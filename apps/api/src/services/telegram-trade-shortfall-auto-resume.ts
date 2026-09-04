import { tx, type Pool } from "@hunch/infra";

import { loadFundingLifecycleProjectionForOperation } from "../funding/lifecycle/funding-lifecycle-read-model.js";

export type TelegramTradeShortfallAutoResumeCandidate = Readonly<{
  chatId: string;
  intentId: string;
  telegramMessageId: number;
  telegramUserId: number;
}>;

/**
 * Claim one consented Buy whose durable funding is consumer-ready.
 *
 * The claim is deliberately only a short DB lease: execution remains in the
 * API's normal retry_buy path, which re-quotes and re-checks the original
 * confirmation bounds before it can submit a venue order. A ready operation is
 * therefore never itself authority to trade.
 */
export async function claimTelegramTradeShortfallAutoResume(
  pool: Pool,
): Promise<TelegramTradeShortfallAutoResumeCandidate | null> {
  return tx(pool, async (client) => {
    const selected = await client.query<{
      chat_id: string;
      funding_operation_id: string;
      id: string;
      telegram_message_id: string;
      telegram_user_id: string;
    }>(
      `select intent.id::text,
              intent.chat_id,
              intent.telegram_message_id::text,
              intent.telegram_user_id,
              consumer_operation.id::text as funding_operation_id
         from telegram_trade_intents intent
         join funding_operations root_operation
           on root_operation.id = intent.funding_operation_id
          and root_operation.user_id = intent.user_id
         left join lateral (
           select continuation.id,
                  continuation.user_id
             from funding_operations continuation
            where continuation.user_id = root_operation.user_id
              and continuation.support_metadata ->> 'telegramTradeIntentId' = intent.id::text
              and continuation.support_metadata ->> 'continuationOfOperationId' = root_operation.id::text
            order by continuation.created_at desc, continuation.id desc
            limit 1
         ) continuation on true
         cross join lateral (
           select coalesce(continuation.id, root_operation.id) as id,
                  coalesce(continuation.user_id, root_operation.user_id) as user_id
         ) consumer_operation
        where intent.status = 'funding'
          and intent.delivery_mode = 'bot_submit'
          and intent.action = 'buy'
          and intent.submit_started_at is null
          and intent.chat_id is not null
          and intent.telegram_message_id is not null
          and intent.chat_id = intent.telegram_user_id
          and exists (
            select 1
              from balance_reservations reservation
             where reservation.operation_id = consumer_operation.id
               and reservation.user_id = consumer_operation.user_id
               and reservation.mode = 'settled_for_consumer'
               and reservation.state = 'active'
          )
        order by intent.updated_at, intent.id
        for update of intent, root_operation skip locked
        limit 64`,
    );
    for (const row of selected.rows) {
      const lifecycle = (
        await loadFundingLifecycleProjectionForOperation(client, {
          operationId: row.funding_operation_id,
        })
      )?.lifecycle;
      if (
        lifecycle?.status !== "ready" ||
        lifecycle.progressStage !== "ready_for_consumer"
      ) {
        continue;
      }
      const telegramUserId = Number(row.telegram_user_id);
      const telegramMessageId = Number(row.telegram_message_id);
      if (
        !Number.isSafeInteger(telegramUserId) ||
        telegramUserId <= 0 ||
        !Number.isSafeInteger(telegramMessageId) ||
        telegramMessageId <= 0
      ) {
        continue;
      }
      const claimed = await client.query(
        `update telegram_trade_intents
            set result = coalesce(result, '{}'::jsonb) || jsonb_build_object(
                  'fundingAutoResumeClaimedAt', clock_timestamp()
                ),
                updated_at = clock_timestamp()
          where id = $1::uuid
            and status = 'funding'
            and submit_started_at is null`,
        [row.id],
      );
      if ((claimed.rowCount ?? 0) !== 1) continue;
      return {
        chatId: row.chat_id,
        intentId: row.id,
        telegramMessageId,
        telegramUserId,
      };
    }
    return null;
  });
}
