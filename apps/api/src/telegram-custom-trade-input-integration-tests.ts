// @api-integration

import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createPgPool } from "@hunch/infra";

import { telegramBotTradingTestHooks } from "./services/telegram-bot-trading.js";

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const pool = createPgPool({
  connectionString: databaseUrl,
  options: "-c jit=off",
  max: 8,
});

const suffix = crypto.randomUUID();
const userId = crypto.randomUUID();
const authorizationId = crypto.randomUUID();
const telegramAccountLinkId = crypto.randomUUID();
const eventId = `polymarket:custom-input-event-${suffix}`;
const marketId = `polymarket:custom-input-market-${suffix}`;
const telegramUserId = `custom-input-${suffix}`;

async function insertIntent(input: {
  idempotencyKey: string;
  sellPercent: string | null;
  sharesRaw: string;
}): Promise<string | null> {
  const inserted = await pool.query<{ id: string }>(
    `insert into telegram_trade_intents (
       telegram_user_id,
       user_id,
       authorization_id,
       chat_id,
       action,
       venue,
       market_id,
       event_id,
       side,
       amount_usd,
       sell_percent,
       shares_raw,
       status,
       result,
       expires_at,
       idempotency_key
     ) values (
       $1, $2::uuid, $3::uuid, $1, 'sell', 'polymarket', $4, $5, 'YES',
       null, $6::numeric, $7, 'draft', $8::jsonb,
       now() + interval '2 minutes', $9
     )
     on conflict (idempotency_key) do nothing
     returning id`,
    [
      telegramUserId,
      userId,
      authorizationId,
      marketId,
      eventId,
      input.sellPercent,
      input.sharesRaw,
      JSON.stringify({
        telegramAuthority: {
          authorizationId,
          privyWalletId: `wallet-${suffix}`,
          telegramAccountLinkId,
          userId,
          version: 1,
          walletAddress: "0x0000000000000000000000000000000000000202",
          walletChain: "ethereum",
        },
      }),
      input.idempotencyKey,
    ],
  );
  return inserted.rows[0]?.id ?? null;
}

