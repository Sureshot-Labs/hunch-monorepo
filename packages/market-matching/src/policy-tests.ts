import test from "node:test";
import assert from "node:assert/strict";
import {
  marketMatchingPolicySchema,
  DEFAULT_MARKET_MATCHING_POLICY,
  readMatchingPolicy,
  enabledConsumer,
  approvalRevision,
} from "./policy.js";
import type { RuntimePolicyQuery } from "@hunch/db";

function database(payload: unknown): RuntimePolicyQuery {
  return {
    query: async <T extends Record<string, unknown>>() => ({
      rows: [{ payload }] as unknown as T[],
    }),
  };
}
test("matching defaults disable every producer and consumer", () => {
  for (const [key, value] of Object.entries(DEFAULT_MARKET_MATCHING_POLICY))
    if (key.endsWith("Enabled")) assert.equal(value, false, key);
});
test("policy validates ceilings, types, relationships and unknown fields", () => {
  for (const payload of [
    { workerEnabled: "true" },
    { dailyBudgetUsd: Infinity },
    { dailyBudgetUsd: -1 },
    { lazyBudgetFraction: 1 },
    { contractProbability: 0.9 },
    { eventConfidence: 0.5 },
    { venues: ["kalshi"] },
    { venues: ["limitless", "limitless"] },
    { warmBatchSize: 100, warmTrendingCount: 100, warmLimitlessCount: 25 },
    { warmLimitlessPoolSize: 1 },
    { seedMapDepth: 26 },
    { seedWhalesDepth: 101 },
    { dailyRequests: 5 },
    { pendingInterests: 10 },
    { queuedJobs: 100 },
    { model: "unreviewed-model" },
  ])
    assert.equal(
      marketMatchingPolicySchema.safeParse(payload).success,
      false,
      JSON.stringify(payload),
    );
  assert(marketMatchingPolicySchema.safeParse({ dailyBudgetUsd: 0 }).success);
  assert(marketMatchingPolicySchema.safeParse({ dailyBudgetUsd: 10 }).success);
});
test("bad policy fails closed and env true cannot enable a disabled consumer", async () => {
  await assert.rejects(
    readMatchingPolicy(database({ unknown: true })),
    /invalid_market_matching_policy/,
  );
  const previous = process.env.MATCHING_ALTERNATIVES_ENABLED;
  try {
    process.env.MATCHING_ALTERNATIVES_ENABLED = "true";
    assert.equal(await enabledConsumer(database({}), "alternatives"), false);
    assert.equal(
      await enabledConsumer(
        database({ alternativesEnabled: true }),
        "alternatives",
      ),
      true,
    );
    process.env.MATCHING_ALTERNATIVES_ENABLED = "false";
    assert.equal(
      await enabledConsumer(
        database({ alternativesEnabled: true }),
        "alternatives",
      ),
      false,
    );
  } finally {
    if (previous === undefined)
      delete process.env.MATCHING_ALTERNATIVES_ENABLED;
    else process.env.MATCHING_ALTERNATIVES_ENABLED = previous;
  }
});
test("operational changes do not invalidate paid evidence; decision changes do", () => {
  const initial = approvalRevision(DEFAULT_MARKET_MATCHING_POLICY);
  assert.equal(
    initial,
    approvalRevision({
      ...DEFAULT_MARKET_MATCHING_POLICY,
      dailyBudgetUsd: 1,
      workerEnabled: true,
      warmTrendingCount: 10,
      warmBatchSize: 600,
      warmPrefixCount: 2000,
      seedFeedDepth: 200,
    }),
  );
  assert.notEqual(
    initial,
    approvalRevision({
      ...DEFAULT_MARKET_MATCHING_POLICY,
      contractProbability: 0.99,
    }),
  );
});
