import { ensureRedis, redis } from "./redis";
import { env } from "./env";
import { iterateEventPages } from "./gammaClient";
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
import { isPgSetupIssue } from "@hunch/infra";
import { pool } from "./db";
import { PolymarketEvent } from "./types";
import { log } from "./log";
import PQueue from "p-queue";
import {
  getPolymarketEventsOffset,
  resetPolymarketEventsOffset,
  setPolymarketEventsOffset,
} from "./cursor";

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

type SyncCounters = {
  processedEvents: number;
  processedMarkets: number;
  pages: number;
};

type ProcessResult = {
  processedEvents: number;
  processedMarkets: number;
};

async function hasAnyPolymarketData(): Promise<boolean> {
  const { rows } = await pool.query("select 1 from polymarket_events limit 1");
  return rows.length > 0;
}

async function processEvents(events: unknown[]): Promise<ProcessResult> {
  let processedEvents = 0;
  let processedMarkets = 0;

  for (const e of events) {
    try {
      const polyEvent = PolymarketEvent.parse(e);

      const eRow = mapPolymarketEventRow(polyEvent);
      const eventId = await upsertPolymarketEvent(eRow);

      const unifiedEventRow = mapToUnifiedEvent(polyEvent);
      await upsertUnifiedEvent(pool, unifiedEventRow);

      for (const m of polyEvent.markets) {
        const mRow = mapPolymarketMarketRow(eventId, m);
        await upsertPolymarketMarket(mRow);

        const unifiedMarketRow = mapToUnifiedMarket(m, eventId);
        await upsertUnifiedMarket(pool, unifiedMarketRow);

        processedMarkets += 1;
      }

      processedEvents += 1;
    } catch (err) {
      if (isPgSetupIssue(err)) throw err;
      const id = (() => {
        if (typeof e !== "object" || e === null) return "?";
        if (!("id" in e)) return "?";
        const raw = (e as { id?: unknown }).id;
        return typeof raw === "string" ? raw : "?";
      })();
      log.warn(`Failed to process event ${id}:`, err);
    }
  }

  return { processedEvents, processedMarkets };
}

