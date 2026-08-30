#!/usr/bin/env tsx

import assert from "node:assert/strict";
import {
  upsertUnifiedEvents,
  upsertUnifiedMarkets,
  type ChangeReasonTelemetry,
} from "@hunch/db";
import {
  mapPolymarketEventRow,
  mapPolymarketMarketRow,
  mapToUnifiedEvent,
  mapToUnifiedMarket,
} from "./mappers.js";
import {
  upsertPolymarketEvents,
  upsertPolymarketMarkets,
  type PolymarketUpsertStats,
} from "./polymarket-repo.js";
import { pool } from "./db.js";
import {
  PolymarketEvent,
  PolymarketMarket,
  type TPolymarketEvent,
  type TPolymarketMarket,
} from "./types.js";

type UpsertStats = Pick<
  PolymarketUpsertStats,
  "changedRows" | "skippedRows" | "upsertedRows" | "changeReasons"
>;

function assertPrimaryReason(
  result: UpsertStats,
  reason: string,
  expectedChanged = true,
): void {
  const changed = expectedChanged ? 1 : 0;
  const details = JSON.stringify(result);
  assert.equal(result.changedRows, changed, details);
  assert.equal(result.skippedRows, 1 - changed, details);
  assert.equal(result.upsertedRows, changed, details);
  assert.deepEqual(result.changeReasons.primary, { [reason]: 1 });
}

function requireTelemetry(
  telemetry: ChangeReasonTelemetry | undefined,
): ChangeReasonTelemetry {
  assert.ok(telemetry, "expected change reason telemetry");
  return telemetry;
}

async function verifyDatabaseTarget(): Promise<void> {
  const expectedDatabase = process.env.HUNCH_TEST_EXPECT_DATABASE?.trim();
  if (!expectedDatabase) {
    throw new Error("HUNCH_TEST_EXPECT_DATABASE is required");
  }
  const { rows } = await pool.query<{ current_database: string }>(
    "select current_database() as current_database",
  );
  assert.equal(rows[0]?.current_database, expectedDatabase);
}

