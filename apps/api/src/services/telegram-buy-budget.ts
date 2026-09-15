import type { DbQuery } from "../db.js";

/** Compare-and-set before Review; a concurrent preview/confirmation wins. */
export async function recordTelegramBuyBudget(input: {
  db: DbQuery;
  intentId: string;
  budget: Record<string, unknown>;
  amountUsd: number;
  spendLimitUsd: number;
}): Promise<boolean> {
  const updated = await input.db.query(
    `update telegram_trade_intents
     set amount_usd = $2::numeric,
         result = jsonb_set(result, '{telegramBudget}', $3::jsonb || jsonb_build_object('normalized', true, 'spendLimitUsd', $4::numeric)),
         updated_at = now()
     where id = $1::uuid and status = 'draft'
       and action = 'buy' and venue = 'polymarket' and delivery_mode = 'app_handoff'
       and result -> 'telegramBudget' = $3::jsonb
       and not coalesce(result #>> '{telegramBudget,normalized}' = 'true', false)
       and confirmed_at is null and submit_started_at is null
       and funding_operation_id is null and execution_id is null
       and not (result ? 'appHandoffV2')
     returning id`,
    [
      input.intentId,
      input.amountUsd,
      JSON.stringify(input.budget),
      input.spendLimitUsd,
    ],
  );
  return (updated.rowCount ?? 0) === 1;
}
