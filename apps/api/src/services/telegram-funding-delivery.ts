import { randomUUID } from "node:crypto";

import { tx, type Pool, type PoolClient } from "@hunch/infra";

import type {
  SignalBotTelegramClient,
  TelegramSendResult,
} from "./signal-bot-contracts.js";
import { buildTelegramFundingProgressMessage } from "./telegram-funding-presentation.js";
import { parseTelegramFundingProgressProjection } from "./telegram-funding-progress.js";
import {
  claimSignalBotMenuRender,
  isSignalBotMenuRenderCurrent,
  withSignalBotMenuRenderLock,
  type SignalBotMenuRenderLockResult,
} from "./telegram-bot-menu-state.js";

type FundingOutboxRow = Readonly<{
  id: string;
  action: "funding_send" | "funding_edit" | "funding_replacement";
  funding_session_id: string;
  state_revision: number;
  payload: unknown;
  attempt_count: number;
  delivery_attempt_id: string;
}>;

type FundingDestinationRow = Readonly<{
  active_buy_return_revision: number | null;
  telegram_account_id: string;
  telegram_user_id: string;
  telegram_message_id: string | number | null;
  progress_revision: number;
}>;

const MAX_DELIVERY_ATTEMPTS = 8;
const DELIVERY_LEASE_SECONDS = 300;

