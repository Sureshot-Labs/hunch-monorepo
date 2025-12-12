import { ensureRedis, redis } from "./redis";
import { env } from "./env";
import { iterateEvents } from "./gammaClient";
import { postBooksOnce } from "./clobClient";
import {
  upsertPolymarketEvent,
  upsertPolymarketMarket,
} from "./polymarket-repo";
import {
  mapPolymarketEventRow,
  mapPolymarketMarketRow,
  mapToUnifiedEvent,
  mapToUnifiedMarket,
} from "./mappers";
import {
  upsertUnifiedEvent,
  upsertUnifiedMarket,
  writeUnifiedBookTop,
} from "@hunch/db";
import { pool } from "./db";
import { PolymarketEvent } from "./types";
import { log } from "./log";
import PQueue from "p-queue";

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

export async function bootstrapPolymarket() {
  await ensureRedis();
  log.info("Bootstrapping Polymarket…");

  const topTokenIds = new Set<string>(); // ✅ dedup as you go
  let processedEvents = 0;
  let processedMarkets = 0;

  // Process events page-by-page to avoid loading everything into memory
  for await (const events of iterateEvents()) {
    // Parse and validate events as Polymarket events
    for (const e of events) {
      try {
        // Validate and parse event as Polymarket event
        const polyEvent = PolymarketEvent.parse(e);

        // Map and upsert to polymarket_events table
        const eRow = mapPolymarketEventRow(polyEvent);
        const eventId = await upsertPolymarketEvent(eRow);

        // Map and upsert to unified_events table
        const unifiedEventRow = mapToUnifiedEvent(polyEvent);
        await upsertUnifiedEvent(pool, unifiedEventRow);

        // Process markets
        for (const m of polyEvent.markets) {
          // Map and upsert to polymarket_markets table
          const mRow = mapPolymarketMarketRow(eventId, m);
          await upsertPolymarketMarket(mRow);

          // Map and upsert to unified_markets table
          const unifiedMarketRow = mapToUnifiedMarket(m, eventId);
          await upsertUnifiedMarket(pool, unifiedMarketRow);

          // Extract token IDs from clob_token_ids (can be array or JSON string)
          let tokenIds: string[] = [];
          if (m.clobTokenIds) {
            if (Array.isArray(m.clobTokenIds)) {
              tokenIds = m.clobTokenIds;
            } else {
              try {
                tokenIds = JSON.parse(m.clobTokenIds);
              } catch {
                // If parsing fails, handle gracefully
                tokenIds = [];
              }
            }
          }

          // Add to top tokens if market is accepting orders
          if (
            mRow.enable_order_book &&
            mRow.accepting_orders &&
            tokenIds.length > 0
          ) {
            // Add each token ID to Set for deduplication
            for (const tokenId of tokenIds) {
              topTokenIds.add(tokenId);
            }
          }

          processedMarkets++;
        }

        processedEvents++;
      } catch (err) {
        log.warn(`Failed to process event ${e.id}:`, err);
      }
    }

    // Log progress every 50 events
    if (processedEvents % 50 === 0) {
      log.info(
        `Processed ${processedEvents} events, ${processedMarkets} markets`,
      );
    }
  }

  log.info(
    `Database storage complete: ${processedEvents} events, ${processedMarkets} markets`,
  );

  // take initial book snapshots for top N tokens and warm Redis
  const snapIds = Array.from(topTokenIds).slice(0, env.topBookSnapshot);
  log.info(`Snapshotting ${snapIds.length} top books`);
  const batches = chunk(snapIds, 20);
  const q = new PQueue({ interval: 10_000, intervalCap: 45 }); // safe under /books 50/10s
  await Promise.all(
    batches.map((group) =>
      q.add(async () => {
        try {
          const books = await postBooksOnce(group);
          for (const b of books) {
            const bb = b.bids?.length ? parseFloat(b.bids[0].price) : null;
            const ba = b.asks?.length ? parseFloat(b.asks[0].price) : null;
            const ts = b.timestamp ? new Date(Number(b.timestamp)) : new Date();
            await writeUnifiedBookTop(pool, b.asset_id, bb, ba, ts);
            await redis.set(`book:${b.asset_id}`, JSON.stringify(b), { EX: 5 });
          }
        } catch (e) {
          log.warn("book snapshot failed batch", group[0], String(e));
        }
      }),
    ),
  );

  log.info(
    `Bootstrap complete: events=${processedEvents}, markets=${processedMarkets}, tokens=${topTokenIds.size}, books=${snapIds.length}`,
  );
  return snapIds;
}
