import type { FundingCommitPlan } from "../persistence/funding-operation-repository.js";
import type {
  FundingDiscoveryRequest,
  IntentLiquidityProjection,
  JsonValue,
  MarketContextBinding,
  PlacementDecision,
  SourceOption,
  ValidatedExternalRecipient,
} from "../domain/types.js";
import { isReceiptBearingFundingActionKind } from "../domain/action-kinds.js";
import {
  isRelayHypercoreClientPair,
  RELAY_HYPERCORE_EXECUTOR,
  RELAY_HYPERCORE_AUTH,
  RELAY_HYPERCORE_SEND,
} from "../../funding-providers/relay/hypercore-operation-plan.js";
import type { ResolvedDestinationCandidate } from "./destination-adapters.js";

export type PlannedSourceOption = Readonly<{
  /** Estimated source USD by descending preference cost: external native,
   * external stable, internal native. Only used to recommend a valid plan. */
  sourcePreferenceCost?: readonly [string, string, string];
  option: SourceOption;
  commitPlan: FundingCommitPlan;
  routeId: string | null;
  providerId: string | null;
  compositeEligible?: boolean;
}>;

/**
 * Automatic composites may contain provider- or sponsor-executed steps, but
 * must never silently absorb a step that requires a wallet confirmation.
 */
export function commitPlanRunsWithoutUserWalletAction(
  plan: FundingCommitPlan,
): boolean {
  return plan.steps.every(
    (step) =>
      step.payerRequirement !== "user" &&
      // Native gas is free; the two signatures still require the user.
      step.executorId !== RELAY_HYPERCORE_EXECUTOR &&
      step.normalizedAction.handoffKind !== RELAY_HYPERCORE_AUTH &&
      step.normalizedAction.handoffKind !== RELAY_HYPERCORE_SEND &&
      step.normalizedAction.handoffKind !== "polymarket_safe_transfer",
  );
}

/**
 * Client composites are deliberately separate from automatic composites.
 * Every public action and every durable step must be a receipt-bearing action
 * that the existing web funding executor can submit; server/planned steps and
 * bare signatures are never pulled into this boundary.
 */
export function plannedSourceRunsWithClientWalletActions(
  source: PlannedSourceOption,
): boolean {
  const nativePair = isRelayHypercoreClientPair(source.commitPlan.steps);
  if (
    !nativePair &&
    source.commitPlan.steps.some(
      (step) =>
        step.executorId === RELAY_HYPERCORE_EXECUTOR ||
        step.normalizedAction.handoffKind === RELAY_HYPERCORE_AUTH ||
        step.normalizedAction.handoffKind === RELAY_HYPERCORE_SEND,
    )
  )
    return false;
  const nativeSummary =
    nativePair &&
    source.option.requiredActions.length === 2 &&
    source.option.requiredActions[0]?.kind === "signature" &&
    source.option.requiredActions[0]?.valueMoving === false &&
    source.option.requiredActions[1]?.kind === "external_handoff" &&
    source.option.requiredActions[1]?.valueMoving === true;
  if (nativePair && !nativeSummary) return false;
  return (
    source.option.requiredActions.length > 0 &&
    source.option.requiredActions.every(
      (action) =>
        action.actor === "user" &&
        (isReceiptBearingFundingActionKind(action.kind) ||
          (nativeSummary && action.kind === "signature")),
    ) &&
    source.commitPlan.steps.length > 0 &&
    source.commitPlan.steps.every(
      (step) =>
        step.state === "action_required" &&
        typeof step.normalizedAction.kind === "string" &&
        isReceiptBearingFundingActionKind(step.normalizedAction.kind),
    )
  );
}

export type FundingPlanningSnapshot = Readonly<{
  request: FundingDiscoveryRequest;
  marketContext: MarketContextBinding | null;
  destination: ResolvedDestinationCandidate | null;
  withdrawalRecipient: ValidatedExternalRecipient | null;
  placement: PlacementDecision | null;
  sources: readonly PlannedSourceOption[];
  projection: IntentLiquidityProjection;
  policyRevision: string;
  ownershipRevision: string;
}>;

export type PersistedFundingPlanningSnapshot = Readonly<{
  id: string;
  userId: string;
  request: FundingDiscoveryRequest;
  projection: IntentLiquidityProjection;
  plannerSnapshot: FundingPlanningSnapshot;
  policyVersion: number;
  policyRevision: string;
  ownershipRevision: string;
  expiresAt: Date;
  createdAt: Date;
}>;

export interface FundingPlanningStore {
  create(
    input: Readonly<{
      userId: string;
      request: FundingDiscoveryRequest;
      projection: IntentLiquidityProjection;
      plannerSnapshot: FundingPlanningSnapshot;
      policyVersion: number;
      policyRevision: string;
      ownershipRevision: string;
      expiresAt: Date;
    }>,
  ): Promise<PersistedFundingPlanningSnapshot>;
  fetchOwnedCurrent(
    input: Readonly<{
      userId: string;
      projectionId: string;
      now: Date;
    }>,
  ): Promise<PersistedFundingPlanningSnapshot | null>;
}

export function asJsonValue(value: unknown): JsonValue {
  return value as JsonValue;
}
