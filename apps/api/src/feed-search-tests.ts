#!/usr/bin/env tsx

import assert from "node:assert/strict";
import crypto from "node:crypto";

import { buildApp } from "./app.js";
import { pool } from "./db.js";
import { env } from "./env.js";
import { buildFeedCandidateEventSearchFilter } from "./repos/unified-read.js";

type SeededEvent = {
  id: string;
  venue: "polymarket" | "kalshi";
  venueEventId: string;
  title: string;
  description?: string | null;
  category: string;
  startDate: Date;
  endDate: Date;
  volumeTotal: number;
};

type SeededMarket = {
  id: string;
  venue: "polymarket" | "kalshi";
  venueMarketId: string;
  eventId: string;
  title: string;
  description?: string | null;
  outcomes?: string;
  category?: string | null;
  closeTime: Date;
  expirationTime: Date;
  volumeTotal: number;
  liquidity?: number;
  dflowNativeAcceptingOrders?: boolean;
};

type FeedPayload = {
  count: number;
  data: Array<{
    eventId: string;
    eventTitle: string | null;
    markets: Array<{
      id: string;
      marketId: string;
      marketTitle: string | null;
      volume: number;
    }>;
  }>;
};

function makeId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
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

function sectionBetween(input: string, start: string, end: string): string {
  const startIndex = input.indexOf(start);
  assert.notEqual(startIndex, -1, `missing SQL section start: ${start}`);
  const endIndex = input.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `missing SQL section end: ${end}`);
  return input.slice(startIndex, endIndex);
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
        $1, $2, $3, $4, $5, $6, 'ACTIVE',
        $7, $8, $9, 10, 100, $10, now(), now()
      )
    `,
    [
      event.id,
      event.venue,
      event.venueEventId,
      event.title,
      event.description ?? null,
      event.category,
      event.startDate.toISOString(),
      event.endDate.toISOString(),
      event.volumeTotal,
      makeId("slug"),
    ],
  );
}

async function insertMarket(market: SeededMarket): Promise<void> {
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
        metadata,
        created_at,
        updated_at
      )
      values (
        $1, $2, $3, $4, $5, $6, $7, 'ACTIVE', 'binary',
        now() - interval '1 hour', $8, $9,
        0.45, 0.55, 0.5, $10, 10, $11, 50,
        $12, $13,
        case
          when $2 = 'kalshi' then jsonb_build_object('dflowNativeAcceptingOrders', $14::boolean)
          else '{}'::jsonb
        end,
        now(), now()
      )
    `,
    [
      market.id,
      market.venue,
      market.venueMarketId,
      market.eventId,
      market.title,
      market.description ?? null,
      market.category ?? null,
      market.closeTime.toISOString(),
      market.expirationTime.toISOString(),
      market.volumeTotal,
      market.liquidity ?? 100,
      market.outcomes ?? '["Yes","No"]',
      makeId("slug"),
      market.dflowNativeAcceptingOrders ?? true,
    ],
  );
}

