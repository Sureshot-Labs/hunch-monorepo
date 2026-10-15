import type { GammaEventsByIdsResult } from "./gammaClient.js";
import type { TEvent } from "./types.js";

export const GAMMA_EVENT_REPAIR_KEY = "indexer:polymarket:gamma:event_repairs";
type RepairRedis = {
  zRange(key: string, start: number, stop: number): Promise<string[]>;
  zAdd(
    key: string,
    values: Array<{ score: number; value: string }>,
  ): Promise<unknown>;
  zRem(key: string, values: string[]): Promise<unknown>;
  zCard(key: string): Promise<number>;
};

// Skipped schema rows survive a completed catalog checkpoint. Rotate failed
// IDs so a malformed event cannot starve other repairs. This uses the existing
// refresh cycle and never deletes source/unified data for absent Gamma IDs.
export async function repairGammaEvents(options: {
  redis: RepairRedis;
  limit: number;
  fetchEvents: (ids: string[]) => Promise<GammaEventsByIdsResult>;
  processEvents: (events: TEvent[]) => Promise<{ processedEvents: number }>;
  now?: number;
}) {
  const ids = await options.redis.zRange(
    GAMMA_EVENT_REPAIR_KEY,
    0,
    options.limit - 1,
  );
  if (!ids.length)
    return {
      requested: 0,
      processed: 0,
      missingIds: [],
      failedIds: [],
      remaining: 0,
    };
  await options.redis.zAdd(
    GAMMA_EVENT_REPAIR_KEY,
    ids.map((value) => ({ value, score: options.now ?? Date.now() })),
  );
  const result = await options.fetchEvents(ids);
  const processed = result.events.length
    ? (await options.processEvents(result.events)).processedEvents
    : 0;
  // Successfully parsed/upserted IDs are removed by processEvents itself.
  if (result.missingIds.length)
    await options.redis.zRem(GAMMA_EVENT_REPAIR_KEY, result.missingIds);
  return {
    requested: ids.length,
    processed,
    missingIds: result.missingIds,
    failedIds: result.failedIds,
    remaining: await options.redis.zCard(GAMMA_EVENT_REPAIR_KEY),
  };
}
