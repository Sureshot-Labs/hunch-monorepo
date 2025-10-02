import { ensureRedis } from "../../indexer-polymarket/src/redis";
import { env } from "./env";
import { log } from "../../indexer-polymarket/src/log";
import { fetchAllActive } from "./limitlessClient";
import {
  getVenueId,
  upsertEvent,
  upsertMarket,
  upsertToken,
  writeBookTop,
} from "../../indexer-polymarket/src/repo";
import { mapEventRow, mapMarketRow, mapTokens } from "./mappers";

export async function bootstrapLimitless() {
  await ensureRedis(); // optional
  const venueId = env.venueId || (await getVenueId(env.venueName));
  log.info("Bootstrapping Limitless…");

  const markets = await fetchAllActive(
    env.bootstrapMaxPages,
    env.bootstrapPageSize
  );

  let eventCount = 0;
  let marketCount = 0;

  for (const lm of markets) {
    const eRow = mapEventRow(venueId, lm);
    const eventUuid = await upsertEvent(eRow);
    eventCount++;

    const mRow = mapMarketRow(venueId, eventUuid, lm);
    const {
      id: marketUuid,
      clob_token_yes: yes,
      clob_token_no: no,
    } = await upsertMarket(mRow);
    marketCount++;

    // register pseudo tokens
    if (yes && no) {
      for (const t of mapTokens(marketUuid, yes, no)) await upsertToken(t);

      // write a top-of-book snapshot if prices provided
      if (env.writePriceSnapshots) {
        // prices are 0..1 decimals in mRow.raw.normalizedPrices
        const np = (mRow.raw?.normalizedPrices ?? {}) as {
          yes?: number | null;
          no?: number | null;
        };
        const now = new Date();
        // interpret price% as best_ask for YES, and best_ask for NO. Bid is unknown; leave null.
        if (typeof np.yes === "number")
          await writeBookTop(yes, null, np.yes, now);
        if (typeof np.no === "number") await writeBookTop(no, null, np.no, now);
      }
    }
  }

  log.info(`Bootstrap complete: events=${eventCount} markets=${marketCount}`);
}
