// @api-integration

import assert from "node:assert/strict";
import crypto from "node:crypto";

import { loadTelegramTradeHistory } from "./services/telegram-bot-trade-history.js";
import { createIntegrationTestPool } from "./test-database-target.js";

const pool = await createIntegrationTestPool({
  options: "-c jit=off",
  max: 4,
});

const suffix = crypto.randomUUID();
const activeUserId = crypto.randomUUID();
const inactiveUserId = crypto.randomUUID();
const activeLinkId = crypto.randomUUID();
const inactiveLinkId = crypto.randomUUID();
const activeTelegramUserId = `trade-history-active-${suffix}`;
const inactiveTelegramUserId = `trade-history-inactive-${suffix}`;
const eventId = `polymarket:trade-history-event-${suffix}`;
const marketId = `polymarket:trade-history-market-${suffix}`;
const tokenId = `trade-history-token-${suffix}`;
const duplicateVenueOrderId = `trade-history-order-${suffix}`;

try {
  await pool.query(
    `insert into users (id, username, is_active)
     values ($1::uuid, $2, true), ($3::uuid, $4, false)`,
    [
      activeUserId,
      `trade-history-active-${suffix}`,
      inactiveUserId,
      `trade-history-inactive-${suffix}`,
    ],
  );
  await pool.query(
    `insert into user_telegram_accounts (
       id, user_id, privy_user_id, telegram_user_id
     ) values
       ($1::uuid, $2::uuid, $3, $4),
       ($5::uuid, $6::uuid, $7, $8)`,
    [
      activeLinkId,
      activeUserId,
      `privy:trade-history-active:${suffix}`,
      activeTelegramUserId,
      inactiveLinkId,
      inactiveUserId,
      `privy:trade-history-inactive:${suffix}`,
      inactiveTelegramUserId,
    ],
  );
  await pool.query(
    `insert into unified_events (
       id, venue, venue_event_id, title, status, end_date
     ) values (
       $1, 'polymarket', $2, 'Trade history integration event', 'ACTIVE',
       now() + interval '1 day'
     )`,
    [eventId, `trade-history-event-${suffix}`],
  );
  await pool.query(
    `insert into unified_markets (
       id, venue, venue_market_id, event_id, title, status, market_type,
       close_time, expiration_time, outcomes, clob_token_ids, metadata
     ) values (
       $1, 'polymarket', $2, $3, 'Trade history integration market',
       'ACTIVE', 'binary', now() + interval '1 day', now() + interval '1 day',
       '["Candidate A","Candidate B"]'::jsonb, $4::jsonb, '{}'::jsonb
     )`,
    [
      marketId,
      `trade-history-market-${suffix}`,
      eventId,
      JSON.stringify([tokenId]),
    ],
  );
  await pool.query(
    `insert into unified_market_tokens (
       market_id, token_id, venue, outcome_side
     ) values ($1, $2, 'polymarket', 'YES')`,
    [marketId, tokenId],
  );

  await pool.query(
    `insert into orders (
       id, user_id, venue, venue_order_id, token_id, side, order_type,
       price, size, status, filled_size, average_fill_price, filled_at,
       posted_at, last_update
     ) values
       ($1::uuid, $2::uuid, 'polymarket', $3, $4, 'BUY', 'GTC',
        0.40, 10, 'matched', 2, 0.40, $5::timestamptz,
        $5::timestamptz, $5::timestamptz),
       ($6::uuid, $2::uuid, 'polymarket', $3, $4, 'BUY', 'GTC',
        0.50, 10, 'filled', 4, 0.50, $7::timestamptz,
        $7::timestamptz, $7::timestamptz),
       ($8::uuid, $2::uuid, 'polymarket', $9, $4, 'SELL', 'GTC',
        0.25, 8, 'partially_filled', 0, 0.25, null,
        $10::timestamptz, $10::timestamptz),
       ($11::uuid, $2::uuid, 'polymarket', $12, $4, 'BUY', 'GTC',
        0.90, 1, 'cancelled', 0, null, null,
        $13::timestamptz, $13::timestamptz),
       ($14::uuid, $2::uuid, 'polymarket', $15, $4, null, 'GTC',
        0.75, 1, 'filled', 1, 0.75, $16::timestamptz,
        $16::timestamptz, $16::timestamptz)`,
    [
      crypto.randomUUID(),
      activeUserId,
      duplicateVenueOrderId,
      tokenId,
      "2026-09-14T10:00:00.000Z",
      crypto.randomUUID(),
      "2026-09-14T12:00:00.000Z",
      crypto.randomUUID(),
      `trade-history-partial-${suffix}`,
      "2026-09-14T11:00:00.000Z",
      crypto.randomUUID(),
      `trade-history-cancelled-${suffix}`,
      "2026-09-14T14:00:00.000Z",
      crypto.randomUUID(),
      `trade-history-invalid-${suffix}`,
      "2026-09-14T15:00:00.000Z",
    ],
  );
  await pool.query(
    `insert into executions (
       id, user_id, wallet_address, venue, unified_market_id, side, outcome,
       input_mint, output_mint, amount_in, amount_out, input_decimals,
       output_decimals, tx_signature, status, created_at, updated_at
     ) values (
       $1::uuid, $2::uuid, $3, 'kalshi', $4, 'SELL', 'NO', $5, $6,
       3000000, 1500000, 6, 6, $7, 'closed', $8::timestamptz,
       $8::timestamptz
     )`,
    [
      crypto.randomUUID(),
      activeUserId,
      `solana-wallet-${suffix}`,
      marketId,
      `prediction-mint-${suffix}`,
      `usdc-mint-${suffix}`,
      `trade-history-signature-${suffix}`,
      "2026-09-14T13:00:00.000Z",
    ],
  );

  const loaded = await loadTelegramTradeHistory({
    pool,
    telegramUserId: activeTelegramUserId,
  });
  assert.equal(loaded.linked, true);
  assert.deepEqual(
    loaded.snapshot.trades.map((entry) => ({
      action: entry.action,
      notionalUsd: entry.notionalUsd,
      outcome: entry.outcome,
      price: entry.price,
      shares: entry.shares,
      tradedAt: entry.tradedAt.toISOString(),
      venue: entry.venue,
    })),
    [
      {
        action: "SELL",
        notionalUsd: 1.5,
        outcome: "Candidate B",
        price: 0.5,
        shares: 3,
        tradedAt: "2026-09-14T13:00:00.000Z",
        venue: "kalshi",
      },
      {
        action: "BUY",
        notionalUsd: 2,
        outcome: "Candidate A",
        price: 0.5,
        shares: 4,
        tradedAt: "2026-09-14T12:00:00.000Z",
        venue: "polymarket",
      },
      {
        action: "SELL",
        notionalUsd: null,
        outcome: "Candidate A",
        price: 0.25,
        shares: null,
        tradedAt: "2026-09-14T11:00:00.000Z",
        venue: "polymarket",
      },
    ],
  );

  const inactive = await loadTelegramTradeHistory({
    pool,
    telegramUserId: inactiveTelegramUserId,
  });
  assert.deepEqual(inactive, {
    linked: false,
    snapshot: { trades: [] },
  });

  console.log("[telegram-trade-history-integration-tests] passed");
} finally {
  try {
    await pool.query(`delete from users where id = any($1::uuid[])`, [
      [activeUserId, inactiveUserId],
    ]);
    await pool.query(`delete from unified_markets where id = $1`, [marketId]);
    await pool.query(`delete from unified_events where id = $1`, [eventId]);
  } finally {
    await pool.end();
  }
}