async function main() {
  const app = await buildApp();
  const previousFeedTtl = env.feedTtlSec;
  const previousFeedSearchResultMatchLimit = env.feedSearchResultMatchLimit;
  env.feedTtlSec = 0;
  env.feedSearchResultMatchLimit = 500;

  const suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
  const needle = `ftstest${suffix}`;
  const fallbackNeedle = `fallback${suffix}`;
  const category = `feed-search-${suffix}`;
  const otherCategory = `${category}-other`;
  const now = Date.now();
  const seededEventIds: string[] = [];
  const seededMarketIds: string[] = [];
  const outOfCategoryFallbackEvents: SeededEvent[] = Array.from(
    { length: 220 },
    (_, index) => ({
      id: makeId("polymarket:event"),
      venue: "polymarket",
      venueEventId: makeId("venue-event"),
      title: `Other category description-only fallback marker ${index}`,
      description: `Hidden recall token ${fallbackNeedle}`,
      category: otherCategory,
      startDate: new Date(now - 60 * 60 * 1000),
      endDate: new Date(now + 30 * 24 * 60 * 60 * 1000),
      volumeTotal: 500 + index,
    }),
  );

  {
    const params: unknown[] = [];
    const add = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    const nowParam = add(new Date(now).toISOString());
    const searchFilter = buildFeedCandidateEventSearchFilter({
      add,
      q: "fifa",
      nowParam,
      matchLimit: 200,
      fallbackThreshold: 75,
      earlyFilterInputs: {
        categories: [category],
      },
    });
    const primarySql = sectionBetween(
      searchFilter.searchCte,
      "primary_search_events as materialized",
      "primary_search_state as materialized",
    );
    const fallbackSql = sectionBetween(
      searchFilter.searchCte,
      "fallback_search_events as materialized",
      "search_events as materialized",
    );
    const searchEventsSql = searchFilter.searchCte.slice(
      searchFilter.searchCte.indexOf("search_events as materialized"),
    );
    assert.match(primarySql, /lower\(e\.category\)/);
    assert.match(primarySql, /polymarket_markets pm_search/);
    assert.match(primarySql, /dflowNativeAcceptingOrders/);
    assert.match(primarySql, /limit 200/);
    assert.doesNotMatch(fallbackSql, /lower\(e\.category\)/);
    assert.match(fallbackSql, /limit 500/);
    assert.match(searchEventsSql, /limit 500/);
  }

  const events: SeededEvent[] = [
    {
      id: makeId("polymarket:event"),
      venue: "polymarket",
      venueEventId: makeId("venue-event"),
      title: `Will Trump leave as President before June 30 ${needle}`,
      category,
      startDate: new Date(now - 60 * 60 * 1000),
      endDate: new Date(now + 30 * 24 * 60 * 60 * 1000),
      volumeTotal: 200,
    },
    {
      id: makeId("polymarket:event"),
      venue: "polymarket",
      venueEventId: makeId("venue-event"),
      title: `Child market event ${needle}`,
      description: "Container event mention for Elon Musk child expansion",
      category,
      startDate: new Date(now - 60 * 60 * 1000),
      endDate: new Date(now + 30 * 24 * 60 * 60 * 1000),
      volumeTotal: 1200,
    },
    {
      id: makeId("kalshi:event"),
      venue: "kalshi",
      venueEventId: makeId("venue-event"),
      title: `High volume description match ${needle}`,
      description: `Alpha beta ${needle}`,
      category,
      startDate: new Date(now - 60 * 60 * 1000),
      endDate: new Date(now + 30 * 24 * 60 * 60 * 1000),
      volumeTotal: 5000,
    },
    {
      id: makeId("polymarket:event"),
      venue: "polymarket",
      venueEventId: makeId("venue-event"),
      title: `Alpha beta ${needle}`,
      category,
      startDate: new Date(now - 60 * 60 * 1000),
      endDate: new Date(now + 30 * 24 * 60 * 60 * 1000),
      volumeTotal: 50,
    },
    {
      id: makeId("polymarket:event"),
      venue: "polymarket",
      venueEventId: makeId("venue-event"),
      title: `Bitcoin price catalyst ${needle}`,
      category,
      startDate: new Date(now - 60 * 60 * 1000),
      endDate: new Date(now + 30 * 24 * 60 * 60 * 1000),
      volumeTotal: 75,
    },
    {
      id: makeId("polymarket:event"),
      venue: "polymarket",
      venueEventId: makeId("venue-event"),
      title: `Formula 2026 championship ${needle}`,
      category,
      startDate: new Date(now - 60 * 60 * 1000),
      endDate: new Date(now + 30 * 24 * 60 * 60 * 1000),
      volumeTotal: 25,
    },
    {
      id: makeId("polymarket:event"),
      venue: "polymarket",
      venueEventId: makeId("venue-event"),
      title: `Formula 20260 championship ${needle}`,
      category,
      startDate: new Date(now - 60 * 60 * 1000),
      endDate: new Date(now + 30 * 24 * 60 * 60 * 1000),
      volumeTotal: 20,
    },
    {
      id: makeId("polymarket:event"),
      venue: "polymarket",
      venueEventId: makeId("venue-event"),
      title: `X search marker ${needle}`,
      category,
      startDate: new Date(now - 60 * 60 * 1000),
      endDate: new Date(now + 30 * 24 * 60 * 60 * 1000),
      volumeTotal: 15,
    },
    {
      id: makeId("polymarket:event"),
      venue: "polymarket",
      venueEventId: makeId("venue-event"),
      title: `Primary search marker ${fallbackNeedle}`,
      category,
      startDate: new Date(now - 60 * 60 * 1000),
      endDate: new Date(now + 30 * 24 * 60 * 60 * 1000),
      volumeTotal: 1,
    },
    {
      id: makeId("polymarket:event"),
      venue: "polymarket",
      venueEventId: makeId("venue-event"),
      title: `Description-only fallback marker`,
      description: `Hidden recall token ${fallbackNeedle}`,
      category,
      startDate: new Date(now - 60 * 60 * 1000),
      endDate: new Date(now + 30 * 24 * 60 * 60 * 1000),
      volumeTotal: 3,
    },
    {
      id: makeId("polymarket:event"),
      venue: "polymarket",
      venueEventId: makeId("venue-event"),
      title: "Description-only fallback marker outside overfetch window",
      description: `Hidden recall token ${fallbackNeedle}`,
      category,
      startDate: new Date(now - 60 * 60 * 1000),
      endDate: new Date(now + 30 * 24 * 60 * 60 * 1000),
      volumeTotal: 2,
    },
    {
      id: makeId("polymarket:event"),
      venue: "polymarket",
      venueEventId: makeId("venue-event"),
      title: `Last-name child market event ${needle}`,
      description: "Container event mention for Donald Trump child expansion",
      category,
      startDate: new Date(now - 60 * 60 * 1000),
      endDate: new Date(now + 30 * 24 * 60 * 60 * 1000),
      volumeTotal: 900,
    },
    {
      id: makeId("polymarket:event"),
      venue: "polymarket",
      venueEventId: makeId("venue-event"),
      title: `Bitcoin Up or Down near-term ${needle}`,
      category,
      startDate: new Date(now - 60 * 60 * 1000),
      endDate: new Date(now + 5 * 60 * 1000),
      volumeTotal: 0,
    },
    {
      id: makeId("polymarket:event"),
      venue: "polymarket",
      venueEventId: makeId("venue-event"),
      title: `Bitcoin Bitcoin Bitcoin Up or Down high-volume future ${needle}`,
      category,
      startDate: new Date(now - 60 * 60 * 1000),
      endDate: new Date(now + 24 * 60 * 60 * 1000),
      volumeTotal: 1_000_000,
    },
    {
      id: makeId("kalshi:event"),
      venue: "kalshi",
      venueEventId: makeId("venue-event"),
      title: `World Soccer Cup Quarterfinals Qualifiers ${needle}`,
      category,
      startDate: new Date(now - 60 * 60 * 1000),
      endDate: new Date(now + 30 * 24 * 60 * 60 * 1000),
      volumeTotal: 700,
    },
    {
      id: makeId("polymarket:event"),
      venue: "polymarket",
      venueEventId: makeId("venue-event"),
      title: `World Cup Winner pool ${needle}`,
      category,
      startDate: new Date(now - 60 * 60 * 1000),
      endDate: new Date(now + 30 * 24 * 60 * 60 * 1000),
      volumeTotal: 600,
    },
    ...outOfCategoryFallbackEvents,
  ];

  const markets: SeededMarket[] = [
    {
      id: makeId("polymarket:market"),
      venue: "polymarket",
      venueMarketId: makeId("venue-market"),
      eventId: events[0].id,
      title: `Event title backed market ${needle}`,
      closeTime: events[0].endDate,
      expirationTime: events[0].endDate,
      volumeTotal: 200,
    },
    {
      id: makeId("polymarket:market"),
      venue: "polymarket",
      venueMarketId: makeId("venue-market"),
      eventId: events[0].id,
      title: `Second event title backed market ${needle}`,
      closeTime: events[0].endDate,
      expirationTime: events[0].endDate,
      volumeTotal: 300,
    },
    {
      id: makeId("polymarket:market"),
      venue: "polymarket",
      venueMarketId: makeId("venue-market"),
      eventId: events[1].id,
      title: `Trump President June market child ${needle}`,
      closeTime: events[1].endDate,
      expirationTime: events[1].endDate,
      volumeTotal: 1200,
    },
    {
      id: makeId("polymarket:market"),
      venue: "polymarket",
      venueMarketId: makeId("venue-market"),
      eventId: events[1].id,
      title: `Unrelated high-volume sibling ${needle}`,
      closeTime: events[1].endDate,
      expirationTime: events[1].endDate,
      volumeTotal: 999999,
    },
    {
      id: makeId("polymarket:market"),
      venue: "polymarket",
      venueMarketId: makeId("venue-market"),
      eventId: events[1].id,
      title: "Donald Trump Jr.",
      closeTime: events[1].endDate,
      expirationTime: events[1].endDate,
      volumeTotal: 5000,
    },
    {
      id: makeId("polymarket:market"),
      venue: "polymarket",
      venueMarketId: makeId("venue-market"),
      eventId: events[1].id,
      title: "Donald Trump",
      closeTime: events[1].endDate,
      expirationTime: events[1].endDate,
      volumeTotal: 1000,
    },
    {
      id: makeId("polymarket:market"),
      venue: "polymarket",
      venueMarketId: makeId("venue-market"),
      eventId: events[1].id,
      title: `Generic nomination outcome market ${needle}`,
      outcomes: '["Elon Musk","No"]',
      closeTime: events[1].endDate,
      expirationTime: events[1].endDate,
      volumeTotal: 1300,
    },
    {
      id: makeId("polymarket:market"),
      venue: "polymarket",
      venueMarketId: makeId("venue-market"),
      eventId: events[11].id,
      title: "Petro - Colombia President",
      closeTime: events[11].endDate,
      expirationTime: events[11].endDate,
      volumeTotal: 9000,
    },
    {
      id: makeId("polymarket:market"),
      venue: "polymarket",
      venueMarketId: makeId("venue-market"),
      eventId: events[11].id,
      title: "Trump - USA President",
      closeTime: events[11].endDate,
      expirationTime: events[11].endDate,
      volumeTotal: 100,
    },
    {
      id: makeId("polymarket:market"),
      venue: "polymarket",
      venueMarketId: makeId("venue-market"),
      eventId: events[11].id,
      title: "Starmer - UK PM",
      closeTime: events[11].endDate,
      expirationTime: events[11].endDate,
      volumeTotal: 8000,
    },
    {
      id: makeId("polymarket:market"),
      venue: "polymarket",
      venueMarketId: makeId("venue-market"),
      eventId: events[12].id,
      title: `Bitcoin Up or Down near-term ${needle}`,
      closeTime: events[12].endDate,
      expirationTime: events[12].endDate,
      volumeTotal: 0,
    },
    {
      id: makeId("polymarket:market"),
      venue: "polymarket",
      venueMarketId: makeId("venue-market"),
      eventId: events[13].id,
      title: `Bitcoin Bitcoin Bitcoin Up or Down high-volume future ${needle}`,
      closeTime: events[13].endDate,
      expirationTime: events[13].endDate,
      volumeTotal: 1_000_000,
    },
    {
      id: makeId("kalshi:market"),
      venue: "kalshi",
      venueMarketId: makeId("venue-market"),
      eventId: events[14].id,
      title: "Morocco",
      closeTime: events[14].endDate,
      expirationTime: events[14].endDate,
      volumeTotal: 1_000_000,
      dflowNativeAcceptingOrders: false,
    },
    {
      id: makeId("kalshi:market"),
      venue: "kalshi",
      venueMarketId: makeId("venue-market"),
      eventId: events[14].id,
      title: "USA",
      closeTime: events[14].endDate,
      expirationTime: events[14].endDate,
      volumeTotal: 900_000,
      dflowNativeAcceptingOrders: true,
    },
    {
      id: makeId("polymarket:market"),
      venue: "polymarket",
      venueMarketId: makeId("venue-market"),
      eventId: events[15].id,
      title: "Morocco",
      closeTime: events[15].endDate,
      expirationTime: events[15].endDate,
      volumeTotal: 750,
    },
    {
      id: makeId("polymarket:market"),
      venue: "polymarket",
      venueMarketId: makeId("venue-market"),
      eventId: events[15].id,
      title: "France",
      closeTime: events[15].endDate,
      expirationTime: events[15].endDate,
      volumeTotal: 800,
    },
    {
      id: makeId("polymarket:market"),
      venue: "polymarket",
      venueMarketId: makeId("venue-market"),
      eventId: events[15].id,
      title: "Brazil",
      closeTime: events[15].endDate,
      expirationTime: events[15].endDate,
      volumeTotal: 10_000_000,
    },
    {
      id: makeId("kalshi:market"),
      venue: "kalshi",
      venueMarketId: makeId("venue-market"),
      eventId: events[2].id,
      title: `Description rank market ${needle}`,
      closeTime: events[2].endDate,
      expirationTime: events[2].endDate,
      volumeTotal: 5000,
    },
    {
      id: makeId("polymarket:market"),
      venue: "polymarket",
      venueMarketId: makeId("venue-market"),
      eventId: events[3].id,
      title: `Title rank market ${needle}`,
      closeTime: events[3].endDate,
      expirationTime: events[3].endDate,
      volumeTotal: 50,
    },
    {
      id: makeId("polymarket:market"),
      venue: "polymarket",
      venueMarketId: makeId("venue-market"),
      eventId: events[4].id,
      title: `Bitcoin market ${needle}`,
      closeTime: events[4].endDate,
      expirationTime: events[4].endDate,
      volumeTotal: 75,
    },
    {
      id: makeId("polymarket:market"),
      venue: "polymarket",
      venueMarketId: makeId("venue-market"),
      eventId: events[5].id,
      title: `Formula 2026 market ${needle}`,
      closeTime: events[5].endDate,
      expirationTime: events[5].endDate,
      volumeTotal: 25,
    },
    {
      id: makeId("polymarket:market"),
      venue: "polymarket",
      venueMarketId: makeId("venue-market"),
      eventId: events[6].id,
      title: `Formula 20260 market ${needle}`,
      closeTime: events[6].endDate,
      expirationTime: events[6].endDate,
      volumeTotal: 20,
    },
    {
      id: makeId("polymarket:market"),
      venue: "polymarket",
      venueMarketId: makeId("venue-market"),
      eventId: events[7].id,
      title: `X marker market ${needle}`,
      closeTime: events[7].endDate,
      expirationTime: events[7].endDate,
      volumeTotal: 15,
    },
    {
      id: makeId("polymarket:market"),
      venue: "polymarket",
      venueMarketId: makeId("venue-market"),
      eventId: events[8].id,
      title: `Primary search market ${fallbackNeedle}`,
      closeTime: events[8].endDate,
      expirationTime: events[8].endDate,
      volumeTotal: 1,
    },
    {
      id: makeId("polymarket:market"),
      venue: "polymarket",
      venueMarketId: makeId("venue-market"),
      eventId: events[9].id,
      title: `Description-only fallback market`,
      description: `Hidden market recall token ${fallbackNeedle}`,
      closeTime: events[9].endDate,
      expirationTime: events[9].endDate,
      volumeTotal: 3,
    },
    {
      id: makeId("polymarket:market"),
      venue: "polymarket",
      venueMarketId: makeId("venue-market"),
      eventId: events[10].id,
      title: "Fallback market outside overfetch window",
      description: `Hidden market recall token ${fallbackNeedle}`,
      closeTime: events[10].endDate,
      expirationTime: events[10].endDate,
      volumeTotal: 2,
    },
    ...outOfCategoryFallbackEvents.map((event, index) => ({
      id: makeId("polymarket:market"),
      venue: "polymarket" as const,
      venueMarketId: makeId("venue-market"),
      eventId: event.id,
      title: `Other category fallback market ${index}`,
      description: `Hidden market recall token ${fallbackNeedle}`,
      closeTime: event.endDate,
      expirationTime: event.endDate,
      volumeTotal: 500 + index,
    })),
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

    {
      const response = await app.inject({
        method: "GET",
        url: `/feed?${buildQuery({
          view: "events",
          venue: "polymarket",
          sort: "time",
          sort_dir: "asc",
          limit: 5,
        })}`,
      });
      assert.equal(response.statusCode, 200);
    }

    {
      const response = await app.inject({
        method: "GET",
        url: "/meta/categories/facets?venue=polymarket",
      });
      assert.equal(response.statusCode, 200);
    }

    {
      for (const q of ["bit", "bitcoi"]) {
        const response = await app.inject({
          method: "GET",
          url: `/feed?${buildQuery({
            q,
            view: "events",
            category,
            limit: 5,
          })}`,
        });
        assert.equal(response.statusCode, 200);
        const payload = response.json<FeedPayload>();
        assert.ok(
          payload.data.some((event) => event.eventId === events[4].id),
          `expected ${q} to match bitcoin event`,
        );
      }
    }

    {
      const response = await app.inject({
        method: "GET",
        url: `/feed?${buildQuery({
          q: "2026",
          view: "events",
          category,
          limit: 10,
        })}`,
      });
      assert.equal(response.statusCode, 200);
      const payload = response.json<FeedPayload>();
      const eventIds = payload.data.map((event) => event.eventId);
      assert.ok(eventIds.includes(events[5].id));
      assert.ok(
        !eventIds.includes(events[6].id),
        "complete numeric tokens should not use broad prefix search",
      );
    }

    {
      const response = await app.inject({
        method: "GET",
        url: `/feed?${buildQuery({
          q: "Morocc",
          view: "events",
          category,
          limit: 10,
        })}`,
      });
      assert.equal(response.statusCode, 200);
      const payload = response.json<FeedPayload>();
      const eventIds = payload.data.map((event) => event.eventId);
      assert.ok(
        !eventIds.includes(events[14].id),
        "search should not admit an event through a non-orderable child market",
      );
      const visibleWorldCupEvent = payload.data.find(
        (event) => event.eventId === events[15].id,
      );
      assert.deepEqual(
        visibleWorldCupEvent?.markets.map((market) => market.marketTitle),
        ["Morocco"],
        "search should preview matching visible child markets instead of unrelated siblings",
      );
    }

    {
      const response = await app.inject({
        method: "GET",
        url: `/feed?${buildQuery({
          q: "France",
          view: "events",
          category,
          limit: 10,
        })}`,
      });
      assert.equal(response.statusCode, 200);
      const payload = response.json<FeedPayload>();
      const worldCupEvent = payload.data.find(
        (event) => event.eventId === events[15].id,
      );
      assert.deepEqual(
        worldCupEvent?.markets.map((market) => market.marketTitle),
        ["France"],
        "World Cup winner searches should find the visible country child market",
      );
    }

    {
      const response = await app.inject({
        method: "GET",
        url: `/feed?${buildQuery({
          q: "Donald Trump",
          view: "events",
          category,
          limit: 5,
        })}`,
      });
      assert.equal(response.statusCode, 200);
      const payload = response.json<FeedPayload>();
      const childMarketEvent = payload.data.find(
        (event) => event.eventId === events[1].id,
      );
      assert.deepEqual(
        childMarketEvent?.markets.map((market) => market.marketTitle),
        ["Donald Trump"],
        "event-mode search should prefer exact child market matches over broader token matches",
      );
      const lastNameOnlyEvent = payload.data.find(
        (event) => event.eventId === events[11].id,
      );
      assert.deepEqual(
        lastNameOnlyEvent?.markets.map((market) => market.marketTitle),
        ["Trump - USA President"],
        "event-mode search should use bounded child fallback for last-name market labels before showing all siblings",
      );
    }

    {
      const response = await app.inject({
        method: "GET",
        url: `/feed?${buildQuery({
          q: "x",
          view: "events",
          category,
          limit: 10,
        })}`,
      });
      assert.equal(response.statusCode, 200);
      const payload = response.json<FeedPayload>();
      const eventIds = payload.data.map((event) => event.eventId);
      assert.ok(eventIds.includes(events[7].id));
      assert.ok(
        !eventIds.includes(events[0].id),
        "one-character search should not fall back to the unfiltered feed",
      );
    }

    {
      const response = await app.inject({
        method: "GET",
        url: `/feed?${buildQuery({
          q: fallbackNeedle,
          view: "events",
          category,
          limit: 10,
        })}`,
      });
      assert.equal(response.statusCode, 200);
      const payload = response.json<FeedPayload>();
      const eventIds = payload.data.map((event) => event.eventId);
      assert.equal(eventIds[0], events[8].id);
      assert.equal(new Set(eventIds).size, eventIds.length);
      assert.ok(
        eventIds.includes(events[9].id),
        "single-token search should fall back to full text when primary results underfill",
      );
    }

    {
      const response = await app.inject({
        method: "GET",
        url: `/feed?${buildQuery({
          q: fallbackNeedle,
          view: "events",
          categories: category,
          limit: 10,
        })}`,
      });
      assert.equal(response.statusCode, 200);
      const payload = response.json<FeedPayload>();
      const eventIds = payload.data.map((event) => event.eventId);
      assert.ok(eventIds.includes(events[9].id));
      assert.ok(
        eventIds.includes(events[10].id),
        "category-filtered fallback should overfetch enough global candidates before category filtering",
      );
      const outOfCategoryEventIds = new Set(
        outOfCategoryFallbackEvents.map((event) => event.id),
      );
      assert.ok(
        eventIds.every((eventId) => !outOfCategoryEventIds.has(eventId)),
        "category-filtered fallback should not return out-of-category events",
      );
    }

    {
      const smallResponse = await app.inject({
        method: "GET",
        url: `/feed?${buildQuery({
          q: fallbackNeedle,
          view: "events",
          category,
          limit: 3,
        })}`,
      });
      const largeResponse = await app.inject({
        method: "GET",
        url: `/feed?${buildQuery({
          q: fallbackNeedle,
          view: "events",
          category,
          limit: 18,
        })}`,
      });
      assert.equal(smallResponse.statusCode, 200);
      assert.equal(largeResponse.statusCode, 200);
      const smallEventIds = smallResponse
        .json<FeedPayload>()
        .data.map((event) => event.eventId);
      const largeEventIds = largeResponse
        .json<FeedPayload>()
        .data.map((event) => event.eventId);
      assert.deepEqual(
        smallEventIds,
        largeEventIds.slice(0, smallEventIds.length),
        "search result ordering should not depend on the requested page limit",
      );
    }

    {
      const response = await app.inject({
        method: "GET",
        url: `/feed?${buildQuery({
          q: "hidden recall",
          view: "events",
          category,
          limit: 10,
        })}`,
      });
      assert.equal(response.statusCode, 200);
      const payload = response.json<FeedPayload>();
      const eventIds = payload.data.map((event) => event.eventId);
      assert.ok(
        eventIds.includes(events[9].id),
        "multi-token search should keep full description recall",
      );
    }

    {
      for (const q of ["will", "this"]) {
        const response = await app.inject({
          method: "GET",
          url: `/feed?${buildQuery({
            q,
            view: "events",
            category,
            limit: 10,
          })}`,
        });
        assert.equal(response.statusCode, 200);
        const payload = response.json<FeedPayload>();
        assert.ok(
          payload.data.length > 0,
          `${q} should fall back to normal feed results when Postgres querytree is empty`,
        );
      }
    }

    {
      const response = await app.inject({
        method: "GET",
        url: `/feed?${buildQuery({
          q: `President Trump June ${needle}`,
          view: "events",
          category,
          limit: 5,
        })}`,
      });
      assert.equal(response.statusCode, 200);
      const payload = response.json<FeedPayload>();
      const eventIds = payload.data.map((event) => event.eventId);
      assert.ok(eventIds.includes(events[0].id));
      assert.ok(eventIds.includes(events[1].id));
      const eventTitleOnlyMatch = payload.data.find(
        (event) => event.eventId === events[0].id,
      );
      assert.deepEqual(
        eventTitleOnlyMatch?.markets.map((market) => market.marketTitle),
        [
          `Second event title backed market ${needle}`,
          `Event title backed market ${needle}`,
        ],
        "event-mode search should keep all child markets when only the event matches",
      );
      const childMarketEvent = payload.data.find(
        (event) => event.eventId === events[1].id,
      );
      assert.deepEqual(
        childMarketEvent?.markets.map((market) => market.marketTitle),
        [`Trump President June market child ${needle}`],
        "event-mode search should expand direct child market matches instead of unrelated sibling markets",
      );
    }

    {
      const response = await app.inject({
        method: "GET",
        url: `/feed?${buildQuery({
          q: "Elon Musk",
          view: "events",
          category,
          limit: 5,
        })}`,
      });
      assert.equal(response.statusCode, 200);
      const payload = response.json<FeedPayload>();
      const childMarketEvent = payload.data.find(
        (event) => event.eventId === events[1].id,
      );
      assert.deepEqual(
        childMarketEvent?.markets.map((market) => market.marketTitle),
        [`Generic nomination outcome market ${needle}`],
        "event-mode search should match market outcomes and expand only the matching child market",
      );
    }

    {
      const savedSearchLimit = env.feedSearchResultMatchLimit;
      env.feedSearchResultMatchLimit = 1;
      try {
        const response = await app.inject({
          method: "GET",
          url: `/feed?${buildQuery({
            q: `Bitcoin up ${needle}`,
            view: "events",
            category,
            sort: "time",
            sort_dir: "asc",
            limit: 2,
          })}`,
        });
        assert.equal(response.statusCode, 200);
        const payload = response.json<FeedPayload>();
        assert.equal(
          payload.data[0]?.eventId,
          events[12].id,
          "time-sorted search should apply chronological ordering across all search matches, not only top relevance matches",
        );
      } finally {
        env.feedSearchResultMatchLimit = savedSearchLimit;
      }
    }

    {
      const response = await app.inject({
        method: "GET",
        url: `/feed?${buildQuery({
          q: `Trump President June ${needle}`,
          view: "markets",
          venue: "polymarket",
          category,
          sort: "totalvol",
          sort_dir: "desc",
          limit: 20,
        })}`,
      });
      assert.equal(response.statusCode, 200);
      const payload = response.json<FeedPayload>();
      const uniqueEventIds = Array.from(
        new Set(payload.data.map((event) => event.eventId)),
      );
      assert.deepEqual(
        uniqueEventIds,
        [events[1].id, events[0].id],
      );
    }

    {
      const response = await app.inject({
        method: "GET",
        url: `/feed?${buildQuery({
          q: `Alpha beta ${needle}`,
          view: "events",
          category,
          limit: 2,
        })}`,
      });
      assert.equal(response.statusCode, 200);
      const payload = response.json<FeedPayload>();
      assert.equal(payload.data[0]?.eventId, events[2].id);
      assert.equal(payload.data[1]?.eventId, events[3].id);
    }

    {
      const response = await app.inject({
        method: "GET",
        url: `/feed?${buildQuery({
          view: "events",
          category,
          sort: "totalvol",
          sort_dir: "desc",
          limit: 2,
        })}`,
      });
      assert.equal(response.statusCode, 200);
      const payload = response.json<FeedPayload>();
      assert.deepEqual(
        payload.data.map((event) => event.eventId),
        [events[13].id, events[2].id],
      );
    }
  } finally {
    env.feedTtlSec = previousFeedTtl;
    env.feedSearchResultMatchLimit = previousFeedSearchResultMatchLimit;
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
