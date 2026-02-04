import { chunkArray } from "@hunch/shared";
import { ensureRedis, redis } from "./redis.js";
import { env } from "./env.js";
import { fetchEventsByIds, iterateEventPages } from "./gammaClient.js";
import { postBooksOnce } from "./clobClient.js";
import {
  upsertPolymarketEvents,
  upsertPolymarketMarkets,
} from "./polymarket-repo.js";
import {
  mapPolymarketEventRow,
  mapPolymarketMarketRow,
  mapTokens,
  mapToUnifiedEvent,
  mapToUnifiedMarket,
} from "./mappers.js";
import {
  upsertUnifiedEvents,
  upsertUnifiedMarkets,
  upsertUnifiedTokens,
  writeUnifiedBookTop,
} from "@hunch/db";
import {
  buildTopMarketsText,
  enqueueEmbedItems,
  isPgSetupIssue,
  type EmbedQueueItem,
} from "@hunch/infra";
import { pool } from "./db.js";
import { PolymarketEvent, type TPolymarketEvent } from "./types.js";
import { log } from "./log.js";
import PQueue from "p-queue";
import {
  getPolymarketEventsOffset,
  resetPolymarketEventsOffset,
  setPolymarketEventsOffset,
} from "./cursor.js";

function parsePrice(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function bestBid(levels: Array<{ price: string }> | undefined): number | null {
  if (!levels || levels.length === 0) return null;
  let best: number | null = null;
  for (const level of levels) {
    const p = parsePrice(level.price);
    if (p == null) continue;
    if (best == null || p > best) best = p;
  }
  return best;
}

function bestAsk(levels: Array<{ price: string }> | undefined): number | null {
  if (!levels || levels.length === 0) return null;
  let best: number | null = null;
  for (const level of levels) {
    const p = parsePrice(level.price);
    if (p == null) continue;
    if (best == null || p < best) best = p;
  }
  return best;
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
  const parsedEvents: TPolymarketEvent[] = [];

  for (const e of events) {
    try {
      const polyEvent = PolymarketEvent.parse(e);
      parsedEvents.push(polyEvent);
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

  if (!parsedEvents.length) return { processedEvents: 0, processedMarkets: 0 };

  const polymarketEventRows = parsedEvents.map(mapPolymarketEventRow);
  const unifiedEventRows = parsedEvents.map(mapToUnifiedEvent);

  const polymarketMarketRows = parsedEvents.flatMap((event) =>
    event.markets.map((market) => mapPolymarketMarketRow(event.id, market)),
  );
  const unifiedMarketRows = parsedEvents.flatMap((event) =>
    event.markets.map((market) => mapToUnifiedMarket(market, event.id)),
  );
  const unifiedTokenRows = parsedEvents.flatMap((event) =>
    event.markets.flatMap((market) => {
      const [yes, no] = Array.isArray(market.clobTokenIds)
        ? market.clobTokenIds
        : [];
      return mapTokens(`polymarket:${market.id}`, yes ?? null, no ?? null);
    }),
  );

  await Promise.all([
    upsertPolymarketEvents(polymarketEventRows),
    upsertUnifiedEvents(pool, unifiedEventRows),
  ]);

  await Promise.all([
    upsertPolymarketMarkets(polymarketMarketRows),
    upsertUnifiedMarkets(pool, unifiedMarketRows),
  ]);
  if (unifiedTokenRows.length) {
    await upsertUnifiedTokens(pool, unifiedTokenRows);
  }

  try {
    const eventTitleById = new Map(
      unifiedEventRows.map((row) => [row.id, row.title]),
    );
    const marketsByEvent = new Map<string, typeof unifiedMarketRows>();
    for (const row of unifiedMarketRows) {
      const list = marketsByEvent.get(row.event_id) ?? [];
      list.push(row);
      marketsByEvent.set(row.event_id, list);
    }
    const topMarketsByEvent = new Map<string, string>();
    for (const row of unifiedEventRows) {
      const markets = marketsByEvent.get(row.id) ?? [];
      const topMarkets = buildTopMarketsText(markets, row.title);
      if (topMarkets) topMarketsByEvent.set(row.id, topMarkets);
    }
    const embedEvents: EmbedQueueItem[] = unifiedEventRows.map((row) => ({
      entity_type: "event",
      event_id: row.id,
      venue: row.venue,
      status: row.status,
      event_title: row.title,
      top_markets: topMarketsByEvent.get(row.id),
      description: row.description,
      category: row.category,
      updated_at: row.updated_at ?? row.created_at,
      source: "polymarket",
    }));
    const embedMarkets: EmbedQueueItem[] = unifiedMarketRows.map((row) => ({
      entity_type: "market",
      market_id: row.id,
      venue: row.venue,
      status: row.status,
      market_title: row.title,
      event_title: eventTitleById.get(row.event_id),
      description: row.description,
      category: row.category,
      outcomes: row.outcomes,
      market_type: row.market_type,
      updated_at: row.updated_at ?? row.created_at,
      source: "polymarket",
    }));
    await enqueueEmbedItems(redis, [...embedEvents, ...embedMarkets]);
  } catch (err) {
    log.warn("Polymarket embed enqueue failed", err);
  }

  return {
    processedEvents: parsedEvents.length,
    processedMarkets: polymarketMarketRows.length,
  };
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

  const batches = chunkArray(snapIds, 20);
  const q = new PQueue({ interval: 10_000, intervalCap: 45 }); // safe under /books 50/10s
  await Promise.all(
    batches.map((group) =>
      q.add(async () => {
        try {
          const books = await postBooksOnce(group);
          for (const b of books) {
            const bb = bestBid(b.bids);
            const ba = bestAsk(b.asks);
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

function splitBudget(total: number, hotShare: number): { hotBudget: number } {
  const clampedShare = Math.max(0, Math.min(1, hotShare));
  const hotBudget = Math.max(0, Math.min(total, Math.round(total * clampedShare)));
  return { hotBudget };
}

async function fetchHotTokenIds(): Promise<string[]> {
  if (env.hotTokensMax <= 0) return [];
  await ensureRedis();

  const key = "hot:tokens:polymarket";
  const cutoff = Date.now() - env.hotTokensTtlSec * 1000;

  try {
    await redis.zRemRangeByScore(key, 0, cutoff);
    return await redis.zRange(key, 0, env.hotTokensMax - 1, { REV: true });
  } catch (error) {
    log.warn("Failed to fetch hot tokens", error);
    return [];
  }
}

async function fetchHotMarketsByTokenIds(
  tokenIds: string[],
): Promise<Array<{ marketId: string; tokenIds: string[] }>> {
  if (!tokenIds.length) return [];
  const { rows } = await pool.query<{
    id: string | null;
    clob_token_ids: unknown;
  }>(
    `
      select id, clob_token_ids
      from polymarket_markets
      where clob_token_ids is not null
        and clob_token_ids <> '[]'
        and (clob_token_ids::jsonb ?| $1::text[])
    `,
    [tokenIds],
  );

  const markets: Array<{ marketId: string; tokenIds: string[] }> = [];
  for (const row of rows) {
    if (!row.id) continue;
    const ids = parseJsonStringArray(row.clob_token_ids);
    if (!ids.length) continue;
    markets.push({ marketId: row.id, tokenIds: ids });
  }
  return markets;
}

async function buildHotTokenList(
  hotTokenIds: string[],
  hotBudget: number,
): Promise<string[]> {
  if (!hotTokenIds.length || hotBudget <= 0) return [];
  const markets = await fetchHotMarketsByTokenIds(hotTokenIds);
  if (!markets.length) return [];

  const tokenToMarket = new Map<
    string,
    { marketId: string; tokenIds: string[] }
  >();
  for (const market of markets) {
    for (const tokenId of market.tokenIds) {
      if (!tokenToMarket.has(tokenId)) tokenToMarket.set(tokenId, market);
    }
  }

  const seenMarkets = new Set<string>();
  const seenTokens = new Set<string>();
  const out: string[] = [];

  for (const tokenId of hotTokenIds) {
    const market = tokenToMarket.get(tokenId);
    if (!market) continue;
    if (seenMarkets.has(market.marketId)) continue;
    seenMarkets.add(market.marketId);
    for (const next of market.tokenIds) {
      if (seenTokens.has(next)) continue;
      seenTokens.add(next);
      out.push(next);
      if (out.length >= hotBudget) return out;
    }
  }

  return out;
}

async function fetchTopTokens(
  limitTokens: number,
  exclude: Set<string>,
): Promise<string[]> {
  if (limitTokens <= 0) return [];
  const limitMarkets = Math.max(100, limitTokens * 2);
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
  for (const row of rows) {
    const tokenIds = parseJsonStringArray(
      (row as { clob_token_ids?: unknown }).clob_token_ids,
    );
    for (const tokenId of tokenIds) {
      if (exclude.has(tokenId)) continue;
      exclude.add(tokenId);
      out.push(tokenId);
      if (out.length >= limitTokens) return out;
    }
  }
  return out;
}

export async function selectHotTokenIds(): Promise<string[]> {
  return fetchHotTokenIds();
}

async function fetchHotEventIdsFromTokens(): Promise<string[]> {
  const tokenIds = await fetchHotTokenIds();
  if (!tokenIds.length) return [];

  const { rows } = await pool.query<{ event_id: string }>(
    `
      select distinct event_id
      from polymarket_markets
      where clob_token_ids is not null
        and clob_token_ids <> '[]'
        and (clob_token_ids::jsonb ?| $1::text[])
      limit $2
    `,
    [tokenIds, env.hotStatusMaxEvents],
  );

  return rows.map((row) => row.event_id).filter(Boolean);
}

export async function syncHotEventStatuses(): Promise<void> {
  const eventIds = await fetchHotEventIdsFromTokens();
  if (!eventIds.length) return;

  log.info("Polymarket hot status refresh", {
    events: eventIds.length,
  });

  const events = await fetchEventsByIds(eventIds);
  if (!events.length) return;
  const result = await processEvents(events as unknown[]);

  log.info("Polymarket hot status refresh complete", {
    events: result.processedEvents,
    markets: result.processedMarkets,
  });
}

export async function selectWsTokenIds(): Promise<string[]> {
  const { hotBudget } = splitBudget(env.wsSubset, env.wsHotShare);
  const hotTokenIds = await fetchHotTokenIds();
  const hotTokens = await buildHotTokenList(hotTokenIds, hotBudget);

  const seen = new Set<string>(hotTokens);
  const remaining = Math.max(0, env.wsSubset - hotTokens.length);
  const topTokens = await fetchTopTokens(remaining, seen);

  return [...hotTokens, ...topTokens];
}
