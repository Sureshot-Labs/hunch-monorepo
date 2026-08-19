import type { PoolClient } from "@hunch/infra";

import { isPolymarketDepositRouterProfileId } from "./delegated-funding-profile-ids.js";
import { relayEvmFundingProfileSpec } from "./relay-evm-profile-specs.js";

/**
 * Shortfall consent is the authority to start exactly the root action of an
 * already-persisted, server-delegated operation.  Receive routes deliberately
 * do not use this: their root remains gated by an observed inbound receipt.
 */
export function isTelegramTradeShortfallServerProfile(
  profileId: string,
): boolean {
  return (
    relayEvmFundingProfileSpec(profileId) != null ||
    isPolymarketDepositRouterProfileId(profileId)
  );
}

/**
 * Promote a root step only while every durable shortfall invariant still
 * holds. The predicate is deliberately also suitable for reconciliation of a
 * previously committed operation: no attempt means no external boundary was
 * crossed, so this is an idempotent liveness repair rather than a replay.
 */
export async function activateTelegramTradeShortfallInitialStepInTransaction(
  client: Pick<PoolClient, "query">,
  input: Readonly<{
    operationId: string;
    profileId: string;
    tradeIntentId: string;
  }>,
): Promise<boolean> {
  if (!isTelegramTradeShortfallServerProfile(input.profileId)) return false;
  const activated = await client.query<{ id: string }>(
    `update funding_operation_steps root_step
        set state = 'action_required', updated_at = clock_timestamp()
       from funding_operations operation_row
       join telegram_trade_intents trade_intent_row
         on trade_intent_row.id::text =
              operation_row.support_metadata ->> 'telegramTradeIntentId'
        and trade_intent_row.user_id = operation_row.user_id
        and trade_intent_row.status = 'funding'
        and trade_intent_row.funding_operation_id = operation_row.id
        and trade_intent_row.submit_started_at is null
       left join telegram_funding_authorization_reservations reservation_row
         on reservation_row.funding_operation_id = operation_row.id
        and reservation_row.source_trade_intent_id = trade_intent_row.id
        and reservation_row.status = 'reserved'
      where root_step.operation_id = operation_row.id
        and operation_row.id = $1::uuid
        and operation_row.purpose = 'trade_shortfall'
        and operation_row.status in (
          'in_progress', 'reconcile_required', 'recovery_required'
        )
        and operation_row.support_metadata ->> 'telegramTradeIntentId' = $2::text
        and operation_row.support_metadata ->> 'delegatedOriginKind' =
              'trade_shortfall_intent'
        and root_step.executor_id = $3
        and root_step.depends_on_step_id is null
        and root_step.state = 'planned'
        and (
          $3 in (
            'polymarket_deposit_pusd_fund_v1',
            'polymarket_deposit_usdce_wrap_v1'
          )
          or reservation_row.id is not null
        )
        and not exists (
          select 1
          from funding_operation_step_attempts root_attempt
          where root_attempt.step_id = root_step.id
        )
      returning root_step.id`,
    [input.operationId, input.tradeIntentId, input.profileId],
  );
  return activated.rowCount === 1;
}

