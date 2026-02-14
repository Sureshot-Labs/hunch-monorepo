import { env } from "./env.js";
import { log } from "./log.js";
import {
  fetchAllActive,
  fetchMarket,
  fetchOrderbook,
} from "./limitlessClient.js";
import {
  upsertLimitlessEvent,
  upsertLimitlessMarket,
} from "./limitless-repo.js";
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
} from "@hunch/db";
import {
  buildTopMarketsText,
  createTopTickGate,
  enqueueEmbedItems,
  isPgSetupIssue,
  type EmbedQueueItem,
} from "@hunch/infra";
import { pool } from "./db.js";
import { ensureRedis, redis } from "./redis.js";
import type { TLimitlessMarket, TLimitlessMarketItem } from "./types.js";

const detailCache = new Map<string, TLimitlessMarket>();
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
    log.warn("Limitless orderbook fetch failed", { slug, error });
  }
}

type HotMarketRefRow = {
  slug: string | null;
  address: string | null;
};

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

function splitBudget(total: number, hotShare: number): { hotBudget: number } {
  const clampedShare = Math.max(0, Math.min(1, hotShare));
  const hotBudget = Math.max(0, Math.min(total, Math.round(total * clampedShare)));
  return { hotBudget };
}

async function resolveHotMarketRefs(
  tokenIds: string[],
): Promise<string[]> {
  if (!tokenIds.length) return [];

  const { rows } = await pool.query<HotMarketRefRow>(
    `
      select distinct
        coalesce(e.slug, m.slug) as slug,
        nullif(m.metadata->>'address', '') as address
      from unified_tokens t
      join unified_markets m on m.id = t.market_id
      left join unified_events e on e.id = m.event_id
      where t.token_id = any($1::text[])
        and m.venue = 'limitless'
    `,
    [tokenIds],
  );

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

async function resolveHotMarketSlugs(
  tokenIds: string[],
): Promise<string[]> {
  if (!tokenIds.length) return [];

  const { rows } = await pool.query<{ slug: string | null }>(
    `
      select distinct coalesce(e.slug, m.slug) as slug
      from unified_tokens t
      join unified_markets m on m.id = t.market_id
      left join unified_events e on e.id = m.event_id
      where t.token_id = any($1::text[])
        and m.venue = 'limitless'
        and coalesce(e.slug, m.slug) is not null
    `,
    [tokenIds],
  );

  const out: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const slug = row.slug?.trim();
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    out.push(slug);
  }
  return out;
}

async function processLimitlessMarket(
  mergedTop: TLimitlessMarket,
): Promise<{ eventId: string; marketCount: number }> {
  const eventRow = mapLimitlessEventRow(mergedTop);
  const eventId = await upsertLimitlessEvent(eventRow);

  const unifiedEventRow = mapToUnifiedEvent(mergedTop);
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
  const eventMarkets: Array<{
    title?: string | null;
    volume_24h?: number | null;
    volume_total?: number | null;
    liquidity?: number | null;
    open_interest?: number | null;
  }> = [];

  if (mergedTop.marketType === "single") {
    const marketRow = mapLimitlessMarketRow(eventId, mergedTop);
    await upsertLimitlessMarket(marketRow);
    marketCount += 1;

    const unifiedMarketRow = mapToUnifiedMarket(
      mergedTop,
      String(mergedTop.id),
    );
    if (mergedTop.tradeType?.toLowerCase() === "clob") {
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
      );
      if (mergedSub.tradeType?.toLowerCase() === "clob") {
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

  if (embedItems.length) {
    try {
      await enqueueEmbedItems(redis, embedItems);
    } catch (err) {
      log.warn("Limitless embed enqueue failed", err);
    }
  }

  return { eventId, marketCount };
}

export async function bootstrapLimitless() {
  log.info("Bootstrapping Limitless…");

  // Fail fast on DB/auth/migrations issues (otherwise we spam per-market failures).
  await pool.query("select 1");
  await ensureRedis();

  const markets = await fetchAllActive(
    env.bootstrapMaxPages,
    env.bootstrapPageSize,
  );

  let eventCount = 0;
  let marketCount = 0;

  for (const lm of markets) {
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

      const { eventId, marketCount: processedMarkets } =
        await processLimitlessMarket(mergedTop);
      eventCount += 1;
      marketCount += processedMarkets;

      log.info(`Processed ${mergedTop.marketType} market: ${mergedTop.title}`, {
        eventId,
        marketCount: processedMarkets,
      });
    } catch (error) {
      if (isPgSetupIssue(error)) throw error;
      log.err(`Failed to process market ${lm.id}: ${lm.title}`, {
        error,
        market: lm,
      });
      // Continue processing other markets
    }
  }

  log.info(`Bootstrap complete: events=${eventCount} markets=${marketCount}`);
}

export async function syncHotLimitlessMarkets(): Promise<{
  processedMarkets: number;
}> {
  if (!env.limitlessEnabled || env.hotTokensMax <= 0) {
    return { processedMarkets: 0 };
  }

  await ensureRedis();
  await pool.query("select 1");

  const tokenIds = await fetchHotTokenIds(clampHotProbeLimit(env.wsSubset * 12));
  if (!tokenIds.length) return { processedMarkets: 0 };

  const refs = await resolveHotMarketRefs(tokenIds);
  if (!refs.length) return { processedMarkets: 0 };

  let processedMarkets = 0;
  for (const ref of refs) {
    try {
      const detail = await fetchMarket(ref);
      const mergedTop = mergeMarket(detail, null);
      const result = await processLimitlessMarket(mergedTop);
      processedMarkets += result.marketCount;
    } catch (error) {
      log.warn("Limitless hot market fetch failed", { ref, error });
    }
  }

  log.info("Limitless hot status refresh complete", {
    tokens: tokenIds.length,
    markets: processedMarkets,
  });

  return { processedMarkets };
}

export async function resolveHotSlugsForWs(): Promise<string[]> {
  const { hotBudget } = splitBudget(env.wsSubset, env.wsHotShare);
  const hotTokenIds = await fetchHotTokenIds(clampHotProbeLimit(env.wsSubset * 12));
  const hotSlugsAll = await resolveHotMarketSlugs(hotTokenIds);
  const hotSlugs = hotSlugsAll.slice(0, hotBudget);

  const remaining = Math.max(0, env.wsSubset - hotSlugs.length);
  const { rows } = await pool.query<{ slug: string | null }>(
    `
      select m.slug
      from unified_markets m
      where m.venue = 'limitless'
        and m.status = 'ACTIVE'
        and m.slug is not null
      order by m.volume_total desc nulls last,
               m.liquidity desc nulls last,
               m.updated_at_db desc
      limit $1
    `,
    [Math.max(100, remaining * 2)],
  );

  const seen = new Set<string>(hotSlugs);
  const topSlugs: string[] = [];
  for (const row of rows) {
    const slug = row.slug?.trim();
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    topSlugs.push(slug);
    if (topSlugs.length >= remaining) break;
  }

  const out = [...hotSlugs, ...topSlugs];
  if (out.length < env.wsSubset) {
    for (const slug of hotSlugsAll) {
      if (seen.has(slug)) continue;
      seen.add(slug);
      out.push(slug);
      if (out.length >= env.wsSubset) break;
    }
  }

  return out;
}
