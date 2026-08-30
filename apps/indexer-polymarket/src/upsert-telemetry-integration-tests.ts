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

async function waitForBlockedBackend(
  blockerPid: number,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { rows } = await pool.query<{ blocked: boolean }>(
      `select exists (
        select 1
        from pg_stat_activity waiting_backend
        where waiting_backend.datname = current_database()
          and waiting_backend.wait_event_type = 'Lock'
          and $1 = any(pg_blocking_pids(waiting_backend.pid))
      ) as blocked`,
      [blockerPid],
    );
    if (rows[0]?.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for the market upsert lock race");
}

async function main(): Promise<void> {
  await verifyDatabaseTarget();

  const suffix = `${Date.now()}-${process.pid}`;
  const sourceEventId = `telemetry-event-${suffix}`;
  const sourceMarketId = `telemetry-market-${suffix}`;
  const secondSourceMarketId = `telemetry-market-second-${suffix}`;
  const raceSourceMarketId = `telemetry-market-race-${suffix}`;
  const unifiedEventId = `polymarket:${sourceEventId}`;
  const unifiedMarketId = `polymarket:${sourceMarketId}`;
  const limitlessMarketId = `limitless:telemetry-amm-${suffix}`;
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
      source_market_best_bid: string | null;
      source_market_question: string;
      source_market_updated_at: string | null;
      source_market_updated_at_db: string;
      unified_event_updated_at: string | null;
      unified_event_updated_at_db: string;
      unified_market_updated_at: string | null;
      unified_market_updated_at_db: string;
      unified_market_best_bid: string | null;
      unified_market_title: string;
    }>(
      `select
        (select md5(raw::text) from polymarket_events where id = $1) as source_event_raw_hash,
        (select updated_at::text from polymarket_events where id = $1) as source_event_updated_at,
        (select updated_at_db::text from polymarket_events where id = $1) as source_event_updated_at_db,
        (select md5(raw::text) from polymarket_markets where id = $2) as source_market_raw_hash,
        (select best_bid::text from polymarket_markets where id = $2) as source_market_best_bid,
        (select question from polymarket_markets where id = $2) as source_market_question,
        (select updated_at::text from polymarket_markets where id = $2) as source_market_updated_at,
        (select updated_at_db::text from polymarket_markets where id = $2) as source_market_updated_at_db,
        (select updated_at::text from unified_events where id = $3) as unified_event_updated_at,
        (select updated_at_db::text from unified_events where id = $3) as unified_event_updated_at_db,
        (select updated_at::text from unified_markets where id = $4) as unified_market_updated_at,
        (select updated_at_db::text from unified_markets where id = $4) as unified_market_updated_at_db,
        (select best_bid::text from unified_markets where id = $4) as unified_market_best_bid,
        (select title from unified_markets where id = $4) as unified_market_title`,
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
    assert.equal(metricsStoredState?.source_market_best_bid, "0.38");
    assert.equal(
      metricsStoredState?.source_market_question,
      "Telemetry market?",
    );
    assert.equal(metricsStoredState?.unified_market_best_bid, "0.38");
    assert.equal(metricsStoredState?.unified_market_title, "Telemetry market?");
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

    const limitlessAmmMarket = {
      id: limitlessMarketId,
      venue: "limitless",
      venue_market_id: `telemetry-amm-${suffix}`,
      event_id: unifiedEventId,
      title: "Telemetry AMM market",
      status: "ACTIVE" as const,
      market_type: "binary",
      best_bid: 0.2,
      best_ask: 0.3,
      last_price: 0.25,
      volume_total: 10,
      metadata: { tradeType: "amm" },
      updated_at: new Date(initialTimestamp),
    };
    await upsertUnifiedMarkets(pool, [limitlessAmmMarket], {
      filterUnchanged: true,
    });
    const limitlessMetricsResult = await upsertUnifiedMarkets(
      pool,
      [
        {
          ...limitlessAmmMarket,
          best_bid: undefined,
          best_ask: undefined,
          last_price: undefined,
          volume_total: 11,
          updated_at: new Date(laterTimestamp),
        },
      ],
      { filterUnchanged: true },
    );
    assertPrimaryReason(
      {
        ...limitlessMetricsResult,
        changeReasons: requireTelemetry(limitlessMetricsResult.changeReasons),
      },
      "metrics",
    );
    const { rows: limitlessRows } = await pool.query<{
      best_ask: string | null;
      best_bid: string | null;
      last_price: string | null;
      volume_total: string | null;
    }>(
      `select
        best_bid::text as best_bid,
        best_ask::text as best_ask,
        last_price::text as last_price,
        volume_total::text as volume_total
      from unified_markets
      where id = $1`,
      [limitlessMarketId],
    );
    assert.deepEqual(limitlessRows[0], {
      best_bid: "0.2",
      best_ask: "0.3",
      last_price: "0.25",
      volume_total: "11",
    });

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
      bestAsk: 0.42,
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
    const structuralStoredState = await loadStoredState();
    assert.equal(
      structuralStoredState?.source_market_question,
      "Updated telemetry market?",
    );
    assert.equal(
      structuralStoredState?.unified_market_title,
      "Updated telemetry market?",
    );

    const mixedUnifiedResult = await upsertUnifiedMarkets(
      pool,
      [
        mapToUnifiedMarket(
          PolymarketMarket.parse({ ...market, bestBid: 0.37 }),
          sourceEventId,
          event,
        ),
        {
          ...limitlessAmmMarket,
          title: "Updated telemetry AMM market",
          volume_total: 12,
          updated_at: new Date(laterTimestamp),
        },
      ],
      { filterUnchanged: true },
    );
    assert.equal(mixedUnifiedResult.changedRows, 2);
    assert.equal(mixedUnifiedResult.upsertedRows, 2);
    assert.deepEqual(
      requireTelemetry(mixedUnifiedResult.changeReasons).primary,
      {
        metrics: 1,
        presentation: 1,
      },
    );
    const { rows: mixedUnifiedRows } = await pool.query<{
      best_bid: string | null;
      id: string;
      title: string;
      volume_total: string | null;
    }>(
      `select id, title, best_bid::text as best_bid,
        volume_total::text as volume_total
      from unified_markets
      where id = any($1::text[])
      order by id`,
      [[unifiedMarketId, limitlessMarketId]],
    );
    assert.deepEqual(mixedUnifiedRows, [
      {
        id: limitlessMarketId,
        title: "Updated telemetry AMM market",
        best_bid: "0.2",
        volume_total: "12",
      },
      {
        id: unifiedMarketId,
        title: "Updated telemetry market?",
        best_bid: "0.37",
        volume_total: "100",
      },
    ]);

    const secondMarket = PolymarketMarket.parse({
      ...market,
      id: secondSourceMarketId,
      question: "Second telemetry market?",
      slug: `telemetry-market-second-${suffix}`,
      clobTokenIds: [`yes-second-${suffix}`, `no-second-${suffix}`],
    });
    assertPrimaryReason(await upsertSourceMarket(secondMarket), "inserted");
    market = PolymarketMarket.parse({ ...market, bestBid: 0.37 });
    const secondStructuralMarket = PolymarketMarket.parse({
      ...secondMarket,
      question: "Updated second telemetry market?",
    });
    const mixedSourceResult = await upsertPolymarketMarkets([
      mapPolymarketMarketRow(sourceEventId, market),
      mapPolymarketMarketRow(sourceEventId, secondStructuralMarket),
    ]);
    assert.equal(mixedSourceResult.changedRows, 2);
    assert.equal(mixedSourceResult.upsertedRows, 2);
    assert.deepEqual(mixedSourceResult.changeReasons.primary, {
      metrics: 1,
      structural: 1,
    });
    const { rows: mixedSourceRows } = await pool.query<{
      best_bid: string | null;
      id: string;
      question: string;
    }>(
      `select id, question, best_bid::text as best_bid
      from polymarket_markets
      where id = any($1::text[])
      order by id`,
      [[sourceMarketId, secondSourceMarketId]],
    );
    assert.deepEqual(mixedSourceRows, [
      {
        id: sourceMarketId,
        question: "Updated telemetry market?",
        best_bid: "0.37",
      },
      {
        id: secondSourceMarketId,
        question: "Updated second telemetry market?",
        best_bid: "0.38",
      },
    ]);

    const raceMarket = PolymarketMarket.parse({
      ...market,
      id: raceSourceMarketId,
      question: "Retention race telemetry market?",
      slug: `telemetry-market-race-${suffix}`,
      clobTokenIds: [`yes-race-${suffix}`, `no-race-${suffix}`],
    });
    assertPrimaryReason(await upsertSourceMarket(raceMarket), "inserted");
    const { rows: raceInitialRows } = await pool.query<{
      raw_hash: string;
    }>(
      "select md5(raw::text) as raw_hash from polymarket_markets where id = $1",
      [raceSourceMarketId],
    );
    const blocker = await pool.connect();
    let racingUpsert: Promise<PolymarketUpsertStats> | undefined;
    try {
      await blocker.query("begin");
      const { rows: blockerRows } = await blocker.query<{ pid: number }>(
        "select pg_backend_pid() as pid",
      );
      const blockerRow = blockerRows[0];
      assert.ok(blockerRow, "expected blocker backend pid");
      await blocker.query(
        "select id from polymarket_markets where id = $1 for update",
        [raceSourceMarketId],
      );
      racingUpsert = upsertPolymarketMarkets([
        mapPolymarketMarketRow(
          sourceEventId,
          PolymarketMarket.parse({ ...raceMarket, bestBid: 0.36 }),
        ),
      ]);
      await waitForBlockedBackend(blockerRow.pid);
      await blocker.query("delete from polymarket_markets where id = $1", [
        raceSourceMarketId,
      ]);
      await blocker.query("commit");

      const raceResult = await racingUpsert;
      assertPrimaryReason(raceResult, "metrics");
      const { rows: raceStoredRows } = await pool.query<{
        best_bid: string | null;
        raw_hash: string;
      }>(
        `select best_bid::text as best_bid, md5(raw::text) as raw_hash
        from polymarket_markets
        where id = $1`,
        [raceSourceMarketId],
      );
      assert.deepEqual(raceStoredRows[0], {
        best_bid: "0.36",
        raw_hash: raceInitialRows[0]?.raw_hash,
      });
    } catch (error) {
      await blocker.query("rollback").catch(() => undefined);
      await racingUpsert?.catch(() => undefined);
      throw error;
    } finally {
      blocker.release();
    }

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
      limitlessMarketId,
    ]);
    await pool.query("delete from unified_markets where id = $1", [
      unifiedMarketId,
    ]);
    await pool.query("delete from unified_events where id = $1", [
      unifiedEventId,
    ]);
    await pool.query("delete from polymarket_markets where id = $1", [
      sourceMarketId,
    ]);
    await pool.query("delete from polymarket_markets where id = $1", [
      secondSourceMarketId,
    ]);
    await pool.query("delete from polymarket_markets where id = $1", [
      raceSourceMarketId,
    ]);
    await pool.query("delete from polymarket_events where id = $1", [
      sourceEventId,
    ]);
    await pool.end();
  }
}

await main();
