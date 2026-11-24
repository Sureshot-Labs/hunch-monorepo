import type { Pool } from "@hunch/infra";
import { normalizeLimitlessRawTokenId } from "../lib/limitless-token.js";

export type LimitlessFokScope = {
  userId: string;
  walletAddress: string;
  tokenId: string;
  side: "BUY" | "SELL";
  clientOrderId: string;
};

// Every new collateral FOK lane takes this lock in the transaction that marks
// its own durable intent broadcast-capable. No network request runs under it.
export async function lockLimitlessFokScope(
  db: Pick<Pool, "query">,
  scope: LimitlessFokScope,
): Promise<void> {
  const rawTokenId = normalizeLimitlessRawTokenId(scope.tokenId);
  if (!rawTokenId) throw new Error("Limitless FOK scope has no exact token");
  await db.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `limitless-direct:${scope.userId}:${scope.walletAddress.toLowerCase()}:limitless:${rawTokenId}:${scope.side}`,
  ]);
}

export async function readOtherPendingLimitlessFok(
  db: Pick<Pool, "query">,
  scope: LimitlessFokScope,
): Promise<boolean> {
  const rawTokenId = normalizeLimitlessRawTokenId(scope.tokenId);
  if (!rawTokenId) throw new Error("Limitless FOK scope has no exact token");
  const { rows } = await db.query<{ pending: boolean }>(
    `select exists (
       select 1 from orders journal_order
        where journal_order.user_id=$1 and journal_order.venue='limitless'
          and lower(journal_order.wallet_address)=$2 and journal_order.token_id in ($3,$4)
          and journal_order.order_type='FOK' and journal_order.side=$5 and journal_order.status='submitted'
          and journal_order.venue_order_id like 'client:hunch-direct-%'
          and journal_order.venue_order_id <> concat('client:',$6::text)
       union all
       select 1 from funding_trade_attempts funding_attempt
         join funding_operations funding_operation on funding_operation.id=funding_attempt.operation_id
         cross join lateral (select funding_operation.support_metadata -> concat('limitlessClobSubmissionV1:',funding_attempt.id) -> 'submission' as evidence) saved
        where $5='BUY' and funding_attempt.user_id=$1 and funding_attempt.execution_path='limitless_clob'
          and funding_attempt.state in ('submission_started','ambiguous') and funding_attempt.broadcast_may_have_occurred
          and funding_attempt.external_reference is distinct from $6
          and saved.evidence -> 'context' ? 'collateralFeeModule'
          and lower(saved.evidence #>> '{order,maker}')=$2
          and saved.evidence #>> '{order,tokenId}' in ($3,$4)
       union all
       select 1 from telegram_trade_intents telegram_intent
        where telegram_intent.user_id=$1 and telegram_intent.venue='limitless'
          and upper(telegram_intent.action)=$5 and telegram_intent.status in ('executing','reconcile_required','submitted')
          and telegram_intent.submit_started_at is not null and telegram_intent.order_id is null
          and telegram_intent.prepared_snapshot #>> '{reconcileKeys,clientOrderId}' is distinct from $6
          and telegram_intent.prepared_snapshot #>> '{recoveryPayload,orderType}'='FOK'
          and (telegram_intent.prepared_snapshot #> '{recoveryPayload,submissionContext}') ? 'collateralFeeModule'
          and lower(telegram_intent.prepared_snapshot #>> '{recoveryPayload,orderPayload,maker}')=$2
          and telegram_intent.prepared_snapshot #>> '{recoveryPayload,tokenId}' in ($3,$4)
       union all
       select 1 from copy_attributions copy_attempt
        where $5='BUY' and copy_attempt.copier_user_id=$1 and copy_attempt.state='pending'
          and copy_attempt.submission_started_at is not null and copy_attempt.order_id is null and copy_attempt.execution_id is null
          and copy_attempt.provider_reference <> concat('limitless:clob:8453:',$6::text)
          and copy_attempt.source_snapshot #>> '{submission,orderType}'='FOK'
          and (copy_attempt.source_snapshot #> '{submission,limitlessClob,context}') ? 'collateralFeeModule'
          and lower(copy_attempt.source_snapshot #>> '{submission,limitlessClob,order,maker}')=$2
          and copy_attempt.source_snapshot #>> '{submission,limitlessClob,order,tokenId}' in ($3,$4)
     ) as pending`,
    [
      scope.userId,
      scope.walletAddress.toLowerCase(),
      rawTokenId,
      `limitless:${rawTokenId}`,
      scope.side,
      scope.clientOrderId,
    ],
  );
  return rows[0]?.pending === true;
}
