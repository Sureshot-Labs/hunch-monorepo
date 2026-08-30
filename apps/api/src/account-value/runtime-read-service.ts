import { logger } from "@hunch/shared";

import { pool } from "../db.js";
import type { UsdEstimate } from "../funding/domain/types.js";
import { SOLANA_NATIVE_ASSET } from "../funding/domain/network-fees.js";
import { discardDedicatedRedis, getDedicatedRedis } from "../redis.js";
import { createPythSolUsdLastKnownStore } from "./pyth-sol-usd-last-known-store.js";
import { buildAccountValueReadModel } from "./runtime-service.js";
import { createAccountValueSnapshotLoader } from "./snapshot-loader.js";
import {
  PythSolUsdPriceAdapter,
  PYTH_SOL_USD_ACCOUNT,
  PYTH_SOL_USD_FEED_ID,
} from "./pyth-sol-usd-price-adapter.js";
import { PYTH_SOL_USD_PRICE_POLICY_ID } from "./valuation-service.js";

const PYTH_SOL_USD_LAST_KNOWN_REDIS_KEY =
  "account-value:pyth:sol-usd:last-known:v3";
const DISPLAY_CACHE_DEADLINE_MS = 250;
const DISPLAY_CACHE_CONNECT_DEADLINE_MS = 1_000;

async function getDisplayCacheClient(resourceName: string) {
  const client = await getDedicatedRedis(resourceName, {
    connectDeadlineMs: DISPLAY_CACHE_CONNECT_DEADLINE_MS,
  });
  if (!client) return null;
  return {
    eval: (
      script: string,
      options: Readonly<{ keys: string[]; arguments: string[] }>,
    ) => client.eval(script, options),
    invalidate: () => discardDedicatedRedis(resourceName, client),
  };
}

const pythSolUsdLastKnownStore = createPythSolUsdLastKnownStore({
  cacheKey: PYTH_SOL_USD_LAST_KNOWN_REDIS_KEY,
  deadlineMs: DISPLAY_CACHE_DEADLINE_MS,
  expectedAccount: PYTH_SOL_USD_ACCOUNT,
  expectedFeedId: PYTH_SOL_USD_FEED_ID,
  getClient: () => getDisplayCacheClient("pyth-sol-usd-cache"),
  getQuarantineClient: () => getDisplayCacheClient("pyth-sol-usd-quarantine"),
});

const pythSolUsdPriceAdapter = new PythSolUsdPriceAdapter({
  lastKnownStore: pythSolUsdLastKnownStore,
  onUnavailable: ({ code }) => {
    logger.warn(
      { reasonCode: code },
      "Pyth SOL/USD display valuation is unavailable",
    );
  },
});
const accountValuePriceAdapters = [pythSolUsdPriceAdapter] as const;

/** API-only display estimate; execution never consumes this price. */
export function estimateNativeSolUsd(raw: string): Promise<UsdEstimate | null> {
  return pythSolUsdPriceAdapter.freshValue({
    amount: {
      asset: SOLANA_NATIVE_ASSET,
      raw,
    },
    observedAt: new Date().toISOString(),
    policyId: PYTH_SOL_USD_PRICE_POLICY_ID,
  });
}

export const accountValueReadService = createAccountValueSnapshotLoader(
  (userId) =>
    buildAccountValueReadModel({
      pool,
      userId,
      additionalPriceAdapters: accountValuePriceAdapters,
    }),
  { maxEntries: 500, ttlMs: 2_000 },
);
