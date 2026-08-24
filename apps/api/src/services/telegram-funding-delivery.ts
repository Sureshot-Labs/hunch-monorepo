import { randomUUID } from "node:crypto";

import { tx, type Pool, type PoolClient } from "@hunch/infra";

import type {
  SignalBotTelegramClient,
  TelegramSendResult,
} from "./signal-bot-contracts.js";
import {
  shouldDeleteTelegramFundingQr,
  type TelegramFundingProgressProjection,
} from "./telegram-funding-contracts.js";
import { lockTelegramFundingLinkLifecycle } from "../funding/execution/telegram-funding-link-lifecycle-lock.js";
import { isTelegramFundingReceiveControllerCurrent } from "../funding/execution/telegram-funding-managed-wallet.js";
import { canonicalJsonEqual } from "../funding/persistence/canonical.js";
import { lockFundingPolicyForTransaction } from "../funding/policies/funding-policy-sidecar.js";
import {
  buildTelegramFundingProgressMessage,
  buildTelegramFundingQrPhoto,
} from "./telegram-funding-presentation.js";
import {
  parseTelegramFundingProgressProjection,
  resolveTelegramFundingRetainedTerminal,
} from "./telegram-funding-progress.js";
import type { TelegramFundingSessionContext } from "./telegram-funding-sessions.js";
import { resolveTelegramFundingAutomaticCapability } from "./telegram-funding-route.js";
import {
  claimSignalBotBackgroundMenuRender,
  claimSignalBotMenuRender,
  isSignalBotMenuRenderCurrent,
  withSignalBotMenuRenderLock,
  type SignalBotMenuRenderLockResult,
  type SignalBotMenuStateRedis,
} from "./telegram-bot-menu-state.js";

type FundingOutboxRow = Readonly<{
  id: string;
  action:
    | "funding_send"
    | "funding_edit"
    | "funding_replacement"
    | "funding_qr";
  funding_session_id: string;
  state_revision: number;
  payload: unknown;
  attempt_count: number;
  delivery_attempt_id: string;
  telegram_message_id: string | number | null;
  user_id: string;
}>;

type FundingDestinationRow = Readonly<{
  active_buy_return_revision: number | null;
  address_disclosure_attempt_revision: number;
  address_disclosure_message_id: string | number | null;
  address_delivered_revision: number;
  address_redacted_revision: number;
  automation_enabled: boolean | null;
  cancelled_at: Date | null;
  destination_option_id: string;
  expires_at: Date;
  policy_snapshot: unknown;
  receive_status: string;
  receive_session_id: string;
  telegram_account_id: string | null;
  telegram_user_id: string;
  telegram_message_id: string | number | null;
  latest_terminal_projection: unknown;
  progress_revision: number;
  user_id: string;
  venue_binding_option_id: string;
}>;

const MAX_DELIVERY_ATTEMPTS = 8;
const DELIVERY_LEASE_SECONDS = 300;

export function requiresCurrentFundingPolicyForAddressDelivery(input: {
  action: FundingOutboxRow["action"];
  addressDeliveredRevision: number;
}): boolean {
  return (
    input.addressDeliveredRevision === 0 || input.action !== "funding_edit"
  );
}

async function enqueueFundingEditRevision(
  client: Pick<PoolClient, "query">,
  input: Readonly<{
    action: Extract<FundingOutboxRow["action"], "funding_edit">;
    fundingSessionId: string;
    payload: unknown;
    stateRevision: number;
    telegramAccountId: string | null;
    telegramUserId: string;
    userId: string;
    requireCurrentAddressProjection?: boolean;
  }>,
): Promise<boolean> {
  const queued = await client.query(
    `
      insert into telegram_bot_action_outbox (
        action,
        telegram_account_id,
        user_id,
        telegram_user_id,
        funding_session_id,
        state_revision,
        payload
      )
      select $1, $2, $3, $4, $5, $6, $7::jsonb
      where not $8::boolean
         or exists (
           select 1
           from telegram_funding_sessions context
           where context.id = $5
             and context.user_id = $3
             and context.telegram_account_id = $2
             and context.telegram_user_id = $4
             and context.progress_revision = $6
             and context.latest_progress_projection = $7::jsonb
             and context.latest_terminal_projection is null
             and context.telegram_message_id is not null
             and (
               context.address_disclosure_message_id is null
               or context.address_disclosure_message_id = context.telegram_message_id
             )
         )
      on conflict (funding_session_id, state_revision, action)
        where action in ('funding_send', 'funding_edit', 'funding_replacement')
      do update
        set telegram_account_id = excluded.telegram_account_id,
            user_id = excluded.user_id,
            telegram_user_id = excluded.telegram_user_id,
            payload = excluded.payload,
            status = 'pending',
            attempt_count = 0,
            next_attempt_at = now(),
            last_error = null,
            delivery_attempt_id = null,
            delivery_started_at = null,
            sent_at = null,
            updated_at = now()
        where telegram_bot_action_outbox.status not in (
          'sending',
          'delivery_unknown'
        )
    `,
    [
      input.action,
      input.telegramAccountId,
      input.userId,
      input.telegramUserId,
      input.fundingSessionId,
      input.stateRevision,
      JSON.stringify(input.payload),
      input.requireCurrentAddressProjection === true,
    ],
  );
  return (queued.rowCount ?? 0) === 1;
}

export async function rearmTelegramFundingCurrentAddressDelivery(input: {
  context: Pick<
    TelegramFundingSessionContext,
    | "addressDisclosureMessageId"
    | "id"
    | "latestProgressProjection"
    | "latestTerminalProjection"
    | "progressRevision"
    | "telegramMessageId"
  >;
  pool: Pool;
  telegramAccountId: string;
  telegramUserId: string;
  userId: string;
}): Promise<boolean> {
  const projection = parseTelegramFundingProgressProjection(
    input.context.latestProgressProjection,
  );
  if (
    !projection ||
    projection.fundingContextId !== input.context.id ||
    projection.terminal ||
    projection.receiveAddress === null ||
    input.context.latestTerminalProjection !== null ||
    input.context.telegramMessageId === null ||
    (input.context.addressDisclosureMessageId !== null &&
      input.context.addressDisclosureMessageId !==
        input.context.telegramMessageId)
  ) {
    return false;
  }
  // A normal menu may overwrite the exact Telegram message after this
  // revision was delivered. Rearm only the durable intent: claim fencing and
  // delivery-time lifecycle checks remain the freshness/security boundary.
  return enqueueFundingEditRevision(input.pool, {
    action: "funding_edit",
    fundingSessionId: input.context.id,
    payload: projection,
    stateRevision: input.context.progressRevision,
    telegramAccountId: input.telegramAccountId,
    telegramUserId: input.telegramUserId,
    userId: input.userId,
    requireCurrentAddressProjection: true,
  });
}

