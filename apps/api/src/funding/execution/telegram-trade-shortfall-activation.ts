import type { PoolClient } from "@hunch/infra";

import { isPolymarketDepositRouterProfileId } from "./delegated-funding-profile-ids.js";
import { relayEvmFundingProfileSpec } from "./relay-evm-profile-specs.js";
import { projectedFundingLifecycleInTransaction } from "../persistence/funding-evidence-repository.js";
import { reduceFundingOperationInTransaction } from "../reconciliation/funding-reducer.js";
import type { FundingLifecycleProjection } from "../lifecycle/funding-lifecycle-projector.js";

function isActionableProjectedAction(
  lifecycle: FundingLifecycleProjection,
  actionId: string,
): boolean {
  return lifecycle.actions.some(
    (action) =>
      action.actionId === actionId &&
      action.state === "action_required" &&
      action.actionable,
  );
}

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
  client: PoolClient,
  input: Readonly<{
    operationId: string;
    profileId: string;
    tradeIntentId: string;
  }>,
): Promise<boolean> {
  if (!isTelegramTradeShortfallServerProfile(input.profileId)) return false;
  const candidates = await client.query<{
    operation_id: string;
    step_id: string;
  }>(
    `select operation_row.id as operation_id, root_step.id as step_id
       from funding_operations operation_row
       join funding_operation_steps root_step
         on root_step.operation_id = operation_row.id
       join telegram_trade_intents trade_intent_row
         on trade_intent_row.id::text =
              operation_row.support_metadata ->> 'telegramTradeIntentId'
        and trade_intent_row.user_id = operation_row.user_id
        and trade_intent_row.status = 'funding'
        and (
          trade_intent_row.funding_operation_id = operation_row.id
          or trade_intent_row.funding_operation_id::text =
               operation_row.support_metadata ->> 'continuationOfOperationId'
        )
        and trade_intent_row.submit_started_at is null
       left join telegram_funding_authorization_reservations reservation_row
         on reservation_row.funding_operation_id = operation_row.id
        and reservation_row.source_trade_intent_id = trade_intent_row.id
        and reservation_row.status = 'reserved'
      where root_step.operation_id = operation_row.id
        and operation_row.id = $1::uuid
        and operation_row.purpose = 'trade_shortfall'
        and operation_row.support_metadata ->> 'telegramTradeIntentId' = $2::text
        and operation_row.support_metadata ->> 'delegatedOriginKind' =
              'trade_shortfall_intent'
        and root_step.executor_id = $3
        and root_step.depends_on_step_id is null
        and (
          $3 = 'polymarket_deposit_pusd_fund_v1'
          or reservation_row.id is not null
        )
        and not exists (
          select 1
          from funding_operation_step_attempts root_attempt
        where root_attempt.step_id = root_step.id
        )
      for update of root_step`,
    [input.operationId, input.tradeIntentId, input.profileId],
  );
  const candidate = candidates.rows[0];
  if (!candidate) return false;
  const now = new Date();
  await reduceFundingOperationInTransaction(client, {
    operationId: candidate.operation_id,
    now,
  });
  const lifecycle = await projectedFundingLifecycleInTransaction(client, {
    operationId: candidate.operation_id,
    now,
  });
  return isActionableProjectedAction(lifecycle, candidate.step_id);
}

