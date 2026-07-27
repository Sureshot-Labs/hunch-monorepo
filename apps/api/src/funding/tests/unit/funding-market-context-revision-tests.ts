#!/usr/bin/env tsx

import assert from "node:assert/strict";

import { canonicalJsonHash } from "../../persistence/canonical.js";
import { canonicalMarketUpdatedAt } from "../../planner/market-context-revision.js";

const ISO = "2026-07-26T16:09:05.259Z";

assert.equal(canonicalMarketUpdatedAt(new Date(ISO)), ISO);
assert.equal(canonicalMarketUpdatedAt(ISO), ISO);
assert.equal(canonicalMarketUpdatedAt("not-a-timestamp"), null);
assert.equal(canonicalMarketUpdatedAt(new Date(Number.NaN)), null);

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
  "[funding-market-context-revision-tests] ok pg Date is canonicalized",
);
