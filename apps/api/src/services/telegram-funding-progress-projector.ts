import { fetchActiveRuntimePolicy } from "@hunch/db";
import { tx, type Pool } from "@hunch/infra";

import {
  fetchFundingReceiveSessionForUser,
  listFundingReceiveRoutingReceiptIdsAfterBroadcastBoundary,
  listFundingReceiveReceiptsForUser,
} from "../funding/persistence/funding-receive-session-repository.js";
import { lockTelegramFundingLinkLifecycle } from "../funding/execution/telegram-funding-link-lifecycle-lock.js";
import { isTelegramFundingReceiveDisclosureTargetCurrent } from "./telegram-funding-disclosure-target.js";
import {
  parseTelegramFundingProgressProjection,
  projectTelegramFundingProgress,
  projectTelegramFundingUnavailable,
  resolveTelegramFundingRetainedTerminal,
  telegramFundingProgressFingerprint,
} from "./telegram-funding-progress.js";
import {
  isTelegramSolanaRetainedFundingRouteKey,
  resolveTelegramFundingConsentCapability,
  resolveTelegramFundingConsentRoute,
} from "./telegram-funding-route.js";
import {
  fetchActiveTelegramFundingConsent,
  fetchTelegramFundingSessionContext,
} from "./telegram-funding-sessions.js";
import { DEFAULT_SIGNAL_BOT_POLICY_REVISION } from "./signal-bot-policy-revision.js";
import { shouldDeleteTelegramFundingQr } from "./telegram-funding-contracts.js";

type CandidateRow = Readonly<{
  id: string;
  user_id: string;
  telegram_user_id: string;
  chat_id: string;
}>;

const CAPABILITY_RECHECK_MS = 60_000;

async function listProjectionCandidates(
  pool: Pick<Pool, "query">,
  input: Readonly<{
    limit: number;
    now: Date;
    policyRevision: string;
  }>,
): Promise<CandidateRow[]> {
  const { rows } = await pool.query<CandidateRow>(
    `
      select
        context.id,
        context.user_id,
        context.telegram_user_id,
        context.chat_id
      from telegram_funding_sessions context
      join funding_receive_sessions receive
        on receive.id = context.receive_session_id
       and receive.user_id = context.user_id
      where (
          context.active_consent_revision is not null
          or context.active_buy_return_revision is not null
          or context.cancelled_at is not null
          or context.expires_at <= $1
          or exists (
            select 1
            from funding_receive_receipts receipt
            where receipt.receive_session_id = context.receive_session_id
          )
        )
        and (
          context.projection_checked_at is null
          or receive.version > context.projected_receive_version
          or coalesce(context.active_consent_revision, 0)
            <> context.projected_consent_revision
          or coalesce(context.active_buy_return_revision, 0)
            <> context.projected_buy_return_revision
          or (
            context.active_buy_return_revision is not null
            and context.projected_buy_policy_revision is distinct from $3
          )
          or (
            context.active_consent_revision is not null
            and (
              context.cancelled_at is not null
              or context.expires_at <= $1
            )
            and coalesce(context.latest_progress_projection->>'terminal', 'false')
              <> 'true'
          )
          or (
            coalesce(context.latest_progress_projection->>'state', '')
              <> 'converting'
            and exists (
              select 1
              from funding_receive_receipts routing_receipt
              join funding_operation_steps routing_step
                on routing_step.operation_id =
                     routing_receipt.child_funding_operation_id
              join funding_operation_step_attempts routing_attempt
                on routing_attempt.step_id = routing_step.id
              where routing_receipt.receive_session_id =
                      context.receive_session_id
                and routing_receipt.user_id = context.user_id
                and routing_receipt.status = 'routing'
                and routing_receipt.handling = 'automatic_conversion'
                and routing_attempt.broadcast_may_have_occurred
            )
          )
          or (
            context.active_consent_revision is not null
            and coalesce(context.latest_progress_projection->>'terminal', 'false')
              <> 'true'
            and context.projection_checked_at <= $4
          )
          or (
            context.address_disclosure_attempt_revision >
                context.address_redacted_revision
            and coalesce(context.latest_progress_projection->>'state', '')
              <> 'unavailable'
            and context.projection_checked_at <= $4
          )
        )
      order by context.projection_checked_at asc nulls first, context.id asc
      limit $2
    `,
    [
      input.now,
      input.limit,
      input.policyRevision,
      new Date(input.now.getTime() - CAPABILITY_RECHECK_MS),
    ],
  );
  return rows;
}

