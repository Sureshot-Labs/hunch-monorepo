import { env } from "./env.js";
import { log } from "./log.js";
import PQueue from "p-queue";
import { fetchLimitlessAmmQuotePair } from "./ammQuote.js";
import {
  buildWsTargets,
  countHotAmmQuoteCandidates,
  selectHotAmmQuoteCandidates,
  type HotLimitlessMarketRow,
  type WsMarketRefRow,
} from "./hot-targets.js";
import {
  fetchAllActive,
  fetchActivePage,
  fetchMarket,
  fetchOrderbook,
} from "./limitlessClient.js";
import {
  upsertLimitlessEvent,
  upsertLimitlessMarket,
} from "./limitless-repo.js";
import {
  orderLimitlessMarketsForGrouping,
  resolveLimitlessEventContext,
  resolveLimitlessGroupId,
} from "./grouping.js";
import {
  mapLimitlessEventRow,
  mapLimitlessMarketRow,
  mapToUnifiedEvent,
  mapToUnifiedMarket,
} from "./mappers.js";
import {
  upsertUnifiedEvent,
  upsertUnifiedMarket,
  upsertUnifiedTokens,
  writeUnifiedBookTop,
  type UnifiedMarketRow,
} from "@hunch/db";
import {
  buildTopMarketsText,
  claimDuePriceRefreshTokens,
  createTopTickGate,
  enqueueEmbedItems,
  getPriceRefreshQueueBacklog,
  isPgSetupIssue,
  publishMarketState,
  publishMarketUpdate,
  requeuePriceRefreshTokens,
  type EmbedQueueItem,
  type PriceRefreshQueueClaimSide,
  type PriceRefreshRedis,
} from "@hunch/infra";
import { pool } from "./db.js";
import { ensureRedis, redis } from "./redis.js";
import {
  LimitlessMarket,
  type TLimitlessMarket,
  type TLimitlessMarketItem,
} from "./types.js";
import type { WsTargets } from "./wsMarket.js";

const detailCache = new Map<string, TLimitlessMarket>();
const hotAmmQuoteRetryAt = new Map<string, number>();
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

function prefixLimitlessToken(tokenId?: string | null): string | undefined {
  if (!tokenId) return undefined;
  return tokenId.startsWith("limitless:") ? tokenId : `limitless:${tokenId}`;
}

function resolveTimestampMs(value: Date | undefined): number | null {
  if (!value) return null;
  const time = value.getTime();
  return Number.isFinite(time) ? time : null;
}

function resolveLimitlessAcceptingOrders(
  market: UnifiedMarketRow,
  nowMs: number,
): boolean {
  if (market.resolved_outcome || market.resolved_outcome_pct != null) {
    return false;
  }
  if (market.status !== "ACTIVE") return false;

  const closeMs = resolveTimestampMs(market.close_time);
  const expirationMs = resolveTimestampMs(market.expiration_time);
  return !(
    (closeMs != null && closeMs <= nowMs) ||
    (expirationMs != null && expirationMs <= nowMs)
  );
}

function buildBookSide(best: number | null) {
  return best != null ? [{ price: String(best), size: "NA" }] : [];
}

async function publishTokenTop(
  tokenId: string,
  bestBid: number | null,
  bestAsk: number | null,
  ts: Date,
  snapshot?: unknown,
): Promise<void> {
  if (bestBid == null && bestAsk == null) return;
  const tsMs = ts.getTime();
  if (!topTickGate.shouldPublish({ tokenId, bestBid, bestAsk, tsMs })) {
    return;
  }

  await publishTokenTopNow(tokenId, bestBid, bestAsk, tsMs, snapshot);
}

async function publishTokenTopNow(
  tokenId: string,
  bestBid: number | null,
  bestAsk: number | null,
  tsMs: number,
  snapshot?: unknown,
): Promise<void> {
  if (bestBid == null && bestAsk == null) return;
  const tick = {
    token_id: tokenId,
    best_bid: bestBid,
    best_ask: bestAsk,
    ts: tsMs,
  };
  const tickJson = JSON.stringify(tick);
  const snap =
    snapshot ??
    ({
      token_id: tokenId,
      bids: buildBookSide(bestBid),
      asks: buildBookSide(bestAsk),
      timestamp: tsMs.toString(),
    } as const);

  const multi = redis.multi();
  multi.set(`book:${tokenId}`, JSON.stringify(snap), { EX: 5 });
  multi.set(`top:${tokenId}`, tickJson, { EX: 60 });
  multi.publish(`prices:${tokenId}`, tickJson);

  await Promise.all([
    writeUnifiedBookTop(pool, tokenId, bestBid, bestAsk, new Date(tsMs)),
    multi.exec(),
  ]);
}

