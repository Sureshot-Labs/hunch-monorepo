export const FUNDING_OPERATION_STATUSES = [
  "awaiting_user",
  "awaiting_external_funds",
  "in_progress",
  "ready",
  "reconcile_required",
  "recovery_required",
  "completed",
  "refunded",
  "failed",
  "cancelled",
] as const;

export type FundingOperationStatus =
  (typeof FUNDING_OPERATION_STATUSES)[number];

export const FUNDING_PROGRESS_STAGES = [
  "committed",
  "source_action",
  "source_observed",
  "routing",
  "intermediate_observed",
  "destination_observed",
  "venue_preparation",
  "ready_for_consumer",
  "refunding",
  "terminal",
] as const;

export type FundingProgressStage = (typeof FUNDING_PROGRESS_STAGES)[number];

export type FundingOperationState = Readonly<{
  status: FundingOperationStatus;
  stage: FundingProgressStage;
}>;

export type FundingStateKey =
  `${FundingOperationStatus}:${FundingProgressStage}`;

function stateKey(state: FundingOperationState): FundingStateKey {
  return `${state.status}:${state.stage}`;
}

function defineTransitions<
  const Entries extends Readonly<
    Partial<Record<FundingStateKey, readonly FundingStateKey[]>>
  >,
>(entries: Entries): Entries {
  return entries;
}

/**
 * This is the single operation transition map. A state absent from this map is
 * invalid. Terminal states are intentionally leaf nodes; idempotent replays of
 * the exact same state are accepted by canTransitionFundingOperation.
 */
export const FUNDING_OPERATION_TRANSITIONS = defineTransitions({
  "awaiting_user:committed": [
    "awaiting_user:source_action",
    "cancelled:terminal",
  ],
  "awaiting_user:source_action": [
    "in_progress:source_action",
    "reconcile_required:source_action",
    "cancelled:terminal",
  ],
  "awaiting_external_funds:committed": [
    "awaiting_external_funds:source_action",
    "cancelled:terminal",
  ],
  "awaiting_external_funds:source_action": [
    "in_progress:source_observed",
    "reconcile_required:source_action",
    "recovery_required:source_action",
    "cancelled:terminal",
  ],
  "in_progress:committed": [
    "in_progress:source_action",
    "awaiting_user:source_action",
    "awaiting_external_funds:source_action",
  ],
  "in_progress:source_action": [
    "in_progress:source_observed",
    "reconcile_required:source_action",
    "recovery_required:source_action",
  ],
  "in_progress:source_observed": [
    "in_progress:routing",
    "in_progress:destination_observed",
    "reconcile_required:source_observed",
    "recovery_required:source_observed",
  ],
  "in_progress:routing": [
    "in_progress:intermediate_observed",
    "in_progress:destination_observed",
    "reconcile_required:routing",
    "recovery_required:routing",
  ],
  "in_progress:intermediate_observed": [
    "in_progress:routing",
    "in_progress:destination_observed",
    "reconcile_required:intermediate_observed",
    "recovery_required:intermediate_observed",
  ],
  "in_progress:destination_observed": [
    "in_progress:venue_preparation",
    "ready:ready_for_consumer",
    "completed:terminal",
    "reconcile_required:destination_observed",
    "recovery_required:destination_observed",
  ],
  "in_progress:venue_preparation": [
    "ready:ready_for_consumer",
    "reconcile_required:venue_preparation",
    "recovery_required:venue_preparation",
  ],
  "ready:ready_for_consumer": [
    "completed:terminal",
    "reconcile_required:ready_for_consumer",
    "recovery_required:ready_for_consumer",
  ],
  "reconcile_required:source_action": [
    "in_progress:source_action",
    "in_progress:source_observed",
    "recovery_required:source_action",
    "reconcile_required:refunding",
    "failed:terminal",
  ],
  "reconcile_required:source_observed": [
    "in_progress:source_observed",
    "in_progress:routing",
    "recovery_required:source_observed",
    "reconcile_required:refunding",
    "failed:terminal",
  ],
  "reconcile_required:routing": [
    "in_progress:routing",
    "in_progress:intermediate_observed",
    "in_progress:destination_observed",
    "recovery_required:routing",
    "reconcile_required:refunding",
    "failed:terminal",
  ],
  "reconcile_required:intermediate_observed": [
    "in_progress:intermediate_observed",
    "in_progress:routing",
    "in_progress:destination_observed",
    "recovery_required:intermediate_observed",
    "reconcile_required:refunding",
    "failed:terminal",
  ],
  "reconcile_required:destination_observed": [
    "in_progress:destination_observed",
    "in_progress:venue_preparation",
    "ready:ready_for_consumer",
    "completed:terminal",
    "recovery_required:destination_observed",
  ],
  "reconcile_required:venue_preparation": [
    "in_progress:venue_preparation",
    "ready:ready_for_consumer",
    "recovery_required:venue_preparation",
    "failed:terminal",
  ],
  "reconcile_required:ready_for_consumer": [
    "ready:ready_for_consumer",
    "completed:terminal",
    "recovery_required:ready_for_consumer",
  ],
  "reconcile_required:refunding": [
    "refunded:terminal",
    "recovery_required:refunding",
    "failed:terminal",
  ],
  "recovery_required:source_action": [
    "in_progress:source_action",
    "reconcile_required:source_action",
    "recovery_required:refunding",
  ],
  "recovery_required:source_observed": [
    "in_progress:source_observed",
    "reconcile_required:source_observed",
    "recovery_required:refunding",
  ],
  "recovery_required:routing": [
    "in_progress:routing",
    "reconcile_required:routing",
    "recovery_required:refunding",
  ],
  "recovery_required:intermediate_observed": [
    "in_progress:intermediate_observed",
    "reconcile_required:intermediate_observed",
    "recovery_required:refunding",
  ],
  "recovery_required:destination_observed": [
    "in_progress:destination_observed",
    "reconcile_required:destination_observed",
    "recovery_required:refunding",
  ],
  "recovery_required:venue_preparation": [
    "in_progress:venue_preparation",
    "reconcile_required:venue_preparation",
    "failed:terminal",
  ],
  "recovery_required:ready_for_consumer": [
    "ready:ready_for_consumer",
    "reconcile_required:ready_for_consumer",
  ],
  "recovery_required:refunding": [
    "reconcile_required:refunding",
    "refunded:terminal",
    "failed:terminal",
  ],
  "completed:terminal": [],
  "refunded:terminal": [],
  "failed:terminal": [],
  "cancelled:terminal": [],
} as const);