async function enqueueFundingDeliveryRevision(
  client: PoolClient,
  input: Readonly<{
    action: FundingOutboxRow["action"];
    fundingSessionId: string;
    payload: unknown;
    stateRevision: number;
    telegramAccountId: string;
    telegramUserId: string;
    userId: string;
  }>,
): Promise<void> {
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
    `,
    [
      input.action,
      input.telegramAccountId,
      input.userId,
      input.telegramUserId,
      input.fundingSessionId,
      input.stateRevision,
      JSON.stringify(input.payload),
    ],
  );
}

export type TelegramFundingRenderCoordinator = Readonly<{
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

export function createTelegramFundingRenderCoordinator(redis: {
  eval(
    script: string,
    options: { arguments: string[]; keys: string[] },
  ): Promise<unknown>;
  get(key: string): Promise<string | null>;
  set(
    key: string,
    value: string,
    options?: { EX?: number; NX?: boolean; PX?: number },
  ): Promise<unknown>;
}): TelegramFundingRenderCoordinator {
  return {
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
        where outbox.action in ('funding_send', 'funding_replacement')
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
          and outbox.action in ('funding_send', 'funding_edit', 'funding_replacement')
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
          outbox.attempt_count
        from telegram_bot_action_outbox outbox
        join telegram_funding_sessions context
          on context.id = outbox.funding_session_id
         and context.progress_revision = outbox.state_revision
        where outbox.action in ('funding_send', 'funding_edit', 'funding_replacement')
          and (
            (outbox.status in ('pending', 'retry') and outbox.next_attempt_at <= now())
            or (
              outbox.action = 'funding_edit'
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
            and action in ('funding_send', 'funding_edit', 'funding_replacement')
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
): Promise<FundingDestinationRow | null> {
  const { rows } = await pool.query<FundingDestinationRow>(
    `
      select
        context.active_buy_return_revision,
        account.id::text as telegram_account_id,
        account.telegram_user_id,
        context.telegram_message_id,
        context.progress_revision
      from telegram_funding_sessions context
      join user_telegram_accounts account
        on account.id = context.telegram_account_id
       and account.user_id = context.user_id
       and account.telegram_user_id = context.telegram_user_id
      join users app_user on app_user.id = context.user_id
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
        and coalesce(app_user.is_active, true) = true
      limit 1
    `,
    [
      row.funding_session_id,
      row.state_revision,
      row.id,
      row.delivery_attempt_id,
    ],
  );
  return rows[0] ?? null;
}

async function finishAttempt(input: {
  pool: Pool;
  row: FundingOutboxRow;
  status: "dead" | "delivery_unknown" | "retry" | "skipped";
  reason: string;
  retryAfterSec?: number;
}): Promise<void> {
  const dead = input.row.attempt_count >= MAX_DELIVERY_ATTEMPTS;
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
  pool: Pool;
  row: FundingOutboxRow;
  telegramAccountId: string;
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
    await client.query(
      `
        update telegram_bot_action_outbox
        set status = 'sent',
            telegram_account_id = $2,
            telegram_message_id = $3,
            last_error = null,
            sent_at = now(),
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
      ],
    );
    if (current.current_telegram_account_id !== input.telegramAccountId) {
      await client.query(
        `
          update telegram_funding_sessions
          set telegram_message_id = case
                when $4::uuid is not null then $5
                else telegram_message_id
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
        ],
      );
      if (
        current.current_telegram_account_id &&
        current.latest_progress_projection
      ) {
        await enqueueFundingDeliveryRevision(client, {
          action:
            input.row.action === "funding_edit"
              ? "funding_replacement"
              : "funding_edit",
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
            last_delivered_revision = greatest(last_delivered_revision, $4),
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
        input.row.action !== "funding_edit",
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
      await enqueueFundingDeliveryRevision(client, {
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

async function enqueueReplacementAfterMissingEdit(input: {
  pool: Pool;
  row: FundingOutboxRow;
  telegramAccountId: string;
}): Promise<boolean> {
  return tx(input.pool, async (client) => {
    const current = await client.query<{
      latest_progress_projection: unknown;
      progress_revision: number;
      telegram_user_id: string;
      user_id: string;
    }>(
      `
        select
          context.latest_progress_projection,
          context.progress_revision,
          context.telegram_user_id,
          context.user_id
        from telegram_bot_action_outbox outbox
        join telegram_funding_sessions context
          on context.id = outbox.funding_session_id
        join user_telegram_accounts account
          on account.id = context.telegram_account_id
         and account.user_id = context.user_id
         and account.telegram_user_id = context.telegram_user_id
        where outbox.id = $1
          and outbox.delivery_attempt_id = $2
          and outbox.status = 'sending'
          and context.delivery_lease_outbox_id = outbox.id
          and context.delivery_lease_attempt_id = outbox.delivery_attempt_id
          and account.id = $3
        for update of outbox, context
      `,
      [input.row.id, input.row.delivery_attempt_id, input.telegramAccountId],
    );
    const destination = current.rows[0];
    if (!destination?.latest_progress_projection) {
      await client.query(
        `
          update telegram_bot_action_outbox
          set status = 'skipped',
              last_error = 'funding_delivery_superseded',
              updated_at = now()
          where id = $1
            and delivery_attempt_id = $2
            and status = 'sending'
        `,
        [input.row.id, input.row.delivery_attempt_id],
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
      return false;
    }
    await client.query(
      `
        update telegram_bot_action_outbox
        set status = 'skipped',
            last_error = 'funding_edit_message_unavailable',
            updated_at = now()
        where id = $1
          and delivery_attempt_id = $2
          and status = 'sending'
      `,
      [input.row.id, input.row.delivery_attempt_id],
    );
    await client.query(
      `
        update telegram_funding_sessions
        set telegram_message_id = null,
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
      ],
    );
    await enqueueFundingDeliveryRevision(client, {
      action: "funding_replacement",
      fundingSessionId: input.row.funding_session_id,
      payload: destination.latest_progress_projection,
      stateRevision: destination.progress_revision,
      telegramAccountId: input.telegramAccountId,
      telegramUserId: destination.telegram_user_id,
      userId: destination.user_id,
    });
    return true;
  });
}

function resultMessage(result: TelegramSendResult): string {
  return result.ok ? "ok" : result.message.slice(0, 240);
}

