import { tx, type Pool, type PoolClient } from "@hunch/infra";

import {
  FUNDING_OPERATION_TRANSITIONS,
  SEGMENT_TRANSITIONS,
  isValidFundingOperationState,
  type FundingOperationState,
  type FundingStateKey,
  type SegmentStatus,
} from "../domain/transitions.js";
import type { JsonValue } from "../domain/types.js";
import {
  claimFundingReconciliationJobs,
  fetchFundingOperationForWorkerInTransaction,
  finishFundingReconciliationLease,
  listFundingObservationsForOperation,
  releaseFundingReservationInTransaction,
  transitionFundingSegmentInTransaction,
  transitionFundingOperationInTransaction,
  type FundingObservationRow,
  type FundingOperationRow,
  type FundingPersistenceError,
  type FundingReconciliationLease,
} from "../persistence/funding-operation-repository.js";

type JsonRecord = Readonly<Record<string, JsonValue>>;

export type FundingReductionResult = Readonly<{
  operationId: string;
  initialState: FundingOperationState;
  finalState: FundingOperationState;
  appliedTransitions: readonly FundingOperationState[];
  terminal: boolean;
  reorgBlockedByTerminalState: boolean;
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

type StoredFundingStepStateRow = {
  id: string;
  segment_id: string | null;
  state:
    | "planned"
    | "action_required"
    | "submitted"
    | "succeeded"
    | "reconcile_required"
    | "recovery_required"
    | "failed"
    | "cancelled";
};

function stateKey(state: FundingOperationState): FundingStateKey {
  return `${state.status}:${state.stage}`;
}

function parseStateKey(key: FundingStateKey): FundingOperationState {
  const separator = key.indexOf(":");
  return {
    status: key.slice(0, separator) as FundingOperationState["status"],
    stage: key.slice(separator + 1) as FundingOperationState["stage"],
  };
}

function findTransitionPath(
  from: FundingOperationState,
  to: FundingOperationState,
): readonly FundingOperationState[] | null {
  if (
    !isValidFundingOperationState(from) ||
    !isValidFundingOperationState(to)
  ) {
    return null;
  }
  const start = stateKey(from);
  const target = stateKey(to);
  if (start === target) return [];

  const queue: FundingStateKey[] = [start];
  const previous = new Map<FundingStateKey, FundingStateKey | null>([
    [start, null],
  ]);
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    const nextStates =
      (
        FUNDING_OPERATION_TRANSITIONS as Readonly<
          Partial<Record<FundingStateKey, readonly FundingStateKey[]>>
        >
      )[current] ?? [];
    for (const next of nextStates) {
      if (previous.has(next)) continue;
      previous.set(next, current);
      if (next === target) {
        const path: FundingStateKey[] = [];
        let cursor: FundingStateKey | null = target;
        while (cursor && cursor !== start) {
          path.push(cursor);
          cursor = previous.get(cursor) ?? null;
        }
        return path.reverse().map(parseStateKey);
      }
      queue.push(next);
    }
  }
  return null;
}

function findSegmentTransitionPath(
  from: SegmentStatus,
  to: SegmentStatus,
): readonly SegmentStatus[] | null {
  if (from === to) return [];
  const queue: SegmentStatus[] = [from];
  const previous = new Map<SegmentStatus, SegmentStatus | null>([[from, null]]);
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    for (const next of SEGMENT_TRANSITIONS[current]) {
      if (previous.has(next)) continue;
      previous.set(next, current);
      if (next === to) {
        const path: SegmentStatus[] = [];
        let cursor: SegmentStatus | null = to;
        while (cursor && cursor !== from) {
          path.push(cursor);
          cursor = previous.get(cursor) ?? null;
        }
        return path.reverse();
      }
      queue.push(next);
    }
  }
  return null;
}

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

function recoveryTargetFor(
  current: FundingOperationState,
): FundingOperationState | null {
  const candidate: FundingOperationState = {
    status: "recovery_required",
    stage: current.stage,
  };
  return isValidFundingOperationState(candidate) ? candidate : null;
}

function destinationRequiresPreparation(
  operation: FundingOperationRow,
): boolean {
  const preparation = operation.destinationTargetSnapshot.preparation;
  return preparation != null && preparation !== "none";
}

