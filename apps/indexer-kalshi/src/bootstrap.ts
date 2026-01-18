// apps/indexer-kalshi/src/bootstrap.ts
import { ensureRedis, redis } from "./redis";
import { env } from "./env";
import { iterateEventsWithMarkets } from "./marketClient";
import { mapTokens, mapToUnifiedEvent, mapToUnifiedMarket } from "./mappers";
import { upsertKalshiEvent, upsertKalshiMarket } from "./kalshi-repo";
import {
  getVenueId,
  upsertUnifiedEvent,
  upsertUnifiedMarket,
  upsertUnifiedToken,
  writeUnifiedBookTop,
} from "@hunch/db";
import { pool } from "./db";
import {
  buildTopMarketsText,
  enqueueEmbedItems,
  type EmbedQueueItem,
} from "@hunch/infra";
import PQueue from "p-queue";
import { getOrderbookTop } from "./orderbookClient";
import { v4 as uuid } from "uuid";

function parseKalshiTicker(tokenId: string): string | null {
  if (!tokenId.startsWith("kalshi:")) return null;
  const parts = tokenId.split(":");
  if (parts.length < 3) return null;
  return parts[1] || null;
}

async function fetchHotTickers(): Promise<string[]> {
  if (env.hotTokensMax <= 0) return [];
  const key = "hot:tokens:kalshi";
  const cutoff = Date.now() - env.hotTokensTtlSec * 1000;

  try {
    await redis.zRemRangeByScore(key, 0, cutoff);
    const tokens = await redis.zRange(key, 0, env.hotTokensMax - 1, {
      REV: true,
    });
    const out: string[] = [];
    const seen = new Set<string>();
    for (const tokenId of tokens) {
      const ticker = parseKalshiTicker(tokenId);
      if (!ticker) continue;
      if (seen.has(ticker)) continue;
      seen.add(ticker);
      out.push(ticker);
    }
    return out;
  } catch (error) {
    console.warn("[kalshi] Failed to fetch hot tickers", error);
    return [];
  }
}

export async function bootstrapKalshi() {
  await ensureRedis();
  const venueId = await getVenueId(pool, "kalshi");
  console.log("Bootstrapping Kalshi…", venueId);

  console.log(`[Bootstrap] Starting to process events (all statuses)...`);

  const topTickers = new Set<string>(); // ✅ dedup as you go
  let processedEvents = 0;
  let processedMarkets = 0;

  // Fetch all markets regardless of status so we can update closed/settled markets in DB
  // API supports fetching all statuses by omitting the status parameter
  for await (const events of iterateEventsWithMarkets()) {
    const embedItems: EmbedQueueItem[] = [];
    for (const e of events) {
      // Store event in Kalshi-specific table
      await upsertKalshiEvent(e);
      processedEvents++;

      // Map and upsert to unified_events table
      const unifiedEventRow = mapToUnifiedEvent(e);
      await upsertUnifiedEvent(pool, unifiedEventRow);
      const eventEmbed: EmbedQueueItem = {
        entity_type: "event",
        event_id: unifiedEventRow.id,
        venue: unifiedEventRow.venue,
        status: unifiedEventRow.status,
        event_title: unifiedEventRow.title,
        description: unifiedEventRow.description,
        category: unifiedEventRow.category,
        updated_at: unifiedEventRow.updated_at ?? unifiedEventRow.created_at,
        source: "kalshi",
      };

      const unifiedMarketRows: Array<{
        title?: string | null;
        volume_24h?: number | null;
        volume_total?: number | null;
        liquidity?: number | null;
        open_interest?: number | null;
      }> = [];

      for (const m of e.markets ?? []) {
        // Store market in Kalshi-specific table
        await upsertKalshiMarket(m);
        processedMarkets++;

        // Map and upsert to unified_markets table
        const unifiedMarketRow = mapToUnifiedMarket(m, e.event_ticker);
        await upsertUnifiedMarket(pool, unifiedMarketRow);
        unifiedMarketRows.push(unifiedMarketRow);
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
          source: "kalshi",
        });

        // Still need to store tokens in the shared tokens table for orderbook functionality
        const marketUuid = uuid();
        for (const t of mapTokens(marketUuid, m.ticker)) {
          await upsertUnifiedToken(pool, t);
        }
        topTickers.add(m.ticker);
      }

      const topMarkets = buildTopMarketsText(
        unifiedMarketRows,
        unifiedEventRow.title,
      );
      if (topMarkets) eventEmbed.top_markets = topMarkets;
      embedItems.push(eventEmbed);
    }

    // Log progress every 50 events
    if (processedEvents % 50 === 0) {
      console.log(
        `[Bootstrap] Processed ${processedEvents} events, ${processedMarkets} markets`,
      );
    }

    if (embedItems.length) {
      try {
        await enqueueEmbedItems(redis, embedItems);
      } catch (err) {
        console.warn("[kalshi] embed enqueue failed", err);
      }
    }
  }

  console.log(
    `[Bootstrap] Database storage complete: ${processedEvents} events, ${processedMarkets} markets`,
  );

  const hotTickers = await fetchHotTickers();
  const orderedTickers: string[] = [];
  const seenTickers = new Set<string>();
  for (const ticker of hotTickers) {
    if (seenTickers.has(ticker)) continue;
    seenTickers.add(ticker);
    orderedTickers.push(ticker);
  }
  for (const ticker of topTickers) {
    if (seenTickers.has(ticker)) continue;
    seenTickers.add(ticker);
    orderedTickers.push(ticker);
  }

  const snapTickers = orderedTickers.slice(0, env.topBookSnapshot);
  const q = new PQueue({ interval: 10_000, intervalCap: 180 }); // ~18 rps
  await Promise.all(
    snapTickers.map((t) =>
      q.add(async () => {
        try {
          const tops = await getOrderbookTop(t);
          for (const s of tops) {
            const tokenId = `kalshi:${t}:${s.side}`;
            await writeUnifiedBookTop(
              pool,
              tokenId,
              s.bestBid,
              s.bestAsk,
              s.ts,
            );
            await redis.set(
              `book:${tokenId}`,
              JSON.stringify({
                token_id: tokenId,
                bids:
                  s.bestBid != null
                    ? [{ price: String(s.bestBid), size: "NA" }]
                    : [],
                asks:
                  s.bestAsk != null
                    ? [{ price: String(s.bestAsk), size: "NA" }]
                    : [],
                timestamp: s.ts.getTime().toString(),
              }),
              { EX: 5 },
            );
            const tick = {
              token_id: tokenId,
              best_bid: s.bestBid,
              best_ask: s.bestAsk,
              ts: s.ts.getTime(),
            };
            const tickJson = JSON.stringify(tick);
            await redis.set(`top:${tokenId}`, tickJson, { EX: 60 });
            await redis.publish(`prices:${tokenId}`, tickJson);
          }
        } catch (e) {
          console.warn("book snapshot failed for", t, String(e));
        }
      }),
    ),
  );

  console.log(
    `Bootstrap complete: events=${processedEvents}, markets=${topTickers.size}, books=${snapTickers.length}`,
  );

  // WS needs tickers, not token_ids; return tickers
  return snapTickers;
}