async function publishLimitlessMarketStates(
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
      const acceptingOrders = resolveLimitlessAcceptingOrders(market, tsMs);
      return tokenIds.map((tokenId) =>
        q.add(() =>
          publishMarketState({
            redis,
            venue: "limitless",
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
          }),
        ),
      );
    }),
  );
}

async function publishLimitlessMarketUpdates(
  markets: UnifiedMarketRow[],
  event?: ReturnType<typeof mapToUnifiedEvent>,
): Promise<void> {
  if (!markets.length) return;

  const tsMs = Date.now();
  const q = new PQueue({ concurrency: 20 });
  await Promise.all(
    markets.flatMap((market) => {
      const tokenIds = [market.token_yes, market.token_no].filter(
        (tokenId): tokenId is string => Boolean(tokenId),
      );
      if (!tokenIds.length) return [];
      const acceptingOrders = resolveLimitlessAcceptingOrders(market, tsMs);
      return [
        q.add(() =>
          publishMarketUpdate({
            redis,
            venue: "limitless",
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

function mergeMarket(
  base: TLimitlessMarket | TLimitlessMarketItem,
  detail?: TLimitlessMarket | null,
  fallbackTradeType?: string,
): TLimitlessMarket {
  const merged: TLimitlessMarket = {
    ...(detail ?? {}),
    ...(base as TLimitlessMarket),
    venue: (base as TLimitlessMarket).venue ?? detail?.venue,
    negRiskRequestId:
      (base as TLimitlessMarket).negRiskRequestId ?? detail?.negRiskRequestId,
    negRiskMarketId:
      (base as TLimitlessMarket).negRiskMarketId ?? detail?.negRiskMarketId,
    groupId: (base as TLimitlessMarket).groupId ?? detail?.groupId,
    prices: (base as TLimitlessMarket).prices ?? detail?.prices,
    tokens: detail?.tokens ?? (base as TLimitlessMarket).tokens,
    markets: detail?.markets ?? (base as TLimitlessMarket).markets,
    tradeType:
      (base as TLimitlessMarket).tradeType ??
      detail?.tradeType ??
      fallbackTradeType,
    marketType: (base as TLimitlessMarket).marketType ?? detail?.marketType,
  };
  return merged;
}

async function loadLimitlessGroupParent(
  groupId: string,
): Promise<TLimitlessMarket | null> {
  const result = await pool.query<{ raw: unknown }>(
    `
      select raw
      from limitless_events
      where id = $1
        and market_type = 'group'
      limit 1
    `,
    [groupId],
  );
  const raw = result.rows[0]?.raw;
  if (!raw) return null;

  const parsed = LimitlessMarket.safeParse(raw);
  if (!parsed.success) {
    log.warn("Limitless grouped child parent raw failed to parse", {
      groupId,
      error: parsed.error.message,
    });
    return null;
  }
  return parsed.data;
}

async function getMarketDetail(slug?: string | null) {
  if (!slug) return null;
  const cached = detailCache.get(slug);
  if (cached) return cached;
  try {
    const detail = await fetchMarket(slug);
    detailCache.set(slug, detail);
    return detail;
  } catch (error) {
    log.warn("Limitless market detail fetch failed", { slug, error });
    return null;
  }
}

async function applyOrderbookTop(
  slug: string | undefined | null,
  unifiedMarket: ReturnType<typeof mapToUnifiedMarket>,
) {
  if (!env.writePriceSnapshots || !slug) return;
  try {
    const ob = await fetchOrderbook(slug);
    const bestBid = ob.bids?.[0]?.price ?? null;
    const bestAsk = ob.asks?.[0]?.price ?? null;
    const obTokenId = prefixLimitlessToken(ob.tokenId);

    if (obTokenId) {
      unifiedMarket.token_yes = obTokenId;
    }
    if (typeof ob.lastTradePrice === "number") {
      unifiedMarket.last_price = ob.lastTradePrice;
    }
    if (bestBid != null) unifiedMarket.best_bid = bestBid;
    if (bestAsk != null) unifiedMarket.best_ask = bestAsk;

    if (obTokenId && (bestBid != null || bestAsk != null)) {
      await publishTokenTop(obTokenId, bestBid, bestAsk, new Date(), {
        token_id: obTokenId,
        bids: ob.bids ?? [],
        asks: ob.asks ?? [],
        timestamp: Date.now().toString(),
      });
    }
  } catch (error) {
    if (error instanceof Error && /market is not active/i.test(error.message)) {
      return;
    }
    log.warn("Limitless orderbook fetch failed", { slug, error });
  }
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
        "hot:tokens:stream:limitless",
        env.hotStreamTokensMax,
        env.hotStreamTokensTtlSec,
      ),
      readHotSet("hot:tokens:limitless", env.hotTokensMax, env.hotTokensTtlSec),
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

async function resolveOrderedHotLimitlessMarketRows(
  limit?: number,
): Promise<HotLimitlessMarketRow[]> {
  const tokenIds = await fetchHotTokenIds(
    clampHotProbeLimit(env.wsSubset * 12),
  );
  if (!tokenIds.length) return [];

  const params: Array<string[] | number> = [tokenIds];
  const limitValue =
    typeof limit === "number" && Number.isFinite(limit)
      ? Math.max(1, Math.trunc(limit))
      : null;
  const limitSql =
    limitValue != null
      ? (() => {
          params.push(limitValue);
          return `limit $${params.length}`;
        })()
      : "";

  const { rows } = await pool.query<HotLimitlessMarketRow>(
    `
      with hot_tokens as (
        select token_id, ord::int as ord
        from unnest($1::text[]) with ordinality as t(token_id, ord)
      ),
      hot_markets as (
        select
          m.id as market_id,
          min(ht.ord)::int as hot_rank,
          m.slug,
          lower(nullif(m.metadata->>'address', '')) as address,
          nullif(m.metadata->>'tradeType', '') as trade_type,
          m.token_yes,
          m.token_no,
          m.volume_total,
          m.liquidity
        from hot_tokens ht
        join unified_tokens t on t.token_id = ht.token_id
        join unified_markets m on m.id = t.market_id
        left join unified_events e on e.id = m.event_id
        where m.venue = 'limitless'
          and m.status = 'ACTIVE'
        group by
          m.id,
          m.slug,
          lower(nullif(m.metadata->>'address', '')),
          nullif(m.metadata->>'tradeType', ''),
          m.token_yes,
          m.token_no,
          m.volume_total,
          m.liquidity
      )
      select
        market_id,
        hot_rank,
        slug,
        address,
        trade_type,
        token_yes,
        token_no,
        volume_total,
        liquidity
      from hot_markets
      order by hot_rank asc,
               volume_total desc nulls last,
               liquidity desc nulls last
      ${limitSql}
    `,
    params,
  );

  return rows;
}

function expandLimitlessTokenLookupIds(tokenIds: string[]): string[] {
  const ids = new Set<string>();
  for (const raw of tokenIds) {
    const tokenId = raw.trim();
    if (!tokenId) continue;
    ids.add(tokenId);
    const stripped = tokenId.replace(/^limitless:/, "");
    if (stripped) {
      ids.add(stripped);
      ids.add(`limitless:${stripped}`);
    }
  }
  return Array.from(ids);
}

async function resolveLimitlessMarketRowsForTokenIds(
  tokenIds: string[],
): Promise<HotLimitlessMarketRow[]> {
  const lookupTokenIds = expandLimitlessTokenLookupIds(tokenIds);
  if (!lookupTokenIds.length) return [];

  const { rows } = await pool.query<HotLimitlessMarketRow>(
    `
      with requested_tokens as (
        select token_id, ord::int as ord
        from unnest($1::text[]) with ordinality as t(token_id, ord)
      ),
      requested_markets as (
        select
          m.id as market_id,
          min(rt.ord)::int as hot_rank,
          m.slug,
          lower(nullif(m.metadata->>'address', '')) as address,
          nullif(m.metadata->>'tradeType', '') as trade_type,
          m.token_yes,
          m.token_no,
          m.volume_total,
          m.liquidity
        from requested_tokens rt
        join unified_tokens t on t.token_id = rt.token_id
        join unified_markets m on m.id = t.market_id
        left join unified_events e on e.id = m.event_id
        where m.venue = 'limitless'
        group by
          m.id,
          m.slug,
          lower(nullif(m.metadata->>'address', '')),
          nullif(m.metadata->>'tradeType', ''),
          m.token_yes,
          m.token_no,
          m.volume_total,
          m.liquidity
      )
      select
        market_id,
        hot_rank,
        slug,
        address,
        trade_type,
        token_yes,
        token_no,
        volume_total,
        liquidity
      from requested_markets
      order by hot_rank asc,
               volume_total desc nulls last,
               liquidity desc nulls last
    `,
    [lookupTokenIds],
  );

  return rows;
}

async function refreshLimitlessMarketTop(
  row: HotLimitlessMarketRow,
): Promise<boolean> {
  const tradeType = row.trade_type?.trim().toLowerCase();
  if (tradeType === "amm") {
    const address = row.address?.toLowerCase() ?? null;
    if (!address) return false;

    const quote = await fetchLimitlessAmmQuotePair({
      rpcUrl: env.baseRpcUrl,
      timeoutMs: env.baseRpcTimeoutMs,
      marketAddress: address,
    });
    const ts = new Date();
    const yesToken = prefixLimitlessToken(row.token_yes);
    const noToken = prefixLimitlessToken(row.token_no);
    let updated = false;

    if (yesToken && quote.yesPrice != null) {
      await publishTokenTop(yesToken, quote.yesPrice, quote.yesPrice, ts);
      updated = true;
    }
    if (noToken && quote.noPrice != null) {
      await publishTokenTop(noToken, quote.noPrice, quote.noPrice, ts);
      updated = true;
    }
    return updated;
  }

  if (!row.slug) return false;
  const ob = await fetchOrderbook(row.slug);
  const bestBid = ob.bids?.[0]?.price ?? null;
  const bestAsk = ob.asks?.[0]?.price ?? null;
  const obTokenId =
    prefixLimitlessToken(ob.tokenId) ?? prefixLimitlessToken(row.token_yes);
  if (!obTokenId || (bestBid == null && bestAsk == null)) return false;

  await publishTokenTop(obTokenId, bestBid, bestAsk, new Date(), {
    token_id: obTokenId,
    bids: ob.bids ?? [],
    asks: ob.asks ?? [],
    timestamp: Date.now().toString(),
  });
  return true;
}

function isPermanentLimitlessPriceRefreshError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /Limitless 404\b/i.test(error.message);
}

function isLimitlessMarketLive(market: TLimitlessMarket): boolean {
  if (market.expired) return false;
  if (market.status === "RESOLVED") return false;
  return true;
}

function resolveLimitlessMarketRef(row: HotLimitlessMarketRow): string | null {
  const slug = row.slug?.trim();
  if (slug) return slug;
  const address = row.address?.trim();
  return address || null;
}

async function refreshLimitlessQueuedMarket(
  row: HotLimitlessMarketRow,
): Promise<{
  processedMarkets: number;
  topUpdated: boolean;
}> {
  const ref = resolveLimitlessMarketRef(row);
  if (!ref) return { processedMarkets: 0, topUpdated: false };

  const detail = await fetchMarket(ref);
  const mergedTop = mergeMarket(detail, null, row.trade_type ?? undefined);
  const result = await processLimitlessMarket(mergedTop, {
    refreshOrderbookTop: false,
    publishMarketState: true,
  });

  try {
    const topUpdated = await refreshLimitlessMarketTop({
      ...row,
      slug: row.slug ?? detail.slug ?? null,
      address: row.address ?? detail.address?.toLowerCase() ?? null,
      trade_type: detail.tradeType ?? row.trade_type,
    });
    return { processedMarkets: result.marketCount, topUpdated };
  } catch (error) {
    if (!isLimitlessMarketLive(detail)) {
      return { processedMarkets: result.marketCount, topUpdated: false };
    }
    throw error;
  }
}

export async function processPriceRefreshQueue(
  options: {
    side?: PriceRefreshQueueClaimSide;
    logSuccess?: boolean;
  } = {},
): Promise<{
  claimed: number;
  refreshed: number;
  failed: number;
  backlog: number;
  side: PriceRefreshQueueClaimSide;
}> {
  const side = options.side ?? "oldest";
  if (!env.priceRefreshQueueEnabled || !env.limitlessEnabled) {
    return { claimed: 0, refreshed: 0, failed: 0, backlog: 0, side };
  }

  await ensureRedis();
  await pool.query("select 1");

  const redisClient = redis as unknown as PriceRefreshRedis;
  const tokenIds = await claimDuePriceRefreshTokens(redisClient, {
    venue: "limitless",
    limit: env.priceRefreshQueueBatch,
    side,
  });
  if (!tokenIds.length) {
    return { claimed: 0, refreshed: 0, failed: 0, backlog: 0, side };
  }

  const startedAt = Date.now();
  let refreshed = 0;
  let failed = 0;
  let marketRefreshed = 0;
  let topRefreshed = 0;
  const failedTokenIds: string[] = [];
  try {
    const rows = await resolveLimitlessMarketRowsForTokenIds(tokenIds);
    for (const row of rows) {
      try {
        const result = await refreshLimitlessQueuedMarket(row);
        marketRefreshed += result.processedMarkets;
        if (result.topUpdated) topRefreshed += 1;
      } catch (error) {
        failed += 1;
        const permanent = isPermanentLimitlessPriceRefreshError(error);
        if (!permanent) {
          const yesToken = prefixLimitlessToken(row.token_yes);
          const noToken = prefixLimitlessToken(row.token_no);
          if (yesToken) failedTokenIds.push(yesToken);
          if (noToken) failedTokenIds.push(noToken);
        }
        log.warn(
          permanent
            ? "Limitless price refresh market skipped permanently"
            : "Limitless price refresh market failed",
          {
            marketId: row.market_id,
            slug: row.slug,
            error,
          },
        );
      }
    }
    refreshed = marketRefreshed + topRefreshed;
    if (failedTokenIds.length) {
      await requeuePriceRefreshTokens(redisClient, {
        venue: "limitless",
        tokenIds: failedTokenIds,
        delayMs: env.priceRefreshRetryDelayMs,
        maxQueueSize: env.priceRefreshQueueMax,
      });
    }
  } catch (error) {
    failed = tokenIds.length;
    await requeuePriceRefreshTokens(redisClient, {
      venue: "limitless",
      tokenIds,
      delayMs: env.priceRefreshRetryDelayMs,
      maxQueueSize: env.priceRefreshQueueMax,
    });
    log.warn("Limitless price refresh queue failed", { error });
  }

  const backlog = await getPriceRefreshQueueBacklog(redisClient, "limitless");
  if (options.logSuccess !== false) {
    log.info("Limitless price refresh queue processed", {
      side,
      claimed: tokenIds.length,
      refreshed,
      marketRefreshed,
      topRefreshed,
      failed,
      backlog,
      durationMs: Date.now() - startedAt,
    });
  }
  return { claimed: tokenIds.length, refreshed, failed, backlog, side };
}

export async function backfillHotLimitlessAmmPrices(): Promise<{
  demandedMarkets: number;
  scannedMarkets: number;
  updatedMarkets: number;
  skippedCooldownMarkets: number;
}> {
  if (!env.limitlessEnabled || env.hotAmmQuoteMaxMarkets <= 0) {
    return {
      demandedMarkets: 0,
      scannedMarkets: 0,
      updatedMarkets: 0,
      skippedCooldownMarkets: 0,
    };
  }

  await ensureRedis();
  await pool.query("select 1");

  const rows = await resolveOrderedHotLimitlessMarketRows();
  if (!rows.length) {
    return {
      demandedMarkets: 0,
      scannedMarkets: 0,
      updatedMarkets: 0,
      skippedCooldownMarkets: 0,
    };
  }

  const candidates = selectHotAmmQuoteCandidates(
    rows,
    env.hotAmmQuoteMaxMarkets,
  );
  const demandedMarkets = countHotAmmQuoteCandidates(rows);
  if (!candidates.length) {
    return {
      demandedMarkets,
      scannedMarkets: 0,
      updatedMarkets: 0,
      skippedCooldownMarkets: 0,
    };
  }
  if (candidates.length < demandedMarkets) {
    log.warn("Limitless hot AMM quote backfill capped", {
      demandedMarkets,
      maxMarkets: env.hotAmmQuoteMaxMarkets,
    });
  }

  const ts = new Date();
  let updatedMarkets = 0;
  let skippedCooldownMarkets = 0;

  for (const row of candidates) {
    const address = row.address?.toLowerCase() ?? null;
    if (!address) continue;

    const nextRetryAt = hotAmmQuoteRetryAt.get(address) ?? 0;
    if (nextRetryAt > Date.now()) {
      skippedCooldownMarkets += 1;
      continue;
    }

    hotAmmQuoteRetryAt.set(address, Date.now() + env.hotAmmQuoteCooldownMs);

    try {
      const quote = await fetchLimitlessAmmQuotePair({
        rpcUrl: env.baseRpcUrl,
        timeoutMs: env.baseRpcTimeoutMs,
        marketAddress: address,
      });

      const yesToken = prefixLimitlessToken(row.token_yes);
      const noToken = prefixLimitlessToken(row.token_no);

      if (yesToken && quote.yesPrice != null) {
        await publishTokenTop(yesToken, quote.yesPrice, quote.yesPrice, ts);
      }
      if (noToken && quote.noPrice != null) {
        await publishTokenTop(noToken, quote.noPrice, quote.noPrice, ts);
      }

      if (quote.yesPrice != null || quote.noPrice != null) {
        updatedMarkets += 1;
      }
    } catch (error) {
      log.warn("Limitless hot AMM quote backfill failed", {
        marketId: row.market_id,
        address,
        error: String(error),
      });
    }
  }

  log.info("Limitless hot AMM quote backfill complete", {
    demandedMarkets,
    scannedMarkets: candidates.length,
    updatedMarkets,
    skippedCooldownMarkets,
  });

  return {
    demandedMarkets,
    scannedMarkets: candidates.length,
    updatedMarkets,
    skippedCooldownMarkets,
  };
}

function splitBudget(total: number, hotShare: number): { hotBudget: number } {
  const clampedShare = Math.max(0, Math.min(1, hotShare));
  const hotBudget = Math.max(
    0,
    Math.min(total, Math.round(total * clampedShare)),
  );
  return { hotBudget };
}

function resolveHotMarketRefs(
  rows: ReadonlyArray<HotLimitlessMarketRow>,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const row of rows) {
    const slug = row.slug?.trim();
    const address = row.address?.trim();
    const ref = slug || address;
    if (!ref) continue;
    if (seen.has(ref)) continue;
    seen.add(ref);
    out.push(ref);
  }
  return out;
}

async function processLimitlessMarket(
  mergedTop: TLimitlessMarket,
  options: {
    publishMarketState?: boolean;
    refreshOrderbookTop?: boolean;
    groupParent?: TLimitlessMarket | null;
  } = {},
): Promise<{ eventId: string; marketCount: number }> {
  let eventContext = resolveLimitlessEventContext(
    mergedTop,
    options.groupParent,
  );
  if (eventContext.missingGroupParent && eventContext.groupId) {
    const loadedParent = await loadLimitlessGroupParent(eventContext.groupId);
    eventContext = resolveLimitlessEventContext(mergedTop, loadedParent);
    if (eventContext.missingGroupParent) {
      log.warn("Limitless grouped child processed without known parent", {
        marketId: mergedTop.id,
        groupId: eventContext.groupId,
        title: mergedTop.title,
      });
    }
  }

  const eventSource = eventContext.eventSource;
  const eventRow = mapLimitlessEventRow(eventSource);
  const eventId = await upsertLimitlessEvent(eventRow);

  const unifiedEventRow = mapToUnifiedEvent(eventSource);
  await upsertUnifiedEvent(pool, unifiedEventRow);

  let marketCount = 0;
  const embedItems: EmbedQueueItem[] = [
    {
      entity_type: "event",
      event_id: unifiedEventRow.id,
      venue: unifiedEventRow.venue,
      status: unifiedEventRow.status,
      event_title: unifiedEventRow.title,
      description: unifiedEventRow.description,
      category: unifiedEventRow.category,
      updated_at: unifiedEventRow.updated_at ?? unifiedEventRow.created_at,
      source: "limitless",
    },
  ];
  const eventMarkets: UnifiedMarketRow[] = [];

  if (mergedTop.marketType === "single") {
    const marketRow = mapLimitlessMarketRow(eventId, mergedTop);
    await upsertLimitlessMarket(marketRow);
    marketCount += 1;

    const unifiedMarketRow = mapToUnifiedMarket(
      mergedTop,
      eventContext.eventId,
      eventSource,
    );
    if (
      (options.refreshOrderbookTop ?? true) &&
      mergedTop.tradeType?.toLowerCase() === "clob"
    ) {
      await applyOrderbookTop(mergedTop.slug, unifiedMarketRow);
    }
    await upsertUnifiedMarket(pool, unifiedMarketRow);
    eventMarkets.push(unifiedMarketRow);
    embedItems.push({
      entity_type: "market",
      market_id: unifiedMarketRow.id,
      venue: unifiedMarketRow.venue,
      status: unifiedMarketRow.status,
      market_title: unifiedMarketRow.title,
      event_title: unifiedEventRow.title,
      description: unifiedMarketRow.description,
      category: unifiedMarketRow.category,
      outcomes: unifiedMarketRow.outcomes,
      market_type: unifiedMarketRow.market_type,
      updated_at: unifiedMarketRow.updated_at ?? unifiedMarketRow.created_at,
      source: "limitless",
    });
    if (unifiedMarketRow.token_yes || unifiedMarketRow.token_no) {
      const tokenRows: Array<{
        token_id: string;
        market_id: string;
        side: "YES" | "NO";
      }> = [];
      const yesToken = unifiedMarketRow.token_yes
        ? prefixLimitlessToken(unifiedMarketRow.token_yes)
        : undefined;
      const noToken = unifiedMarketRow.token_no
        ? prefixLimitlessToken(unifiedMarketRow.token_no)
        : undefined;
      if (yesToken) {
        tokenRows.push({
          token_id: yesToken,
          market_id: unifiedMarketRow.id,
          side: "YES",
        });
      }
      if (noToken) {
        tokenRows.push({
          token_id: noToken,
          market_id: unifiedMarketRow.id,
          side: "NO",
        });
      }
      if (tokenRows.length) {
        await upsertUnifiedTokens(pool, tokenRows);
      }
    }
  } else if (mergedTop.marketType === "group") {
    const subMarkets = mergedTop.markets ?? [];
    for (const subMarket of subMarkets) {
      const subDetail =
        subMarket.slug &&
        (!subMarket.tokens || !subMarket.tokens.yes || !subMarket.tokens.no)
          ? await getMarketDetail(subMarket.slug)
          : null;
      const mergedSub = mergeMarket(
        subMarket,
        subDetail,
        mergedTop.tradeType ?? "clob",
      );
      if (!mergedSub.venue && mergedTop.venue) {
        mergedSub.venue = mergedTop.venue;
      }
      const marketRow = mapLimitlessMarketRow(eventId, mergedSub);
      await upsertLimitlessMarket(marketRow);
      marketCount += 1;

      const unifiedMarketRow = mapToUnifiedMarket(
        mergedSub,
        String(mergedTop.id),
        mergedTop,
      );
      if (
        (options.refreshOrderbookTop ?? true) &&
        mergedSub.tradeType?.toLowerCase() === "clob"
      ) {
        await applyOrderbookTop(mergedSub.slug, unifiedMarketRow);
      }
      await upsertUnifiedMarket(pool, unifiedMarketRow);
      eventMarkets.push(unifiedMarketRow);
      embedItems.push({
        entity_type: "market",
        market_id: unifiedMarketRow.id,
        venue: unifiedMarketRow.venue,
        status: unifiedMarketRow.status,
        market_title: unifiedMarketRow.title,
        event_title: unifiedEventRow.title,
        description: unifiedMarketRow.description,
        category: unifiedMarketRow.category,
        outcomes: unifiedMarketRow.outcomes,
        market_type: unifiedMarketRow.market_type,
        updated_at: unifiedMarketRow.updated_at ?? unifiedMarketRow.created_at,
        source: "limitless",
      });
      if (unifiedMarketRow.token_yes || unifiedMarketRow.token_no) {
        const tokenRows: Array<{
          token_id: string;
          market_id: string;
          side: "YES" | "NO";
        }> = [];
        const yesToken = unifiedMarketRow.token_yes
          ? prefixLimitlessToken(unifiedMarketRow.token_yes)
          : undefined;
        const noToken = unifiedMarketRow.token_no
          ? prefixLimitlessToken(unifiedMarketRow.token_no)
          : undefined;
        if (yesToken) {
          tokenRows.push({
            token_id: yesToken,
            market_id: unifiedMarketRow.id,
            side: "YES",
          });
        }
        if (noToken) {
          tokenRows.push({
            token_id: noToken,
            market_id: unifiedMarketRow.id,
            side: "NO",
          });
        }
        if (tokenRows.length) {
          await upsertUnifiedTokens(pool, tokenRows);
        }
      }
    }
  }

  const topMarkets = buildTopMarketsText(eventMarkets, unifiedEventRow.title);
  if (topMarkets) {
    embedItems[0] = { ...embedItems[0], top_markets: topMarkets };
  }

  if (options.publishMarketState) {
    await publishLimitlessMarketStates(eventMarkets);
  }
  try {
    await publishLimitlessMarketUpdates(eventMarkets, unifiedEventRow);
  } catch (error) {
    log.warn("Limitless market update publish failed", {
      eventId: unifiedEventRow.id,
      error,
    });
  }

  if (embedItems.length) {
    try {
      await enqueueEmbedItems(redis, embedItems);
    } catch (err) {
      log.warn("Limitless embed enqueue failed", err);
    }
  }

  return { eventId, marketCount };
}

async function processFetchedMarkets(
  markets: TLimitlessMarket[],
  opts: {
    logEach: boolean;
    progressEvery?: number;
    progressLabel?: string;
  },
): Promise<{ eventCount: number; marketCount: number }> {
  let eventCount = 0;
  let marketCount = 0;
  let failedEvents = 0;
  const progressEvery = Math.max(0, opts.progressEvery ?? 0);

  const groupParents = new Map<string, TLimitlessMarket>();
  for (const lm of markets) {
    if (lm.marketType === "group") {
      groupParents.set(String(lm.id), lm);
    }
  }

  for (const lm of orderLimitlessMarketsForGrouping(markets)) {
    try {
      const needsDetail =
        lm.marketType === "group"
          ? !lm.markets?.length
          : lm.tradeType?.toLowerCase() === "clob"
            ? !lm.tokens?.yes || !lm.tokens?.no
            : false;
      const shouldFetchNegRiskDetail = Boolean(
        lm.negRiskRequestId || lm.negRiskMarketId,
      );
      const detail =
        needsDetail || shouldFetchNegRiskDetail
          ? await getMarketDetail(lm.slug)
          : null;
      const mergedTop = mergeMarket(lm, detail);
      if (mergedTop.marketType === "group") {
        groupParents.set(String(mergedTop.id), mergedTop);
      }
      const groupId = resolveLimitlessGroupId(mergedTop);

      const { eventId, marketCount: processedMarkets } =
        await processLimitlessMarket(mergedTop, {
          groupParent: groupId ? groupParents.get(groupId) : undefined,
        });
      eventCount += 1;
      marketCount += processedMarkets;

      if (opts.logEach) {
        log.info(
          `Processed ${mergedTop.marketType} market: ${mergedTop.title}`,
          {
            eventId,
            marketCount: processedMarkets,
          },
        );
      }
    } catch (error) {
      if (isPgSetupIssue(error)) throw error;
      failedEvents += 1;
      log.err(`Failed to process market ${lm.id}: ${lm.title}`, {
        error,
        market: lm,
      });
    } finally {
      if (
        !opts.logEach &&
        progressEvery > 0 &&
        (eventCount + failedEvents) % progressEvery === 0
      ) {
        log.info(opts.progressLabel ?? "Limitless process progress", {
          completedEvents: eventCount + failedEvents,
          totalEvents: markets.length,
          processedMarkets: marketCount,
          failedEvents,
        });
      }
    }
  }

  return { eventCount, marketCount };
}

export async function bootstrapLimitless() {
  log.info("Bootstrapping Limitless…");

  // Fail fast on DB/auth/migrations issues (otherwise we spam per-market failures).
  await pool.query("select 1");
  await ensureRedis();

  const markets = await fetchAllActive(
    env.bootstrapMaxPages,
    env.bootstrapPageSize,
    {
      onPage: ({ page, totalPages, pageMarkets, fetchedMarkets }) => {
        log.info("Limitless full bootstrap fetch progress", {
          page,
          totalPages,
          pageMarkets,
          fetchedMarkets,
        });
      },
    },
  );
  const { eventCount, marketCount } = await processFetchedMarkets(markets, {
    logEach: false,
    progressEvery: 25,
    progressLabel: "Limitless full bootstrap progress",
  });

  log.info(`Bootstrap complete: events=${eventCount} markets=${marketCount}`);
}

export async function ensureStartupWsTargets(): Promise<WsTargets> {
  await pool.query("select 1");
  await ensureRedis();

  let targets = await resolveHotWsTargets();
  if (targets.slugs.length + targets.addresses.length > 0) {
    return targets;
  }

  if (env.startupSeedPages <= 0) {
    return targets;
  }

  log.info("Seeding Limitless markets for WS startup", {
    pages: env.startupSeedPages,
    pageSize: env.bootstrapPageSize,
  });

  const seededMarkets: TLimitlessMarket[] = [];
  for (let page = 1; page <= env.startupSeedPages; page += 1) {
    const result = await fetchActivePage(page, env.bootstrapPageSize, "newest");
    if (!result.data.length) break;
    seededMarkets.push(...result.data);
    const totalPages =
      result.totalPages ??
      (typeof result.totalMarketsCount === "number" &&
      Number.isFinite(result.totalMarketsCount)
        ? Math.ceil(result.totalMarketsCount / env.bootstrapPageSize)
        : undefined);
    if (totalPages && page >= totalPages) break;
  }

  if (seededMarkets.length > 0) {
    const seeded = await processFetchedMarkets(seededMarkets, {
      logEach: false,
      progressEvery: 0,
    });
    log.info("Limitless startup seed complete", seeded);
  }

  targets = await resolveHotWsTargets();
  return targets;
}

export async function syncHotLimitlessMarkets(): Promise<{
  processedMarkets: number;
}> {
  if (!env.limitlessEnabled || env.hotTokensMax <= 0) {
    return { processedMarkets: 0 };
  }

  await ensureRedis();
  await pool.query("select 1");

  const rows = await resolveOrderedHotLimitlessMarketRows();
  const refs = resolveHotMarketRefs(rows);
  if (!refs.length) return { processedMarkets: 0 };

  log.info("Limitless hot status refresh…", {
    hotMarkets: rows.length,
    refs: refs.length,
  });

  let processedMarkets = 0;
  let completedRefs = 0;
  let failedRefs = 0;
  for (const ref of refs) {
    try {
      const detail = await fetchMarket(ref);
      const mergedTop = mergeMarket(detail, null);
      const result = await processLimitlessMarket(mergedTop);
      processedMarkets += result.marketCount;
    } catch (error) {
      failedRefs += 1;
      log.warn("Limitless hot market fetch failed", { ref, error });
    } finally {
      completedRefs += 1;
      if (completedRefs % 10 === 0 || completedRefs === refs.length) {
        log.info("Limitless hot status refresh progress", {
          completedRefs,
          totalRefs: refs.length,
          processedMarkets,
          failedRefs,
        });
      }
    }
  }

  log.info("Limitless hot status refresh complete", {
    hotMarkets: rows.length,
    markets: processedMarkets,
  });

  return { processedMarkets };
}

export async function resolveHotWsTargets(): Promise<WsTargets> {
  const { hotBudget } = splitBudget(env.wsSubset, env.wsHotShare);
  const hotRows = await resolveOrderedHotLimitlessMarketRows();
  const hotTargets = buildWsTargets(hotRows, hotBudget);

  const remaining = Math.max(
    0,
    env.wsSubset - hotTargets.slugs.length - hotTargets.addresses.length,
  );
  const { rows } = await pool.query<WsMarketRefRow>(
    `
      select
        m.slug,
        nullif(m.metadata->>'address', '') as address,
        nullif(m.metadata->>'tradeType', '') as trade_type
      from unified_markets m
      where m.venue = 'limitless'
        and m.status = 'ACTIVE'
        and (
          (coalesce(m.metadata->>'tradeType', 'clob') = 'amm' and nullif(m.metadata->>'address', '') is not null)
          or (coalesce(m.metadata->>'tradeType', 'clob') <> 'amm' and m.slug is not null)
        )
      order by m.volume_total desc nulls last,
               m.liquidity desc nulls last,
               m.updated_at_db desc
      limit $1
    `,
    [Math.max(100, remaining * 2)],
  );

  return buildWsTargets([...hotRows, ...rows], env.wsSubset);
}
