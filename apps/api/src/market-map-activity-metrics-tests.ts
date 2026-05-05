#!/usr/bin/env tsx

import assert from "node:assert/strict";
import crypto from "node:crypto";

import { pool } from "./db.js";

function makeToken(label: string): string {
  return `${label}-${crypto.randomUUID()}`;
}

function toNumber(value: unknown): number {
  assert.notEqual(value, null);
  const parsed = Number(value);
  assert.equal(Number.isFinite(parsed), true);
  return parsed;
}

function assertClose(actual: unknown, expected: number): void {
  assert.equal(Math.abs(toNumber(actual) - expected) < 1e-9, true);
}

async function insertUnifiedEvent(params: {
  eventId: string;
  venueEventId: string;
  title: string;
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
        $1, 'polymarket', $2, $3, null, null, 'ACTIVE',
        now() - interval '1 hour', now() + interval '1 day',
        1000, 100, 100, 120, $4, now(), now()
      )
    `,
    [
      params.eventId,
      params.venueEventId,
      params.title,
      makeToken(`slug-${params.eventId}`),
    ],
  );
}

async function insertUnifiedMarket(params: {
  marketId: string;
  venueMarketId: string;
  eventId: string;
  title: string;
  volumeTotal: number;
  liquidity: number;
  openInterest: number;
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
        $1, 'polymarket', $2, $3, $4, null, null, 'ACTIVE', 'binary',
        now() - interval '1 hour', now() + interval '1 day', now() + interval '1 day',
        0.45, 0.55, 0.5, $5, 10, $6, $7,
        '["Yes","No"]', $8, $9, $10, now(), now()
      )
    `,
    [
      params.marketId,
      params.venueMarketId,
      params.eventId,
      params.title,
      params.volumeTotal,
      params.liquidity,
      params.openInterest,
      makeToken(`yes-${params.marketId}`),
      makeToken(`no-${params.marketId}`),
      makeToken(`slug-${params.marketId}`),
    ],
  );
}

