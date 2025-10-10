import { env } from "./env.js";
import { log } from "./log.js";
import { fetchAllActive } from "./limitlessClient.js";
import { upsertLimitlessEvent, upsertLimitlessMarket } from "./limitless-repo.js";
import { mapLimitlessEventRow, mapLimitlessMarketRow } from "./mappers.js";
import type { TLimitlessMarket } from "./types.js";

export async function bootstrapLimitless() {
  log.info("Bootstrapping Limitless…");

  const markets = await fetchAllActive(
    env.bootstrapMaxPages,
    env.bootstrapPageSize
  );

  let eventCount = 0;
  let marketCount = 0;

  for (const lm of markets) {
    try {
      // Store the main event
      const eventRow = mapLimitlessEventRow(lm);
      const eventId = await upsertLimitlessEvent(eventRow);
      eventCount++;

      // Handle different market types
      if (lm.marketType === "single") {
        // Single market: the market data is in the main object
        const marketRow = mapLimitlessMarketRow(eventId, lm as any);
        await upsertLimitlessMarket(marketRow);
        marketCount++;
      } else if (lm.marketType === "group" && lm.markets) {
        // Group market: iterate through sub-markets
        for (const subMarket of lm.markets) {
          const marketRow = mapLimitlessMarketRow(eventId, subMarket);
          await upsertLimitlessMarket(marketRow);
          marketCount++;
        }
      }

      log.info(`Processed ${lm.marketType} market: ${lm.title}`, {
        eventId,
        marketCount: lm.marketType === "single" ? 1 : lm.markets?.length || 0
      });
    } catch (error) {
      log.err(`Failed to process market ${lm.id}: ${lm.title}`, { error, market: lm });
      // Continue processing other markets
    }
  }

  log.info(`Bootstrap complete: events=${eventCount} markets=${marketCount}`);
}
