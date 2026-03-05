import type { WalletIntelRefreshPolicy } from "./runtime-policies.js";

export const MM_HEDGE_RATIO_MIN = 0.6;
export const MM_TWO_SIDED_MARKETS_MIN = 3;

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
  };
};

export function computeMmSuspected(inputs: {
  hedgeRatio: number | null | undefined;
  twoSidedMarkets: number | null | undefined;
  exposureUsd: number | null | undefined;
  chain: string | null | undefined;
  refreshPolicy: Pick<WalletIntelRefreshPolicy, "whaleUsd" | "whaleUsdSolana">;
}): boolean {
  const hedgeRatio = Math.max(0, inputs.hedgeRatio ?? 0);
  const twoSidedMarkets = Math.max(
    0,
    Math.trunc(inputs.twoSidedMarkets ?? 0),
  );
  const exposureUsd = Math.max(0, inputs.exposureUsd ?? 0);
  const exposureThreshold =
    inputs.chain === "solana"
      ? Math.max(0, inputs.refreshPolicy.whaleUsdSolana)
      : Math.max(0, inputs.refreshPolicy.whaleUsd);
  return (
    hedgeRatio >= MM_HEDGE_RATIO_MIN &&
    twoSidedMarkets >= MM_TWO_SIDED_MARKETS_MIN &&
    exposureUsd >= exposureThreshold
  );
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
  const twoSidedMarkets = Math.max(
    0,
    Math.trunc(inputs.twoSidedMarkets ?? 0),
  );
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
      twoSidedMarkets,
      exposureUsd,
      chain: inputs.chain,
      refreshPolicy: inputs.refreshPolicy,
    }),
    thresholds: {
      hedgeRatioMin: MM_HEDGE_RATIO_MIN,
      twoSidedMarketsMin: MM_TWO_SIDED_MARKETS_MIN,
      exposureUsdMin,
    },
  };
}
