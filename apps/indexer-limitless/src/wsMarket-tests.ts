import assert from "node:assert/strict";

import {
  inferLimitlessResolvedOutcome,
  parseLimitlessWsTimestamp,
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
  assert.equal(
    inferLimitlessResolvedOutcome({ winningOutcomeIndex: 2 }),
    null,
  );
});

test("inferLimitlessResolvedOutcome maps explicit YES/NO labels", () => {
  assert.equal(
    inferLimitlessResolvedOutcome({ winningOutcome: "YES" }),
    "YES",
  );
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
