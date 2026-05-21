import type { Pool } from "pg";
import PQueue from "p-queue";
import {
  type UnifiedEventRow,
  type UnifiedMarketRow,
  type UpsertUnifiedEventsResult,
  type UpsertUnifiedMarketsResult,
  upsertUnifiedEvents,
  upsertUnifiedMarkets,
} from "@hunch/db";
import {
  type PolymarketUpsertStats,
  type PolymarketEventRow,
  type PolymarketMarketRow,
  upsertPolymarketEvents,
  upsertPolymarketMarkets,
} from "./polymarket-repo.js";

const marketUpsertQueue = new PQueue({ concurrency: 1 });

type UpsertMarketsConsistentlyOptions = {
  unifiedBatchSize?: number;
};

export type UpsertMarketsConsistentlyResult = {
  unified: UpsertUnifiedMarketsResult;
  polymarket: PolymarketUpsertStats;
};

export type UpsertEventsConsistentlyResult = {
  unified: UpsertUnifiedEventsResult;
  polymarket: PolymarketUpsertStats;
};

export async function upsertEventsConsistently(
  pool: Pool,
  rows: {
    unified: UnifiedEventRow[];
    polymarket: PolymarketEventRow[];
  },
): Promise<UpsertEventsConsistentlyResult> {
  const unified = await upsertUnifiedEvents(pool, rows.unified);
  const polymarket = await upsertPolymarketEvents(rows.polymarket);
  return {
    unified,
    polymarket,
  };
}

export async function upsertMarketsConsistently(
  pool: Pool,
  rows: {
    unified: UnifiedMarketRow[];
    polymarket: PolymarketMarketRow[];
  },
  options: UpsertMarketsConsistentlyOptions = {},
): Promise<UpsertMarketsConsistentlyResult> {
  const result = await marketUpsertQueue.add(async () => {
    // The UI and status repair script read unified_markets. Write it first so a
    // partial refresh cannot advance raw Polymarket flags while unified status
    // stays stale.
    const unified = await upsertUnifiedMarkets(pool, rows.unified, {
      batchSize: options.unifiedBatchSize,
      filterUnchanged: true,
    });
    const polymarket = await upsertPolymarketMarkets(rows.polymarket);
    return {
      unified,
      polymarket,
    };
  });
  if (!result) {
    throw new Error("Polymarket market upsert queue returned no result");
  }
  return result;
}
