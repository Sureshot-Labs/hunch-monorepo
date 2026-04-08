import { chunkArray } from "@hunch/shared";
import PQueue from "p-queue";
import type { UnifiedEventRow, UnifiedMarketRow } from "@hunch/db";
import {
  buildTopMarketsText,
  enqueueEmbedItems,
  createTopTickGate,
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
  getDflowEventsOffsetByStatus,
  resetDflowEventsOffset,
  resetDflowEventsOffsetByStatus,
  setDflowEventsOffset,
  setDflowEventsOffsetByStatus,
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
  type DflowMappedMarket,
} from "./mappers.js";
import type { TDflowEvent, TDflowMarket } from "./types.js";
import { ensureRedis, redis } from "./redis.js";
import { getSeriesLookup, type DflowSeriesInfo } from "./seriesClient.js";
import { fetchKalshiPublicEvents } from "./kalshiPublicClient.js";
import { applyKalshiPublicEventToMappedMarkets } from "./kalshiPublicEnrichment.js";

type SyncCounters = {
  processedEvents: number;
  processedMarkets: number;
  pages: number;
  publishedMarkets?: number;
  publishedHotTokens?: number;
  statusMarkets?: number;
};

type ProcessEventsOptions = {
  enrichKalshiPublic?: boolean;
  enrichmentContext?: string;
};

type MappedMarketGroup = {
  eventTicker: string | null;
  mappedMarkets: DflowMappedMarket[];
};

const STATUS_BATCH_LIMIT = 100;
const STATUS_POSITION_TOKEN_LIMIT = 200;
const TRADE_MIN_SIZE = 1e-9;
const topTickGate = createTopTickGate({
  onDeferredPublish: ({ tokenId, bestBid, bestAsk, tsMs }) => {
    void publishTokenTopNow(tokenId, bestBid, bestAsk, tsMs).catch((error) => {
      log.warn("Deferred top tick publish failed", {
        tokenId,
        error: String(error),
      });
    });
  },
});

type TradeSide = "BUY" | "SELL";

function logZeroMarketAnomaly(
  context: "hot" | "catch-up",
  totals: SyncCounters,
): void {
  if (totals.processedEvents <= 0 || totals.processedMarkets > 0) return;
  log.err("DFlow sync anomaly: events processed but zero markets mapped", {
    context,
    processedEvents: totals.processedEvents,
    processedMarkets: totals.processedMarkets,
    pages: totals.pages,
    requireInitialized: env.requireInitialized,
    isInitialized: env.isInitialized,
    solanaUsdcMint: env.solanaUsdcMint,
  });
}

async function reconcileKalshiEventStatuses(
  eventIds?: string[],
): Promise<number> {
  if (eventIds && eventIds.length === 0) return 0;

  const uniqueEventIds = eventIds
    ? Array.from(new Set(eventIds)).filter(Boolean)
    : undefined;
  if (eventIds && !uniqueEventIds?.length) return 0;

  const byIdsSql = `
    with target as (
      select unnest($1::text[]) as event_id
    ),
    agg as (
      select
        m.event_id,
        case
          when bool_or(m.status = 'ACTIVE') then 'ACTIVE'::unified_status
          when bool_or(m.status = 'SETTLED') then 'SETTLED'::unified_status
          when bool_or(m.status = 'CLOSED') then 'CLOSED'::unified_status
          when bool_or(m.status = 'ARCHIVED') then 'ARCHIVED'::unified_status
          else 'ACTIVE'::unified_status
        end as status
      from unified_markets m
      join target t on t.event_id = m.event_id
      where m.venue = 'kalshi'
      group by m.event_id
    )
    update unified_events e
    set status = agg.status,
        updated_at = now()
    from agg
    where e.id = agg.event_id
      and e.venue = 'kalshi'
      and e.status is distinct from agg.status
    returning e.id
  `;

  const allSql = `
    with agg as (
      select
        m.event_id,
        case
          when bool_or(m.status = 'ACTIVE') then 'ACTIVE'::unified_status
          when bool_or(m.status = 'SETTLED') then 'SETTLED'::unified_status
          when bool_or(m.status = 'CLOSED') then 'CLOSED'::unified_status
          when bool_or(m.status = 'ARCHIVED') then 'ARCHIVED'::unified_status
          else 'ACTIVE'::unified_status
        end as status
      from unified_markets m
      where m.venue = 'kalshi'
      group by m.event_id
    )
    update unified_events e
    set status = agg.status,
        updated_at = now()
    from agg
    where e.id = agg.event_id
      and e.venue = 'kalshi'
      and e.status is distinct from agg.status
    returning e.id
  `;

  const result = uniqueEventIds
    ? await pool.query(byIdsSql, [uniqueEventIds])
    : await pool.query(allSql);
  return result.rowCount ?? 0;
}

