#!/usr/bin/env tsx

import assert from "node:assert/strict";

import {
  API_CACHE_WARM_FAILURE_BACKOFF_SEC,
  API_CACHE_WARM_TARGETS,
  apiCacheWarmCooldownSec,
  runApiCacheWarmTargetsSequentially,
  selectApiCacheWarmTargets,
  summarizeApiCacheWarmGroups,
} from "./services/api-cache-warm.js";

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

await test("includes discovery market-map sidebar warmer when enabled", () => {
  const selected = selectApiCacheWarmTargets({
    enabled: true,
    pollIntervalSec: 30,
    requestTimeoutMs: 10_000,
    warmFeed: false,
    warmMarketMap: true,
    warmWalletIntel: false,
  });
  assert.deepEqual(
    selected.map((target) => target.id),
    ["market_map_discovery_sidebars"],
  );
  assert.equal(
    selected[0]?.path,
    "/market-map/sidebars?venues=polymarket,kalshi,limitless&trendingLimit=5&volumeMoversLimit=5&liquidityMoversLimit=5&topMoversLimit=5&minVolume24h=1000&volumeMoversSortBy=percent&liquidityMoversSortBy=absolute&includeVolumeSparkline=true&sparklineWindowHours=48&sparklineBucketHours=2",
  );
});

await test("keeps market-map warmer independent from feed and wallet groups", () => {
  const selected = selectApiCacheWarmTargets({
    enabled: true,
    pollIntervalSec: 30,
    requestTimeoutMs: 10_000,
    warmFeed: true,
    warmMarketMap: false,
    warmWalletIntel: false,
  });
  assert.equal(
    selected.some((target) => target.group === "market_map"),
    false,
  );
  assert.ok(selected.length > 0);
  assert.ok(selected.every((target) => target.group === "feed"));
});

await test("registers market-map target in cache warm status target list", () => {
  const target = API_CACHE_WARM_TARGETS.find(
    (entry) => entry.id === "market_map_discovery_sidebars",
  );
  assert.equal(target?.group, "market_map");
  assert.equal(target?.label, "Market Map Discovery Sidebars");
});

await test("keeps normal cadence after a successful run", () => {
  assert.equal(
    apiCacheWarmCooldownSec({
      pollIntervalSec: 30,
      previousResult: "ok",
    }),
    30,
  );
});

await test("backs off partial and failed runs for at least two minutes", () => {
  for (const previousResult of ["partial", "error"]) {
    assert.equal(
      apiCacheWarmCooldownSec({ pollIntervalSec: 30, previousResult }),
      API_CACHE_WARM_FAILURE_BACKOFF_SEC,
    );
    assert.equal(
      apiCacheWarmCooldownSec({ pollIntervalSec: 180, previousResult }),
      180,
    );
  }
});

await test("runs cache-warm targets sequentially", async () => {
  const targets = API_CACHE_WARM_TARGETS.slice(0, 3);
  const executionOrder: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;

  const runs = await runApiCacheWarmTargetsSequentially(
    targets,
    async (target) => {
      executionOrder.push(`start:${target.id}`);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise<void>((resolve) => setImmediate(resolve));
      inFlight -= 1;
      executionOrder.push(`end:${target.id}`);
      return target.id;
    },
  );

  assert.equal(maxInFlight, 1);
  assert.deepEqual(
    runs.map((run) => run.result),
    targets.map((target) => target.id),
  );
  assert.deepEqual(
    executionOrder,
    targets.flatMap((target) => [`start:${target.id}`, `end:${target.id}`]),
  );
});

await test("summarizes cache hits, misses, and duration by group", () => {
  const [feedHit, feedMiss, marketMap] = API_CACHE_WARM_TARGETS;
  assert.ok(feedHit);
  assert.ok(feedMiss);
  assert.ok(marketMap);

  const groups = summarizeApiCacheWarmGroups([
    {
      target: feedHit,
      result: { ok: true, durationMs: 11, cache: "hit" },
    },
    {
      target: feedMiss,
      result: { ok: false, durationMs: 19, cache: "MISS" },
    },
    {
      target: {
        ...marketMap,
        group: "market_map",
      },
      result: { ok: true, durationMs: 7, cache: "bypass" },
    },
  ]);

  assert.deepEqual(groups.feed, {
    targetsAttempted: 2,
    targetsSucceeded: 1,
    targetsFailed: 1,
    cacheHits: 1,
    cacheMisses: 1,
    cacheOther: 0,
    durationMs: 30,
  });
  assert.deepEqual(groups.market_map, {
    targetsAttempted: 1,
    targetsSucceeded: 1,
    targetsFailed: 0,
    cacheHits: 0,
    cacheMisses: 0,
    cacheOther: 1,
    durationMs: 7,
  });
});
