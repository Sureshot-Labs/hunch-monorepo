import { tx, type Pool, type PoolClient } from "@hunch/infra";

import type {
  FundingOperationState,
  SegmentStatus,
} from "../domain/transitions.js";
import { parseMoneyJson } from "../domain/money-json.js";
import type { JsonValue } from "../domain/types.js";
import { canonicalAssetId, sameAsset } from "../domain/asset-identity.js";
import {
  deriveFundingLifecycle,
  type FundingLifecycleFacts,
  type FundingLifecycleProjection,
} from "../lifecycle/funding-lifecycle-projector.js";
import { loadFundingLifecycleFactsForOperationInTransaction } from "../lifecycle/funding-lifecycle-facts-repository.js";
import { DELEGATED_PROVIDER_REPLAY_MS } from "../execution/delegated-funding-recovery-policy.js";
import {
  claimFundingReconciliationJobs,
  fetchFundingOperationForWorkerInTransaction,
  finishFundingReconciliationLease,
  listFundingObservationsForOperation,
  releaseFundingReservationInTransaction,
  writeFundingOperationLifecycleProjectionCacheInTransaction,
  writeFundingSegmentProjectionCacheInTransaction,
  writeFundingOperationSupportFactsInTransaction,
  type FundingObservationRow,
  type FundingOperationRow,
  type FundingPersistenceError,
  type FundingReconciliationLease,
  type FundingRecoveryMode,
} from "../persistence/funding-operation-repository.js";
import {
  failTelegramAppHandoffV2FundedIntentWithoutConsumerInTransaction,
  recordSafeFundingActionCancellationsInTransaction,
  writeFundingActionProjectionCachesInTransaction,
} from "../persistence/funding-evidence-repository.js";

type JsonRecord = Readonly<Record<string, JsonValue>>;

export type FundingReductionResult = Readonly<{
  operationId: string;
  initialState: FundingOperationState;
  finalState: FundingOperationState;
  appliedTransitions: readonly FundingOperationState[];
  terminal: boolean;
  reorgBlockedByTerminalState: boolean;
  recoveryMode: FundingRecoveryMode | null;
  /** The generic evidence window elapsed before its decision was persisted. */
  reconciliationEvidenceTimedOut: boolean;
  /** A durable automatic-evidence recovery decision already exists. */
  automaticRecoveryRecorded: boolean;
}>;

type StoredReservationRow = {
  id: string;
  mode: "subtract_available" | "advisory_destination" | "settled_for_consumer";
  state: "active" | "consumed" | "released";
};

type StoredFundingSegmentRow = {
  id: string;
  ordinal: number;
  status: SegmentStatus;
  quoted_input: JsonRecord;
  quoted_min_output: JsonRecord;
};

function isCanonicalFinal(observation: FundingObservationRow): boolean {
  return observation.canonical && observation.finalityStatus === "finalized";
}

function hasFinalObservation(
  observations: readonly FundingObservationRow[],
  kind: FundingObservationRow["kind"],
): boolean {
  return observations.some(
    (observation) => observation.kind === kind && isCanonicalFinal(observation),
  );
}

function operationState(operation: FundingOperationRow): FundingOperationState {
  return {
    status: operation.status,
    stage: operation.progressStage,
  };
}

function destinationRequiresPreparation(
  operation: FundingOperationRow,
): boolean {
  const preparation = operation.destinationTargetSnapshot.preparation;
  return (
    (preparation != null && preparation !== "none") ||
    operation.supportMetadata.containsVenuePreparation === true
  );
}

const DESTINATION_CREDIT_KINDS = new Set<FundingObservationRow["kind"]>([
  "destination_credit",
]);

function sumObservationAmount(
  observations: readonly FundingObservationRow[],
  kinds: ReadonlySet<FundingObservationRow["kind"]>,
  requested: JsonRecord | null,
): JsonRecord | null {
  const selected = observations.filter(
    (observation) =>
      kinds.has(observation.kind) && isCanonicalFinal(observation),
  );
  if (selected.length === 0) return null;
  const networkIds = new Set(
    selected.map((observation) => observation.networkId),
  );
  const assetKeys = new Set(
    selected.map((observation) =>
      canonicalAssetId({
        networkId: observation.networkId,
        assetId: observation.assetId,
        decimals: observation.assetDecimals,
      }),
    ),
  );
  const assetDecimals = new Set(
    selected.map((observation) => observation.assetDecimals),
  );
  if (
    networkIds.size !== 1 ||
    assetKeys.size !== 1 ||
    assetDecimals.size !== 1
  ) {
    return null;
  }
  const requestedMoney = parseMoneyJson(requested);
  const first = selected[0];
  if (
    !first ||
    !requestedMoney ||
    !sameAsset(requestedMoney.asset, {
      networkId: first.networkId,
      assetId: first.assetId,
      decimals: first.assetDecimals,
    })
  ) {
    return null;
  }
  const raw = selected
    .reduce((total, observation) => total + BigInt(observation.rawAmount), 0n)
    .toString();
  return {
    asset: requestedMoney.asset,
    raw,
  };
}

// A routed ingress credit and the later source debit describe two lifecycle
// points of the same funds. Once a debit exists it is the authoritative amount
// that entered the route; adding the earlier wallet credit would count the
// transfer twice and can conflict with the amount already frozen by an earlier
// reducer pass.
function effectiveSourceAmount(
  observations: readonly FundingObservationRow[],
  requested: JsonRecord | null,
): JsonRecord | null {
  return (
    sumObservationAmount(observations, new Set(["source_debit"]), requested) ??
    sumObservationAmount(observations, new Set(["source_credit"]), requested)
  );
}

function moneyMeetsOrExceeds(
  actual: JsonRecord | null,
  expected: JsonRecord | null,
): boolean {
  const actualMoney = parseMoneyJson(actual);
  const expectedMoney = parseMoneyJson(expected);
  return Boolean(
    actualMoney &&
    expectedMoney &&
    sameAsset(actualMoney.asset, expectedMoney.asset) &&
    BigInt(actualMoney.raw) >= BigInt(expectedMoney.raw),
  );
}

async function releaseSourceReservationsAfterEvidence(
  client: Pick<PoolClient, "query">,
  operationId: string,
  observations: readonly FundingObservationRow[],
  reason: string,
  now: Date,
): Promise<void> {
  const segmentIds = [
    ...new Set(
      observations
        .filter(
          (observation) =>
            observation.segmentId != null &&
            isCanonicalFinal(observation) &&
            (
              [
                "source_debit",
                "source_credit",
                "destination_credit",
                "refund_credit",
              ] as const
            ).includes(
              observation.kind as
                | "source_debit"
                | "source_credit"
                | "destination_credit"
                | "refund_credit",
            ),
        )
        .flatMap((observation) =>
          observation.segmentId ? [observation.segmentId] : [],
        ),
    ),
  ];
  if (segmentIds.length === 0) return;
  const { rows } = await client.query<StoredReservationRow>(
    `
      select reservation.id, reservation.mode, reservation.state
      from balance_reservations reservation
      where reservation.operation_id = $1
        and reservation.segment_id = any($2::uuid[])
        and reservation.mode = 'subtract_available'
        and reservation.state = 'active'
      for update of reservation
    `,
    [operationId, segmentIds],
  );
  for (const reservation of rows) {
    await releaseFundingReservationInTransaction(client, {
      reservationId: reservation.id,
      outcomeReason: reason,
      now,
    });
  }
}

async function releaseVenuePreparationReservationsAfterReadiness(
  client: Pick<PoolClient, "query">,
  operationId: string,
  now: Date,
): Promise<void> {
  const { rows } = await client.query<{ id: string }>(
    `
      select id
      from balance_reservations
      where operation_id = $1
        and segment_id is null
        and mode = 'subtract_available'
        and state = 'active'
      for update
    `,
    [operationId],
  );
  for (const row of rows) {
    await releaseFundingReservationInTransaction(client, {
      reservationId: row.id,
      outcomeReason: "venue_readiness_finalized",
      now,
    });
  }
}

async function releaseUnusedStoppedStepReservations(
  client: Pick<PoolClient, "query">,
  operationId: string,
  facts: FundingLifecycleFacts,
  lifecycle: FundingLifecycleProjection,
  now: Date,
): Promise<void> {
  const actionStateById = new Map(
    lifecycle.actions.map((action) => [action.actionId, action.state]),
  );
  // A source reservation can be released only when its own route leg stopped
  // before any finalized money evidence. `step.state` used to approximate this
  // decision; attempt/receipt facts and the projector are the canonical view.
  const stoppedSegmentIds = [
    ...new Set(
      facts.actions.flatMap((action) => {
        if (action.routeLegId === null) return [];
        const state = actionStateById.get(action.actionId);
        const receiptMismatched = action.attempts.some(
          (attempt) => attempt.receipt?.status === "mismatch",
        );
        return state === "failed" || state === "cancelled" || receiptMismatched
          ? [action.routeLegId]
          : [];
      }),
    ),
  ];
  if (stoppedSegmentIds.length === 0) return;
  const { rows } = await client.query<{ id: string }>(
    `
      select reservation.id
      from balance_reservations reservation
      where reservation.operation_id = $1
        and reservation.state = 'active'
        and reservation.mode = 'subtract_available'
        and reservation.segment_id = any($2::uuid[])
        and not exists (
          select 1
          from funding_observations observation
          where observation.operation_id = reservation.operation_id
            and observation.segment_id = reservation.segment_id
            and observation.kind in (
              'source_debit',
              'source_credit',
              'destination_credit',
              'refund_credit'
            )
            and observation.canonical
            and observation.finality_status = 'finalized'
        )
      for update of reservation
    `,
    [operationId, stoppedSegmentIds],
  );
  for (const row of rows) {
    await releaseFundingReservationInTransaction(client, {
      reservationId: row.id,
      outcomeReason: "source_leg_stopped_before_financial_evidence",
      now,
    });
  }
}