function pickDflowEventTicker(event: TDflowEvent): string | null {
  const candidates = [event.event_ticker, event.eventTicker, event.ticker, event.id];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const trimmed = candidate.trim();
    if (trimmed.length) return trimmed;
  }
  return null;
}

function pickDflowMarketEventTicker(
  market: TDflowMarket,
  fallbackEventId?: string,
): string | null {
  const raw = market as Record<string, unknown>;
  const candidates = [raw.eventTicker, raw.event_ticker, fallbackEventId];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const trimmed = candidate.trim();
    if (!trimmed.length) continue;
    if (trimmed.startsWith("kalshi:")) return trimmed.slice("kalshi:".length);
    return trimmed;
  }
  return null;
}

async function maybeEnrichKalshiMappedMarketGroups(
  groups: MappedMarketGroup[],
  context: string,
): Promise<Set<string>> {
  const enrichedEventTickers = new Set<string>();
  if (!env.kalshiPublicEnrichEnabled || !groups.length) {
    return enrichedEventTickers;
  }

  const orderedEventTickers: string[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    if (!group.eventTicker || seen.has(group.eventTicker)) continue;
    seen.add(group.eventTicker);
    orderedEventTickers.push(group.eventTicker);
  }
  if (!orderedEventTickers.length) return enrichedEventTickers;

  const fetchResult = await fetchKalshiPublicEvents(orderedEventTickers);
  let matchedEvents = 0;
  let matchedMarkets = 0;
  let updatedMarkets = 0;
  let filledBestBid = 0;
  let filledBestAsk = 0;
  let filledLastPrice = 0;
  let updatedVolumeTotal = 0;
  let updatedVolume24h = 0;
  let updatedOpenInterest = 0;
  let updatedLiquidity = 0;

  for (const group of groups) {
    if (!group.eventTicker) continue;
    const publicEvent = fetchResult.eventsByTicker.get(group.eventTicker);
    if (!publicEvent) continue;
    matchedEvents += 1;
    const enriched = applyKalshiPublicEventToMappedMarkets(
      group.mappedMarkets,
      publicEvent,
    );
    group.mappedMarkets = enriched.mappedMarkets;
    if (group.eventTicker && enriched.matchedMarkets > 0) {
      enrichedEventTickers.add(group.eventTicker);
    }
    matchedMarkets += enriched.matchedMarkets;
    updatedMarkets += enriched.updatedMarkets;
    filledBestBid += enriched.filledBestBid;
    filledBestAsk += enriched.filledBestAsk;
    filledLastPrice += enriched.filledLastPrice;
    updatedVolumeTotal += enriched.updatedVolumeTotal;
    updatedVolume24h += enriched.updatedVolume24h;
    updatedOpenInterest += enriched.updatedOpenInterest;
    updatedLiquidity += enriched.updatedLiquidity;
  }

  if (fetchResult.failedEvents > 0) {
    log.warn("DFlow Kalshi public enrichment partial failure", {
      context,
      failedEvents: fetchResult.failedEvents,
      sampleErrors: fetchResult.errors,
    });
  }

  if (
    fetchResult.attemptedEvents > 0 ||
    matchedMarkets > 0 ||
    fetchResult.failedEvents > 0
  ) {
    log.info("DFlow Kalshi public enrichment complete", {
      context,
      attemptedEvents: fetchResult.attemptedEvents,
      fetchedEvents: fetchResult.fetchedEvents,
      cachedEvents: fetchResult.cachedEvents,
      resolvedEvents: fetchResult.resolvedEvents,
      skippedEvents: fetchResult.skippedEvents,
      failedEvents: fetchResult.failedEvents,
      matchedEvents,
      matchedMarkets,
      updatedMarkets,
      filledBestBid,
      filledBestAsk,
      filledLastPrice,
      updatedVolumeTotal,
      updatedVolume24h,
      updatedOpenInterest,
      updatedLiquidity,
    });
  }

  return enrichedEventTickers;
}

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
  const tsMs = ts.getTime();
  if (!topTickGate.shouldPublish({ tokenId, bestBid, bestAsk, tsMs })) {
    return;
  }

  await publishTokenTopNow(tokenId, bestBid, bestAsk, tsMs);
}

