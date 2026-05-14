#!/usr/bin/env tsx

import assert from "node:assert/strict";
import crypto from "node:crypto";

import { buildApp } from "./app.js";
import { pool } from "./db.js";
import { insertRuntimePolicy } from "./repos/runtime-policies.js";

type SidebarPayload = {
  trendingNow: SidebarEvent[];
  volumeMovers24h: SidebarEvent[];
  liquidityMovers24h: SidebarEvent[];
  topMovers24h: SidebarEvent[];
  generatedAt: string;
};

type SidebarEvent = {
  eventId: string;
  venue: string;
  volume24h: number;
  volumeLast24h: number | null;
  volumePrev24h: number | null;
  volumeLast24hChange: number | null;
  volumeLast24hChangePct: number | null;
  liquidityNow: number | null;
  liquidityChange24h: number | null;
  liquidityChangePct24h: number | null;
  change24h: number | null;
  activityMetricsUpdatedAt: string | null;
  activitySparklines?: {
    volume?: SidebarSparkline;
    liquidity?: SidebarSparkline;
    movement?: SidebarSparkline;
  };
  marketsPreview?: Array<{
    marketId: string;
    volume24h: number;
    volumeLast24h: number | null;
    volumePrev24h: number | null;
    liquidityNow: number | null;
    activityMetricsUpdatedAt: string | null;
  }>;
};

type SidebarSparkline = {
  metric: "volume" | "liquidity" | "movement";
  windowHours: number;
  bucketHours: number;
  points: Array<{
    bucketStart: string;
    value: number | null;
    delta: number | null;
    changePct: number | null;
  }>;
};

type SeedEvent = {
  key: string;
  venue?: string;
  volume24h: number;
  volumeLast24h: number | null;
  volumePrev24h: number | null;
  volumeChangePct: number | null;
  volumeValid: boolean;
  liquidityNow: number | null;
  liquidity24hAgo: number | null;
  liquidityChangePct: number | null;
  liquidityValid: boolean;
  change24h: number | null;
};

function makeToken(label: string): string {
  return `${label}-${crypto.randomUUID()}`;
}

async function insertUnifiedEvent(params: {
  eventId: string;
  venue?: string;
  venueEventId: string;
  title: string;
  volume24h: number;
}): Promise<void> {
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
        open_interest,
        slug,
        created_at,
        updated_at
      )
      values (
        $1, $5, $2, $3, null, null, 'ACTIVE',
        now() - interval '1 hour', now() + interval '1 day',
        1000, $4, 100, 120, $6, now(), now()
      )
    `,
    [
      params.eventId,
      params.venueEventId,
      params.title,
      params.volume24h,
      params.venue ?? "polymarket",
      makeToken(`slug-${params.eventId}`),
    ],
  );
}

async function insertUnifiedMarket(params: {
  marketId: string;
  venue?: string;
  venueMarketId: string;
  eventId: string;
  title: string;
  volume24h: number;
}): Promise<void> {
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
        token_yes,
        token_no,
        slug,
        created_at,
        updated_at
      )
      values (
        $1, $9, $2, $3, $4, null, null, 'ACTIVE', 'binary',
        now() - interval '1 hour', now() + interval '1 day', now() + interval '1 day',
        0.45, 0.55, 0.5, 1000, $5, 100, 120,
        '["Yes","No"]', $6, $7, $8, now(), now()
      )
    `,
    [
      params.marketId,
      params.venueMarketId,
      params.eventId,
      params.title,
      params.volume24h,
      makeToken(`yes-${params.marketId}`),
      makeToken(`no-${params.marketId}`),
      makeToken(`slug-${params.marketId}`),
      params.venue ?? "polymarket",
    ],
  );
}