/** Activate stranded no-attempt roots for one exact profile during worker reconciliation. */
export async function activateStalledTelegramTradeShortfallInitialStepsInTransaction(
  client: PoolClient,
  input: Readonly<{ profileId: string; limit: number }>,
): Promise<number> {
  if (!isTelegramTradeShortfallServerProfile(input.profileId)) return 0;
  const candidates = await client.query<{
    operation_id: string;
    step_id: string;
  }>({
    name: "funding-shortfall-activate-stalled-roots-v1",
    text: `with candidates as (
       select root_step.id, root_step.operation_id
         from funding_operation_steps root_step
         join funding_operations operation_row
           on operation_row.id = root_step.operation_id
         join telegram_trade_intents trade_intent_row
           on trade_intent_row.id::text =
                operation_row.support_metadata ->> 'telegramTradeIntentId'
          and trade_intent_row.user_id = operation_row.user_id
          and trade_intent_row.status = 'funding'
          and (
            trade_intent_row.funding_operation_id = operation_row.id
            or trade_intent_row.funding_operation_id::text =
                 operation_row.support_metadata ->> 'continuationOfOperationId'
          )
          and trade_intent_row.submit_started_at is null
         left join telegram_funding_authorization_reservations reservation_row
           on reservation_row.funding_operation_id = operation_row.id
          and reservation_row.source_trade_intent_id = trade_intent_row.id
          and reservation_row.status = 'reserved'
        where operation_row.purpose = 'trade_shortfall'
          and operation_row.support_metadata ->> 'delegatedOriginKind' =
              'trade_shortfall_intent'
          and root_step.executor_id = $1
          and root_step.depends_on_step_id is null
          and (
            $1 = 'polymarket_deposit_pusd_fund_v1'
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
     select operation_id, id as step_id
       from candidates`,
    values: [input.profileId, Math.max(1, Math.min(input.limit, 100))],
  });
  let activated = 0;
  for (const candidate of candidates.rows) {
    const now = new Date();
    await reduceFundingOperationInTransaction(client, {
      operationId: candidate.operation_id,
      now,
    });
    const lifecycle = await projectedFundingLifecycleInTransaction(client, {
      operationId: candidate.operation_id,
      now,
    });
    if (isActionableProjectedAction(lifecycle, candidate.step_id)) {
      activated += 1;
    }
  }
  return activated;
}

/**
 * Router approvals are ordinary transaction steps. Once one is canonical,
 * unlock exactly its one dependent Router step: another exact approval or the
 * final fund call. This keeps a two-token Router plan serial without a
 * separate state machine.
 */
export async function activateTelegramTradeShortfallRouterDependentFundInTransaction(
  client: PoolClient,
  input: Readonly<{ operationId: string; approvalStepId: string }>,
): Promise<boolean> {
  const candidates = await client.query<{
    operation_id: string;
    step_id: string;
  }>(
    `select approval_step.operation_id, fund_step.id as step_id
       from funding_operation_steps approval_step
       join funding_operations operation_row
         on operation_row.id = approval_step.operation_id
       join telegram_trade_intents trade_intent_row
         on trade_intent_row.id::text =
              operation_row.support_metadata ->> 'telegramTradeIntentId'
        and trade_intent_row.user_id = operation_row.user_id
        and trade_intent_row.status = 'funding'
        and (
          trade_intent_row.funding_operation_id = operation_row.id
          or trade_intent_row.funding_operation_id::text =
               operation_row.support_metadata ->> 'continuationOfOperationId'
        )
       left join telegram_funding_authorization_reservations reservation_row
         on reservation_row.funding_operation_id = operation_row.id
        and reservation_row.source_trade_intent_id = trade_intent_row.id
        and reservation_row.status = 'reserved'
      where approval_step.id = $2::uuid
        and approval_step.operation_id = $1::uuid
        and approval_step.executor_id = $3
        and approval_step.step_kind = 'transaction'
        and operation_row.purpose = 'trade_shortfall'
        and operation_row.support_metadata ->> 'delegatedOriginKind' =
              'trade_shortfall_intent'
        and fund_step.operation_id = approval_step.operation_id
        and fund_step.depends_on_step_id = approval_step.id
        and fund_step.executor_id = approval_step.executor_id
        and fund_step.step_kind in ('transaction', 'venue_preparation')
        and (
          approval_step.executor_id = 'polymarket_deposit_pusd_fund_v1'
          or reservation_row.id is not null
        )
        and not exists (
          select 1
          from funding_operation_step_attempts fund_attempt
        where fund_attempt.step_id = fund_step.id
        )
      for update of approval_step, fund_step`,
    [
      input.operationId,
      input.approvalStepId,
      "polymarket_deposit_pusd_fund_v1",
    ],
  );
  const candidate = candidates.rows[0];
  if (!candidate) return false;
  const now = new Date();
  await reduceFundingOperationInTransaction(client, {
    operationId: candidate.operation_id,
    now,
  });
  const lifecycle = await projectedFundingLifecycleInTransaction(client, {
    operationId: candidate.operation_id,
    now,
  });
  return isActionableProjectedAction(lifecycle, candidate.step_id);
}
