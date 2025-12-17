import PQueue from "p-queue";
import type { UnifiedEventRow, UnifiedMarketRow } from "@hunch/db";
import {
  upsertUnifiedEvents,
  upsertUnifiedMarkets,
  upsertUnifiedTokens,
  writeUnifiedBookTop,
} from "@hunch/db";

import { env } from "./env";
import {
  getDflowEventsOffset,
  resetDflowEventsOffset,
  setDflowEventsOffset,
} from "./cursor";
import { pool } from "./db";
import { log } from "./log";
import { iterateEventPages, iterateEventsWithMarkets } from "./marketClient";
import {
  mapToUnifiedEvent,
  mapToUnifiedMarket,
  type DflowMarketSnapshot,
} from "./mappers";
import type { TDflowEvent } from "./types";
import { ensureRedis, redis } from "./redis";

type SyncCounters = {
  processedEvents: number;
  processedMarkets: number;
  pages: number;
  publishedMarkets?: number;
};

function byHotness(a: DflowMarketSnapshot, b: DflowMarketSnapshot): number {
  if (b.volume24h !== a.volume24h) return b.volume24h - a.volume24h;
  if (b.liquidity !== a.liquidity) return b.liquidity - a.liquidity;
  return a.marketId.localeCompare(b.marketId);
}

function buildBookSide(best: number | null) {
  return best != null ? [{ price: String(best), size: "NA" }] : [];
}

async function publishSnapshots(markets: DflowMarketSnapshot[]): Promise<void> {
  if (markets.length === 0) return;

  const q = new PQueue({ concurrency: 20 });
  const now = new Date();

  await Promise.all(
    markets.map((m) =>
      q.add(async () => {
        const ts = new Date(now);

        await Promise.all([
          publishTokenTop(m.yesTokenId, m.yesBid, m.yesAsk, ts),
          publishTokenTop(m.noTokenId, m.noBid, m.noAsk, ts),
        ]);
      }),
    ),
  );
}

async function publishTokenTop(
  tokenId: string,
  bestBid: number | null,
  bestAsk: number | null,
  ts: Date,
): Promise<void> {
  if (bestBid == null && bestAsk == null) return;

  const tick = {
    token_id: tokenId,
    best_bid: bestBid,
    best_ask: bestAsk,
    ts: ts.getTime(),
  };
  const tickJson = JSON.stringify(tick);

  const snap = {
    token_id: tokenId,
    bids: buildBookSide(bestBid),
    asks: buildBookSide(bestAsk),
    timestamp: ts.getTime().toString(),
  };

  const multi = redis.multi();
  multi.set(`book:${tokenId}`, JSON.stringify(snap), { EX: 5 });
  multi.set(`top:${tokenId}`, tickJson, { EX: 60 });
  multi.publish(`prices:${tokenId}`, tickJson);

  await Promise.all([
    writeUnifiedBookTop(pool, tokenId, bestBid, bestAsk, ts),
    multi.exec(),
  ]);
}

async function processEvents(events: TDflowEvent[]): Promise<{
  processedEvents: number;
  processedMarkets: number;
  snapshots: DflowMarketSnapshot[];
}> {
  const unifiedEventRows: UnifiedEventRow[] = [];
  const unifiedMarketRows: UnifiedMarketRow[] = [];
  const tokenRows: Array<{
    token_id: string;
    market_id: string;
    side: "YES" | "NO";
  }> = [];
  const snapshots: DflowMarketSnapshot[] = [];

  let processedEvents = 0;
  let processedMarkets = 0;

  for (const e of events) {
    const unifiedEvent = mapToUnifiedEvent(e);
    if (!unifiedEvent) continue;

    let volumeTotalSum = 0;
    let volume24hSum = 0;
    let liquiditySum = 0;
    let openInterestSum = 0;
    let hasVolumeTotal = false;
    let hasVolume24h = false;
    let hasLiquidity = false;
    let hasOpenInterest = false;

    const markets = e.markets ?? [];
    for (const m of markets) {
      const mapped = mapToUnifiedMarket(
        m,
        unifiedEvent.id,
        unifiedEvent.title,
        env.solanaUsdcMint,
      );
      if (!mapped) continue;

      unifiedMarketRows.push(mapped.marketRow);
      tokenRows.push(...mapped.tokenRows);
      snapshots.push(mapped.snapshot);
      processedMarkets += 1;

      const row = mapped.marketRow;
      if (row.volume_total != null) {
        volumeTotalSum += row.volume_total;
        hasVolumeTotal = true;
      }
      if (row.volume_24h != null) {
        volume24hSum += row.volume_24h;
        hasVolume24h = true;
      }
      if (row.liquidity != null) {
        liquiditySum += row.liquidity;
        hasLiquidity = true;
      }
      if (row.open_interest != null) {
        openInterestSum += row.open_interest;
        hasOpenInterest = true;
      }
    }

    if (hasVolumeTotal) unifiedEvent.volume_total = volumeTotalSum;
    if (hasVolume24h) unifiedEvent.volume_24h = volume24hSum;
    if (hasLiquidity) unifiedEvent.liquidity = liquiditySum;
    if (hasOpenInterest) unifiedEvent.open_interest = openInterestSum;

    unifiedEventRows.push(unifiedEvent);
    processedEvents += 1;
  }

  if (unifiedEventRows.length) {
    await upsertUnifiedEvents(pool, unifiedEventRows);
  }
  if (unifiedMarketRows.length) {
    await upsertUnifiedMarkets(pool, unifiedMarketRows);
  }
  if (tokenRows.length) {
    await upsertUnifiedTokens(pool, tokenRows);
  }

  return { processedEvents, processedMarkets, snapshots };
}