async function releaseTerminalReservations(
  client: Pick<PoolClient, "query">,
  operationId: string,
  terminalStatus: FundingOperationRow["status"],
  now: Date,
): Promise<void> {
  const { rows } = await client.query<{ id: string }>(
    `
      select id
      from balance_reservations
      where operation_id = $1
        and state = 'active'
        and mode <> 'settled_for_consumer'
      for update
    `,
    [operationId],
  );
  for (const row of rows) {
    await releaseFundingReservationInTransaction(client, {
      reservationId: row.id,
      outcomeReason: `operation_${terminalStatus}`,
      now,
    });
  }
}

async function ensureSettledConsumerReservation(
  client: PoolClient,
  operation: FundingOperationRow,
  now: Date,
): Promise<void> {
  if (operation.purpose !== "trade_shortfall") return;
  const continuationOfOperationId =
    typeof operation.supportMetadata.continuationOfOperationId === "string"
      ? operation.supportMetadata.continuationOfOperationId
      : null;
  if (continuationOfOperationId) {
    const parentOperation = await client.query<{
      id: string;
      version: number;
    }>(
      `select id, version
         from funding_operations
        where id = $1::uuid
          and user_id = $2::uuid
        for update`,
      [continuationOfOperationId, operation.userId],
    );
    const parent = parentOperation.rows[0];
    if (!parent) {
      throw new Error("trade shortfall continuation parent is missing");
    }
    const parentFacts =
      await loadFundingLifecycleFactsForOperationInTransaction(client, {
        operationId: parent.id,
        now,
        reconciliationEvidenceTimeoutMs:
          DEFAULT_FUNDING_RECONCILIATION_TERMINAL_TIMEOUT_MS,
      });
    if (!parentFacts) {
      throw new Error("trade shortfall continuation parent facts are missing");
    }
    const parentLifecycle = deriveFundingLifecycle(parentFacts);
    const parentIsReady =
      parentLifecycle.status === "ready" &&
      parentLifecycle.progressStage === "ready_for_consumer";
    const parentIsTerminal = parentLifecycle.safety.terminal;
    if (!parentIsReady && !parentIsTerminal) {
      throw new Error("trade shortfall continuation parent is not consumable");
    }
    if (parentIsReady) {
      const parentReservations = await client.query<{ id: string }>(
        `select id
           from balance_reservations
          where operation_id = $1::uuid
            and user_id = $2::uuid
            and mode = 'settled_for_consumer'
            and state = 'active'
          for update`,
        [continuationOfOperationId, operation.userId],
      );
      if (parentReservations.rows.length === 0) {
        throw new Error(
          "trade shortfall continuation parent has no ready balance",
        );
      }
      if (parentReservations.rows.length !== 1) {
        throw new Error(
          "trade shortfall continuation parent has multiple ready balances",
        );
      }
      const reservation = parentReservations.rows[0];
      if (!reservation) {
        throw new Error(
          "trade shortfall continuation parent ready balance is missing",
        );
      }
      await releaseFundingReservationInTransaction(client, {
        reservationId: reservation.id,
        outcomeReason:
          "trade_shortfall_continuation_consumed_parent_ready_balance",
        now,
      });
      await writeFundingOperationSupportFactsInTransaction(client, {
        operationId: parent.id,
        expectedVersion: parent.version,
        supportMetadataPatch: {
          consumerResolution: "consumed_by_continuation",
          consumerResolvedAt: now.toISOString(),
          consumerResolutionReason: "continuation_ready",
          continuationOperationId: operation.id,
        },
        now,
      });
      await reduceFundingOperationInTransaction(client, {
        operationId: parent.id,
        now,
      });
      await client.query(
        `update telegram_funding_authorization_reservations
            set status = 'settled',
                resolved_at = $2,
                resolution_evidence = resolution_evidence || jsonb_build_object(
                  'operationStatus', 'completed',
                  'operationId', $1::text,
                  'reason', 'consumed_by_continuation',
                  'continuationOperationId', $3::text
                ),
                updated_at = $2
          where funding_operation_id = $1::uuid
            and status = 'reserved'`,
        [parent.id, now, operation.id],
      );
    }
  }
  const destination = parseMoneyJson(
    operation.actualDestinationAmount ?? operation.requestedDestinationAmount,
  );
  if (!destination || destination.raw === "0") return;
  const componentId =
    typeof operation.destinationTargetSnapshot.componentId === "string"
      ? operation.destinationTargetSnapshot.componentId
      : `funding-destination:${operation.id}`;
  const locationId =
    typeof operation.destinationTargetSnapshot.locationId === "string"
      ? operation.destinationTargetSnapshot.locationId
      : `funding-destination:${operation.id}`;
  await client.query(
    `
      insert into balance_reservations (
        user_id,
        operation_id,
        component_id,
        location_id,
        network_id,
        asset_id,
        asset_decimals,
        raw_amount,
        mode,
        expires_at
      )
      values (
        $1, $2, $3, $4, $5, $6, $7, $8, 'settled_for_consumer',
        $9::timestamptz + interval '30 minutes'
      )
      on conflict (operation_id, component_id, mode) do nothing
    `,
    [
      operation.userId,
      operation.id,
      componentId,
      locationId,
      destination.asset.networkId,
      destination.asset.assetId,
      destination.asset.decimals,
      destination.raw,
      now,
    ],
  );
}

async function expireSettledConsumerReservation(
  client: Pick<PoolClient, "query">,
  operation: FundingOperationRow,
  lifecycle: FundingLifecycleProjection,
  now: Date,
): Promise<FundingOperationRow | null> {
  if (
    lifecycle.status !== "ready" ||
    lifecycle.progressStage !== "ready_for_consumer"
  ) {
    return null;
  }
  const result = await client.query<{ id: string }>(
    `
      select id
      from balance_reservations
      where operation_id = $1
        and mode = 'settled_for_consumer'
        and state = 'active'
        and expires_at <= $2
        and not exists (
          select 1
          from funding_trade_attempts trade_attempt
          where trade_attempt.reservation_id = balance_reservations.id
            and (
              trade_attempt.state in ('submission_started', 'ambiguous')
              or trade_attempt.broadcast_may_have_occurred
            )
        )
      order by id
      for update
    `,
    [operation.id, now],
  );
  if (result.rows.length === 0) return null;
  if (result.rows.length !== 1) {
    throw new Error(
      `funding operation ${operation.id} has ambiguous expired consumer reservations`,
    );
  }
  const reservation = result.rows[0];
  if (!reservation) return null;
  await failTelegramAppHandoffV2FundedIntentWithoutConsumerInTransaction(
    client,
    {
      code: "funding_reservation_expired",
      message:
        "Prepared funding was not used before its Buy reservation expired.",
      operationId: operation.id,
      userId: operation.userId,
    },
  );
  await releaseFundingReservationInTransaction(client, {
    reservationId: reservation.id,
    outcomeReason: "consumer_reservation_expired",
    now,
  });
  const facts = await loadFundingLifecycleFactsForOperationInTransaction(
    client,
    {
      operationId: operation.id,
      now,
      reconciliationEvidenceTimeoutMs:
        DEFAULT_FUNDING_RECONCILIATION_TERMINAL_TIMEOUT_MS,
    },
  );
  if (!facts) {
    throw new Error(
      `funding operation ${operation.id} disappeared after expiry`,
    );
  }
  const projected = deriveFundingLifecycle(facts);
  return writeFundingOperationLifecycleProjectionCacheInTransaction(client, {
    operationId: operation.id,
    expectedVersion: operation.version,
    state: {
      status: projected.status,
      stage: projected.progressStage,
    },
    recoveryMode: projected.recoveryMode,
    supportMetadataPatch: {
      consumerResolution: "released_to_venue_cash",
      consumerResolvedAt: now.toISOString(),
      consumerResolutionReason: "reservation_expired",
    },
    now,
  });
}

async function preflightSettledConsumerReservationExpiry(
  client: PoolClient,
  operationId: string,
  now: Date,
): Promise<Readonly<{
  expired: FundingOperationRow | null;
  initial: FundingOperationRow;
}> | null> {
  const candidate = await client.query<{
    expiry_candidate: boolean;
  }>(
    `select exists (
              select 1
              from balance_reservations reservation
              where reservation.operation_id = operation.id
                and reservation.mode = 'settled_for_consumer'
                and reservation.state = 'active'
                and reservation.expires_at <= $2
                and not exists (
                  select 1
                  from funding_trade_attempts trade_attempt
                  where trade_attempt.reservation_id = reservation.id
                    and (
                      trade_attempt.state in ('submission_started', 'ambiguous')
                      or trade_attempt.broadcast_may_have_occurred
                    )
                )
            ) as expiry_candidate
       from funding_operations operation
      where operation.id = $1`,
    [operationId, now],
  );
  const candidateRow = candidate.rows[0];
  if (!candidateRow?.expiry_candidate) {
    return null;
  }
  const beforeLockFacts =
    await loadFundingLifecycleFactsForOperationInTransaction(client, {
      operationId,
      now,
      reconciliationEvidenceTimeoutMs:
        DEFAULT_FUNDING_RECONCILIATION_TERMINAL_TIMEOUT_MS,
    });
  if (!beforeLockFacts) return null;
  const beforeLockLifecycle = deriveFundingLifecycle(beforeLockFacts);
  if (
    beforeLockLifecycle.status !== "ready" ||
    beforeLockLifecycle.progressStage !== "ready_for_consumer"
  ) {
    return null;
  }

  // The exact handoff claim owns intent -> operation -> reservation. Expiry
  // must use the same order; locking the operation first can deadlock a claim
  // that already owns the intent and is waiting for that operation.
  await client.query(
    `select intent.id
       from telegram_trade_intents intent
      where intent.funding_operation_id = $1
      order by intent.id
      for update`,
    [operationId],
  );
  const initial = await fetchFundingOperationForWorkerInTransaction(
    client,
    operationId,
  );
  if (!initial) {
    throw new Error(`funding operation ${operationId} not found`);
  }
  const facts = await loadFundingLifecycleFactsForOperationInTransaction(
    client,
    {
      operationId,
      now,
      reconciliationEvidenceTimeoutMs:
        DEFAULT_FUNDING_RECONCILIATION_TERMINAL_TIMEOUT_MS,
    },
  );
  if (!facts) return null;
  const lifecycle = deriveFundingLifecycle(facts);
  if (
    lifecycle.status !== "ready" ||
    lifecycle.progressStage !== "ready_for_consumer"
  ) {
    return null;
  }
  return {
    initial,
    expired: await expireSettledConsumerReservation(
      client,
      initial,
      lifecycle,
      now,
    ),
  };
}

