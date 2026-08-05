import { tx, type Pool } from "@hunch/infra";

import {
  fetchFundingReceiveSessionForUser,
  listFundingReceiveReceiptsForUser,
} from "../funding/persistence/funding-receive-session-repository.js";
import type { TelegramFundingProgressProjection } from "./telegram-funding-contracts.js";
import {
  projectTelegramFundingProgress,
  telegramFundingProgressFingerprint,
} from "./telegram-funding-progress.js";
import {
  fetchActiveTelegramFundingConsent,
  fetchTelegramFundingSessionContext,
} from "./telegram-funding-sessions.js";

type CandidateRow = Readonly<{
  id: string;
  user_id: string;
  telegram_user_id: string;
  chat_id: string;
}>;

async function listProjectionCandidates(
  pool: Pick<Pool, "query">,
  input: Readonly<{ limit: number; now: Date }>,
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
          or (
            context.active_consent_revision is not null
            and (
              context.cancelled_at is not null
              or context.expires_at <= $1
            )
            and coalesce(context.latest_progress_projection->>'terminal', 'false')
              <> 'true'
          )
        )
      order by context.projection_checked_at asc nulls first, context.id asc
      limit $2
    `,
    [input.now, input.limit],
  );
  return rows;
}

async function projectCandidate(
  pool: Pool,
  candidate: CandidateRow,
  now: Date,
): Promise<"created" | "skipped"> {
  return tx(pool, async (client) => {
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
    const [receipts, consent] = await Promise.all([
      listFundingReceiveReceiptsForUser(client, {
        userId: context.userId,
        receiveSessionId: context.receiveSessionId,
      }),
      fetchActiveTelegramFundingConsent(client, context.id),
    ]);
    const projection = projectTelegramFundingProgress({
      consent,
      context,
      receipts,
      session: receive.session,
      now,
    });
    const fingerprint = projection
      ? telegramFundingProgressFingerprint(projection)
      : null;
    const current = await client.query<{
      progress_fingerprint: string | null;
      progress_revision: number;
      telegram_account_id: string | null;
      telegram_message_id: string | number | null;
    }>(
      `
        select
          progress_fingerprint,
          progress_revision,
          telegram_account_id,
          telegram_message_id
        from telegram_funding_sessions
        where id = $1
      `,
      [context.id],
    );
    const row = current.rows[0];
    if (!row) return "skipped";
    if (!projection || row.progress_fingerprint === fingerprint) {
      await client.query(
        `
          update telegram_funding_sessions
          set projected_receive_version = greatest(projected_receive_version, $2),
              projected_consent_revision = $3,
              projection_checked_at = $4
          where id = $1
        `,
        [
          context.id,
          receive.session.version,
          context.activeConsentRevision ?? 0,
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
            latest_terminal_revision = case when $5 then $2 else latest_terminal_revision end,
            latest_terminal_projection = case when $5 then $4::jsonb else latest_terminal_projection end,
            projected_receive_version = greatest(projected_receive_version, $7),
            projected_consent_revision = $8,
            projection_checked_at = $9
        where id = $1
          and progress_revision = $6
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
        now,
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
          and action in ('funding_send', 'funding_edit', 'funding_replacement')
          and status in ('pending', 'retry')
      `,
      [context.id, revision],
    );
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

export async function runTelegramFundingProgressProjectionBatch(
  pool: Pool,
  input: Readonly<{ limit?: number; now?: Date }> = {},
): Promise<Readonly<{ candidates: number; created: number; skipped: number }>> {
  const now = input.now ?? new Date();
  const candidates = await listProjectionCandidates(pool, {
    limit: Math.min(100, Math.max(1, input.limit ?? 25)),
    now,
  });
  let created = 0;
  let skipped = 0;
  for (const candidate of candidates) {
    const result = await projectCandidate(pool, candidate, now);
    if (result === "created") created += 1;
    else skipped += 1;
  }
  return { candidates: candidates.length, created, skipped };
}

export function parseTelegramFundingProgressProjection(
  value: unknown,
): TelegramFundingProgressProjection | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Partial<TelegramFundingProgressProjection>;
  if (
    record.version !== 1 ||
    typeof record.fundingContextId !== "string" ||
    ![
      "waiting_for_transfer",
      "funds_received",
      "ready",
      "expired",
      "cancelled",
      "needs_attention",
    ].includes(String(record.state)) ||
    typeof record.terminal !== "boolean" ||
    (record.assetSymbol !== "pUSD" && record.assetSymbol !== "USDC.e") ||
    record.networkLabel !== "Polygon" ||
    record.decimals !== 6 ||
    (record.rawAmount !== null && typeof record.rawAmount !== "string") ||
    (record.receiveAddress !== null &&
      typeof record.receiveAddress !== "string") ||
    typeof record.expiresAt !== "string" ||
    (record.observedAt !== null && typeof record.observedAt !== "string")
  ) {
    return null;
  }
  return record as TelegramFundingProgressProjection;
}
