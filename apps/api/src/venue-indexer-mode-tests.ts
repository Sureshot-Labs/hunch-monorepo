import assert from "node:assert/strict";

import {
  DEFAULT_VENUE_LIFECYCLE_POLICY,
  filterVenuesByIndexerMode,
  venueHasIndexerMode,
  type VenueLifecyclePolicy,
} from "@hunch/shared";
import { clearVenueLifecyclePolicyCache } from "./services/runtime-policies.js";
import { resolveLiveIntelVenueScope } from "./services/venue-lifecycle.js";

const policy: VenueLifecyclePolicy = {
  ...DEFAULT_VENUE_LIFECYCLE_POLICY,
  venues: {
    ...DEFAULT_VENUE_LIFECYCLE_POLICY.venues,
    polymarket: { lifecycle: "active", indexerMode: "full" },
    limitless: { lifecycle: "active", indexerMode: "off" },
    kalshi: { lifecycle: "exit-only", indexerMode: "maintenance" },
  },
};

assert.equal(venueHasIndexerMode(policy, "polymarket", "full"), true);
assert.equal(venueHasIndexerMode(policy, "limitless", "full"), false);
assert.equal(venueHasIndexerMode(policy, "kalshi", "full"), false);
assert.equal(venueHasIndexerMode(policy, "dflow", "maintenance"), true);
assert.equal(venueHasIndexerMode(policy, "unknown", "full"), false);
assert.deepEqual(
  filterVenuesByIndexerMode(
    policy,
    ["polymarket", "dflow", "kalshi", "limitless", "unknown"],
    "maintenance",
  ),
  ["kalshi"],
);
function runtimePolicyDb(payload: unknown) {
  return {
    async query<T extends Record<string, unknown>>() {
      return {
        rows: [
          {
            id: "policy-1",
            policy_key: "venue_lifecycle",
            effective_at: new Date("2026-07-19T00:00:00.000Z"),
            payload,
            created_by: null,
            created_at: new Date("2026-07-19T00:00:00.000Z"),
          } as unknown as T,
        ],
      };
    },
  };
}

const db = runtimePolicyDb(policy);
const scope = await resolveLiveIntelVenueScope(db as never);
assert.deepEqual(scope.venues, ["polymarket"]);
assert.match(scope.revision, /^db-/);
assert.equal(scope.source, "db");

clearVenueLifecyclePolicyCache(db as never);
const invalidDb = runtimePolicyDb({ version: 1, venues: {} });
const invalidScope = await resolveLiveIntelVenueScope(invalidDb as never);
assert.deepEqual(invalidScope.venues, ["polymarket", "limitless"]);
assert.equal(invalidScope.invalidOverride, true);
clearVenueLifecyclePolicyCache();

console.log("[venue-indexer-mode-tests] passed 11/11");
