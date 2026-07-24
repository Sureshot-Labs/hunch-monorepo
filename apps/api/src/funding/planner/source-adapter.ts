import type {
  FundingDiscoveryRequest,
  MarketContextBinding,
  Money,
  PlacementDecision,
} from "../domain/types.js";
import type { FundingRuntimePolicy } from "../policies/funding-policy.js";
import type {
  ResolvedDestinationCandidate,
  ResolvedRouteDestination,
} from "./destination-adapters.js";
import type { PlannedSourceOption } from "./planning-types.js";

export type FundingSourcePlanningInput = Readonly<{
  accountId: string;
  request: FundingDiscoveryRequest;
  marketContext: MarketContextBinding | null;
  destinationFacts: ResolvedDestinationCandidate | null;
  destination: ResolvedRouteDestination;
  placement: PlacementDecision;
  requiredAmount: Money;
  policy: FundingRuntimePolicy;
  policyRevision: string;
  now: Date;
}>;

/**
 * Venue/provider-specific source planning ends at this boundary. An adapter
 * returns only the shared immutable plan/step/reservation contract; the quote,
 * commit, action, receipt, and reducer core never branches on the adapter ID.
 */
export interface FundingSourceAdapter {
  readonly adapterId: string;
  list(
    input: FundingSourcePlanningInput,
  ): Promise<readonly PlannedSourceOption[]>;
}

export async function listAdaptedFundingSources(
  adapters: readonly FundingSourceAdapter[],
  input: FundingSourcePlanningInput,
): Promise<readonly PlannedSourceOption[]> {
  const results = await Promise.all(
    adapters.map((adapter) => adapter.list(input)),
  );
  return results.flat();
}
