import type { DbQuery } from "../db.js";
import {
  buildSignalBotMenuScreen,
  isSignalBotAdmin,
  type SignalBotConfig,
  type SignalBotTelegramClient,
  type TelegramSendResult,
} from "./signal-bot.js";
import { markTelegramNotificationsUnreachable } from "./telegram-notification-preferences.js";

type TelegramBotActionOutboxRow = {
  attempt_count: number;
  id: string;
  telegram_account_id: string;
  telegram_user_id: string;
  user_id: string;
};

type TelegramBotActionDestinationRow = {
  telegram_user_id: string;
};

const MAX_DELIVERY_ATTEMPTS = 8;

async function claimTelegramBotActionOutbox(input: {
  db: DbQuery;
  limit: number;
}): Promise<TelegramBotActionOutboxRow[]> {
  const { rows } = await input.db.query<TelegramBotActionOutboxRow>(
    `
      with candidates as (
        select id
        from telegram_bot_action_outbox
        where action = 'welcome_menu'
          and (
            (
              status in ('pending', 'retry')
              and next_attempt_at <= now()
            ) or (
              status = 'sending'
              and updated_at <= now() - interval '5 minutes'
            )
          )
        order by next_attempt_at asc, created_at asc
        for update skip locked
        limit $1
      )
      update telegram_bot_action_outbox outbox
      set status = 'sending',
          attempt_count = outbox.attempt_count + 1,
          updated_at = now()
      from candidates
      where outbox.id = candidates.id
      returning
        outbox.id,
        outbox.user_id,
        outbox.telegram_account_id,
        outbox.telegram_user_id,
        outbox.attempt_count
    `,
    [input.limit],
  );
  return rows;
}

async function loadCurrentDestination(input: {
  db: DbQuery;
  row: TelegramBotActionOutboxRow;
}): Promise<TelegramBotActionDestinationRow | null> {
  const { rows } = await input.db.query<TelegramBotActionDestinationRow>(
    `
      select account.telegram_user_id
      from user_telegram_accounts account
      join users app_user on app_user.id = account.user_id
      where account.id = $1
        and account.user_id = $2
        and account.telegram_user_id = $3
        and coalesce(app_user.is_active, true) = true
      limit 1
    `,
    [
      input.row.telegram_account_id,
      input.row.user_id,
      input.row.telegram_user_id,
    ],
  );
  return rows[0] ?? null;
}

async function markActionSkipped(input: {
  db: DbQuery;
  id: string;
  reason: string;
}): Promise<void> {
  await input.db.query(
    `
      update telegram_bot_action_outbox
      set status = 'skipped', last_error = $2, updated_at = now()
      where id = $1
    `,
    [input.id, input.reason],
  );
}

async function markActionSent(input: {
  db: DbQuery;
  id: string;
  messageId: number | null;
}): Promise<void> {
  await input.db.query(
    `
      update telegram_bot_action_outbox
      set status = 'sent',
          telegram_message_id = $2,
          last_error = null,
          sent_at = now(),
          updated_at = now()
      where id = $1
    `,
    [input.id, input.messageId],
  );
}

async function markActionDead(input: {
  db: DbQuery;
  id: string;
  message: string;
}): Promise<void> {
  await input.db.query(
    `
      update telegram_bot_action_outbox
      set status = 'dead', last_error = $2, updated_at = now()
      where id = $1
    `,
    [input.id, input.message],
  );
}

async function markActionFailed(input: {
  attemptCount: number;
  db: DbQuery;
  id: string;
  message: string;
  retryAfterSec?: number;
}): Promise<void> {
  const dead = input.attemptCount >= MAX_DELIVERY_ATTEMPTS;
  const retryAfterSec = Math.max(
    1,
    Math.min(
      3_600,
      input.retryAfterSec ?? 5 * 2 ** Math.max(0, input.attemptCount - 1),
    ),
  );
  await input.db.query(
    `
      update telegram_bot_action_outbox
      set status = $2,
          last_error = $3,
          next_attempt_at = now() + ($4::int * interval '1 second'),
          updated_at = now()
      where id = $1
    `,
    [input.id, dead ? "dead" : "retry", input.message, retryAfterSec],
  );
}

export async function cleanupTelegramBotActionOutbox(input: {
  db: DbQuery;
  limit?: number;
  retentionDays?: number;
}): Promise<number> {
  const limit = Math.min(10_000, Math.max(1, input.limit ?? 1_000));
  const retentionDays = Math.min(
    365,
    Math.max(1, Math.trunc(input.retentionDays ?? 90)),
  );
  const result = await input.db.query(
    `
      with expired as (
        select id
        from telegram_bot_action_outbox
        where status in ('sent', 'skipped', 'dead')
          and updated_at < now() - ($1::int * interval '1 day')
        order by updated_at asc
        limit $2
      )
      delete from telegram_bot_action_outbox outbox
      using expired
      where outbox.id = expired.id
    `,
    [retentionDays, limit],
  );
  return result.rowCount ?? 0;
}

export async function deliverTelegramBotOnboardingActions(input: {
  config: Pick<
    SignalBotConfig,
    "adminUserIds" | "appBaseUrl" | "telegramMiniAppLinkBase"
  >;
  db: DbQuery;
  limit?: number;
  telegram: Pick<SignalBotTelegramClient, "sendMessage">;
}): Promise<{
  blocked: number;
  claimed: number;
  failed: number;
  sent: number;
  skipped: number;
}> {
  const claimedRows = await claimTelegramBotActionOutbox({
    db: input.db,
    limit: Math.min(100, Math.max(1, input.limit ?? 25)),
  });
  let blocked = 0;
  let failed = 0;
  let sent = 0;
  let skipped = 0;

  for (const row of claimedRows) {
    const destination = await loadCurrentDestination({ db: input.db, row });
    if (!destination) {
      skipped += 1;
      await markActionSkipped({
        db: input.db,
        id: row.id,
        reason: "The Telegram account link changed before delivery.",
      });
      continue;
    }

    const telegramUserId = Number(destination.telegram_user_id);
    const menu = buildSignalBotMenuScreen({
      appBaseUrl: input.config.appBaseUrl,
      audience: "linked",
      isAdmin: isSignalBotAdmin(
        input.config,
        Number.isSafeInteger(telegramUserId) ? telegramUserId : null,
      ),
      miniAppEnabled: input.config.telegramMiniAppLinkBase != null,
      screen: "home",
    });

    let result: TelegramSendResult;
    try {
      result = await input.telegram.sendMessage({
        chat_id: destination.telegram_user_id,
        disable_web_page_preview: true,
        parse_mode: "MarkdownV2",
        reply_markup: menu.keyboard,
        text: menu.text,
      });
    } catch (error) {
      result = {
        error: "other",
        message: error instanceof Error ? error.message : String(error),
        ok: false,
      };
    }

    if (result.ok) {
      sent += 1;
      await markActionSent({
        db: input.db,
        id: row.id,
        messageId: result.messageId,
      });
      continue;
    }
    if (result.error === "blocked_or_missing") {
      blocked += 1;
      await markTelegramNotificationsUnreachable({
        db: input.db,
        userId: row.user_id,
      });
      await markActionDead({
        db: input.db,
        id: row.id,
        message: result.message,
      });
      continue;
    }
    failed += 1;
    await markActionFailed({
      attemptCount: row.attempt_count,
      db: input.db,
      id: row.id,
      message: result.message,
      retryAfterSec: result.retryAfterSec,
    });
  }

  return {
    blocked,
    claimed: claimedRows.length,
    failed,
    sent,
    skipped,
  };
}