try {
  await pool.query(
    `insert into users (id, username)
     values ($1::uuid, $2)`,
    [userId, `custom-input-${suffix}`],
  );
  await pool.query(
    `insert into user_telegram_accounts (
       id, user_id, privy_user_id, telegram_user_id
     ) values ($1::uuid, $2::uuid, $3, $4)`,
    [telegramAccountLinkId, userId, `privy:${suffix}`, telegramUserId],
  );
  await pool.query(
    `insert into user_wallets (
       user_id, wallet_address, wallet_type, is_primary, is_verified
     ) values ($1::uuid, $2, 'ethereum', true, true)`,
    [userId, "0x0000000000000000000000000000000000000202"],
  );
  await pool.query(
    `insert into telegram_bot_trading_preferences (
       user_id, desired_enabled, decision_source
     ) values ($1::uuid, true, 'manual_enable')`,
    [userId],
  );
  await pool.query(
    `insert into telegram_bot_trading_authorizations (
       id, user_id, telegram_user_id, wallet_address, wallet_chain,
       privy_wallet_id, enabled, enabled_venues
     ) values (
       $1::uuid, $2::uuid, $3, $4, 'ethereum', $5, true,
       array['polymarket']::text[]
     )`,
    [
      authorizationId,
      userId,
      telegramUserId,
      "0x0000000000000000000000000000000000000202",
      `wallet-${suffix}`,
    ],
  );

  const authority = await telegramBotTradingTestHooks.loadEnabledAuthorization(
    pool,
    telegramUserId,
    "polymarket",
  );
  assert.equal(authority?.id, authorizationId);
  assert.equal(authority?.telegram_account_link_id, telegramAccountLinkId);
  const authorityLockClient = await pool.connect();
  const competingAuthorizationClient = await pool.connect();
  try {
    await authorityLockClient.query("begin");
    const lockedAuthority =
      await telegramBotTradingTestHooks.loadEnabledAuthorization(
        authorityLockClient,
        telegramUserId,
        "polymarket",
        { lock: true },
      );
    assert.equal(lockedAuthority?.id, authorizationId);
    await competingAuthorizationClient.query("begin");
    await competingAuthorizationClient.query(
      "set local lock_timeout = '100ms'",
    );
    await assert.rejects(
      competingAuthorizationClient.query(
        `update telegram_bot_trading_authorizations
            set privy_wallet_id = $2
          where id = $1::uuid`,
        [authorizationId, `changed-wallet-${suffix}`],
      ),
      /lock timeout/u,
    );
  } finally {
    await competingAuthorizationClient.query("rollback").catch(() => undefined);
    await authorityLockClient.query("rollback").catch(() => undefined);
    competingAuthorizationClient.release();
    authorityLockClient.release();
  }
  await pool.query(
    `insert into unified_events (
       id, venue, venue_event_id, title, status, end_date
     ) values (
       $1, 'polymarket', $2, 'Custom input integration event', 'ACTIVE',
       now() + interval '1 day'
     )`,
    [eventId, `event-${suffix}`],
  );
  await pool.query(
    `insert into unified_markets (
       id, venue, venue_market_id, event_id, title, status, market_type,
       close_time, expiration_time, outcomes, clob_token_ids, metadata
     ) values (
       $1, 'polymarket', $2, $3, 'Custom input integration market',
       'ACTIVE', 'binary', now() + interval '1 day', now() + interval '1 day',
       '["Yes","No"]'::jsonb, '["yes-token","no-token"]'::jsonb,
       '{}'::jsonb
     )`,
    [marketId, `market-${suffix}`, eventId],
  );

  assert.ok(
    await insertIntent({
      idempotencyKey: `custom-input:exact:${suffix}`,
      sellPercent: null,
      sharesRaw: "1250000",
    }),
  );
  assert.ok(
    await insertIntent({
      idempotencyKey: `custom-input:fractional:${suffix}`,
      sellPercent: "12.5",
      sharesRaw: "125000",
    }),
  );
  for (const sellPercent of ["50", "100"]) {
    assert.ok(
      await insertIntent({
        idempotencyKey: `custom-input:legacy:${sellPercent}:${suffix}`,
        sellPercent,
        sharesRaw: "500000",
      }),
    );
  }

  for (const invalid of [
    { sellPercent: "0", sharesRaw: "1" },
    { sellPercent: "100.000001", sharesRaw: "1" },
    { sellPercent: null, sharesRaw: "0" },
    { sellPercent: null, sharesRaw: "not-an-integer" },
  ]) {
    await assert.rejects(
      insertIntent({
        idempotencyKey: `custom-input:invalid:${crypto.randomUUID()}`,
        ...invalid,
      }),
      /telegram_trade_intents_action_payload_check/u,
    );
  }

  const concurrentKey = `telegram-bot-input:${crypto.randomUUID()}`;
  const concurrent = await Promise.all(
    Array.from({ length: 8 }, () =>
      insertIntent({
        idempotencyKey: concurrentKey,
        sellPercent: null,
        sharesRaw: "1517448",
      }),
    ),
  );
  assert.equal(concurrent.filter(Boolean).length, 1);
  const persisted = await pool.query<{
    count: string;
    sell_percent: string | null;
    shares_raw: string;
  }>(
    `select count(*)::text as count,
            min(sell_percent)::text as sell_percent,
            min(shares_raw) as shares_raw
       from telegram_trade_intents
      where idempotency_key = $1`,
    [concurrentKey],
  );
  assert.deepEqual(persisted.rows[0], {
    count: "1",
    sell_percent: null,
    shares_raw: "1517448",
  });
  const persistedBinding = await pool.query<{
    authorization_id: string | null;
    bound_authorization_id: string | null;
    bound_link_id: string | null;
    bound_user_id: string | null;
    user_id: string | null;
  }>(
    `select authorization_id::text,
            result #>> '{telegramAuthority,authorizationId}' as bound_authorization_id,
            result #>> '{telegramAuthority,telegramAccountLinkId}' as bound_link_id,
            result #>> '{telegramAuthority,userId}' as bound_user_id,
            user_id::text
       from telegram_trade_intents
      where idempotency_key = $1`,
    [concurrentKey],
  );
  assert.deepEqual(persistedBinding.rows[0], {
    authorization_id: authorizationId,
    bound_authorization_id: authorizationId,
    bound_link_id: telegramAccountLinkId,
    bound_user_id: userId,
    user_id: userId,
  });

  const conflictingKey = `telegram-bot-input:${crypto.randomUUID()}`;
  const conflicting = await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      insertIntent({
        idempotencyKey: conflictingKey,
        sellPercent: index % 2 === 0 ? null : "25",
        sharesRaw: index % 2 === 0 ? "1000000" : "250000",
      }),
    ),
  );
  assert.equal(conflicting.filter(Boolean).length, 1);
  const conflictingPersisted = await pool.query<{
    count: string;
    sell_percent: string | null;
    shares_raw: string;
  }>(
    `select count(*)::text as count,
            min(sell_percent)::text as sell_percent,
            min(shares_raw) as shares_raw
       from telegram_trade_intents
      where idempotency_key = $1`,
    [conflictingKey],
  );
  assert.equal(conflictingPersisted.rows[0]?.count, "1");
  assert.ok(
    (conflictingPersisted.rows[0]?.sell_percent == null &&
      conflictingPersisted.rows[0]?.shares_raw === "1000000") ||
      (Number(conflictingPersisted.rows[0]?.sell_percent) === 25 &&
        conflictingPersisted.rows[0]?.shares_raw === "250000"),
  );

  console.log("[telegram-custom-trade-input-integration-tests] passed");
} finally {
  try {
    await pool.query(
      `delete from telegram_trade_intents
        where user_id = $1::uuid
           or idempotency_key like $2`,
      [userId, `%${suffix}%`],
    );
    await pool.query(`delete from unified_markets where id = $1`, [marketId]);
    await pool.query(`delete from unified_events where id = $1`, [eventId]);
    await pool.query(`delete from users where id = $1::uuid`, [userId]);
  } finally {
    await pool.end();
  }
}
