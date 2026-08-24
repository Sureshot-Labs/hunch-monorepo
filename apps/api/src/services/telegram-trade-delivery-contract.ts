import type { Pool } from "@hunch/infra";

/**
 * Historical storage identifier for the revisioned Telegram trade card.
 * The payload now covers the whole trade lifecycle, not only funding.
 */
export const TELEGRAM_TRADE_LIFECYCLE_OUTBOX_ACTION = "trade_funding_edit";
export const TELEGRAM_TRADE_LIFECYCLE_DELIVERY_PHASE_PAYLOAD_KEY =
  "_telegramDeliveryPhase";

/** A crashed terminal edit crossed an unknowable Telegram delivery boundary. */
export const TELEGRAM_TRADE_LIFECYCLE_DELIVERY_UNKNOWN_ERROR =
  "telegram_trade_lifecycle_edit_delivery_unknown";

/**
 * Persisted on the intent when its current Telegram message must no longer be
 * edited. A later lifecycle revision is delivered as a new message and then
 * becomes the new editable generation.
 */
export const TELEGRAM_TRADE_LIFECYCLE_MESSAGE_BOUNDARY_RESULT_KEY =
  "telegramLifecycleMessageBoundary";

/**
 * A terminal trade is delivered either by the revisioned lifecycle edit or by
 * the generic notification fallback. Persisting the fallback owner on the
 * intent prevents both delivery paths from presenting the same fill.
 */
export const TELEGRAM_TRADE_TERMINAL_DELIVERY_OWNER_RESULT_KEY =
  "telegramTerminalDeliveryOwner";
export const TELEGRAM_TRADE_GENERIC_NOTIFICATION_OWNER = "generic_notification";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A funding-linked or sealed-v2 trade owns one revisioned Telegram card.
 * Callback handlers must not render a second terminal message for these rows.
 */
export function isTelegramTradeLifecycleDeliveryEligible(
  input: Readonly<{
    chatId: string | null;
    deliveryMode: string;
    fundingOperationId: string | null;
    result: unknown;
    telegramMessageId: string | null;
  }>,
): boolean {
  if (input.chatId == null || input.telegramMessageId == null) return false;
  if (input.fundingOperationId != null) return true;
  if (input.deliveryMode !== "app_handoff" || !isRecord(input.result)) {
    return false;
  }
  const execution = input.result.appHandoffExecution;
  return isRecord(execution) && execution.version === 2;
}

/**
 * A user-selected private screen owns the visible Telegram message. Persist
 * that generation change before its render token is claimed, so an already
 * queued lifecycle revision can only continue on a new standalone card.
 */
export async function fenceTelegramTradeLifecycleNavigation(input: {
  chatId: string;
  db: Pick<Pool, "query">;
  intentId?: string | null;
  messageId: number;
  telegramUserId: string;
}): Promise<number> {
  const result = await input.db.query(
    `with rearmed_delivery as (
       update telegram_bot_action_outbox outbox
          set status = 'retry',
              next_attempt_at = clock_timestamp(),
              last_error = 'telegram_trade_lifecycle_navigation_during_delivery',
              delivery_attempt_id = null,
              delivery_started_at = null,
              updated_at = clock_timestamp()
         from telegram_trade_intents delivery_intent
        where delivery_intent.chat_id = $1::text
          and delivery_intent.telegram_message_id = $2::bigint
          and delivery_intent.telegram_user_id = $3::text
          and ($4::uuid is null or delivery_intent.id = $4::uuid)
          and outbox.trade_intent_id = delivery_intent.id
          and outbox.action = $6::text
          and coalesce(outbox.payload ->> $7::text, 'edit') = 'edit'
          and outbox.state_revision =
                (delivery_intent.result ->> 'shortfallProgressRevision')::integer
          and outbox.status = 'sending'
        returning outbox.trade_intent_id
     )
     update telegram_trade_intents intent_row
        set result = case
              when intent_row.result -> $5::text ->> 'mutation' = 'send'
                then coalesce(intent_row.result, '{}'::jsonb)
              else coalesce(intent_row.result, '{}'::jsonb) ||
                jsonb_build_object(
                  $5::text,
                  jsonb_build_object(
                    'messageId', $2::bigint,
                    'reason', 'navigation',
                    'mutation', 'navigation',
                    'recordedAt', clock_timestamp()
                  )
                )
            end,
            updated_at = clock_timestamp()
      where intent_row.chat_id = $1::text
        and intent_row.telegram_message_id = $2::bigint
        and intent_row.telegram_user_id = $3::text
        and ($4::uuid is null or intent_row.id = $4::uuid)
        and (
          intent_row.funding_operation_id is not null
          or (
            intent_row.delivery_mode = 'app_handoff'
            and intent_row.result #>> '{appHandoffExecution,version}' = '2'
          )
        )`,
    [
      input.chatId,
      input.messageId,
      input.telegramUserId,
      input.intentId ?? null,
      TELEGRAM_TRADE_LIFECYCLE_MESSAGE_BOUNDARY_RESULT_KEY,
      TELEGRAM_TRADE_LIFECYCLE_OUTBOX_ACTION,
      TELEGRAM_TRADE_LIFECYCLE_DELIVERY_PHASE_PAYLOAD_KEY,
    ],
  );
  return result.rowCount ?? 0;
}