export function deriveTargetState(
  operation: FundingOperationRow,
  observations: readonly FundingObservationRow[],
  segments: readonly StoredFundingSegmentRow[],
  steps: readonly StoredFundingStepStateRow[],
): Readonly<{
  reorgBlockedByTerminalState: boolean;
  target: FundingOperationState;
}> {
  const current = operationState(operation);
  const segmentObservations = (segmentId: string) =>
    observations.filter((observation) => observation.segmentId === segmentId);
  const allSegmentsSucceeded =
    segments.length > 0 &&
    segments.every((segment) => {
      const target = deriveSegmentTargetStatus(
        segment.status,
        segmentObservations(segment.id),
        segment.quoted_min_output,
      );
      return segment.status === "succeeded" || target === "succeeded";
    });
  const allSegmentsRefunded =
    segments.length > 0 &&
    segments.every((segment) => {
      const target = deriveSegmentTargetStatus(
        segment.status,
        segmentObservations(segment.id),
        segment.quoted_min_output,
      );
      return segment.status === "refunded" || target === "refunded";
    });
  const actualDestination = sumObservationAmount(
    observations,
    new Set(["destination_credit"]),
    operation.requestedDestinationAmount,
  );
  const requestedDestination = parseMoneySnapshot(
    operation.requestedDestinationAmount,
  );
  const destinationRequirementMet =
    actualDestination != null &&
    requestedDestination != null &&
    BigInt(actualDestination.raw as string) >= BigInt(requestedDestination.raw);
  const composite = operation.planKind === "composite_route";
  const financialEvidencePresent = observations.some(
    (observation) =>
      isCanonicalFinal(observation) && observation.kind !== "venue_readiness",
  );
  const recoveryTarget = (): FundingOperationState => {
    const exact = recoveryTargetFor(current);
    if (exact) return exact;
    return {
      status: "recovery_required",
      stage: current.stage === "committed" ? "source_action" : current.stage,
    };
  };
  if (
    observations.some(
      (observation) =>
        observation.finalityStatus === "reorged" || !observation.canonical,
    )
  ) {
    const recovery = recoveryTarget();
    return {
      reorgBlockedByTerminalState: !isValidFundingOperationState(recovery),
      target: isValidFundingOperationState(recovery) ? recovery : current,
    };
  }

  if (steps.some((step) => step.state === "recovery_required")) {
    return {
      reorgBlockedByTerminalState: false,
      target: recoveryTarget(),
    };
  }
  if (steps.some((step) => step.state === "reconcile_required")) {
    const stage =
      current.stage === "committed" ? "source_action" : current.stage;
    const target: FundingOperationState = {
      status: "reconcile_required",
      stage,
    };
    return {
      reorgBlockedByTerminalState: false,
      target: isValidFundingOperationState(target) ? target : recoveryTarget(),
    };
  }
  if (
    steps.some((step) => step.state === "failed" || step.state === "cancelled")
  ) {
    return {
      reorgBlockedByTerminalState: false,
      target: financialEvidencePresent
        ? recoveryTarget()
        : {
            status: steps.some((step) => step.state === "failed")
              ? "failed"
              : "cancelled",
            stage: "terminal",
          },
    };
  }

  if (hasFinalObservation(observations, "refund_credit")) {
    if (composite && !allSegmentsRefunded) {
      const recovery = recoveryTarget();
      return {
        reorgBlockedByTerminalState: false,
        target: isValidFundingOperationState(recovery) ? recovery : current,
      };
    }
    return {
      reorgBlockedByTerminalState: false,
      target: { status: "refunded", stage: "terminal" },
    };
  }

  const venueReady = hasFinalObservation(observations, "venue_readiness");
  const destinationObserved = hasFinalObservation(
    observations,
    "destination_credit",
  );
  if (venueReady && (!composite || destinationRequirementMet)) {
    return {
      reorgBlockedByTerminalState: false,
      target:
        operation.purpose === "trade_shortfall"
          ? { status: "ready", stage: "ready_for_consumer" }
          : { status: "completed", stage: "terminal" },
    };
  }
  if (
    destinationObserved &&
    (!composite || (allSegmentsSucceeded && destinationRequirementMet))
  ) {
    if (destinationRequiresPreparation(operation)) {
      return {
        reorgBlockedByTerminalState: false,
        target: { status: "in_progress", stage: "venue_preparation" },
      };
    }
    return {
      reorgBlockedByTerminalState: false,
      target:
        operation.purpose === "trade_shortfall"
          ? { status: "ready", stage: "ready_for_consumer" }
          : { status: "completed", stage: "terminal" },
    };
  }
  if (composite && destinationObserved) {
    return {
      reorgBlockedByTerminalState: false,
      target: { status: "in_progress", stage: "routing" },
    };
  }
  if (hasFinalObservation(observations, "intermediate_transfer")) {
    return {
      reorgBlockedByTerminalState: false,
      target: { status: "in_progress", stage: "intermediate_observed" },
    };
  }
  if (
    hasFinalObservation(observations, "source_debit") ||
    hasFinalObservation(observations, "source_credit")
  ) {
    return {
      reorgBlockedByTerminalState: false,
      target: { status: "in_progress", stage: "source_observed" },
    };
  }
  if (
    steps.some(
      (step) => step.state === "submitted" || step.state === "succeeded",
    )
  ) {
    return {
      reorgBlockedByTerminalState: false,
      target: { status: "in_progress", stage: "source_action" },
    };
  }
  return { reorgBlockedByTerminalState: false, target: current };
}