async function projectCandidate(
  pool: Pool,
  candidate: CandidateRow,
  now: Date,
  policyRevision: string,
): Promise<"created" | "skipped"> {
  return tx(pool, async (client) => {
    await lockTelegramFundingLinkLifecycle(client, candidate.user_id);
    const locked = await client.query<{ id: string }>(
      `select id from telegram_funding_sessions where id = $1 for update`,
      [candidate.id],
    );
    if (!locked.rows[0]) return "skipped";
    const context = await fetchTelegramFundingSessionContext(client, {
      contextId: candidate.id,
      userId: candidate.user_id,
      telegramUserId: candidate.telegram_user_id,
      chatId: candidate.chat_id,
    });
    if (!context) return "skipped";
    const receive = await fetchFundingReceiveSessionForUser(client, {
      userId: context.userId,
      receiveSessionId: context.receiveSessionId,
    });
    if (!receive) return "skipped";
    const latestProjection = parseTelegramFundingProgressProjection(
      context.latestProgressProjection,
    );
    const consent = await fetchActiveTelegramFundingConsent(client, context.id);
    const consentRoute = consent
      ? resolveTelegramFundingConsentRoute(consent)
      : null;
    const disclosureTargetIsCurrent =
      context.telegramAccountId != null &&
      (await isTelegramFundingReceiveDisclosureTargetCurrent(client, {
        expectedReceiveAddress: latestProjection?.receiveAddress ?? null,
        fundingContextId: context.id,
        receiveSessionId: context.receiveSessionId,
        retainedSolanaTarget:
          (latestProjection != null &&
            isTelegramSolanaRetainedFundingRouteKey(
              latestProjection.presentation.routeKey,
            )) ||
          (consentRoute != null &&
            isTelegramSolanaRetainedFundingRouteKey(
              consentRoute.presentation.routeKey,
            )),
        telegramAccountId: context.telegramAccountId,
        telegramUserId: context.telegramUserId,
        userId: context.userId,
      }));
    const retainedTerminal = resolveTelegramFundingRetainedTerminal(
      context.latestTerminalProjection,
      context.id,
    );
    const redactionPresentation =
      latestProjection?.presentation ?? consentRoute?.presentation ?? null;
    const qrPhoto = await client.query<{ exists: boolean }>(
      `
        select exists (
          select 1
          from telegram_bot_action_outbox
          where funding_session_id = $1
            and action = 'funding_qr'
            and telegram_message_id is not null
            and telegram_message_id is distinct from $2::bigint
            and payload->>'terminal' <> 'true'
        ) as exists
      `,
      [context.id, context.telegramMessageId],
    );
    const shouldDeleteQrPhoto =
      !disclosureTargetIsCurrent && qrPhoto.rows[0]?.exists === true;
    const shouldRedactDeliveredAddress =
      !disclosureTargetIsCurrent &&
      context.addressDisclosureAttemptRevision >
        context.addressRedactedRevision &&
      redactionPresentation != null &&
      latestProjection?.state !== "unavailable";
    if (
      !disclosureTargetIsCurrent &&
      !shouldRedactDeliveredAddress &&
      !shouldDeleteQrPhoto
    ) {
      await client.query(
        `
          update telegram_bot_action_outbox
          set status = 'skipped',
              last_error = 'funding_disclosure_target_changed',
              updated_at = $2
          where funding_session_id = $1
            and action in (
              'funding_send',
              'funding_edit',
              'funding_replacement',
              'funding_qr'
            )
            and status in ('pending', 'retry')
        `,
        [context.id, now],
      );
      await client.query(
        `
          update telegram_funding_sessions
          set projection_checked_at = $2
          where id = $1
        `,
        [context.id, now],
      );
      return "skipped";
    }
    let projection =
      (shouldRedactDeliveredAddress || shouldDeleteQrPhoto) &&
      redactionPresentation
        ? projectTelegramFundingUnavailable(context, redactionPresentation)
        : null;
    if (disclosureTargetIsCurrent) {
      const receipts = await listFundingReceiveReceiptsForUser(client, {
        userId: context.userId,
        receiveSessionId: context.receiveSessionId,
      });
      const afterBroadcastBoundaryReceiptIds =
        await listFundingReceiveRoutingReceiptIdsAfterBroadcastBoundary(
          client,
          {
            userId: context.userId,
            receiveSessionId: context.receiveSessionId,
          },
        );
      const capability =
        consent?.automationEnabled && context.telegramAccountId
          ? await resolveTelegramFundingConsentCapability(client, {
              consent,
              userId: context.userId,
              telegramAccountId: context.telegramAccountId,
              telegramUserId: context.telegramUserId,
              destinationOptionId: receive.session.destinationOptionId,
              venueBindingOptionId: receive.session.venueBindingOptionId,
              now,
            })
          : null;
      projection = projectTelegramFundingProgress({
        afterBroadcastBoundaryReceiptIds,
        automaticConversionAvailable: capability?.decision.kind === "allowed",
        automaticConversionMode: capability
          ? capability.decision.kind === "allowed"
            ? "available"
            : capability.decision.kind === "soft_paused"
              ? "soft_paused"
              : "hard_invalid"
          : consent?.automationEnabled
            ? "hard_invalid"
            : undefined,
        consent,
        context,
        receipts,
        session: receive.session,
        now,
      });
    }
    // Terminality is absorbing for one funding context. A restored controller
    // or policy must open a fresh context instead of reviving an address whose
    // disclosure has already been durably redacted. Malformed historical
    // terminal JSON is repaired to the same address-free unavailable surface.
    if (retainedTerminal.kind !== "absent") {
      projection =
        retainedTerminal.kind === "valid"
          ? retainedTerminal.projection
          : redactionPresentation
            ? projectTelegramFundingUnavailable(context, redactionPresentation)
            : null;
    }
    const fingerprint = projection
      ? telegramFundingProgressFingerprint(projection)
      : null;
    const current = await client.query<{
      active_buy_return_revision: number | null;
      progress_fingerprint: string | null;
      progress_revision: number;
      projected_buy_policy_revision: string | null;
      projected_buy_return_revision: number;
      telegram_account_id: string | null;
      telegram_message_id: string | number | null;
    }>(
      `
        select
          progress_fingerprint,
          progress_revision,
          active_buy_return_revision,
          projected_buy_policy_revision,
          projected_buy_return_revision,
          telegram_account_id,
          telegram_message_id
        from telegram_funding_sessions
        where id = $1
      `,
      [context.id],
    );
    const row = current.rows[0];
    if (!row) return "skipped";
    const presentationChanged =
      row.active_buy_return_revision != null &&
      (row.projected_buy_return_revision !== row.active_buy_return_revision ||
        row.projected_buy_policy_revision !== policyRevision);
    if (
      !projection ||
      (row.progress_fingerprint === fingerprint && !presentationChanged)
    ) {
      await client.query(
        `
          update telegram_funding_sessions
          set projected_receive_version = greatest(projected_receive_version, $2),
              projected_consent_revision = $3,
              projected_buy_return_revision = coalesce(active_buy_return_revision, 0),
              projected_buy_policy_revision = $4,
              projection_checked_at = $5
          where id = $1
        `,
        [
          context.id,
          receive.session.version,
          context.activeConsentRevision ?? 0,
          policyRevision,
          now,
        ],
      );
      return "skipped";
    }
    const revision = row.progress_revision + 1;
    const updated = await client.query<{ id: string }>(
      `
        update telegram_funding_sessions
        set progress_revision = $2,
            progress_fingerprint = $3,
            latest_progress_projection = $4::jsonb,
            latest_terminal_revision = case
              when $11::boolean or (latest_terminal_projection is null and $5)
                then $2
              else latest_terminal_revision
            end,
            latest_terminal_projection = case
              when $11::boolean or (latest_terminal_projection is null and $5)
                then $4::jsonb
              else latest_terminal_projection
            end,
            projected_receive_version = greatest(projected_receive_version, $7),
            projected_consent_revision = $8,
            projected_buy_return_revision = coalesce(active_buy_return_revision, 0),
            projected_buy_policy_revision = $9,
            projection_checked_at = $10
        where id = $1
          and progress_revision = $6
          and (
            latest_terminal_projection is null
            or latest_terminal_projection = $4::jsonb
            or $11::boolean
          )
        returning id
      `,
      [
        context.id,
        revision,
        fingerprint,
        JSON.stringify(projection),
        projection.terminal,
        row.progress_revision,
        receive.session.version,
        context.activeConsentRevision ?? 0,
        policyRevision,
        now,
        retainedTerminal.kind === "invalid",
      ],
    );
    if (!updated.rows[0]) return "skipped";
    await client.query(
      `
        update telegram_bot_action_outbox
        set status = 'skipped',
            last_error = 'funding_delivery_superseded',
            updated_at = now()
        where funding_session_id = $1
          and state_revision < $2
          and action in (
            'funding_send',
            'funding_edit',
            'funding_replacement',
            'funding_qr'
          )
          and status in ('pending', 'retry')
      `,
      [context.id, revision],
    );
    if (shouldDeleteTelegramFundingQr(projection)) {
      await client.query(
        `
          update telegram_bot_action_outbox
          set state_revision = $2,
              payload = $3::jsonb,
              status = 'pending',
              attempt_count = 0,
              next_attempt_at = now(),
              last_error = null,
              sent_at = null,
              delivery_attempt_id = null,
              delivery_started_at = null,
              updated_at = now()
          where funding_session_id = $1
            and action = 'funding_qr'
            and telegram_message_id is not null
            and telegram_message_id is distinct from $4::bigint
            and status not in ('sending', 'delivery_unknown')
        `,
        [
          context.id,
          revision,
          JSON.stringify(projection),
          context.telegramMessageId,
        ],
      );
    }
    if (projection.receiveAddress !== null && !row.telegram_message_id) {
      return "created";
    }
    const action = row.telegram_message_id ? "funding_edit" : "funding_send";
    await client.query(
      `
        insert into telegram_bot_action_outbox (
          action,
          telegram_account_id,
          user_id,
          telegram_user_id,
          funding_session_id,
          state_revision,
          payload
        ) values ($1, $2, $3, $4, $5, $6, $7::jsonb)
        on conflict do nothing
      `,
      [
        action,
        row.telegram_account_id,
        context.userId,
        context.telegramUserId,
        context.id,
        revision,
        JSON.stringify(projection),
      ],
    );
    return "created";
  });
}

