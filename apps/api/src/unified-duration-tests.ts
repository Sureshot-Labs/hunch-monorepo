#!/usr/bin/env tsx

import assert from "node:assert/strict";
import crypto from "node:crypto";

import {
  deriveExactWindowDurationMinutes,
  deriveLimitlessDurationMinutes,
  derivePolymarketDurationMinutes,
  upsertUnifiedEvents,
  upsertUnifiedMarkets,
} from "@hunch/db";
import { buildApp } from "./app.js";
import { pool } from "./db.js";
import { env } from "./env.js";
import { buildEventDurationExistsSql } from "./repos/unified-read.js";
import { feedQuerySchema } from "./schemas/feed.js";
import { forYouQuerySchema } from "./schemas/for-you.js";

type FeedPayload = {
  data: Array<{
    eventId: string;
    durationMinutes?: number | null;
    markets: Array<{
      marketId: string;
      marketTitle: string;
      durationMinutes?: number | null;
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

async function insertEvent(input: {
  id: string;
  venueEventId: string;
  title: string;
  category: string;
  startDate: Date;
  endDate: Date;
  durationMinutes?: number | null;
}) {
  await upsertUnifiedEvents(pool, [
    {
      id: input.id,
      venue: "polymarket",
      venue_event_id: input.venueEventId,
      title: input.title,
      category: input.category,
      status: "ACTIVE",
      duration_minutes: input.durationMinutes ?? undefined,
      start_date: input.startDate,
      end_date: input.endDate,
      volume_total: 100,
      volume_24h: 10,
      liquidity: 100,
      slug: makeId("slug"),
    },
  ]);
}

async function insertMarket(input: {
  id: string;
  venueMarketId: string;
  eventId: string;
  title: string;
  closeTime: Date;
  durationMinutes?: number | null;
}) {
  await upsertUnifiedMarkets(pool, [
    {
      id: input.id,
      venue: "polymarket",
      venue_market_id: input.venueMarketId,
      event_id: input.eventId,
      title: input.title,
      category: "duration-test",
      status: "ACTIVE",
      market_type: "binary",
      duration_minutes: input.durationMinutes ?? undefined,
      open_time: new Date(Date.now() - 60_000),
      close_time: input.closeTime,
      expiration_time: input.closeTime,
      best_bid: 0.45,
      best_ask: 0.55,
      last_price: 0.5,
      volume_total: 100,
      volume_24h: 10,
      liquidity: 100,
      open_interest: 50,
      outcomes: JSON.stringify(["Yes", "No"]),
      slug: makeId("slug"),
    },
  ]);
}

async function main() {
  assert.equal(derivePolymarketDurationMinutes("btc-up-or-down-5m"), 5);
  assert.equal(derivePolymarketDurationMinutes("eth-up-or-down-15m"), 15);
  assert.equal(derivePolymarketDurationMinutes("sol-up-or-down-1h"), 60);
  assert.equal(derivePolymarketDurationMinutes("over-15m-public-sale"), null);
  assert.equal(
    deriveLimitlessDurationMinutes({ stableSlug: "btc-5min-price" }),
    5,
  );
  assert.equal(
    deriveLimitlessDurationMinutes({ stableSlug: "btc-15min-price" }),
    15,
  );
  assert.equal(
    deriveLimitlessDurationMinutes({ stableSlug: "btc-hourly-price" }),
    60,
  );
  assert.equal(
    deriveLimitlessDurationMinutes({
      slug: "xrp-up-or-down-15-mins-1778034615564",
    }),
    15,
  );
  assert.equal(
    deriveLimitlessDurationMinutes({
      slug: "will-arsenal-score-before-15-mins-vs-kairat",
      title: "Will Arsenal score before 15 mins vs Kairat?",
    }),
    null,
  );
  assert.equal(
    deriveExactWindowDurationMinutes({
      openTime: new Date("2026-01-01T00:00:00Z"),
      closeTime: new Date("2026-01-01T00:15:00Z"),
    }),
    15,
  );
  {
    assert.deepEqual(
      feedQuerySchema.parse({ duration_minutes: "60,5,15,5" })
        .duration_minutes,
      [5, 15, 60],
    );
    assert.deepEqual(
      feedQuerySchema.parse({ duration_minutes: ["60", "5,15"] })
        .duration_minutes,
      [5, 15, 60],
    );
    assert.deepEqual(
      forYouQuerySchema.parse({ duration_minutes: "15" }).duration_minutes,
      [15],
    );
    assert.throws(() => feedQuerySchema.parse({ duration_minutes: "7" }));
    assert.throws(() => feedQuerySchema.parse({ duration_minutes: "5,foo" }));
    assert.throws(() => feedQuerySchema.parse({ duration_minutes: "0" }));
  }
  {
    const params: unknown[] = [];
    const sql = buildEventDurationExistsSql({
      inputs: { durationMinutes: [5, 15] },
      add: (value) => {
        params.push(value);
        return `$${params.length}`;
      },
      nowParam: "$now",
    });
    assert.ok(sql?.includes("dm.duration_minutes = ANY($1::int[])"));
    assert.ok(sql?.includes("dm.expiration_time is null"));
    assert.ok(sql?.includes("dm.close_time is null"));
    assert.ok(sql?.includes("dflowNativeAcceptingOrders"));
    assert.deepEqual(params, [[5, 15]]);
  }

  const app = await buildApp();
  const previousFeedTtl = env.feedTtlSec;
  env.feedTtlSec = 0;

  const suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
  const category = `duration-test-${suffix}`;
  const now = Date.now();
  const closeTime = new Date(now + 60 * 60 * 1000);
  const event5 = {
    id: makeId("polymarket:event"),
    venueEventId: makeId("duration-event"),
  };
  const event15 = {
    id: makeId("polymarket:event"),
    venueEventId: makeId("duration-event"),
  };
  const market5 = {
    id: makeId("polymarket:market"),
    venueMarketId: makeId("duration-market"),
  };
  const market15SameEvent = {
    id: makeId("polymarket:market"),
    venueMarketId: makeId("duration-market"),
  };
  const market15OtherEvent = {
    id: makeId("polymarket:market"),
    venueMarketId: makeId("duration-market"),
  };
  const seededMarketIds = [
    market5.id,
    market15SameEvent.id,
    market15OtherEvent.id,
  ];
  const seededEventIds = [event5.id, event15.id];

  try {
    await insertEvent({
      ...event5,
      title: "Duration 5m event",
      category,
      startDate: new Date(now - 60 * 60 * 1000),
      endDate: closeTime,
      durationMinutes: 5,
    });
    await insertEvent({
      ...event15,
      title: "Duration 15m event",
      category,
      startDate: new Date(now - 60 * 60 * 1000),
      endDate: closeTime,
      durationMinutes: 15,
    });
    await insertMarket({
      ...market5,
      eventId: event5.id,
      title: "Five minute market",
      closeTime,
      durationMinutes: 5,
    });
    await insertMarket({
      ...market15SameEvent,
      eventId: event5.id,
      title: "Fifteen minute sibling market",
      closeTime,
      durationMinutes: 15,
    });
    await insertMarket({
      ...market15OtherEvent,
      eventId: event15.id,
      title: "Other fifteen minute market",
      closeTime,
      durationMinutes: 15,
    });

    const eventResponse = await app.inject({
      method: "GET",
      url: `/feed?${buildQuery({
        view: "events",
        category,
        duration_minutes: 5,
        limit: 10,
      })}`,
    });
    assert.equal(eventResponse.statusCode, 200);
    const eventPayload = eventResponse.json<FeedPayload>();
    assert.deepEqual(
      eventPayload.data.map((row) => row.eventId),
      [event5.id],
    );
    assert.deepEqual(
      eventPayload.data[0]?.markets.map((market) => market.marketId),
      [market5.venueMarketId],
    );
    assert.equal(eventPayload.data[0]?.durationMinutes, 5);
    assert.equal(eventPayload.data[0]?.markets[0]?.durationMinutes, 5);

    const marketResponse = await app.inject({
      method: "GET",
      url: `/feed?${buildQuery({
        view: "markets",
        category,
        duration_minutes: 15,
        limit: 10,
      })}`,
    });
    assert.equal(marketResponse.statusCode, 200);
    const marketPayload = marketResponse.json<FeedPayload>();
    const returnedMarketIds = marketPayload.data
      .flatMap((row) => row.markets)
      .map((market) => market.marketId)
      .sort();
    assert.deepEqual(
      returnedMarketIds,
      [market15OtherEvent.venueMarketId, market15SameEvent.venueMarketId].sort(),
    );
    assert.deepEqual(
      marketPayload.data.flatMap((row) =>
        row.markets.map((market) => market.durationMinutes),
      ),
      [15, 15],
    );

    const multiResponse = await app.inject({
      method: "GET",
      url: `/feed?${buildQuery({
        view: "events",
        category,
        duration_minutes: "60,5,15,5",
        limit: 10,
      })}`,
    });
    assert.equal(multiResponse.statusCode, 200);
    const multiPayload = multiResponse.json<FeedPayload>();
    assert.deepEqual(
      multiPayload.data.map((row) => row.eventId).sort(),
      [event15.id, event5.id].sort(),
    );
    assert.deepEqual(
      multiPayload.data
        .flatMap((row) => row.markets)
        .map((market) => market.marketId)
        .sort(),
      [
        market15OtherEvent.venueMarketId,
        market15SameEvent.venueMarketId,
        market5.venueMarketId,
      ].sort(),
    );

    const invalidResponse = await app.inject({
      method: "GET",
      url: `/feed?${buildQuery({
        view: "events",
        category,
        duration_minutes: 7,
        limit: 10,
      })}`,
    });
    assert.equal(invalidResponse.statusCode, 400);
  } finally {
    if (seededMarketIds.length) {
      await pool.query("delete from unified_markets where id = any($1::text[])", [
        seededMarketIds,
      ]);
    }
    if (seededEventIds.length) {
      await pool.query("delete from unified_events where id = any($1::text[])", [
        seededEventIds,
      ]);
    }
    env.feedTtlSec = previousFeedTtl;
    await app.close();
  }
}

await main();