/** Activate stranded no-attempt roots for one exact profile during worker reconciliation. */
export async function activateStalledTelegramTradeShortfallInitialStepsInTransaction(
  client: Pick<PoolClient, "query">,
  input: Readonly<{ profileId: string; limit: number }>,
): Promise<number> {
  if (!isTelegramTradeShortfallServerProfile(input.profileId)) return 0;
  const updated = await client.query<{ id: string }>(
    `with candidates as (
       select root_step.id
         from funding_operation_steps root_step
         join funding_operations operation_row
           on operation_row.id = root_step.operation_id
         join telegram_trade_intents trade_intent_row
           on trade_intent_row.id::text =
                operation_row.support_metadata ->> 'telegramTradeIntentId'
          and trade_intent_row.user_id = operation_row.user_id
          and trade_intent_row.status = 'funding'
          and trade_intent_row.funding_operation_id = operation_row.id
          and trade_intent_row.submit_started_at is null
         left join telegram_funding_authorization_reservations reservation_row
           on reservation_row.funding_operation_id = operation_row.id
          and reservation_row.source_trade_intent_id = trade_intent_row.id
          and reservation_row.status = 'reserved'
        where operation_row.purpose = 'trade_shortfall'
          and operation_row.status in (
            'in_progress', 'reconcile_required', 'recovery_required'
          )
          and operation_row.support_metadata ->> 'delegatedOriginKind' =
                'trade_shortfall_intent'
          and root_step.executor_id = $1
          and root_step.depends_on_step_id is null
          and root_step.state = 'planned'
          and (
            $1 in (
              'polymarket_deposit_pusd_fund_v1',
              'polymarket_deposit_usdce_wrap_v1'
            )
            or reservation_row.id is not null
          )
          and not exists (
            select 1
            from funding_operation_step_attempts root_attempt
            where root_attempt.step_id = root_step.id
          )
        order by root_step.updated_at, root_step.id
        limit $2
        for update of root_step skip locked
     )
     update funding_operation_steps root_step
        set state = 'action_required', updated_at = clock_timestamp()
       from candidates
      where root_step.id = candidates.id
      returning root_step.id`,
    [input.profileId, Math.max(1, Math.min(input.limit, 100))],
  );
  return updated.rowCount ?? 0;
}

/**
 * Router approvals are ordinary transaction steps. Once one is canonical,
 * unlock exactly its one dependent Router step: another exact approval or the
 * final fund call. This keeps a two-token Router plan serial without a
 * separate state machine.
 */
export async function activateTelegramTradeShortfallRouterDependentFundInTransaction(
  client: Pick<PoolClient, "query">,
  input: Readonly<{ operationId: string; approvalStepId: string }>,
): Promise<boolean> {
  const activated = await client.query<{ id: string }>(
    `update funding_operation_steps fund_step
        set state = 'action_required', updated_at = clock_timestamp()
       from funding_operation_steps approval_step
       join funding_operations operation_row
         on operation_row.id = approval_step.operation_id
       join telegram_trade_intents trade_intent_row
         on trade_intent_row.id::text =
              operation_row.support_metadata ->> 'telegramTradeIntentId'
        and trade_intent_row.user_id = operation_row.user_id
        and trade_intent_row.status = 'funding'
        and trade_intent_row.funding_operation_id = operation_row.id
       left join telegram_funding_authorization_reservations reservation_row
         on reservation_row.funding_operation_id = operation_row.id
        and reservation_row.source_trade_intent_id = trade_intent_row.id
        and reservation_row.status = 'reserved'
      where approval_step.id = $2::uuid
        and approval_step.operation_id = $1::uuid
        and approval_step.state = 'succeeded'
        and approval_step.executor_id = $3
        and approval_step.step_kind = 'transaction'
        and operation_row.purpose = 'trade_shortfall'
        and operation_row.support_metadata ->> 'delegatedOriginKind' =
              'trade_shortfall_intent'
        and fund_step.operation_id = approval_step.operation_id
        and fund_step.depends_on_step_id = approval_step.id
        and fund_step.executor_id = approval_step.executor_id
        and fund_step.step_kind in ('transaction', 'venue_preparation')
        and fund_step.state = 'planned'
        and (
          approval_step.executor_id = 'polymarket_deposit_pusd_fund_v1'
          or reservation_row.id is not null
        )
        and not exists (
          select 1
          from funding_operation_step_attempts fund_attempt
          where fund_attempt.step_id = fund_step.id
        )
      returning fund_step.id`,
    [
      input.operationId,
      input.approvalStepId,
      "polymarket_deposit_pusd_fund_v1",
    ],
  );
  return activated.rowCount === 1;
}
