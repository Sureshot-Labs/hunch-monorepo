import assert from "node:assert/strict";
import { DEFAULT_HIP4_READ_POLICY, type HunchVenue } from "@hunch/shared";
import type { DbQuery } from "./db.js";
import { createDiscoveryVenueScopeResolver } from "./services/discovery-venue-scope.js";
import { VENUE_LIFECYCLE_CACHE_TTL_MS } from "./services/runtime-policies.js";

const db = {
  query: async () => {
    throw new Error("unexpected_db_query");
  },
} as DbQuery;
let reads = 0;
let now = 0;
let revision = "active-v1";
let allowed: HunchVenue[] = ["polymarket", "hyperliquid"];
let failure = false;
let environment: "mainnet" | "testnet" = "mainnet";
const resolve = createDiscoveryVenueScopeResolver({
  now: () => now,
  lifecycle: async (_db, requested) => ({
    revision,
    venues:
      requested == null
        ? allowed
        : allowed.filter((venue) => requested.includes(venue)),
  }),
  protocol: async () => {
    reads++;
    if (failure) throw new Error("policy_unavailable");
    return {
      policy: { ...DEFAULT_HIP4_READ_POLICY, enabled: true, environment },
      revision: `protocol-${environment}`,
      lifecycle: { lifecycle: "active", indexerMode: "full" },
      disabledReason: null,
    };
  },
});

await resolve(db, ["polymarket"]);
assert.equal(reads, 0, "legacy-only discovery must not read a HIP policy");
const burst = await Promise.all(
  Array.from({ length: 50 }, () => resolve(db, undefined)),
);
assert.equal(reads, 1, "concurrent feed cache hits share one protocol read");
assert.ok(burst.every((result) => result.hip4Environment === "mainnet"));
now = VENUE_LIFECYCLE_CACHE_TTL_MS - 1;
await resolve(db, undefined);
assert.equal(reads, 1);
now++;
environment = "testnet";
const switched = await resolve(db, undefined);
assert.equal(reads, 2);
assert.equal(switched.hip4Environment, "testnet");
assert.notEqual(
  switched.revision,
  burst[0].revision,
  "network changes partition response caches",
);
allowed = ["polymarket"];
revision = "disabled-v2";
assert.equal((await resolve(db, undefined)).hip4Environment, null);
assert.equal(reads, 2, "disabled HIP must not perform protocol reads");
allowed.push("hyperliquid");
revision = "active-v3";
failure = true;
await assert.rejects(resolve(db, undefined), /policy_unavailable/);
assert.equal(reads, 3);
failure = false;
assert.equal((await resolve(db, undefined)).hip4Environment, "testnet");
assert.equal(
  reads,
  4,
  "failed refresh can recover immediately, without stale cooldown",
);
console.log(
  "ok - discovery policy reads are bounded, single-flight, revision-aware and recoverable",
);