export type TelegramFundingRenderCoordinator = Readonly<{
  claimBackground?(
    input: Readonly<{
      chatId: string;
      messageId: number;
      renderToken: string;
    }>,
  ): Promise<boolean>;
  claim(
    input: Readonly<{
      chatId: string;
      messageId: number;
      renderToken: string;
    }>,
  ): Promise<void>;
  isCurrent(
    input: Readonly<{
      chatId: string;
      messageId: number;
      renderToken: string;
    }>,
  ): Promise<boolean>;
  runExclusive<T>(
    input: Readonly<{
      chatId: string;
      deliver: () => Promise<T>;
      messageId: number;
      renderToken: string;
    }>,
  ): Promise<SignalBotMenuRenderLockResult<T>>;
}>;

export function createTelegramFundingRenderCoordinator(
  redis: Pick<SignalBotMenuStateRedis, "eval" | "get" | "set">,
): TelegramFundingRenderCoordinator {
  return {
    claimBackground: (input) =>
      claimSignalBotBackgroundMenuRender({ ...input, redis }),
    claim: (input) => claimSignalBotMenuRender({ ...input, redis }),
    isCurrent: (input) => isSignalBotMenuRenderCurrent({ ...input, redis }),
    runExclusive: (input) =>
      withSignalBotMenuRenderLock({
        ...input,
        redis,
        isCurrent: () => isSignalBotMenuRenderCurrent({ ...input, redis }),
      }),
  };
}

async function recoverStaleSendAttempts(client: PoolClient): Promise<void> {
  await client.query(
    `
      with unknown as (
        update telegram_bot_action_outbox outbox
        set status = 'delivery_unknown',
            last_error = 'funding_send_outcome_unknown',
            updated_at = now()
        where (
            outbox.action in ('funding_send', 'funding_replacement')
            or (
              outbox.action = 'funding_qr'
              and not (
                outbox.telegram_message_id is not null
                and jsonb_typeof(outbox.payload->'receiveAddress') = 'null'
                and (
                  outbox.payload->>'terminal' = 'true'
                  or jsonb_typeof(outbox.payload->'observedAt') = 'string'
                )
              )
            )
          )
          and outbox.status = 'sending'
          and outbox.updated_at <= now() - interval '5 minutes'
        returning outbox.id, outbox.funding_session_id, outbox.delivery_attempt_id
      )
      update telegram_funding_sessions context
      set delivery_lease_outbox_id = null,
          delivery_lease_attempt_id = null,
          delivery_lease_expires_at = null
      from unknown
      where context.id = unknown.funding_session_id
        and context.delivery_lease_outbox_id = unknown.id
        and context.delivery_lease_attempt_id = unknown.delivery_attempt_id
    `,
  );
}

async function claimFundingOutbox(input: {
  pool: Pool;
  limit: number;
}): Promise<FundingOutboxRow[]> {
  return tx(input.pool, async (client) => {
    await recoverStaleSendAttempts(client);
    await client.query(
      `
        update telegram_bot_action_outbox outbox
        set status = 'skipped',
            last_error = 'funding_delivery_superseded',
            updated_at = now()
        from telegram_funding_sessions context
        where context.id = outbox.funding_session_id
          and outbox.state_revision < context.progress_revision
          and outbox.action in (
            'funding_send',
            'funding_edit',
            'funding_replacement',
            'funding_qr'
          )
          and outbox.status in ('pending', 'retry')
      `,
    );
    const { rows } = await client.query<
      Omit<FundingOutboxRow, "delivery_attempt_id">
    >(
      `
        select
          outbox.id,
          outbox.action,
          outbox.funding_session_id,
          outbox.state_revision,
          outbox.payload,
          outbox.attempt_count,
          outbox.telegram_message_id,
          outbox.user_id
        from telegram_bot_action_outbox outbox
        join telegram_funding_sessions context
          on context.id = outbox.funding_session_id
         and context.progress_revision = outbox.state_revision
        where outbox.action in (
          'funding_send',
          'funding_edit',
          'funding_replacement',
          'funding_qr'
        )
          and (
            (outbox.status in ('pending', 'retry') and outbox.next_attempt_at <= now())
            or (
              outbox.action in ('funding_edit', 'funding_qr')
              and outbox.status = 'sending'
              and outbox.updated_at <= now() - interval '5 minutes'
            )
          )
          and (
            context.delivery_lease_outbox_id is null
            or context.delivery_lease_expires_at <= now()
          )
          and not exists (
            select 1
            from telegram_bot_action_outbox unknown
            where unknown.funding_session_id = context.id
              and unknown.status = 'delivery_unknown'
              and not (
                (
                  outbox.action = 'funding_edit'
                  and context.address_disclosure_attempt_revision >
                      context.address_redacted_revision
                  and outbox.payload->>'terminal' = 'true'
                  and jsonb_typeof(outbox.payload->'receiveAddress') = 'null'
                )
                or (
                  outbox.action = 'funding_qr'
                  and outbox.telegram_message_id is not null
                  and jsonb_typeof(outbox.payload->'receiveAddress') = 'null'
                  and (
                    outbox.payload->>'terminal' = 'true'
                    or jsonb_typeof(outbox.payload->'observedAt') = 'string'
                  )
                )
              )
          )
        order by outbox.next_attempt_at asc, outbox.created_at asc
        for update of outbox, context skip locked
        limit $1
      `,
      [Math.min(300, input.limit * 3)],
    );
    const claimed: FundingOutboxRow[] = [];
    const claimedContexts = new Set<string>();
    for (const row of rows) {
      if (
        claimed.length >= input.limit ||
        claimedContexts.has(row.funding_session_id)
      ) {
        continue;
      }
      const attemptId = randomUUID();
      const leased = await client.query(
        `
          update telegram_funding_sessions
          set delivery_lease_outbox_id = $2,
              delivery_lease_attempt_id = $3,
              delivery_lease_expires_at = now() + ($4::int * interval '1 second')
          where id = $1
            and (
              delivery_lease_outbox_id is null
              or delivery_lease_expires_at <= now()
            )
        `,
        [row.funding_session_id, row.id, attemptId, DELIVERY_LEASE_SECONDS],
      );
      if ((leased.rowCount ?? 0) !== 1) continue;
      const started = await client.query(
        `
          update telegram_bot_action_outbox
          set status = 'sending',
              attempt_count = attempt_count + 1,
              delivery_attempt_id = $2,
              delivery_started_at = now(),
              updated_at = now()
          where id = $1
            and action in (
              'funding_send',
              'funding_edit',
              'funding_replacement',
              'funding_qr'
            )
          returning attempt_count
        `,
        [row.id, attemptId],
      );
      const attemptCount = Number(
        (started.rows[0] as { attempt_count?: unknown } | undefined)
          ?.attempt_count ?? row.attempt_count + 1,
      );
      claimed.push({
        ...row,
        attempt_count: attemptCount,
        delivery_attempt_id: attemptId,
      });
      claimedContexts.add(row.funding_session_id);
    }
    return claimed;
  });
}

