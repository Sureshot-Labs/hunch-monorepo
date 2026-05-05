#!/usr/bin/env tsx

import assert from "node:assert/strict";
import crypto from "node:crypto";

import { buildApp } from "./app.js";
import { pool } from "./db.js";
import { env } from "./env.js";

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
        created_at,
        updated_at
      )
      values (
        $1, $2, $3, $4, $5, null, null, 'ACTIVE', 'binary',
        now() - interval '1 hour', $6, $7,
        $8, $9, $10, $11, $12, $13, $14,
        '["Yes","No"]', $15, now(), now()
      )
    `,
    [
      market.id,
      market.venue,
      market.venueMarketId,
      market.eventId,
      market.title,
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
    ],
  );
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

async function main() {
  const app = await buildApp();
  const previousFeedTtl = env.feedTtlSec;
  env.feedTtlSec = 0;

  const suiteId = crypto.randomUUID().slice(0, 8);
  const categoryAlpha = `facet-alpha-${suiteId}`;
  const categoryGamma = `facet-gamma-${suiteId}`;
  const categorySearch = `facet-search-${suiteId}`;
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
  } finally {
    env.feedTtlSec = previousFeedTtl;
    if (seededMarketIds.length > 0) {
      await pool.query(
        "delete from unified_markets where id = any($1::text[])",
        [seededMarketIds],
      );
    }
    if (seededEventIds.length > 0) {
      await pool.query(
        "delete from unified_events where id = any($1::text[])",
        [seededEventIds],
      );
    }
    await app.close();
  }
}

await main();