export function deriveSegmentTargetStatus(
  current: SegmentStatus,
  observations: readonly FundingObservationRow[],
  quotedMinimumOutput: JsonRecord,
): SegmentStatus {
  if (
    observations.some(
      (observation) =>
        observation.finalityStatus === "reorged" || !observation.canonical,
    )
  ) {
    return findSegmentTransitionPath(current, "recovery_required")
      ? "recovery_required"
      : current;
  }
  if (hasFinalObservation(observations, "refund_credit")) return "refunded";
  if (hasFinalObservation(observations, "destination_credit")) {
    const actualOutput = sumObservationAmount(
      observations,
      new Set(["destination_credit"]),
      quotedMinimumOutput,
    );
    const minimumOutput = parseMoneySnapshot(quotedMinimumOutput);
    if (!actualOutput || !minimumOutput) {
      return findSegmentTransitionPath(current, "recovery_required")
        ? "recovery_required"
        : current;
    }
    return BigInt(actualOutput.raw as string) >= BigInt(minimumOutput.raw)
      ? "succeeded"
      : "settling";
  }
  if (hasFinalObservation(observations, "intermediate_transfer")) {
    return "settling";
  }
  if (
    hasFinalObservation(observations, "source_debit") ||
    hasFinalObservation(observations, "source_credit")
  ) {
    return "submitted";
  }
  return current;
}

type MoneySnapshot = Readonly<{
  asset: Readonly<{
    networkId: string;
    assetId: string;
    decimals: number;
  }>;
  raw: string;
}>;

