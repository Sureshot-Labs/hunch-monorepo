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
import {
  fetchMarketsBatch,
  iterateEventPages,
  iterateEventsWithMarkets,
} from "./marketClient";
import {
  mapToUnifiedEvent,
  mapToUnifiedMarket,
  type DflowMarketSnapshot,
} from "./mappers";
import type { TDflowEvent, TDflowMarket } from "./types";
import { ensureRedis, redis } from "./redis";

type SyncCounters = {
  processedEvents: number;
  processedMarkets: number;
  pages: number;
  publishedMarkets?: number;
  publishedHotTokens?: number;
  statusMarkets?: number;
};

const STATUS_BATCH_LIMIT = 100;
const STATUS_POSITION_TOKEN_LIMIT = 200;

function byHotness(a: DflowMarketSnapshot, b: DflowMarketSnapshot): number {
  if (b.volume24h !== a.volume24h) return b.volume24h - a.volume24h;
  if (b.liquidity !== a.liquidity) return b.liquidity - a.liquidity;
  if (b.openInterest !== a.openInterest) return b.openInterest - a.openInterest;
  if (b.volumeTotal !== a.volumeTotal) return b.volumeTotal - a.volumeTotal;
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

async function fetchHotTokenIds(): Promise<string[]> {
  if (env.hotTokensMax <= 0) return [];
  await ensureRedis();

  const key = "hot:tokens:dflow";
  const cutoff = Date.now() - env.hotTokensTtlSec * 1000;
  try {
    await redis.zRemRangeByScore(key, 0, cutoff);
    return await redis.zRange(key, 0, env.hotTokensMax - 1, { REV: true });
  } catch (error) {
    log.warn("Failed to fetch hot tokens", error);
    return [];
  }
}

function stripSolanaPrefix(tokenId: string): string | null {
  if (!tokenId) return null;
  return tokenId.startsWith("sol:") ? tokenId.slice(4) : tokenId;
}

function chunkArray<T>(items: T[], size: number): T[][] {
  if (size <= 0) return [];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

async function fetchPositionTokenIds(
  limit = STATUS_POSITION_TOKEN_LIMIT,
): Promise<string[]> {
  const { rows } = await pool.query<{ token_id: string }>(
    `
      select token_id
      from (
        select token_id, max(updated_at) as updated_at
        from positions
        where venue = 'kalshi'
          and token_id like 'sol:%'
        group by token_id
      ) as recent
      order by updated_at desc nulls last
      limit $1
    `,
    [limit],
  );
  return rows.map((row) => row.token_id).filter(Boolean);
}

async function fetchMarketEventInfoByTickers(
  tickers: string[],
): Promise<Map<string, { eventId: string; eventTitle: string }>> {
  if (!tickers.length) return new Map();
  const { rows } = await pool.query<{
    venue_market_id: string;
    event_id: string;
    event_title: string;
  }>(
    `
      select m.venue_market_id, m.event_id, e.title as event_title
      from unified_markets m
      join unified_events e on e.id = m.event_id
      where m.venue = 'kalshi'
        and m.venue_market_id = any($1::text[])
    `,
    [tickers],
  );

  const map = new Map<string, { eventId: string; eventTitle: string }>();
  for (const row of rows) {
    map.set(row.venue_market_id, {
      eventId: row.event_id,
      eventTitle: row.event_title,
    });
  }
  return map;
}

function deriveNoBid(yesAsk: number | null): number | null {
  if (yesAsk == null) return null;
  return Math.max(0, 1 - yesAsk);
}

function deriveNoAsk(yesBid: number | null): number | null {
  if (yesBid == null) return null;
  return Math.max(0, 1 - yesBid);
}

async function refreshHotTokenTops(): Promise<number> {
  const tokenIds = await fetchHotTokenIds();
  if (!tokenIds.length) return 0;

  const { rows } = await pool.query<{
    token_id: string;
    side: "YES" | "NO";
    best_bid: number | null;
    best_ask: number | null;
  }>(
    `
      select t.token_id, t.side, m.best_bid, m.best_ask
      from unified_tokens t
      join unified_markets m on m.id = t.market_id
      where t.token_id = any($1::text[])
    `,
    [tokenIds],
  );

  if (!rows.length) return 0;

  const ts = new Date();
  const publish = rows
    .map((row) => {
      const yesBid = row.best_bid != null ? Number(row.best_bid) : null;
      const yesAsk = row.best_ask != null ? Number(row.best_ask) : null;
      const bestBid =
        row.side === "YES" ? yesBid : deriveNoBid(yesAsk);
      const bestAsk =
        row.side === "YES" ? yesAsk : deriveNoAsk(yesBid);
      if (bestBid == null && bestAsk == null) return null;
      return { tokenId: row.token_id, bestBid, bestAsk };
    })
    .filter(
      (row): row is { tokenId: string; bestBid: number | null; bestAsk: number | null } =>
        Boolean(row),
    );

  if (!publish.length) return 0;

  const q = new PQueue({ concurrency: 20 });
  await Promise.all(
    publish.map((row) =>
      q.add(() => publishTokenTop(row.tokenId, row.bestBid, row.bestAsk, ts)),
    ),
  );

  return publish.length;
}

export async function syncHotMarketStatuses(): Promise<{ processedMarkets: number }> {
  if (!env.dflowEnabled) return { processedMarkets: 0 };

  await ensureRedis();
  await pool.query("select 1");

  const hotTokenIds = await fetchHotTokenIds();
  const positionTokenIds = await fetchPositionTokenIds();

  const allTokenIds = Array.from(
    new Set([...hotTokenIds, ...positionTokenIds]),
  );
  if (!allTokenIds.length) return { processedMarkets: 0 };

  const mints = Array.from(
    new Set(
      allTokenIds
        .map((tokenId) => stripSolanaPrefix(tokenId))
        .filter((mint): mint is string => Boolean(mint)),
    ),
  );

  if (!mints.length) return { processedMarkets: 0 };

  const batches = chunkArray(mints, STATUS_BATCH_LIMIT);
  const markets: TDflowMarket[] = [];
  for (const batch of batches) {
    const result = await fetchMarketsBatch({ mints: batch });
    markets.push(...result);
  }

  const tickers = markets
    .map((market) => market.ticker)
    .filter((ticker): ticker is string => Boolean(ticker));
  const eventInfoByTicker = await fetchMarketEventInfoByTickers(tickers);

  const unifiedMarketRows: UnifiedMarketRow[] = [];
  const tokenRows: Array<{ token_id: string; market_id: string; side: "YES" | "NO" }> = [];

  let processedMarkets = 0;

  for (const market of markets) {
    const eventInfo = eventInfoByTicker.get(market.ticker);
    if (!eventInfo) continue;
    const mapped = mapToUnifiedMarket(
      market,
      eventInfo.eventId,
      eventInfo.eventTitle,
      env.solanaUsdcMint,
      env.requireInitialized,
    );
    if (!mapped) continue;
    unifiedMarketRows.push(mapped.marketRow);
    tokenRows.push(...mapped.tokenRows);
    processedMarkets += 1;
  }

  if (unifiedMarketRows.length) {
    await upsertUnifiedMarkets(pool, unifiedMarketRows);
  }
  if (tokenRows.length) {
    await upsertUnifiedTokens(pool, tokenRows);
  }

  log.info("DFlow hot status refresh complete", {
    tokens: allTokenIds.length,
    markets: processedMarkets,
  });

  return { processedMarkets };
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
        env.requireInitialized,
      );
      if (!mapped) continue;

      unifiedMarketRows.push(mapped.marketRow);
      tokenRows.push(...mapped.tokenRows);
      if (mapped.snapshot) snapshots.push(mapped.snapshot);
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

    if (unifiedEvent.volume_total == null && hasVolumeTotal)
      unifiedEvent.volume_total = volumeTotalSum;
    if (unifiedEvent.volume_24h == null && hasVolume24h)
      unifiedEvent.volume_24h = volume24hSum;
    if (unifiedEvent.liquidity == null && hasLiquidity)
      unifiedEvent.liquidity = liquiditySum;
    if (unifiedEvent.open_interest == null && hasOpenInterest)
      unifiedEvent.open_interest = openInterestSum;

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

  const hotTokenCount = await refreshHotTokenTops();
  if (hotTokenCount > 0) totals.publishedHotTokens = hotTokenCount;

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
