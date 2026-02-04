import { chunkArray } from "@hunch/shared";
import PQueue from "p-queue";
import type { UnifiedEventRow, UnifiedMarketRow } from "@hunch/db";
import {
  buildTopMarketsText,
  enqueueEmbedItems,
  type EmbedQueueItem,
} from "@hunch/infra";
import {
  upsertUnifiedEvents,
  upsertUnifiedMarkets,
  upsertUnifiedTokens,
  writeUnifiedBookTop,
  writeUnifiedLastTrade,
} from "@hunch/db";

import { env } from "./env.js";
import {
  getDflowEventsOffset,
  resetDflowEventsOffset,
  setDflowEventsOffset,
} from "./cursor.js";
import { pool } from "./db.js";
import { log } from "./log.js";
import {
  fetchMarketsBatch,
  iterateEventPages,
  iterateEventsWithMarkets,
} from "./marketClient.js";
import { fetchTradesByMint, type TDflowTrade } from "./tradesClient.js";
import {
  mapToUnifiedEvent,
  mapToUnifiedMarket,
  type DflowMarketSnapshot,
} from "./mappers.js";
import type { TDflowEvent, TDflowMarket } from "./types.js";
import { ensureRedis, redis } from "./redis.js";
import { getSeriesLookup, type DflowSeriesInfo } from "./seriesClient.js";

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
const TRADE_MIN_SIZE = 1e-9;

type TradeSide = "BUY" | "SELL";

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

function splitBudget(total: number, hotShare: number): { hotBudget: number } {
  const clampedShare = Math.max(0, Math.min(1, hotShare));
  const hotBudget = Math.max(0, Math.min(total, Math.round(total * clampedShare)));
  return { hotBudget };
}

function stripSolanaPrefix(tokenId: string): string | null {
  if (!tokenId) return null;
  return tokenId.startsWith("sol:") ? tokenId.slice(4) : tokenId;
}

