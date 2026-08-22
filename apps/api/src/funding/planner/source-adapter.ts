import type { PoolClient } from "@hunch/infra";

import type { AccountValueReadModel } from "../../account-value/runtime-service.js";
import type {
  FundingDiscoveryRequest,
  MarketContextBinding,
  Money,
  PlacementDecision,
  WalletExecutionProfile,
} from "../domain/types.js";
import { sameAccountAddress } from "../domain/asset-identity.js";
import type { FundingRuntimePolicy } from "../policies/funding-policy.js";
import type {
  ResolvedDestinationCandidate,
  ResolvedRouteDestination,
} from "./destination-adapters.js";
import type { PlannedSourceOption } from "./planning-types.js";
import type { FundingCommitPlan } from "../persistence/funding-operation-repository.js";

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
  verifyCommit?(
    client: PoolClient,
    input: Readonly<{
      userId: string;
      operation: FundingCommitPlan["operation"];
    }>,
  ): Promise<void>;
}

/**
 * An execution wrapper may name its signing wallet while accounting reserves
 * the underlying balance component. The planner freezes that exact alias in
 * `balanceLocationId`; no other location is part of the owned source.
 */
export function fundingOwnedSourceIncludesLocation(
  source: Readonly<{
    kind: string;
    location?: Readonly<{
      details: Readonly<Record<string, unknown>>;
      locationId: string;
    }>;
  }>,
  locationId: string,
): boolean {
  if (source.kind !== "owned_location" || !source.location) return false;
  const balanceLocationId = source.location.details.balanceLocationId;
  return (
    source.location.locationId === locationId ||
    (typeof balanceLocationId === "string" && balanceLocationId === locationId)
  );
}

export function fundingOwnedSourceReservationLocationId(
  source: Readonly<{
    kind: string;
    location?: Readonly<{
      details: Readonly<Record<string, unknown>>;
      locationId: string;
    }>;
  }>,
): string | null {
  if (source.kind !== "owned_location" || !source.location) return null;
  const balanceLocationId = source.location.details.balanceLocationId;
  return typeof balanceLocationId === "string"
    ? balanceLocationId
    : source.location.locationId;
}

export function findExactFundingWalletProfile(input: {
  account: AccountValueReadModel;
  walletId: string;
  networkId: string;
  address: string;
}): WalletExecutionProfile | null {
  return (
    input.account.ownership?.wallets.find(
      (profile) =>
        profile.walletId === input.walletId &&
        profile.networkId === input.networkId &&
        sameAccountAddress(input.networkId, profile.address, input.address),
    ) ?? null
  );
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

export async function verifyAdaptedFundingSourceCommit(
  adapters: readonly FundingSourceAdapter[],
  client: PoolClient,
  input: Readonly<{
    userId: string;
    operation: FundingCommitPlan["operation"];
  }>,
): Promise<void> {
  // Commit guards describe effects contained in the frozen operation, not
  // merely the source adapter that happened to discover it. A direct ingress
  // can contain a venue-preparation effect owned by another adapter.
  for (const adapter of adapters) {
    await adapter.verifyCommit?.(client, input);
  }
}