async function insertEventActivityMetric(params: {
  eventId: string;
  venue?: string;
  volumeLast24h: number | null;
  volumePrev24h: number | null;
  volumeChangePct: number | null;
  volumeValid: boolean;
  liquidityNow: number | null;
  liquidity24hAgo: number | null;
  liquidityChangePct: number | null;
  liquidityValid: boolean;
  updatedAt: string;
}): Promise<void> {
  await pool.query(
    `
      insert into unified_event_activity_metrics_24h (
        event_id,
        venue,
        volume_last_24h,
        volume_prev_24h,
        volume_last_24h_change,
        volume_last_24h_change_pct,
        liquidity_now,
        liquidity_24h_ago,
        liquidity_change_24h,
        liquidity_change_pct_24h,
        has_24h_window,
        has_48h_window,
        volume_valid,
        liquidity_valid,
        open_interest_valid,
        updated_at
      )
      values (
        $1, $11, $2, $3,
        case when $2::numeric is not null and $3::numeric is not null then $2::numeric - $3::numeric else null end,
        $4, $5,
        $6,
        case when $5::numeric is not null and $6::numeric is not null then $5::numeric - $6::numeric else null end,
        $7, true, true, $8, $9, false, $10::timestamptz
      )
    `,
    [
      params.eventId,
      params.volumeLast24h,
      params.volumePrev24h,
      params.volumeChangePct,
      params.liquidityNow,
      params.liquidity24hAgo,
      params.liquidityChangePct,
      params.volumeValid,
      params.liquidityValid,
      params.updatedAt,
      params.venue ?? "polymarket",
    ],
  );
}

async function insertMarketActivityMetric(params: {
  marketId: string;
  eventId: string;
  venue?: string;
  volumeLast24h: number | null;
  volumePrev24h: number | null;
  liquidityNow: number | null;
  updatedAt: string;
}): Promise<void> {
  await pool.query(
    `
      insert into unified_market_activity_metrics_24h (
        market_id,
        event_id,
        venue,
        volume_last_24h,
        volume_prev_24h,
        liquidity_now,
        has_24h_window,
        has_48h_window,
        volume_valid,
        liquidity_valid,
        open_interest_valid,
        updated_at
      )
      values ($1, $2, $7, $3, $4, $5, true, true, true, true, false, $6::timestamptz)
    `,
    [
      params.marketId,
      params.eventId,
      params.volumeLast24h,
      params.volumePrev24h,
      params.liquidityNow,
      params.updatedAt,
      params.venue ?? "polymarket",
    ],
  );
}

async function insertMarketActivitySnapshots(params: {
  marketId: string;
  eventId: string;
  venue?: string;
  volumeTotal: number;
  liquidity: number | null;
}): Promise<void> {
  const buckets = [
    { hoursAgo: 2, volumeOffset: -20, liquidityOffset: -2 },
    { hoursAgo: 1, volumeOffset: -10, liquidityOffset: -1 },
    { hoursAgo: 0, volumeOffset: 0, liquidityOffset: 0 },
  ];
  for (const bucket of buckets) {
    await pool.query(
      `
        insert into unified_market_activity_snapshots_1h (
          market_id,
          event_id,
          venue,
          bucket,
          volume_total,
          liquidity,
          open_interest,
          source_updated_at,
          created_at
        )
        values (
          $1,
          $2,
          $8,
          date_trunc('hour', now() - ($3::text || ' hours')::interval),
          greatest($4::numeric + $5::numeric, 0),
          case when $6::numeric is null then null else greatest($6::numeric + $7::numeric, 0) end,
          null,
          now() - ($3::text || ' hours')::interval,
          now() - ($3::text || ' hours')::interval
        )
        on conflict (market_id, bucket) do update
          set event_id = excluded.event_id,
              venue = excluded.venue,
              volume_total = excluded.volume_total,
              liquidity = excluded.liquidity,
              open_interest = excluded.open_interest,
              source_updated_at = excluded.source_updated_at
      `,
      [
        params.marketId,
        params.eventId,
        bucket.hoursAgo,
        params.volumeTotal,
        bucket.volumeOffset,
        params.liquidity,
        bucket.liquidityOffset,
        params.venue ?? "polymarket",
      ],
    );
  }
}

