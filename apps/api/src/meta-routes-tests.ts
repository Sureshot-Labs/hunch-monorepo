#!/usr/bin/env tsx

import assert from "node:assert/strict";
import crypto from "node:crypto";

import { buildApp } from "./app.js";
import { pool } from "./db.js";
import { env } from "./env.js";
import {
  fetchFeedEventIds,
  fetchFeedMarketsDirect,
} from "./repos/unified-read.js";

type SeededEvent = {
  id: string;
  venue: "polymarket" | "kalshi";
  venueEventId: string;
  category: string;
  title: string;
  startDate: Date;
  endDate: Date;
};

type SeededMarket = {
  id: string;
  venue: "polymarket" | "kalshi";
  venueMarketId: string;
  eventId: string;
  title: string;
  closeTime: Date;
  expirationTime: Date;
  bestBid?: number;
  bestAsk?: number;
  lastPrice?: number;
  volumeTotal?: number;
  volume24h?: number;
  liquidity?: number;
  openInterest?: number;
  durationMinutes?: number;
};

type CategoriesFacetPayload = {
  total: number;
  generatedAt: string;
  categories: Array<{
    category: string;
    events: number;
    venues: Record<string, number>;
  }>;
};

type FeedPayload = {
  data: Array<{ eventId: string }>;
};

function makeId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

async function insertEvent(event: SeededEvent): Promise<void> {
  await pool.query(
    `
      insert into unified_events (
        id,
        venue,
        venue_event_id,
        title,
        description,
        category,
        status,
        start_date,
        end_date,
        volume_total,
        volume_24h,
        liquidity,
        slug,
        created_at,
        updated_at
      )
      values (
        $1, $2, $3, $4, null, $5, 'ACTIVE',
        $6, $7, 100, 10, 100, $8, now(), now()
      )
    `,
    [
      event.id,
      event.venue,
      event.venueEventId,
      event.title,
      event.category,
      event.startDate.toISOString(),
      event.endDate.toISOString(),
      makeId("slug"),
    ],
  );
}

async function insertMarket(market: SeededMarket): Promise<void> {
  const bestBid = market.bestBid ?? 0.45;
  const bestAsk = market.bestAsk ?? 0.55;
  const lastPrice = market.lastPrice ?? (bestBid + bestAsk) / 2;
  const volumeTotal = market.volumeTotal ?? 100;
  const volume24h = market.volume24h ?? 10;
  const liquidity = market.liquidity ?? 100;
  const openInterest = market.openInterest ?? 50;
  const durationMinutes = market.durationMinutes ?? 60;
  await pool.query(
    `
      insert into unified_markets (
        id,
        venue,
        venue_market_id,
        event_id,
        title,
        description,
        category,
        status,
        market_type,
        duration_minutes,
        open_time,
        close_time,
        expiration_time,
        best_bid,
        best_ask,
        last_price,
        volume_total,
        volume_24h,
        liquidity,
        open_interest,
        outcomes,
        slug,
        metadata,
        created_at,
        updated_at
      )
      values (
        $1, $2, $3, $4, $5, null, null, 'ACTIVE', 'binary',
        $6, now() - interval '1 hour', $7, $8,
        $9, $10, $11, $12, $13, $14, $15,
        '["Yes","No"]', $16, $17::jsonb, now(), now()
      )
    `,
    [
      market.id,
      market.venue,
      market.venueMarketId,
      market.eventId,
      market.title,
      durationMinutes,
      market.closeTime.toISOString(),
      market.expirationTime.toISOString(),
      bestBid,
      bestAsk,
      lastPrice,
      volumeTotal,
      volume24h,
      liquidity,
      openInterest,
      makeId("slug"),
      JSON.stringify(
        market.venue === "kalshi" ? { dflowNativeAcceptingOrders: true } : {},
      ),
    ],
  );
}

