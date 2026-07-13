import { fetchActiveRuntimePolicy, type RuntimePolicyQuery } from "@hunch/db";
import {
  buildVenueLifecyclePolicyRevision,
  DEFAULT_VENUE_LIFECYCLE_POLICY,
  parseVenueLifecyclePolicy,
  type VenueIndexerMode,
  type VenueLifecyclePolicy,
} from "@hunch/shared";

export type DflowRuntimeModeSource =
  | "db"
  | "default"
  | "env_disabled"
  | "last_known_good";

export type DflowRuntimeMode = {
  mode: VenueIndexerMode;
  policy: VenueLifecyclePolicy;
  revision: string;
  source: DflowRuntimeModeSource;
};

let lastKnownGood: DflowRuntimeMode | null = null;

export function clearDflowRuntimeModeLastKnownGood(): void {
  lastKnownGood = null;
}

export async function resolveDflowRuntimeMode(
  db: RuntimePolicyQuery,
  options: { dflowEnabled: boolean },
): Promise<DflowRuntimeMode> {
  if (!options.dflowEnabled) {
    return {
      mode: "off",
      policy: DEFAULT_VENUE_LIFECYCLE_POLICY,
      revision: "env-disabled",
      source: "env_disabled",
    };
  }

  try {
    const row = await fetchActiveRuntimePolicy(db, "venue_lifecycle");
    if (!row) {
      const result: DflowRuntimeMode = {
        mode: DEFAULT_VENUE_LIFECYCLE_POLICY.venues.kalshi.indexerMode,
        policy: DEFAULT_VENUE_LIFECYCLE_POLICY,
        revision: buildVenueLifecyclePolicyRevision(null),
        source: "default",
      };
      lastKnownGood = result;
      return result;
    }

    const policy = parseVenueLifecyclePolicy(row.payload);
    if (!policy) {
      const result: DflowRuntimeMode = {
        mode: DEFAULT_VENUE_LIFECYCLE_POLICY.venues.kalshi.indexerMode,
        policy: DEFAULT_VENUE_LIFECYCLE_POLICY,
        revision: buildVenueLifecyclePolicyRevision(null),
        source: "default",
      };
      lastKnownGood = result;
      return result;
    }

    const result: DflowRuntimeMode = {
      mode: policy.venues.kalshi.indexerMode,
      policy,
      revision: buildVenueLifecyclePolicyRevision(row.effective_at),
      source: "db",
    };
    lastKnownGood = result;
    return result;
  } catch {
    if (lastKnownGood) {
      return { ...lastKnownGood, source: "last_known_good" };
    }
    return {
      mode: "maintenance",
      policy: DEFAULT_VENUE_LIFECYCLE_POLICY,
      revision: "defaults-v1",
      source: "default",
    };
  }
}
