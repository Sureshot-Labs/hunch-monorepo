import type { Pool } from "@hunch/infra";

/** Creates a new unconfirmed review, never revives the expired trade. */
export async function refreshExpiredTelegramQuote(input: {
  db: Pick<Pool, "query">;
  intentId: string;
  telegramUserId: string;
  chatId: string;
  messageId: number;
  ttlSec: number;
}): Promise<{ id: string; action: string } | null> {
  const result = await input.db.query<{ id: string; action: string }>(
    `with source_intent as (
       select old_intent.* from telegram_trade_intents old_intent
       where old_intent.id = $1::uuid
         and old_intent.telegram_user_id = $2
         and old_intent.chat_id = $3
         and old_intent.telegram_message_id = $4::bigint
         and old_intent.status = 'expired'
         and old_intent.result ->> 'quoteExpiredReview' = 'true'
         and old_intent.action in ('buy', 'sell')
         and old_intent.submit_started_at is null
         and old_intent.submitted_at is null
         and old_intent.funding_operation_id is null
         and old_intent.funding_reservation_id is null
         and old_intent.execution_id is null
         and old_intent.order_id is null
         and old_intent.venue_order_id is null
         and old_intent.tx_signature is null
         and not (old_intent.result ? 'appHandoffExecution')
         and not exists (
           select 1 from telegram_app_handoffs handoff_row
           where handoff_row.trade_intent_id = old_intent.id
             and handoff_row.state in ('claimed', 'committed')
         )
         and not exists (
           select 1 from telegram_bot_action_outbox delivery_row
           where delivery_row.trade_intent_id = old_intent.id
             and delivery_row.status = 'sending'
         )
       for update of old_intent
     ), marked_source as (
       update telegram_trade_intents old_intent
       set result = old_intent.result || '{"quoteRefreshRequested":true}'::jsonb
       from source_intent where old_intent.id = source_intent.id
       returning old_intent.id
     ), stopped_edits as (
       update telegram_bot_action_outbox delivery_row
       set status = 'dead', last_error = 'quote_refreshed', updated_at = now()
       from source_intent
       where delivery_row.trade_intent_id = source_intent.id
         and delivery_row.action = 'trade_funding_edit'
         and delivery_row.status in ('pending', 'retry')
       returning delivery_row.id
     )
     insert into telegram_trade_intents (
       telegram_user_id,user_id,authorization_id,chat_id,telegram_message_id,
       delivery_mode,action,venue,market_id,event_id,side,amount_usd,
       sell_percent,shares_raw,status,quote_snapshot,policy_snapshot,result,
       expires_at,idempotency_key
     ) select telegram_user_id,user_id,authorization_id,chat_id,telegram_message_id,
       delivery_mode,action,venue,market_id,event_id,side,amount_usd,
       sell_percent,shares_raw,'draft','{}'::jsonb,policy_snapshot,
       jsonb_strip_nulls(jsonb_build_object(
         'telegramAuthority',result -> 'telegramAuthority',
         'telegramNavigation',result -> 'telegramNavigation',
         'telegramInput',result -> 'telegramInput',
         'strictSlippage',result -> 'strictSlippage',
         'telegramBudget',(result -> 'telegramBudget') - 'normalized' - 'spendLimitUsd'
       )), clock_timestamp() + ($5::integer * interval '1 second'),
       'telegram-quote-refresh:' || id::text
     from source_intent
     on conflict (idempotency_key) do update
       set idempotency_key = excluded.idempotency_key
     returning id::text,action`,
    [
      input.intentId,
      input.telegramUserId,
      input.chatId,
      input.messageId,
      Math.max(1, Math.min(3600, Math.trunc(input.ttlSec))),
    ],
  );
  return result.rows[0] ?? null;
}
