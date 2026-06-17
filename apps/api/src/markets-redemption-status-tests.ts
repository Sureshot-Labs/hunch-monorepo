#!/usr/bin/env tsx

import assert from "node:assert/strict";
import crypto from "node:crypto";

import { buildApp } from "./app.js";
import { pool } from "./db.js";
import { normalizeRedemptionStatus } from "./services/redemption-status.js";

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

function baseStatusInput() {
  return {
    venue: "limitless",
    closeTime: "2026-06-17T12:00:00.000Z",
    expirationTime: "2026-06-17T12:00:00.000Z",
    eventEndTime: "2026-06-17T12:00:00.000Z",
    now: new Date("2026-06-17T10:00:00.000Z"),
  };
}

await test("redemption status maps open markets", () => {
  const status = normalizeRedemptionStatus({
    ...baseStatusInput(),
    marketStatus: "ACTIVE",
  });
  assert.equal(status.status, "market_open");
  assert.equal(status.reasonCode, "market_open");
});

await test("redemption status maps closed pending resolution", () => {
  const status = normalizeRedemptionStatus({
    ...baseStatusInput(),
    marketStatus: "CLOSED",
    now: new Date("2026-06-17T13:00:00.000Z"),
  });
  assert.equal(status.status, "pending_resolution");
});

await test("redemption status keeps raw pending_resolution distinct from settlement pending", () => {
  const status = normalizeRedemptionStatus({
    ...baseStatusInput(),
    marketStatus: "CLOSED",
    rawStatus: "pending_resolution",
    now: new Date("2026-06-17T13:00:00.000Z"),
  });
  assert.equal(status.status, "pending_resolution");
  assert.equal(status.reasonCode, "pending_resolution");
});

await test("redemption status maps settlement and challenge windows", () => {
  const settlement = normalizeRedemptionStatus({
    ...baseStatusInput(),
    marketStatus: "SETTLED",
    rawStatus: "settlement_pending",
  });
  assert.equal(settlement.status, "settlement_pending");
  assert.equal(settlement.reasonCode, "settlement_pending");

  const challenge = normalizeRedemptionStatus({
    ...baseStatusInput(),
    marketStatus: "SETTLED",
    rawStatus: "challenge_window",
  });
  assert.equal(challenge.status, "settlement_pending");
  assert.equal(challenge.reasonCode, "challenge_window");
});

await test("redemption status maps winning, losing, redeemed, and failed cases", () => {
  const winning = normalizeRedemptionStatus({
    ...baseStatusInput(),
    marketStatus: "SETTLED",
    resolvedOutcome: "YES",
    outcomeSide: "YES",
    positionSize: 3,
  });
  assert.equal(winning.status, "redeemable");

  const losing = normalizeRedemptionStatus({
    ...baseStatusInput(),
    marketStatus: "SETTLED",
    resolvedOutcome: "YES",
    outcomeSide: "NO",
    positionSize: 3,
  });
  assert.equal(losing.status, "resolved_not_redeemable");

  const redeemed = normalizeRedemptionStatus({
    ...baseStatusInput(),
    marketStatus: "SETTLED",
    resolvedOutcome: "YES",
    outcomeSide: "YES",
    positionSize: 0,
  });
  assert.equal(redeemed.status, "redeemed");

  const failed = normalizeRedemptionStatus({
    ...baseStatusInput(),
    marketStatus: "SETTLED",
    rawStatus: "failed",
    resolvedOutcome: "YES",
    outcomeSide: "YES",
  });
  assert.equal(failed.status, "failed_retryable");
});

await test("markets by token route includes normalized redemption", async () => {
  const app = await buildApp();
  const eventId = `redemption-event-${crypto.randomUUID()}`;
  const marketId = `redemption-market-${crypto.randomUUID()}`;
  const yesTokenId = `redemption-yes-${crypto.randomUUID()}`;
  const noTokenId = `redemption-no-${crypto.randomUUID()}`;

  try {
    await pool.query(
      `
        insert into unified_events (
          id,
          venue,
          venue_event_id,
          title,
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
          $1,
          'limitless',
          $1,
          'Redemption route event',
          'SETTLED',
          now() - interval '2 days',
          now() - interval '1 day',
          0,
          0,
          0,
          $2,
          now(),
          now()
        )
      `,
      [eventId, `slug-${eventId}`],
    );
    await pool.query(
      `
        insert into unified_markets (
          id,
          venue,
          venue_market_id,
          event_id,
          title,
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
          resolved_outcome,
          redemption_status,
          created_at,
          updated_at
        )
        values (
          $1,
          'limitless',
          $1,
          $2,
          'Redemption route market',
          'SETTLED',
          'binary',
          now() - interval '2 days',
          now() - interval '1 day',
          now() - interval '1 day',
          0,
          0,
          null,
          0,
          0,
          0,
          0,
          '["Yes","No"]',
          $3,
          $4,
          $5,
          'YES',
          'ready',
          now(),
          now()
        )
      `,
      [marketId, eventId, yesTokenId, noTokenId, `slug-${marketId}`],
    );
    await pool.query(
      `
        insert into unified_market_tokens(token_id, venue, market_id, outcome_side)
        values
          ($1, 'limitless', $3, 'YES'),
          ($2, 'limitless', $3, 'NO')
      `,
      [yesTokenId, noTokenId, marketId],
    );

    const response = await app.inject({
      method: "GET",
      url: `/markets/by-token?tokenIds=${encodeURIComponent(
        yesTokenId,
      )}&venue=limitless&includeTop=false`,
    });

    assert.equal(response.statusCode, 200);
    const payload = response.json();
    assert.equal(payload.data.length, 1);
    assert.equal(payload.data[0].market.redemptionStatus, "ready");
    assert.equal(payload.data[0].market.redemption.status, "redeemable");
  } finally {
    await pool.query(
      "delete from unified_market_tokens where token_id = any($1::text[])",
      [[yesTokenId, noTokenId]],
    );
    await pool.query("delete from unified_markets where id = $1", [marketId]);
    await pool.query("delete from unified_events where id = $1", [eventId]);
    await app.close();
  }
});
