#!/usr/bin/env tsx

import assert from "node:assert/strict";

import {
  API_CACHE_WARM_TARGETS,
  selectApiCacheWarmTargets,
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