async function loadCurrentDestination(
  pool: Pick<Pool, "query">,
  row: FundingOutboxRow,
  projection: TelegramFundingProgressProjection,
): Promise<FundingDestinationRow | null> {
  const addressFreeTerminalEdit = isSafeAddressRedaction(projection);
  const deletesQrPhoto =
    row.action === "funding_qr" && shouldDeleteTelegramFundingQr(projection);
  const { rows } = await pool.query<FundingDestinationRow>(
    `
      select
        context.active_buy_return_revision,
        context.address_disclosure_attempt_revision,
        context.address_disclosure_message_id,
        context.address_delivered_revision,
        context.address_redacted_revision,
        consent.automation_enabled,
        context.cancelled_at,
        receive.destination_option_id,
        context.expires_at,
        consent.automation_policy_snapshot as policy_snapshot,
        context.receive_session_id,
        receive.status as receive_status,
        account.id::text as telegram_account_id,
        context.chat_id as telegram_user_id,
        context.telegram_message_id,
        context.latest_terminal_projection,
        context.progress_revision,
        context.user_id,
        receive.venue_binding_option_id
      from telegram_funding_sessions context
      join funding_receive_sessions receive
        on receive.id = context.receive_session_id
       and receive.user_id = context.user_id
      left join user_telegram_accounts account
        on account.id = context.telegram_account_id
       and account.user_id = context.user_id
       and account.telegram_user_id = context.telegram_user_id
      join users app_user on app_user.id = context.user_id
      left join telegram_funding_consents consent
        on consent.telegram_funding_session_id = context.id
       and consent.revision = context.active_consent_revision
      where context.id = $1
        and context.progress_revision = $2
        and exists (
          select 1
          from telegram_bot_action_outbox claimed
          where claimed.id = $3
            and claimed.status = 'sending'
            and claimed.delivery_attempt_id = $4
        )
        and context.delivery_lease_outbox_id = $3
        and context.delivery_lease_attempt_id = $4
        and context.delivery_lease_expires_at > now()
        and context.user_id = $5
        and (
          coalesce(app_user.is_active, true) = true
          or $6::boolean
        )
        and (
          $7::boolean
          or context.telegram_message_id is null
          or not exists (
            select 1
            from telegram_funding_sessions newer
            where newer.user_id = context.user_id
              and newer.telegram_user_id = context.telegram_user_id
              and newer.chat_id = context.chat_id
              and newer.telegram_message_id = context.telegram_message_id
              and newer.id <> context.id
              and (newer.created_at, newer.id) >
                  (context.created_at, context.id)
          )
        )
      limit 1
    `,
    [
      row.funding_session_id,
      row.state_revision,
      row.id,
      row.delivery_attempt_id,
      row.user_id,
      addressFreeTerminalEdit,
      deletesQrPhoto,
    ],
  );
  const destination = rows[0];
  if (!destination) return null;
  // The retained terminal is the exact context watermark, not a boolean hint.
  // Delivery may emit that canonical payload only; malformed or split evidence
  // stays fail-closed until the projector repairs it under the context lock.
  const retainedTerminal = resolveTelegramFundingRetainedTerminal(
    destination.latest_terminal_projection,
    row.funding_session_id,
  );
  if (
    retainedTerminal.kind === "invalid" ||
    (retainedTerminal.kind === "absent" && projection.terminal) ||
    (retainedTerminal.kind === "valid" &&
      !canonicalJsonEqual(retainedTerminal.projection, projection))
  ) {
    return null;
  }
  const safeAddressRedaction =
    addressFreeTerminalEdit &&
    destination.address_disclosure_attempt_revision >
      destination.address_redacted_revision;
  if (
    safeAddressRedaction &&
    destination.address_disclosure_message_id == null
  ) {
    return null;
  }
  if (
    projection.receiveAddress !== null &&
    (destination.cancelled_at !== null ||
      destination.expires_at.getTime() <= Date.now() ||
      destination.receive_status !== "open")
  ) {
    return null;
  }
  if (!destination.telegram_account_id) {
    return safeAddressRedaction || deletesQrPhoto ? destination : null;
  }
  const controllerIsCurrent = await isTelegramFundingReceiveControllerCurrent(
    pool,
    {
      receiveSessionId: destination.receive_session_id,
      telegramAccountId: destination.telegram_account_id,
      telegramUserId: destination.telegram_user_id,
      userId: destination.user_id,
    },
  );
  if (!controllerIsCurrent) {
    return safeAddressRedaction || deletesQrPhoto ? destination : null;
  }
  if (projection.receiveAddress === null) return destination;
  if (destination.automation_enabled === false) return destination;
  if (destination.automation_enabled !== true) return null;
  const capability = await resolveTelegramFundingAutomaticCapability(pool, {
    policySnapshot: destination.policy_snapshot,
    userId: destination.user_id,
    telegramAccountId: destination.telegram_account_id,
    telegramUserId: destination.telegram_user_id,
    destinationOptionId: destination.destination_option_id,
    venueBindingOptionId: destination.venue_binding_option_id,
  });
  if (!capability || capability.decision.kind === "hard_invalid") return null;
  if (
    requiresCurrentFundingPolicyForAddressDelivery({
      action: row.action,
      addressDeliveredRevision: destination.address_delivered_revision,
    }) &&
    capability.fundingPolicyRevision !==
      capability.expectedFundingPolicyRevision
  ) {
    return null;
  }
  return destination;
}

