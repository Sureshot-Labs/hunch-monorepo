// apps/indexer-kalshi/src/bootstrap.ts
import { ensureRedis, redis } from "../../indexer-polymarket/src/redis";
import { env } from "./env";
import { iterateEventsWithMarkets } from "./marketClient";
import {
  getVenueId,
  upsertToken,
  writeBookTop,
} from "../../indexer-polymarket/src/repo";
import { mapTokens, mapToUnifiedEvent, mapToUnifiedMarket } from "./mappers";
import { upsertKalshiEvent, upsertKalshiMarket } from "./kalshi-repo";
import {
  upsertUnifiedEvent,
  upsertUnifiedMarket,
} from "../../../packages/db/src/unified-repo";
import { pool } from "../../indexer-polymarket/src/db";
import PQueue from "p-queue";
import { getOrderbookTop } from "./orderbookClient";
import { v4 as uuid } from "uuid";

export async function bootstrapKalshi() {
  await ensureRedis();
  const venueId = await getVenueId("kalshi");
  console.log("Bootstrapping Kalshi…", venueId);

  console.log(`[Bootstrap] Starting to process events (all statuses)...`);

  const topTickers = new Set<string>(); // ✅ dedup as you go
  let processedEvents = 0;
  let processedMarkets = 0;

  // Fetch all markets regardless of status so we can update closed/settled markets in DB
  // API supports fetching all statuses by omitting the status parameter
  for await (const events of iterateEventsWithMarkets()) {
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
        topTickers.add(m.ticker);
      }
    }

    // Log progress every 50 events
    if (processedEvents % 50 === 0) {
      console.log(
        `[Bootstrap] Processed ${processedEvents} events, ${processedMarkets} markets`,
      );
    }
  }

  console.log(
    `[Bootstrap] Database storage complete: ${processedEvents} events, ${processedMarkets} markets`,
  );

  const snapTickers = Array.from(topTickers).slice(0, env.topBookSnapshot);
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
              { EX: 5 },
            );
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