const validFundingStates = new Set<FundingStateKey>(
  Object.keys(FUNDING_OPERATION_TRANSITIONS) as FundingStateKey[],
);

export function isValidFundingOperationState(
  state: FundingOperationState,
): boolean {
  return validFundingStates.has(stateKey(state));
}

export function canTransitionFundingOperation(
  from: FundingOperationState,
  to: FundingOperationState,
): boolean {
  const fromKey = stateKey(from);
  const toKey = stateKey(to);
  if (!validFundingStates.has(fromKey) || !validFundingStates.has(toKey)) {
    return false;
  }
  if (fromKey === toKey) return true;
  const transitionMap = FUNDING_OPERATION_TRANSITIONS as Readonly<
    Partial<Record<FundingStateKey, readonly FundingStateKey[]>>
  >;
  return transitionMap[fromKey]?.includes(toKey) === true;
}

export function assertFundingOperationTransition(
  from: FundingOperationState,
  to: FundingOperationState,
): void {
  if (!canTransitionFundingOperation(from, to)) {
    throw new Error(
      `invalid funding operation transition: ${stateKey(from)} -> ${stateKey(to)}`,
    );
  }
}

export const SEGMENT_STATUSES = [
  "planned",
  "awaiting_source",
  "submitted",
  "settling",
  "succeeded",
  "reconcile_required",
  "recovery_required",
  "refunding",
  "refunded",
  "failed",
] as const;

export type SegmentStatus = (typeof SEGMENT_STATUSES)[number];

export const SEGMENT_TRANSITIONS: Readonly<
  Record<SegmentStatus, readonly SegmentStatus[]>
> = {
  planned: ["awaiting_source", "submitted", "failed"],
  awaiting_source: ["submitted", "reconcile_required", "failed"],
  submitted: ["settling", "succeeded", "reconcile_required"],
  settling: ["succeeded", "reconcile_required", "recovery_required"],
  succeeded: [],
  reconcile_required: [
    "submitted",
    "settling",
    "succeeded",
    "recovery_required",
    "refunding",
    "failed",
  ],
  recovery_required: ["reconcile_required", "refunding", "failed"],
  refunding: ["refunded", "reconcile_required", "recovery_required"],
  refunded: [],
  failed: [],
};

export function canTransitionSegment(
  from: SegmentStatus,
  to: SegmentStatus,
): boolean {
  return from === to || SEGMENT_TRANSITIONS[from].includes(to);
}