function isSafeAddressRedaction(
  projection: TelegramFundingProgressProjection,
): boolean {
  return projection.terminal && projection.receiveAddress === null;
}

// Persist the redaction obligation before Telegram can observe the address.
// This is intentionally distinct from confirmed delivery: process loss after
// the edit must retain the obligation without pretending that delivery was
// acknowledged.
async function markAddressDisclosureAttempt(input: {
  client: Pick<PoolClient, "query">;
  messageId: number;
  row: FundingOutboxRow;
}): Promise<boolean> {
  const marked = await input.client.query(
    `
      update telegram_funding_sessions context
      set address_disclosure_attempt_revision = greatest(
            address_disclosure_attempt_revision,
            $4
          ),
          address_disclosure_message_id = coalesce(
            address_disclosure_message_id,
            $5
          ),
          updated_at = now()
      from telegram_bot_action_outbox outbox,
           funding_receive_sessions receive
      where context.id = $1
        and context.progress_revision = $4
        and context.delivery_lease_outbox_id = $2
        and context.delivery_lease_attempt_id = $3
        and context.delivery_lease_expires_at > now()
        and context.cancelled_at is null
        and context.expires_at > now()
        and context.telegram_message_id = $5
        and not exists (
          select 1
          from telegram_funding_sessions newer
          where newer.user_id = context.user_id
            and newer.telegram_user_id = context.telegram_user_id
            and newer.chat_id = context.chat_id
            and newer.telegram_message_id = context.telegram_message_id
            and newer.id <> context.id
            and (newer.created_at, newer.id) >
                (context.created_at, context.id)
        )
        and (
          context.address_disclosure_message_id is null
          or context.address_disclosure_message_id = $5
        )
        and receive.id = context.receive_session_id
        and receive.user_id = context.user_id
        and receive.owner_channel = 'telegram'
        and receive.status = 'open'
        and receive.expires_at > now()
        and outbox.id = $2
        and outbox.funding_session_id = context.id
        and outbox.state_revision = $4
        and outbox.status = 'sending'
        and outbox.delivery_attempt_id = $3
      returning context.id
    `,
    [
      input.row.funding_session_id,
      input.row.id,
      input.row.delivery_attempt_id,
      input.row.state_revision,
      input.messageId,
    ],
  );
  return (marked.rowCount ?? 0) === 1;
}

async function prepareAddressDisclosure(input: {
  pool: Pool;
  projection: TelegramFundingProgressProjection;
  row: FundingOutboxRow;
}): Promise<Readonly<{
  destination: FundingDestinationRow;
  messageId: number;
}> | null> {
  return tx(input.pool, async (client) => {
    await lockTelegramFundingLinkLifecycle(client, input.row.user_id);
    await lockFundingPolicyForTransaction(client);
    const destination = await loadCurrentDestination(
      client,
      input.row,
      input.projection,
    );
    const messageId = Number(destination?.telegram_message_id);
    if (
      !destination ||
      !Number.isSafeInteger(messageId) ||
      messageId <= 0 ||
      !(await markAddressDisclosureAttempt({
        client,
        messageId,
        row: input.row,
      }))
    ) {
      return null;
    }
    return { destination, messageId };
  });
}

async function finishAttempt(input: {
  pool: Pool;
  row: FundingOutboxRow;
  status: "dead" | "delivery_unknown" | "retry" | "skipped";
  reason: string;
  persistentRetry?: boolean;
  retryAfterSec?: number;
}): Promise<void> {
  const dead =
    !input.persistentRetry && input.row.attempt_count >= MAX_DELIVERY_ATTEMPTS;
  const retryAfterSec = Math.max(
    1,
    Math.min(
      3_600,
      input.retryAfterSec ?? 5 * 2 ** Math.max(0, input.row.attempt_count - 1),
    ),
  );
  await tx(input.pool, async (client) => {
    const status = input.status === "retry" && dead ? "dead" : input.status;
    await client.query(
      `
        update telegram_bot_action_outbox
        set status = $3,
            last_error = $4,
            next_attempt_at = case
              when $3 = 'retry' then now() + ($5::int * interval '1 second')
              else next_attempt_at
            end,
            updated_at = now()
        where id = $1
          and delivery_attempt_id = $2
          and status = 'sending'
      `,
      [
        input.row.id,
        input.row.delivery_attempt_id,
        status,
        input.reason,
        retryAfterSec,
      ],
    );
    await client.query(
      `
        update telegram_funding_sessions
        set delivery_lease_outbox_id = null,
            delivery_lease_attempt_id = null,
            delivery_lease_expires_at = null
        where id = $1
          and delivery_lease_outbox_id = $2
          and delivery_lease_attempt_id = $3
      `,
      [
        input.row.funding_session_id,
        input.row.id,
        input.row.delivery_attempt_id,
      ],
    );
  });
}

