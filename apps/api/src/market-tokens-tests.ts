import assert from "node:assert/strict";

import { resolveMarketTokenPair } from "./lib/market-tokens.js";
import { zVenue } from "./schemas/common.js";

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

test("shared venue schema accepts Hyperliquid", () => {
  assert.equal(zVenue.parse("hyperliquid"), "hyperliquid");
});

test("resolves Hyperliquid tokens from unified YES/NO columns", () => {
  assert.deepEqual(
    resolveMarketTokenPair({
      venue: "hyperliquid",
      tokenYes: "hyperliquid:101:yes",
      tokenNo: "hyperliquid:101:no",
    }),
    {
      yes: "hyperliquid:101:yes",
      no: "hyperliquid:101:no",
    },
  );
});

test("resolves Polymarket clob token ids with unified fallback", () => {
  assert.deepEqual(
    resolveMarketTokenPair({
      venue: "polymarket",
      clobTokenIds: JSON.stringify(["101", "102"]),
      tokenYes: "fallback-yes",
      tokenNo: "fallback-no",
    }),
    { yes: "101", no: "102" },
  );

  assert.deepEqual(
    resolveMarketTokenPair({
      venue: "polymarket",
      clobTokenIds: "not-json",
      tokenYes: "fallback-yes",
      tokenNo: "fallback-no",
    }),
    { yes: "fallback-yes", no: "fallback-no" },
  );
});
