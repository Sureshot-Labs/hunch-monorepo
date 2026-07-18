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

async function insertCanonicalMarketTop(
  market: SeededMarket,
): Promise<string[]> {
  const yesTokenId = `${market.id}:YES`;
  const noTokenId = `${market.id}:NO`;
  const yesBid = market.bestBid ?? 0.45;
  const yesAsk = market.bestAsk ?? 0.55;
  const noBid = 1 - yesAsk;
  const noAsk = 1 - yesBid;

  await pool.query(
    `
      insert into unified_market_tokens (
        market_id,
        token_id,
        venue,
        outcome_side
      )
      values
        ($1, $2, $4, 'YES'),
        ($1, $3, $4, 'NO')
    `,
    [market.id, yesTokenId, noTokenId, market.venue],
  );
  await pool.query(
    `
      insert into unified_token_top_latest (
        token_id,
        venue,
        ts,
        best_bid,
        best_ask,
        mid,
        spread,
        updated_at
      )
      values
        ($1, $3, now(), $4::numeric, $5::numeric,
          ($4::numeric + $5::numeric) / 2, $5::numeric - $4::numeric, now()),
        ($2, $3, now(), $6::numeric, $7::numeric,
          ($6::numeric + $7::numeric) / 2, $7::numeric - $6::numeric, now())
    `,
    [yesTokenId, noTokenId, market.venue, yesBid, yesAsk, noBid, noAsk],
  );

  return [yesTokenId, noTokenId];
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

function createSqlCapturePool<T extends Record<string, unknown>>(
  capturedSql: string[],
  rows: T[],
  capturedParams?: unknown[][],
) {
  const runQuery = async (sql: string, params?: unknown[]) => {
    const normalized = sql.trim().toLowerCase();
    if (
      normalized !== "begin" &&
      normalized !== "commit" &&
      normalized !== "rollback" &&
      !normalized.startsWith("set local ")
    ) {
      capturedSql.push(sql);
      capturedParams?.push(params ?? []);
    }
    return { rows };
  };
  return {
    query: runQuery,
    async connect() {
      return {
        query: runQuery,
        release() {
          return undefined;
        },
      };
    },
  };
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
  const now = new Date("2026-06-16T12:00:00.000Z");
  const captureMarketSql = async (
    eventScope: "grouped" | "single",
  ): Promise<string> => {
    const capturedSql: string[] = [];
    const fakePool = createSqlCapturePool(
      capturedSql,
      [],
    ) as unknown as Parameters<typeof fetchFeedMarketsDirect>[0];

    await fetchFeedMarketsDirect(fakePool, {
      limit: 25,
      offset: 0,
      minVol: 0,
      minLiquidity: 0,
      view: "markets",
      eventScope,
      sort: "totalvol",
      sortDir: "desc",
      nowParam: now.toISOString(),
      sevenDaysAgo: new Date(
        now.getTime() - 7 * 24 * 60 * 60 * 1000,
      ).toISOString(),
      sevenDaysFromNow: new Date(
        now.getTime() + 7 * 24 * 60 * 60 * 1000,
      ).toISOString(),
    });

    return capturedSql.join("\n");
  };

  const sql = await captureMarketSql("grouped");
  assert.match(sql, /orderable_market_candidates as materialized/);
  assert.match(
    sql,
    /orderable_market_candidates_pm_recent_candidates as materialized/,
  );
  assert.match(sql, /join lateral \(/);
  assert.match(
    sql,
    /scoped_orderable_market_candidates as materialized \([\s\S]*count\(\*\) over \(partition by omc\.event_id\) as market_count[\s\S]*from orderable_market_candidates omc/s,
  );
  assert.match(sql, /where market_count > 1/);
  assert.match(
    sql,
    /from scoped_orderable_market_candidates omc\s+join unified_markets m on m\.id = omc\.market_id/s,
  );
  assert.doesNotMatch(sql, /join market_count emc/s);
  assert.doesNotMatch(sql, /market_count as materialized/s);
  assert.doesNotMatch(
    sql,
    /market_count as[\s\S]{0,300}from unified_markets m/s,
  );
  assert.doesNotMatch(
    sql,
    /join polymarket_markets pm_filter\s+on pm_filter\.id = m\.venue_market_id\s+and m\.venue = 'polymarket'/s,
  );

  const singleSql = await captureMarketSql("single");
  assert.match(singleSql, /where market_count = 1/);

  const captureFastMarketSql = async (sort: string): Promise<string[]> => {
    const capturedSql: string[] = [];
    let substantiveQueryIndex = 0;
    const runQuery = async (sql: string) => {
      const normalized = sql.trim().toLowerCase();
      if (
        normalized === "begin" ||
        normalized === "commit" ||
        normalized === "rollback" ||
        normalized.startsWith("set local ")
      ) {
        return { rows: [] };
      }
      capturedSql.push(sql);
      substantiveQueryIndex += 1;
      if (substantiveQueryIndex > 1) return { rows: [] };
      return sort === "trending"
        ? { rows: [{ ids: ["market-1"], candidate_count: 1_000 }] }
        : { rows: [{ id: "market-1" }] };
    };
    const fakePool = {
      query: runQuery,
      async connect() {
        return { query: runQuery, release() {} };
      },
    } as unknown as Parameters<typeof fetchFeedMarketsDirect>[0];

    await fetchFeedMarketsDirect(fakePool, {
      limit: 1,
      offset: 0,
      minVol: 0,
      minLiquidity: 0,
      view: "markets",
      venues: ["polymarket", "limitless"],
      sort,
      sortDir: "desc",
      nowParam: now.toISOString(),
      sevenDaysAgo: new Date(
        now.getTime() - 7 * 24 * 60 * 60 * 1000,
      ).toISOString(),
      sevenDaysFromNow: new Date(
        now.getTime() + 7 * 24 * 60 * 60 * 1000,
      ).toISOString(),
    });
    return capturedSql;
  };

  const change24hSql = await captureFastMarketSql("change24h");
  assert.match(change24hSql[0], /orderable_market_candidates as materialized/);
  assert.match(change24hSql[0], /observed_market_change_24h as materialized/);
  assert.match(change24hSql[0], /join unified_token_change_24h cached/);
  assert.doesNotMatch(change24hSql[0], /from unified_book_top_1h book/);
  assert.match(
    change24hSql[0],
    /history_token_set as materialized[\s\S]*?from current_probabilities[\s\S]*?current_probability is not null/,
  );
  assert.match(change24hSql[0], /current_yes_top/);
  assert.match(change24hSql[0], /current_no_top/);
  assert.match(change24hSql[0], /historical_yes_top/);
  assert.match(change24hSql[0], /historical_no_top/);
  assert.match(change24hSql[0], /order by change_24h desc nulls last/);
  assert.doesNotMatch(change24hSql[0], /unified_market_change_24h/);

  const trendingV2Sql = await captureFastMarketSql("trending_v2");
  assert.match(trendingV2Sql[0], /from unified_market_trade_24h metric/);
  assert.match(trendingV2Sql[0], /limitless_candidates as materialized/);
  assert.match(trendingV2Sql[0], /union all/);

  const legacyTrendingSql = await captureFastMarketSql("trending");
  assert.match(
    legacyTrendingSql[0],
    /ranked_market_candidates as materialized/,
  );
  assert.match(legacyTrendingSql[0], /valid_ranked_markets as materialized/);
  assert.doesNotMatch(
    legacyTrendingSql[0],
    /orderable_market_candidates as materialized/,
  );

  {
    const capturedSql: string[] = [];
    const fakePool = createSqlCapturePool(capturedSql, [
      { ids: [], candidate_count: 0 },
    ]) as unknown as Parameters<typeof fetchFeedMarketsDirect>[0];
    await fetchFeedMarketsDirect(fakePool, {
      limit: 1,
      offset: 0,
      minVol: 0,
      minLiquidity: 0,
      minProb: 0.8,
      view: "markets",
      sort: "trending",
      sortDir: "desc",
      nowParam: now.toISOString(),
      sevenDaysAgo: new Date(
        now.getTime() - 7 * 24 * 60 * 60 * 1000,
      ).toISOString(),
      sevenDaysFromNow: new Date(
        now.getTime() + 7 * 24 * 60 * 60 * 1000,
      ).toISOString(),
    });
    assert.match(capturedSql[0], /unified_token_top_latest canonical_yes_top/);
    assert.match(capturedSql[0], /unified_token_top_latest canonical_no_top/);
    assert.doesNotMatch(
      capturedSql[0],
      /when m\.best_bid is not null and m\.best_ask is not null/,
    );
  }
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
    sevenDaysAgo: new Date(
      now.getTime() - 7 * 24 * 60 * 60 * 1000,
    ).toISOString(),
    sevenDaysFromNow: new Date(
      now.getTime() + 7 * 24 * 60 * 60 * 1000,
    ).toISOString(),
  } satisfies Parameters<typeof fetchFeedEventIds>[1];

  const runWithRows = async (
    inputs: Partial<Parameters<typeof fetchFeedEventIds>[1]>,
    rowCount: number,
  ): Promise<{ capturedSql: string[]; capturedParams: unknown[][] }> => {
    const capturedSql: string[] = [];
    const capturedParams: unknown[][] = [];
    const ids = Array.from(
      { length: rowCount },
      (_, index) => `event-${index}`,
    );
    const fakePool = createSqlCapturePool(
      capturedSql,
      [{ ids, candidate_count: rowCount }],
      capturedParams,
    ) as unknown as Parameters<typeof fetchFeedEventIds>[0];

    await fetchFeedEventIds(fakePool, {
      ...baseInputs,
      ...inputs,
    });
    return { capturedSql, capturedParams };
  };

  for (const sort of [
    undefined,
    "trending",
    "totalvol",
    "liquidity",
    "openinterest",
    "time",
  ]) {
    const { capturedSql } = await runWithRows({ sort }, baseInputs.limit);
    const [sql] = capturedSql;
    assert.match(sql, /ranked_event_candidates as materialized/);
    assert.match(sql, /valid_ranked_events as materialized/);
    assert.match(sql, /from unified_events e/s);
    assert.match(
      sql,
      /e\.end_date is null or e\.end_date > \(\$\d+::timestamptz - interval '6 hours'\)/,
    );
    assert.doesNotMatch(sql, /join orderable_market_candidates/s);
  }

  {
    const { capturedSql } = await runWithRows(
      { sort: "change24h" },
      baseInputs.limit,
    );
    const [sql] = capturedSql;
    assert.match(sql, /orderable_market_candidates as materialized/);
    assert.match(sql, /observed_market_change_24h as materialized/);
    assert.match(sql, /join unified_token_change_24h cached/);
    assert.doesNotMatch(sql, /from unified_book_top_1h book/);
    assert.match(
      sql,
      /history_token_set as materialized[\s\S]*?from current_probabilities[\s\S]*?current_probability is not null/,
    );
    assert.match(sql, /avg\(market_change\.change_24h\) desc nulls last/);
    assert.doesNotMatch(sql, /unified_event_change_24h/);
    assert.doesNotMatch(sql, /unified_market_change_24h/);
  }

  {
    const { capturedSql } = await runWithRows(
      { sort: "trending_v2" },
      baseInputs.limit,
    );
    const [sql] = capturedSql;
    assert.match(sql, /from unified_event_trade_24h et/s);
    assert.match(sql, /union all/s);
    assert.match(sql, /valid_ranked_events as materialized/);
    assert.match(
      sql,
      /e\.end_date is null or e\.end_date > \(\$\d+::timestamptz - interval '6 hours'\)/,
    );
  }

  {
    const { capturedParams } = await runWithRows(
      { sort: "liquidity" },
      baseInputs.limit,
    );
    assert.ok(
      capturedParams[0]?.includes(10_000),
      "liquidity event fast path should use wider candidate window",
    );
  }

  {
    const capturedSql: string[] = [];
    const fakePool = createSqlCapturePool(
      capturedSql,
      [],
    ) as unknown as Parameters<typeof fetchFeedEventIds>[0];

    await fetchFeedEventIds(fakePool, {
      ...baseInputs,
      sort: "trending",
    });

    assert.equal(capturedSql.length, 1);
    assert.match(capturedSql[0], /ranked_event_candidates as materialized/);
    assert.doesNotMatch(
      capturedSql[0],
      /orderable_market_candidates as materialized/,
    );
  }

  {
    const capturedSql: string[] = [];
    const capturedParams: unknown[][] = [];
    let queryIndex = 0;
    const runQuery = async (sql: string, params: unknown[] = []) => {
      const normalized = sql.trim().toLowerCase();
      if (
        normalized === "begin" ||
        normalized === "commit" ||
        normalized === "rollback" ||
        normalized.startsWith("set local ")
      ) {
        return { rows: [] };
      }
      capturedSql.push(sql);
      capturedParams.push([...params]);
      queryIndex += 1;
      return queryIndex === 1
        ? { rows: [{ ids: ["event-0"], candidate_count: 1_000 }] }
        : {
            rows: [
              {
                ids: Array.from(
                  { length: baseInputs.limit },
                  (_, index) => `event-${index}`,
                ),
                candidate_count: 4_000,
              },
            ],
          };
    };
    const fakePool = {
      query: runQuery,
      async connect() {
        return { query: runQuery, release() {} };
      },
    } as unknown as Parameters<typeof fetchFeedEventIds>[0];

    const rows = await fetchFeedEventIds(fakePool, {
      ...baseInputs,
      sort: "trending",
    });

    assert.equal(capturedSql.length, 2);
    assert.deepEqual(
      rows.map((row) => row.id),
      ["event-0", "event-1", "event-2", "event-3", "event-4"],
    );
    assert.ok(capturedParams[0]?.includes(1_000));
    assert.ok(capturedParams[1]?.includes(4_000));
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
  const seededTokenIds: string[] = [];

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
    for (const market of markets.slice(8, 10)) {
      seededTokenIds.push(...(await insertCanonicalMarketTop(market)));
    }
    await pool.query(
      `
        update unified_token_top_latest
        set ts = now() - interval '22 hours'
        where token_id = any($1::text[])
      `,
      [seededTokenIds.slice(-2)],
    );
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
      expectedEvents: 1,
      expectedVenues: {
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

    const alphaEventIds = [events[0].id, events[2].id];
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
        assert.equal(findCategory(facetPayload, categoryAlpha).events, 2);
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

    for (const sort of [
      "trending",
      "totalvol",
      "liquidity",
      "openinterest",
      "time",
      "change24h",
      "trending_v2",
    ]) {
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
    if (seededTokenIds.length > 0) {
      await pool.query(
        "delete from unified_token_top_latest where token_id = any($1::text[])",
        [seededTokenIds],
      );
    }
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
