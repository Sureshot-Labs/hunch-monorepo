import assert from "node:assert/strict";

import { resolveTerminalTokenPrices } from "@hunch/db";

import { env } from "./env.js";
import {
  addMarketWSDemandTargets,
  inferLimitlessResolvedOutcome,
  parseLimitlessWsTimestamp,
  updateMarketWSSubscriptions,
} from "./wsMarket.js";

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

test("inferLimitlessResolvedOutcome maps winning indexes conservatively", () => {
  assert.equal(
    inferLimitlessResolvedOutcome({ winningOutcomeIndex: 0 }),
    "YES",
  );
  assert.equal(
    inferLimitlessResolvedOutcome({ winningOutcomeIndex: "1" }),
    "NO",
  );
  assert.equal(inferLimitlessResolvedOutcome({ winningOutcomeIndex: 2 }), null);
});

test("inferLimitlessResolvedOutcome maps explicit YES/NO labels", () => {
  assert.equal(inferLimitlessResolvedOutcome({ winningOutcome: "YES" }), "YES");
  assert.equal(inferLimitlessResolvedOutcome({ winningOutcome: "no" }), "NO");
  assert.equal(
    inferLimitlessResolvedOutcome({ winningOutcome: "Team Alpha" }),
    null,
  );
});

test("inferLimitlessResolvedOutcome prefers explicit index over fallback", () => {
  assert.equal(
    inferLimitlessResolvedOutcome({
      fallbackWinningOutcomeIndex: 0,
      winningOutcomeIndex: 1,
    }),
    "NO",
  );
});

test("resolveTerminalTokenPrices maps binary and scalar outcomes", () => {
  assert.deepEqual(resolveTerminalTokenPrices({ resolvedOutcome: "YES" }), {
    yes: 1,
    no: 0,
  });
  assert.deepEqual(resolveTerminalTokenPrices({ resolvedOutcome: "no" }), {
    yes: 0,
    no: 1,
  });
  assert.deepEqual(resolveTerminalTokenPrices({ resolvedOutcomePct: 2500 }), {
    yes: 0.25,
    no: 0.75,
  });
});

test("parseLimitlessWsTimestamp accepts seconds and milliseconds", () => {
  assert.equal(
    parseLimitlessWsTimestamp(1_782_595_710).toISOString(),
    new Date(1_782_595_710_000).toISOString(),
  );
  assert.equal(
    parseLimitlessWsTimestamp("1782595710000").toISOString(),
    new Date(1_782_595_710_000).toISOString(),
  );
});

test("addMarketWSDemandTargets reports subscribed and dropped demand", () => {
  updateMarketWSSubscriptions({ addresses: [], slugs: [] });
  const active = addMarketWSDemandTargets(
    { addresses: [], slugs: ["demand-active"] },
    { maxTargets: 10, ttlMs: 60_000 },
  );
  assert.equal(active.total, 1);
  assert.equal(active.subscribedTotal, 1);
  assert.equal(active.droppedBySubset, 0);

  updateMarketWSSubscriptions({
    addresses: [],
    slugs: Array.from(
      { length: Math.max(1, Math.trunc(env.wsSubset)) },
      (_, index) => `base-${index}`,
    ),
  });
  const saturated = addMarketWSDemandTargets(
    { addresses: [], slugs: ["demand-dropped"] },
    { maxTargets: 10, ttlMs: 60_000 },
  );
  assert.equal(saturated.total, 1);
  assert.equal(saturated.subscribedTotal, 0);
  assert.equal(saturated.droppedBySubset, 1);
});
