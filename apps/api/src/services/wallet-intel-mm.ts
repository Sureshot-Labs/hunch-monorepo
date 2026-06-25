import type { WalletIntelRefreshPolicy } from "./runtime-policies.js";

export const MM_HEDGE_RATIO_MIN = 0.6;
export const MM_TWO_SIDED_MARKETS_MIN = 3;
export const MM_MATERIAL_HEDGE_RATIO_MIN = 0.1;
export const MM_MATERIAL_HEDGED_NOTIONAL_USD_MIN = 10_000;
export const MM_LARGE_SINGLE_MARKET_HEDGED_USD_MIN = 100_000;

export type WalletMmDiagnostics = {
  exposureUsd: number;
  hedgedNotionalUsd: number;
  netImbalanceUsd: number;
  hedgeRatio: number;
  twoSidedMarkets: number;
  mmSuspected: boolean;
  thresholds: {
    hedgeRatioMin: number;
    twoSidedMarketsMin: number;
    exposureUsdMin: number;
    materialHedgeRatioMin: number;
    materialHedgedNotionalUsdMin: number;
    largeSingleMarketHedgedUsdMin: number;
  };
};

export function computeMmSuspected(inputs: {
  hedgeRatio: number | null | undefined;
  hedgedNotionalUsd: number | null | undefined;
  twoSidedMarkets: number | null | undefined;
  exposureUsd: number | null | undefined;
  chain: string | null | undefined;
  refreshPolicy: Pick<WalletIntelRefreshPolicy, "whaleUsd" | "whaleUsdSolana">;
}): boolean {
  const hedgeRatio = Math.max(0, inputs.hedgeRatio ?? 0);
  const hedgedNotionalUsd = Math.max(0, inputs.hedgedNotionalUsd ?? 0);
  const twoSidedMarkets = Math.max(0, Math.trunc(inputs.twoSidedMarkets ?? 0));
  const exposureUsd = Math.max(0, inputs.exposureUsd ?? 0);
  const exposureThreshold =
    inputs.chain === "solana"
      ? Math.max(0, inputs.refreshPolicy.whaleUsdSolana)
      : Math.max(0, inputs.refreshPolicy.whaleUsd);
  const balancedInventory =
    hedgeRatio >= MM_HEDGE_RATIO_MIN &&
    twoSidedMarkets >= MM_TWO_SIDED_MARKETS_MIN &&
    exposureUsd >= exposureThreshold;
  const materialTwoSidedHedge =
    exposureUsd >= exposureThreshold &&
    twoSidedMarkets >= 2 &&
    hedgeRatio >= MM_MATERIAL_HEDGE_RATIO_MIN &&
    hedgedNotionalUsd >= MM_MATERIAL_HEDGED_NOTIONAL_USD_MIN;
  const largeSingleMarketHedge =
    exposureUsd >= exposureThreshold &&
    twoSidedMarkets >= 1 &&
    hedgeRatio >= MM_MATERIAL_HEDGE_RATIO_MIN &&
    hedgedNotionalUsd >= MM_LARGE_SINGLE_MARKET_HEDGED_USD_MIN;
  return balancedInventory || materialTwoSidedHedge || largeSingleMarketHedge;
}

export function buildWalletMmSuspectedSql(input: {
  exposureUsdSql: string;
  hedgedNotionalUsdSql: string;
  hedgeRatioSql: string;
  twoSidedMarketsSql: string;
  exposureThresholdSql: string;
}): string {
  return `
    (
      coalesce(${input.exposureUsdSql}, 0) >= ${input.exposureThresholdSql}
      and (
        (
          coalesce(${input.hedgeRatioSql}, 0) >= ${MM_HEDGE_RATIO_MIN}
          and coalesce(${input.twoSidedMarketsSql}, 0) >= ${MM_TWO_SIDED_MARKETS_MIN}
        )
        or (
          coalesce(${input.hedgeRatioSql}, 0) >= ${MM_MATERIAL_HEDGE_RATIO_MIN}
          and coalesce(${input.twoSidedMarketsSql}, 0) >= 2
          and coalesce(${input.hedgedNotionalUsdSql}, 0) >= ${MM_MATERIAL_HEDGED_NOTIONAL_USD_MIN}
        )
        or (
          coalesce(${input.hedgeRatioSql}, 0) >= ${MM_MATERIAL_HEDGE_RATIO_MIN}
          and coalesce(${input.twoSidedMarketsSql}, 0) >= 1
          and coalesce(${input.hedgedNotionalUsdSql}, 0) >= ${MM_LARGE_SINGLE_MARKET_HEDGED_USD_MIN}
        )
      )
    )
  `;
}

export function buildWalletMmDiagnostics(inputs: {
  exposureUsd: number | null | undefined;
  hedgedNotionalUsd: number | null | undefined;
  netImbalanceUsd: number | null | undefined;
  hedgeRatio: number | null | undefined;
  twoSidedMarkets: number | null | undefined;
  chain: string | null | undefined;
  refreshPolicy: Pick<WalletIntelRefreshPolicy, "whaleUsd" | "whaleUsdSolana">;
}): WalletMmDiagnostics {
  const exposureUsd = Math.max(0, inputs.exposureUsd ?? 0);
  const hedgedNotionalUsd = Math.max(0, inputs.hedgedNotionalUsd ?? 0);
  const netImbalanceUsd = Math.max(0, inputs.netImbalanceUsd ?? 0);
  const hedgeRatio = Math.max(0, Math.min(1, inputs.hedgeRatio ?? 0));
  const twoSidedMarkets = Math.max(0, Math.trunc(inputs.twoSidedMarkets ?? 0));
  const exposureUsdMin =
    inputs.chain === "solana"
      ? Math.max(0, inputs.refreshPolicy.whaleUsdSolana)
      : Math.max(0, inputs.refreshPolicy.whaleUsd);
  return {
    exposureUsd,
    hedgedNotionalUsd,
    netImbalanceUsd,
    hedgeRatio,
    twoSidedMarkets,
    mmSuspected: computeMmSuspected({
      hedgeRatio,
      hedgedNotionalUsd,
      twoSidedMarkets,
      exposureUsd,
      chain: inputs.chain,
      refreshPolicy: inputs.refreshPolicy,
    }),
    thresholds: {
      hedgeRatioMin: MM_HEDGE_RATIO_MIN,
      twoSidedMarketsMin: MM_TWO_SIDED_MARKETS_MIN,
      exposureUsdMin,
      materialHedgeRatioMin: MM_MATERIAL_HEDGE_RATIO_MIN,
      materialHedgedNotionalUsdMin: MM_MATERIAL_HEDGED_NOTIONAL_USD_MIN,
      largeSingleMarketHedgedUsdMin: MM_LARGE_SINGLE_MARKET_HEDGED_USD_MIN,
    },
  };
}
