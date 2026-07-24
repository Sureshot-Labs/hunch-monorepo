import type { FundingCommitPlan } from "../persistence/funding-operation-repository.js";
import type {
  FundingDiscoveryRequest,
  IntentLiquidityProjection,
  JsonValue,
  MarketContextBinding,
  PlacementDecision,
  SourceOption,
} from "../domain/types.js";
import type { ResolvedDestinationCandidate } from "./destination-adapters.js";

export type PlannedSourceOption = Readonly<{
  option: SourceOption;
  commitPlan: FundingCommitPlan;
  routeId: string | null;
  providerId: string | null;
}>;

export type FundingPlanningSnapshot = Readonly<{
  request: FundingDiscoveryRequest;
  marketContext: MarketContextBinding | null;
  destination: ResolvedDestinationCandidate | null;
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