async function insertSnapshot(params: {
  marketId: string;
  eventId: string;
  hoursAgo: 24 | 48;
  volumeTotal: number;
  liquidity: number;
  openInterest: number;
}): Promise<void> {
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
        'polymarket',
        date_trunc('hour', now() - ($3::text || ' hours')::interval),
        $4,
        $5,
        $6,
        now() - ($3::text || ' hours')::interval,
        now() - ($3::text || ' hours')::interval
      )
    `,
    [
      params.marketId,
      params.eventId,
      params.hoursAgo,
      params.volumeTotal,
      params.liquidity,
      params.openInterest,
    ],
  );
}

async function seedMarket(params: {
  eventId: string;
  marketId: string;
  key: string;
  now: {
    volumeTotal: number;
    liquidity: number;
    openInterest: number;
  };
  h24: {
    volumeTotal: number;
    liquidity: number;
    openInterest: number;
  };
  h48: {
    volumeTotal: number;
    liquidity: number;
    openInterest: number;
  };
}): Promise<void> {
  await insertUnifiedMarket({
    marketId: params.marketId,
    venueMarketId: `venue-${params.marketId}`,
    eventId: params.eventId,
    title: `Activity market ${params.key}`,
    volumeTotal: params.now.volumeTotal,
    liquidity: params.now.liquidity,
    openInterest: params.now.openInterest,
  });
  await insertSnapshot({
    marketId: params.marketId,
    eventId: params.eventId,
    hoursAgo: 24,
    ...params.h24,
  });
  await insertSnapshot({
    marketId: params.marketId,
    eventId: params.eventId,
    hoursAgo: 48,
    ...params.h48,
  });
}

async function main() {
  try {
    await pool.query("select 1");
  } catch {
    console.log(
      "[market-map-activity-metrics-tests] skipped (DATABASE_URL unavailable)",
    );
    return;
  }

  const suiteId = crypto.randomUUID().slice(0, 8);
  const goodEventId = `mm-activity-good-${suiteId}`;
  const invalidEventId = `mm-activity-invalid-${suiteId}`;
  const zeroPriorEventId = `mm-activity-zero-prior-${suiteId}`;
  const currentOnlyEventId = `mm-activity-current-only-${suiteId}`;
  const goodMarketA = `mm-activity-good-a-${suiteId}`;
  const goodMarketB = `mm-activity-good-b-${suiteId}`;
  const invalidMarket = `mm-activity-invalid-market-${suiteId}`;
  const zeroPriorMarket = `mm-activity-zero-prior-market-${suiteId}`;
  const currentOnlyMarket = `mm-activity-current-only-market-${suiteId}`;

  await pool.query("begin");
  try {
    await insertUnifiedEvent({
      eventId: goodEventId,
      venueEventId: `venue-${goodEventId}`,
      title: "Activity good event",
    });
    await insertUnifiedEvent({
      eventId: invalidEventId,
      venueEventId: `venue-${invalidEventId}`,
      title: "Activity invalid event",
    });
    await insertUnifiedEvent({
      eventId: zeroPriorEventId,
      venueEventId: `venue-${zeroPriorEventId}`,
      title: "Activity zero prior event",
    });
    await insertUnifiedEvent({
      eventId: currentOnlyEventId,
      venueEventId: `venue-${currentOnlyEventId}`,
      title: "Activity current-only event",
    });

    await seedMarket({
      eventId: goodEventId,
      marketId: goodMarketA,
      key: "good-a",
      now: { volumeTotal: 1000, liquidity: 70, openInterest: 40 },
      h24: { volumeTotal: 900, liquidity: 100, openInterest: 30 },
      h48: { volumeTotal: 850, liquidity: 110, openInterest: 20 },
    });
    await seedMarket({
      eventId: goodEventId,
      marketId: goodMarketB,
      key: "good-b",
      now: { volumeTotal: 500, liquidity: 30, openInterest: 60 },
      h24: { volumeTotal: 400, liquidity: 50, openInterest: 50 },
      h48: { volumeTotal: 300, liquidity: 50, openInterest: 40 },
    });
    await seedMarket({
      eventId: invalidEventId,
      marketId: invalidMarket,
      key: "invalid-volume",
      now: { volumeTotal: 80, liquidity: 20, openInterest: 10 },
      h24: { volumeTotal: 100, liquidity: 30, openInterest: 10 },
      h48: { volumeTotal: 50, liquidity: 40, openInterest: 10 },
    });
    await seedMarket({
      eventId: zeroPriorEventId,
      marketId: zeroPriorMarket,
      key: "zero-prior",
      now: { volumeTotal: 200, liquidity: 10, openInterest: 10 },
      h24: { volumeTotal: 100, liquidity: 0, openInterest: 10 },
      h48: { volumeTotal: 50, liquidity: 0, openInterest: 10 },
    });
    await insertUnifiedMarket({
      marketId: currentOnlyMarket,
      venueMarketId: `venue-${currentOnlyMarket}`,
      eventId: currentOnlyEventId,
      title: "Activity market current-only",
      volumeTotal: 321,
      liquidity: 123,
      openInterest: 45,
    });

    await pool.query("select refresh_unified_market_activity_metrics_1h()");

    const { rows: goodMarketRows } = await pool.query(
      `
        select
          volume_last_24h,
          volume_prev_24h,
          volume_last_24h_change_pct,
          liquidity_change_24h,
          liquidity_change_pct_24h,
          volume_valid,
          liquidity_valid
        from unified_market_activity_metrics_24h
        where market_id = $1
      `,
      [goodMarketA],
    );
    assert.equal(goodMarketRows.length, 1);
    assertClose(goodMarketRows[0].volume_last_24h, 100);
    assertClose(goodMarketRows[0].volume_prev_24h, 50);
    assertClose(goodMarketRows[0].volume_last_24h_change_pct, 1);
    assertClose(goodMarketRows[0].liquidity_change_24h, -30);
    assertClose(goodMarketRows[0].liquidity_change_pct_24h, -0.3);
    assert.equal(goodMarketRows[0].volume_valid, true);
    assert.equal(goodMarketRows[0].liquidity_valid, true);

    const { rows: invalidMarketRows } = await pool.query(
      `
        select volume_last_24h, volume_valid
        from unified_market_activity_metrics_24h
        where market_id = $1
      `,
      [invalidMarket],
    );
    assert.equal(invalidMarketRows.length, 1);
    assert.equal(invalidMarketRows[0].volume_last_24h, null);
    assert.equal(invalidMarketRows[0].volume_valid, false);

    const { rows: zeroPriorRows } = await pool.query(
      `
        select liquidity_change_24h, liquidity_change_pct_24h, liquidity_valid
        from unified_market_activity_metrics_24h
        where market_id = $1
      `,
      [zeroPriorMarket],
    );
    assert.equal(zeroPriorRows.length, 1);
    assertClose(zeroPriorRows[0].liquidity_change_24h, 10);
    assert.equal(zeroPriorRows[0].liquidity_change_pct_24h, null);
    assert.equal(zeroPriorRows[0].liquidity_valid, true);

    const { rows: goodEventRows } = await pool.query(
      `
        select
          volume_last_24h,
          volume_prev_24h,
          volume_last_24h_change_pct,
          liquidity_change_24h,
          liquidity_change_pct_24h,
          volume_valid,
          liquidity_valid
        from unified_event_activity_metrics_24h
        where event_id = $1
      `,
      [goodEventId],
    );
    assert.equal(goodEventRows.length, 1);
    assertClose(goodEventRows[0].volume_last_24h, 200);
    assertClose(goodEventRows[0].volume_prev_24h, 150);
    assertClose(goodEventRows[0].volume_last_24h_change_pct, 1 / 3);
    assertClose(goodEventRows[0].liquidity_change_24h, -50);
    assertClose(goodEventRows[0].liquidity_change_pct_24h, -1 / 3);
    assert.equal(goodEventRows[0].volume_valid, true);
    assert.equal(goodEventRows[0].liquidity_valid, true);

    const { rows: invalidEventRows } = await pool.query(
      `
        select volume_last_24h, volume_last_24h_change_pct, volume_valid
        from unified_event_activity_metrics_24h
        where event_id = $1
      `,
      [invalidEventId],
    );
    assert.equal(invalidEventRows.length, 1);
    assert.equal(invalidEventRows[0].volume_last_24h, null);
    assert.equal(invalidEventRows[0].volume_last_24h_change_pct, null);
    assert.equal(invalidEventRows[0].volume_valid, false);

    const { rows: currentOnlyEventRows } = await pool.query(
      `
        select
          volume_total_now,
          volume_last_24h,
          liquidity_now,
          liquidity_change_24h,
          open_interest_now,
          open_interest_change_24h,
          has_24h_window,
          liquidity_valid,
          open_interest_valid
        from unified_event_activity_metrics_24h
        where event_id = $1
      `,
      [currentOnlyEventId],
    );
    assert.equal(currentOnlyEventRows.length, 1);
    assertClose(currentOnlyEventRows[0].volume_total_now, 321);
    assert.equal(currentOnlyEventRows[0].volume_last_24h, null);
    assertClose(currentOnlyEventRows[0].liquidity_now, 123);
    assert.equal(currentOnlyEventRows[0].liquidity_change_24h, null);
    assertClose(currentOnlyEventRows[0].open_interest_now, 45);
    assert.equal(currentOnlyEventRows[0].open_interest_change_24h, null);
    assert.equal(currentOnlyEventRows[0].has_24h_window, false);
    assert.equal(currentOnlyEventRows[0].liquidity_valid, false);
    assert.equal(currentOnlyEventRows[0].open_interest_valid, false);

    console.log("[market-map-activity-metrics-tests] ok");
  } finally {
    await pool.query("rollback");
  }
}

await main();
