#!/usr/bin/env tsx

import assert from "node:assert/strict";

import { canonicalJsonHash } from "../../persistence/canonical.js";
import {
  canonicalMarketUpdatedAt,
  matchesCanonicalMarketIdentity,
} from "../../planner/market-context-revision.js";

const ISO = "2026-07-26T16:09:05.259Z";

assert.equal(canonicalMarketUpdatedAt(new Date(ISO)), ISO);
assert.equal(canonicalMarketUpdatedAt(ISO), ISO);
assert.equal(canonicalMarketUpdatedAt("not-a-timestamp"), null);
assert.equal(canonicalMarketUpdatedAt(new Date(Number.NaN)), null);
for (const identity of [
  {
    intent: { venueId: "polymarket", marketId: "polymarket:561251" },
    market: { id: "polymarket:561251", venue: "polymarket" },
  },
  {
    intent: { venueId: "limitless", marketId: "limitless:340129" },
    market: { id: "limitless:340129", venue: "limitless" },
  },
  {
    intent: {
      venueId: "future-venue",
      marketId: "future-venue:Case:Sensitive/42",
    },
    market: {
      id: "future-venue:Case:Sensitive/42",
      venue: "future-venue",
    },
  },
]) {
  assert.equal(
    matchesCanonicalMarketIdentity(identity.intent, identity.market),
    true,
  );
  assert.equal(
    matchesCanonicalMarketIdentity(
      {
        ...identity.intent,
        marketId: identity.intent.marketId.replace(
          `${identity.intent.venueId}:`,
          "",
        ),
      },
      identity.market,
    ),
    false,
  );
}
assert.equal(
  matchesCanonicalMarketIdentity(
    { venueId: "kalshi", marketId: "kalshi:kxbtc" },
    { id: "kalshi:KXBTC", venue: "kalshi" },
  ),
  false,
);

assert.doesNotThrow(() =>
  canonicalJsonHash({
    marketId: "polymarket:665374",
    side: "YES",
    status: "ACTIVE",
    acceptingOrders: true,
    updatedAt: canonicalMarketUpdatedAt(new Date(ISO)),
  }),
);

console.log(
  "[funding-market-context-revision-tests] ok pg Date and resolved market identity are canonicalized",
);
