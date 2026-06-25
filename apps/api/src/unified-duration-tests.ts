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

async function upsertTestEvent(input: {
  category: string;
  id: string;
  title: string;
  venue: "kalshi" | "polymarket";
  venueEventId: string;
}) {
  await upsertUnifiedEvents(pool, [
    {
      id: input.id,
      venue: input.venue,
      venue_event_id: input.venueEventId,
      title: input.title,
      category: input.category,
      status: "ACTIVE",
      start_date: new Date(Date.now() - 60_000),
      end_date: new Date(Date.now() + 60 * 60 * 1000),
      volume_total: 100,
      volume_24h: 10,
      liquidity: 100,
      slug: makeId("slug"),
    },
  ]);
}

async function upsertTestMarket(input: {
  closeTime: Date;
  eventId: string;
  filterUnchanged?: boolean;
  id: string;
  resolvedOutcome?: string;
  resolvedOutcomePct?: number;
  status: "ACTIVE" | "CLOSED" | "SETTLED" | "ARCHIVED";
  title: string;
  venue: "kalshi" | "polymarket";
  venueMarketId: string;
}) {
  await upsertUnifiedMarkets(
    pool,
    [
      {
        id: input.id,
        venue: input.venue,
        venue_market_id: input.venueMarketId,
        event_id: input.eventId,
        title: input.title,
        category: "status-merge-test",
        status: input.status,
        market_type: "binary",
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
        outcomes: JSON.stringify(["YES", "NO"]),
        token_yes: input.venue === "kalshi" ? makeId("sol:yes") : undefined,
        token_no: input.venue === "kalshi" ? makeId("sol:no") : undefined,
        resolved_outcome: input.resolvedOutcome,
        resolved_outcome_pct: input.resolvedOutcomePct,
        slug: makeId("slug"),
      },
    ],
    input.filterUnchanged ? { filterUnchanged: true } : undefined,
  );
}

async function loadMarketStatus(id: string): Promise<string | null> {
  const { rows } = await pool.query<{ status: string }>(
    "select status::text as status from unified_markets where id = $1",
    [id],
  );
  return rows[0]?.status ?? null;
}

async function assertKalshiActiveReopenPolicy() {
  const suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
  const futureClose = new Date(Date.now() + 60 * 60 * 1000);
  const pastClose = new Date(Date.now() - 60 * 60 * 1000);
  const eventIds = {
    kalshi: makeId("kalshi:event"),
    polymarket: makeId("polymarket:event"),
  };
  const venueEventIds = {
    kalshi: `KXSTATUSMERGE-${suffix}`,
    polymarket: makeId("status-merge-event"),
  };
  const marketIds = {
    kalshiFuture: makeId("kalshi:market"),
    kalshiPast: makeId("kalshi:market"),
    kalshiSettled: makeId("kalshi:market"),
    kalshiOutcome: makeId("kalshi:market"),
    polymarket: makeId("polymarket:market"),
  };
  const venueMarketIds = {
    kalshiFuture: `KXSTATUSMERGE-${suffix}-FUTURE`,
    kalshiPast: `KXSTATUSMERGE-${suffix}-PAST`,
    kalshiSettled: `KXSTATUSMERGE-${suffix}-SETTLED`,
    kalshiOutcome: `KXSTATUSMERGE-${suffix}-OUTCOME`,
    polymarket: makeId("status-merge-market"),
  };

  try {
    await upsertTestEvent({
      id: eventIds.kalshi,
      venue: "kalshi",
      venueEventId: venueEventIds.kalshi,
      title: "Kalshi status merge test",
      category: "status-merge-test",
    });
    await upsertTestEvent({
      id: eventIds.polymarket,
      venue: "polymarket",
      venueEventId: venueEventIds.polymarket,
      title: "Polymarket status merge test",
      category: "status-merge-test",
    });

    await upsertTestMarket({
      id: marketIds.kalshiFuture,
      venue: "kalshi",
      venueMarketId: venueMarketIds.kalshiFuture,
      eventId: eventIds.kalshi,
      title: "Kalshi future stale closed",
      status: "CLOSED",
      closeTime: futureClose,
    });
    await upsertTestMarket({
      id: marketIds.kalshiFuture,
      venue: "kalshi",
      venueMarketId: venueMarketIds.kalshiFuture,
      eventId: eventIds.kalshi,
      title: "Kalshi future stale closed",
      status: "ACTIVE",
      closeTime: futureClose,
      filterUnchanged: true,
    });
    assert.equal(await loadMarketStatus(marketIds.kalshiFuture), "ACTIVE");

    await upsertTestMarket({
      id: marketIds.kalshiPast,
      venue: "kalshi",
      venueMarketId: venueMarketIds.kalshiPast,
      eventId: eventIds.kalshi,
      title: "Kalshi past stale closed",
      status: "CLOSED",
      closeTime: pastClose,
    });
    await upsertTestMarket({
      id: marketIds.kalshiPast,
      venue: "kalshi",
      venueMarketId: venueMarketIds.kalshiPast,
      eventId: eventIds.kalshi,
      title: "Kalshi past stale closed",
      status: "ACTIVE",
      closeTime: pastClose,
    });
    assert.equal(await loadMarketStatus(marketIds.kalshiPast), "CLOSED");

    await upsertTestMarket({
      id: marketIds.kalshiSettled,
      venue: "kalshi",
      venueMarketId: venueMarketIds.kalshiSettled,
      eventId: eventIds.kalshi,
      title: "Kalshi settled",
      status: "SETTLED",
      closeTime: futureClose,
    });
    await upsertTestMarket({
      id: marketIds.kalshiSettled,
      venue: "kalshi",
      venueMarketId: venueMarketIds.kalshiSettled,
      eventId: eventIds.kalshi,
      title: "Kalshi settled",
      status: "ACTIVE",
      closeTime: futureClose,
    });
    assert.equal(await loadMarketStatus(marketIds.kalshiSettled), "SETTLED");

    await upsertTestMarket({
      id: marketIds.kalshiOutcome,
      venue: "kalshi",
      venueMarketId: venueMarketIds.kalshiOutcome,
      eventId: eventIds.kalshi,
      title: "Kalshi closed with outcome",
      status: "CLOSED",
      closeTime: futureClose,
      resolvedOutcome: "YES",
    });
    await upsertTestMarket({
      id: marketIds.kalshiOutcome,
      venue: "kalshi",
      venueMarketId: venueMarketIds.kalshiOutcome,
      eventId: eventIds.kalshi,
      title: "Kalshi closed with outcome",
      status: "ACTIVE",
      closeTime: futureClose,
    });
    assert.equal(await loadMarketStatus(marketIds.kalshiOutcome), "CLOSED");

    await upsertTestMarket({
      id: marketIds.polymarket,
      venue: "polymarket",
      venueMarketId: venueMarketIds.polymarket,
      eventId: eventIds.polymarket,
      title: "Polymarket closed",
      status: "CLOSED",
      closeTime: futureClose,
    });
    await upsertTestMarket({
      id: marketIds.polymarket,
      venue: "polymarket",
      venueMarketId: venueMarketIds.polymarket,
      eventId: eventIds.polymarket,
      title: "Polymarket closed",
      status: "ACTIVE",
      closeTime: futureClose,
    });
    assert.equal(await loadMarketStatus(marketIds.polymarket), "ACTIVE");
  } finally {
    await pool.query("delete from unified_markets where id = any($1::text[])", [
      Object.values(marketIds),
    ]);
    await pool.query("delete from unified_events where id = any($1::text[])", [
      Object.values(eventIds),
    ]);
  }
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
  await assertKalshiActiveReopenPolicy();

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
