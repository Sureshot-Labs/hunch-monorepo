export type AiMarketMetricInput = {
  venue: string | null | undefined;
  volume24h: number | null | undefined;
  volumeTotal: number | null | undefined;
  liquidity: number | null | undefined;
  openInterest: number | null | undefined;
};

export type NormalizedAiMarketMetrics = {
  activityVolume: number;
  depthProxy: number;
  openInterest: number | null;
};

function numericOrZero(value: number | null | undefined): number {
  return Number.isFinite(value) ? Number(value) : 0;
}

function normalizePositiveOrNull(
  value: number | null | undefined,
): number | null {
  return numericOrZero(value) > 0 ? numericOrZero(value) : null;
}

export function normalizeAiMarketMetrics(
  input: AiMarketMetricInput,
): NormalizedAiMarketMetrics {
  const venue = (input.venue ?? "").trim().toLowerCase();
  const rawVolume24h = normalizePositiveOrNull(input.volume24h);
  const rawVolumeTotal = normalizePositiveOrNull(input.volumeTotal);
  const rawLiquidity = normalizePositiveOrNull(input.liquidity);
  const rawOpenInterest = normalizePositiveOrNull(input.openInterest);
  const activityVolume =
    rawVolume24h ?? (venue === "limitless" ? (rawVolumeTotal ?? 0) : 0);
  const depthProxy = rawLiquidity ?? rawOpenInterest ?? 0;

  return {
    activityVolume,
    depthProxy,
    openInterest: rawOpenInterest,
  };
}