async function reduceFundingSegmentsInTransaction(
  client: Pick<PoolClient, "query">,
  input: Readonly<{
    operationId: string;
    observations: readonly FundingObservationRow[];
    lifecycle: FundingLifecycleProjection;
    now: Date;
  }>,
): Promise<readonly StoredFundingSegmentRow[]> {
  const { rows } = await client.query<StoredFundingSegmentRow>(
    `
      select id, ordinal, status, quoted_input, quoted_min_output
      from funding_operation_segments
      where operation_id = $1
      order by ordinal
      for update
    `,
    [input.operationId],
  );
  const lifecycleSegmentById = new Map(
    input.lifecycle.segments.map((segment) => [segment.routeLegId, segment]),
  );
  for (const segment of rows) {
    const observations = input.observations.filter(
      (observation) => observation.segmentId === segment.id,
    );
    const actualInput = effectiveSourceAmount(
      observations,
      segment.quoted_input,
    );
    const actualOutput = sumObservationAmount(
      observations,
      new Set(["destination_credit"]),
      segment.quoted_min_output,
    );
    const lifecycleSegment = lifecycleSegmentById.get(segment.id);
    if (!lifecycleSegment) {
      throw new Error(`funding lifecycle is missing route leg ${segment.id}`);
    }
    const target = lifecycleSegment.status;
    const inputIsFinal =
      moneyMeetsOrExceeds(actualInput, segment.quoted_input) ||
      target === "succeeded" ||
      target === "refunded" ||
      target === "failed";
    await writeFundingSegmentProjectionCacheInTransaction(client, {
      operationId: input.operationId,
      segmentId: segment.id,
      status: target,
      actualInput: inputIsFinal && actualInput ? actualInput : undefined,
      actualOutput:
        target === "succeeded" && actualOutput ? actualOutput : undefined,
      now: input.now,
    });
  }
  return rows;
}

export async function reduceFundingOperationInTransaction(
  client: PoolClient,
  input: Readonly<{ operationId: string; now?: Date }>,
): Promise<FundingReductionResult> {
  const now = input.now ?? new Date();
  const expiryPreflight = await preflightSettledConsumerReservationExpiry(
    client,
    input.operationId,
    now,
  );
  const initial =
    expiryPreflight?.initial ??
    (await fetchFundingOperationForWorkerInTransaction(
      client,
      input.operationId,
    ));
  if (!initial) {
    throw new Error(`funding operation ${input.operationId} not found`);
  }
  // This is a diagnostic/cache snapshot only. The lifecycle target below is
  // derived without reading the previous status/stage as an input.
  const initialState = operationState(initial);
  const observations = await listFundingObservationsForOperation(
    client,
    input.operationId,
  );
  const lifecycleFacts =
    await loadFundingLifecycleFactsForOperationInTransaction(client, {
      operationId: initial.id,
      now,
      reconciliationEvidenceTimeoutMs:
        DEFAULT_FUNDING_RECONCILIATION_TERMINAL_TIMEOUT_MS,
    });
  if (!lifecycleFacts) {
    throw new Error(
      `funding operation ${input.operationId} has no lifecycle facts`,
    );
  }
  const lifecycle = deriveFundingLifecycle(lifecycleFacts);
  const expired = expiryPreflight?.expired ?? null;
  if (expired) {
    // Expiry released the consumer reservation and wrote a presentation cache.
    // Reload the facts so the worker's next decision remains tied to the
    // durable release, never to that cache write's returned row.
    const expiredFacts =
      await loadFundingLifecycleFactsForOperationInTransaction(client, {
        operationId: expired.id,
        now,
        reconciliationEvidenceTimeoutMs:
          DEFAULT_FUNDING_RECONCILIATION_TERMINAL_TIMEOUT_MS,
      });
    if (!expiredFacts) {
      throw new Error(
        `funding operation ${expired.id} disappeared after reservation expiry`,
      );
    }
    const expiredLifecycle = deriveFundingLifecycle(expiredFacts);
    const finalState = {
      status: expiredLifecycle.status,
      stage: expiredLifecycle.progressStage,
    } satisfies FundingOperationState;
    return {
      operationId: expired.id,
      initialState,
      finalState,
      appliedTransitions: [finalState],
      terminal: expiredLifecycle.safety.terminal,
      reorgBlockedByTerminalState: false,
      recoveryMode: expiredLifecycle.recoveryMode,
      reconciliationEvidenceTimedOut:
        expiredLifecycle.safety.reconciliationEvidenceTimedOut,
      automaticRecoveryRecorded: expiredFacts.automaticRecovery !== null,
    };
  }
  await reduceFundingSegmentsInTransaction(client, {
    operationId: initial.id,
    observations,
    lifecycle,
    now,
  });
  await writeFundingActionProjectionCachesInTransaction(client, lifecycle, now);
  const target = {
    status: lifecycle.status,
    stage: lifecycle.progressStage,
  } satisfies FundingOperationState;
  const actualDestinationAmount = sumObservationAmount(
    observations,
    DESTINATION_CREDIT_KINDS,
    initial.requestedDestinationAmount,
  );
  const directWithdrawalCompleted =
    initial.purpose === "withdrawal" &&
    initial.supportMetadata.withdrawalExecutionKind ===
      "exact_same_asset_transfer" &&
    actualDestinationAmount != null;
  const actualSourceAmount = directWithdrawalCompleted
    ? initial.requestedSourceAmount
    : effectiveSourceAmount(observations, initial.requestedSourceAmount);
  const sourceObserved =
    hasFinalObservation(observations, "source_debit") ||
    hasFinalObservation(observations, "source_credit");
  const destinationObserved = hasFinalObservation(
    observations,
    "destination_credit",
  );
  const refundObserved = hasFinalObservation(observations, "refund_credit");
  const venueReady = hasFinalObservation(observations, "venue_readiness");
  const sourceLegsFinal = lifecycleFacts.plan.routeLegs.every((routeLeg) => {
    const actualInput = lifecycle.segments.find(
      (segment) => segment.routeLegId === routeLeg.routeLegId,
    )?.actualInput;
    return (
      actualInput !== null &&
      actualInput !== undefined &&
      sameAsset(
        {
          networkId: actualInput.networkId,
          assetId: actualInput.assetId,
          decimals: actualInput.decimals,
        },
        {
          networkId: routeLeg.requestedSource.networkId,
          assetId: routeLeg.requestedSource.assetId,
          decimals: routeLeg.requestedSource.decimals,
        },
      ) &&
      BigInt(actualInput.raw) >= BigInt(routeLeg.requestedSource.raw)
    );
  });
  const recordActualSource =
    actualSourceAmount != null &&
    (sourceLegsFinal ||
      ["completed", "refunded", "failed", "cancelled"].includes(target.status));
  const recordActualDestination =
    actualDestinationAmount != null &&
    [
      "destination_observed",
      "venue_preparation",
      "ready_for_consumer",
      "terminal",
    ].includes(target.stage);
  const stateChanged =
    initialState.status !== target.status ||
    initialState.stage !== target.stage;
  const operation =
    await writeFundingOperationLifecycleProjectionCacheInTransaction(client, {
      operationId: initial.id,
      expectedVersion: initial.version,
      state: target,
      actualSourceAmount: recordActualSource ? actualSourceAmount : undefined,
      actualDestinationAmount: recordActualDestination
        ? actualDestinationAmount
        : undefined,
      errorCode: lifecycle.errorCode,
      recoveryMode: lifecycle.recoveryMode,
      supportMetadataPatch:
        lifecycleFacts.manualRecovery !== null &&
        ["ready", "completed", "refunded"].includes(target.status)
          ? { lifecycleManualRecovery: null }
          : undefined,
      now,
    });
  const appliedTransitions = stateChanged ? [target] : [];

  if (sourceObserved || destinationObserved || refundObserved) {
    await releaseSourceReservationsAfterEvidence(
      client,
      operation.id,
      observations,
      refundObserved
        ? "refund_finalized"
        : destinationObserved
          ? "destination_finalized"
          : "source_debit_finalized",
      now,
    );
  }
  if (venueReady && destinationRequiresPreparation(operation)) {
    await releaseVenuePreparationReservationsAfterReadiness(
      client,
      operation.id,
      now,
    );
  }
  // `target` is the lifecycle decision made from this transaction's fact
  // snapshot. Do not read the operation cache we just materialized above to
  // decide reservation side effects.
  if (target.status === "ready") {
    await ensureSettledConsumerReservation(client, operation, now);
  }
  if (target.status === "recovery_required") {
    await releaseUnusedStoppedStepReservations(
      client,
      operation.id,
      lifecycleFacts,
      lifecycle,
      now,
    );
  }
  if (
    ["completed", "refunded", "failed", "cancelled"].includes(target.status)
  ) {
    await releaseTerminalReservations(client, operation.id, target.status, now);
  }
  if (target.status === "completed" || target.status === "refunded") {
    await client.query(
      `update telegram_funding_authorization_reservations
          set status = case when $2 = 'refunded' then 'refunded' else 'settled' end,
              resolved_at = $3,
              resolution_evidence = resolution_evidence || jsonb_build_object(
                'operationStatus', $2::text,
                'operationId', $1::text
              ),
              updated_at = $3
        where funding_operation_id = $1::uuid
          and (
            status = 'reserved'
            or ($2 = 'refunded' and status = 'cleaned')
          )`,
      [operation.id, target.status, now],
    );
  }
  if (target.status === "failed" || target.status === "cancelled") {
    // A terminal route cannot retain an allowance lane or rolling-cap slot.
    // A direct reservation belongs to this operation; a cleanup_required row
    // belongs to its zero-allowance cleanup child. Both are safe to release
    // once that exact operation is terminal: neither can still broadcast.
    await client.query(
      `update telegram_funding_authorization_reservations reservation
          set status = 'released',
              resolved_at = $2,
              resolution_evidence = resolution_evidence || jsonb_build_object(
                'operationStatus', $3::text,
                'operationId', $1::text,
                'reason', case
                  when reservation.cleanup_operation_id = $1::uuid
                    then 'cleanup_terminal_without_allowance_change'
                  else 'terminal_without_source_debit'
                end
              ),
              updated_at = $2
        where (
                reservation.funding_operation_id = $1::uuid
                and reservation.status = 'reserved'
              )
           or (
                reservation.cleanup_operation_id = $1::uuid
                and reservation.status = 'cleanup_required'
              )`,
      [operation.id, now, target.status],
    );
  }

  return {
    operationId: operation.id,
    initialState,
    finalState: target,
    appliedTransitions,
    terminal: ["completed", "refunded", "failed", "cancelled"].includes(
      target.status,
    ),
    reorgBlockedByTerminalState: false,
    recoveryMode: lifecycle.recoveryMode,
    reconciliationEvidenceTimedOut:
      lifecycle.safety.reconciliationEvidenceTimedOut,
    automaticRecoveryRecorded: lifecycleFacts.automaticRecovery !== null,
  };
}