function parseTradeNumber(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeTradeSide(value: unknown): TradeSide | null {
  if (typeof value !== "string") return null;
  const lower = value.toLowerCase();
  if (lower.includes("buy")) return "BUY";
  if (lower.includes("sell")) return "SELL";
  return null;
}

function parseTradeTimestamp(value: unknown): Date | null {
  const n = parseTradeNumber(value);
  if (n == null) return null;
  const ms = n < 1e12 ? n * 1000 : n;
  const ts = new Date(ms);
  return Number.isNaN(ts.getTime()) ? null : ts;
}

function pickTradePrice(
  trade: TDflowTrade,
  tokenSide: "YES" | "NO" | null,
): number | null {
  const yesDollars = parseTradeNumber(trade.yesPriceDollars);
  const noDollars = parseTradeNumber(trade.noPriceDollars);
  const directDollars = parseTradeNumber(trade.priceDollars);
  const yes = parseTradeNumber(trade.yesPrice);
  const no = parseTradeNumber(trade.noPrice);
  const direct = parseTradeNumber(trade.price);

  const price =
    tokenSide === "YES"
      ? yesDollars ?? directDollars ?? yes ?? direct ?? null
      : tokenSide === "NO"
        ? noDollars ?? directDollars ?? no ?? direct ?? null
        : directDollars ?? yesDollars ?? noDollars ?? direct ?? yes ?? no ?? null;

  if (price == null || price < 0 || price > 1) return null;
  return price;
}

function pickTradeSize(trade: TDflowTrade): number | null {
  const count = parseTradeNumber(trade.count);
  if (count != null && count > 0) return count;
  return null;
}

async function fetchTokenSides(
  tokenIds: string[],
): Promise<Map<string, "YES" | "NO">> {
  if (!tokenIds.length) return new Map();
  const { rows } = await pool.query<{ token_id: string; side: "YES" | "NO" }>(
    `
      select token_id, side
      from unified_tokens
      where token_id = any($1::text[])
    `,
    [tokenIds],
  );
  const map = new Map<string, "YES" | "NO">();
  for (const row of rows) {
    if (row.token_id && row.side) map.set(row.token_id, row.side);
  }
  return map;
}

async function fetchLastTradeTimestamps(
  tokenIds: string[],
): Promise<Map<string, Date>> {
  if (!tokenIds.length) return new Map();
  const { rows } = await pool.query<{ token_id: string; ts: Date | null }>(
    `
      select token_id, max(ts) as ts
      from unified_last_trade
      where token_id = any($1::text[])
      group by token_id
    `,
    [tokenIds],
  );
  const map = new Map<string, Date>();
  for (const row of rows) {
    if (row.token_id && row.ts) map.set(row.token_id, row.ts);
  }
  return map;
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

async function fetchTickersForTokenIds(
  tokenIds: string[],
): Promise<string[]> {
  if (!tokenIds.length) return [];
  const { rows } = await pool.query<{
    token_id: string | null;
    venue_market_id: string | null;
  }>(
    `
      select t.token_id, m.venue_market_id
      from unified_tokens t
      join unified_markets m on m.id = t.market_id
      where t.token_id = any($1::text[])
        and t.token_id like 'sol:%'
        and m.venue = 'kalshi'
    `,
    [tokenIds],
  );

  const tokenToTicker = new Map<string, string>();
  for (const row of rows) {
    if (!row.token_id || !row.venue_market_id) continue;
    tokenToTicker.set(row.token_id, row.venue_market_id);
  }

  const out: string[] = [];
  const seen = new Set<string>();
  for (const tokenId of tokenIds) {
    const ticker = tokenToTicker.get(tokenId);
    if (!ticker || seen.has(ticker)) continue;
    seen.add(ticker);
    out.push(ticker);
  }
  return out;
}

async function fetchHotTickersOrdered(): Promise<string[]> {
  const hotTokenIds = await fetchHotTokenIds();
  const positionTokenIds = await fetchPositionTokenIds();

  const hotTickers = await fetchTickersForTokenIds(hotTokenIds);
  const positionTickers = await fetchTickersForTokenIds(positionTokenIds);

  const out = [...hotTickers];
  const seen = new Set(out);
  for (const ticker of positionTickers) {
    if (seen.has(ticker)) continue;
    seen.add(ticker);
    out.push(ticker);
  }
  return out;
}

async function fetchTopTickers(limit: number): Promise<string[]> {
  if (limit <= 0) return [];
  const limitRows = Math.max(100, limit * 2);
  const { rows } = await pool.query<{ venue_market_id: string | null }>(
    `
      select m.venue_market_id
      from unified_markets m
      where m.venue = 'kalshi'
        and m.status = 'ACTIVE'
        and m.venue_market_id is not null
      order by m.volume_24h desc nulls last,
               m.liquidity desc nulls last,
               m.open_interest desc nulls last
      limit $1
    `,
    [limitRows],
  );

  const out: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const ticker = row.venue_market_id;
    if (!ticker || seen.has(ticker)) continue;
    seen.add(ticker);
    out.push(ticker);
    if (out.length >= limit) break;
  }
  return out;
}

async function fetchTradeTokenIds(): Promise<string[]> {
  const hotTokenIds = await fetchHotTokenIds();
  const positionTokenIds = await fetchPositionTokenIds();
  const tokenIds = Array.from(new Set([...hotTokenIds, ...positionTokenIds]))
    .filter((tokenId) => tokenId.startsWith("sol:"));
  return tokenIds.slice(0, env.tradesTokenLimit);
}

export async function syncRecentTrades(): Promise<{
  tokenCount: number;
  tradeCount: number;
}> {
  if (!env.dflowEnabled) return { tokenCount: 0, tradeCount: 0 };

  const tokenIds = await fetchTradeTokenIds();
  if (!tokenIds.length) return { tokenCount: 0, tradeCount: 0 };

  const [sideMap, lastTradeMap] = await Promise.all([
    fetchTokenSides(tokenIds),
    fetchLastTradeTimestamps(tokenIds),
  ]);

  const q = new PQueue({ concurrency: env.tradesConcurrency });
  let tradeCount = 0;

  await Promise.all(
    tokenIds.map((tokenId) =>
      q.add(async () => {
        const mint = stripSolanaPrefix(tokenId);
        if (!mint) return;

        const lastTs = lastTradeMap.get(tokenId);
        const minTs =
          lastTs != null ? Math.floor(lastTs.getTime() / 1000) + 1 : undefined;

        let response;
        try {
          response = await fetchTradesByMint({
            mint,
            limit: env.tradesPerMintLimit,
            minTs,
          });
        } catch (error) {
          log.warn("DFlow trades fetch failed", { tokenId, error });
          return;
        }

        const tokenSide = sideMap.get(tokenId) ?? null;
        for (const trade of response.trades) {
          const ts = parseTradeTimestamp(trade.createdTime);
          if (!ts) continue;

          const price = pickTradePrice(trade, tokenSide);
          if (price == null) continue;

          const size = pickTradeSize(trade);
          if (size == null || size <= TRADE_MIN_SIZE) continue;

          const side = normalizeTradeSide(trade.takerSide) ?? "BUY";

          await writeUnifiedLastTrade(pool, {
            tokenId,
            venue: "kalshi",
            price,
            size,
            side,
            ts,
            txHash: trade.tradeId ?? null,
          });
          tradeCount += 1;
        }
      }),
    ),
  );

  return { tokenCount: tokenIds.length, tradeCount };
}

export async function resolveHotTickersForWs(): Promise<string[]> {
  if (!env.dflowEnabled) return [];
  await ensureRedis();
  await pool.query("select 1");
  const { hotBudget } = splitBudget(env.wsSubset, env.wsHotShare);
  const hotTickersAll = await fetchHotTickersOrdered();
  const hotTickers = hotTickersAll.slice(0, hotBudget);

  const seen = new Set(hotTickers);
  const remaining = Math.max(0, env.wsSubset - hotTickers.length);
  const topTickers = await fetchTopTickers(remaining);

  const out = [...hotTickers];
  for (const ticker of topTickers) {
    if (seen.has(ticker)) continue;
    seen.add(ticker);
    out.push(ticker);
    if (out.length >= env.wsSubset) break;
  }

  if (out.length < env.wsSubset) {
    for (const ticker of hotTickersAll) {
      if (seen.has(ticker)) continue;
      seen.add(ticker);
      out.push(ticker);
      if (out.length >= env.wsSubset) break;
    }
  }

  return out;
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

  if (unifiedMarketRows.length) {
    try {
      const eventTitleById = new Map(
        Array.from(eventInfoByTicker.values()).map((info) => [
          info.eventId,
          info.eventTitle,
        ]),
      );
      const embedMarkets: EmbedQueueItem[] = unifiedMarketRows.map((row) => ({
        entity_type: "market",
        market_id: row.id,
        venue: row.venue,
        status: row.status,
        market_title: row.title,
        event_title: eventTitleById.get(row.event_id),
        description: row.description,
        category: row.category,
        outcomes: row.outcomes,
        market_type: row.market_type,
        updated_at: row.updated_at ?? row.created_at,
        source: "dflow",
      }));
      await enqueueEmbedItems(redis, embedMarkets);
    } catch (err) {
      log.warn("DFlow embed enqueue failed", err);
    }
  }

  log.info("DFlow hot status refresh complete", {
    tokens: allTokenIds.length,
    markets: processedMarkets,
  });

  return { processedMarkets };
}

async function processEvents(
  events: TDflowEvent[],
  seriesLookup?: Map<string, DflowSeriesInfo>,
): Promise<{
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
    const unifiedEvent = mapToUnifiedEvent(e, seriesLookup);
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

  if (unifiedEventRows.length || unifiedMarketRows.length) {
    try {
      const eventTitleById = new Map(
        unifiedEventRows.map((row) => [row.id, row.title]),
      );
      const marketsByEvent = new Map<string, UnifiedMarketRow[]>();
      for (const row of unifiedMarketRows) {
        const list = marketsByEvent.get(row.event_id) ?? [];
        list.push(row);
        marketsByEvent.set(row.event_id, list);
      }
      const topMarketsByEvent = new Map<string, string>();
      for (const row of unifiedEventRows) {
        const markets = marketsByEvent.get(row.id) ?? [];
        const topMarkets = buildTopMarketsText(markets, row.title);
        if (topMarkets) topMarketsByEvent.set(row.id, topMarkets);
      }
      const embedEvents: EmbedQueueItem[] = unifiedEventRows.map((row) => ({
        entity_type: "event",
        event_id: row.id,
        venue: row.venue,
        status: row.status,
        event_title: row.title,
        top_markets: topMarketsByEvent.get(row.id),
        description: row.description,
        category: row.category,
        updated_at: row.updated_at ?? row.created_at,
        source: "dflow",
      }));
      const embedMarkets: EmbedQueueItem[] = unifiedMarketRows.map((row) => ({
        entity_type: "market",
        market_id: row.id,
        venue: row.venue,
        status: row.status,
        market_title: row.title,
        event_title: eventTitleById.get(row.event_id),
        description: row.description,
        category: row.category,
        outcomes: row.outcomes,
        market_type: row.market_type,
        updated_at: row.updated_at ?? row.created_at,
        source: "dflow",
      }));
      await enqueueEmbedItems(redis, [...embedEvents, ...embedMarkets]);
    } catch (err) {
      log.warn("DFlow embed enqueue failed", err);
    }
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
  const seriesLookup = await getSeriesLookup();

  for await (const events of iterateEventsWithMarkets({
    label: "hot",
    sort: env.hotSort,
    maxPages: env.hotMaxPages,
  })) {
    totals.pages += 1;
    const r = await processEvents(events, seriesLookup);
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

  const seriesLookup = await getSeriesLookup();

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
    const r = await processEvents(page.events, seriesLookup);
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
