import type { Pool, PoolClient } from "@hunch/infra";
import { projectTelegramNativeHandoffStatusInTransaction } from "./telegram-native-handoff-read.js";
import { hip4RawUnits } from "@hunch/shared";
import { canonicalJsonHash } from "../funding/persistence/canonical.js";
import {
  consumeFundingReservationForLinkedConsumerInTransaction,
  releaseFundingReservationForAbandonedTradeInTransaction,
} from "../funding/persistence/funding-evidence-repository.js";
import { proveHyperliquidOrderRejectedInTransaction } from "../funding/persistence/funding-trade-attempt-repository.js";
import { lockFundingPolicyForTransaction } from "../funding/policies/funding-policy-sidecar.js";
import { formatUnsignedDecimal } from "../account-value/decimal.js";
import {
  interpretHip4ExactOrderFills,
  interpretHip4ExactOrderStatus,
  advanceHip4OrderBalanceBarrier,
  classifyHip4NativeOrderStatus,
  type Hip4OrderBalanceBarrier,
} from "../services/hip4-order-evidence.js";
import type { Hip4TradeSigningInput } from "../services/hip4-trade-signing.js";
import { HIP4_COMPLETED_ORDER_OBSERVATION_SQL } from "../services/hip4-order-observation-schedule.js";
import { readHip4AccountPolicy } from "../services/hip4-account-repository.js";

function claimOrderObservationSql(completed: boolean) {
  return `with due_submissions as (
  select action_id from hip4_order_submissions
  where state<>'rejected' and debit_asset_id is not null
    and (${HIP4_COMPLETED_ORDER_OBSERVATION_SQL})=${completed ? "true" : "false"}
    and reconcile_after<=statement_timestamp()
    and (reconcile_lease_until is null or reconcile_lease_until<statement_timestamp())
  order by reconcile_after,action_id limit 1 for update skip locked
) update hip4_order_submissions target_row
  set reconcile_lease_token=gen_random_uuid(),
    reconcile_lease_until=clock_timestamp()+$1*interval '1 millisecond',
    reconcile_attempt_at=clock_timestamp(),
    reconcile_after=clock_timestamp()+greatest($1,$2)*interval '1 millisecond'
  from due_submissions where target_row.action_id=due_submissions.action_id
  returning target_row.action_id,target_row.reconcile_lease_token`;
}
export const HIP4_CLAIM_ORDER_OBSERVATION_SQL = claimOrderObservationSql(false);
export const HIP4_CLAIM_COMPLETED_ORDER_OBSERVATION_SQL =
  claimOrderObservationSql(true);

export const HIP4_ORDER_OBSERVATION_CONTEXT_SQL = `select
  action_row.unsigned_envelope,action_row.signer_address,action_row.cloid,
  action_row.environment,action_row.action_kind,action_row.order_id,order_row.user_id,
  order_row.venue_order_id,submission_row.order_observation,submission_row.fills_observation
  from hip4_order_submissions submission_row
  join hip4_order_actions action_row on action_row.id=submission_row.action_id
  join orders order_row on order_row.id=action_row.order_id
  where submission_row.action_id=$1 and submission_row.reconcile_lease_token=$2
    and submission_row.reconcile_lease_until>clock_timestamp()
    and submission_row.state<>'rejected'`;

export type Hip4OrderObservationContext = {
  unsigned_envelope: Hip4TradeSigningInput;
  signer_address: string;
  cloid: string;
  environment: "mainnet" | "testnet";
  action_kind: string;
  order_id: string;
  user_id: string;
  venue_order_id: string | null;
  order_observation: ObservedStatus | null;
  fills_observation: {
    repair?: unknown;
    repairError?: string | null;
    fullQuantityObserved?: boolean;
    feeCoverage?: "known" | "unknown";
  } | null;
};
type ObservedStatus = Extract<
  ReturnType<typeof interpretHip4ExactOrderStatus>,
  { kind: "observed" }
> & { balanceBarrier?: Hip4OrderBalanceBarrier | null };
export type Hip4OrderObservationClaim = {
  action_id: string;
  reconcile_lease_token: string;
};