async function insertMarketMetricRows(markets: SeededMarket[]): Promise<void> {
  for (const [index, market] of markets.entries()) {
    await pool.query(
      `
        insert into unified_market_change_24h (
          market_id,
          change_24h,
          updated_at
        )
        values ($1, $2, now())
        on conflict (market_id) do update
          set change_24h = excluded.change_24h,
              updated_at = excluded.updated_at
      `,
      [market.id, (index + 1) / 100],
    );
    await pool.query(
      `
        insert into unified_market_trade_24h (
          market_id,
          volume_24h,
          vwap,
          trades,
          updated_at
        )
        values ($1, $2, $3, $4, now())
        on conflict (market_id) do update
          set volume_24h = excluded.volume_24h,
              vwap = excluded.vwap,
              trades = excluded.trades,
              updated_at = excluded.updated_at
      `,
      [market.id, 100 + index, 0.5, index + 1],
    );
  }
}

async function insertEventTradeRows(events: SeededEvent[]): Promise<void> {
  for (const [index, event] of events.entries()) {
    await pool.query(
      `
        insert into unified_event_trade_24h (
          event_id,
          volume_24h,
          updated_at
        )
        values ($1, $2, now())
        on conflict (event_id) do update
          set volume_24h = excluded.volume_24h,
              updated_at = excluded.updated_at
      `,
      [event.id, 200 + index],
    );
  }
}

async function insertEventChangeRows(events: SeededEvent[]): Promise<void> {
  for (const [index, event] of events.entries()) {
    await pool.query(
      `
        insert into unified_event_change_24h (
          event_id,
          change_24h,
          updated_at
        )
        values ($1, $2, now())
        on conflict (event_id) do update
          set change_24h = excluded.change_24h,
              updated_at = excluded.updated_at
      `,
      [event.id, (index + 1) / 50],
    );
  }
}

function buildQuery(
  params: Record<string, string | number | undefined>,
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value == null) continue;
    search.set(key, String(value));
  }
  return search.toString();
}

function findCategory(
  payload: CategoriesFacetPayload,
  category: string,
): { category: string; events: number; venues: Record<string, number> } {
  const match = payload.categories.find((entry) => entry.category === category);
  assert.ok(match, `expected category ${category} in facet payload`);
  return match;
}

function distinctFeedEventCount(payload: FeedPayload): number {
  return new Set(payload.data.map((item) => item.eventId)).size;
}

async function assertFacetParity(args: {
  app: Awaited<ReturnType<typeof buildApp>>;
  query: Record<string, string | number | undefined>;
  category: string;
  expectedEvents: number;
  expectedVenues: Record<string, number>;
}) {
  const { app, query, category, expectedEvents, expectedVenues } = args;
  const facetResponse = await app.inject({
    method: "GET",
    url: `/meta/categories/facets?${buildQuery(query)}`,
  });
  assert.equal(facetResponse.statusCode, 200);
  const facetPayload = facetResponse.json<CategoriesFacetPayload>();
  const facetCategory = findCategory(facetPayload, category);

  assert.equal(facetCategory.events, expectedEvents);
  assert.deepEqual(facetCategory.venues, expectedVenues);

  const feedResponse = await app.inject({
    method: "GET",
    url: `/feed?${buildQuery({
      ...query,
      category,
    })}`,
  });
  assert.equal(feedResponse.statusCode, 200);
  const feedPayload = feedResponse.json<FeedPayload>();
  assert.equal(distinctFeedEventCount(feedPayload), expectedEvents);
}

async function assertMarketScopeFeed(args: {
  app: Awaited<ReturnType<typeof buildApp>>;
  category: string;
  eventScope: "grouped" | "single";
  sort: string;
  expectedEventIds: string[];
  q?: string;
}) {
  const { app, category, eventScope, sort, expectedEventIds, q } = args;
  const response = await app.inject({
    method: "GET",
    url: `/feed?${buildQuery({
      view: "markets",
      category,
      event_scope: eventScope,
      sort,
      sort_dir: "desc",
      q,
      limit: 10,
    })}`,
  });
  assert.equal(response.statusCode, 200);
  const payload = response.json<FeedPayload>();
  const actualEventIds = [...new Set(payload.data.map((item) => item.eventId))]
    .sort()
    .join(",");
  assert.equal(actualEventIds, [...expectedEventIds].sort().join(","));
}

