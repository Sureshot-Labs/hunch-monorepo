import { pool } from "../db.js";
import type { UsdEstimate } from "../funding/domain/types.js";
import { SOLANA_NATIVE_ASSET } from "../funding/domain/network-fees.js";
import { buildAccountValueReadModel } from "./runtime-service.js";
import { createAccountValueSnapshotLoader } from "./snapshot-loader.js";
import { PythSolUsdPriceAdapter } from "./pyth-sol-usd-price-adapter.js";
import { PYTH_SOL_USD_PRICE_POLICY_ID } from "./valuation-service.js";

const pythSolUsdPriceAdapter = new PythSolUsdPriceAdapter();
const accountValuePriceAdapters = [pythSolUsdPriceAdapter] as const;

/** API-only display estimate; execution never consumes this price. */
export function estimateNativeSolUsd(raw: string): Promise<UsdEstimate | null> {
  return pythSolUsdPriceAdapter.value({
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