// Explicit internal repair bypasses housekeeping cadence, never an active lease.
// This is not an authorization boundary or a public handler.
export const HIP4_CLAIM_EXACT_ORDER_OBSERVATION_SQL = `update hip4_order_submissions
  set reconcile_lease_token=gen_random_uuid(),
    reconcile_lease_until=clock_timestamp()+$2*interval '1 millisecond',
    reconcile_attempt_at=clock_timestamp(),
    reconcile_after=clock_timestamp()+greatest($2,$3)*interval '1 millisecond'
  where action_id=$1 and state<>'rejected' and debit_asset_id is not null
    and (reconcile_lease_until is null or reconcile_lease_until<clock_timestamp())
  returning action_id,reconcile_lease_token`;

// Do not filter away future/early/conflicting rows: the interpreter must see
// them. Equality prefixes + deterministic page order keep unrelated history out.
export const HIP4_EXACT_ORDER_FILLS_SQL = `select execution,provider_fill
  from hip4_account_executions where environment=$1 and account_address=$2
    and coin=$3 and oid=$4::bigint
  order by time_ms,tid limit $5`;

export const HIP4_REJECTED_ORDER_EXECUTION_CONFLICT_SQL = `select 1 from hip4_account_executions
  where environment=$1 and account_address=$2 and coin=$3 and oid=$4::bigint
  union all select 1 from orders where id=$5 and coalesce(filled_size,0)>0 limit 1`;

export async function readHip4OrderObservationContext(
  db: Pick<Pool, "query">,
  claim: Hip4OrderObservationClaim,
) {
  return (
    (
      await db.query<Hip4OrderObservationContext>(
        HIP4_ORDER_OBSERVATION_CONTEXT_SQL,
        [claim.action_id, claim.reconcile_lease_token],
      )
    ).rows[0] ?? null
  );
}

/** Caller owns the transaction. Provider IO has already finished. Re-read exact
 * P2 facts under the account row lock so its conflict metadata and immutable
 * ledger are coherent. No invented fills, parallel ledger or position mutation.
 * Consuming a funded purchase uses the same consumer writer as other venues.
 * Status is first persisted independently of bounded fill repair. Only fresh
 * server-owned capacity reads may use its local balance inclusion barrier. */