async function recordDeliverySuccess(input: {
  addressDelivered: boolean;
  addressRedacted: boolean;
  pool: Pool;
  row: FundingOutboxRow;
  telegramAccountId: string | null;
  messageId: number;
}): Promise<boolean> {
  return tx(input.pool, async (client) => {
    const locked = await client.query<{
      current_telegram_account_id: string | null;
      latest_progress_projection: unknown;
      progress_revision: number;
      telegram_user_id: string;
      user_id: string;
    }>(
      `
        select
          current_account.id::text as current_telegram_account_id,
          context.latest_progress_projection,
          context.progress_revision,
          context.telegram_user_id,
          context.user_id
        from telegram_bot_action_outbox outbox
        join telegram_funding_sessions context
          on context.id = outbox.funding_session_id
        left join lateral (
          select account.id
          from user_telegram_accounts account
          where account.user_id = context.user_id
            and account.telegram_user_id = context.telegram_user_id
          limit 1
        ) current_account on true
        where outbox.id = $1
          and outbox.delivery_attempt_id = $2
          and outbox.status = 'sending'
          and context.delivery_lease_outbox_id = outbox.id
          and context.delivery_lease_attempt_id = outbox.delivery_attempt_id
        for update of outbox, context
      `,
      [input.row.id, input.row.delivery_attempt_id],
    );
    const current = locked.rows[0];
    if (!current) return false;
    const currentProjection = parseTelegramFundingProgressProjection(
      current.latest_progress_projection,
    );
    const deleteJustSentQr =
      input.row.action === "funding_qr" &&
      currentProjection != null &&
      shouldDeleteTelegramFundingQr(currentProjection) &&
      current.progress_revision > input.row.state_revision;
    await client.query(
      `
        update telegram_bot_action_outbox
        set status = case when $5::boolean then 'pending' else 'sent' end,
            telegram_account_id = $2,
            telegram_message_id = $3,
            last_error = null,
            sent_at = case when $5::boolean then null else now() end,
            state_revision = case when $5::boolean then $6 else state_revision end,
            payload = case when $5::boolean then $7::jsonb else payload end,
            attempt_count = case when $5::boolean then 0 else attempt_count end,
            next_attempt_at = case when $5::boolean then now() else next_attempt_at end,
            delivery_attempt_id = case when $5::boolean then null else delivery_attempt_id end,
            delivery_started_at = case when $5::boolean then null else delivery_started_at end,
            updated_at = now()
        where id = $1
          and delivery_attempt_id = $4
          and status = 'sending'
      `,
      [
        input.row.id,
        input.telegramAccountId,
        input.messageId,
        input.row.delivery_attempt_id,
        deleteJustSentQr,
        current.progress_revision,
        JSON.stringify(currentProjection),
      ],
    );
    if (current.current_telegram_account_id !== input.telegramAccountId) {
      await client.query(
        `
          update telegram_funding_sessions
          set telegram_message_id = case
                when $4::uuid is not null and $8::boolean then $5
                else telegram_message_id
              end,
              address_redacted_revision = case
                when $6::boolean
                 and address_disclosure_message_id = $5
                  then greatest(address_redacted_revision, $7)
                else address_redacted_revision
              end,
              delivery_lease_outbox_id = null,
              delivery_lease_attempt_id = null,
              delivery_lease_expires_at = null
          where id = $1
            and delivery_lease_outbox_id = $2
            and delivery_lease_attempt_id = $3
        `,
        [
          input.row.funding_session_id,
          input.row.id,
          input.row.delivery_attempt_id,
          current.current_telegram_account_id,
          input.messageId,
          input.addressRedacted,
          input.row.state_revision,
          input.row.action === "funding_send",
        ],
      );
      if (
        current.current_telegram_account_id &&
        current.latest_progress_projection
      ) {
        await enqueueFundingEditRevision(client, {
          action: "funding_edit",
          fundingSessionId: input.row.funding_session_id,
          payload: current.latest_progress_projection,
          stateRevision: current.progress_revision,
          telegramAccountId: current.current_telegram_account_id,
          telegramUserId: current.telegram_user_id,
          userId: current.user_id,
        });
      }
      return true;
    }
    const attached = await client.query(
      `
        update telegram_funding_sessions context
        set telegram_account_id = $2,
            telegram_message_id = case
              when $7::boolean then $3
              else telegram_message_id
            end,
            last_delivered_revision = case
              when $10::boolean then greatest(last_delivered_revision, $4)
              else last_delivered_revision
            end,
            address_delivered_revision = case
              when $8::boolean
               and address_disclosure_message_id = $3
                then greatest(address_delivered_revision, $4)
              else address_delivered_revision
            end,
            address_redacted_revision = case
              when $9::boolean
               and address_disclosure_message_id = $3
                then greatest(address_redacted_revision, $4)
              else address_redacted_revision
            end,
            delivery_lease_outbox_id = null,
            delivery_lease_attempt_id = null,
            delivery_lease_expires_at = null
        where context.id = $1
          and context.delivery_lease_outbox_id = $5
          and context.delivery_lease_attempt_id = $6
        returning context.progress_revision, context.latest_progress_projection
      `,
      [
        input.row.funding_session_id,
        current.current_telegram_account_id,
        input.messageId,
        input.row.state_revision,
        input.row.id,
        input.row.delivery_attempt_id,
        input.row.action === "funding_send",
        input.addressDelivered,
        input.addressRedacted,
        input.row.action !== "funding_qr",
      ],
    );
    if ((attached.rowCount ?? 0) === 0) {
      await client.query(
        `
          update telegram_funding_sessions
          set delivery_lease_outbox_id = null,
              delivery_lease_attempt_id = null,
              delivery_lease_expires_at = null
          where id = $1
            and delivery_lease_outbox_id = $2
            and delivery_lease_attempt_id = $3
        `,
        [
          input.row.funding_session_id,
          input.row.id,
          input.row.delivery_attempt_id,
        ],
      );
      return true;
    }
    if (
      current.progress_revision > input.row.state_revision &&
      current.latest_progress_projection
    ) {
      await client.query(
        `
          update telegram_bot_action_outbox
          set status = 'skipped',
              last_error = 'funding_delivery_superseded_after_success',
              updated_at = now()
          where funding_session_id = $1
            and state_revision = $2
            and action in ('funding_send', 'funding_replacement')
            and status in ('pending', 'retry')
        `,
        [input.row.funding_session_id, current.progress_revision],
      );
      await enqueueFundingEditRevision(client, {
        action: "funding_edit",
        fundingSessionId: input.row.funding_session_id,
        payload: current.latest_progress_projection,
        stateRevision: current.progress_revision,
        telegramAccountId: current.current_telegram_account_id,
        telegramUserId: current.telegram_user_id,
        userId: current.user_id,
      });
    }
    return true;
  });
}

function resultMessage(result: TelegramSendResult): string {
  return result.ok ? "ok" : result.message.slice(0, 240);
}

async function finishTelegramFailure(input: {
  delivery: Extract<TelegramSendResult, { ok: false }>;
  persistentRetry?: boolean;
  pool: Pool;
  row: FundingOutboxRow;
}): Promise<"blocked" | "failed"> {
  if (input.delivery.error === "blocked_or_missing" && !input.persistentRetry) {
    await finishAttempt({
      pool: input.pool,
      row: input.row,
      status: "dead",
      reason: "funding_chat_unreachable",
    });
    return "blocked";
  }
  await finishAttempt({
    pool: input.pool,
    row: input.row,
    status: "retry",
    reason: resultMessage(input.delivery),
    persistentRetry: input.persistentRetry,
    retryAfterSec: input.delivery.retryAfterSec,
  });
  return "failed";
}