function parseDateOrNull(v: unknown): Date | null {
  if (typeof v !== "string") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function syncCatchUpFromCursor(): Promise<SyncCounters> {
  await ensureRedis();
  await pool.query("select 1");

  const hasData = await hasAnyPolymarketData();
  if (!hasData) await resetPolymarketEventsOffset();

  const cursorOffset = await getPolymarketEventsOffset();
  const overlap = env.overlapPages * env.pageSize;
  const startOffset = Math.max(0, cursorOffset - overlap);

  log.info("Polymarket catch-up…", {
    cursorOffset,
    startOffset,
    pageSize: env.pageSize,
    overlapPages: env.overlapPages,
  });

  const totals: SyncCounters = {
    processedEvents: 0,
    processedMarkets: 0,
    pages: 0,
  };

  for await (const page of iterateEventPages({
    label: "catch-up",
    startOffset,
    pageSize: env.pageSize,
    order: "id",
    ascending: true,
    active: true,
    archived: false,
  })) {
    totals.pages += 1;
    const r = await processEvents(page.events as unknown[]);
    totals.processedEvents += r.processedEvents;
    totals.processedMarkets += r.processedMarkets;

    const nextOffset = page.offset + page.events.length;
    await setPolymarketEventsOffset(nextOffset);

    if (totals.pages % 5 === 0) {
      log.info("Polymarket catch-up progress", {
        pages: totals.pages,
        events: totals.processedEvents,
        markets: totals.processedMarkets,
        cursor: nextOffset,
      });
    }
  }

  log.info("Polymarket catch-up complete", totals);
  return totals;
}

async function syncHotPass(closed: boolean): Promise<SyncCounters> {
  const label = closed ? "hot-closed" : "hot-open";
  const lookbackMin = env.hotLookbackMinutes;
  const threshold = new Date(Date.now() - lookbackMin * 60_000);

  log.info("Polymarket hot refresh…", {
    label,
    closed,
    pageSize: env.pageSize,
    lookbackMin,
    maxPages: env.hotMaxPages,
  });

  const totals: SyncCounters = {
    processedEvents: 0,
    processedMarkets: 0,
    pages: 0,
  };

  let stoppedByLookback = false;
  let hitMaxPages = false;

  for await (const page of iterateEventPages({
    label,
    startOffset: 0,
    pageSize: env.pageSize,
    maxPages: env.hotMaxPages,
    order: "updatedAt",
    ascending: false,
    closed,
    active: true,
    archived: false,
  })) {
    totals.pages += 1;
    const r = await processEvents(page.events as unknown[]);
    totals.processedEvents += r.processedEvents;
    totals.processedMarkets += r.processedMarkets;

    const oldestUpdatedAt = (() => {
      if (page.events.length === 0) return null;
      const last = page.events[page.events.length - 1] as unknown;
      if (typeof last !== "object" || last === null) return null;
      if (!("updatedAt" in last)) return null;
      return parseDateOrNull((last as { updatedAt?: unknown }).updatedAt);
    })();

    if (oldestUpdatedAt && oldestUpdatedAt < threshold) {
      stoppedByLookback = true;
      break;
    }
  }

  if (!stoppedByLookback && totals.pages >= env.hotMaxPages) {
    hitMaxPages = true;
  }

  if (hitMaxPages) {
    log.warn("Polymarket hot refresh hit max pages cap", { label, ...totals });
  } else {
    log.info("Polymarket hot refresh complete", { label, ...totals });
  }

  return totals;
}

export async function syncHotWindow(): Promise<SyncCounters> {
  await ensureRedis();
  await pool.query("select 1");

  const open = await syncHotPass(false);
  const closed = await syncHotPass(true);

  return {
    processedEvents: open.processedEvents + closed.processedEvents,
    processedMarkets: open.processedMarkets + closed.processedMarkets,
    pages: open.pages + closed.pages,
  };
}

export async function snapshotBooks(tokenIds: string[]): Promise<void> {
  if (tokenIds.length === 0) return;
  await ensureRedis();
  await pool.query("select 1");

  const snapIds = tokenIds.slice(0, env.topBookSnapshot);
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
            await redis.set(
              `top:${b.asset_id}`,
              JSON.stringify({
                token_id: b.asset_id,
                best_bid: bb,
                best_ask: ba,
                ts: ts.getTime(),
              }),
              { EX: 60 },
            );
          }
        } catch (e) {
          if (isPgSetupIssue(e)) throw e;
          log.warn("book snapshot failed batch", group[0], String(e));
        }
      }),
    ),
  );
}

function parseJsonStringArray(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((x): x is string => typeof x === "string")
      : [];
  } catch {
    return [];
  }
}

export async function selectWsTokenIds(): Promise<string[]> {
  const limitMarkets = Math.max(100, env.wsSubset * 2);
  const { rows } = await pool.query(
    `
    select clob_token_ids
    from polymarket_markets
    where closed = false
      and archived = false
      and enable_order_book = true
      and accepting_orders = true
      and clob_token_ids is not null
      and clob_token_ids <> '[]'
    order by
      coalesce(volume24hr_clob, 0) desc,
      coalesce(liquidity_clob, 0) desc,
      coalesce(volume24hr, 0) desc,
      coalesce(liquidity, 0) desc
    limit $1
    `,
    [limitMarkets],
  );

  const out: string[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    const tokenIds = parseJsonStringArray(
      (row as { clob_token_ids?: unknown }).clob_token_ids,
    );
    for (const tokenId of tokenIds) {
      if (seen.has(tokenId)) continue;
      seen.add(tokenId);
      out.push(tokenId);
      if (out.length >= env.wsSubset) return out;
    }
  }

  return out;
}