async function publishTokenTopNow(
  tokenId: string,
  bestBid: number | null,
  bestAsk: number | null,
  tsMs: number,
): Promise<void> {
  if (bestBid == null && bestAsk == null) return;

  const tick = {
    token_id: tokenId,
    best_bid: bestBid,
    best_ask: bestAsk,
    ts: tsMs,
  };
  const tickJson = JSON.stringify(tick);

  const snap = {
    token_id: tokenId,
    bids: buildBookSide(bestBid),
    asks: buildBookSide(bestAsk),
    timestamp: tsMs.toString(),
  };

  const multi = redis.multi();
  multi.set(`book:${tokenId}`, JSON.stringify(snap), { EX: 5 });
  multi.set(`top:${tokenId}`, tickJson, { EX: 60 });
  multi.publish(`prices:${tokenId}`, tickJson);

  await Promise.all([
    writeUnifiedBookTop(pool, tokenId, bestBid, bestAsk, new Date(tsMs)),
    multi.exec(),
  ]);
}

function clampHotProbeLimit(limit: number): number {
  return Math.max(200, Math.min(2000, Math.trunc(limit)));
}

async function fetchHotTokenIds(limit?: number): Promise<string[]> {
  if (env.hotTokensMax <= 0 && env.hotStreamTokensMax <= 0) return [];
  await ensureRedis();
  const mergedCap = Math.max(env.hotTokensMax, env.hotStreamTokensMax);
  const resolvedLimit =
    typeof limit === "number" && Number.isFinite(limit)
      ? Math.max(0, Math.trunc(limit))
      : mergedCap;
  if (resolvedLimit <= 0) return [];

  const readHotSet = async (
    key: string,
    maxTokens: number,
    ttlSec: number,
  ): Promise<string[]> => {
    const readMax = Math.min(maxTokens, resolvedLimit);
    if (readMax <= 0) return [];
    const cutoff = Date.now() - ttlSec * 1000;
    await redis.zRemRangeByScore(key, 0, cutoff);
    return redis.zRange(key, 0, readMax - 1, { REV: true });
  };

  try {
    const [streamIds, hotIds] = await Promise.all([
      readHotSet(
        "hot:tokens:stream:dflow",
        env.hotStreamTokensMax,
        env.hotStreamTokensTtlSec,
      ),
      readHotSet("hot:tokens:dflow", env.hotTokensMax, env.hotTokensTtlSec),
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

async function fetchTickersForEventIds(eventIds: string[]): Promise<string[]> {
  if (!eventIds.length) return [];
  const { rows } = await pool.query<{ venue_market_id: string | null }>(
    `
      select m.venue_market_id
      from unified_markets m
      where m.venue = 'kalshi'
        and m.event_id = any($1::text[])
        and m.venue_market_id is not null
      order by m.updated_at desc nulls last
    `,
    [eventIds],
  );

  const out: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const ticker = row.venue_market_id;
    if (!ticker || seen.has(ticker)) continue;
    seen.add(ticker);
    out.push(ticker);
  }
  return out;
}

async function fetchHotTickersOrdered(): Promise<string[]> {
  const hotTokenIds = await fetchHotTokenIds(clampHotProbeLimit(env.wsSubset * 12));
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
  const hotTokenIds = await fetchHotTokenIds(
    clampHotProbeLimit(env.tradesTokenLimit * 8),
  );
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
): Promise<
  Map<string, { eventCategory: string | null; eventId: string; eventTitle: string }>
> {
  if (!tickers.length) return new Map();
  const { rows } = await pool.query<{
    event_category: string | null;
    venue_market_id: string;
    event_id: string;
    event_title: string;
  }>(
    `
      select
        m.venue_market_id,
        m.event_id,
        e.title as event_title,
        e.category as event_category
      from unified_markets m
      join unified_events e on e.id = m.event_id
      where m.venue = 'kalshi'
        and m.venue_market_id = any($1::text[])
    `,
    [tickers],
  );

  const map = new Map<
    string,
    { eventCategory: string | null; eventId: string; eventTitle: string }
  >();
  for (const row of rows) {
    map.set(row.venue_market_id, {
      eventCategory: row.event_category,
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
  const tokenIds = await fetchHotTokenIds(clampHotProbeLimit(env.wsSubset * 10));
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

  const hotTokenIds = await fetchHotTokenIds(clampHotProbeLimit(env.wsSubset * 12));
  const positionTokenIds = await fetchPositionTokenIds();

  const allTokenIds = Array.from(new Set([...hotTokenIds, ...positionTokenIds]));
  let processedMarkets = 0;
  const touchedEventIds = new Set<string>();

  if (allTokenIds.length) {
    const mints = Array.from(
      new Set(
        allTokenIds
          .map((tokenId) => stripSolanaPrefix(tokenId))
          .filter((mint): mint is string => Boolean(mint)),
      ),
    );

    if (mints.length) {
      const batches = chunkArray(mints, STATUS_BATCH_LIMIT);
      const marketsByTicker = new Map<string, TDflowMarket>();
      for (const batch of batches) {
        const result = await fetchMarketsBatch({ mints: batch });
        for (const market of result) {
          if (!market.ticker) continue;
          marketsByTicker.set(market.ticker, market);
        }
      }

      const initialTickers = Array.from(marketsByTicker.keys());
      const initialEventInfoByTicker =
        await fetchMarketEventInfoByTickers(initialTickers);
      const initialEventIds = Array.from(
        new Set(
          Array.from(initialEventInfoByTicker.values()).map(
            (info) => info.eventId,
          ),
        ),
      );

      let siblingTickersFetched = 0;
      if (initialEventIds.length) {
        const siblingTickers = await fetchTickersForEventIds(initialEventIds);
        const missingSiblingTickers = siblingTickers.filter(
          (ticker) => !marketsByTicker.has(ticker),
        );
        if (missingSiblingTickers.length) {
          const tickerBatches = chunkArray(
            missingSiblingTickers,
            STATUS_BATCH_LIMIT,
          );
          for (const batch of tickerBatches) {
            const result = await fetchMarketsBatch({ tickers: batch });
            for (const market of result) {
              if (!market.ticker) continue;
              if (!marketsByTicker.has(market.ticker)) {
                siblingTickersFetched += 1;
              }
              marketsByTicker.set(market.ticker, market);
            }
          }
        }
      }

      const markets = Array.from(marketsByTicker.values());
      const tickers = markets
        .map((market) => market.ticker)
        .filter((ticker): ticker is string => Boolean(ticker));
      const eventInfoByTicker = await fetchMarketEventInfoByTickers(tickers);

      const mappedGroupsByEvent = new Map<string, MappedMarketGroup>();

      for (const market of markets) {
        const eventInfo = eventInfoByTicker.get(market.ticker);
        if (!eventInfo) continue;
        const mapped = mapToUnifiedMarket(
          market,
          eventInfo.eventId,
          eventInfo.eventTitle,
          eventInfo.eventCategory,
          env.solanaUsdcMint,
          env.requireInitialized,
        );
        if (!mapped) continue;
        const eventTicker = pickDflowMarketEventTicker(market, eventInfo.eventId);
        const groupKey = eventTicker ?? `__missing__:${eventInfo.eventId}`;
        const existing = mappedGroupsByEvent.get(groupKey);
        if (existing) {
          existing.mappedMarkets.push(mapped);
        } else {
          mappedGroupsByEvent.set(groupKey, {
            eventTicker,
            mappedMarkets: [mapped],
          });
        }
        processedMarkets += 1;
      }

      const mappedGroups = Array.from(mappedGroupsByEvent.values());
      await maybeEnrichKalshiMappedMarketGroups(
        mappedGroups,
        "hot-status",
      );

      const unifiedMarketRows: UnifiedMarketRow[] = [];
      const tokenRows: Array<{ token_id: string; market_id: string; side: "YES" | "NO" }> = [];
      for (const group of mappedGroups) {
        for (const mapped of group.mappedMarkets) {
          unifiedMarketRows.push(mapped.marketRow);
          tokenRows.push(...mapped.tokenRows);
          touchedEventIds.add(mapped.marketRow.event_id);
        }
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

      if (siblingTickersFetched > 0) {
        log.info("DFlow hot status sibling refresh", {
          initialTickers: initialTickers.length,
          siblingTickersFetched,
          totalTickers: markets.length,
        });
      }
    }
  }

  const reconciledEvents = await reconcileKalshiEventStatuses(
    Array.from(touchedEventIds),
  );

  log.info("DFlow hot status refresh complete", {
    tokens: allTokenIds.length,
    markets: processedMarkets,
    reconciledEvents,
  });

  return { processedMarkets };
}

async function processEvents(
  events: TDflowEvent[],
  seriesLookup?: Map<string, DflowSeriesInfo>,
  options: ProcessEventsOptions = {},
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

  const bundles: Array<{
    eventTicker: string | null;
    unifiedEvent: UnifiedEventRow;
    mappedMarkets: DflowMappedMarket[];
    usedPublicEnrichment: boolean;
  }> = [];

  for (const e of events) {
    const unifiedEvent = mapToUnifiedEvent(e, seriesLookup);
    if (!unifiedEvent) continue;
    const mappedMarkets: DflowMappedMarket[] = [];
    const markets = e.markets ?? [];
    for (const m of markets) {
      const mapped = mapToUnifiedMarket(
        m,
        unifiedEvent.id,
        unifiedEvent.title,
        unifiedEvent.category,
        env.solanaUsdcMint,
        env.requireInitialized,
      );
      if (!mapped) continue;
      mappedMarkets.push(mapped);
      processedMarkets += 1;
    }
    bundles.push({
      eventTicker: pickDflowEventTicker(e),
      unifiedEvent,
      mappedMarkets,
      usedPublicEnrichment: false,
    });
    processedEvents += 1;
  }

  if (options.enrichKalshiPublic) {
    const groups = bundles.map((bundle) => ({
      eventTicker: bundle.eventTicker,
      mappedMarkets: bundle.mappedMarkets,
    }));
    const enrichedEventTickers = await maybeEnrichKalshiMappedMarketGroups(
      groups,
      options.enrichmentContext ?? "hot-window",
    );
    for (let index = 0; index < bundles.length; index += 1) {
      const group = groups[index];
      if (!group) continue;
      const before = bundles[index];
      bundles[index] = {
        ...before,
        mappedMarkets: group.mappedMarkets,
        usedPublicEnrichment:
          Boolean(group.eventTicker) &&
          enrichedEventTickers.has(group.eventTicker as string),
      };
    }
  }

  for (const bundle of bundles) {
    let volumeTotalSum = 0;
    let volume24hSum = 0;
    let liquiditySum = 0;
    let openInterestSum = 0;
    let hasVolumeTotal = false;
    let hasVolume24h = false;
    let hasLiquidity = false;
    let hasOpenInterest = false;

    for (const mapped of bundle.mappedMarkets) {
      unifiedMarketRows.push(mapped.marketRow);
      tokenRows.push(...mapped.tokenRows);
      if (mapped.snapshot) snapshots.push(mapped.snapshot);

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

    const unifiedEvent = bundle.unifiedEvent;
    if (bundle.usedPublicEnrichment) {
      if (hasVolumeTotal) unifiedEvent.volume_total = volumeTotalSum;
      if (hasVolume24h) unifiedEvent.volume_24h = volume24hSum;
      if (hasLiquidity) unifiedEvent.liquidity = liquiditySum;
      if (hasOpenInterest) unifiedEvent.open_interest = openInterestSum;
    } else {
      if (unifiedEvent.volume_total == null && hasVolumeTotal)
        unifiedEvent.volume_total = volumeTotalSum;
      if (unifiedEvent.volume_24h == null && hasVolume24h)
        unifiedEvent.volume_24h = volume24hSum;
      if (unifiedEvent.liquidity == null && hasLiquidity)
        unifiedEvent.liquidity = liquiditySum;
      if (unifiedEvent.open_interest == null && hasOpenInterest)
        unifiedEvent.open_interest = openInterestSum;
    }

    unifiedEventRows.push(unifiedEvent);
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
  if (unifiedMarketRows.length) {
    await reconcileKalshiEventStatuses(
      unifiedMarketRows.map((row) => row.event_id),
    );
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
    const r = await processEvents(events, seriesLookup, {
      enrichKalshiPublic: env.kalshiPublicEnrichEnabled,
      enrichmentContext: "hot-window",
    });
    totals.processedEvents += r.processedEvents;
    totals.processedMarkets += r.processedMarkets;
    for (const snap of r.snapshots) snapshotByMarketId.set(snap.marketId, snap);
  }

  logZeroMarketAnomaly("hot", totals);

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

export async function syncNonActiveSweep(): Promise<SyncCounters> {
  if (!env.dflowEnabled) {
    log.warn("DFlow indexer disabled", { issues: env.dflowIssues });
    return { processedEvents: 0, processedMarkets: 0, pages: 0 };
  }
  if (!env.nonActiveSweepEnabled || env.nonActiveSweepStatuses.length === 0) {
    return { processedEvents: 0, processedMarkets: 0, pages: 0 };
  }

  await ensureRedis();
  await pool.query("select 1");

  const totals: SyncCounters = {
    processedEvents: 0,
    processedMarkets: 0,
    pages: 0,
  };
  const seriesLookup = await getSeriesLookup();

  for (const status of env.nonActiveSweepStatuses) {
    const cursorOffset = await getDflowEventsOffsetByStatus(status);
    const overlap = env.nonActiveSweepOverlapPages * env.nonActiveSweepPageSize;
    const startCursor = Math.max(0, cursorOffset - overlap);

    let statusPages = 0;
    let statusEvents = 0;
    let statusMarkets = 0;
    let lastCursor = cursorOffset;

    for await (const page of iterateEventPages({
      label: `non-active:${status}`,
      startCursor,
      pageSize: env.nonActiveSweepPageSize,
      maxPages: env.nonActiveSweepMaxPages,
      status,
      withNestedMarkets: true,
    })) {
      statusPages += 1;
      totals.pages += 1;

      const r = await processEvents(page.events, seriesLookup);
      statusEvents += r.processedEvents;
      statusMarkets += r.processedMarkets;
      totals.processedEvents += r.processedEvents;
      totals.processedMarkets += r.processedMarkets;

      const baseCursor = page.cursor ?? 0;
      const computed = baseCursor + page.events.length;
      const nextCursor = page.nextCursor ?? computed;
      lastCursor = nextCursor;
      await setDflowEventsOffsetByStatus(status, nextCursor);
    }

    if (statusPages === 0 && cursorOffset > 0) {
      // Cursor reached the end for this status; reset to rescan from head next cycle.
      await resetDflowEventsOffsetByStatus(status);
      lastCursor = 0;
    }

    log.info("DFlow non-active sweep status complete", {
      status,
      cursorOffset,
      startCursor,
      lastCursor,
      pages: statusPages,
      events: statusEvents,
      markets: statusMarkets,
    });
  }

  if (totals.pages > 0) {
    log.info("DFlow non-active sweep complete", totals);
  }
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

  logZeroMarketAnomaly("catch-up", totals);

  log.info("DFlow catch-up complete", totals);
  return totals;
}
