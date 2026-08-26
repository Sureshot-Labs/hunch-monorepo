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
import type { ResolvedDestinationCandidate } from "./destination-adapters.js";

export type PlannedSourceOption = Readonly<{
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
  return plan.steps.every((step) => step.payerRequirement !== "user");
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
  return (
    source.option.requiredActions.length > 0 &&
    source.option.requiredActions.every(
      (action) =>
        action.actor === "user" &&
        isReceiptBearingFundingActionKind(action.kind),
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