export async function reduceFundingOperation(
  pool: Pool,
  input: Readonly<{ operationId: string; now?: Date }>,
): Promise<FundingReductionResult> {
  return tx(pool, (client) =>
    reduceFundingOperationInTransaction(client, input),
  );
}

export type FundingReconciliationBatchOptions = Readonly<{
  workerId: string;
  concurrency?: number;
  limit?: number;
  leaseSeconds?: number;
  retryDelayMs?: number;
  pollDelayMs?: number;
  idlePollDelayMs?: number;
  recoveryPollDelayMs?: number;
  maxAttempts?: number;
  terminalTimeoutMs?: number;
  now?: Date;
  providerPoll?: (
    operationId: string,
    now: Date,
  ) => Promise<Readonly<{ requestsPolled: number }>>;
  receiptPoll?: (
    operationId: string,
    now: Date,
  ) => Promise<Readonly<{ receiptsPolled: number }>>;
  postconditionPoll?: (
    operationId: string,
    now: Date,
  ) => Promise<Readonly<{ postconditionsPolled: number }>>;
  destinationPoll?: (
    operationId: string,
    now: Date,
  ) => Promise<
    Readonly<{
      destinationsPolled: number;
      destinationSatisfied: boolean;
    }>
  >;
}>;

export type FundingReconciliationBatchResult = Readonly<{
  claimed: number;
  completed: number;
  requeued: number;
  failed: number;
  deadLettered: number;
  operationIds: readonly string[];
}>;

const RECONCILIATION_ACTIVE_STATUSES = new Set<FundingOperationState["status"]>(
  ["in_progress", "reconcile_required"],
);
export const DEFAULT_FUNDING_RECONCILIATION_TERMINAL_TIMEOUT_MS = 90_000;
// Receipt application and the operation reducer run in separate durable
// passes. Give the reducer two ordinary polls to consume already-finalized
// action evidence, but never suppress a genuinely missing postcondition.
export const FUNDING_RECONCILIATION_EVIDENCE_REDUCTION_GRACE_MS = 30_000;
export const FUNDING_RECONCILIATION_TIMEOUT_ERROR_CODE =
  "reconciliation_evidence_timeout";
export const TERMINAL_REFUND_REORG_UNRESOLVED_ERROR_CODE =
  "terminal_refund_reorg_unresolved";
export const FUNDING_RECEIPT_REORG_UNRESOLVED_ERROR_CODE =
  "funding_receipt_reorg_unresolved";

export type FundingReconciliationDisposition =
  | "complete"
  | "requeue"
  | "recovery_required";

type FundingReconciliationActiveWindow = Readonly<{
  startedAt: Date;
  initialAttemptCount: number;
}>;

export function fundingReconciliationTerminalTimeoutReached(
  input: Readonly<{
    reconciliationStartedAt: Date;
    now: Date;
    terminalTimeoutMs: number;
  }>,
): boolean {
  return (
    input.now.getTime() - input.reconciliationStartedAt.getTime() >=
    input.terminalTimeoutMs
  );
}

export function fundingReconciliationDisposition(
  input: Readonly<{
    canonicalFinalizedStepEvidencePendingReduction?: boolean;
    state: FundingOperationState;
    recoveryMode?: FundingRecoveryMode | null;
    reconciliationEvidenceTimedOut?: boolean;
    automaticRecoveryRecorded?: boolean;
    reductionCompleted: boolean;
    reconciliationStartedAt: Date | null;
    now: Date;
    terminalTimeoutMs: number;
  }>,
): FundingReconciliationDisposition {
  if (input.reductionCompleted) {
    return "complete";
  }
  if (input.state.status === "recovery_required") {
    // The projector sees an elapsed generic deadline before this worker has
    // made that recovery decision durable. Persist it once; later polls use
    // the durable fact and the normal automatic-recovery cadence.
    if (
      input.reconciliationEvidenceTimedOut === true &&
      input.automaticRecoveryRecorded !== true
    ) {
      return "recovery_required";
    }
    return input.recoveryMode === "automatic_evidence" ? "requeue" : "complete";
  }
  // The timeout protects a missing-evidence wait. It must not turn already
  // canonical, finalized action evidence into a recovery incident merely
  // because the reducer has not consumed it on this pass yet. This is only a
  // bounded reducer-lag grace period: destination/readiness evidence still
  // has to arrive or the ordinary timeout becomes visible.
  if (
    input.canonicalFinalizedStepEvidencePendingReduction &&
    (input.reconciliationStartedAt == null ||
      !fundingReconciliationTerminalTimeoutReached({
        reconciliationStartedAt: input.reconciliationStartedAt,
        now: input.now,
        terminalTimeoutMs:
          input.terminalTimeoutMs +
          FUNDING_RECONCILIATION_EVIDENCE_REDUCTION_GRACE_MS,
      }))
  ) {
    return "requeue";
  }
  if (!RECONCILIATION_ACTIVE_STATUSES.has(input.state.status)) {
    return "requeue";
  }
  return input.reconciliationStartedAt != null &&
    fundingReconciliationTerminalTimeoutReached({
      reconciliationStartedAt: input.reconciliationStartedAt,
      now: input.now,
      terminalTimeoutMs: input.terminalTimeoutMs,
    })
    ? "recovery_required"
    : "requeue";
}

function storedFundingReconciliationActiveWindow(
  supportMetadata: Readonly<Record<string, JsonValue>>,
  attemptCount: number,
  now: Date,
): FundingReconciliationActiveWindow | null {
  const startedAtValue = supportMetadata.reconciliationActiveSince;
  const initialAttemptCount =
    supportMetadata.reconciliationActiveAttemptBaseline;
  if (
    typeof startedAtValue !== "string" ||
    typeof initialAttemptCount !== "number" ||
    !Number.isInteger(initialAttemptCount) ||
    initialAttemptCount < 0 ||
    initialAttemptCount > attemptCount
  ) {
    return null;
  }
  const startedAt = new Date(startedAtValue);
  return Number.isFinite(startedAt.getTime()) &&
    startedAt.getTime() <= now.getTime()
    ? { startedAt, initialAttemptCount }
    : null;
}

export async function fundingReconciliationWaitState(
  client: Pick<PoolClient, "query">,
  operationId: string,
  broadcastEvidenceWindowMs = DEFAULT_FUNDING_RECONCILIATION_TERMINAL_TIMEOUT_MS,
  now = new Date(),
): Promise<
  Readonly<{
    awaitingProviderReference: boolean;
    awaitingUnbroadcastActionReport: boolean;
    broadcastEvidenceActiveUntil: Date | null;
    providerReferenceRecoveryAt: Date | null;
  }>
> {
  const facts = await loadFundingLifecycleFactsForOperationInTransaction(
    client,
    {
      operationId,
      now,
      reconciliationEvidenceTimeoutMs:
        DEFAULT_FUNDING_RECONCILIATION_TERMINAL_TIMEOUT_MS,
    },
  );
  if (!facts) {
    return {
      awaitingProviderReference: false,
      awaitingUnbroadcastActionReport: false,
      broadcastEvidenceActiveUntil: null,
      providerReferenceRecoveryAt: null,
    };
  }

  const lifecycle = deriveFundingLifecycle(facts);
  const actionStateById = new Map(
    lifecycle.actions.map((action) => [action.actionId, action.state]),
  );
  const attempts = facts.actions.flatMap((action) =>
    action.attempts.map((attempt) => ({ action, attempt })),
  );
  const hasUnresolvedBroadcast = attempts.some(
    ({ attempt }) =>
      attempt.broadcastMayHaveOccurred && attempt.receipt?.status !== "failed",
  );
  const providerReferenceAttempts = attempts.filter(
    ({ action, attempt }) =>
      actionStateById.get(action.actionId) === "reconcile_required" &&
      attempt.outcome === "ambiguous" &&
      attempt.broadcastMayHaveOccurred &&
      attempt.referenceKind === "provider_receipt",
  );
  const broadcastEvidenceActiveUntil = attempts
    .filter(
      ({ attempt }) =>
        attempt.broadcastMayHaveOccurred &&
        (attempt.receipt === null ||
          ["pending", "confirmed", "reorged"].includes(attempt.receipt.status)),
    )
    .reduce<Date | null>((latest, { attempt }) => {
      const deadline = new Date(
        attempt.startedAt.getTime() + broadcastEvidenceWindowMs,
      );
      return latest === null || deadline.getTime() > latest.getTime()
        ? deadline
        : latest;
    }, null);
  const providerReferenceRecoveryAt =
    providerReferenceAttempts.reduce<Date | null>((earliest, { attempt }) => {
      const recoveryAt = new Date(
        attempt.updatedAt.getTime() + DELEGATED_PROVIDER_REPLAY_MS,
      );
      return earliest === null || recoveryAt.getTime() < earliest.getTime()
        ? recoveryAt
        : earliest;
    }, null);

  return {
    awaitingProviderReference: providerReferenceAttempts.length > 0,
    awaitingUnbroadcastActionReport:
      lifecycle.actions.some(
        (action) =>
          action.state === "planned" || action.state === "action_required",
      ) &&
      !lifecycle.actions.some((action) =>
        ["submitted", "reconcile_required", "recovery_required"].includes(
          action.state,
        ),
      ) &&
      !hasUnresolvedBroadcast,
    broadcastEvidenceActiveUntil,
    providerReferenceRecoveryAt,
  };
}