async function main(): Promise<void> {
  await verifyDatabaseTarget();

  const suffix = `${Date.now()}-${process.pid}`;
  const sourceEventId = `telemetry-event-${suffix}`;
  const sourceMarketId = `telemetry-market-${suffix}`;
  const unifiedEventId = `polymarket:${sourceEventId}`;
  const unifiedMarketId = `polymarket:${sourceMarketId}`;
  const initialTimestamp = "2026-08-30T00:00:00.000Z";
  const laterTimestamp = "2026-08-30T00:01:00.000Z";

  let event = PolymarketEvent.parse({
    id: sourceEventId,
    title: "Telemetry event",
    slug: `telemetry-event-${suffix}`,
    category: "crypto",
    active: true,
    closed: false,
    volume: 100,
    volume24hr: 10,
    liquidity: 50,
    updatedAt: initialTimestamp,
    sponsorName: "Initial sponsor",
    observationNoise: "stable",
    series: [
      {
        slug: `telemetry-series-${suffix}`,
        ticker: `telemetry-series-${suffix}`,
        title: "Telemetry series",
        updatedAt: initialTimestamp,
        volume: 100,
        volume24hr: 10,
        liquidity: 50,
        commentCount: 1,
      },
    ],
    markets: [],
  });
  let market = PolymarketMarket.parse({
    id: sourceMarketId,
    question: "Telemetry market?",
    slug: `telemetry-market-${suffix}`,
    category: "crypto",
    active: true,
    closed: false,
    acceptingOrders: true,
    outcomes: JSON.stringify(["Yes", "No"]),
    outcomePrices: JSON.stringify(["0.4", "0.6"]),
    clobTokenIds: [`yes-${suffix}`, `no-${suffix}`],
    volume: 100,
    volume24hr: 10,
    liquidity: 50,
    bestBid: 0.39,
    bestAsk: 0.41,
    updatedAt: initialTimestamp,
    makerBaseFee: 0,
    observationNoise: "stable",
  });

  const upsertSourceEvent = (value: TPolymarketEvent) =>
    upsertPolymarketEvents([mapPolymarketEventRow(value)]);
  const upsertSourceMarket = (value: TPolymarketMarket) =>
    upsertPolymarketMarkets([mapPolymarketMarketRow(sourceEventId, value)]);
  const upsertUnifiedEvent = (value: TPolymarketEvent) =>
    upsertUnifiedEvents(pool, [mapToUnifiedEvent(value)]);
  const upsertUnifiedMarket = (value: TPolymarketMarket) =>
    upsertUnifiedMarkets(
      pool,
      [mapToUnifiedMarket(value, sourceEventId, event)],
      { filterUnchanged: true },
    );
  const loadStoredState = async () => {
    const { rows } = await pool.query<{
      source_event_raw_hash: string;
      source_event_updated_at: string | null;
      source_event_updated_at_db: string;
      source_market_raw_hash: string;
      source_market_updated_at: string | null;
      source_market_updated_at_db: string;
      unified_event_updated_at: string | null;
      unified_event_updated_at_db: string;
      unified_market_updated_at: string | null;
      unified_market_updated_at_db: string;
    }>(
      `select
        (select md5(raw::text) from polymarket_events where id = $1) as source_event_raw_hash,
        (select updated_at::text from polymarket_events where id = $1) as source_event_updated_at,
        (select updated_at_db::text from polymarket_events where id = $1) as source_event_updated_at_db,
        (select md5(raw::text) from polymarket_markets where id = $2) as source_market_raw_hash,
        (select updated_at::text from polymarket_markets where id = $2) as source_market_updated_at,
        (select updated_at_db::text from polymarket_markets where id = $2) as source_market_updated_at_db,
        (select updated_at::text from unified_events where id = $3) as unified_event_updated_at,
        (select updated_at_db::text from unified_events where id = $3) as unified_event_updated_at_db,
        (select updated_at::text from unified_markets where id = $4) as unified_market_updated_at,
        (select updated_at_db::text from unified_markets where id = $4) as unified_market_updated_at_db`,
      [sourceEventId, sourceMarketId, unifiedEventId, unifiedMarketId],
    );
    return rows[0];
  };

  try {
    assertPrimaryReason(await upsertSourceEvent(event), "inserted");
    assertPrimaryReason(await upsertUnifiedEvent(event), "inserted");
    assertPrimaryReason(await upsertSourceMarket(market), "inserted");
    const insertedUnifiedMarket = await upsertUnifiedMarket(market);
    assertPrimaryReason(
      {
        ...insertedUnifiedMarket,
        changeReasons: requireTelemetry(insertedUnifiedMarket.changeReasons),
      },
      "inserted",
    );

    const initialStoredState = await loadStoredState();

    assertPrimaryReason(await upsertSourceEvent(event), "unchanged", false);
    assertPrimaryReason(await upsertUnifiedEvent(event), "unchanged", false);
    assertPrimaryReason(await upsertSourceMarket(market), "unchanged", false);
    const unchangedUnifiedMarket = await upsertUnifiedMarket(market);
    assertPrimaryReason(
      {
        ...unchangedUnifiedMarket,
        changeReasons: requireTelemetry(unchangedUnifiedMarket.changeReasons),
      },
      "unchanged",
      false,
    );

    event = PolymarketEvent.parse({ ...event, updatedAt: laterTimestamp });
    market = PolymarketMarket.parse({ ...market, updatedAt: laterTimestamp });
    assertPrimaryReason(
      await upsertSourceEvent(event),
      "source_timestamp_only",
      false,
    );
    assertPrimaryReason(
      await upsertUnifiedEvent(event),
      "source_timestamp_only",
      false,
    );
    assertPrimaryReason(
      await upsertSourceMarket(market),
      "source_timestamp_only",
      false,
    );
    const timestampUnifiedMarket = await upsertUnifiedMarket(market);
    assertPrimaryReason(
      {
        ...timestampUnifiedMarket,
        changeReasons: requireTelemetry(timestampUnifiedMarket.changeReasons),
      },
      "source_timestamp_only",
      false,
    );
    assert.deepEqual(await loadStoredState(), initialStoredState);

    event = PolymarketEvent.parse({
      ...event,
      series: [
        {
          slug: `telemetry-series-${suffix}`,
          ticker: `telemetry-series-${suffix}`,
          title: "Telemetry series",
          updatedAt: laterTimestamp,
          volume: 200,
          volume24hr: 20,
          liquidity: 75,
          commentCount: 2,
        },
      ],
    });
    market = PolymarketMarket.parse({
      ...market,
      observationNoise: "market-noise-before-metrics",
    });
    assertPrimaryReason(await upsertSourceEvent(event), "raw_only", false);
    assertPrimaryReason(
      await upsertUnifiedEvent(event),
      "source_timestamp_only",
      false,
    );
    assertPrimaryReason(await upsertSourceMarket(market), "raw_only", false);
    const noiseUnifiedMarket = await upsertUnifiedMarket(market);
    assertPrimaryReason(
      {
        ...noiseUnifiedMarket,
        changeReasons: requireTelemetry(noiseUnifiedMarket.changeReasons),
      },
      "source_timestamp_only",
      false,
    );
    assert.deepEqual(await loadStoredState(), initialStoredState);

    event = PolymarketEvent.parse({ ...event, volume: 101 });
    market = PolymarketMarket.parse({ ...market, bestBid: 0.38 });
    assertPrimaryReason(await upsertSourceEvent(event), "metrics");
    assertPrimaryReason(await upsertUnifiedEvent(event), "metrics");
    assertPrimaryReason(await upsertSourceMarket(market), "metrics");
    const metricsUnifiedMarket = await upsertUnifiedMarket(market);
    assertPrimaryReason(
      {
        ...metricsUnifiedMarket,
        changeReasons: requireTelemetry(metricsUnifiedMarket.changeReasons),
      },
      "metrics",
    );
    const metricsStoredState = await loadStoredState();
    assert.equal(
      metricsStoredState?.source_event_raw_hash,
      initialStoredState?.source_event_raw_hash,
    );
    assert.equal(
      metricsStoredState?.source_market_raw_hash,
      initialStoredState?.source_market_raw_hash,
    );
    assert.notEqual(
      metricsStoredState?.source_event_updated_at_db,
      initialStoredState?.source_event_updated_at_db,
    );
    assert.notEqual(
      metricsStoredState?.source_market_updated_at_db,
      initialStoredState?.source_market_updated_at_db,
    );

    event = PolymarketEvent.parse({
      ...event,
      sponsorName: "Updated sponsor",
    });
    market = PolymarketMarket.parse({ ...market, makerBaseFee: 1 });
    assertPrimaryReason(await upsertSourceEvent(event), "relevant_raw");
    assertPrimaryReason(await upsertSourceMarket(market), "relevant_raw");
    const relevantRawStoredState = await loadStoredState();
    assert.notEqual(
      relevantRawStoredState?.source_event_raw_hash,
      metricsStoredState?.source_event_raw_hash,
    );
    assert.notEqual(
      relevantRawStoredState?.source_market_raw_hash,
      metricsStoredState?.source_market_raw_hash,
    );

    event = PolymarketEvent.parse({
      ...event,
      observationNoise: "event-noise-changed",
    });
    market = PolymarketMarket.parse({
      ...market,
      observationNoise: "market-noise-changed",
    });
    assertPrimaryReason(await upsertSourceEvent(event), "raw_only", false);
    assertPrimaryReason(await upsertSourceMarket(market), "raw_only", false);
    assert.deepEqual(await loadStoredState(), relevantRawStoredState);

    event = PolymarketEvent.parse({ ...event, title: "Updated event title" });
    market = PolymarketMarket.parse({
      ...market,
      question: "Updated telemetry market?",
    });
    assertPrimaryReason(await upsertSourceEvent(event), "structural");
    assertPrimaryReason(await upsertUnifiedEvent(event), "presentation");
    assertPrimaryReason(await upsertSourceMarket(market), "structural");
    const structuralUnifiedMarket = await upsertUnifiedMarket(market);
    assertPrimaryReason(
      {
        ...structuralUnifiedMarket,
        changeReasons: requireTelemetry(structuralUnifiedMarket.changeReasons),
      },
      "presentation",
    );

    const { rows } = await pool.query<{
      source_event_count: number;
      source_market_count: number;
      unified_event_count: number;
      unified_market_count: number;
    }>(
      `select
        (select count(*)::int from polymarket_events where id = $1) as source_event_count,
        (select count(*)::int from polymarket_markets where id = $2) as source_market_count,
        (select count(*)::int from unified_events where id = $3) as unified_event_count,
        (select count(*)::int from unified_markets where id = $4) as unified_market_count`,
      [sourceEventId, sourceMarketId, unifiedEventId, unifiedMarketId],
    );
    assert.deepEqual(rows[0], {
      source_event_count: 1,
      source_market_count: 1,
      unified_event_count: 1,
      unified_market_count: 1,
    });
    console.log(
      "ok - polymarket upserts skip timestamp/raw noise and preserve raw on metrics",
    );
  } finally {
    await pool.query("delete from unified_markets where id = $1", [
      unifiedMarketId,
    ]);
    await pool.query("delete from unified_events where id = $1", [
      unifiedEventId,
    ]);
    await pool.query("delete from polymarket_markets where id = $1", [
      sourceMarketId,
    ]);
    await pool.query("delete from polymarket_events where id = $1", [
      sourceEventId,
    ]);
    await pool.end();
  }
}

await main();