export async function deliverTelegramFundingActions(input: {
  pool: Pool;
  renderCoordinator: TelegramFundingRenderCoordinator;
  resolveMessage?: (
    input: Readonly<{
      contextId: string;
      projection: TelegramFundingProgressProjection;
      telegramUserId: string;
    }>,
  ) => Promise<ReturnType<typeof buildTelegramFundingProgressMessage>>;
  telegram: Pick<
    SignalBotTelegramClient,
    "deleteMessage" | "editMessageText" | "sendMessage" | "sendPhoto"
  >;
  limit?: number;
}): Promise<
  Readonly<{
    claimed: number;
    sent: number;
    skipped: number;
    failed: number;
    blocked: number;
    unknown: number;
  }>
> {
  const claimed = await claimFundingOutbox({
    pool: input.pool,
    limit: Math.min(100, Math.max(1, input.limit ?? 25)),
  });
  let sent = 0;
  let skipped = 0;
  let failed = 0;
  let blocked = 0;
  let unknown = 0;
  for (const row of claimed) {
    // A funding context belongs to one Telegram message for its entire life.
    // Historical replacement rows are retained as evidence, never delivered.
    if (row.action === "funding_replacement") {
      await finishAttempt({
        pool: input.pool,
        row,
        status: "dead",
        reason: "funding_owner_scoped_replacement_disabled",
      });
      failed += 1;
      continue;
    }
    const projection = parseTelegramFundingProgressProjection(row.payload);
    if (!projection || projection.fundingContextId !== row.funding_session_id) {
      await finishAttempt({
        pool: input.pool,
        row,
        status: "dead",
        reason: "invalid_funding_projection",
      });
      failed += 1;
      continue;
    }
    const addressFreeTerminalEdit = isSafeAddressRedaction(projection);
    if (projection.receiveAddress !== null && row.action === "funding_send") {
      await finishAttempt({
        pool: input.pool,
        row,
        status: "dead",
        reason: "funding_address_requires_known_edit_target",
      });
      failed += 1;
      continue;
    }
    let destination = await loadCurrentDestination(input.pool, row, projection);
    if (!destination) {
      await finishAttempt({
        pool: input.pool,
        row,
        status: "skipped",
        reason: "funding_destination_unavailable",
      });
      skipped += 1;
      continue;
    }
    if (row.action === "funding_qr") {
      if (shouldDeleteTelegramFundingQr(projection)) {
        const messageId = Number(row.telegram_message_id);
        const deleteMessage = input.telegram.deleteMessage?.bind(
          input.telegram,
        );
        if (
          !Number.isSafeInteger(messageId) ||
          messageId <= 0 ||
          !deleteMessage
        ) {
          await finishAttempt({
            pool: input.pool,
            row,
            status: deleteMessage ? "dead" : "retry",
            reason: "funding_qr_delete_unavailable",
            persistentRetry: !deleteMessage,
          });
          failed += 1;
          continue;
        }
        const deleted = await deleteMessage({
          chat_id: destination.telegram_user_id,
          message_id: messageId,
        }).catch((error: unknown) => ({
          error: "ambiguous" as const,
          message:
            error instanceof Error ? error.message : "delete_qr_photo_failed",
          ok: false as const,
        }));
        if (deleted.ok) {
          const recorded = await recordDeliverySuccess({
            addressDelivered: false,
            addressRedacted: false,
            pool: input.pool,
            row,
            telegramAccountId: destination.telegram_account_id,
            messageId,
          });
          if (recorded) sent += 1;
          else skipped += 1;
          continue;
        }
        const outcome = await finishTelegramFailure({
          delivery: deleted,
          pool: input.pool,
          row,
          persistentRetry: true,
        });
        if (outcome === "blocked") blocked += 1;
        else failed += 1;
        continue;
      }
      const sendPhoto = input.telegram.sendPhoto?.bind(input.telegram);
      if (!sendPhoto) {
        await finishAttempt({
          pool: input.pool,
          row,
          status: "retry",
          reason: "funding_qr_transport_unavailable",
        });
        failed += 1;
        continue;
      }
      let prepared: Awaited<ReturnType<typeof prepareAddressDisclosure>>;
      let qr: Awaited<ReturnType<typeof buildTelegramFundingQrPhoto>>;
      try {
        prepared = await prepareAddressDisclosure({
          pool: input.pool,
          projection,
          row,
        });
        qr = await buildTelegramFundingQrPhoto(projection);
      } catch {
        await finishAttempt({
          pool: input.pool,
          row,
          status: "retry",
          reason: "funding_qr_prepare_failed",
        });
        failed += 1;
        continue;
      }
      if (!prepared) {
        await finishAttempt({
          pool: input.pool,
          row,
          status: "skipped",
          reason: "funding_disclosure_attempt_superseded",
        });
        skipped += 1;
        continue;
      }
      destination = prepared.destination;
      const delivery = await sendPhoto({
        caption: qr.caption,
        chat_id: destination.telegram_user_id,
        filename: qr.filename,
        parse_mode: "MarkdownV2",
        photo: qr.photo,
        reply_markup: qr.reply_markup,
      }).catch((error: unknown) => ({
        error: "ambiguous" as const,
        message:
          error instanceof Error ? error.message : "send_qr_photo_failed",
        ok: false as const,
      }));
      if (delivery.ok && delivery.messageId) {
        const recorded = await recordDeliverySuccess({
          addressDelivered: false,
          addressRedacted: false,
          pool: input.pool,
          row,
          telegramAccountId: destination.telegram_account_id,
          messageId: delivery.messageId,
        });
        if (recorded) sent += 1;
        else skipped += 1;
        continue;
      }
      if (delivery.ok || delivery.error === "ambiguous") {
        await finishAttempt({
          pool: input.pool,
          row,
          status: "delivery_unknown",
          reason: "funding_qr_outcome_unknown",
        });
        unknown += 1;
        continue;
      }
      const outcome = await finishTelegramFailure({
        delivery,
        pool: input.pool,
        row,
      });
      if (outcome === "blocked") blocked += 1;
      else failed += 1;
      continue;
    }
    const safeAddressRedaction =
      addressFreeTerminalEdit &&
      destination.address_disclosure_attempt_revision >
        destination.address_redacted_revision;
    const frozenMessage = buildTelegramFundingProgressMessage(projection);
    let message: ReturnType<typeof buildTelegramFundingProgressMessage>;
    try {
      message =
        safeAddressRedaction ||
        !input.resolveMessage ||
        destination.active_buy_return_revision == null
          ? frozenMessage
          : await input.resolveMessage({
              contextId: row.funding_session_id,
              projection,
              telegramUserId: destination.telegram_user_id,
            });
    } catch {
      await finishAttempt({
        pool: input.pool,
        row,
        status: "retry",
        reason: "funding_presentation_unavailable",
        persistentRetry: safeAddressRedaction,
      });
      failed += 1;
      continue;
    }
    if (
      message.durableFundingDeliveryRequired !==
        frozenMessage.durableFundingDeliveryRequired ||
      message.qrText !== frozenMessage.qrText
    ) {
      await finishAttempt({
        pool: input.pool,
        row,
        status: "dead",
        reason: "funding_presentation_changed_address_surface",
      });
      failed += 1;
      continue;
    }
    {
      if (row.action === "funding_edit") {
        let editMessageId = safeAddressRedaction
          ? destination.address_disclosure_message_id
          : destination.telegram_message_id;
        const editMessageText = input.telegram.editMessageText?.bind(
          input.telegram,
        );
        if (editMessageId == null || !editMessageText) {
          if (safeAddressRedaction) {
            await finishAttempt({
              pool: input.pool,
              row,
              status: editMessageText ? "dead" : "retry",
              reason: "funding_redaction_edit_target_unavailable",
              persistentRetry: !editMessageText,
            });
            failed += 1;
            continue;
          }
          await finishAttempt({
            pool: input.pool,
            row,
            status: editMessageText ? "dead" : "retry",
            reason: "funding_owner_edit_target_unavailable",
          });
          failed += 1;
          continue;
        }
        if (projection.receiveAddress !== null || message.qrText != null) {
          let prepared: Awaited<ReturnType<typeof prepareAddressDisclosure>>;
          try {
            prepared = await prepareAddressDisclosure({
              pool: input.pool,
              projection,
              row,
            });
          } catch {
            await finishAttempt({
              pool: input.pool,
              row,
              status: "retry",
              reason: "funding_lifecycle_guard_unavailable",
            });
            failed += 1;
            continue;
          }
          if (!prepared) {
            await finishAttempt({
              pool: input.pool,
              row,
              status: "skipped",
              reason: "funding_disclosure_attempt_superseded",
            });
            skipped += 1;
            continue;
          }
          destination = prepared.destination;
          editMessageId = prepared.messageId;
        }
        const editTelegramUserId = destination.telegram_user_id;
        const renderAttempt = {
          chatId: editTelegramUserId,
          messageId: Number(editMessageId),
          renderToken: `funding:${row.delivery_attempt_id}`,
        };
        let guarded: SignalBotMenuRenderLockResult<TelegramSendResult>;
        try {
          const claimed = input.renderCoordinator.claimBackground
            ? await input.renderCoordinator.claimBackground(renderAttempt)
            : (await input.renderCoordinator.claim(renderAttempt), true);
          if (!claimed) {
            await finishAttempt({
              pool: input.pool,
              row,
              status: safeAddressRedaction ? "retry" : "skipped",
              reason: "funding_render_superseded",
              persistentRetry: safeAddressRedaction,
            });
            if (safeAddressRedaction) failed += 1;
            else skipped += 1;
            continue;
          }
          guarded = await input.renderCoordinator.runExclusive({
            ...renderAttempt,
            deliver: () =>
              editMessageText({
                chat_id: editTelegramUserId,
                disable_web_page_preview: true,
                message_id: Number(editMessageId),
                parse_mode: message.parse_mode ?? "MarkdownV2",
                reply_markup: message.reply_markup,
                text: message.text,
              }).catch((error: unknown) => ({
                error: "ambiguous" as const,
                message: error instanceof Error ? error.message : "edit_failed",
                ok: false as const,
              })),
          });
        } catch {
          await finishAttempt({
            pool: input.pool,
            row,
            status: "retry",
            reason: "funding_render_guard_unavailable",
            persistentRetry: safeAddressRedaction,
          });
          failed += 1;
          continue;
        }
        if (guarded.status === "superseded") {
          await finishAttempt({
            pool: input.pool,
            row,
            status: safeAddressRedaction ? "retry" : "skipped",
            reason: "funding_render_superseded",
            persistentRetry: safeAddressRedaction,
          });
          if (safeAddressRedaction) failed += 1;
          else skipped += 1;
          continue;
        }
        if (guarded.status === "unavailable") {
          await finishAttempt({
            pool: input.pool,
            row,
            status: "retry",
            reason: "funding_render_guard_unavailable",
            persistentRetry: safeAddressRedaction,
          });
          failed += 1;
          continue;
        }
        const delivery = guarded.value;
        if (delivery.ok) {
          const recorded = await recordDeliverySuccess({
            addressDelivered:
              projection.receiveAddress !== null || message.qrText != null,
            addressRedacted:
              row.action === "funding_edit" &&
              projection.receiveAddress === null &&
              message.qrText == null,
            pool: input.pool,
            row,
            telegramAccountId: destination.telegram_account_id,
            messageId: delivery.messageId ?? Number(editMessageId),
          });
          if (recorded) sent += 1;
          else {
            await finishAttempt({
              pool: input.pool,
              row,
              status: safeAddressRedaction ? "retry" : "skipped",
              reason: "funding_delivery_superseded",
              persistentRetry: safeAddressRedaction,
            });
            if (safeAddressRedaction) failed += 1;
            else skipped += 1;
          }
          continue;
        }
        if (delivery.error === "message_not_editable") {
          if (safeAddressRedaction) {
            await finishAttempt({
              pool: input.pool,
              row,
              status: "dead",
              reason: "funding_redaction_message_not_editable",
            });
            failed += 1;
            continue;
          }
          await finishAttempt({
            pool: input.pool,
            row,
            status: "dead",
            reason: "funding_owner_message_not_editable",
          });
          failed += 1;
          continue;
        }
        const outcome = await finishTelegramFailure({
          delivery,
          persistentRetry: safeAddressRedaction,
          pool: input.pool,
          row,
        });
        if (outcome === "blocked") blocked += 1;
        else failed += 1;
        continue;
      }

      const delivery = await input.telegram
        .sendMessage({
          chat_id: destination.telegram_user_id,
          disable_web_page_preview: true,
          parse_mode: message.parse_mode ?? "MarkdownV2",
          reply_markup: message.reply_markup,
          text: message.text,
        })
        .catch((error: unknown) => ({
          error: "ambiguous" as const,
          message: error instanceof Error ? error.message : "send_failed",
          ok: false as const,
        }));
      if (delivery.ok) {
        if (!delivery.messageId || delivery.messageId <= 0) {
          await finishAttempt({
            pool: input.pool,
            row,
            status: "delivery_unknown",
            reason: "funding_send_missing_message_id",
          });
          unknown += 1;
          continue;
        }
        const recorded = await recordDeliverySuccess({
          addressDelivered:
            projection.receiveAddress !== null || message.qrText != null,
          addressRedacted: false,
          pool: input.pool,
          row,
          telegramAccountId: destination.telegram_account_id,
          messageId: delivery.messageId,
        });
        if (recorded) sent += 1;
        else {
          await finishAttempt({
            pool: input.pool,
            row,
            status: "skipped",
            reason: "funding_delivery_superseded",
          });
          skipped += 1;
        }
        continue;
      }
      if (delivery.error === "ambiguous") {
        await finishAttempt({
          pool: input.pool,
          row,
          status: "delivery_unknown",
          reason: "funding_send_outcome_unknown",
        });
        unknown += 1;
        continue;
      }
      const outcome = await finishTelegramFailure({
        delivery,
        pool: input.pool,
        row,
      });
      if (outcome === "blocked") blocked += 1;
      else failed += 1;
    }
  }
  return {
    claimed: claimed.length,
    sent,
    skipped,
    failed,
    blocked,
    unknown,
  };
}

