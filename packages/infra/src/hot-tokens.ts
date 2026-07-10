import type { PriceRefreshVenue } from "./price-refresh.js";

export type HotTokenRedis = {
  zRange(
    key: string,
    start: number,
    stop: number,
    options: { REV: true },
  ): Promise<string[]>;
  zRemRangeByScore(key: string, min: number, max: number): Promise<unknown>;
};

export type SelectRecentHotTokenIdsInputs = {
  hotStreamTokensMax: number;
  hotStreamTokensTtlSec: number;
  hotTokensMax: number;
  hotTokensTtlSec: number;
  limit?: number;
  nowMs?: number;
  venue: PriceRefreshVenue;
};

export function clampHotTokenProbeLimit(limit: number): number {
  return Math.max(200, Math.min(2000, Math.trunc(limit)));
}

export async function selectRecentHotTokenIds(
  redis: HotTokenRedis,
  inputs: SelectRecentHotTokenIdsInputs,
): Promise<string[]> {
  const mergedCap = Math.max(inputs.hotTokensMax, inputs.hotStreamTokensMax);
  const resolvedLimit =
    typeof inputs.limit === "number" && Number.isFinite(inputs.limit)
      ? Math.max(0, Math.trunc(inputs.limit))
      : mergedCap;
  if (mergedCap <= 0 || resolvedLimit <= 0) return [];

  const nowMs = inputs.nowMs ?? Date.now();
  const readHotSet = async (
    key: string,
    maxTokens: number,
    ttlSec: number,
  ): Promise<string[]> => {
    const readMax = Math.min(maxTokens, resolvedLimit);
    if (readMax <= 0) return [];
    await redis.zRemRangeByScore(key, 0, nowMs - ttlSec * 1000);
    return redis.zRange(key, 0, readMax - 1, { REV: true });
  };

  const [streamIds, hotIds] = await Promise.all([
    readHotSet(
      `hot:tokens:stream:${inputs.venue}`,
      inputs.hotStreamTokensMax,
      inputs.hotStreamTokensTtlSec,
    ),
    readHotSet(
      `hot:tokens:${inputs.venue}`,
      inputs.hotTokensMax,
      inputs.hotTokensTtlSec,
    ),
  ]);

  const maxOut = Math.min(mergedCap, resolvedLimit);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const tokenId of [...streamIds, ...hotIds]) {
    if (seen.has(tokenId)) continue;
    seen.add(tokenId);
    out.push(tokenId);
    if (out.length >= maxOut) break;
  }
  return out;
}