export async function recordHip4OrderObservationInTransaction(
  db: PoolClient,
  input: {
    claim: Hip4OrderObservationClaim;
    userId: string;
    body: unknown;
    responseAt: number;
    maxRows: number;
    retryMs: number;
    repairError?: string | null;
    phase?: "status" | "fills";
  },
) {
  if (
    !Number.isSafeInteger(input.responseAt) ||
    input.responseAt < 0 ||
    input.responseAt > Date.now() ||
    !Number.isSafeInteger(input.maxRows) ||
    input.maxRows < 1 ||
    input.maxRows > 100000 ||
    !Number.isSafeInteger(input.retryMs) ||
    input.retryMs < 1000 ||
    input.retryMs > 3600000
  )
    throw new Error("hip4_order_observation_input_invalid");
  await lockFundingPolicyForTransaction(db);
  await db.query("select id from users where id=$1 for update", [input.userId]);
  const context = await readHip4OrderObservationContext(db, input.claim);
  if (!context || context.user_id !== input.userId)
    return { saved: false as const };
  if (context.environment !== "mainnet" || context.action_kind !== "order")
    throw new Error("hip4_order_observation_scope_invalid");
  const observed = interpretHip4ExactOrderStatus({
    envelope: context.unsigned_envelope,
    body: input.body,
    knownOrderId: context.venue_order_id,
  });
  let error: string | null = null;
  let statusReadError: string | null = null;
  let status: ObservedStatus | null = null;
  let fills: ReturnType<typeof interpretHip4ExactOrderFills> | null = null;
  if (observed.kind === "pending") {
    error = observed.reason;
    // Provider retention/temporary absence does not erase a previously exact
    // binding. A terminal observation is immutable; newly repaired P2 fills can
    // complete it without pretending the cached status was checked again.
    if (
      observed.reason === "order_not_observed" &&
      context.order_observation?.terminal
    ) {
      status = context.order_observation;
      statusReadError = error;
      error = null;
    }
  } else if (observed.observedStatusTime > input.responseAt)
    error = "order_status_in_future";
  else if (
    context.order_observation &&
    (observed.observedStatusTime <
      context.order_observation.observedStatusTime ||
      (classifyHip4NativeOrderStatus(context.order_observation.status) ===
        "accepted" &&
        classifyHip4NativeOrderStatus(observed.status) === "rejected") ||
      (context.order_observation.terminal &&
        (!observed.terminal ||
          observed.status !== context.order_observation.status)))
  )
    error = "order_status_regression";
  else status = observed;
  const nativeAcceptance =
    status !== null &&
    classifyHip4NativeOrderStatus(status.status) === "accepted";
  // Capture exact status evidence before independent history repair errors.
  // A retained, non-invalidated terminal observation is historical evidence;
  // unknownOid neither refreshes it nor repairs a known contradiction.
  // Do this BEFORE fill validation: missing history is not a contradictory
  // native status, and cached unknownOid must not clear an invalidation.
  const storedStatus = status ?? context.order_observation;
  let statusObservation = storedStatus
    ? {
        ...storedStatus,
        balanceBarrier: advanceHip4OrderBalanceBarrier({
          previous: context.order_observation?.balanceBarrier,
          exactTerminal:
            observed.kind === "observed" && observed.terminal && error === null,
          exactOpen:
            observed.kind === "observed" &&
            observed.status === "open" &&
            error === null,
          statusError: error ?? statusReadError,
          responseAt: input.responseAt,
        }),
      }
    : null;
  const acceptedStatus =
    nativeAcceptance &&
    (observed.kind === "observed" ||
      statusObservation?.balanceBarrier?.state === "terminal_observed");
  const exactRejection =
    status !== null &&
    observed.kind === "observed" &&
    classifyHip4NativeOrderStatus(status.status) === "rejected";
  if (status && exactRejection) {
    // A placement rejection is positive native evidence, not empty-history
    // inference. It needs no full history scan, but cannot override known fills.
    // The P2 writer uses this same row lock before publishing executions. An
    // empty placeholder supplies the lock when no account snapshot exists; it
    // carries no balance/history proof and does not require a provider read.
    await db.query(
      "insert into hip4_account_snapshots(environment,account_address) values($1,$2) on conflict do nothing",
      [context.environment, context.signer_address],
    );
    await db.query(
      "select account_address from hip4_account_snapshots where environment=$1 and account_address=$2 for update",
      [context.environment, context.signer_address],
    );
    const conflict = await db.query(
      HIP4_REJECTED_ORDER_EXECUTION_CONFLICT_SQL,
      [
        context.environment,
        context.signer_address,
        status.coin,
        status.orderId,
        context.order_id,
      ],
    );
    if (conflict.rows.length > 0) {
      error = "rejected_order_execution_conflict";
      // Do not install this contradictory rejection as the trusted terminal
      // state: a subsequent exact accepted status must be able to repair it.
      statusObservation = context.order_observation
        ? {
            ...context.order_observation,
            balanceBarrier: advanceHip4OrderBalanceBarrier({
              previous: context.order_observation.balanceBarrier,
              exactTerminal: false,
              statusError: error,
              responseAt: input.responseAt,
            }),
          }
        : null;
    }
  } else if (status && input.phase !== "status") {
    const account = (
      await db.query<{ history: Record<string, unknown> }>(
        `select history from hip4_account_snapshots where environment=$1 and account_address=$2 for update`,
        [context.environment, context.signer_address],
      )
    ).rows[0];
    const conflicts = account?.history.accountingConflicts as
      | Record<string, unknown>
      | undefined;
    if (!account) error = "account_history_unavailable";
    // Legacy P2 metadata keeps MAX(time), not the set of conflicts. An older
    // maximum can be excluded; a later maximum cannot rule out an earlier
    // conflicting execution inside this order's lifetime.
    else if (
      typeof conflicts?.[status.coin] === "number" &&
      Number(conflicts[status.coin]) >= status.orderTime
    )
      error = "execution_identity_conflict";
    else {
      const entries = (
        await db.query(HIP4_EXACT_ORDER_FILLS_SQL, [
          context.environment,
          context.signer_address,
          status.coin,
          status.orderId,
          input.maxRows + 1,
        ])
      ).rows;
      if (entries.length > input.maxRows) error = "order_fills_page_incomplete";
      else {
        fills = interpretHip4ExactOrderFills({
          envelope: context.unsigned_envelope,
          accountAddress: context.signer_address,
          orderId: status.orderId,
          fills: entries.map((row) => row.provider_fill),
        });
        if (fills.kind === "pending") error = fills.reason;
        else {
          const projected = fills.executions,
            exactStatus = status;
          if (
            entries.length !== projected.length ||
            entries.some(
              (row, index) =>
                canonicalJsonHash(row.execution) !==
                canonicalJsonHash(projected[index]),
            )
          )
            error = "execution_projection_conflict";
          else if (
            projected.some(
              (row) =>
                row.time < exactStatus.orderTime ||
                row.time >
                  (exactStatus.terminal
                    ? exactStatus.observedStatusTime
                    : input.responseAt),
            )
          )
            error = "fill_time_conflict";
          else if (
            classifyHip4NativeOrderStatus(exactStatus.status) === "rejected" &&
            BigInt(fills.quantityRaw) > 0n
          )
            error = "rejected_order_execution_conflict";
        }
      }
    }
  }
  // Lease fence precedes every economic write. A waiting stale worker must not
  // publish over the newer claimant or consume its funding reservation.
  const completed =
    input.phase !== "status" &&
    !error &&
    !statusReadError &&
    !input.repairError &&
    status?.terminal === true &&
    statusObservation?.balanceBarrier?.state === "terminal_observed" &&
    fills?.kind === "observed" &&
    fills.fullQuantityObserved &&
    fills.executionSummary !== null &&
    fills.executions.every(
      (entry) => entry.netQuoteCash !== null && entry.feeToken === "USDC",
    );
  const nextRetryMs = completed
    ? (await readHip4AccountPolicy(db)).policy.completedOrderRecheckIntervalMs
    : input.retryMs;
  const saved = await db.query(
    `update hip4_order_submissions
    set order_observation=coalesce($3::jsonb,order_observation),
      state=case when $3::jsonb is not null or $8 then 'reconcile_required' else state end,
      fills_observation=case when $4::jsonb is not null then coalesce(fills_observation,'{}'::jsonb)||$4::jsonb
        when $5::text is not null then fills_observation-'executionSummary' else fills_observation end,
      reconcile_error=$5,reconcile_after=clock_timestamp()+$6*interval '1 millisecond',
      reconcile_lease_token=case when $7 then reconcile_lease_token else null end,
      reconcile_lease_until=case when $7 then reconcile_lease_until else null end,
      updated_at=clock_timestamp()
    where action_id=$1 and reconcile_lease_token=$2 and reconcile_lease_until>clock_timestamp()
      and state<>'rejected' returning funding_trade_attempt_id,admission_snapshot`,
    [
      input.claim.action_id,
      input.claim.reconcile_lease_token,
      statusObservation,
      !error && fills?.kind === "observed"
        ? {
            quantityRaw: fills.quantityRaw,
            fullQuantityObserved: fills.fullQuantityObserved,
            historyCoverage: fills.historyCoverage,
            executionCount: fills.executions.length,
            // A later status-only read must not resurrect cash evidence from a
            // failed repair. Rebuild it on the next successful fills phase.
            executionSummary:
              statusReadError || input.repairError
                ? null
                : fills.executionSummary,
            observedAt: input.responseAt,
            feeCoverage: fills.executions.every(
              (entry) => entry.netQuoteCash !== null,
            )
              ? "known"
              : "unknown",
          }
        : null,
      error ?? statusReadError ?? input.repairError ?? null,
      nextRetryMs,
      input.phase === "status" || (exactRejection && error === null),
      status !== null,
    ],
  );
  if (!saved.rows[0]) return { saved: false as const };
  // Same transaction as official status/invalidation, AFTER its lease fence.
  // No additional H lock and no post-commit best-effort lifecycle race.
  await projectTelegramNativeHandoffStatusInTransaction(db, {
    actionId: input.claim.action_id,
    userId: input.userId,
  });
  if (!status) return { saved: true as const, error };
  // A bound OID is useful even when fills still need bounded P2 history repair.
  const bound = await db.query(
    `update orders set venue_order_id=coalesce(venue_order_id,$2)
    where id=$1 and user_id=$3 and (venue_order_id is null or venue_order_id=$2) returning id`,
    [context.order_id, status.orderId, input.userId],
  );
  if (bound.rows.length !== 1) throw new Error("hip4_order_reference_conflict");
  if (exactRejection && error === null) {
    const attemptId = saved.rows[0].funding_trade_attempt_id;
    if (attemptId) {
      const attempt = await proveHyperliquidOrderRejectedInTransaction(db, {
        attemptId,
        actionId: input.claim.action_id,
        userId: input.userId,
        cloid: context.cloid,
        rejectionStatus: status.status,
        expectedObservationClaimToken: input.claim.reconcile_lease_token,
      });
      await releaseFundingReservationForAbandonedTradeInTransaction(db, {
        userId: input.userId,
        link: {
          operationId: attempt.operationId,
          reservationId: attempt.reservationId,
        },
        outcomeReason: `hip4_exact_status_${status.status}`,
      });
    }
    await db.query(
      "update orders set status='failed' where id=$1 and user_id=$2",
      [context.order_id, input.userId],
    );
    await db.query(
      `update hip4_order_submissions set state='rejected',reconcile_lease_token=null,reconcile_lease_until=null
      where action_id=$1 and reconcile_lease_token=$2`,
      [input.claim.action_id, input.claim.reconcile_lease_token],
    );
    await projectTelegramNativeHandoffStatusInTransaction(db, {
      actionId: input.claim.action_id,
      userId: input.userId,
    });
    return { saved: true as const, error: null, rejected: true as const };
  }
  // Same consumer contract as other venues: exact acceptance completes the
  // linked funding, even if the order is unfilled or history/fees need repair.
  // This does not set an execution-derived order status or release native cash.
  const exactPositiveFill =
    !error &&
    nativeAcceptance &&
    status.balanceBarrier?.state !== "invalidated" &&
    fills?.kind === "observed" &&
    BigInt(fills.quantityRaw) > 0n;
  const row = saved.rows[0];
  if ((acceptedStatus || exactPositiveFill) && row.funding_trade_attempt_id) {
    const funding = row.admission_snapshot.funding;
    if (!funding?.reservationId)
      throw new Error("hip4_funding_binding_invalid");
    await consumeFundingReservationForLinkedConsumerInTransaction(db, {
      userId: input.userId,
      reservationId: funding.reservationId,
      tradeAttemptId: row.funding_trade_attempt_id,
      consumer: { kind: "web_order", orderId: context.order_id },
      outcomeReason: acceptedStatus
        ? "hip4_exact_order_accepted"
        : "hip4_exact_execution_observed",
    });
  }
  if (error || !fills || fills.kind !== "observed")
    return { saved: true as const, error };
  const quantity = formatUnsignedDecimal(BigInt(fills.quantityRaw), 5);
  const current = await db.query(
    `update orders set filled_size=$2::numeric,status=$3
    where id=$1 and coalesce(filled_size,0)<=$2::numeric returning id`,
    [
      context.order_id,
      quantity,
      fills.fullQuantityObserved
        ? "filled"
        : BigInt(fills.quantityRaw) > 0n
          ? "partially_filled"
          : "submitted",
    ],
  );
  if (current.rows.length !== 1) throw new Error("hip4_order_fill_regression");
  return {
    saved: true as const,
    error: error ?? statusReadError ?? input.repairError ?? null,
    quantityRaw: hip4RawUnits(quantity, 5).toString(),
  };
}

