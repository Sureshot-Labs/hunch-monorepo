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
// Observation only: retain queue behavior and measure whether future
// microbatching could combine the same IDs safely.
const queuedEventIds = new Map<string, number>();
const queuedMarketIds = new Map<string, number>();

function reserveQueuedIds(
  counts: Map<string, number>,
  rawIds: readonly string[],
): { overlappingRows: number; release: () => void } {
  const ids = [...new Set(rawIds)];
  let overlappingRows = 0;
  for (const id of ids) {
    const current = counts.get(id) ?? 0;
    if (current > 0) overlappingRows += 1;
    counts.set(id, current + 1);
  }
  return {
    overlappingRows,
    release: () => {
      for (const id of ids) {
        const current = counts.get(id) ?? 0;
        if (current <= 1) counts.delete(id);
        else counts.set(id, current - 1);
      }
    },
  };
}

type UpsertMarketsConsistentlyOptions = {
  unifiedBatchSize?: number;
};

export type UpsertMarketsConsistentlyResult = {
  unified: UpsertUnifiedMarketsResult;
  polymarket: PolymarketUpsertStats;
  timings: {
    queueWaitMs: number;
    unifiedMarketsMs: number;
    polymarketMarketsMs: number;
    writeMs: number;
    totalMs: number;
    queueDepthAtEnqueue: number;
    overlappingRowsAtEnqueue: number;
  };
  payloadBytes: {
    unified: number;
    polymarket: number;
    total: number;
  };
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
    queueDepthAtEnqueue: number;
    overlappingRowsAtEnqueue: number;
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
  const queueDepthAtEnqueue = eventUpsertQueue.size + eventUpsertQueue.pending;
  const reservation = reserveQueuedIds(
    queuedEventIds,
    rows.unified.map((row) => `${row.venue}:${row.venue_event_id}`),
  );
  const payloadBytes = {
    unified: Buffer.byteLength(JSON.stringify(rows.unified)),
    polymarket: Buffer.byteLength(JSON.stringify(rows.polymarket)),
    total: 0,
  };
  payloadBytes.total = payloadBytes.unified + payloadBytes.polymarket;

  try {
    const result = await eventUpsertQueue.add(async () => {
      const writeStartedAt = Date.now();
      const queueWaitMs = writeStartedAt - queuedAt;
      const unified = await timed(() =>
        upsertUnifiedEvents(pool, rows.unified),
      );
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
          queueDepthAtEnqueue,
          overlappingRowsAtEnqueue: reservation.overlappingRows,
        },
        payloadBytes,
      };
    });
    if (!result) {
      throw new Error("Polymarket event upsert queue returned no result");
    }
    return result;
  } finally {
    reservation.release();
  }
}

export async function upsertMarketsConsistently(
  pool: Pool,
  rows: {
    unified: UnifiedMarketRow[];
    polymarket: PolymarketMarketRow[];
  },
  options: UpsertMarketsConsistentlyOptions = {},
): Promise<UpsertMarketsConsistentlyResult> {
  const queuedAt = Date.now();
  const queueDepthAtEnqueue =
    marketUpsertQueue.size + marketUpsertQueue.pending;
  const reservation = reserveQueuedIds(
    queuedMarketIds,
    rows.unified.map((row) => `${row.venue}:${row.venue_market_id}`),
  );
  const payloadBytes = {
    unified: Buffer.byteLength(JSON.stringify(rows.unified)),
    polymarket: Buffer.byteLength(JSON.stringify(rows.polymarket)),
    total: 0,
  };
  payloadBytes.total = payloadBytes.unified + payloadBytes.polymarket;

  try {
    const result = await marketUpsertQueue.add(async () => {
      const writeStartedAt = Date.now();
      const queueWaitMs = writeStartedAt - queuedAt;
      // The UI and status repair script read unified_markets. Write it first so a
      // partial refresh cannot advance raw Polymarket flags while unified status
      // stays stale.
      const unified = await timed(() =>
        upsertUnifiedMarkets(pool, rows.unified, {
          batchSize: options.unifiedBatchSize,
          filterUnchanged: true,
        }),
      );
      const polymarket = await timed(() =>
        upsertPolymarketMarkets(rows.polymarket),
      );
      const writeMs = Date.now() - writeStartedAt;
      return {
        unified: unified.value,
        polymarket: polymarket.value,
        timings: {
          queueWaitMs,
          unifiedMarketsMs: unified.durationMs,
          polymarketMarketsMs: polymarket.durationMs,
          writeMs,
          totalMs: Date.now() - queuedAt,
          queueDepthAtEnqueue,
          overlappingRowsAtEnqueue: reservation.overlappingRows,
        },
        payloadBytes,
      };
    });
    if (!result) {
      throw new Error("Polymarket market upsert queue returned no result");
    }
    return result;
  } finally {
    reservation.release();
  }
}
