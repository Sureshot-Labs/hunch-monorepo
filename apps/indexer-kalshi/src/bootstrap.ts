// apps/indexer-kalshi/src/bootstrap.ts
import { ensureRedis, redis } from "../../indexer-polymarket/src/redis";
import { env } from "./env";
import { fetchAllEventsWithNestedMarkets } from "./marketClient";
import {
  getVenueId,
  upsertEvent,
  upsertMarket,
  upsertToken,
  writeBookTop,
} from "../../indexer-polymarket/src/repo";
import { mapEventRow, mapMarketRow, mapTokens } from "./mappers";
import PQueue from "p-queue";
import { getOrderbookTop } from "./orderbookClient";

export async function bootstrapKalshi() {
  await ensureRedis();
  const venueId = await getVenueId("kalshi");
  console.log("Bootstrapping Kalshi…", venueId);

  const events = await fetchAllEventsWithNestedMarkets(
    env.bootstrapLimit,
    "open"
  );
  console.log(`Fetched ${events.length} events (with nested markets)`);

  const topTickers: string[] = [];

  for (const e of events) {
    const eventUuid = await upsertEvent(mapEventRow(venueId, e));

    for (const m of e.markets ?? []) {
      const { id: marketUuid, clob_token_yes: yesTok } = await upsertMarket(
        mapMarketRow(venueId, eventUuid, m)
      );

      for (const t of mapTokens(marketUuid, m.ticker)) {
        await upsertToken(t);
      }
      if (yesTok) topTickers.push(m.ticker);
    }
  }

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