export async function failHip4OrderObservation(
  db: PoolClient,
  claim: Hip4OrderObservationClaim,
  error: string,
  retryMs: number,
) {
  // A failed repair invalidates the cached execution summary as well. Use the
  // SAME native writer order P -> U -> S/I, not a submission-first CTE that can
  // deadlock with admission. Caller supplies one transaction; even failures
  // wake the shared intent lifecycle atomically with the current lease fence.
  if (!(await readHip4OrderObservationContext(db, claim))) return false;
  await lockFundingPolicyForTransaction(db);
  const context = await readHip4OrderObservationContext(db, claim);
  if (!context) return false;
  const lockedOwner = await db.query(
    "select id from users where id=$1 for update",
    [context.user_id],
  );
  const current = await readHip4OrderObservationContext(db, claim);
  if (lockedOwner.rowCount !== 1 || current?.user_id !== context.user_id)
    return false;
  const saved =
    (
      await db.query(
        `update hip4_order_submissions set reconcile_error=$3,reconcile_after=clock_timestamp()+$4*interval '1 millisecond',
    fills_observation=fills_observation-'executionSummary',updated_at=clock_timestamp(),
    reconcile_lease_token=null,reconcile_lease_until=null
    where action_id=$1 and reconcile_lease_token=$2 and reconcile_lease_until>clock_timestamp()
    returning action_id`,
        [claim.action_id, claim.reconcile_lease_token, error, retryMs],
      )
    ).rowCount === 1;
  if (saved)
    await projectTelegramNativeHandoffStatusInTransaction(db, {
      actionId: claim.action_id,
      userId: context.user_id,
    });
  return saved;
}