function parseMoneySnapshot(value: JsonRecord | null): MoneySnapshot | null {
  if (!value || typeof value.raw !== "string") return null;
  const asset = value.asset;
  if (!asset || typeof asset !== "object" || Array.isArray(asset)) return null;
  const assetRecord = asset as Readonly<Record<string, JsonValue>>;
  const networkId = assetRecord.networkId;
  const assetId = assetRecord.assetId;
  const decimals = assetRecord.decimals;
  if (
    typeof networkId !== "string" ||
    typeof assetId !== "string" ||
    typeof decimals !== "number"
  ) {
    return null;
  }
  return {
    asset: { networkId, assetId, decimals },
    raw: value.raw,
  };
}

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
  const assetIds = new Set(selected.map((observation) => observation.assetId));
  if (networkIds.size !== 1 || assetIds.size !== 1) return null;
  const requestedMoney = parseMoneySnapshot(requested);
  const networkId = selected[0]?.networkId;
  const assetId = selected[0]?.assetId;
  if (
    !networkId ||
    !assetId ||
    !requestedMoney ||
    requestedMoney.asset.networkId !== networkId ||
    requestedMoney.asset.assetId !== assetId
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

function moneyMeetsOrExceeds(
  actual: JsonRecord | null,
  expected: JsonRecord | null,
): boolean {
  const actualMoney = parseMoneySnapshot(actual);
  const expectedMoney = parseMoneySnapshot(expected);
  return Boolean(
    actualMoney &&
    expectedMoney &&
    actualMoney.asset.networkId === expectedMoney.asset.networkId &&
    actualMoney.asset.assetId === expectedMoney.asset.assetId &&
    actualMoney.asset.decimals === expectedMoney.asset.decimals &&
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
  now: Date,
): Promise<void> {
  const { rows } = await client.query<{ id: string }>(
    `
      select reservation.id
      from balance_reservations reservation
      where reservation.operation_id = $1
        and reservation.state = 'active'
        and reservation.mode = 'subtract_available'
        and reservation.segment_id is not null
        and (
          exists (
            select 1
            from funding_operation_steps step
            where step.segment_id = reservation.segment_id
              and step.state in ('failed', 'cancelled')
          )
          or exists (
            select 1
            from funding_operation_steps step
            join funding_operation_step_attempts attempt
              on attempt.step_id = step.id
            join funding_step_receipt_observations receipt
              on receipt.attempt_id = attempt.id
             and receipt.status = 'mismatch'
            where step.segment_id = reservation.segment_id
          )
        )
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
    [operationId],
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
  client: Pick<PoolClient, "query">,
  operation: FundingOperationRow,
  now: Date,
): Promise<void> {
  if (operation.purpose !== "trade_shortfall") return;
  const destination = parseMoneySnapshot(
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
  now: Date,
): Promise<FundingOperationRow | null> {
  if (
    operation.status !== "ready" ||
    operation.progressStage !== "ready_for_consumer"
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
  await releaseFundingReservationInTransaction(client, {
    reservationId: reservation.id,
    outcomeReason: "consumer_reservation_expired",
    now,
  });
  return transitionFundingOperationInTransaction(client, {
    operationId: operation.id,
    scope: { kind: "worker" },
    expectedVersion: operation.version,
    expectedState: {
      status: operation.status,
      stage: operation.progressStage,
    },
    nextState: { status: "completed", stage: "terminal" },
    supportMetadataPatch: {
      consumerResolution: "released_to_venue_cash",
      consumerResolvedAt: now.toISOString(),
      consumerResolutionReason: "reservation_expired",
    },
    now,
  });
}

async function reconcileBoundStepsForSegment(
  client: Pick<PoolClient, "query">,
  segmentId: string,
  target: SegmentStatus,
  now: Date,
): Promise<void> {
  const stepTarget =
    target === "succeeded" || target === "refunded"
      ? "succeeded"
      : target === "failed"
        ? "failed"
        : target === "recovery_required"
          ? "recovery_required"
          : target === "reconcile_required"
            ? "reconcile_required"
            : null;
  if (!stepTarget) return;
  await client.query(
    `
      update funding_operation_steps
      set state = $2,
          updated_at = $3
      where segment_id = $1
        and state in ('submitted', 'reconcile_required')
    `,
    [segmentId, stepTarget, now],
  );
}

async function reduceFundingSegmentsInTransaction(
  client: Pick<PoolClient, "query">,
  input: Readonly<{
    operationId: string;
    observations: readonly FundingObservationRow[];
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
  for (const segment of rows) {
    const observations = input.observations.filter(
      (observation) => observation.segmentId === segment.id,
    );
    const actualInput = sumObservationAmount(
      observations,
      new Set(["source_debit", "source_credit"]),
      segment.quoted_input,
    );
    const actualOutput = sumObservationAmount(
      observations,
      new Set(["destination_credit"]),
      segment.quoted_min_output,
    );
    const target = deriveSegmentTargetStatus(
      segment.status,
      observations,
      segment.quoted_min_output,
    );
    const inputIsFinal =
      moneyMeetsOrExceeds(actualInput, segment.quoted_input) ||
      target === "succeeded" ||
      target === "refunded" ||
      target === "failed";
    const path = findSegmentTransitionPath(segment.status, target);
    if (!path) {
      throw new Error(
        `no declared funding segment transition path from ${segment.status} to ${target}`,
      );
    }
    const transitions = path.length > 0 ? path : [segment.status];
    let current = segment.status;
    for (const [index, next] of transitions.entries()) {
      await transitionFundingSegmentInTransaction(client, {
        operationId: input.operationId,
        segmentId: segment.id,
        expectedStatus: current,
        nextStatus: next,
        actualInput:
          index === 0 && inputIsFinal && actualInput ? actualInput : undefined,
        actualOutput:
          index === 0 && target === "succeeded" && actualOutput
            ? actualOutput
            : undefined,
        submittedAt:
          next === "submitted" || next === "refunded" ? input.now : undefined,
        settledAt:
          next === "succeeded" || next === "refunded" ? input.now : undefined,
      });
      current = next;
    }
    await reconcileBoundStepsForSegment(client, segment.id, target, input.now);
  }
  return rows;
}

export async function reduceFundingOperationInTransaction(
  client: PoolClient,
  input: Readonly<{ operationId: string; now?: Date }>,
): Promise<FundingReductionResult> {
  const initial = await fetchFundingOperationForWorkerInTransaction(
    client,
    input.operationId,
  );
  if (!initial) {
    throw new Error(`funding operation ${input.operationId} not found`);
  }
  const initialState = operationState(initial);
  if (!isValidFundingOperationState(initialState)) {
    throw new Error(
      `funding operation ${input.operationId} has undeclared stored state`,
    );
  }
  const observations = await listFundingObservationsForOperation(
    client,
    input.operationId,
  );
  const now = input.now ?? new Date();
  const expired = await expireSettledConsumerReservation(client, initial, now);
  if (expired) {
    const finalState = operationState(expired);
    return {
      operationId: expired.id,
      initialState,
      finalState,
      appliedTransitions: [finalState],
      terminal: true,
      reorgBlockedByTerminalState: false,
    };
  }
  const segments = await reduceFundingSegmentsInTransaction(client, {
    operationId: initial.id,
    observations,
    now,
  });
  const stepResult = await client.query<StoredFundingStepStateRow>(
    `
      select id, segment_id, state
      from funding_operation_steps
      where operation_id = $1
      order by ordinal
      for update
    `,
    [initial.id],
  );
  const derived = deriveTargetState(
    initial,
    observations,
    segments,
    stepResult.rows,
  );
  const path = findTransitionPath(initialState, derived.target);
  if (!path) {
    throw new Error(
      `no declared funding transition path from ${stateKey(initialState)} to ${stateKey(derived.target)}`,
    );
  }

  const actualSourceAmount = sumObservationAmount(
    observations,
    new Set(["source_debit", "source_credit"]),
    initial.requestedSourceAmount,
  );
  const actualDestinationAmount = sumObservationAmount(
    observations,
    new Set(["destination_credit"]),
    initial.requestedDestinationAmount,
  );
  const sourceLegsFinal = segments.every((segment) => {
    const segmentInput = sumObservationAmount(
      observations.filter(
        (observation) => observation.segmentId === segment.id,
      ),
      new Set(["source_debit", "source_credit"]),
      segment.quoted_input,
    );
    return moneyMeetsOrExceeds(segmentInput, segment.quoted_input);
  });
  const recordActualSource =
    actualSourceAmount != null &&
    (sourceLegsFinal ||
      ["completed", "refunded", "failed", "cancelled"].includes(
        derived.target.status,
      ));
  const recordActualDestination =
    actualDestinationAmount != null &&
    [
      "destination_observed",
      "venue_preparation",
      "ready_for_consumer",
      "terminal",
    ].includes(derived.target.stage);
  let operation = initial;
  const appliedTransitions: FundingOperationState[] = [];
  const steps = path.length > 0 ? path : [initialState];
  for (const [index, nextState] of steps.entries()) {
    const currentState = operationState(operation);
    operation = await transitionFundingOperationInTransaction(client, {
      operationId: operation.id,
      scope: { kind: "worker" },
      expectedVersion: operation.version,
      expectedState: currentState,
      nextState,
      actualSourceAmount:
        index === 0 && recordActualSource ? actualSourceAmount : undefined,
      actualDestinationAmount:
        index === 0 && recordActualDestination
          ? actualDestinationAmount
          : undefined,
      errorCode: derived.reorgBlockedByTerminalState
        ? "finalized_observation_reorg"
        : undefined,
      supportMetadataPatch: derived.reorgBlockedByTerminalState
        ? {
            reorgBlockedByTerminalState: true,
            reorgDetectedAt: now.toISOString(),
          }
        : undefined,
      now,
    });
    if (
      currentState.status !== nextState.status ||
      currentState.stage !== nextState.stage
    ) {
      appliedTransitions.push(nextState);
    }
  }

  const sourceObserved =
    hasFinalObservation(observations, "source_debit") ||
    hasFinalObservation(observations, "source_credit");
  const destinationObserved = hasFinalObservation(
    observations,
    "destination_credit",
  );
  const refundObserved = hasFinalObservation(observations, "refund_credit");
  const venueReady = hasFinalObservation(observations, "venue_readiness");
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
  if (venueReady && operation.planKind === "venue_preparation") {
    await releaseVenuePreparationReservationsAfterReadiness(
      client,
      operation.id,
      now,
    );
  }
  if (operation.status === "ready") {
    await ensureSettledConsumerReservation(client, operation, now);
  }
  if (operation.status === "recovery_required") {
    await releaseUnusedStoppedStepReservations(client, operation.id, now);
  }
  if (
    ["completed", "refunded", "failed", "cancelled"].includes(operation.status)
  ) {
    await releaseTerminalReservations(
      client,
      operation.id,
      operation.status,
      now,
    );
  }

  return {
    operationId: operation.id,
    initialState,
    finalState: operationState(operation),
    appliedTransitions,
    terminal: ["completed", "refunded", "failed", "cancelled"].includes(
      operation.status,
    ),
    reorgBlockedByTerminalState: derived.reorgBlockedByTerminalState,
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
  limit?: number;
  leaseSeconds?: number;
  retryDelayMs?: number;
  pollDelayMs?: number;
  maxAttempts?: number;
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
}>;

export type FundingReconciliationBatchResult = Readonly<{
  claimed: number;
  completed: number;
  requeued: number;
  failed: number;
  deadLettered: number;
  operationIds: readonly string[];
}>;

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

async function processLease(
  pool: Pool,
  lease: FundingReconciliationLease,
  options: Required<
    Pick<
      FundingReconciliationBatchOptions,
      "maxAttempts" | "pollDelayMs" | "retryDelayMs"
    >
  > &
    Readonly<{ now: Date }>,
  providerPoll?: FundingReconciliationBatchOptions["providerPoll"],
  receiptPoll?: FundingReconciliationBatchOptions["receiptPoll"],
  postconditionPoll?: FundingReconciliationBatchOptions["postconditionPoll"],
): Promise<"completed" | "requeued" | "failed" | "dead_lettered"> {
  try {
    await receiptPoll?.(lease.operationId, options.now);
    await postconditionPoll?.(lease.operationId, options.now);
    await providerPoll?.(lease.operationId, options.now);
    const reduction = await reduceFundingOperation(pool, {
      operationId: lease.operationId,
      now: options.now,
    });
    if (reduction.terminal && !reduction.reorgBlockedByTerminalState) {
      await finishFundingReconciliationLease(pool, {
        jobId: lease.jobId,
        leaseOwner: lease.leaseOwner,
        leaseToken: lease.leaseToken,
        result: { kind: "completed" },
        now: options.now,
      });
      return "completed";
    }
    await finishFundingReconciliationLease(pool, {
      jobId: lease.jobId,
      leaseOwner: lease.leaseOwner,
      leaseToken: lease.leaseToken,
      result: {
        kind: "requeue",
        dueAt: new Date(options.now.getTime() + options.pollDelayMs),
      },
      now: options.now,
    });
    return "requeued";
  } catch (error) {
    const detail = summarizeError(error);
    const deadLetter = lease.attemptCount >= options.maxAttempts;
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
  const now = options.now ?? new Date();
  const leases = await claimFundingReconciliationJobs(pool, {
    leaseOwner: options.workerId,
    limit: options.limit ?? 25,
    leaseSeconds: options.leaseSeconds ?? 30,
    now,
  });
  const counts = {
    completed: 0,
    requeued: 0,
    failed: 0,
    deadLettered: 0,
  };
  for (const lease of leases) {
    const outcome = await processLease(
      pool,
      lease,
      {
        maxAttempts: options.maxAttempts ?? 20,
        pollDelayMs: options.pollDelayMs ?? 15_000,
        retryDelayMs: options.retryDelayMs ?? 30_000,
        now,
      },
      options.providerPoll,
      options.receiptPoll,
      options.postconditionPoll,
    );
    if (outcome === "dead_lettered") counts.deadLettered += 1;
    else counts[outcome] += 1;
  }
  return {
    claimed: leases.length,
    ...counts,
    operationIds: leases.map((lease) => lease.operationId),
  };
}