async function assertEventFeed(args: {
  app: Awaited<ReturnType<typeof buildApp>>;
  query: Record<string, string | number | undefined>;
  expectedEventIds: string[];
}) {
  const { app, query, expectedEventIds } = args;
  const response = await app.inject({
    method: "GET",
    url: `/feed?${buildQuery({
      view: "events",
      limit: 10,
      ...query,
    })}`,
  });
  assert.equal(response.statusCode, 200);
  const payload = response.json<FeedPayload>();
  const actualEventIds = [...new Set(payload.data.map((item) => item.eventId))]
    .sort()
    .join(",");
  assert.equal(actualEventIds, [...expectedEventIds].sort().join(","));
}

async function assertDirectMarketSqlShape(): Promise<void> {
  let capturedSql = "";
  const fakePool = {
    async query(sql: string) {
      capturedSql = sql;
      return { rows: [] };
    },
  } as unknown as Parameters<typeof fetchFeedMarketsDirect>[0];
  const now = new Date("2026-06-16T12:00:00.000Z");

  await fetchFeedMarketsDirect(fakePool, {
    limit: 25,
    offset: 0,
    minVol: 0,
    minLiquidity: 0,
    view: "markets",
    eventScope: "grouped",
    sort: "totalvol",
    sortDir: "desc",
    nowParam: now.toISOString(),
    sevenDaysAgo: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
      .toISOString(),
    sevenDaysFromNow: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)
      .toISOString(),
  });

  assert.match(capturedSql, /orderable_market_candidates as materialized/);
  assert.match(
    capturedSql,
    /market_count as materialized \([\s\S]*from orderable_market_candidates/s,
  );
  assert.match(
    capturedSql,
    /from orderable_market_candidates omc\s+join unified_markets m on m\.id = omc\.market_id/s,
  );
  assert.doesNotMatch(
    capturedSql,
    /market_count as[\s\S]{0,300}from unified_markets m/s,
  );
}

async function assertEventFeedSqlShape(): Promise<void> {
  const now = new Date("2026-06-16T12:00:00.000Z");
  const baseInputs = {
    limit: 5,
    offset: 0,
    minVol: 0,
    minLiquidity: 0,
    view: "events",
    sortDir: "desc",
    nowParam: now.toISOString(),
    sevenDaysAgo: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
      .toISOString(),
    sevenDaysFromNow: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)
      .toISOString(),
  } satisfies Parameters<typeof fetchFeedEventIds>[1];

  const runWithRows = async (
    inputs: Partial<Parameters<typeof fetchFeedEventIds>[1]>,
    rowCount: number,
  ): Promise<string[]> => {
    const capturedSql: string[] = [];
    const fakePool = {
      async query(sql: string) {
        capturedSql.push(sql);
        return {
          rows: Array.from({ length: rowCount }, (_, index) => ({
            id: `event-${index}`,
          })),
        };
      },
    } as unknown as Parameters<typeof fetchFeedEventIds>[0];

    await fetchFeedEventIds(fakePool, {
      ...baseInputs,
      ...inputs,
    });
    return capturedSql;
  };

  for (const sort of [
    undefined,
    "trending",
    "totalvol",
    "liquidity",
    "openinterest",
    "time",
  ]) {
    const [sql] = await runWithRows({ sort }, baseInputs.limit);
    assert.match(sql, /ranked_event_candidates as materialized/);
    assert.match(sql, /valid_ranked_events as materialized/);
    assert.match(sql, /from unified_events e/s);
    assert.doesNotMatch(sql, /join orderable_market_candidates/s);
  }

  {
    const [sql] = await runWithRows({ sort: "change24h" }, baseInputs.limit);
    assert.match(sql, /from unified_event_change_24h ec/s);
    assert.match(sql, /join unified_events e on e\.id = ec\.event_id/s);
    assert.match(sql, /valid_ranked_events as materialized/);
  }

  {
    const [sql] = await runWithRows({ sort: "trending_v2" }, baseInputs.limit);
    assert.match(sql, /from unified_event_trade_24h et/s);
    assert.match(sql, /union all/s);
    assert.match(sql, /valid_ranked_events as materialized/);
  }

  {
    const capturedSql: string[] = [];
    const fakePool = {
      async query(sql: string) {
        capturedSql.push(sql);
        return { rows: [] };
      },
    } as unknown as Parameters<typeof fetchFeedEventIds>[0];

    await fetchFeedEventIds(fakePool, {
      ...baseInputs,
      sort: "trending",
    });

    assert.equal(capturedSql.length, 2);
    assert.match(capturedSql[0], /ranked_event_candidates as materialized/);
    assert.match(capturedSql[1], /select\s+e\.id[\s\S]*from unified_events e/s);
    assert.match(capturedSql[1], /exists \(/s);
  }
}

