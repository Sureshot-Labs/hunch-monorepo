import type { DbQuery } from "../db.js";
import { listFundingLifecycleProjectionsForUsers } from "../funding/lifecycle/funding-lifecycle-read-model.js";

type FinancialLifecycleDbRow = {
  active_funding_movement: boolean;
  active_legacy_bridge: boolean;
  active_position_action: boolean;
  active_preparation: boolean;
  active_receive_session: boolean;
  active_telegram_funding_context: boolean;
  active_telegram_intent: boolean;
  deposit_evidence: boolean;
  funding_evidence: boolean;
  legacy_bridge_evidence: boolean;
  position_action_evidence: boolean;
  preparation_run_count: string;
  receive_evidence: boolean;
  telegram_funding_evidence: boolean;
  telegram_funding_buy_continuation_evidence: boolean;
  telegram_funding_authorization_evidence: boolean;
  trading_evidence: boolean;
};

export type UserFinancialLifecycleSummary = Readonly<{
  activeMovement: boolean;
  activeReasons: readonly string[];
  ambiguousFundingAttemptCount: number;
  nonTerminalFundingOperationCount: number;
  preparationRunEvidence: number;
  protectedEvidence: boolean;
  protectedReasons: readonly string[];
}>;

export async function fetchUserFinancialLifecycleSummary(
  db: DbQuery,
  userIds: readonly string[],
): Promise<UserFinancialLifecycleSummary> {
  if (userIds.length === 0) {
    return {
      activeMovement: false,
      activeReasons: [],
      ambiguousFundingAttemptCount: 0,
      nonTerminalFundingOperationCount: 0,
      preparationRunEvidence: 0,
      protectedEvidence: false,
      protectedReasons: [],
    };
  }
  const buyContinuationEvidenceSql = `
        exists (
          select 1
          from telegram_funding_buy_return_revisions buy_return
          join telegram_funding_sessions context
            on context.id = buy_return.telegram_funding_session_id
          where context.user_id = any($1::uuid[])
        )
      `;
  const { rows } = await db.query<FinancialLifecycleDbRow>(
    `
      select
        (
          exists (
            select 1
            from balance_reservations reservation
            where reservation.user_id = any($1::uuid[])
              and reservation.state = 'active'
          )
          or exists (
            select 1
            from telegram_funding_authorization_reservations reservation
            join telegram_funding_authorizations funding_authorization
              on funding_authorization.id = reservation.authorization_id
            where funding_authorization.user_id = any($1::uuid[])
              and reservation.status in ('reserved', 'cleanup_required')
          )
          or exists (
            select 1
            from funding_reconciliation_jobs job
            join funding_operations operation
              on operation.id = job.operation_id
            where operation.user_id = any($1::uuid[])
              and job.status = 'leased'
              and job.lease_until > now()
          )
          or exists (
            select 1
            from funding_route_observations route
            where route.user_id = any($1::uuid[])
              and route.outcome = 'in_progress'
          )
          or exists (
            select 1
            from funding_trade_attempts attempt
            where attempt.user_id = any($1::uuid[])
              and attempt.state in (
                'claimed',
                'submission_started',
                'ambiguous'
              )
          )
        ) as active_funding_movement,
        (
          exists (
            select 1
            from funding_preparation_runs run
            where run.user_id = any($1::uuid[])
              and run.status in ('submitted', 'ambiguous')
          )
          or exists (
            select 1
            from funding_preparation_action_attempts attempt
            join funding_preparation_runs run on run.id = attempt.run_id
            where run.user_id = any($1::uuid[])
              and (
                attempt.state in ('submitted', 'ambiguous')
                or attempt.broadcast_may_have_occurred
              )
          )
        ) as active_preparation,
        exists (
          select 1
          from position_action_operations action
          where action.user_id = any($1::uuid[])
            and action.status not in ('completed', 'failed', 'cancelled')
        ) as active_position_action,
        exists (
          select 1
          from funding_receive_sessions session
          where session.user_id = any($1::uuid[])
            and (
              session.status in (
                'open',
                'processing',
                'review_required',
                'recovery_required'
              )
              or (
                session.status in ('completed', 'expired', 'cancelled')
                and session.observe_until > now()
              )
            )
        ) as active_receive_session,
        exists (
          select 1
          from telegram_funding_sessions context
          join funding_receive_sessions session
            on session.id = context.receive_session_id
           and session.user_id = context.user_id
          where context.user_id = any($1::uuid[])
            and (
              session.status in (
                'open',
                'processing',
                'review_required',
                'recovery_required'
              )
              or (
                session.status in ('completed', 'expired', 'cancelled')
                and session.observe_until > now()
              )
            )
        ) as active_telegram_funding_context,
        exists (
          select 1
          from bridge_orders bridge
          where bridge.user_id = any($1::uuid[])
            and lower(trim(bridge.status)) not in (
              'fulfilled', 'filled', 'completed', 'success', 'confirmed',
              'failed', 'reverted', 'error', 'expired', 'refunded',
              'cancelled', 'canceled'
            )
        ) as active_legacy_bridge,
        exists (
          select 1
          from telegram_trade_intents intent
          where intent.user_id = any($1::uuid[])
            and intent.status in (
              'executing', 'submitted', 'reconcile_required'
            )
        ) as active_telegram_intent,
        exists (
          select 1 from funding_quotes where user_id = any($1::uuid[])
          union all
          select 1 from funding_withdrawal_destinations
            where user_id = any($1::uuid[])
          union all
          select 1 from funding_operations where user_id = any($1::uuid[])
          union all
          select 1 from balance_reservations where user_id = any($1::uuid[])
          union all
          select 1 from funding_route_observations
            where user_id = any($1::uuid[])
          union all
          select 1 from funding_trade_attempts where user_id = any($1::uuid[])
          union all
          select 1 from funding_preparation_runs
            where user_id = any($1::uuid[])
          limit 1
        ) as funding_evidence,
        (
          select count(*)::text
          from funding_preparation_runs
          where user_id = any($1::uuid[])
        ) as preparation_run_count,
        exists (
          select 1 from funding_receive_sessions
            where user_id = any($1::uuid[])
          union all
          select 1 from funding_receive_receipts
            where user_id = any($1::uuid[])
          limit 1
        ) as receive_evidence,
        exists (
          select 1
          from telegram_funding_sessions
          where user_id = any($1::uuid[])
        ) as telegram_funding_evidence,
        exists (
          select 1
          from telegram_funding_authorizations
          where user_id = any($1::uuid[])
        ) as telegram_funding_authorization_evidence,
        ${buyContinuationEvidenceSql}
          as telegram_funding_buy_continuation_evidence,
        exists (
          select 1
          from position_action_operations
          where user_id = any($1::uuid[])
        ) as position_action_evidence,
        exists (
          select 1 from bridge_orders where user_id = any($1::uuid[])
        ) as legacy_bridge_evidence,
        exists (
          select 1 from deposit_events where user_id = any($1::uuid[])
        ) as deposit_evidence,
        exists (
          select 1 from orders where user_id = any($1::uuid[])
          union all
          select 1 from positions where user_id = any($1::uuid[])
          union all
          select 1 from executions where user_id = any($1::uuid[])
          limit 1
        ) as trading_evidence
    `,
    [Array.from(userIds)],
  );
  const row = rows[0];
  if (!row) {
    throw new Error("Financial lifecycle summary query returned no row");
  }
  const operationLifecycles = await listFundingLifecycleProjectionsForUsers(
    db,
    { userIds },
  );
  const nonTerminalOperationIds = new Set(
    operationLifecycles
      .filter((projection) => !projection.lifecycle.safety.terminal)
      .map((projection) => projection.operationId),
  );
  const nonTerminalOperationLifecycles = operationLifecycles.filter(
    (projection) => !projection.lifecycle.safety.terminal,
  );
  const ambiguousFundingAttemptCount = nonTerminalOperationLifecycles.reduce(
    (count, projection) =>
      count +
      projection.facts.actions.reduce(
        (actionCount, action) =>
          actionCount +
          action.attempts.filter(
            (attempt) =>
              attempt.outcome === "ambiguous" ||
              attempt.broadcastMayHaveOccurred,
          ).length,
        0,
      ),
    0,
  );
  const fundingIntentResult = await db.query<{
    funding_operation_id: string | null;
  }>(
    `select distinct intent.funding_operation_id::text as funding_operation_id
       from telegram_trade_intents intent
      where intent.user_id = any($1::uuid[])
        and intent.status = 'funding'
        and intent.funding_operation_id is not null`,
    [Array.from(userIds)],
  );
  const activeFundingIntent = fundingIntentResult.rows.some((intent) =>
    intent.funding_operation_id === null
      ? false
      : nonTerminalOperationIds.has(intent.funding_operation_id),
  );
  const activeFundingMovement =
    row.active_funding_movement || nonTerminalOperationIds.size > 0;
  const activeReasons = [
    activeFundingMovement ? "active_funding_movement" : null,
    row.active_preparation ? "active_funding_preparation" : null,
    row.active_position_action ? "active_position_action" : null,
    row.active_receive_session ? "active_receive_session" : null,
    row.active_telegram_funding_context
      ? "active_telegram_funding_context"
      : null,
    row.active_legacy_bridge ? "active_legacy_bridge" : null,
    row.active_telegram_intent || activeFundingIntent
      ? "active_telegram_intent"
      : null,
  ].filter((reason): reason is string => reason !== null);
  const protectedReasons = [
    row.funding_evidence ? "funding_evidence" : null,
    row.position_action_evidence ? "position_action_evidence" : null,
    row.receive_evidence ? "receive_evidence" : null,
    row.telegram_funding_evidence ? "telegram_funding_evidence" : null,
    row.telegram_funding_buy_continuation_evidence
      ? "telegram_funding_buy_continuation_evidence"
      : null,
    row.telegram_funding_authorization_evidence
      ? "telegram_funding_authorization_evidence"
      : null,
    row.legacy_bridge_evidence ? "legacy_bridge_evidence" : null,
    row.deposit_evidence ? "deposit_evidence" : null,
    row.trading_evidence ? "trading_evidence" : null,
    ...activeReasons,
  ].filter((reason): reason is string => reason !== null);
  return {
    activeMovement: activeReasons.length > 0,
    activeReasons,
    ambiguousFundingAttemptCount,
    nonTerminalFundingOperationCount: nonTerminalOperationLifecycles.length,
    preparationRunEvidence: Number(row.preparation_run_count),
    protectedEvidence: protectedReasons.length > 0,
    protectedReasons,
  };
}
