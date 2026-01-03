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
import { isPgSetupIssue } from "@hunch/infra";
import { pool } from "./db.js";
import { ensureRedis, redis } from "./redis.js";
import type { TLimitlessMarket, TLimitlessMarketItem } from "./types.js";

const detailCache = new Map<string, TLimitlessMarket>();

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
    writeUnifiedBookTop(pool, tokenId, bestBid, bestAsk, ts),
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

export async function bootstrapLimitless() {
  log.info("Bootstrapping Limitless…");

  // Fail fast on DB/auth/migrations issues (otherwise we spam per-market failures).
  await pool.query("select 1");
  if (env.writePriceSnapshots) {
    await ensureRedis();
  }

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

      // Store the main event
      const eventRow = mapLimitlessEventRow(mergedTop);
      const eventId = await upsertLimitlessEvent(eventRow);
      eventCount++;

      // Map and upsert to unified_events table
      const unifiedEventRow = mapToUnifiedEvent(mergedTop);
      await upsertUnifiedEvent(pool, unifiedEventRow);

      // Handle different market types
      if (mergedTop.marketType === "single") {
        // Single market: the market data is in the main object
        const marketRow = mapLimitlessMarketRow(eventId, mergedTop);
        await upsertLimitlessMarket(marketRow);
        marketCount++;

        // Map and upsert to unified_markets table
        const unifiedMarketRow = mapToUnifiedMarket(
          mergedTop,
          String(mergedTop.id),
        );
        if (mergedTop.tradeType?.toLowerCase() === "clob") {
          await applyOrderbookTop(mergedTop.slug, unifiedMarketRow);
        }
        await upsertUnifiedMarket(pool, unifiedMarketRow);
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
        // Group market: iterate through sub-markets
        const subMarkets = mergedTop.markets ?? lm.markets ?? [];
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
          marketCount++;

          // Map and upsert to unified_markets table
          const unifiedMarketRow = mapToUnifiedMarket(
            mergedSub,
            String(mergedTop.id),
          );
          if (mergedSub.tradeType?.toLowerCase() === "clob") {
            await applyOrderbookTop(mergedSub.slug, unifiedMarketRow);
          }
          await upsertUnifiedMarket(pool, unifiedMarketRow);
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

      log.info(`Processed ${mergedTop.marketType} market: ${mergedTop.title}`, {
        eventId,
        marketCount:
          mergedTop.marketType === "single"
            ? 1
            : mergedTop.markets?.length || 0,
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

export async function resolveHotSlugsForWs(): Promise<string[]> {
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
    [env.wsSubset],
  );
  return rows.map((row) => row.slug).filter((slug): slug is string => !!slug);
}