async function main() {
  await assertDirectMarketSqlShape();
  await assertEventFeedSqlShape();

  const app = await buildApp();
  const previousFeedTtl = env.feedTtlSec;
  env.feedTtlSec = 0;

  const suiteId = crypto.randomUUID().slice(0, 8);
  const categoryAlpha = `facet-alpha-${suiteId}`;
  const categoryGamma = `facet-gamma-${suiteId}`;
  const categorySearch = `facet-search-${suiteId}`;
  const categoryYear = `facet-year-${suiteId}`;
  const categoryYearPrefix = `facet-year-prefix-${suiteId}`;
  const categoryBit = `facet-bit-${suiteId}`;
  const categorySingleChar = `facet-x-${suiteId}`;
  const categoryScope = `facet-scope-${suiteId}`;
  const categoryProb = `facet-prob-${suiteId}`;
  const searchNeedle = `needle-${suiteId}`;

  const now = Date.now();
  const seededEventIds: string[] = [];
  const seededMarketIds: string[] = [];

  const events: SeededEvent[] = [
    {
      id: makeId("polymarket:event"),
      venue: "polymarket",
      venueEventId: makeId("venue-event"),
      category: categoryAlpha,
      title: `Facet alpha current ${suiteId}`,
      startDate: new Date(now - 2 * 60 * 60 * 1000),
      endDate: new Date(now + 6 * 60 * 60 * 1000),
    },
    {
      id: makeId("kalshi:event"),
      venue: "kalshi",
      venueEventId: makeId("venue-event"),
      category: categoryAlpha,
      title: `Facet alpha older ${suiteId}`,
      startDate: new Date(now - 36 * 60 * 60 * 1000),
      endDate: new Date(now + 8 * 60 * 60 * 1000),
    },
    {
      id: makeId("polymarket:event"),
      venue: "polymarket",
      venueEventId: makeId("venue-event"),
      category: categoryAlpha,
      title: `Facet alpha long dated ${suiteId}`,
      startDate: new Date(now - 4 * 60 * 60 * 1000),
      endDate: new Date(now + 72 * 60 * 60 * 1000),
    },
    {
      id: makeId("polymarket:event"),
      venue: "polymarket",
      venueEventId: makeId("venue-event"),
      category: categoryGamma,
      title: `Facet gamma stale ${suiteId}`,
      startDate: new Date(now - 72 * 60 * 60 * 1000),
      endDate: new Date(now + 96 * 60 * 60 * 1000),
    },
    {
      id: makeId("polymarket:event"),
      venue: "polymarket",
      venueEventId: makeId("venue-event"),
      category: categorySearch,
      title: `Facet search event ${suiteId}`,
      startDate: new Date(now - 3 * 60 * 60 * 1000),
      endDate: new Date(now + 10 * 60 * 60 * 1000),
    },
    {
      id: makeId("polymarket:event"),
      venue: "polymarket",
      venueEventId: makeId("venue-event"),
      category: categoryScope,
      title: `Facet grouped scope ${suiteId}`,
      startDate: new Date(now - 5 * 60 * 60 * 1000),
      endDate: new Date(now + 12 * 60 * 60 * 1000),
    },
    {
      id: makeId("polymarket:event"),
      venue: "polymarket",
      venueEventId: makeId("venue-event"),
      category: categoryScope,
      title: `Facet single scope ${suiteId}`,
      startDate: new Date(now - 5 * 60 * 60 * 1000),
      endDate: new Date(now + 12 * 60 * 60 * 1000),
    },
    {
      id: makeId("polymarket:event"),
      venue: "polymarket",
      venueEventId: makeId("venue-event"),
      category: categoryProb,
      title: `Facet low prob ${suiteId}`,
      startDate: new Date(now - 6 * 60 * 60 * 1000),
      endDate: new Date(now + 18 * 60 * 60 * 1000),
    },
    {
      id: makeId("polymarket:event"),
      venue: "polymarket",
      venueEventId: makeId("venue-event"),
      category: categoryProb,
      title: `Facet high prob ${suiteId}`,
      startDate: new Date(now - 6 * 60 * 60 * 1000),
      endDate: new Date(now + 18 * 60 * 60 * 1000),
    },
    {
      id: makeId("polymarket:event"),
      venue: "polymarket",
      venueEventId: makeId("venue-event"),
      category: categoryYear,
      title: `Facet 2026 exact ${suiteId}`,
      startDate: new Date(now - 6 * 60 * 60 * 1000),
      endDate: new Date(now + 18 * 60 * 60 * 1000),
    },
    {
      id: makeId("polymarket:event"),
      venue: "polymarket",
      venueEventId: makeId("venue-event"),
      category: categoryYearPrefix,
      title: `Facet 20260 prefix guard ${suiteId}`,
      startDate: new Date(now - 6 * 60 * 60 * 1000),
      endDate: new Date(now + 18 * 60 * 60 * 1000),
    },
    {
      id: makeId("polymarket:event"),
      venue: "polymarket",
      venueEventId: makeId("venue-event"),
      category: categoryBit,
      title: `Bitcoin facet prefix ${suiteId}`,
      startDate: new Date(now - 6 * 60 * 60 * 1000),
      endDate: new Date(now + 18 * 60 * 60 * 1000),
    },
    {
      id: makeId("polymarket:event"),
      venue: "polymarket",
      venueEventId: makeId("venue-event"),
      category: categorySingleChar,
      title: `X facet exact ${suiteId}`,
      startDate: new Date(now - 6 * 60 * 60 * 1000),
      endDate: new Date(now + 18 * 60 * 60 * 1000),
    },
  ];

  const markets: SeededMarket[] = [
    {
      id: makeId("polymarket:market"),
      venue: "polymarket",
      venueMarketId: makeId("venue-market"),
      eventId: events[0].id,
      title: `Facet alpha market ${suiteId}`,
      closeTime: new Date(now + 6 * 60 * 60 * 1000),
      expirationTime: new Date(now + 6 * 60 * 60 * 1000),
      bestBid: 0.74,
      bestAsk: 0.78,
    },
    {
      id: makeId("kalshi:market"),
      venue: "kalshi",
      venueMarketId: makeId("venue-market"),
      eventId: events[1].id,
      title: `Facet alpha older market ${suiteId}`,
      closeTime: new Date(now + 8 * 60 * 60 * 1000),
      expirationTime: new Date(now + 8 * 60 * 60 * 1000),
      bestBid: 0.34,
      bestAsk: 0.38,
    },
    {
      id: makeId("polymarket:market"),
      venue: "polymarket",
      venueMarketId: makeId("venue-market"),
      eventId: events[2].id,
      title: `Facet alpha long market ${suiteId}`,
      closeTime: new Date(now + 72 * 60 * 60 * 1000),
      expirationTime: new Date(now + 72 * 60 * 60 * 1000),
      bestBid: 0.86,
      bestAsk: 0.9,
    },
    {
      id: makeId("polymarket:market"),
      venue: "polymarket",
      venueMarketId: makeId("venue-market"),
      eventId: events[3].id,
      title: `Facet gamma market ${suiteId}`,
      closeTime: new Date(now + 96 * 60 * 60 * 1000),
      expirationTime: new Date(now + 96 * 60 * 60 * 1000),
      bestBid: 0.58,
      bestAsk: 0.92,
    },
    {
      id: makeId("polymarket:market"),
      venue: "polymarket",
      venueMarketId: makeId("venue-market"),
      eventId: events[4].id,
      title: `Facet market ${searchNeedle}`,
      closeTime: new Date(now + 10 * 60 * 60 * 1000),
      expirationTime: new Date(now + 10 * 60 * 60 * 1000),
      bestBid: 0.48,
      bestAsk: 0.52,
    },
    {
      id: makeId("polymarket:market"),
      venue: "polymarket",
      venueMarketId: makeId("venue-market"),
      eventId: events[5].id,
      title: `Facet grouped primary ${suiteId}`,
      closeTime: new Date(now + 12 * 60 * 60 * 1000),
      expirationTime: new Date(now + 12 * 60 * 60 * 1000),
      bestBid: 0.63,
      bestAsk: 0.67,
    },
    {
      id: makeId("polymarket:market"),
      venue: "polymarket",
      venueMarketId: makeId("venue-market"),
      eventId: events[5].id,
      title: `Facet grouped secondary ${suiteId}`,
      closeTime: new Date(now + 12 * 60 * 60 * 1000),
      expirationTime: new Date(now + 12 * 60 * 60 * 1000),
      bestBid: 0.26,
      bestAsk: 0.3,
    },
    {
      id: makeId("polymarket:market"),
      venue: "polymarket",
      venueMarketId: makeId("venue-market"),
      eventId: events[6].id,
      title: `Facet single market ${suiteId}`,
      closeTime: new Date(now + 12 * 60 * 60 * 1000),
      expirationTime: new Date(now + 12 * 60 * 60 * 1000),
      bestBid: 0.66,
      bestAsk: 0.7,
    },
    {
      id: makeId("polymarket:market"),
      venue: "polymarket",
      venueMarketId: makeId("venue-market"),
      eventId: events[7].id,
      title: `Facet low prob market ${suiteId}`,
      closeTime: new Date(now + 18 * 60 * 60 * 1000),
      expirationTime: new Date(now + 18 * 60 * 60 * 1000),
      bestBid: 0.18,
      bestAsk: 0.22,
    },
    {
      id: makeId("polymarket:market"),
      venue: "polymarket",
      venueMarketId: makeId("venue-market"),
      eventId: events[8].id,
      title: `Facet high prob market ${suiteId}`,
      closeTime: new Date(now + 18 * 60 * 60 * 1000),
      expirationTime: new Date(now + 18 * 60 * 60 * 1000),
      bestBid: 0.74,
      bestAsk: 0.9,
    },
    {
      id: makeId("polymarket:market"),
      venue: "polymarket",
      venueMarketId: makeId("venue-market"),
      eventId: events[9].id,
      title: `Facet 2026 market ${suiteId}`,
      closeTime: new Date(now + 18 * 60 * 60 * 1000),
      expirationTime: new Date(now + 18 * 60 * 60 * 1000),
    },
    {
      id: makeId("polymarket:market"),
      venue: "polymarket",
      venueMarketId: makeId("venue-market"),
      eventId: events[10].id,
      title: `Facet 20260 market ${suiteId}`,
      closeTime: new Date(now + 18 * 60 * 60 * 1000),
      expirationTime: new Date(now + 18 * 60 * 60 * 1000),
    },
    {
      id: makeId("polymarket:market"),
      venue: "polymarket",
      venueMarketId: makeId("venue-market"),
      eventId: events[11].id,
      title: `Bitcoin facet market ${suiteId}`,
      closeTime: new Date(now + 18 * 60 * 60 * 1000),
      expirationTime: new Date(now + 18 * 60 * 60 * 1000),
    },
    {
      id: makeId("polymarket:market"),
      venue: "polymarket",
      venueMarketId: makeId("venue-market"),
      eventId: events[12].id,
      title: `X facet market ${suiteId}`,
      closeTime: new Date(now + 18 * 60 * 60 * 1000),
      expirationTime: new Date(now + 18 * 60 * 60 * 1000),
    },
  ];

  try {
    for (const event of events) {
      await insertEvent(event);
      seededEventIds.push(event.id);
    }
    for (const market of markets) {
      await insertMarket(market);
      seededMarketIds.push(market.id);
    }
    await insertMarketMetricRows(markets);
    await insertEventTradeRows(events);
    await insertEventChangeRows(events);
    await pool.query("select refresh_unified_event_active_categories()");

    await assertFacetParity({
      app,
      query: {
        end_within_hours: 24,
        category: categoryGamma,
      },
      category: categoryAlpha,
      expectedEvents: 2,
      expectedVenues: {
        kalshi: 1,
        polymarket: 1,
      },
    });

    await assertFacetParity({
      app,
      query: {
        age_within_hours: 24,
      },
      category: categoryAlpha,
      expectedEvents: 2,
      expectedVenues: {
        polymarket: 2,
      },
    });

    await assertFacetParity({
      app,
      query: {
        end_within_hours: 24,
        age_within_hours: 24,
      },
      category: categoryAlpha,
      expectedEvents: 1,
      expectedVenues: {
        polymarket: 1,
      },
    });

    const alphaEventIds = [events[0].id, events[1].id, events[2].id];
    await assertEventFeed({
      app,
      query: {
        category: categoryAlpha,
      },
      expectedEventIds: alphaEventIds,
    });
    for (const sort of [
      "trending",
      "totalvol",
      "liquidity",
      "openinterest",
      "time",
      "change24h",
      "trending_v2",
    ]) {
      await assertEventFeed({
        app,
        query: {
          category: categoryAlpha,
          sort,
        },
        expectedEventIds: alphaEventIds,
      });
    }
    await assertEventFeed({
      app,
      query: {
        category: categoryAlpha,
        venue: "polymarket",
        sort: "trending",
      },
      expectedEventIds: [events[0].id, events[2].id],
    });
    await assertEventFeed({
      app,
      query: {
        category: categoryAlpha,
        duration_minutes: 60,
        sort: "totalvol",
      },
      expectedEventIds: alphaEventIds,
    });

    {
      const response = await app.inject({
        method: "GET",
        url: `/feed?${buildQuery({
          view: "events",
          category: categoryAlpha,
          sort: "trending_v2",
          end_within_hours: 24,
          age_within_hours: 24,
          limit: 10,
        })}`,
      });
      assert.equal(response.statusCode, 200);
      const payload = response.json<FeedPayload>();
      assert.deepEqual(
        payload.data.map((item) => item.eventId),
        [events[0].id],
      );
    }

    {
      const facetResponse = await app.inject({
        method: "GET",
        url: `/meta/categories/facets?${buildQuery({
          end_within_hours: 24,
          age_within_hours: 24,
        })}`,
      });
      assert.equal(facetResponse.statusCode, 200);
      const facetPayload = facetResponse.json<CategoriesFacetPayload>();
      const facetGamma = findCategory(facetPayload, categoryGamma);
      assert.equal(facetGamma.events, 0);
      assert.deepEqual(facetGamma.venues, {});
    }

    await assertFacetParity({
      app,
      query: {
        view: "markets",
        q: searchNeedle,
      },
      category: categorySearch,
      expectedEvents: 1,
      expectedVenues: {
        polymarket: 1,
      },
    });

    await assertFacetParity({
      app,
      query: {
        q: searchNeedle,
      },
      category: categorySearch,
      expectedEvents: 1,
      expectedVenues: {
        polymarket: 1,
      },
    });

    {
      const facetResponse = await app.inject({
        method: "GET",
        url: `/meta/categories/facets?${buildQuery({ q: "2026" })}`,
      });
      assert.equal(facetResponse.statusCode, 200);
      const facetPayload = facetResponse.json<CategoriesFacetPayload>();
      assert.equal(findCategory(facetPayload, categoryYear).events, 1);
      assert.equal(findCategory(facetPayload, categoryYearPrefix).events, 0);
    }

    await assertFacetParity({
      app,
      query: {
        q: "bit",
      },
      category: categoryBit,
      expectedEvents: 1,
      expectedVenues: {
        polymarket: 1,
      },
    });

    {
      const facetResponse = await app.inject({
        method: "GET",
        url: `/meta/categories/facets?${buildQuery({ q: "x" })}`,
      });
      assert.equal(facetResponse.statusCode, 200);
      const facetPayload = facetResponse.json<CategoriesFacetPayload>();
      assert.equal(findCategory(facetPayload, categorySingleChar).events, 1);
      assert.equal(findCategory(facetPayload, categoryAlpha).events, 0);
    }

    {
      for (const q of ["will", "this"]) {
        const facetResponse = await app.inject({
          method: "GET",
          url: `/meta/categories/facets?${buildQuery({ q })}`,
        });
        assert.equal(facetResponse.statusCode, 200);
        const facetPayload = facetResponse.json<CategoriesFacetPayload>();
        assert.equal(findCategory(facetPayload, categoryAlpha).events, 3);
      }
    }

    await assertFacetParity({
      app,
      query: {
        min_prob: 0.7,
      },
      category: categoryProb,
      expectedEvents: 1,
      expectedVenues: {
        polymarket: 1,
      },
    });

    await assertFacetParity({
      app,
      query: {
        max_prob: 0.3,
      },
      category: categoryProb,
      expectedEvents: 1,
      expectedVenues: {
        polymarket: 1,
      },
    });

    await assertFacetParity({
      app,
      query: {
        max_spread: 0.05,
      },
      category: categoryProb,
      expectedEvents: 1,
      expectedVenues: {
        polymarket: 1,
      },
    });

    await assertFacetParity({
      app,
      query: {
        event_scope: "grouped",
      },
      category: categoryScope,
      expectedEvents: 1,
      expectedVenues: {
        polymarket: 1,
      },
    });

    await assertFacetParity({
      app,
      query: {
        event_scope: "single",
      },
      category: categoryScope,
      expectedEvents: 1,
      expectedVenues: {
        polymarket: 1,
      },
    });

    for (const sort of ["trending_v2", "change24h", "totalvol"]) {
      await assertMarketScopeFeed({
        app,
        category: categoryScope,
        eventScope: "grouped",
        sort,
        expectedEventIds: [events[5].id],
      });
      await assertMarketScopeFeed({
        app,
        category: categoryScope,
        eventScope: "single",
        sort,
        expectedEventIds: [events[6].id],
      });
    }

    await assertMarketScopeFeed({
      app,
      category: categoryScope,
      eventScope: "grouped",
      sort: "totalvol",
      q: `grouped ${suiteId}`,
      expectedEventIds: [events[5].id],
    });
  } finally {
    env.feedTtlSec = previousFeedTtl;
    if (seededMarketIds.length > 0) {
      await pool.query(
        "delete from unified_market_change_24h where market_id = any($1::text[])",
        [seededMarketIds],
      );
      await pool.query(
        "delete from unified_market_trade_24h where market_id = any($1::text[])",
        [seededMarketIds],
      );
      await pool.query(
        "delete from unified_markets where id = any($1::text[])",
        [seededMarketIds],
      );
    }
    if (seededEventIds.length > 0) {
      await pool.query(
        "delete from unified_event_change_24h where event_id = any($1::text[])",
        [seededEventIds],
      );
      await pool.query(
        "delete from unified_event_trade_24h where event_id = any($1::text[])",
        [seededEventIds],
      );
      await pool.query(
        "delete from unified_events where id = any($1::text[])",
        [seededEventIds],
      );
    }
    await pool.query("select refresh_unified_event_active_categories()");
    await app.close();
  }
}

await main();