export async function runTelegramFundingProgressProjectionForContext(
  pool: Pool,
  input: Readonly<{ contextId: string; now?: Date }>,
): Promise<"created" | "skipped"> {
  const now = input.now ?? new Date();
  const policyRevision =
    (await fetchActiveRuntimePolicy(pool, "signal_bot"))?.id ??
    DEFAULT_SIGNAL_BOT_POLICY_REVISION;
  const candidate = await pool.query<CandidateRow>(
    `
      select id, user_id, telegram_user_id, chat_id
      from telegram_funding_sessions
      where id = $1
      limit 1
    `,
    [input.contextId],
  );
  const row = candidate.rows[0];
  return row ? projectCandidate(pool, row, now, policyRevision) : "skipped";
}

export async function runTelegramFundingProgressProjectionBatch(
  pool: Pool,
  input: Readonly<{ limit?: number; now?: Date }> = {},
): Promise<Readonly<{ candidates: number; created: number; skipped: number }>> {
  const now = input.now ?? new Date();
  const policyRevision =
    (await fetchActiveRuntimePolicy(pool, "signal_bot"))?.id ??
    DEFAULT_SIGNAL_BOT_POLICY_REVISION;
  const candidates = await listProjectionCandidates(pool, {
    limit: Math.min(100, Math.max(1, input.limit ?? 25)),
    now,
    policyRevision,
  });
  let created = 0;
  let skipped = 0;
  for (const candidate of candidates) {
    const result = await projectCandidate(pool, candidate, now, policyRevision);
    if (result === "created") created += 1;
    else skipped += 1;
  }
  return { candidates: candidates.length, created, skipped };
}

export { parseTelegramFundingProgressProjection };
