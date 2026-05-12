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
  category?: string | null;
  closeTime: Date;
  expirationTime: Date;
  volumeTotal: number;
  liquidity?: number;
};

type FeedPayload = {
  count: number;
  data: Array<{
    eventId: string;
    eventTitle: string | null;
    markets: Array<{
      id: string;
      marketId: string;
      title: string | null;
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
        created_at,
        updated_at
      )
      values (
        $1, $2, $3, $4, $5, $6, $7, 'ACTIVE', 'binary',
        now() - interval '1 hour', $8, $9,
        0.45, 0.55, 0.5, $10, 10, $11, 50,
        '["Yes","No"]', $12, now(), now()
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
      makeId("slug"),
    ],
  );
}

async function main() {
  const app = await buildApp();
  const previousFeedTtl = env.feedTtlSec;
  env.feedTtlSec = 0;

  const suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
  const needle = `ftstest${suffix}`;
  const category = `feed-search-${suffix}`;
  const now = Date.now();
  const seededEventIds: string[] = [];
  const seededMarketIds: string[] = [];

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
      eventId: events[1].id,
      title: `Trump President June market child ${needle}`,
      closeTime: events[1].endDate,
      expirationTime: events[1].endDate,
      volumeTotal: 1200,
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
          limit: 5,
        })}`,
      });
      assert.equal(response.statusCode, 200);
      const payload = response.json<FeedPayload>();
      assert.deepEqual(
        payload.data.map((event) => event.eventId),
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
      assert.equal(payload.data[0]?.eventId, events[3].id);
      assert.equal(payload.data[1]?.eventId, events[2].id);
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
        [events[2].id, events[1].id],
      );
    }
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
