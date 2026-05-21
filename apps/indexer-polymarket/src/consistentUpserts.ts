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

const eventUpsertQueue = new PQueue({ concurrency: 1 });
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
  timings: {
    queueWaitMs: number;
    unifiedEventsMs: number;
    polymarketEventsMs: number;
    writeMs: number;
    totalMs: number;
  };
  payloadBytes: {
    unified: number;
    polymarket: number;
    total: number;
  };
};

async function timed<T>(
  run: () => Promise<T>,
): Promise<{ durationMs: number; value: T }> {
  const startedAt = Date.now();
  const value = await run();
  return { durationMs: Date.now() - startedAt, value };
}

export async function upsertEventsConsistently(
  pool: Pool,
  rows: {
    unified: UnifiedEventRow[];
    polymarket: PolymarketEventRow[];
  },
): Promise<UpsertEventsConsistentlyResult> {
  const queuedAt = Date.now();
  const payloadBytes = {
    unified: Buffer.byteLength(JSON.stringify(rows.unified)),
    polymarket: Buffer.byteLength(JSON.stringify(rows.polymarket)),
    total: 0,
  };
  payloadBytes.total = payloadBytes.unified + payloadBytes.polymarket;

  const result = await eventUpsertQueue.add(async () => {
    const writeStartedAt = Date.now();
    const queueWaitMs = writeStartedAt - queuedAt;
    const unified = await timed(() => upsertUnifiedEvents(pool, rows.unified));
    const polymarket = await timed(() =>
      upsertPolymarketEvents(rows.polymarket),
    );
    const writeMs = Date.now() - writeStartedAt;

    return {
      unified: unified.value,
      polymarket: polymarket.value,
      timings: {
        queueWaitMs,
        unifiedEventsMs: unified.durationMs,
        polymarketEventsMs: polymarket.durationMs,
        writeMs,
        totalMs: Date.now() - queuedAt,
      },
      payloadBytes,
    };
  });

  if (!result) {
    throw new Error("Polymarket event upsert queue returned no result");
  }
  return result;
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
