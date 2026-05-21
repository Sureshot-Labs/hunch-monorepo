import type { Pool } from "pg";
import PQueue from "p-queue";
import {
  type UnifiedEventRow,
  type UnifiedMarketRow,
  upsertUnifiedEvents,
  upsertUnifiedMarkets,
} from "@hunch/db";
import {
  type PolymarketEventRow,
  type PolymarketMarketRow,
  upsertPolymarketEvents,
  upsertPolymarketMarkets,
} from "./polymarket-repo.js";

const marketUpsertQueue = new PQueue({ concurrency: 1 });

type UpsertMarketsConsistentlyOptions = {
  unifiedBatchSize?: number;
};

export async function upsertEventsConsistently(
  pool: Pool,
  rows: {
    unified: UnifiedEventRow[];
    polymarket: PolymarketEventRow[];
  },
): Promise<void> {
  await upsertUnifiedEvents(pool, rows.unified);
  await upsertPolymarketEvents(rows.polymarket);
}

export async function upsertMarketsConsistently(
  pool: Pool,
  rows: {
    unified: UnifiedMarketRow[];
    polymarket: PolymarketMarketRow[];
  },
  options: UpsertMarketsConsistentlyOptions = {},
): Promise<void> {
  await marketUpsertQueue.add(async () => {
    // The UI and status repair script read unified_markets. Write it first so a
    // partial refresh cannot advance raw Polymarket flags while unified status
    // stays stale.
    await upsertUnifiedMarkets(pool, rows.unified, {
      batchSize: options.unifiedBatchSize,
    });
    await upsertPolymarketMarkets(rows.polymarket);
  });
}