async function hasCanonicalFinalizedStepEvidencePendingReduction(
  pool: Pool,
  operationId: string,
  now: Date,
): Promise<boolean> {
  const facts = await loadFundingLifecycleFactsForOperationInTransaction(pool, {
    operationId,
    now,
  });
  if (!facts || facts.actions.length === 0) return false;
  const lifecycle = deriveFundingLifecycle(facts);
  // This is a worker wake-up hint, never an admission decision. Require both
  // the projector's current success result and a canonical finalized receipt
  // for every action, which is the former SQL condition without stale caches.
  return lifecycle.actions.every((projection) => {
    const action = facts.actions.find(
      (candidate) => candidate.actionId === projection.actionId,
    );
    return (
      projection.state === "succeeded" &&
      action?.attempts.some(
        (attempt) =>
          attempt.receipt?.status === "finalized" &&
          attempt.receipt.canonical &&
          attempt.receipt.actionMatched === true,
      ) === true
    );
  });
}

async function awaitingUnbroadcastActionReport(
  client: Pick<PoolClient, "query">,
  operationId: string,
  now = new Date(),
): Promise<boolean> {
  return (
    await fundingReconciliationWaitState(client, operationId, undefined, now)
  ).awaitingUnbroadcastActionReport;
}

async function unbroadcastActionExpiresAt(
  client: Pick<PoolClient, "query">,
  operationId: string,
  now = new Date(),
): Promise<Date | null> {
  const facts = await loadFundingLifecycleFactsForOperationInTransaction(
    client,
    {
      operationId,
      now,
      reconciliationEvidenceTimeoutMs:
        DEFAULT_FUNDING_RECONCILIATION_TERMINAL_TIMEOUT_MS,
    },
  );
  if (!facts) return null;
  const actionStateById = new Map(
    deriveFundingLifecycle(facts).actions.map((action) => [
      action.actionId,
      action.state,
    ]),
  );
  const actionable = facts.actions.filter((action) => {
    const state = actionStateById.get(action.actionId);
    return state === "planned" || state === "action_required";
  });
  if (
    actionable.length === 0 ||
    actionable.some((action) => action.expiresAt === null)
  ) {
    return null;
  }
  const firstExpiry = actionable[0]?.expiresAt;
  if (!firstExpiry) return null;
  return actionable.reduce<Date>((latest, action) => {
    const expiresAt = action.expiresAt;
    return expiresAt !== null && expiresAt.getTime() > latest.getTime()
      ? expiresAt
      : latest;
  }, firstExpiry);
}

async function synchronizeFundingReconciliationActiveWindow(
  pool: Pool,
  input: Readonly<{
    operationId: string;
    attemptCount: number;
    now: Date;
    terminalTimeoutMs: number;
  }>,
): Promise<FundingReconciliationActiveWindow | null> {
  return tx(pool, async (client) => {
    const operation = await fetchFundingOperationForWorkerInTransaction(
      client,
      input.operationId,
    );
    if (!operation) {
      return null;
    }
    const facts = await loadFundingLifecycleFactsForOperationInTransaction(
      client,
      {
        operationId: operation.id,
        now: input.now,
        reconciliationEvidenceTimeoutMs:
          DEFAULT_FUNDING_RECONCILIATION_TERMINAL_TIMEOUT_MS,
      },
    );
    if (!facts) return null;
    const lifecycle = deriveFundingLifecycle(facts);
    const genericTimeoutAwaitingEscalation =
      lifecycle.safety.reconciliationEvidenceTimedOut &&
      facts.automaticRecovery === null;
    const activeStatus =
      RECONCILIATION_ACTIVE_STATUSES.has(lifecycle.status) ||
      genericTimeoutAwaitingEscalation;
    const waitState = activeStatus
      ? await fundingReconciliationWaitState(
          client,
          operation.id,
          undefined,
          input.now,
        )
      : null;
    // The delegated executor owns recovery of its durable provider reference.
    // Starting the generic evidence timeout before that reference resolves can
    // strand the attempt before its recovery lease becomes eligible.
    if (
      !activeStatus ||
      waitState?.awaitingUnbroadcastActionReport ||
      waitState?.awaitingProviderReference ||
      lifecycle.safety.awaitingProviderReceipt
    ) {
      const hasStoredWindow =
        operation.supportMetadata.reconciliationActiveSince != null ||
        operation.supportMetadata.reconciliationActiveAttemptBaseline != null;
      if (hasStoredWindow) {
        await writeFundingOperationSupportFactsInTransaction(client, {
          operationId: operation.id,
          expectedVersion: operation.version,
          supportMetadataPatch: {
            reconciliationActiveSince: null,
            reconciliationActiveAttemptBaseline: null,
            reconciliationEvidenceDeadline: null,
          },
          now: input.now,
        });
      }
      return null;
    }
    const stored = storedFundingReconciliationActiveWindow(
      operation.supportMetadata,
      input.attemptCount,
      input.now,
    );
    const activeWindow =
      stored ??
      ({
        startedAt: input.now,
        initialAttemptCount: Math.max(0, input.attemptCount - 1),
      } satisfies FundingReconciliationActiveWindow);
    const storedDeadline =
      operation.supportMetadata.reconciliationEvidenceDeadline;
    const hasStoredDeadline =
      typeof storedDeadline === "string" &&
      Number.isFinite(new Date(storedDeadline).getTime());
    if (!stored || !hasStoredDeadline) {
      await writeFundingOperationSupportFactsInTransaction(client, {
        operationId: operation.id,
        expectedVersion: operation.version,
        supportMetadataPatch: {
          reconciliationActiveSince: activeWindow.startedAt.toISOString(),
          reconciliationActiveAttemptBaseline: activeWindow.initialAttemptCount,
          reconciliationEvidenceDeadline: new Date(
            activeWindow.startedAt.getTime() + input.terminalTimeoutMs,
          ).toISOString(),
        },
        now: input.now,
      });
    }
    return activeWindow;
  });
}

function summarizeError(error: unknown): Readonly<{
  code: string;
  summary: string;
}> {
  const fundingError = error as Partial<FundingPersistenceError>;
  return {
    code:
      typeof fundingError.code === "string"
        ? fundingError.code
        : "funding_reconciliation_failed",
    summary: error instanceof Error ? error.message : String(error),
  };
}

const NON_TRANSIENT_RECONCILIATION_ERROR_CODES = new Set([
  "actual_amount_conflict",
  "ambiguous_duplicate_observation",
  "idempotency_conflict",
  "invalid_operation_state",
  "invalid_segment_transition",
  "invalid_state_transition",
  "quote_mismatch",
  "trade_submission_reconciling",
]);

export function fundingReconciliationErrorIsNonTransient(
  error: unknown,
): boolean {
  if (!error || typeof error !== "object") return false;
  const detail = error as Readonly<{
    code?: unknown;
    retryable?: unknown;
    transient?: unknown;
  }>;
  if (detail.retryable === false || detail.transient === false) return true;
  return (
    typeof detail.code === "string" &&
    NON_TRANSIENT_RECONCILIATION_ERROR_CODES.has(detail.code)
  );
}

export function fundingReconciliationPollDelayMs(
  state: FundingOperationState,
  input: Readonly<{
    activePollDelayMs: number;
    broadcastEvidenceActiveUntil?: Date | null;
    idlePollDelayMs: number;
    now?: Date;
    recoveryMode?: FundingRecoveryMode | null;
    recoveryPollDelayMs?: number;
    awaitingUnbroadcastActionReport?: boolean;
  }>,
): number {
  if (state.status === "recovery_required") {
    if (
      input.recoveryMode === "automatic_evidence" &&
      input.broadcastEvidenceActiveUntil != null &&
      input.broadcastEvidenceActiveUntil.getTime() >
        (input.now ?? new Date()).getTime()
    ) {
      return input.activePollDelayMs;
    }
    return input.recoveryPollDelayMs ?? 60_000;
  }
  if (input.awaitingUnbroadcastActionReport) {
    return input.idlePollDelayMs;
  }
  return state.status === "in_progress" || state.status === "reconcile_required"
    ? input.activePollDelayMs
    : input.idlePollDelayMs;
}