async function insertEventActivitySnapshots(params: {
  eventId: string;
  venue?: string;
  volumeTotal: number;
  liquidity: number | null;
}): Promise<void> {
  const buckets = [
    { hoursAgo: 2, volumeOffset: -20, liquidityOffset: -2 },
    { hoursAgo: 1, volumeOffset: -10, liquidityOffset: -1 },
    { hoursAgo: 0, volumeOffset: 0, liquidityOffset: 0 },
  ];
  for (const bucket of buckets) {
    await pool.query(
      `
        insert into unified_event_activity_snapshots_1h (
          event_id,
          venue,
          bucket,
          volume_total,
          liquidity,
          open_interest,
          source_updated_at,
          created_at,
          updated_at
        )
        values (
          $1,
          $6,
          date_trunc('hour', now() - ($2::text || ' hours')::interval),
          greatest($3::numeric + $4::numeric, 0),
          case when $5::numeric is null then null else greatest($5::numeric + $7::numeric, 0) end,
          null,
          now() - ($2::text || ' hours')::interval,
          now() - ($2::text || ' hours')::interval,
          now() - ($2::text || ' hours')::interval
        )
        on conflict (event_id, venue, bucket) do update
          set volume_total = excluded.volume_total,
              liquidity = excluded.liquidity,
              open_interest = excluded.open_interest,
              source_updated_at = excluded.source_updated_at,
              updated_at = excluded.updated_at
      `,
      [
        params.eventId,
        bucket.hoursAgo,
        params.volumeTotal,
        bucket.volumeOffset,
        params.liquidity,
        params.venue ?? "polymarket",
        bucket.liquidityOffset,
      ],
    );
  }
}

