import { env } from "./env.js";
import { log } from "./log.js";
import { fetchAllActive } from "./limitlessClient.js";
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
} from "../../../packages/db/src/unified-repo";
import { pool } from "../../indexer-polymarket/src/db";

export async function bootstrapLimitless() {
  log.info("Bootstrapping Limitless…");

  const markets = await fetchAllActive(
    env.bootstrapMaxPages,
    env.bootstrapPageSize,
  );

  let eventCount = 0;
  let marketCount = 0;

  for (const lm of markets) {
    try {
      // Store the main event
      const eventRow = mapLimitlessEventRow(lm);
      const eventId = await upsertLimitlessEvent(eventRow);
      eventCount++;

      // Map and upsert to unified_events table
      const unifiedEventRow = mapToUnifiedEvent(lm);
      await upsertUnifiedEvent(pool, unifiedEventRow);

      // Handle different market types
      if (lm.marketType === "single") {
        // Single market: the market data is in the main object
        const marketRow = mapLimitlessMarketRow(eventId, lm);
        await upsertLimitlessMarket(marketRow);
        marketCount++;

        // Map and upsert to unified_markets table
        const unifiedMarketRow = mapToUnifiedMarket(lm, String(lm.id));
        await upsertUnifiedMarket(pool, unifiedMarketRow);
      } else if (lm.marketType === "group" && lm.markets) {
        // Group market: iterate through sub-markets
        for (const subMarket of lm.markets) {
          const marketRow = mapLimitlessMarketRow(eventId, subMarket);
          await upsertLimitlessMarket(marketRow);
          marketCount++;

          // Map and upsert to unified_markets table
          const unifiedMarketRow = mapToUnifiedMarket(subMarket, String(lm.id));
          await upsertUnifiedMarket(pool, unifiedMarketRow);
        }
      }

      log.info(`Processed ${lm.marketType} market: ${lm.title}`, {
        eventId,
        marketCount: lm.marketType === "single" ? 1 : lm.markets?.length || 0,
      });
    } catch (error) {
      log.err(`Failed to process market ${lm.id}: ${lm.title}`, {
        error,
        market: lm,
      });
      // Continue processing other markets
    }
  }

  log.info(`Bootstrap complete: events=${eventCount} markets=${marketCount}`);
}