export async function pollFundingReconciliationEvidence(
  input: Readonly<{
    operationId: string;
    state: FundingOperationState;
    recoveryMode?: FundingRecoveryMode | null;
    recentFailedReceiptWatch?: boolean;
    terminalReceiptWatch?: boolean;
    terminalRelayRefundWatch?: boolean;
    awaitingUnbroadcastActionReport?: boolean;
    now: Date;
    providerPoll?: FundingReconciliationBatchOptions["providerPoll"];
    receiptPoll?: FundingReconciliationBatchOptions["receiptPoll"];
    postconditionPoll?: FundingReconciliationBatchOptions["postconditionPoll"];
    destinationPoll?: FundingReconciliationBatchOptions["destinationPoll"];
  }>,
): Promise<Readonly<{ terminalReceiptPollFailed: boolean }>> {
  const terminalReceiptWatch = input.terminalReceiptWatch === true;
  const receiptWatch =
    terminalReceiptWatch || input.recentFailedReceiptWatch === true;
  const terminalRelayRefundWatch = input.terminalRelayRefundWatch === true;
  if (
    input.awaitingUnbroadcastActionReport &&
    !receiptWatch &&
    !(
      input.state.status === "recovery_required" &&
      input.recoveryMode === "automatic_evidence"
    )
  )
    return { terminalReceiptPollFailed: false };
  if (
    input.state.status === "recovery_required" &&
    input.recoveryMode !== "automatic_evidence" &&
    !receiptWatch
  ) {
    return { terminalReceiptPollFailed: false };
  }
  let terminalReceiptPollFailed = false;
  if (receiptWatch) {
    try {
      await input.receiptPoll?.(input.operationId, input.now);
    } catch {
      terminalReceiptPollFailed = true;
      // A receipt RPC/integrity failure must not consume the bounded local
      // canonical refund watch. Continue to the authoritative chain scan.
    }
  } else {
    await input.receiptPoll?.(input.operationId, input.now);
  }
  if (input.state.status === "awaiting_user") {
    return { terminalReceiptPollFailed };
  }
  // A terminal refund remains under a bounded canonical watch. Refresh Relay
  // first so a replacement refund transaction hash revealed after a reorg is
  // available to the exact owned-transfer scanner in this same poll wave.
  // Provider availability must not gate the local canonical scan: otherwise a
  // Relay outage could consume the whole watch without observing a chain reorg.
  // This refresh is therefore best-effort for terminal evidence only.
  if (terminalRelayRefundWatch) {
    try {
      await input.providerPoll?.(input.operationId, input.now);
    } catch {
      // Continue to the authoritative local refund scan and bounded reduction.
    }
  }
  const [, destination] = await Promise.all([
    input.postconditionPoll?.(input.operationId, input.now),
    input.destinationPoll?.(input.operationId, input.now),
  ]);
  if (
    !RECONCILIATION_ACTIVE_STATUSES.has(input.state.status) &&
    !(
      input.state.status === "recovery_required" &&
      input.recoveryMode === "automatic_evidence"
    )
  ) {
    return { terminalReceiptPollFailed };
  }
  // Finalized source receipts plus the exact owned-destination balance delta
  // are authoritative completion evidence. Provider status is only needed
  // while that destination evidence is still absent.
  if (!terminalRelayRefundWatch && !destination?.destinationSatisfied) {
    await input.providerPoll?.(input.operationId, input.now);
  }
  return { terminalReceiptPollFailed };
}

async function loadFundingOperationState(
  pool: Pool,
  operationId: string,
  now: Date,
  broadcastEvidenceWindowMs = DEFAULT_FUNDING_RECONCILIATION_TERMINAL_TIMEOUT_MS,
): Promise<
  Readonly<{
    state: FundingOperationState;
    recoveryMode: FundingRecoveryMode | null;
    recentFailedReceiptWatch: boolean;
    terminalReceiptWatch: boolean;
    terminalRelayRefundWatch: boolean;
    awaitingProviderReference: boolean;
    awaitingUnbroadcastActionReport: boolean;
    broadcastEvidenceActiveUntil: Date | null;
    providerReferenceRecoveryAt: Date | null;
    unbroadcastActionExpiresAt: Date | null;
  }>
> {
  return tx(pool, async (client) => {
    const operation = await fetchFundingOperationForWorkerInTransaction(
      client,
      operationId,
    );
    if (!operation) {
      throw new Error(`funding operation ${operationId} was not found`);
    }
    const waitState = await fundingReconciliationWaitState(
      client,
      operation.id,
      broadcastEvidenceWindowMs,
      now,
    );
    const facts = await loadFundingLifecycleFactsForOperationInTransaction(
      client,
      {
        operationId: operation.id,
        now,
        reconciliationEvidenceTimeoutMs: broadcastEvidenceWindowMs,
      },
    );
    if (!facts) {
      throw new Error(
        `funding operation ${operationId} has no lifecycle facts`,
      );
    }
    const lifecycle = deriveFundingLifecycle(facts);
    const terminalEvidenceWatch = await client.query<{ watching: boolean }>(
      `select (
             exists (
               select 1
               from funding_operation_steps step
               join funding_operation_step_attempts attempt
                 on attempt.step_id = step.id
               where step.operation_id = $1::uuid
                 and attempt.broadcast_may_have_occurred
                 and attempt.receipt_ref_ciphertext is not null
                 and attempt.receipt_ref_lookup_hmac is not null
                 and attempt.lookup_key_version is not null
             )
             or exists (
               select 1
               from funding_observations refund
               where refund.operation_id = $1::uuid
                 and refund.kind = 'refund_credit'
                 and (
                   (
                     refund.finality_status = 'finalized'
                     and refund.canonical
                     and refund.finalized_at >=
                           $2::timestamptz - interval '15 minutes'
                   )
                   or (
                     refund.finality_status = 'reorged'
                     and not refund.canonical
                     and refund.reorged_at >=
                           $2::timestamptz - interval '15 minutes'
                   )
                 )
             )
           ) as watching`,
      [operation.id, now],
    );
    const terminalRelayRefundWatch = await client.query<{ watching: boolean }>(
      `select exists (
         select 1
           from funding_observations refund
          where refund.operation_id = $1::uuid
            and refund.kind = 'refund_credit'
            and (
              (
                refund.finality_status = 'finalized'
                and refund.canonical
                and refund.finalized_at >= $2::timestamptz - interval '15 minutes'
              )
              or (
                refund.finality_status = 'reorged'
                and not refund.canonical
                and refund.reorged_at >= $2::timestamptz - interval '15 minutes'
              )
            )
       ) as watching`,
      [operation.id, now],
    );
    const recentFailedReceiptWatch = await client.query<{ watching: boolean }>(
      `select exists (
         select 1
         from funding_operation_steps step
         join funding_step_receipt_observations receipt
           on receipt.step_id = step.id
         where step.operation_id = $1::uuid
           and receipt.status = 'failed'
           and receipt.canonical
           and receipt.evidence ->> 'failureFinalized' = 'true'
           and receipt.finalized_at >
                 $2::timestamptz - interval '15 minutes'
       ) as watching`,
      [operation.id, now],
    );
    return {
      state: {
        status: lifecycle.status,
        stage: lifecycle.progressStage,
      },
      recoveryMode: lifecycle.recoveryMode,
      recentFailedReceiptWatch:
        recentFailedReceiptWatch.rows[0]?.watching === true,
      terminalReceiptWatch:
        terminalEvidenceWatch.rows[0]?.watching === true ||
        operation.supportMetadata.withdrawalExecutionKind ===
          "exact_same_asset_transfer",
      terminalRelayRefundWatch:
        terminalRelayRefundWatch.rows[0]?.watching === true,
      awaitingProviderReference: waitState.awaitingProviderReference,
      awaitingUnbroadcastActionReport:
        waitState.awaitingUnbroadcastActionReport,
      broadcastEvidenceActiveUntil: waitState.broadcastEvidenceActiveUntil,
      providerReferenceRecoveryAt: waitState.providerReferenceRecoveryAt,
      unbroadcastActionExpiresAt: await unbroadcastActionExpiresAt(
        client,
        operation.id,
        now,
      ),
    };
  });
}

async function expireUnbroadcastActionWait(
  pool: Pool,
  input: Readonly<{ operationId: string; now: Date }>,
): Promise<boolean> {
  return tx(pool, async (client) => {
    const operation = await fetchFundingOperationForWorkerInTransaction(
      client,
      input.operationId,
    );
    const facts = operation
      ? await loadFundingLifecycleFactsForOperationInTransaction(client, {
          operationId: operation.id,
          now: input.now,
          reconciliationEvidenceTimeoutMs:
            DEFAULT_FUNDING_RECONCILIATION_TERMINAL_TIMEOUT_MS,
        })
      : null;
    const lifecycle = facts ? deriveFundingLifecycle(facts) : null;
    if (
      !operation ||
      !lifecycle ||
      lifecycle.safety.terminal ||
      !(await awaitingUnbroadcastActionReport(client, operation.id, input.now))
    ) {
      return false;
    }
    const actionExpiresAt = await unbroadcastActionExpiresAt(
      client,
      operation.id,
      input.now,
    );
    if (!actionExpiresAt || actionExpiresAt.getTime() > input.now.getTime()) {
      return false;
    }
    const cancellationFacts =
      await recordSafeFundingActionCancellationsInTransaction(client, {
        operationId: operation.id,
        now: input.now,
      });
    if (cancellationFacts.unsafeStepIds.length > 0) {
      return false;
    }
    await writeFundingOperationSupportFactsInTransaction(client, {
      operationId: operation.id,
      expectedVersion: operation.version,
      supportMetadataPatch: {
        actionWaitExpiredAt: input.now.toISOString(),
        terminalReason: "unbroadcast_action_expired",
      },
      now: input.now,
    });
    const reduction = await reduceFundingOperationInTransaction(client, {
      operationId: operation.id,
      now: input.now,
    });
    if (
      reduction.finalState.status !== "cancelled" ||
      reduction.finalState.stage !== "terminal"
    ) {
      throw new Error(
        `expired unbroadcast funding operation ${operation.id} did not cancel`,
      );
    }
    return true;
  });
}

