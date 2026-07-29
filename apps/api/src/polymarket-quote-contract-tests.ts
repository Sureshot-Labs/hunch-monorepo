#!/usr/bin/env tsx

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { polymarketQuoteBodySchema } from "./schemas/polymarket-private.js";

const legacy = polymarketQuoteBodySchema.parse({
  tokenId: "123",
  side: "BUY",
  amountUsd: 1,
});
assert.equal(
  legacy.includeFundingPlan,
  true,
  "legacy quote clients must retain funding-plan previews",
);

const unified = polymarketQuoteBodySchema.parse({
  tokenId: "123",
  side: "BUY",
  amountUsd: 1,
  includeFundingPlan: false,
});
assert.equal(
  unified.includeFundingPlan,
  false,
  "unified funding clients must be able to skip duplicate RPC funding work",
);

console.log("ok - Polymarket quote funding-plan compatibility contract");

const clientSource = readFileSync(
  new URL("./services/polymarket-client.ts", import.meta.url),
  "utf8",
);
assert.doesNotMatch(
  clientSource,
  /AbortSignal\.timeout/,
  "shared Polymarket client must not crash Bun through an unhandled TimeoutError",
);

const executionSource = readFileSync(
  new URL(
    "./services/polymarket-trading-execution-service.ts",
    import.meta.url,
  ),
  "utf8",
);
assert.match(
  executionSource,
  /withinPolymarketInteractiveQuoteDeadline\(\s*quotePolymarketOrder\(/,
  "interactive quote timeout must remain inside the handled route contract",
);

console.log("ok - Polymarket quote timeout stays route-scoped");
