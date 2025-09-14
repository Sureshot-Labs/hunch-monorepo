import { ensureRedis, redis } from "./redis";
import { env } from "./env";
import { fetchAllEvents } from "./gammaClient";
import { getBook, postBooks, postBooksOnce } from "./clobClient";
import {
  getVenueId,
  upsertEvent,
  upsertMarket,
  upsertToken,
  writeBookTop,
} from "./repo";
import { mapEventRow, mapMarketRow, mapTokens } from "./mappers";
import { log } from "./log";
import PQueue from "p-queue";

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

export async function bootstrapPolymarket() {
  await ensureRedis();
  const venueId = await getVenueId("polymarket");
  log.info("Bootstrapping Polymarket…");

  const events = await fetchAllEvents(env.bootstrapLimit);

  const topTokenIds: string[] = [];

  for (const e of events) {
    const eRow = mapEventRow(venueId, e);
    const eventUuid = await upsertEvent(eRow);

    for (const m of e.markets) {
      const mRow = mapMarketRow(venueId, eventUuid, m);
      const {
        id: marketUuid,
        clob_token_yes: yes,
        clob_token_no: no,
      } = await upsertMarket(mRow);

      if (mRow.enable_orderbook && mRow.accepting_orders) {
        if (yes) topTokenIds.push(yes);
        if (no) topTokenIds.push(no);
      }

      for (const t of mapTokens(
        marketUuid,
        yes ?? undefined,
        no ?? undefined
      )) {
        await upsertToken(t);
      }
    }
  }

  // take initial book snapshots for top N tokens and warm Redis
  const snapIds = topTokenIds.slice(0, env.topBookSnapshot);
  log.info(`Snapshotting ${snapIds.length} top books`);
  const batches = chunk(snapIds, 20);
  const q = new PQueue({ interval: 10_000, intervalCap: 45 }); // safe under /books 50/10s
  await Promise.all(
    batches.map((group: any) =>
      q.add(async () => {
        try {
          const books = await postBooksOnce(group);
          for (const b of books) {
            const bb = b.bids?.length ? parseFloat(b.bids[0].price) : null;
            const ba = b.asks?.length ? parseFloat(b.asks[0].price) : null;
            const ts = b.timestamp ? new Date(Number(b.timestamp)) : new Date();
            await writeBookTop(b.asset_id, bb, ba, ts);
            await redis.set(`book:${b.asset_id}`, JSON.stringify(b), { EX: 5 });
          }
        } catch (e) {
          log.warn("book snapshot failed batch", group[0], String(e));
        }
      })
    )
  );

  log.info(
    `Bootstrap complete: events=${events.length}, tokensSnapshotted=${snapIds.length}`
  );
  return snapIds;
}
