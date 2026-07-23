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
  status: SegmentStatus;
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

function deriveTargetState(
  operation: FundingOperationRow,
  observations: readonly FundingObservationRow[],
): Readonly<{
  reorgBlockedByTerminalState: boolean;
  target: FundingOperationState;
}> {
  const current = operationState(operation);
  if (
    observations.some(
      (observation) =>
        observation.finalityStatus === "reorged" || !observation.canonical,
    )
  ) {
    const recovery = recoveryTargetFor(current);
    return {
      reorgBlockedByTerminalState: recovery === null,
      target: recovery ?? current,
    };
  }

  if (hasFinalObservation(observations, "refund_credit")) {
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
  if (venueReady) {
    return {
      reorgBlockedByTerminalState: false,
      target:
        operation.purpose === "trade_shortfall"
          ? { status: "ready", stage: "ready_for_consumer" }
          : { status: "completed", stage: "terminal" },
    };
  }
  if (destinationObserved) {
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
  return { reorgBlockedByTerminalState: false, target: current };
}

function deriveSegmentTargetStatus(
  current: SegmentStatus,
  observations: readonly FundingObservationRow[],
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
  if (
    hasFinalObservation(observations, "destination_credit") ||
    hasFinalObservation(observations, "venue_readiness")
  ) {
    return "succeeded";
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

async function releaseSourceReservationAfterEvidence(
  client: Pick<PoolClient, "query">,
  operationId: string,
  reason: string,
  now: Date,
): Promise<void> {
  const { rows } = await client.query<StoredReservationRow>(
    `
      select id, mode, state
      from balance_reservations
      where operation_id = $1
        and mode = 'subtract_available'
        and state = 'active'
      for update
    `,
    [operationId],
  );
  const reservation = rows[0];
  if (!reservation) return;
  await releaseFundingReservationInTransaction(client, {
    reservationId: reservation.id,
    outcomeReason: reason,
    now,
  });
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
        $9::timestamptz + interval '24 hours'
      )
      on conflict (operation_id, mode) do nothing
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

async function reduceFundingSegmentInTransaction(
  client: Pick<PoolClient, "query">,
  input: Readonly<{
    operationId: string;
    observations: readonly FundingObservationRow[];
    actualSourceAmount: JsonRecord | null;
    actualDestinationAmount: JsonRecord | null;
    now: Date;
  }>,
): Promise<void> {
  const { rows } = await client.query<StoredFundingSegmentRow>(
    `
      select id, status
      from funding_operation_segments
      where operation_id = $1
      order by ordinal
      for update
    `,
    [input.operationId],
  );
  if (rows.length === 0) return;
  if (rows.length !== 1) {
    throw new Error(
      `funding operation ${input.operationId} has ${rows.length} provider segments`,
    );
  }
  const segment = rows[0];
  if (!segment) return;
  const target = deriveSegmentTargetStatus(segment.status, input.observations);
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
        index === 0 && input.actualSourceAmount
          ? input.actualSourceAmount
          : undefined,
      actualOutput:
        index === 0 && input.actualDestinationAmount
          ? input.actualDestinationAmount
          : undefined,
      submittedAt:
        next === "submitted" || next === "refunded" ? input.now : undefined,
      settledAt:
        next === "succeeded" || next === "refunded" ? input.now : undefined,
    });
    current = next;
  }
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
  const derived = deriveTargetState(initial, observations);
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
  const now = input.now ?? new Date();
  await reduceFundingSegmentInTransaction(client, {
    operationId: initial.id,
    observations,
    actualSourceAmount,
    actualDestinationAmount,
    now,
  });
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
        index === 0 && actualSourceAmount ? actualSourceAmount : undefined,
      actualDestinationAmount:
        index === 0 && actualDestinationAmount
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
  if (sourceObserved || destinationObserved || refundObserved) {
    await releaseSourceReservationAfterEvidence(
      client,
      operation.id,
      refundObserved
        ? "refund_finalized"
        : destinationObserved
          ? "destination_finalized"
          : "source_debit_finalized",
      now,
    );
  }
  if (operation.status === "ready") {
    await ensureSettledConsumerReservation(client, operation, now);
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
): Promise<"completed" | "requeued" | "failed" | "dead_lettered"> {
  try {
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
    const outcome = await processLease(pool, lease, {
      maxAttempts: options.maxAttempts ?? 20,
      pollDelayMs: options.pollDelayMs ?? 15_000,
      retryDelayMs: options.retryDelayMs ?? 30_000,
      now,
    });
    if (outcome === "dead_lettered") counts.deadLettered += 1;
    else counts[outcome] += 1;
  }
  return {
    claimed: leases.length,
    ...counts,
    operationIds: leases.map((lease) => lease.operationId),
  };
}