export async function rearmTelegramFundingTerminalDelivery(input: {
  pool: Pick<Pool, "query">;
  telegramUserId: string | number;
}): Promise<number> {
  const result = await input.pool.query<{ rearmed: number }>(
    `
      select rearm_telegram_funding_delivery(
        account.telegram_user_id,
        account.id
      ) as rearmed
      from user_telegram_accounts account
      join users app_user on app_user.id = account.user_id
      where account.telegram_user_id = $1
        and coalesce(app_user.is_active, true) = true
      limit 1
    `,
    [String(input.telegramUserId)],
  );
  return Number(result.rows[0]?.rearmed ?? 0);
}

export async function cleanupTelegramFundingContexts(input: {
  pool: Pool;
  limit?: number;
  retentionDays?: number;
}): Promise<number> {
  const buyIntentBlockerSql = `
          and not exists (
            select 1
            from telegram_funding_buy_resume_generations generation
            join telegram_trade_intents intent
              on intent.id = generation.trade_intent_id
            where generation.telegram_funding_session_id = context.id
              and (
                intent.status in ('executing', 'submitted', 'reconcile_required')
                or intent.submit_started_at is not null
                or intent.order_id is not null
                or intent.execution_id is not null
                or intent.venue_order_id is not null
                or intent.tx_signature is not null
                or coalesce(intent.result->'setupTransactions', '[]'::jsonb) <> '[]'::jsonb
              )
          )
      `;
  const limit = Math.min(10_000, Math.max(1, input.limit ?? 1_000));
  const retentionDays = Math.min(
    3650,
    Math.max(30, Math.trunc(input.retentionDays ?? 365)),
  );
  return tx(input.pool, async (client) => {
    await client.query(
      "select set_config('hunch.telegram_funding_retention_cleanup', 'on', true)",
    );
    const candidates = await client.query<{ id: string }>(
      `
        select context.id
        from telegram_funding_sessions context
        join funding_receive_sessions receive
          on receive.id = context.receive_session_id
         and receive.user_id = context.user_id
        where context.updated_at < now() - ($1::int * interval '1 day')
          and receive.status in ('completed', 'expired', 'cancelled')
          and not exists (
            select 1
            from funding_receive_receipts receipt
            left join funding_operations operation
              on operation.id = receipt.child_funding_operation_id
            where receipt.receive_session_id = context.receive_session_id
              and (
                receipt.status <> 'ready'
                or (
                  operation.id is not null
                  and operation.status not in ('completed', 'refunded', 'cancelled', 'failed')
                )
              )
          )
          and not exists (
            select 1
            from telegram_bot_action_outbox outbox
            where outbox.funding_session_id = context.id
              and outbox.action in (
                'funding_send',
                'funding_edit',
                'funding_replacement',
                'funding_qr'
              )
              and outbox.status in ('pending', 'retry', 'sending', 'delivery_unknown')
          )
          and not (
            context.address_disclosure_attempt_revision >
                context.address_redacted_revision
          )
          ${buyIntentBlockerSql}
        order by context.updated_at asc
        limit $2
        for update of context skip locked
      `,
      [retentionDays, limit],
    );
    const ids = candidates.rows.map((row) => row.id);
    if (ids.length === 0) return 0;
    await client.query(
      `delete from telegram_funding_mutations
       where funding_context_id = any($1::uuid[])`,
      [ids],
    );
    await client.query(
      `delete from telegram_funding_buy_resume_generations
       where telegram_funding_session_id = any($1::uuid[])`,
      [ids],
    );
    await client.query(
      `delete from telegram_funding_buy_continuations
       where telegram_funding_session_id = any($1::uuid[])`,
      [ids],
    );
    await client.query(
      `update telegram_funding_sessions
       set active_consent_revision = null,
           active_buy_return_revision = null,
           projected_buy_return_revision = 0,
           projected_buy_policy_revision = null
       where id = any($1::uuid[])`,
      [ids],
    );
    await client.query(
      `delete from telegram_funding_buy_return_revisions
       where telegram_funding_session_id = any($1::uuid[])`,
      [ids],
    );
    await client.query(
      `delete from telegram_funding_consents
       where telegram_funding_session_id = any($1::uuid[])`,
      [ids],
    );
    const deleted = await client.query(
      `delete from telegram_funding_sessions
       where id = any($1::uuid[])`,
      [ids],
    );
    return deleted.rowCount ?? 0;
  });
}