async function main() {
  const app = await buildApp();
  try {
    await pool.query("select 1");
  } catch {
    console.log(
      "[market-map-sidebars-tests] skipped (DATABASE_URL unavailable)",
    );
    await app.close();
    return;
  }

  const suiteId = crypto.randomUUID().slice(0, 8);
  const updatedAt = "2026-04-03T12:00:00.000Z";
  const seeds: SeedEvent[] = [
    {
      key: "alpha",
      volume24h: 1_000_000_000_010,
      volumeLast24h: 1_000_000_000_100,
      volumePrev24h: 500_000_000_050,
      volumeChangePct: 1,
      volumeValid: true,
      liquidityNow: 1_000_000_000_110,
      liquidity24hAgo: 909_090_909_191,
      liquidityChangePct: 0.1,
      liquidityValid: true,
      change24h: 10_000_000_000.2,
    },
    {
      key: "beta",
      volume24h: 1_000_000_000_030,
      volumeLast24h: 2_000_000_000_300,
      volumePrev24h: 1_000_000_000_300,
      volumeChangePct: 0.9999999997,
      volumeValid: true,
      liquidityNow: 1_000_000_000_090,
      liquidity24hAgo: 1_111_111_111_211,
      liquidityChangePct: -0.1,
      liquidityValid: true,
      change24h: 10_000_000_000.5,
    },
    {
      key: "fallback",
      volume24h: 1_000_000_000_500,
      volumeLast24h: null,
      volumePrev24h: null,
      volumeChangePct: null,
      volumeValid: false,
      liquidityNow: null,
      liquidity24hAgo: null,
      liquidityChangePct: null,
      liquidityValid: false,
      change24h: 10_000_000_000.05,
    },
    {
      key: "partial",
      volume24h: 1_000_000_000_005,
      volumeLast24h: 2_000_000_000_000,
      volumePrev24h: 1,
      volumeChangePct: 999,
      volumeValid: false,
      liquidityNow: null,
      liquidity24hAgo: null,
      liquidityChangePct: null,
      liquidityValid: false,
      change24h: null,
    },
    {
      key: "tiny",
      volume24h: 1,
      volumeLast24h: 100,
      volumePrev24h: 1,
      volumeChangePct: 99,
      volumeValid: true,
      liquidityNow: 100,
      liquidity24hAgo: 1,
      liquidityChangePct: 99,
      liquidityValid: true,
      change24h: 20_000_000_000,
    },
    {
      key: "liquidity",
      volume24h: 1_000_000_000_080,
      volumeLast24h: 1_000_000_000_080,
      volumePrev24h: 1_000_000_000_080,
      volumeChangePct: 0,
      volumeValid: false,
      liquidityNow: 2_000_000_000_300,
      liquidity24hAgo: 666_666_666_767,
      liquidityChangePct: 2,
      liquidityValid: true,
      change24h: 10_000_000_000.1,
    },
    {
      key: "limitless",
      venue: "limitless",
      volume24h: 1_000_000_000_700,
      volumeLast24h: 3_000_000_000_000,
      volumePrev24h: 1_000_000_000_000,
      volumeChangePct: 2,
      volumeValid: true,
      liquidityNow: 5_000_000_000_000,
      liquidity24hAgo: 1_000_000_000_000,
      liquidityChangePct: 4,
      liquidityValid: true,
      change24h: 30_000_000_000,
    },
  ];
  const eventIds = seeds.map(
    (seed) => `mm-sidebars-event-${seed.key}-${suiteId}`,
  );
  const marketIds = seeds.map(
    (seed) => `mm-sidebars-market-${seed.key}-${suiteId}`,
  );
  const policy = await insertRuntimePolicy(pool, {
    policyKey: "market_map",
    effectiveAt: new Date(),
    createdBy: null,
    payload: {
      enabled: true,
      venuesEnabled: ["polymarket", "kalshi", "limitless"],
    },
  });

  try {
    for (let index = 0; index < seeds.length; index += 1) {
      const seed = seeds[index];
      const eventId = eventIds[index];
      const marketId = marketIds[index];
      await insertUnifiedEvent({
        eventId,
        venue: seed.venue,
        venueEventId: `venue-${eventId}`,
        title: `Sidebar ${seed.key}`,
        volume24h: seed.volume24h,
      });
      await insertUnifiedMarket({
        marketId,
        venue: seed.venue,
        venueMarketId: `venue-${marketId}`,
        eventId,
        title: `Sidebar market ${seed.key}`,
        volume24h: seed.volume24h,
      });
      await insertMarketActivityMetric({
        marketId,
        eventId,
        venue: seed.venue,
        volumeLast24h: seed.volumeLast24h,
        volumePrev24h: seed.volumePrev24h,
        liquidityNow: seed.liquidityNow,
        updatedAt,
      });
      await insertMarketActivitySnapshots({
        marketId,
        eventId,
        venue: seed.venue,
        volumeTotal: seed.volume24h,
        liquidity: seed.liquidityNow,
      });
      if (seed.key !== "beta") {
        await insertEventActivitySnapshots({
          eventId,
          venue: seed.venue,
          volumeTotal: seed.volume24h,
          liquidity: seed.liquidityNow,
        });
      }
      if (
        seed.volumeLast24h != null ||
        seed.liquidityNow != null ||
        seed.volumeValid ||
        seed.liquidityValid
      ) {
        await insertEventActivityMetric({
          eventId,
          venue: seed.venue,
          volumeLast24h: seed.volumeLast24h,
          volumePrev24h: seed.volumePrev24h,
          volumeChangePct: seed.volumeChangePct,
          volumeValid: seed.volumeValid,
          liquidityNow: seed.liquidityNow,
          liquidity24hAgo: seed.liquidity24hAgo,
          liquidityChangePct: seed.liquidityChangePct,
          liquidityValid: seed.liquidityValid,
          updatedAt,
        });
      }
      if (seed.change24h != null) {
        await pool.query(
          `
            insert into unified_event_change_24h (event_id, change_24h, updated_at)
            values ($1, $2, $3::timestamptz)
          `,
          [eventId, seed.change24h, updatedAt],
        );
      }
    }

    const response = await app.inject({
      method: "GET",
      url:
        "/market-map/sidebars?venues=polymarket&limit=9" +
        "&trendingLimit=3" +
        "&volumeMoversLimit=2" +
        "&liquidityMoversLimit=2" +
        "&topMoversLimit=3" +
        "&volumeMoversSortBy=percent" +
        "&liquidityMoversSortBy=percent" +
        "&minVolume24h=1000000000" +
        "&minLiquidity=1000000000" +
        "&minVolumeChange24h=100000000000" +
        "&minVolumeChangePct24h=0.5" +
        "&minLiquidityChange24h=100000000000" +
        "&minLiquidityChangePct24h=0.05" +
        "&includeVolumeSparkline=true" +
        "&includeLiquiditySparkline=true" +
        "&sparklineWindowHours=2" +
        "&sparklineBucketHours=1",
    });
    assert.equal(response.statusCode, 200, response.body);
    const payload = response.json<SidebarPayload>();

    assert.deepEqual(
      payload.trendingNow.map((item) => item.eventId),
      [eventIds[1], eventIds[2], eventIds[0]],
    );
    assert.deepEqual(
      payload.volumeMovers24h.map((item) => item.eventId),
      [eventIds[0], eventIds[1]],
    );
    assert.equal(
      payload.trendingNow.some((item) => item.eventId === eventIds[3]),
      false,
    );
    assert.equal(
      payload.volumeMovers24h.some((item) => item.eventId === eventIds[3]),
      false,
    );
    assert.equal(
      payload.volumeMovers24h.some((item) => item.eventId === eventIds[4]),
      false,
    );
    assert.deepEqual(
      payload.liquidityMovers24h.map((item) => item.eventId),
      [eventIds[5], eventIds[0]],
    );
    assert.equal(
      payload.liquidityMovers24h.some((item) => item.eventId === eventIds[4]),
      false,
    );
    assert.equal(
      payload.liquidityMovers24h.some((item) => item.eventId === eventIds[1]),
      false,
    );
    assert.deepEqual(
      payload.topMovers24h.map((item) => item.eventId),
      [eventIds[1], eventIds[0], eventIds[5]],
    );
    assert.equal(payload.topMovers24h[0]?.change24h, 10_000_000_000.5);
    assert.equal(
      payload.topMovers24h.some((item) => item.eventId === eventIds[4]),
      false,
    );
    assert.equal(payload.topMovers24h[0]?.eventId, eventIds[1]);
    assert.equal(
      payload.topMovers24h[0]?.activitySparklines?.volume?.points.at(-1)?.value,
      1_000_000_000_030,
    );
    assert.equal(
      payload.topMovers24h[0]?.activitySparklines?.volume?.points.at(-1)?.delta,
      10,
    );

    const alpha = payload.volumeMovers24h[0];
    assert.equal(alpha.volume24h, 1_000_000_000_010);
    assert.equal(alpha.volumeLast24h, 1_000_000_000_100);
    assert.equal(alpha.volumePrev24h, 500_000_000_050);
    assert.equal(alpha.volumeLast24hChangePct, 1);
    assert.equal(alpha.activityMetricsUpdatedAt, updatedAt);
    assert.equal(alpha.activitySparklines?.volume?.metric, "volume");
    assert.equal(alpha.activitySparklines?.volume?.windowHours, 2);
    assert.equal(alpha.activitySparklines?.volume?.bucketHours, 1);
    assert.equal(alpha.activitySparklines?.volume?.points.length, 3);
    assert.equal(
      alpha.activitySparklines?.volume?.points.at(-1)?.value,
      1_000_000_000_010,
    );
    assert.equal(alpha.activitySparklines?.volume?.points.at(-1)?.delta, 10);
    assert.equal(alpha.activitySparklines?.liquidity?.metric, "liquidity");
    assert.equal(alpha.activitySparklines?.liquidity?.points.length, 3);
    assert.equal(
      alpha.activitySparklines?.liquidity?.points.at(-1)?.value,
      1_000_000_000_110,
    );
    assert.equal(alpha.marketsPreview?.[0]?.marketId, marketIds[0]);
    assert.equal(alpha.marketsPreview?.[0]?.volume24h, 1_000_000_000_010);
    assert.equal(alpha.marketsPreview?.[0]?.volumeLast24h, 1_000_000_000_100);
    assert.equal(alpha.marketsPreview?.[0]?.volumePrev24h, 500_000_000_050);
    assert.equal(alpha.marketsPreview?.[0]?.liquidityNow, 1_000_000_000_110);
    assert.equal(
      alpha.marketsPreview?.[0]?.activityMetricsUpdatedAt,
      updatedAt,
    );

    const absoluteResponse = await app.inject({
      method: "GET",
      url:
        "/market-map/sidebars?venues=polymarket&limit=9" +
        "&trendingLimit=0" +
        "&volumeMoversLimit=2" +
        "&liquidityMoversLimit=2" +
        "&topMoversLimit=0" +
        "&volumeMoversSortBy=absolute" +
        "&liquidityMoversSortBy=absolute" +
        "&minVolume24h=1000000000" +
        "&minLiquidity=1000000000" +
        "&minVolumeChange24h=100000000000" +
        "&minVolumeChangePct24h=0.5" +
        "&minLiquidityChange24h=100000000000" +
        "&minLiquidityChangePct24h=0.05",
    });
    assert.equal(absoluteResponse.statusCode, 200, absoluteResponse.body);
    const absolutePayload = absoluteResponse.json<SidebarPayload>();
    assert.deepEqual(absolutePayload.trendingNow, []);
    assert.deepEqual(
      absolutePayload.volumeMovers24h.map((item) => item.eventId),
      [eventIds[1], eventIds[0]],
    );
    assert.deepEqual(
      absolutePayload.liquidityMovers24h.map((item) => item.eventId),
      [eventIds[5], eventIds[1]],
    );
    assert.equal(
      absolutePayload.volumeMovers24h.some(
        (item) => item.eventId === eventIds[4],
      ),
      false,
    );
    assert.equal(
      absolutePayload.liquidityMovers24h.some(
        (item) => item.eventId === eventIds[0],
      ),
      false,
    );
    assert.deepEqual(absolutePayload.topMovers24h, []);

    const mixedVenueResponse = await app.inject({
      method: "GET",
      url:
        "/market-map/sidebars?venues=polymarket,limitless&limit=9" +
        "&trendingLimit=3" +
        "&volumeMoversLimit=3" +
        "&liquidityMoversLimit=3" +
        "&topMoversLimit=0" +
        "&volumeMoversSortBy=absolute" +
        "&liquidityMoversSortBy=absolute" +
        "&minVolume24h=1000000000" +
        "&minLiquidity=1000000000" +
        "&minVolumeChange24h=100000000000" +
        "&minLiquidityChange24h=100000000000",
    });
    assert.equal(mixedVenueResponse.statusCode, 200, mixedVenueResponse.body);
    const mixedVenuePayload = mixedVenueResponse.json<SidebarPayload>();
    assert.deepEqual(
      mixedVenuePayload.volumeMovers24h.map((item) => item.eventId),
      [eventIds[6], eventIds[1], eventIds[0]],
    );
    assert.equal(mixedVenuePayload.volumeMovers24h[0]?.venue, "limitless");
    assert.deepEqual(
      mixedVenuePayload.liquidityMovers24h.map((item) => item.eventId),
      [eventIds[5], eventIds[1]],
    );
    assert.equal(
      mixedVenuePayload.liquidityMovers24h.some(
        (item) => item.venue === "limitless",
      ),
      false,
    );

    const limitlessOnlyResponse = await app.inject({
      method: "GET",
      url:
        "/market-map/sidebars?venues=limitless&limit=9" +
        "&trendingLimit=0" +
        "&volumeMoversLimit=2" +
        "&liquidityMoversLimit=2" +
        "&topMoversLimit=0" +
        "&volumeMoversSortBy=absolute" +
        "&liquidityMoversSortBy=absolute" +
        "&minVolume24h=1000000000" +
        "&minLiquidity=1000000000" +
        "&minVolumeChange24h=100000000000" +
        "&minLiquidityChange24h=100000000000",
    });
    assert.equal(
      limitlessOnlyResponse.statusCode,
      200,
      limitlessOnlyResponse.body,
    );
    const limitlessOnlyPayload = limitlessOnlyResponse.json<SidebarPayload>();
    assert.deepEqual(
      limitlessOnlyPayload.volumeMovers24h.map((item) => item.eventId),
      [eventIds[6]],
    );
    assert.deepEqual(limitlessOnlyPayload.liquidityMovers24h, []);

    console.log("[market-map-sidebars-tests] ok");
  } finally {
    await pool.query(
      "delete from unified_event_change_24h where event_id = any($1::text[])",
      [eventIds],
    );
    await pool.query(
      "delete from unified_event_activity_metrics_24h where event_id = any($1::text[])",
      [eventIds],
    );
    await pool.query(
      "delete from unified_market_activity_metrics_24h where market_id = any($1::text[])",
      [marketIds],
    );
    await pool.query(
      "delete from unified_event_activity_snapshots_1h where event_id = any($1::text[])",
      [eventIds],
    );
    await pool.query(
      "delete from unified_market_activity_snapshots_1h where market_id = any($1::text[])",
      [marketIds],
    );
    await pool.query("delete from unified_markets where id = any($1::text[])", [
      marketIds,
    ]);
    await pool.query("delete from unified_events where id = any($1::text[])", [
      eventIds,
    ]);
    await pool.query("delete from runtime_policies where id = $1", [policy.id]);
    await app.close();
  }
}

await main();
