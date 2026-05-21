import { chunkArray } from "@hunch/shared";
import { ensureRedis, redis } from "./redis.js";
import { env } from "./env.js";
import {
  fetchEventsByIds,
  fetchEventsByIdsDetailed,
  fetchMarketById,
  iterateEventPages,
} from "./gammaClient.js";
import { postBooksOnce } from "./clobClient.js";
import {
  mapPolymarketEventRow,
  mapPolymarketMarketRow,
  mapTokens,
  mapToUnifiedEvent,
  mapToUnifiedMarket,
} from "./mappers.js";
import { upsertUnifiedTokens, writeUnifiedBookTops } from "@hunch/db";
import {
  upsertEventsConsistently,
  upsertMarketsConsistently,
} from "./consistentUpserts.js";
import {
  buildTopMarketsText,
  claimDuePriceRefreshTokens,
  enqueueEmbedItems,
  getPriceRefreshQueueBacklog,
  isPgSetupIssue,
  publishMarketState,
  requeuePriceRefreshTokens,
  type EmbedQueueItem,
  type PriceRefreshRedis,
} from "@hunch/infra";
import { pool } from "./db.js";
import {
  PolymarketEvent,
  PolymarketMarket,
  type TEvent,
  type TPolymarketEvent,
  type TPolymarketMarket,
} from "./types.js";
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

function clobTokenPair(market: TPolymarketMarket): {
  yes: string | null;
  no: string | null;
} {
  const raw = market.clobTokenIds;
  if (Array.isArray(raw)) {
    return { yes: raw[0] ?? null, no: raw[1] ?? null };
  }
  if (typeof raw !== "string") return { yes: null, no: null };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return { yes: null, no: null };
    return {
      yes: typeof parsed[0] === "string" ? parsed[0] : null,
      no: typeof parsed[1] === "string" ? parsed[1] : null,
    };
  } catch {
    return { yes: null, no: null };
  }
}

function publishedMarketStatus(
  market: ReturnType<typeof mapToUnifiedMarket> | undefined,
): string | null {
  if (!market) return null;
  if (market.resolved_outcome || market.resolved_outcome_pct != null) {
    return "SETTLED";
  }
  return market.status ?? null;
}

type SyncCounters = {
  processedEvents: number;
  processedMarkets: number;
  pages: number;
};

type ProcessResult = {
  processedEvents: number;
  processedMarkets: number;
  timings?: Record<string, number>;
};

function createTimings(): Record<string, number> {
  return {};
}

