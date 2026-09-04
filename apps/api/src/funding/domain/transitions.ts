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

/**
 * Public operation cache shapes. This is deliberately a whitelist, not a
 * transition graph: the lifecycle projector derives every next shape from
 * immutable plan and durable evidence rather than from the prior cache.
 */
export const FUNDING_OPERATION_STATE_KEYS = [
  "awaiting_user:committed",
  "awaiting_user:source_action",
  "awaiting_external_funds:committed",
  "awaiting_external_funds:source_action",
  "in_progress:committed",
  "in_progress:source_action",
  "in_progress:source_observed",
  "in_progress:routing",
  "in_progress:intermediate_observed",
  "in_progress:destination_observed",
  "in_progress:venue_preparation",
  "ready:ready_for_consumer",
  "reconcile_required:source_action",
  "reconcile_required:source_observed",
  "reconcile_required:routing",
  "reconcile_required:intermediate_observed",
  "reconcile_required:destination_observed",
  "reconcile_required:venue_preparation",
  "reconcile_required:ready_for_consumer",
  "reconcile_required:refunding",
  "recovery_required:source_action",
  "recovery_required:source_observed",
  "recovery_required:routing",
  "recovery_required:intermediate_observed",
  "recovery_required:destination_observed",
  "recovery_required:venue_preparation",
  "recovery_required:ready_for_consumer",
  "recovery_required:refunding",
  "completed:terminal",
  "refunded:terminal",
  "failed:terminal",
  "cancelled:terminal",
] as const satisfies readonly FundingStateKey[];

const validFundingStates = new Set<FundingStateKey>(
  FUNDING_OPERATION_STATE_KEYS,
);

export function isValidFundingOperationState(
  state: FundingOperationState,
): boolean {
  return validFundingStates.has(stateKey(state));
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
