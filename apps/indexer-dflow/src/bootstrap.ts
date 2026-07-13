import { chunkArray } from "@hunch/shared";
import PQueue from "p-queue";
import type { UnifiedEventRow, UnifiedMarketRow } from "@hunch/db";
import {
  buildTopMarketsText,
  claimDuePriceRefreshTokens,
  clampHotTokenProbeLimit,
  enqueueEmbedItems,
  filterStalePriceRefreshTokens,
  getPriceRefreshQueueBacklog,
  createTopTickGate,
  publishMarketState,
  publishMarketUpdate,
  requeuePriceRefreshTokens,
  selectRecentHotTokenIds,
  type EmbedQueueItem,
  type PriceRefreshQueueClaimSide,
  type PriceRefreshRedis,
} from "@hunch/infra";
import {
  writeResolvedTerminalTokenTops,
  upsertUnifiedEvents,
  upsertUnifiedMarkets as upsertUnifiedMarketsBase,
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

type DflowUnifiedTokenRow = {
  token_id: string;
  market_id: string;
  side: "YES" | "NO";
};

type DflowMarketInsertFilterResult = {
  blockedNewMarketIds: Set<string>;
  marketRows: UnifiedMarketRow[];
  skippedStaleNewMarketIds: Set<string>;
};

type MarketStatusRefreshOptions = {
  allowNewMarkets?: boolean;
  includeSiblings?: boolean;
  publishDiscoveryUpdates?: boolean;
  publishMarketState?: boolean;
};

export type DflowMaintenanceTargets = {
  marketIds: string[];
  reasons: Record<string, number>;
  tickers: string[];
  tokenIds: string[];
};

const STATUS_BATCH_LIMIT = 100;
const STATUS_POSITION_TOKEN_LIMIT = 200;
const TRADE_MIN_SIZE = 1e-9;
const STALE_DFLOW_NEW_MARKET_INSERT_DAYS = 90;
const STALE_DFLOW_NEW_MARKET_INSERT_MS =
  STALE_DFLOW_NEW_MARKET_INSERT_DAYS * 24 * 60 * 60 * 1000;
const unifiedMarketWriteQueue = new PQueue({ concurrency: 1 });
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

function getDflowMarketTerminalTime(
  row: Pick<UnifiedMarketRow, "close_time" | "expiration_time">,
): Date | undefined {
  return row.close_time ?? row.expiration_time;
}

export function shouldSkipStaleDflowNewMarketInsert(
  row: Pick<
    UnifiedMarketRow,
    "id" | "venue" | "close_time" | "expiration_time"
  >,
  existingMarketIds: ReadonlySet<string>,
  nowMs = Date.now(),
): boolean {
  if (row.venue !== "kalshi") return false;
  if (existingMarketIds.has(row.id)) return false;

  const terminalTime = getDflowMarketTerminalTime(row);
  if (!terminalTime) return false;

  const terminalMs = terminalTime.getTime();
  if (!Number.isFinite(terminalMs)) return false;

  return terminalMs < nowMs - STALE_DFLOW_NEW_MARKET_INSERT_MS;
}

export function shouldBlockDflowNewMarketInsert(
  marketId: string,
  existingMarketIds: ReadonlySet<string>,
  allowNewMarkets: boolean,
): boolean {
  return !allowNewMarkets && !existingMarketIds.has(marketId);
}

async function loadExistingDflowMarketIds(
  rows: UnifiedMarketRow[],
): Promise<Set<string>> {
  const ids = Array.from(new Set(rows.map((row) => row.id)));
  if (!ids.length) return new Set();

  const result = await pool.query<{ id: string }>(
    `
      select id
      from unified_markets
      where id = any($1::text[])
    `,
    [ids],
  );
  return new Set(result.rows.map((row) => row.id));
}

async function filterStaleDflowNewMarketInserts(
  rows: UnifiedMarketRow[],
  options: { allowNewMarkets?: boolean } = {},
): Promise<DflowMarketInsertFilterResult> {
  if (!rows.length) {
    return {
      blockedNewMarketIds: new Set(),
      marketRows: [],
      skippedStaleNewMarketIds: new Set(),
    };
  }

  const existingMarketIds = await loadExistingDflowMarketIds(rows);
  const nowMs = Date.now();
  const blockedNewMarketIds = new Set<string>();
  const marketRows: UnifiedMarketRow[] = [];
  const skippedStaleNewMarketIds = new Set<string>();

  for (const row of rows) {
    if (
      shouldBlockDflowNewMarketInsert(
        row.id,
        existingMarketIds,
        options.allowNewMarkets !== false,
      )
    ) {
      blockedNewMarketIds.add(row.id);
      continue;
    }
    if (shouldSkipStaleDflowNewMarketInsert(row, existingMarketIds, nowMs)) {
      skippedStaleNewMarketIds.add(row.id);
      continue;
    }
    marketRows.push(row);
  }

  if (blockedNewMarketIds.size) {
    log.info("DFlow maintenance blocked new market inserts", {
      inputRows: rows.length,
      blockedRows: blockedNewMarketIds.size,
      sampleMarketIds: Array.from(blockedNewMarketIds).slice(0, 5),
    });
  }

  if (skippedStaleNewMarketIds.size) {
    log.info("DFlow skipped stale new market inserts", {
      cutoffDays: STALE_DFLOW_NEW_MARKET_INSERT_DAYS,
      inputRows: rows.length,
      skippedRows: skippedStaleNewMarketIds.size,
      sampleMarketIds: Array.from(skippedStaleNewMarketIds).slice(0, 5),
    });
  }

  return { blockedNewMarketIds, marketRows, skippedStaleNewMarketIds };
}

function filterTokenRowsForSkippedMarkets(
  tokenRows: DflowUnifiedTokenRow[],
  skippedMarketIds: ReadonlySet<string>,
): DflowUnifiedTokenRow[] {
  if (!skippedMarketIds.size) return tokenRows;
  return tokenRows.filter((row) => !skippedMarketIds.has(row.market_id));
}

async function upsertDflowUnifiedMarkets(
  rows: UnifiedMarketRow[],
): Promise<void> {
  if (rows.length === 0) return;
  await unifiedMarketWriteQueue.add(() => upsertUnifiedMarketsBase(pool, rows));
}

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
  const candidates = [
    event.event_ticker,
    event.eventTicker,
    event.ticker,
    event.id,
  ];
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

async function publishResolvedTerminalTopTicks(input: {
  marketId: string;
  noTokenId: string | null;
  observedAt: Date;
  resolvedOutcome?: string | null;
  resolvedOutcomePct?: number | string | null;
  yesTokenId: string | null;
}): Promise<number> {
  const result = await writeResolvedTerminalTokenTops(pool, {
    marketId: input.marketId,
    noTokenId: input.noTokenId,
    observedAt: input.observedAt,
    resolvedOutcome: input.resolvedOutcome,
    resolvedOutcomePct: input.resolvedOutcomePct,
    yesTokenId: input.yesTokenId,
  });
  if (result.tokenPrices.length === 0) return 0;

  const tsMs = input.observedAt.getTime();
  const multi = redis.multi();
  for (const row of result.tokenPrices) {
    const tick = {
      token_id: row.tokenId,
      best_bid: row.price,
      best_ask: row.price,
      ts: tsMs,
    };
    const tickJson = JSON.stringify(tick);
    multi.set(`top:${row.tokenId}`, tickJson, { EX: 60 });
    multi.publish(`prices:${row.tokenId}`, tickJson);
  }
  await multi.exec();
  return result.tokenPrices.length;
}

function isDflowNativeAcceptingOrders(metadata: unknown): boolean {
  if (
    typeof metadata !== "object" ||
    metadata === null ||
    Array.isArray(metadata)
  ) {
    return false;
  }
  return (
    (metadata as Record<string, unknown>).dflowNativeAcceptingOrders === true
  );
}

function isMarketTimeOpen(market: UnifiedMarketRow, nowMs: number): boolean {
  const closeMs = market.close_time?.getTime();
  const expirationMs = market.expiration_time?.getTime();
  return (
    (closeMs == null || closeMs > nowMs) &&
    (expirationMs == null || expirationMs > nowMs)
  );
}

function resolveDflowAcceptingOrders(
  market: UnifiedMarketRow,
  nowMs: number,
): boolean {
  return (
    market.status === "ACTIVE" &&
    isMarketTimeOpen(market, nowMs) &&
    isDflowNativeAcceptingOrders(market.metadata)
  );
}

function hasResolvedTerminalPrice(market: {
  resolved_outcome?: string | null;
  resolved_outcome_pct?: number | string | null;
}): boolean {
  return Boolean(
    market.resolved_outcome || market.resolved_outcome_pct != null,
  );
}

async function fetchHotTokenIds(limit?: number): Promise<string[]> {
  if (env.hotTokensMax <= 0 && env.hotStreamTokensMax <= 0) return [];
  await ensureRedis();
  try {
    return await selectRecentHotTokenIds(redis, {
      hotStreamTokensMax: env.hotStreamTokensMax,
      hotStreamTokensTtlSec: env.hotStreamTokensTtlSec,
      hotTokensMax: env.hotTokensMax,
      hotTokensTtlSec: env.hotTokensTtlSec,
      limit,
      venue: "dflow",
    });
  } catch (error) {
    log.warn("Failed to fetch hot tokens", error);
    return [];
  }
}

function splitBudget(total: number, hotShare: number): { hotBudget: number } {
  const clampedShare = Math.max(0, Math.min(1, hotShare));
  const hotBudget = Math.max(
    0,
    Math.min(total, Math.round(total * clampedShare)),
  );
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
      ? (yesDollars ?? directDollars ?? yes ?? direct ?? null)
      : tokenSide === "NO"
        ? (noDollars ?? directDollars ?? no ?? direct ?? null)
        : (directDollars ??
          yesDollars ??
          noDollars ??
          direct ??
          yes ??
          no ??
          null);

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
  const uniqueTokenIds = Array.from(new Set(tokenIds.filter(Boolean)));
  if (!uniqueTokenIds.length) return new Map();
  const { rows } = await pool.query<{ token_id: string; ts: Date | null }>(
    `
      with input as (
        select distinct unnest($1::text[]) as token_id
      )
      select i.token_id, lt.ts
      from input i
      join lateral (
        select ult.ts
        from unified_last_trade ult
        where ult.token_id = i.token_id
        order by ult.ts desc
        limit 1
      ) lt on true
    `,
    [uniqueTokenIds],
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

export async function loadDflowMaintenanceTargets(): Promise<DflowMaintenanceTargets> {
  const { rows } = await pool.query<{
    market_id: string;
    reason: string;
    ticker: string;
    token_id: string;
  }>(`
    with raw_refs as (
      select 'position'::text as reason, t.market_id, p.token_id
      from positions p
      join unified_tokens t on t.token_id = p.token_id
      join unified_markets m on m.id = t.market_id and m.venue = 'kalshi'
      where p.venue = 'kalshi'
        and abs(coalesce(p.size, 0)) > 0

      union all

      select 'order'::text as reason, t.market_id, o.token_id
      from orders o
      join unified_tokens t on t.token_id = o.token_id
      join unified_markets m on m.id = t.market_id and m.venue = 'kalshi'
      where o.venue = 'kalshi'
        and lower(coalesce(o.status, '')) in (
          'pending', 'submitted', 'live', 'partially_filled',
          'delayed', 'unconfirmed', 'open', 'unknown'
        )
        and greatest(coalesce(o.size, 0) - coalesce(o.filled_size, 0), 0) > 0
        and o.cancelled_at is null

      union all

      select 'execution'::text as reason, e.unified_market_id, null::text
      from executions e
      join unified_markets m
        on m.id = e.unified_market_id
       and m.venue = 'kalshi'
      where e.venue = 'kalshi'
        and lower(coalesce(e.status, 'unknown')) in (
          'pending', 'submitted', 'open', 'pending_close',
          'unknown', 'unconfirmed'
        )

      union all

      select 'telegram_intent'::text as reason, ti.market_id, null::text
      from telegram_trade_intents ti
      join unified_markets m on m.id = ti.market_id and m.venue = 'kalshi'
      where ti.venue = 'kalshi'
        and ti.status in ('executing', 'submitted', 'reconcile_required')
    ),
    expanded as (
      select distinct r.reason, r.market_id, r.token_id
      from raw_refs r
      where r.token_id is not null

      union

      select distinct r.reason, r.market_id, t.token_id
      from raw_refs r
      join unified_tokens t on t.market_id = r.market_id
      where r.token_id is null
        and t.token_id like 'sol:%'
    )
    select
      e.reason,
      e.market_id,
      m.venue_market_id as ticker,
      e.token_id
    from expanded e
    join unified_markets m on m.id = e.market_id and m.venue = 'kalshi'
    where m.venue_market_id is not null
      and e.token_id like 'sol:%'
    order by e.reason, e.market_id, e.token_id
  `);

  const marketIds = new Set<string>();
  const tickers = new Set<string>();
  const tokenIds = new Set<string>();
  const reasons: Record<string, number> = {};
  const reasonTargets = new Map<string, Set<string>>();
  for (const row of rows) {
    marketIds.add(row.market_id);
    tickers.add(row.ticker);
    tokenIds.add(row.token_id);
    const targets = reasonTargets.get(row.reason) ?? new Set<string>();
    targets.add(row.market_id);
    reasonTargets.set(row.reason, targets);
  }
  for (const [reason, targets] of reasonTargets) {
    reasons[reason] = targets.size;
  }

  return {
    marketIds: Array.from(marketIds).sort(),
    reasons,
    tickers: Array.from(tickers).sort(),
    tokenIds: Array.from(tokenIds).sort(),
  };
}

async function fetchTickersForTokenIds(tokenIds: string[]): Promise<string[]> {
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
  const hotTokenIds = await fetchHotTokenIds(
    clampHotTokenProbeLimit(env.wsSubset * 12),
  );
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

export function appendUniqueTickers(
  target: string[],
  tickers: ReadonlyArray<string>,
  limit: number,
): void {
  const seen = new Set(target);
  for (const ticker of tickers) {
    if (target.length >= limit) break;
    if (!ticker || seen.has(ticker)) continue;
    seen.add(ticker);
    target.push(ticker);
    if (target.length >= limit) break;
  }
}

async function fetchDurationReserveTickers(): Promise<string[]> {
  if (!env.durationWsReserveEnabled || env.durationWsReserveMax <= 0) {
    return [];
  }

  const limit = Math.min(env.wsSubset, env.durationWsReserveMax);
  if (limit <= 0) return [];

  const { rows } = await pool.query<{ venue_market_id: string | null }>(
    `
      select m.venue_market_id
      from unified_markets m
      where m.venue = 'kalshi'
        and m.status = 'ACTIVE'
        and m.is_initialized is true
        and lower(coalesce(m.metadata->>'dflowNativeAcceptingOrders', 'false')) = 'true'
        and m.duration_minutes = any($1::int[])
        and m.close_time is not null
        and m.close_time > now()
        and m.close_time <= now()
          + make_interval(mins => m.duration_minutes)
          + ($2::int * interval '1 second')
        and (m.expiration_time is null or m.expiration_time > now())
        and m.venue_market_id is not null
      order by
        m.close_time asc,
        m.duration_minutes asc,
        m.id asc
      limit $3
    `,
    [env.durationWsReserveDurations, env.durationWsReservePrewarmSec, limit],
  );

  return rows.map((row) => row.venue_market_id).filter(Boolean) as string[];
}

async function fetchTradeTokenIds(): Promise<string[]> {
  const hotTokenIds = await fetchHotTokenIds(
    clampHotTokenProbeLimit(env.tradesTokenLimit * 8),
  );
  const positionTokenIds = await fetchPositionTokenIds();
  const tokenIds = Array.from(
    new Set([...hotTokenIds, ...positionTokenIds]),
  ).filter((tokenId) => tokenId.startsWith("sol:"));
  return tokenIds.slice(0, env.tradesTokenLimit);
}

async function syncRecentTradesForTokenIds(tokenIds: string[]): Promise<{
  tokenCount: number;
  tradeCount: number;
}> {
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

export async function syncRecentTrades(): Promise<{
  tokenCount: number;
  tradeCount: number;
}> {
  if (!env.dflowEnabled) return { tokenCount: 0, tradeCount: 0 };
  return syncRecentTradesForTokenIds(await fetchTradeTokenIds());
}

export async function resolveHotTickersForWs(): Promise<string[]> {
  if (!env.dflowEnabled) return [];
  await ensureRedis();
  await pool.query("select 1");
  const { hotBudget } = splitBudget(env.wsSubset, env.wsHotShare);
  const durationTickers = await fetchDurationReserveTickers();
  const hotTickersAll = await fetchHotTickersOrdered();
  const hotTickers = hotTickersAll.slice(0, hotBudget);

  const out: string[] = [];
  appendUniqueTickers(out, durationTickers, env.wsSubset);
  appendUniqueTickers(out, hotTickers, env.wsSubset);

  const seen = new Set(out);
  const remaining = Math.max(0, env.wsSubset - out.length);
  const topTickers = await fetchTopTickers(remaining);

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
  Map<
    string,
    { eventCategory: string | null; eventId: string; eventTitle: string }
  >
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
  const tokenIds = await fetchHotTokenIds(
    clampHotTokenProbeLimit(env.wsSubset * 10),
  );
  return publishTokenTopsForTokenIds(tokenIds);
}

async function publishTokenTopsForTokenIds(
  tokenIds: string[],
): Promise<number> {
  const { rows } = await pool.query<{
    market_id: string;
    token_id: string;
    token_yes: string | null;
    token_no: string | null;
    side: "YES" | "NO";
    best_bid: number | null;
    best_ask: number | null;
    status: UnifiedMarketRow["status"];
    close_time: Date | null;
    expiration_time: Date | null;
    resolved_outcome: string | null;
    resolved_outcome_pct: number | null;
    metadata: unknown;
  }>(
    `
      select
        m.id as market_id,
        t.token_id,
        m.token_yes,
        m.token_no,
        t.side,
        m.best_bid,
        m.best_ask,
        m.status,
        m.close_time,
        m.expiration_time,
        m.resolved_outcome,
        m.resolved_outcome_pct,
        m.metadata
      from unified_tokens t
      join unified_markets m on m.id = t.market_id
      where t.token_id = any($1::text[])
    `,
    [tokenIds],
  );

  if (!rows.length) return 0;

  const ts = new Date();
  const tsMs = ts.getTime();
  const terminalMarkets = new Map<string, (typeof rows)[number]>();
  const publish: Array<{
    bestAsk: number | null;
    bestBid: number | null;
    tokenId: string;
  }> = [];

  for (const row of rows) {
    const acceptingOrders = resolveDflowAcceptingOrders(
      {
        status: row.status,
        close_time: row.close_time ?? undefined,
        expiration_time: row.expiration_time ?? undefined,
        metadata: row.metadata,
      } as UnifiedMarketRow,
      tsMs,
    );
    if (!acceptingOrders) {
      if (hasResolvedTerminalPrice(row)) {
        terminalMarkets.set(row.market_id, row);
      }
      continue;
    }

    const yesBid = row.best_bid != null ? Number(row.best_bid) : null;
    const yesAsk = row.best_ask != null ? Number(row.best_ask) : null;
    const bestBid = row.side === "YES" ? yesBid : deriveNoBid(yesAsk);
    const bestAsk = row.side === "YES" ? yesAsk : deriveNoAsk(yesBid);
    publish.push({ tokenId: row.token_id, bestBid, bestAsk });
  }

  let published = 0;
  for (const market of terminalMarkets.values()) {
    published += await publishResolvedTerminalTopTicks({
      marketId: market.market_id,
      noTokenId: market.token_no ?? null,
      observedAt: ts,
      resolvedOutcome: market.resolved_outcome ?? null,
      resolvedOutcomePct: market.resolved_outcome_pct ?? null,
      yesTokenId: market.token_yes ?? null,
    });
  }

  const q = new PQueue({ concurrency: 20 });
  await Promise.all(
    publish.map((row) =>
      q.add(() => publishTokenTop(row.tokenId, row.bestBid, row.bestAsk, ts)),
    ),
  );

  return published + publish.length;
}

async function publishDflowMarketStates(
  markets: UnifiedMarketRow[],
): Promise<void> {
  if (!markets.length) return;

  const tsMs = Date.now();
  const q = new PQueue({ concurrency: 20 });
  await Promise.all(
    markets.flatMap((market) => {
      const tokenIds = [market.token_yes, market.token_no].filter(
        (tokenId): tokenId is string => Boolean(tokenId),
      );
      const acceptingOrders = resolveDflowAcceptingOrders(market, tsMs);
      const tasks: Array<Promise<void> | undefined> = tokenIds.map((tokenId) =>
        q.add(async () => {
          await publishMarketState({
            redis,
            venue: "kalshi",
            tokenId,
            market: market.condition_id ?? market.venue_market_id ?? null,
            conditionId: market.condition_id ?? null,
            status:
              market.resolved_outcome || market.resolved_outcome_pct != null
                ? "SETTLED"
                : (market.status ?? null),
            acceptingOrders,
            resolvedOutcome: market.resolved_outcome ?? null,
            tsMs,
          });
        }),
      );
      if (!acceptingOrders && hasResolvedTerminalPrice(market)) {
        tasks.push(
          q.add(() =>
            publishResolvedTerminalTopTicks({
              marketId: market.id,
              noTokenId: market.token_no ?? null,
              observedAt: new Date(tsMs),
              resolvedOutcome: market.resolved_outcome ?? null,
              resolvedOutcomePct: market.resolved_outcome_pct ?? null,
              yesTokenId: market.token_yes ?? null,
            }).then(() => undefined),
          ),
        );
      }
      return tasks;
    }),
  );
}

async function publishDflowMarketUpdates(
  markets: UnifiedMarketRow[],
  events: UnifiedEventRow[] = [],
): Promise<void> {
  if (!markets.length) return;

  const eventById = new Map(events.map((event) => [event.id, event]));
  const tsMs = Date.now();
  const q = new PQueue({ concurrency: 20 });
  await Promise.all(
    markets.flatMap((market) => {
      const tokenIds = [market.token_yes, market.token_no].filter(
        (tokenId): tokenId is string => Boolean(tokenId),
      );
      if (!tokenIds.length) return [];
      const event = eventById.get(market.event_id);
      const acceptingOrders = resolveDflowAcceptingOrders(market, tsMs);
      return [
        q.add(() =>
          publishMarketUpdate({
            redis,
            venue: "kalshi",
            tokenIds,
            marketId: market.id,
            eventId: market.event_id,
            conditionId: market.condition_id ?? null,
            volumeTotal: market.volume_total,
            volume24h: market.volume_24h,
            liquidity: market.liquidity,
            openInterest: market.open_interest,
            lastPrice: market.last_price,
            status:
              market.resolved_outcome || market.resolved_outcome_pct != null
                ? "SETTLED"
                : (market.status ?? null),
            acceptingOrders,
            resolvedOutcome: market.resolved_outcome ?? null,
            resolvedOutcomePct: market.resolved_outcome_pct ?? null,
            eventVolumeTotal: event?.volume_total,
            eventVolume24h: event?.volume_24h,
            eventLiquidity: event?.liquidity,
            eventOpenInterest: event?.open_interest,
            tsMs,
          }),
        ),
      ];
    }),
  );
}

async function syncMarketStatusesForTokenIds(
  inputTokenIds: string[],
  context: string,
  options: MarketStatusRefreshOptions = {},
): Promise<{
  blockedNewMarkets: number;
  processedMarkets: number;
}> {
  if (!env.dflowEnabled) {
    return { blockedNewMarkets: 0, processedMarkets: 0 };
  }

  await ensureRedis();
  await pool.query("select 1");

  const allTokenIds = Array.from(new Set(inputTokenIds));
  let processedMarkets = 0;
  let blockedNewMarkets = 0;
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
      if (options.includeSiblings !== false && initialEventIds.length) {
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
        const eventTicker = pickDflowMarketEventTicker(
          market,
          eventInfo.eventId,
        );
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
      await maybeEnrichKalshiMappedMarketGroups(mappedGroups, context);

      const unifiedMarketRows: UnifiedMarketRow[] = [];
      const tokenRows: DflowUnifiedTokenRow[] = [];
      for (const group of mappedGroups) {
        for (const mapped of group.mappedMarkets) {
          unifiedMarketRows.push(mapped.marketRow);
          tokenRows.push(...mapped.tokenRows);
        }
      }

      const marketFilter = await filterStaleDflowNewMarketInserts(
        unifiedMarketRows,
        {
          allowNewMarkets: options.allowNewMarkets,
        },
      );
      const persistedMarketRows = marketFilter.marketRows;
      blockedNewMarkets += marketFilter.blockedNewMarketIds.size;
      const skippedMarketIds = new Set([
        ...marketFilter.blockedNewMarketIds,
        ...marketFilter.skippedStaleNewMarketIds,
      ]);
      const persistedTokenRows = filterTokenRowsForSkippedMarkets(
        tokenRows,
        skippedMarketIds,
      );

      if (persistedMarketRows.length) {
        await upsertDflowUnifiedMarkets(persistedMarketRows);
      }
      if (persistedTokenRows.length) {
        await upsertUnifiedTokens(pool, persistedTokenRows);
      }
      if (options.publishMarketState) {
        await publishDflowMarketStates(persistedMarketRows);
      }
      if (options.publishDiscoveryUpdates !== false) {
        try {
          await publishDflowMarketUpdates(persistedMarketRows);
        } catch (error) {
          log.warn("DFlow market update publish failed", { context, error });
        }
      }

      for (const row of persistedMarketRows) {
        touchedEventIds.add(row.event_id);
      }

      if (
        options.publishDiscoveryUpdates !== false &&
        persistedMarketRows.length
      ) {
        try {
          const eventTitleById = new Map(
            Array.from(eventInfoByTicker.values()).map((info) => [
              info.eventId,
              info.eventTitle,
            ]),
          );
          const embedMarkets: EmbedQueueItem[] = persistedMarketRows.map(
            (row) => ({
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
            }),
          );
          await enqueueEmbedItems(redis, embedMarkets);
        } catch (err) {
          log.warn("DFlow embed enqueue failed", err);
        }
      }

      if (siblingTickersFetched > 0) {
        log.info("DFlow market status sibling refresh", {
          context,
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

  log.info("DFlow market status refresh complete", {
    context,
    tokens: allTokenIds.length,
    markets: processedMarkets,
    reconciledEvents,
  });

  return { blockedNewMarkets, processedMarkets };
}

export async function syncDflowMaintenanceTargets(
  targets: DflowMaintenanceTargets,
): Promise<{
  blockedNewMarkets: number;
  processedMarkets: number;
  publishedTokenTops: number;
  tradeCount: number;
}> {
  const status = await syncMarketStatusesForTokenIds(
    targets.tokenIds,
    "maintenance",
    {
      allowNewMarkets: false,
      includeSiblings: false,
      publishDiscoveryUpdates: false,
      publishMarketState: true,
    },
  );
  const [publishedTokenTops, trades] = await Promise.all([
    publishTokenTopsForTokenIds(targets.tokenIds),
    syncRecentTradesForTokenIds(targets.tokenIds),
  ]);
  return {
    ...status,
    publishedTokenTops,
    tradeCount: trades.tradeCount,
  };
}

export async function syncHotMarketStatuses(): Promise<{
  processedMarkets: number;
}> {
  if (!env.dflowEnabled) return { processedMarkets: 0 };

  const hotTokenIds = await fetchHotTokenIds(
    clampHotTokenProbeLimit(env.wsSubset * 12),
  );
  const positionTokenIds = await fetchPositionTokenIds();
  return syncMarketStatusesForTokenIds(
    [...hotTokenIds, ...positionTokenIds],
    "hot-status",
    { includeSiblings: true },
  );
}

export async function processPriceRefreshQueue(
  options: {
    allowedTokenIds?: ReadonlySet<string>;
    side?: PriceRefreshQueueClaimSide;
    logSuccess?: boolean;
  } = {},
): Promise<{
  claimed: number;
  refreshed: number;
  failed: number;
  backlog: number;
  side: PriceRefreshQueueClaimSide;
  freshSkipped?: number;
  stale?: number;
  marketRefreshed?: number;
  topRefreshed?: number;
  httpFallback?: number;
  policySkipped?: number;
  durationMs?: number;
}> {
  const side = options.side ?? "oldest";
  if (!env.priceRefreshQueueEnabled || !env.dflowEnabled) {
    return { claimed: 0, refreshed: 0, failed: 0, backlog: 0, side };
  }

  await ensureRedis();
  const redisClient = redis as unknown as PriceRefreshRedis;
  const claimedTokenIds = await claimDuePriceRefreshTokens(redisClient, {
    venue: "dflow",
    limit: env.priceRefreshQueueBatch,
    side,
  });
  if (!claimedTokenIds.length) {
    return { claimed: 0, refreshed: 0, failed: 0, backlog: 0, side };
  }
  const tokenIds = options.allowedTokenIds
    ? claimedTokenIds.filter((tokenId) => options.allowedTokenIds?.has(tokenId))
    : claimedTokenIds;
  const policySkipped = claimedTokenIds.length - tokenIds.length;

  if (!tokenIds.length) {
    const backlog = await getPriceRefreshQueueBacklog(redisClient, "dflow");
    return {
      backlog,
      claimed: claimedTokenIds.length,
      failed: 0,
      policySkipped,
      refreshed: 0,
      side,
    };
  }

  const startedAt = Date.now();
  let refreshed = 0;
  let failed = 0;
  let marketRefreshed = 0;
  let topRefreshed = 0;
  let freshSkipped = 0;
  let staleTokenIds = tokenIds;
  try {
    const freshness = await filterStalePriceRefreshTokens(pool, tokenIds, {
      maxAgeMs: env.priceRefreshFreshTopMaxAgeMs,
      now: new Date(startedAt),
    });
    freshSkipped = freshness.freshTokenIds.length;
    staleTokenIds = freshness.staleTokenIds;
    if (!staleTokenIds.length) {
      const backlog = await getPriceRefreshQueueBacklog(redisClient, "dflow");
      if (options.logSuccess !== false) {
        log.info("DFlow price refresh queue processed", {
          side,
          claimed: claimedTokenIds.length,
          policySkipped,
          freshSkipped,
          stale: 0,
          refreshed: 0,
          marketRefreshed: 0,
          topRefreshed: 0,
          httpFallback: 0,
          failed: 0,
          backlog,
          durationMs: Date.now() - startedAt,
        });
      }
      return {
        claimed: claimedTokenIds.length,
        refreshed: 0,
        failed: 0,
        backlog,
        side,
        policySkipped,
        freshSkipped,
        stale: 0,
        marketRefreshed: 0,
        topRefreshed: 0,
        httpFallback: 0,
        durationMs: Date.now() - startedAt,
      };
    }

    const result = await syncMarketStatusesForTokenIds(
      staleTokenIds,
      "price-refresh",
      {
        allowNewMarkets: options.allowedTokenIds ? false : undefined,
        includeSiblings: false,
        publishDiscoveryUpdates: options.allowedTokenIds ? false : undefined,
        publishMarketState: true,
      },
    );
    marketRefreshed = result.processedMarkets;
    topRefreshed = await publishTokenTopsForTokenIds(staleTokenIds);
    refreshed = marketRefreshed + topRefreshed;
  } catch (error) {
    failed = staleTokenIds.length;
    await requeuePriceRefreshTokens(redisClient, {
      venue: "dflow",
      tokenIds: staleTokenIds,
      delayMs: env.priceRefreshRetryDelayMs,
      maxQueueSize: env.priceRefreshQueueMax,
    });
    log.warn("DFlow price refresh queue failed", { error });
  }

  const backlog = await getPriceRefreshQueueBacklog(redisClient, "dflow");
  if (options.logSuccess !== false) {
    log.info("DFlow price refresh queue processed", {
      side,
      claimed: claimedTokenIds.length,
      policySkipped,
      freshSkipped,
      stale: staleTokenIds.length,
      refreshed,
      marketRefreshed,
      topRefreshed,
      httpFallback: staleTokenIds.length,
      failed,
      backlog,
      durationMs: Date.now() - startedAt,
    });
  }
  return {
    claimed: claimedTokenIds.length,
    refreshed,
    failed,
    backlog,
    side,
    policySkipped,
    freshSkipped,
    stale: staleTokenIds.length,
    marketRefreshed,
    topRefreshed,
    httpFallback: staleTokenIds.length,
    durationMs: Date.now() - startedAt,
  };
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
  const tokenRows: DflowUnifiedTokenRow[] = [];
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

  const marketFilter =
    await filterStaleDflowNewMarketInserts(unifiedMarketRows);
  const persistedMarketRows = marketFilter.marketRows;
  const persistedTokenRows = filterTokenRowsForSkippedMarkets(
    tokenRows,
    marketFilter.skippedStaleNewMarketIds,
  );
  const skippedEventIds = new Set(
    unifiedMarketRows
      .filter((row) => marketFilter.skippedStaleNewMarketIds.has(row.id))
      .map((row) => row.event_id),
  );
  const persistedEventIds = new Set(
    persistedMarketRows.map((row) => row.event_id),
  );
  const eventRowsForWrite = marketFilter.skippedStaleNewMarketIds.size
    ? unifiedEventRows.filter(
        (row) => !skippedEventIds.has(row.id) || persistedEventIds.has(row.id),
      )
    : unifiedEventRows;
  const persistedMarketIds = new Set(persistedMarketRows.map((row) => row.id));
  const persistedSnapshots = snapshots.filter((snapshot) =>
    persistedMarketIds.has(snapshot.marketId),
  );

  if (eventRowsForWrite.length) {
    await upsertUnifiedEvents(pool, eventRowsForWrite);
  }
  if (persistedMarketRows.length) {
    await upsertDflowUnifiedMarkets(persistedMarketRows);
  }
  if (persistedTokenRows.length) {
    await upsertUnifiedTokens(pool, persistedTokenRows);
  }
  try {
    await publishDflowMarketUpdates(persistedMarketRows, eventRowsForWrite);
  } catch (error) {
    log.warn("DFlow market update publish failed", {
      context: options.enrichmentContext ?? "events",
      error,
    });
  }
  if (persistedMarketRows.length) {
    await reconcileKalshiEventStatuses(
      persistedMarketRows.map((row) => row.event_id),
    );
  }

  if (eventRowsForWrite.length || persistedMarketRows.length) {
    try {
      const eventTitleById = new Map(
        eventRowsForWrite.map((row) => [row.id, row.title]),
      );
      const marketsByEvent = new Map<string, UnifiedMarketRow[]>();
      for (const row of persistedMarketRows) {
        const list = marketsByEvent.get(row.event_id) ?? [];
        list.push(row);
        marketsByEvent.set(row.event_id, list);
      }
      const topMarketsByEvent = new Map<string, string>();
      for (const row of eventRowsForWrite) {
        const markets = marketsByEvent.get(row.id) ?? [];
        const topMarkets = buildTopMarketsText(markets, row.title);
        if (topMarkets) topMarketsByEvent.set(row.id, topMarkets);
      }
      const embedEvents: EmbedQueueItem[] = eventRowsForWrite.map((row) => ({
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
      const embedMarkets: EmbedQueueItem[] = persistedMarketRows.map((row) => ({
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

  return { processedEvents, processedMarkets, snapshots: persistedSnapshots };
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