async function timedPhase<T>(
  timings: Record<string, number>,
  phase: string,
  run: () => Promise<T>,
  context: Record<string, unknown> = {},
): Promise<T> {
  const startedAt = Date.now();
  try {
    return await run();
  } finally {
    const durationMs = Date.now() - startedAt;
    timings[phase] = (timings[phase] ?? 0) + durationMs;
    if (durationMs >= env.slowPhaseWarnMs) {
      log.warn("Polymarket slow phase", {
        phase,
        durationMs,
        ...context,
      });
    }
  }
}

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

  const timings = createTimings();
  const polymarketEventRows = parsedEvents.map(mapPolymarketEventRow);
  const unifiedEventRows = parsedEvents.map(mapToUnifiedEvent);

  const polymarketMarketRows = parsedEvents.flatMap((event) =>
    event.markets.map((market) => mapPolymarketMarketRow(event.id, market)),
  );
  const unifiedMarketRows = parsedEvents.flatMap((event) =>
    event.markets.map((market) => mapToUnifiedMarket(market, event.id, event)),
  );
  const unifiedTokenRows = parsedEvents.flatMap((event) =>
    event.markets.flatMap((market) => {
      const [yes, no] = Array.isArray(market.clobTokenIds)
        ? market.clobTokenIds
        : [];
      return mapTokens(`polymarket:${market.id}`, yes ?? null, no ?? null);
    }),
  );

  const eventUpsertResult = await timedPhase(
    timings,
    "processEvents.eventUpsert",
    () =>
      upsertEventsConsistently(pool, {
        unified: unifiedEventRows,
        polymarket: polymarketEventRows,
      }),
    { events: parsedEvents.length },
  );
  log.info("Polymarket event upsert stats", {
    events: parsedEvents.length,
    unifiedInputRows: eventUpsertResult.unified.inputRows,
    unifiedDedupedRows: eventUpsertResult.unified.dedupedRows,
    unifiedChangedRows: eventUpsertResult.unified.changedRows,
    unifiedSkippedRows: eventUpsertResult.unified.skippedRows,
    unifiedUpsertedRows: eventUpsertResult.unified.upsertedRows,
    unifiedBatches: eventUpsertResult.unified.batches,
    polymarketInputRows: eventUpsertResult.polymarket.inputRows,
    polymarketDedupedRows: eventUpsertResult.polymarket.dedupedRows,
    polymarketChangedRows: eventUpsertResult.polymarket.changedRows,
    polymarketSkippedRows: eventUpsertResult.polymarket.skippedRows,
    polymarketUpsertedRows: eventUpsertResult.polymarket.upsertedRows,
    polymarketBatches: eventUpsertResult.polymarket.batches,
  });

  const marketUpsertResult = await timedPhase(
    timings,
    "processEvents.marketUpsert",
    () =>
      upsertMarketsConsistently(
        pool,
        {
          unified: unifiedMarketRows,
          polymarket: polymarketMarketRows,
        },
        {
          unifiedBatchSize: env.marketUpsertBatchSize,
        },
      ),
    { markets: unifiedMarketRows.length },
  );
  log.info("Polymarket market upsert stats", {
    markets: unifiedMarketRows.length,
    polymarketInputRows: marketUpsertResult.polymarket.inputRows,
    polymarketDedupedRows: marketUpsertResult.polymarket.dedupedRows,
    polymarketChangedRows: marketUpsertResult.polymarket.changedRows,
    polymarketSkippedRows: marketUpsertResult.polymarket.skippedRows,
    polymarketUpsertedRows: marketUpsertResult.polymarket.upsertedRows,
    polymarketBatches: marketUpsertResult.polymarket.batches,
    unifiedInputRows: marketUpsertResult.unified.inputRows,
    unifiedDedupedRows: marketUpsertResult.unified.dedupedRows,
    unifiedChangedRows: marketUpsertResult.unified.changedRows,
    unifiedSkippedRows: marketUpsertResult.unified.skippedRows,
    unifiedUpsertedRows: marketUpsertResult.unified.upsertedRows,
    unifiedBatches: marketUpsertResult.unified.batches,
    unifiedTokenSyncMarketCount:
      marketUpsertResult.unified.tokenSyncMarketCount,
  });

  if (unifiedTokenRows.length) {
    const tokenUpsertResult = await timedPhase(
      timings,
      "processEvents.tokenUpsert",
      () => upsertUnifiedTokens(pool, unifiedTokenRows),
      { tokens: unifiedTokenRows.length },
    );
    log.info("Polymarket token upsert stats", {
      context: "processEvents",
      tokens: unifiedTokenRows.length,
      inputRows: tokenUpsertResult.inputRows,
      dedupedRows: tokenUpsertResult.dedupedRows,
      changedRows: tokenUpsertResult.changedRows,
      skippedRows: tokenUpsertResult.skippedRows,
      upsertedRows: tokenUpsertResult.upsertedRows,
      batches: tokenUpsertResult.batches,
    });
  }

  try {
    await timedPhase(
      timings,
      "processEvents.embedEnqueue",
      async () => {
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
      },
      { events: unifiedEventRows.length, markets: unifiedMarketRows.length },
    );
  } catch (err) {
    if (isPgSetupIssue(err)) throw err;
    log.warn("Polymarket embed enqueue failed", err);
  }

  return {
    processedEvents: parsedEvents.length,
    processedMarkets: polymarketMarketRows.length,
    timings,
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
  const maxOffset = env.gammaMaxEventsOffset;

  log.info("Polymarket catch-up…", {
    cursorOffset,
    startOffset,
    pageSize: env.pageSize,
    overlapPages: env.overlapPages,
    maxOffset,
  });

  const totals: SyncCounters = {
    processedEvents: 0,
    processedMarkets: 0,
    pages: 0,
  };

  if (startOffset > maxOffset) {
    log.warn("Polymarket catch-up skipped: cursor exceeds Gamma offset cap", {
      cursorOffset,
      startOffset,
      maxOffset,
      reason:
        "Gamma /events rejects offsets above this cap; hot refresh and websocket sync still cover recent/active changes.",
    });
    return totals;
  }

  for await (const page of iterateEventPages({
    label: "catch-up",
    startOffset,
    pageSize: env.pageSize,
    maxOffset,
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

export async function snapshotBooks(tokenIds: string[]): Promise<{
  requested: number;
  failedTokenIds: string[];
  timings: Record<string, number>;
}> {
  if (tokenIds.length === 0) {
    return { requested: 0, failedTokenIds: [], timings: {} };
  }
  await ensureRedis();
  await pool.query("select 1");

  const snapIds = tokenIds.slice(0, env.topBookSnapshot);
  const failedTokenIds: string[] = [];
  const timings = createTimings();
  log.info(`Snapshotting ${snapIds.length} top books`);

  const batches = chunkArray(snapIds, 20);
  const q = new PQueue({ interval: 10_000, intervalCap: 45 }); // safe under /books 50/10s
  await Promise.all(
    batches.map((group) =>
      q.add(async () => {
        try {
          const books = await timedPhase(
            timings,
            "snapshotBooks.fetchBooks",
            () => postBooksOnce(group),
            { tokens: group.length },
          );
          await timedPhase(
            timings,
            "snapshotBooks.persistBooks",
            async () => {
              const bookTops = books.map((b) => {
                const bb = bestBid(b.bids);
                const ba = bestAsk(b.asks);
                const ts = b.timestamp
                  ? new Date(Number(b.timestamp))
                  : new Date();
                return { book: b, bestBid: bb, bestAsk: ba, ts };
              });

              await writeUnifiedBookTops(
                pool,
                bookTops.map((entry) => ({
                  tokenId: entry.book.asset_id,
                  bestBid: entry.bestBid,
                  bestAsk: entry.bestAsk,
                  ts: entry.ts,
                })),
              );

              await Promise.all(
                bookTops.map(async (entry) => {
                  const tickJson = JSON.stringify({
                    token_id: entry.book.asset_id,
                    best_bid: entry.bestBid,
                    best_ask: entry.bestAsk,
                    ts: entry.ts.getTime(),
                  });
                  await Promise.all([
                    redis.set(
                      `book:${entry.book.asset_id}`,
                      JSON.stringify(entry.book),
                      { EX: 5 },
                    ),
                    redis.set(`top:${entry.book.asset_id}`, tickJson, {
                      EX: 60,
                    }),
                    redis.publish(`prices:${entry.book.asset_id}`, tickJson),
                  ]);
                }),
              );
            },
            { tokens: books.length },
          );
        } catch (e) {
          if (isPgSetupIssue(e)) throw e;
          failedTokenIds.push(...group);
          log.warn("book snapshot failed batch", group[0], String(e));
        }
      }),
    ),
  );
  return { requested: snapIds.length, failedTokenIds, timings };
}

async function fetchEventIdsForTokenIds(
  tokenIds: string[],
  limit?: number,
): Promise<string[]> {
  if (!tokenIds.length) return [];

  const params: Array<string[] | number> = [tokenIds];
  const limitSql =
    limit != null
      ? (() => {
          params.push(Math.max(1, Math.trunc(limit)));
          return `limit $${params.length}`;
        })()
      : "";

  const { rows } = await pool.query<{ venue_event_id: string | null }>(
    `
      with requested_tokens as (
        select token_id
        from unnest($1::text[]) as t(token_id)
      ),
      token_markets as (
        select distinct m.event_id
        from requested_tokens rt
        join unified_market_tokens mt
          on mt.token_id = rt.token_id
         and mt.venue = 'polymarket'
        join unified_markets m
          on m.id = mt.market_id
         and m.venue = 'polymarket'
        union
        select distinct m.event_id
        from requested_tokens rt
        join unified_tokens t
          on t.token_id = rt.token_id
         and t.venue = 'polymarket'
        join unified_markets m
          on m.id = t.market_id
         and m.venue = 'polymarket'
      )
      select distinct e.venue_event_id
      from token_markets tm
      join unified_events e
        on e.id = tm.event_id
      where e.venue = 'polymarket'
        and e.venue_event_id is not null
      order by e.venue_event_id
      ${limitSql}
    `,
    params,
  );

  return rows
    .map((row) => row.venue_event_id)
    .filter((eventId): eventId is string => Boolean(eventId));
}

async function fetchMarketRefsForTokenIds(tokenIds: string[]): Promise<
  Array<{
    marketId: string;
    eventId: string;
  }>
> {
  if (!tokenIds.length) return [];

  const { rows } = await pool.query<{
    venue_market_id: string | null;
    venue_event_id: string | null;
  }>(
    `
      with requested_tokens as (
        select token_id, ord::int as ord
        from unnest($1::text[]) with ordinality as t(token_id, ord)
      ),
      token_markets as (
        select rt.ord, m.venue_market_id, e.venue_event_id
        from requested_tokens rt
        join unified_market_tokens mt
          on mt.token_id = rt.token_id
         and mt.venue = 'polymarket'
        join unified_markets m
          on m.id = mt.market_id
         and m.venue = 'polymarket'
        join unified_events e
          on e.id = m.event_id
         and e.venue = 'polymarket'
        union
        select rt.ord, m.venue_market_id, e.venue_event_id
        from requested_tokens rt
        join unified_tokens t
          on t.token_id = rt.token_id
         and t.venue = 'polymarket'
        join unified_markets m
          on m.id = t.market_id
         and m.venue = 'polymarket'
        join unified_events e
          on e.id = m.event_id
         and e.venue = 'polymarket'
      )
      select distinct on (venue_market_id)
        venue_market_id,
        venue_event_id
      from token_markets
      where venue_market_id is not null
        and venue_event_id is not null
      order by venue_market_id, ord
    `,
    [tokenIds],
  );

  return rows
    .map((row) =>
      row.venue_market_id && row.venue_event_id
        ? {
            marketId: row.venue_market_id,
            eventId: row.venue_event_id,
          }
        : null,
    )
    .filter((row): row is { marketId: string; eventId: string } => row != null);
}

type PolymarketMarketRef = {
  marketId: string;
  eventId: string;
};

type RefreshedPolymarketMarket = {
  eventId: string;
  market: TPolymarketMarket;
};

type RefreshMarketRefsResult = {
  requestedMarkets: number;
  refreshed: number;
  eventsFetched: number;
  fallbackMarketFetches: number;
  timings: Record<string, number>;
};

function dedupeMarketRefs(refs: PolymarketMarketRef[]): PolymarketMarketRef[] {
  const out: PolymarketMarketRef[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    if (seen.has(ref.marketId)) continue;
    seen.add(ref.marketId);
    out.push(ref);
  }
  return out;
}

function collectMarketsFromEvents(
  events: TEvent[],
  refsByMarketId: Map<string, PolymarketMarketRef>,
): Map<string, RefreshedPolymarketMarket> {
  const rowsByMarketId = new Map<string, RefreshedPolymarketMarket>();

  for (const event of events) {
    for (const rawMarket of event.markets) {
      const marketId = String(rawMarket.id);
      const ref = refsByMarketId.get(marketId);
      if (!ref || rowsByMarketId.has(marketId)) continue;
      try {
        rowsByMarketId.set(marketId, {
          eventId: ref.eventId,
          market: PolymarketMarket.parse(rawMarket) as TPolymarketMarket,
        });
      } catch (error) {
        log.warn("Failed to parse Polymarket refreshed market from event", {
          eventId: event.id,
          marketId,
          error,
        });
      }
    }
  }

  return rowsByMarketId;
}

async function fetchFallbackMarketRows(
  refs: PolymarketMarketRef[],
): Promise<RefreshedPolymarketMarket[]> {
  if (!refs.length) return [];

  const q = new PQueue({ concurrency: env.priceRefreshMarketConcurrency });
  const rows = await Promise.all(
    refs.map((ref) =>
      q.add(async () => {
        const market = await fetchMarketById(ref.marketId);
        if (!market) return null;
        try {
          return {
            eventId: ref.eventId,
            market: PolymarketMarket.parse(market) as TPolymarketMarket,
          };
        } catch (error) {
          log.warn("Failed to parse Polymarket refreshed market", {
            marketId: ref.marketId,
            error,
          });
          return null;
        }
      }),
    ),
  );

  return rows.filter((row): row is RefreshedPolymarketMarket => row != null);
}

async function refreshMarketRefs(
  refs: PolymarketMarketRef[],
): Promise<RefreshMarketRefsResult> {
  const dedupedRefs = dedupeMarketRefs(refs);
  const resultBase = {
    requestedMarkets: dedupedRefs.length,
    eventsFetched: 0,
    fallbackMarketFetches: 0,
  };
  if (!dedupedRefs.length) {
    return { ...resultBase, refreshed: 0, timings: {} };
  }

  const timings = createTimings();
  const refsByMarketId = new Map(dedupedRefs.map((ref) => [ref.marketId, ref]));
  const eventIds = Array.from(new Set(dedupedRefs.map((ref) => ref.eventId)));

  const eventRefresh = await timedPhase(
    timings,
    "refreshMarketRefs.fetchEvents",
    () => fetchEventsByIdsDetailed(eventIds),
    { eventIds: eventIds.length, marketRefs: dedupedRefs.length },
  );
  const events = eventRefresh.events;
  if (eventRefresh.failedIds.length) {
    log.warn("Polymarket event batch market refresh partially failed", {
      eventIds: eventIds.length,
      failedEventIds: eventRefresh.failedIds.length,
      marketRefs: dedupedRefs.length,
    });
  }

  const rowsByMarketId = collectMarketsFromEvents(events, refsByMarketId);
  const missingRefs = dedupedRefs.filter(
    (ref) => !rowsByMarketId.has(ref.marketId),
  );
  const fallbackRows = missingRefs.length
    ? await timedPhase(
        timings,
        "refreshMarketRefs.fallbackMarkets",
        () => fetchFallbackMarketRows(missingRefs),
        { marketRefs: missingRefs.length },
      )
    : [];
  for (const row of fallbackRows) {
    rowsByMarketId.set(String(row.market.id), row);
  }

  const parsed = Array.from(rowsByMarketId.values());
  if (!parsed.length) {
    return {
      ...resultBase,
      eventsFetched: events.length,
      fallbackMarketFetches: missingRefs.length,
      refreshed: 0,
      timings,
    };
  }

  const polymarketMarketRows = parsed.map(({ eventId, market }) =>
    mapPolymarketMarketRow(eventId, market),
  );
  const unifiedMarketRows = parsed.map(({ eventId, market }) =>
    mapToUnifiedMarket(market, eventId),
  );
  const unifiedTokenRows = parsed.flatMap(({ market }) => {
    const [yes, no] = Array.isArray(market.clobTokenIds)
      ? market.clobTokenIds
      : [];
    return mapTokens(`polymarket:${market.id}`, yes ?? null, no ?? null);
  });

  const marketUpsertResult = await timedPhase(
    timings,
    "refreshMarketRefs.marketUpsert",
    () =>
      upsertMarketsConsistently(
        pool,
        {
          unified: unifiedMarketRows,
          polymarket: polymarketMarketRows,
        },
        {
          unifiedBatchSize: env.marketUpsertBatchSize,
        },
      ),
    { markets: unifiedMarketRows.length },
  );
  log.info("Polymarket market upsert stats", {
    context: "refreshMarketRefs",
    markets: unifiedMarketRows.length,
    polymarketInputRows: marketUpsertResult.polymarket.inputRows,
    polymarketDedupedRows: marketUpsertResult.polymarket.dedupedRows,
    polymarketChangedRows: marketUpsertResult.polymarket.changedRows,
    polymarketSkippedRows: marketUpsertResult.polymarket.skippedRows,
    polymarketUpsertedRows: marketUpsertResult.polymarket.upsertedRows,
    polymarketBatches: marketUpsertResult.polymarket.batches,
    unifiedInputRows: marketUpsertResult.unified.inputRows,
    unifiedDedupedRows: marketUpsertResult.unified.dedupedRows,
    unifiedChangedRows: marketUpsertResult.unified.changedRows,
    unifiedSkippedRows: marketUpsertResult.unified.skippedRows,
    unifiedUpsertedRows: marketUpsertResult.unified.upsertedRows,
    unifiedBatches: marketUpsertResult.unified.batches,
    unifiedTokenSyncMarketCount:
      marketUpsertResult.unified.tokenSyncMarketCount,
  });

  if (unifiedTokenRows.length) {
    const tokenUpsertResult = await timedPhase(
      timings,
      "refreshMarketRefs.tokenUpsert",
      () => upsertUnifiedTokens(pool, unifiedTokenRows),
      { tokens: unifiedTokenRows.length },
    );
    log.info("Polymarket token upsert stats", {
      context: "refreshMarketRefs",
      tokens: unifiedTokenRows.length,
      inputRows: tokenUpsertResult.inputRows,
      dedupedRows: tokenUpsertResult.dedupedRows,
      changedRows: tokenUpsertResult.changedRows,
      skippedRows: tokenUpsertResult.skippedRows,
      upsertedRows: tokenUpsertResult.upsertedRows,
      batches: tokenUpsertResult.batches,
    });
  }

  const tsMs = Date.now();
  const stateQueue = new PQueue({ concurrency: 20 });
  await timedPhase(
    timings,
    "refreshMarketRefs.publishState",
    () =>
      Promise.all(
        parsed.flatMap(({ market }, index) => {
          const unifiedMarket = unifiedMarketRows[index];
          const { yes, no } = clobTokenPair(market);
          const tokenIds = [yes, no].filter((tokenId): tokenId is string =>
            Boolean(tokenId),
          );
          return tokenIds.map((tokenId) =>
            stateQueue.add(() =>
              publishMarketState({
                redis,
                venue: "polymarket",
                tokenId,
                market: market.conditionId ?? null,
                conditionId: market.conditionId ?? null,
                status: publishedMarketStatus(unifiedMarket),
                acceptingOrders:
                  typeof market.acceptingOrders === "boolean"
                    ? market.acceptingOrders
                    : null,
                resolvedOutcome: unifiedMarket?.resolved_outcome ?? null,
                tsMs,
              }),
            ),
          );
        }),
      ),
    { markets: parsed.length },
  );

  return {
    ...resultBase,
    eventsFetched: events.length,
    fallbackMarketFetches: missingRefs.length,
    refreshed: parsed.length,
    timings,
  };
}

async function fetchTradableTokenIdsForSnapshot(
  tokenIds: string[],
): Promise<string[]> {
  if (!tokenIds.length) return [];

  const { rows } = await pool.query<{ token_id: string }>(
    `
      with requested_tokens as (
        select token_id, ord::int as ord
        from unnest($1::text[]) with ordinality as t(token_id, ord)
      ),
      token_markets as (
        select rt.token_id, rt.ord, m.id as market_id, m.venue_market_id
        from requested_tokens rt
        join unified_market_tokens mt
          on mt.token_id = rt.token_id
         and mt.venue = 'polymarket'
        join unified_markets m
          on m.id = mt.market_id
         and m.venue = 'polymarket'
        where m.status = 'ACTIVE'
        union
        select rt.token_id, rt.ord, m.id as market_id, m.venue_market_id
        from requested_tokens rt
        join unified_tokens t
          on t.token_id = rt.token_id
         and t.venue = 'polymarket'
        join unified_markets m
          on m.id = t.market_id
         and m.venue = 'polymarket'
        where m.status = 'ACTIVE'
      )
      select distinct on (tm.token_id) tm.token_id
      from token_markets tm
      left join polymarket_markets pm
        on pm.id = tm.venue_market_id
      where coalesce(pm.closed, false) = false
        and coalesce(pm.archived, false) = false
        and coalesce(pm.enable_order_book, true) = true
        and coalesce(pm.accepting_orders, true) = true
      order by tm.token_id, tm.ord
    `,
    [tokenIds],
  );

  const requestedOrder = new Map<string, number>();
  tokenIds.forEach((tokenId, index) => {
    if (!requestedOrder.has(tokenId)) requestedOrder.set(tokenId, index);
  });

  return rows
    .map((row) => row.token_id)
    .sort(
      (a, b) =>
        (requestedOrder.get(a) ?? Number.MAX_SAFE_INTEGER) -
        (requestedOrder.get(b) ?? Number.MAX_SAFE_INTEGER),
    );
}

export async function processPriceRefreshQueue(): Promise<{
  claimed: number;
  refreshed: number;
  failed: number;
  backlog: number;
}> {
  if (!env.priceRefreshQueueEnabled) {
    return { claimed: 0, refreshed: 0, failed: 0, backlog: 0 };
  }

  await ensureRedis();
  const redisClient = redis as unknown as PriceRefreshRedis;
  const tokenIds = await claimDuePriceRefreshTokens(redisClient, {
    venue: "polymarket",
    limit: env.priceRefreshQueueBatch,
  });
  if (!tokenIds.length) {
    return { claimed: 0, refreshed: 0, failed: 0, backlog: 0 };
  }

  const startedAt = Date.now();
  let refreshed = 0;
  let failed = 0;
  let marketRefreshed = 0;
  let bookRefreshed = 0;
  let skippedBookTokens = 0;
  let marketRefs = 0;
  let eventsFetched = 0;
  let fallbackMarketFetches = 0;
  let snapshotTokens = 0;
  let refreshTimings: Record<string, number> = {};
  let bookTimings: Record<string, number> = {};
  const timings = createTimings();
  try {
    const refs = await timedPhase(
      timings,
      "priceRefresh.fetchMarketRefs",
      () => fetchMarketRefsForTokenIds(tokenIds),
      { tokens: tokenIds.length },
    );
    const marketResult = await refreshMarketRefs(refs);
    marketRefs = marketResult.requestedMarkets;
    marketRefreshed = marketResult.refreshed;
    eventsFetched = marketResult.eventsFetched;
    fallbackMarketFetches = marketResult.fallbackMarketFetches;
    refreshTimings = marketResult.timings;

    const snapshotTokenIds = await timedPhase(
      timings,
      "priceRefresh.fetchTradableSnapshotTokens",
      () => fetchTradableTokenIdsForSnapshot(tokenIds),
      { tokens: tokenIds.length },
    );
    snapshotTokens = snapshotTokenIds.length;
    skippedBookTokens = Math.max(0, tokenIds.length - snapshotTokenIds.length);
    if (snapshotTokenIds.length) {
      const result = await snapshotBooks(snapshotTokenIds);
      bookTimings = result.timings;
      bookRefreshed = result.requested - result.failedTokenIds.length;
      failed = result.failedTokenIds.length;
      if (result.failedTokenIds.length) {
        await requeuePriceRefreshTokens(redisClient, {
          venue: "polymarket",
          tokenIds: result.failedTokenIds,
          delayMs: env.priceRefreshRetryDelayMs,
          maxQueueSize: env.priceRefreshQueueMax,
        });
      }
    }
    refreshed = marketRefreshed + bookRefreshed;
  } catch (error) {
    failed = tokenIds.length;
    await requeuePriceRefreshTokens(redisClient, {
      venue: "polymarket",
      tokenIds,
      delayMs: env.priceRefreshRetryDelayMs,
      maxQueueSize: env.priceRefreshQueueMax,
    });
    log.warn("Polymarket price refresh queue failed", { error });
  }

  const backlog = await getPriceRefreshQueueBacklog(redisClient, "polymarket");
  log.info("Polymarket price refresh queue processed", {
    claimed: tokenIds.length,
    refreshed,
    marketRefs,
    marketRefreshed,
    eventsFetched,
    fallbackMarketFetches,
    snapshotTokens,
    bookRefreshed,
    failed,
    skippedBookTokens,
    backlog,
    durationMs: Date.now() - startedAt,
    timings: {
      ...timings,
      ...refreshTimings,
      ...bookTimings,
    },
  });
  return { claimed: tokenIds.length, refreshed, failed, backlog };
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
  const hotBudget = Math.max(
    0,
    Math.min(total, Math.round(total * clampedShare)),
  );
  return { hotBudget };
}

function clampHotProbeLimit(limit: number): number {
  return Math.max(200, Math.min(2000, Math.trunc(limit)));
}

async function fetchHotTokenIds(limit?: number): Promise<string[]> {
  if (env.hotTokensMax <= 0 && env.hotStreamTokensMax <= 0) return [];
  await ensureRedis();
  const mergedCap = Math.max(env.hotTokensMax, env.hotStreamTokensMax);
  const resolvedLimit =
    typeof limit === "number" && Number.isFinite(limit)
      ? Math.max(0, Math.trunc(limit))
      : mergedCap;
  if (resolvedLimit <= 0) return [];

  const readHotSet = async (
    key: string,
    maxTokens: number,
    ttlSec: number,
  ): Promise<string[]> => {
    const readMax = Math.min(maxTokens, resolvedLimit);
    if (readMax <= 0) return [];
    const cutoff = Date.now() - ttlSec * 1000;
    await redis.zRemRangeByScore(key, 0, cutoff);
    return redis.zRange(key, 0, readMax - 1, { REV: true });
  };

  try {
    const [streamIds, hotIds] = await Promise.all([
      readHotSet(
        "hot:tokens:stream:polymarket",
        env.hotStreamTokensMax,
        env.hotStreamTokensTtlSec,
      ),
      readHotSet(
        "hot:tokens:polymarket",
        env.hotTokensMax,
        env.hotTokensTtlSec,
      ),
    ]);

    const maxOut = Math.min(mergedCap, resolvedLimit);
    const out: string[] = [];
    const seen = new Set<string>();
    for (const tokenId of [...streamIds, ...hotIds]) {
      if (seen.has(tokenId)) continue;
      seen.add(tokenId);
      out.push(tokenId);
      if (out.length >= maxOut) break;
    }
    return out;
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
    market_id: string | null;
    token_ids: string[] | null;
  }>(
    `
      with requested_tokens as (
        select token_id
        from unnest($1::text[]) as t(token_id)
      ),
      matched_markets as (
        select distinct mt.market_id
        from requested_tokens rt
        join unified_market_tokens mt
          on mt.token_id = rt.token_id
         and mt.venue = 'polymarket'
        union
        select distinct t.market_id
        from requested_tokens rt
        join unified_tokens t
          on t.token_id = rt.token_id
         and t.venue = 'polymarket'
      ),
      market_tokens as (
        select
          mm.market_id,
          mt.token_id,
          mt.outcome_side as side
        from matched_markets mm
        join unified_market_tokens mt
          on mt.market_id = mm.market_id
         and mt.venue = 'polymarket'
        union
        select
          mm.market_id,
          t.token_id,
          t.side
        from matched_markets mm
        join unified_tokens t
          on t.market_id = mm.market_id
         and t.venue = 'polymarket'
      )
      select
        mm.market_id,
        array_agg(
          mt.token_id
          order by
            case mt.side
              when 'YES' then 0
              when 'NO' then 1
              else 2
            end,
            mt.token_id
        ) as token_ids
      from matched_markets mm
      join market_tokens mt
        on mt.market_id = mm.market_id
      group by mm.market_id
    `,
    [tokenIds],
  );

  const markets: Array<{ marketId: string; tokenIds: string[] }> = [];
  for (const row of rows) {
    if (!row.market_id) continue;
    const ids = Array.isArray(row.token_ids) ? row.token_ids : [];
    if (!ids.length) continue;
    markets.push({ marketId: row.market_id, tokenIds: ids });
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
  const out: string[] = [];

  const sourceScanFactors = [1, 5, 15, 40];
  for (const factor of sourceScanFactors) {
    const scanMarkets = Math.max(limitMarkets * factor, 1_000);
    const sourceRows = await fetchTopTokensFromSourceScan(
      scanMarkets,
      limitTokens - out.length,
      exclude,
    );
    out.push(...sourceRows);
    if (out.length >= limitTokens) return out;
  }
  if (out.length < limitTokens) {
    log.warn(
      "Polymarket top token source scan underfilled",
      {
        limitTokens,
        returned: out.length,
        limitMarkets,
      },
    );
  }
  return out;
}

async function fetchTopTokensFromSourceScan(
  limitMarkets: number,
  limitTokens: number,
  exclude: Set<string>,
): Promise<string[]> {
  const { rows } = await pool.query<{ clob_token_ids: unknown }>(
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
        coalesce(liquidity, 0) desc,
        id
      limit $1
    `,
    [limitMarkets],
  );

  return collectTopTokensFromRows(rows, limitTokens, exclude);
}

function collectTopTokensFromRows(
  rows: Array<{ clob_token_ids?: unknown }>,
  limitTokens: number,
  exclude: Set<string>,
): string[] {
  const out: string[] = [];
  for (const row of rows) {
    const tokenIds = parseJsonStringArray(row.clob_token_ids);
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
  const probeLimit = clampHotProbeLimit(env.wsSubset * 10);
  return fetchHotTokenIds(probeLimit);
}

async function fetchHotEventIdsFromTokens(): Promise<string[]> {
  const probeLimit = clampHotProbeLimit(env.hotStatusMaxEvents * 10);
  const tokenIds = await fetchHotTokenIds(probeLimit);
  if (!tokenIds.length) return [];
  return fetchEventIdsForTokenIds(tokenIds, env.hotStatusMaxEvents);
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
  const probeLimit = clampHotProbeLimit(
    Math.max(env.wsSubset * 10, hotBudget * 20),
  );
  const hotTokenIds = await fetchHotTokenIds(probeLimit);
  const hotTokens = await buildHotTokenList(hotTokenIds, hotBudget);

  const seen = new Set<string>(hotTokens);
  const remaining = Math.max(0, env.wsSubset - hotTokens.length);
  const topTokens = await fetchTopTokens(remaining, seen);

  return [...hotTokens, ...topTokens];
}
