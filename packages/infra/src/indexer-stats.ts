export type IndexerStatsVenue =
  | "polymarket"
  | "dflow"
  | "limitless"
  | "hyperliquid";

export type IndexerStatsRedis = {
  get: (key: string) => Promise<string | null>;
  set: (
    key: string,
    value: string,
    options?: { EX?: number },
  ) => Promise<unknown>;
};

export type IndexerStatsPatch = Partial<{
  hotRefresh: Record<string, unknown>;
  metadataRefresh: Record<string, unknown>;
  priceRefresh: Record<string, unknown>;
  topBookSync: Record<string, unknown>;
  ws: Record<string, unknown>;
  lastError: { message: string; phase?: string; at: string } | null;
}>;

export const INDEXER_STATS_TTL_SEC = 24 * 60 * 60;

export const INDEXER_STATS_KEYS: Record<IndexerStatsVenue, string> = {
  polymarket: "indexer:stats:polymarket",
  dflow: "indexer:stats:dflow",
  limitless: "indexer:stats:limitless",
  hyperliquid: "indexer:stats:hyperliquid",
};

function parseExistingStats(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export async function updateIndexerStats(
  redis: IndexerStatsRedis,
  venue: IndexerStatsVenue,
  patch: IndexerStatsPatch,
  nowMs = Date.now(),
): Promise<void> {
  const key = INDEXER_STATS_KEYS[venue];
  const existing = parseExistingStats(await redis.get(key));
  const next = {
    ...existing,
    schemaVersion: 1,
    venue,
    updatedAt: new Date(nowMs).toISOString(),
    updatedAtMs: nowMs,
    ...patch,
  };
  await redis.set(key, JSON.stringify(next), { EX: INDEXER_STATS_TTL_SEC });
}
