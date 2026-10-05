import { normalizePolymarketAssetId } from "@hunch/shared";

import { isRecord } from "../lib/type-guards.js";
import { fetchPolymarketDataApiV2Pages } from "./polymarket-data-api-v2.js";

const DAY_SECONDS = 86_400;
const INTERVAL_SECONDS: Readonly<Record<string, number>> = {
  "1m": 60,
  "30m": 1800,
  "1h": 3600,
  "4h": 14400,
  "6h": 21600,
  "1d": DAY_SECONDS,
  "1w": 7 * DAY_SECONDS,
  "1M": 30 * DAY_SECONDS,
  "6m": 180 * DAY_SECONDS,
  "6M": 180 * DAY_SECONDS,
  "1Y": 365 * DAY_SECONDS,
};

export type PolymarketPriceHistoryOptions = {
  startTs?: number;
  endTs?: number;
  interval?: string;
  fidelity?: number;
};

/** Old Hunch `1m` means one minute, not V2's case-sensitive month preset.
 * Fine absolute windows must fit 15 days. Long/history windows deliberately
 * use permanent coarse data, never fine `max` which silently keeps 30 days.
 * Omit bucket_seconds for recent/old windows: the service selects a retained
 * grain rather than returning empty data for an expired requested grain.
 */
export function polymarketPriceHistoryParams(
  tokenId: string,
  options: PolymarketPriceHistoryOptions,
  nowSeconds = Math.floor(Date.now() / 1000),
): Record<string, string> {
  const assetId = normalizePolymarketAssetId(tokenId);
  if (assetId == null) throw new Error("Invalid Polymarket history asset.");
  const end = options.endTs ?? nowSeconds + 1;
  const duration = INTERVAL_SECONDS[options.interval ?? "max"];
  const start = options.startTs ?? (duration == null ? null : end - duration);
  if (
    !Number.isFinite(end) ||
    end < 0 ||
    (start != null && (!Number.isFinite(start) || start < 0 || start >= end))
  )
    throw new Error("Invalid Polymarket history window.");
  const params: Record<string, string> = { token_id: assetId, limit: "10000" };
  if (start != null && Math.ceil(end) - Math.floor(start) <= 15 * DAY_SECONDS) {
    params.start = String(Math.floor(start));
    params.end = String(Math.ceil(end));
  } else {
    params.interval = "max";
    params.bucket_seconds = "10800";
  }
  return params;
}

export type PolymarketPricePoint = {
  t: number;
  p: number;
  resolutionSeconds: number;
};

export function parsePolymarketPricePoint(row: unknown): PolymarketPricePoint {
  if (
    !isRecord(row) ||
    typeof row.timestamp !== "number" ||
    !Number.isSafeInteger(row.timestamp) ||
    row.timestamp < 0 ||
    typeof row.price !== "number" ||
    !Number.isFinite(row.price) ||
    row.price < 0 ||
    row.price > 1 ||
    typeof row.resolution_seconds !== "number" ||
    !Number.isSafeInteger(row.resolution_seconds) ||
    row.resolution_seconds < 0
  )
    throw new Error(
      "Polymarket Data API V2 returned an invalid history point.",
    );
  return {
    t: row.timestamp,
    p: row.price,
    resolutionSeconds: row.resolution_seconds,
  };
}

export async function fetchPolymarketPriceHistory(inputs: {
  baseUrl: string;
  params: Readonly<Record<string, string>>;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}): Promise<{ history: PolymarketPricePoint[] }> {
  const points = await fetchPolymarketDataApiV2Pages({
    ...inputs,
    endpoint: "prices-history",
    parseRow: parsePolymarketPricePoint,
  });
  // Pagination can overlap. Identity is the observed timestamp; retain the
  // last observation (including a final zero-resolution settlement point).
  const byTime = new Map(points.map((point) => [point.t, point]));
  return { history: [...byTime.values()].sort((a, b) => a.t - b.t) };
}