async function hasAnyDflowData(): Promise<boolean> {
  const { rows } = await pool.query(
    `
      select 1
      from unified_markets
      where venue = 'kalshi'
        and (
          token_yes like 'sol:%'
          or token_no like 'sol:%'
        )
      limit 1
    `,
  );
  return rows.length > 0;
}

export async function syncHotWindow(): Promise<SyncCounters> {
  if (!env.dflowEnabled) {
    log.warn("DFlow indexer disabled", { issues: env.dflowIssues });
    return { processedEvents: 0, processedMarkets: 0, pages: 0 };
  }

  if (!env.hotEnabled) {
    log.warn("DFlow hot refresh disabled");
    return { processedEvents: 0, processedMarkets: 0, pages: 0 };
  }

  await ensureRedis();
  await pool.query("select 1");

  const totals: SyncCounters = {
    processedEvents: 0,
    processedMarkets: 0,
    pages: 0,
    publishedMarkets: 0,
  };

  const snapshotByMarketId = new Map<string, DflowMarketSnapshot>();

  for await (const events of iterateEventsWithMarkets({
    label: "hot",
    sort: env.hotSort,
    maxPages: env.hotMaxPages,
  })) {
    totals.pages += 1;
    const r = await processEvents(events);
    totals.processedEvents += r.processedEvents;
    totals.processedMarkets += r.processedMarkets;
    for (const snap of r.snapshots) snapshotByMarketId.set(snap.marketId, snap);
  }

  const snapshots = Array.from(snapshotByMarketId.values());
  snapshots.sort(byHotness);
  const hot = snapshots.slice(0, env.topBookSnapshot);
  await publishSnapshots(hot);
  totals.publishedMarkets = hot.length;

  log.info("DFlow hot refresh complete", totals);
  return totals;
}

export async function syncCatchUpFromCursor(): Promise<SyncCounters> {
  if (!env.dflowEnabled) {
    log.warn("DFlow indexer disabled", { issues: env.dflowIssues });
    return { processedEvents: 0, processedMarkets: 0, pages: 0 };
  }

  if (!env.catchupEnabled) {
    log.warn("DFlow catch-up disabled");
    return { processedEvents: 0, processedMarkets: 0, pages: 0 };
  }

  await ensureRedis();
  await pool.query("select 1");

  const hasData = await hasAnyDflowData();
  if (!hasData) await resetDflowEventsOffset();

  const cursorOffset = await getDflowEventsOffset();
  const overlap = env.overlapPages * env.pageSize;
  const startCursor = Math.max(0, cursorOffset - overlap);

  log.info("DFlow catch-up…", {
    cursorOffset,
    startCursor,
    pageSize: env.pageSize,
    overlapPages: env.overlapPages,
    maxPages: env.catchupMaxPages,
  });

  const totals: SyncCounters = {
    processedEvents: 0,
    processedMarkets: 0,
    pages: 0,
  };

  for await (const page of iterateEventPages({
    label: "catch-up",
    startCursor,
    pageSize: env.pageSize,
    maxPages: env.catchupMaxPages,
    status: "active",
    withNestedMarkets: true,
    isInitialized: env.isInitialized,
  })) {
    totals.pages += 1;
    const r = await processEvents(page.events);
    totals.processedEvents += r.processedEvents;
    totals.processedMarkets += r.processedMarkets;

    const baseCursor = page.cursor ?? 0;
    const computed = baseCursor + page.events.length;
    const nextCursor = page.nextCursor ?? computed;
    await setDflowEventsOffset(nextCursor);

    if (totals.pages % 5 === 0) {
      log.info("DFlow catch-up progress", {
        pages: totals.pages,
        events: totals.processedEvents,
        markets: totals.processedMarkets,
        cursor: nextCursor,
      });
    }
  }

  log.info("DFlow catch-up complete", totals);
  return totals;
}