async function markFundingOperationRecoveryRequired(
  pool: Pool,
  input: Readonly<{
    operationId: string;
    errorCode: string;
    recoveryMode: FundingRecoveryMode;
    now: Date;
  }>,
): Promise<boolean> {
  return tx(pool, async (client) => {
    let operation = await fetchFundingOperationForWorkerInTransaction(
      client,
      input.operationId,
    );
    if (!operation) {
      return false;
    }
    if (input.recoveryMode === "manual_review") {
      // A manual escalation is a durable typed fact. It is deliberately not
      // inferred from, or written through, the previous public cache state.
      operation = await writeFundingOperationSupportFactsInTransaction(client, {
        operationId: operation.id,
        expectedVersion: operation.version,
        supportMetadataPatch: {
          lifecycleManualRecovery: {
            code: input.errorCode,
            requestedAt: input.now.toISOString(),
          },
          reconciliationRecoveryRequiredAt: input.now.toISOString(),
          reconciliationRecoveryReason: input.errorCode,
        },
        now: input.now,
      });
    } else {
      // Record the elapsed automatic-evidence window as a durable fact before
      // refreshing the projection cache. The generic active window is only a
      // timer for an in-progress reconciliation; it must be clearable without
      // making an already-escalated operation appear active again.
      operation = await writeFundingOperationSupportFactsInTransaction(client, {
        operationId: operation.id,
        expectedVersion: operation.version,
        supportMetadataPatch: {
          lifecycleAutomaticRecovery: {
            code: input.errorCode,
            requestedAt: input.now.toISOString(),
          },
        },
        now: input.now,
      });
    }
    const facts = await loadFundingLifecycleFactsForOperationInTransaction(
      client,
      {
        operationId: operation.id,
        now: input.now,
        reconciliationEvidenceTimeoutMs:
          DEFAULT_FUNDING_RECONCILIATION_TERMINAL_TIMEOUT_MS,
      },
    );
    if (!facts) return false;
    const lifecycle = deriveFundingLifecycle(facts);
    if (lifecycle.status !== "recovery_required") {
      return false;
    }
    await writeFundingActionProjectionCachesInTransaction(
      client,
      lifecycle,
      input.now,
    );
    await writeFundingOperationLifecycleProjectionCacheInTransaction(client, {
      operationId: operation.id,
      expectedVersion: operation.version,
      state: {
        status: lifecycle.status,
        stage: lifecycle.progressStage,
      },
      recoveryMode: lifecycle.recoveryMode,
      errorCode: input.errorCode,
      supportMetadataPatch: undefined,
      now: input.now,
    });
    return true;
  });
}

async function markFundingOperationRecoveryManualReview(
  pool: Pool,
  input: Readonly<{
    operationId: string;
    errorCode: string;
    now: Date;
  }>,
): Promise<boolean> {
  return markFundingOperationRecoveryRequired(pool, {
    ...input,
    recoveryMode: "manual_review",
  });
}

async function processLease(
  pool: Pool,
  lease: FundingReconciliationLease,
  options: Required<
    Pick<
      FundingReconciliationBatchOptions,
      | "maxAttempts"
      | "pollDelayMs"
      | "idlePollDelayMs"
      | "recoveryPollDelayMs"
      | "retryDelayMs"
      | "terminalTimeoutMs"
    >
  > &
    Readonly<{ now: Date }>,
  providerPoll?: FundingReconciliationBatchOptions["providerPoll"],
  receiptPoll?: FundingReconciliationBatchOptions["receiptPoll"],
  postconditionPoll?: FundingReconciliationBatchOptions["postconditionPoll"],
  destinationPoll?: FundingReconciliationBatchOptions["destinationPoll"],
): Promise<"completed" | "requeued" | "failed" | "dead_lettered"> {
  try {
    let operationBeforePoll = await loadFundingOperationState(
      pool,
      lease.operationId,
      options.now,
      options.terminalTimeoutMs,
    );
    if (
      operationBeforePoll.awaitingUnbroadcastActionReport &&
      operationBeforePoll.unbroadcastActionExpiresAt !== null &&
      operationBeforePoll.unbroadcastActionExpiresAt.getTime() <=
        options.now.getTime() &&
      (await expireUnbroadcastActionWait(pool, {
        operationId: lease.operationId,
        now: options.now,
      }))
    ) {
      if (operationBeforePoll.recentFailedReceiptWatch) {
        // Expiry releases an unused retry, but the earlier canonical failure
        // remains under its bounded deep-reorg watch. Reload the now-terminal
        // operation and keep this job alive until that watch ends.
        operationBeforePoll = await loadFundingOperationState(
          pool,
          lease.operationId,
          options.now,
          options.terminalTimeoutMs,
        );
      } else {
        await finishFundingReconciliationLease(pool, {
          jobId: lease.jobId,
          leaseOwner: lease.leaseOwner,
          leaseToken: lease.leaseToken,
          result: { kind: "completed" },
          now: options.now,
        });
        return "completed";
      }
    }
    const pollEvidence = await pollFundingReconciliationEvidence({
      operationId: lease.operationId,
      state: operationBeforePoll.state,
      recoveryMode: operationBeforePoll.recoveryMode,
      recentFailedReceiptWatch: operationBeforePoll.recentFailedReceiptWatch,
      terminalReceiptWatch: operationBeforePoll.terminalReceiptWatch,
      terminalRelayRefundWatch: operationBeforePoll.terminalRelayRefundWatch,
      awaitingUnbroadcastActionReport:
        operationBeforePoll.awaitingUnbroadcastActionReport,
      now: options.now,
      providerPoll,
      receiptPoll,
      postconditionPoll,
      destinationPoll,
    });
    if (pollEvidence.terminalReceiptPollFailed) {
      const terminalReceiptVerificationWindow = await pool.query<{
        expired: boolean;
      }>(
        `select exists (
                 select 1
                   from funding_operation_steps step
                   join funding_step_receipt_observations receipt
                     on receipt.step_id = step.id
                  where step.operation_id = $1::uuid
                    and receipt.status in ('finalized', 'failed')
                    and receipt.canonical
                    and receipt.finalized_at <=
                          $2::timestamptz - interval '15 minutes'
               )
               and not exists (
                 select 1
                   from funding_operation_steps step
                   join funding_step_receipt_observations receipt
                     on receipt.step_id = step.id
                  where step.operation_id = $1::uuid
                    and receipt.status in ('finalized', 'failed')
                    and receipt.canonical
                    and receipt.finalized_at >
                          $2::timestamptz - interval '15 minutes'
               ) as expired`,
        [lease.operationId, options.now],
      );
      const deadLetter =
        terminalReceiptVerificationWindow.rows[0]?.expired === true;
      await finishFundingReconciliationLease(pool, {
        jobId: lease.jobId,
        leaseOwner: lease.leaseOwner,
        leaseToken: lease.leaseToken,
        result: {
          kind: "error",
          dueAt: new Date(options.now.getTime() + options.retryDelayMs),
          errorCode: "terminal_relay_receipt_verification_unavailable",
          errorSummary:
            "terminal action receipt canonicality verification was unavailable",
          deadLetter,
        },
        now: options.now,
      });
      return deadLetter ? "dead_lettered" : "requeued";
    }
    const reduction = await reduceFundingOperation(pool, {
      operationId: lease.operationId,
      now: options.now,
    });
    const unresolvedReceiptReorg = await pool.query<{ incident: boolean }>(
      `select exists (
         select 1
           from funding_step_receipt_observations receipt
          where receipt.operation_id = $1::uuid
            and receipt.status = 'reorged'
            and receipt.reorged_at <=
                  $2::timestamptz - interval '15 minutes'
       ) as incident`,
      [lease.operationId, options.now],
    );
    if (unresolvedReceiptReorg.rows[0]?.incident === true) {
      await markFundingOperationRecoveryManualReview(pool, {
        operationId: lease.operationId,
        errorCode: FUNDING_RECEIPT_REORG_UNRESOLVED_ERROR_CODE,
        now: options.now,
      });
      await finishFundingReconciliationLease(pool, {
        jobId: lease.jobId,
        leaseOwner: lease.leaseOwner,
        leaseToken: lease.leaseToken,
        result: {
          kind: "error",
          dueAt: options.now,
          errorCode: FUNDING_RECEIPT_REORG_UNRESOLVED_ERROR_CODE,
          errorSummary:
            "funding action receipt reorg remained unresolved after its canonical watch window",
          deadLetter: true,
        },
        now: options.now,
      });
      return "dead_lettered";
    }
    const actionReceiptReorgWatch = reduction.terminal
      ? await pool.query<{ watching: boolean }>(
          `select exists (
             select 1
               from funding_operation_steps step
               join funding_step_receipt_observations receipt
                 on receipt.step_id = step.id
              where step.operation_id = $1::uuid
                and receipt.status in ('finalized', 'failed')
                and receipt.finalized_at > $2::timestamptz - interval '15 minutes'
             union all
             select 1
               from funding_observations refund
              where refund.operation_id = $1::uuid
                and refund.kind = 'refund_credit'
                and (
                  (
                    refund.finality_status = 'finalized'
                    and refund.canonical
                    and refund.finalized_at >
                          $2::timestamptz - interval '15 minutes'
                  )
                  or (
                    refund.finality_status = 'reorged'
                    and not refund.canonical
                    and refund.reorged_at >
                          $2::timestamptz - interval '15 minutes'
                  )
                )
           ) as watching`,
          [lease.operationId, options.now],
        )
      : null;
    const reductionCompleted =
      reduction.terminal &&
      !reduction.reorgBlockedByTerminalState &&
      actionReceiptReorgWatch?.rows[0]?.watching !== true;
    const canonicalFinalizedStepEvidencePendingReduction = reductionCompleted
      ? false
      : await hasCanonicalFinalizedStepEvidencePendingReduction(
          pool,
          lease.operationId,
          options.now,
        );
    // A reorged refund is a money-movement incident, not a property of the
    // materialized operation cache.  The projector deliberately reopens its
    // public cache to recovery_required as soon as the canonical credit is
    // lost.  Keep the bounded watch/dead-letter decision anchored in the
    // reorged refund fact, otherwise that correct cache update would turn the
    // final scan into an unbounded retry loop.
    const terminalRefundReorgIncident = await pool.query<{ incident: boolean }>(
      `select exists (
               select 1
                 from funding_observations reorged_refund
                where reorged_refund.operation_id = $1::uuid
                  and reorged_refund.kind = 'refund_credit'
                  and reorged_refund.finality_status = 'reorged'
                  and not reorged_refund.canonical
                  and reorged_refund.reorged_at <=
                        $2::timestamptz - interval '15 minutes'
                  and not exists (
                    select 1
                      from funding_observations replacement_refund
                     where replacement_refund.operation_id =
                             reorged_refund.operation_id
                       and replacement_refund.id <> reorged_refund.id
                       and replacement_refund.kind = 'refund_credit'
                       and replacement_refund.segment_id is not distinct from
                             reorged_refund.segment_id
                       and replacement_refund.network_id =
                             reorged_refund.network_id
                       and replacement_refund.asset_id =
                             reorged_refund.asset_id
                       and replacement_refund.asset_decimals =
                             reorged_refund.asset_decimals
                       and replacement_refund.raw_amount =
                             reorged_refund.raw_amount
                       and replacement_refund.metadata ->>
                             'replacementForRefundObservationId' =
                             reorged_refund.id::text
                       and replacement_refund.observed_at >=
                             reorged_refund.reorged_at
                       and (
                         (
                           replacement_refund.finality_status = 'finalized'
                           and replacement_refund.canonical
                         )
                         or (
                           replacement_refund.finality_status = 'reorged'
                           and not replacement_refund.canonical
                         )
                       )
                  )
             ) as incident`,
      [lease.operationId, options.now],
    );
    if (terminalRefundReorgIncident.rows[0]?.incident === true) {
      await finishFundingReconciliationLease(pool, {
        jobId: lease.jobId,
        leaseOwner: lease.leaseOwner,
        leaseToken: lease.leaseToken,
        result: {
          kind: "error",
          dueAt: options.now,
          errorCode: TERMINAL_REFUND_REORG_UNRESOLVED_ERROR_CODE,
          errorSummary:
            "terminal Relay refund reorg remained unresolved after its canonical recovery window",
          deadLetter: true,
        },
        now: options.now,
      });
      return "dead_lettered";
    }
    const activeWindow = reductionCompleted
      ? null
      : await synchronizeFundingReconciliationActiveWindow(pool, {
          operationId: lease.operationId,
          attemptCount: lease.attemptCount,
          now: options.now,
          terminalTimeoutMs: options.terminalTimeoutMs,
        });
    const disposition = fundingReconciliationDisposition({
      canonicalFinalizedStepEvidencePendingReduction,
      state: reduction.finalState,
      recoveryMode: reduction.recoveryMode,
      reconciliationEvidenceTimedOut: reduction.reconciliationEvidenceTimedOut,
      automaticRecoveryRecorded: reduction.automaticRecoveryRecorded,
      reductionCompleted,
      reconciliationStartedAt: activeWindow?.startedAt ?? null,
      now: options.now,
      terminalTimeoutMs: options.terminalTimeoutMs,
    });
    const providerReferenceDueAt =
      operationBeforePoll.awaitingProviderReference &&
      operationBeforePoll.providerReferenceRecoveryAt
        ? new Date(
            Math.max(
              operationBeforePoll.providerReferenceRecoveryAt.getTime(),
              options.now.getTime() + options.pollDelayMs,
            ),
          )
        : null;
    if (disposition === "complete") {
      await finishFundingReconciliationLease(pool, {
        jobId: lease.jobId,
        leaseOwner: lease.leaseOwner,
        leaseToken: lease.leaseToken,
        result: { kind: "completed" },
        now: options.now,
      });
      return "completed";
    }
    if (disposition === "recovery_required") {
      await markFundingOperationRecoveryRequired(pool, {
        operationId: lease.operationId,
        errorCode: FUNDING_RECONCILIATION_TIMEOUT_ERROR_CODE,
        recoveryMode: "automatic_evidence",
        now: options.now,
      });
      await finishFundingReconciliationLease(pool, {
        jobId: lease.jobId,
        leaseOwner: lease.leaseOwner,
        leaseToken: lease.leaseToken,
        result: {
          kind: "requeue",
          dueAt:
            providerReferenceDueAt ??
            new Date(
              options.now.getTime() +
                fundingReconciliationPollDelayMs(
                  {
                    status: "recovery_required",
                    stage: reduction.finalState.stage,
                  },
                  {
                    activePollDelayMs: options.pollDelayMs,
                    broadcastEvidenceActiveUntil:
                      operationBeforePoll.broadcastEvidenceActiveUntil,
                    idlePollDelayMs: options.idlePollDelayMs,
                    now: options.now,
                    recoveryMode: "automatic_evidence",
                    recoveryPollDelayMs: options.recoveryPollDelayMs,
                  },
                ),
            ),
        },
        now: options.now,
      });
      return "requeued";
    }
    await finishFundingReconciliationLease(pool, {
      jobId: lease.jobId,
      leaseOwner: lease.leaseOwner,
      leaseToken: lease.leaseToken,
      result: {
        kind: "requeue",
        dueAt:
          providerReferenceDueAt !== null
            ? providerReferenceDueAt
            : new Date(
                options.now.getTime() +
                  fundingReconciliationPollDelayMs(reduction.finalState, {
                    activePollDelayMs: options.pollDelayMs,
                    broadcastEvidenceActiveUntil:
                      operationBeforePoll.broadcastEvidenceActiveUntil,
                    idlePollDelayMs: options.idlePollDelayMs,
                    now: options.now,
                    recoveryMode: reduction.recoveryMode,
                    recoveryPollDelayMs: options.recoveryPollDelayMs,
                    awaitingUnbroadcastActionReport:
                      operationBeforePoll.awaitingUnbroadcastActionReport,
                  }),
              ),
      },
      now: options.now,
    });
    return "requeued";
  } catch (error) {
    const detail = summarizeError(error);
    const activeWindow = await synchronizeFundingReconciliationActiveWindow(
      pool,
      {
        operationId: lease.operationId,
        attemptCount: lease.attemptCount,
        now: options.now,
        terminalTimeoutMs: options.terminalTimeoutMs,
      },
    );
    const terminalTimeoutReached =
      activeWindow != null &&
      fundingReconciliationTerminalTimeoutReached({
        reconciliationStartedAt: activeWindow.startedAt,
        now: options.now,
        terminalTimeoutMs: options.terminalTimeoutMs,
      });
    const timeoutRecoveryRequired = terminalTimeoutReached
      ? await markFundingOperationRecoveryRequired(pool, {
          operationId: lease.operationId,
          errorCode: FUNDING_RECONCILIATION_TIMEOUT_ERROR_CODE,
          recoveryMode: "automatic_evidence",
          now: options.now,
        })
      : false;
    if (timeoutRecoveryRequired) {
      await finishFundingReconciliationLease(pool, {
        jobId: lease.jobId,
        leaseOwner: lease.leaseOwner,
        leaseToken: lease.leaseToken,
        result: {
          kind: "requeue",
          dueAt: new Date(options.now.getTime() + options.recoveryPollDelayMs),
        },
        now: options.now,
      });
      return "requeued";
    }
    const maximumActiveAttemptsReached =
      activeWindow != null &&
      lease.attemptCount - activeWindow.initialAttemptCount >=
        options.maxAttempts;
    const maximumAttemptsRecoveryRequired =
      maximumActiveAttemptsReached &&
      !timeoutRecoveryRequired &&
      fundingReconciliationErrorIsNonTransient(error)
        ? await markFundingOperationRecoveryRequired(pool, {
            operationId: lease.operationId,
            errorCode: detail.code,
            recoveryMode: "manual_review",
            now: options.now,
          })
        : false;
    const deadLetter = maximumAttemptsRecoveryRequired;
    await finishFundingReconciliationLease(pool, {
      jobId: lease.jobId,
      leaseOwner: lease.leaseOwner,
      leaseToken: lease.leaseToken,
      result: {
        kind: "error",
        dueAt: new Date(options.now.getTime() + options.retryDelayMs),
        errorCode: detail.code,
        errorSummary: detail.summary,
        deadLetter,
      },
      now: options.now,
    });
    return deadLetter ? "dead_lettered" : "failed";
  }
}