export async function deliverTelegramFundingActions(input: {
  pool: Pool;
  renderCoordinator: TelegramFundingRenderCoordinator;
  resolveMessage?: (
    input: Readonly<{
      contextId: string;
      telegramUserId: string;
    }>,
  ) => Promise<ReturnType<typeof buildTelegramFundingProgressMessage>>;
  telegram: Pick<SignalBotTelegramClient, "editMessageText" | "sendMessage">;
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
    const destination = await loadCurrentDestination(input.pool, row);
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
    let message: ReturnType<typeof buildTelegramFundingProgressMessage>;
    try {
      message =
        input.resolveMessage && destination.active_buy_return_revision != null
          ? await input.resolveMessage({
              contextId: row.funding_session_id,
              telegramUserId: destination.telegram_user_id,
            })
          : buildTelegramFundingProgressMessage(projection);
    } catch {
      await finishAttempt({
        pool: input.pool,
        row,
        status: "retry",
        reason: "funding_presentation_unavailable",
      });
      failed += 1;
      continue;
    }
    if (row.action === "funding_edit") {
      const editMessageText = input.telegram.editMessageText?.bind(
        input.telegram,
      );
      if (destination.telegram_message_id == null || !editMessageText) {
        const queued = await enqueueReplacementAfterMissingEdit({
          pool: input.pool,
          row,
          telegramAccountId: destination.telegram_account_id,
        });
        skipped += 1;
        if (!queued) failed += 1;
        continue;
      }
      const renderAttempt = {
        chatId: destination.telegram_user_id,
        messageId: Number(destination.telegram_message_id),
        renderToken: `funding:${row.delivery_attempt_id}`,
      };
      let guarded: SignalBotMenuRenderLockResult<TelegramSendResult>;
      try {
        await input.renderCoordinator.claim(renderAttempt);
        guarded = await input.renderCoordinator.runExclusive({
          ...renderAttempt,
          deliver: () =>
            editMessageText({
              chat_id: destination.telegram_user_id,
              disable_web_page_preview: true,
              message_id: Number(destination.telegram_message_id),
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
        });
        failed += 1;
        continue;
      }
      if (guarded.status === "superseded") {
        await finishAttempt({
          pool: input.pool,
          row,
          status: "skipped",
          reason: "funding_render_superseded",
        });
        skipped += 1;
        continue;
      }
      if (guarded.status === "unavailable") {
        await finishAttempt({
          pool: input.pool,
          row,
          status: "retry",
          reason: "funding_render_guard_unavailable",
        });
        failed += 1;
        continue;
      }
      const delivery = guarded.value;
      if (delivery.ok) {
        const recorded = await recordDeliverySuccess({
          pool: input.pool,
          row,
          telegramAccountId: destination.telegram_account_id,
          messageId:
            delivery.messageId ?? Number(destination.telegram_message_id),
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
      if (delivery.error === "message_not_editable") {
        const queued = await enqueueReplacementAfterMissingEdit({
          pool: input.pool,
          row,
          telegramAccountId: destination.telegram_account_id,
        });
        skipped += 1;
        if (!queued) failed += 1;
        continue;
      }
      if (delivery.error === "blocked_or_missing") {
        await finishAttempt({
          pool: input.pool,
          row,
          status: "dead",
          reason: "funding_chat_unreachable",
        });
        blocked += 1;
        continue;
      }
      await finishAttempt({
        pool: input.pool,
        row,
        status: "retry",
        reason: resultMessage(delivery),
        retryAfterSec: delivery.retryAfterSec,
      });
      failed += 1;
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
    if (delivery.error === "blocked_or_missing") {
      await finishAttempt({
        pool: input.pool,
        row,
        status: "dead",
        reason: "funding_chat_unreachable",
      });
      blocked += 1;
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
    await finishAttempt({
      pool: input.pool,
      row,
      status: "retry",
      reason: resultMessage(delivery),
      retryAfterSec: delivery.retryAfterSec,
    });
    failed += 1;
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
              and outbox.action in ('funding_send', 'funding_edit', 'funding_replacement')
              and outbox.status in ('pending', 'retry', 'sending', 'delivery_unknown')
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
