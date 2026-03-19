import { env } from "./env.js";
import { log } from "./log.js";
import { fetchLimitlessAmmQuotePair } from "./ammQuote.js";
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
    if (
      error instanceof Error &&
      /market is not active/i.test(error.message)
    ) {
      return;
    }
    log.warn("Limitless orderbook fetch failed", { slug, error });
  }
}

type HotMarketRefRow = {
  slug: string | null;
  address: string | null;
};

type HotAmmMarketRow = {
  market_id: string;
  address: string | null;
  token_yes: string | null;
  token_no: string | null;
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

export async function backfillHotLimitlessAmmPrices(): Promise<{
  scannedMarkets: number;
  updatedMarkets: number;
}> {
  if (!env.limitlessEnabled || env.hotAmmQuoteMaxMarkets <= 0) {
    return { scannedMarkets: 0, updatedMarkets: 0 };
  }

  await ensureRedis();
  await pool.query("select 1");

  const tokenIds = await fetchHotTokenIds(clampHotProbeLimit(env.wsSubset * 12));
  if (!tokenIds.length) return { scannedMarkets: 0, updatedMarkets: 0 };

  const { rows } = await pool.query<HotAmmMarketRow>(
    `
      select distinct on (m.id)
        m.id as market_id,
        lower(nullif(m.metadata->>'address', '')) as address,
        m.token_yes,
        m.token_no
      from unified_tokens t
      join unified_markets m on m.id = t.market_id
      where t.token_id = any($1::text[])
        and m.venue = 'limitless'
        and m.status = 'ACTIVE'
        and coalesce(m.metadata->>'tradeType', 'clob') = 'amm'
        and nullif(m.metadata->>'address', '') is not null
        and m.token_yes is not null
        and m.token_no is not null
      order by m.id, m.volume_total desc nulls last, m.updated_at_db desc
      limit $2
    `,
    [tokenIds, env.hotAmmQuoteMaxMarkets],
  );

  const ts = new Date();
  let updatedMarkets = 0;

  for (const row of rows) {
    const address = row.address?.toLowerCase() ?? null;
    if (!address) continue;

    const nextRetryAt = hotAmmQuoteRetryAt.get(address) ?? 0;
    if (nextRetryAt > Date.now()) continue;

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

  if (updatedMarkets > 0) {
    log.info("Limitless hot AMM quote backfill complete", {
      scannedMarkets: rows.length,
      updatedMarkets,
    });
  }

  return { scannedMarkets: rows.length, updatedMarkets };
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
      mergedTop,
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
        mergedTop,
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

      if (opts.logEach) {
        log.info(`Processed ${mergedTop.marketType} market: ${mergedTop.title}`, {
          eventId,
          marketCount: processedMarkets,
        });
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

  const tokenIds = await fetchHotTokenIds(clampHotProbeLimit(env.wsSubset * 12));
  if (!tokenIds.length) return { processedMarkets: 0 };

  const refs = await resolveHotMarketRefs(tokenIds);
  if (!refs.length) return { processedMarkets: 0 };

  log.info("Limitless hot status refresh…", {
    tokens: tokenIds.length,
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
    tokens: tokenIds.length,
    markets: processedMarkets,
  });

  return { processedMarkets };
}

type WsMarketRefRow = {
  slug: string | null;
  address: string | null;
  trade_type: string | null;
};

function buildWsTargets(rows: WsMarketRefRow[], limit: number): WsTargets {
  const normalized = rows.map((row) => ({
    tradeType: row.trade_type?.trim().toLowerCase() ?? null,
    slug: row.slug?.trim() ?? null,
    address: row.address?.trim().toLowerCase() ?? null,
  }));

  const totalLimit = Math.max(0, Math.trunc(limit));
  if (totalLimit <= 0) return { slugs: [], addresses: [] };

  const minAddressBudget = Math.min(totalLimit, Math.max(25, Math.round(totalLimit * 0.35)));
  let addressBudget = minAddressBudget;
  let slugBudget = Math.max(0, totalLimit - addressBudget);

  const slugs: string[] = [];
  const addresses: string[] = [];
  const seenSlugs = new Set<string>();
  const seenAddresses = new Set<string>();

  const tryAddRow = (
    row: (typeof normalized)[number],
    budgets: { slugs: number; addresses: number },
  ): boolean => {
    if (row.tradeType === "amm") {
      if (!row.address || seenAddresses.has(row.address)) return false;
      if (addresses.length >= budgets.addresses) return false;
      seenAddresses.add(row.address);
      addresses.push(row.address);
      return true;
    }

    if (!row.slug || seenSlugs.has(row.slug)) return false;
    if (slugs.length >= budgets.slugs) return false;
    seenSlugs.add(row.slug);
    slugs.push(row.slug);
    return true;
  };

  for (const row of normalized) {
    if (slugs.length + addresses.length >= totalLimit) break;
    tryAddRow(row, { slugs: slugBudget, addresses: addressBudget });
  }

  if (slugs.length < slugBudget) {
    addressBudget = Math.min(totalLimit - slugs.length, totalLimit);
    slugBudget = totalLimit - addressBudget;
  } else if (addresses.length < addressBudget) {
    slugBudget = Math.min(totalLimit - addresses.length, totalLimit);
    addressBudget = totalLimit - slugBudget;
  }

  for (const row of normalized) {
    if (slugs.length + addresses.length >= totalLimit) break;
    tryAddRow(row, { slugs: slugBudget, addresses: addressBudget });
  }

  if (slugs.length + addresses.length < totalLimit) {
    for (const row of normalized) {
      if (slugs.length + addresses.length >= totalLimit) break;
      if (row.tradeType === "amm") {
        if (!row.address || seenAddresses.has(row.address)) continue;
        seenAddresses.add(row.address);
        addresses.push(row.address);
      } else {
        if (!row.slug || seenSlugs.has(row.slug)) continue;
        seenSlugs.add(row.slug);
        slugs.push(row.slug);
      }
    }
  }

  return {
    slugs: slugs.slice(0, totalLimit),
    addresses: addresses.slice(0, totalLimit),
  };
}

export async function resolveHotWsTargets(): Promise<WsTargets> {
  const { hotBudget } = splitBudget(env.wsSubset, env.wsHotShare);
  const hotTokenIds = await fetchHotTokenIds(clampHotProbeLimit(env.wsSubset * 12));
  const { rows: hotRows } = await pool.query<WsMarketRefRow>(
    `
      select distinct
        coalesce(e.slug, m.slug) as slug,
        nullif(m.metadata->>'address', '') as address,
        nullif(m.metadata->>'tradeType', '') as trade_type
      from unified_tokens t
      join unified_markets m on m.id = t.market_id
      left join unified_events e on e.id = m.event_id
      where t.token_id = any($1::text[])
        and m.venue = 'limitless'
    `,
    [hotTokenIds],
  );
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