export async function runFundingReconciliationBatch(
  pool: Pool,
  options: FundingReconciliationBatchOptions,
): Promise<FundingReconciliationBatchResult> {
  const requestedLimit = options.limit ?? 25;
  const limit = Number.isFinite(requestedLimit)
    ? Math.max(1, Math.min(100, Math.trunc(requestedLimit)))
    : 25;
  const requestedConcurrency = options.concurrency ?? 4;
  const concurrency = Math.max(
    1,
    Math.min(
      limit,
      Number.isFinite(requestedConcurrency)
        ? Math.trunc(requestedConcurrency)
        : 4,
    ),
  );
  const counts = {
    completed: 0,
    requeued: 0,
    failed: 0,
    deadLettered: 0,
  };
  const claimedLeases: FundingReconciliationLease[] = [];
  const processedOperationIds: string[] = [];
  while (claimedLeases.length < limit) {
    const now = options.now ?? new Date();
    const leases = await claimFundingReconciliationJobs(pool, {
      excludeOperationIds: processedOperationIds,
      leaseOwner: options.workerId,
      limit: Math.min(concurrency, limit - claimedLeases.length),
      leaseSeconds: options.leaseSeconds ?? 30,
      now,
    });
    if (leases.length === 0) break;
    claimedLeases.push(...leases);
    processedOperationIds.push(...leases.map((lease) => lease.operationId));
    const outcomes = await Promise.all(
      leases.map((lease) =>
        processLease(
          pool,
          lease,
          {
            maxAttempts: options.maxAttempts ?? 20,
            pollDelayMs: options.pollDelayMs ?? 15_000,
            idlePollDelayMs: options.idlePollDelayMs ?? 15_000,
            recoveryPollDelayMs: options.recoveryPollDelayMs ?? 60_000,
            retryDelayMs: options.retryDelayMs ?? 30_000,
            terminalTimeoutMs:
              options.terminalTimeoutMs ??
              DEFAULT_FUNDING_RECONCILIATION_TERMINAL_TIMEOUT_MS,
            now,
          },
          options.providerPoll,
          options.receiptPoll,
          options.postconditionPoll,
          options.destinationPoll,
        ),
      ),
    );
    for (const outcome of outcomes) {
      if (outcome === "dead_lettered") counts.deadLettered += 1;
      else counts[outcome] += 1;
    }
  }
  return {
    claimed: claimedLeases.length,
    ...counts,
    operationIds: claimedLeases.map((lease) => lease.operationId),
  };
}
