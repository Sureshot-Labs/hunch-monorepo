// apps/indexer-kalshi/src/bootstrap.ts
import { ensureRedis, redis } from "../../indexer-polymarket/src/redis";
import { env } from "./env";
import { fetchAllEventsWithNestedMarkets } from "./marketClient";
import {
  getVenueId,
  upsertToken,
  writeBookTop,
} from "../../indexer-polymarket/src/repo";
import { mapTokens, mapToUnifiedEvent, mapToUnifiedMarket } from "./mappers";
import { upsertKalshiEvent, upsertKalshiMarket } from "./kalshi-repo";
import { upsertUnifiedEvent, upsertUnifiedMarket } from "../../../packages/db/src/unified-repo";
import { pool } from "../../indexer-polymarket/src/db";
import PQueue from "p-queue";
import { getOrderbookTop } from "./orderbookClient";
import { v4 as uuid } from "uuid";

export async function bootstrapKalshi() {
  await ensureRedis();
  const venueId = await getVenueId("kalshi");
  console.log("Bootstrapping Kalshi…", venueId);

  const events = await fetchAllEventsWithNestedMarkets("open");
  console.log(`[Bootstrap] Starting to process ${events.length} events...`);

  const topTickers: string[] = [];
  let processedEvents = 0;
  let processedMarkets = 0;

  for (const e of events) {
    // Store event in Kalshi-specific table
    await upsertKalshiEvent(e);
    processedEvents++;

    // Map and upsert to unified_events table
    const unifiedEventRow = mapToUnifiedEvent(e);
    await upsertUnifiedEvent(pool, unifiedEventRow);

    for (const m of e.markets ?? []) {
      // Store market in Kalshi-specific table
      await upsertKalshiMarket(m);
      processedMarkets++;

      // Map and upsert to unified_markets table
      const unifiedMarketRow = mapToUnifiedMarket(m, e.event_ticker);
      await upsertUnifiedMarket(pool, unifiedMarketRow);

      // Still need to store tokens in the shared tokens table for orderbook functionality
      const marketUuid = uuid();
      for (const t of mapTokens(marketUuid, m.ticker)) {
        await upsertToken(t);
      }
      topTickers.push(m.ticker);
    }

    // Log progress every 50 events
    if (processedEvents % 50 === 0) {
      console.log(`[Bootstrap] Processed ${processedEvents}/${events.length} events, ${processedMarkets} markets`);
    }
  }

  console.log(`[Bootstrap] Database storage complete: ${processedEvents} events, ${processedMarkets} markets`);

  const snapTickers = topTickers.slice(0, env.topBookSnapshot);
  const q = new PQueue({ interval: 10_000, intervalCap: 180 }); // ~18 rps
  await Promise.all(
    snapTickers.map((t) =>
      q.add(async () => {
        try {
          const tops = await getOrderbookTop(t);
          for (const s of tops) {
            const tokenId = `kalshi:${t}:${s.side}`;
            await writeBookTop(tokenId, s.bestBid, s.bestAsk, s.ts);
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
              { EX: 5 }
            );
          }
        } catch (e) {
          console.warn("book snapshot failed for", t, String(e));
        }
      })
    )
  );

  console.log(
    `Bootstrap complete: events=${events.length}, markets=${topTickers.length}, books=${snapTickers.length}`
  );

  // WS needs tickers, not token_ids; return tickers
  return Array.from(new Set(snapTickers));
}
