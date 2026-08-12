// @api-integration

import assert from "node:assert/strict";
import crypto from "node:crypto";

import {
  parseTelegramBotTradeAuthorityBinding,
  telegramBotTradeAuthorityFingerprint,
} from "./services/telegram-bot-trade-input-context.js";
import { loadTelegramFundingBuyReturnSourceIntentForUpdate } from "./services/telegram-funding.js";
import { createIntegrationTestPool } from "./test-database-target.js";

const pool = await createIntegrationTestPool({
  options: "-c jit=off",
  max: 2,
});
const client = await pool.connect();
const suffix = crypto.randomUUID();
const userId = crypto.randomUUID();
const telegramAccountId = crypto.randomUUID();
const authorizationId = crypto.randomUUID();
const sourceIntentId = crypto.randomUUID();
const telegramUserId = String(
  (BigInt(`0x${suffix.replaceAll("-", "").slice(0, 12)}`) %
    800_000_000_000_000n) +
    100_000_000_000_000n,
);
const eventId = `polymarket:buy-return-source-event-${suffix}`;
const marketId = `polymarket:buy-return-source-market-${suffix}`;
const walletAddress = `0x${suffix.replaceAll("-", "").slice(0, 40).padEnd(40, "0")}`;
const authority = {
  authorizationId,
  privyWalletId: `wallet-${suffix}`,
  telegramAccountLinkId: telegramAccountId,
  userId,
  version: 1,
  walletAddress,
  walletChain: "ethereum" as const,
};

try {
  await client.query("begin");
  await client.query(`insert into users (id, username) values ($1::uuid, $2)`, [
    userId,
    `buy-return-source-${suffix}`,
  ]);
  await client.query(
    `insert into user_telegram_accounts (
       id, user_id, privy_user_id, telegram_user_id, username
     ) values ($1::uuid, $2::uuid, $3, $4, $5)`,
    [
      telegramAccountId,
      userId,
      `did:privy:${suffix}`,
      telegramUserId,
      `buy-return-source-${suffix}`,
    ],
  );
  await client.query(
    `insert into user_wallets (
       user_id, wallet_address, wallet_type, is_primary, is_verified
     ) values ($1::uuid, $2, 'ethereum', true, true)`,
    [userId, walletAddress],
  );
  await client.query(
    `insert into telegram_bot_trading_preferences (
       user_id, desired_enabled, decision_source
     ) values ($1::uuid, true, 'manual_enable')`,
    [userId],
  );
  await client.query(
    `insert into telegram_bot_trading_authorizations (
       id, user_id, telegram_user_id, privy_user_id, wallet_address,
       wallet_chain, privy_wallet_id, enabled, enabled_venues, max_amount_usd
     ) values (
       $1::uuid, $2::uuid, $3, $4, $5, 'ethereum', $6, true,
       array['polymarket']::text[], 20
     )`,
    [
      authorizationId,
      userId,
      telegramUserId,
      `did:privy:${suffix}`,
      walletAddress,
      authority.privyWalletId,
    ],
  );
  await client.query(
    `insert into unified_events (
       id, venue, venue_event_id, title, status, end_date
     ) values (
       $1, 'polymarket', $2, 'Buy return source event', 'ACTIVE',
       now() + interval '2 days'
     )`,
    [eventId, `event-${suffix}`],
  );
  await client.query(
    `insert into unified_markets (
       id, venue, venue_market_id, event_id, title, status, market_type,
       close_time, expiration_time, outcomes, clob_token_ids, metadata
     ) values (
       $1, 'polymarket', $2, $3, 'Buy return source market', 'ACTIVE',
       'binary', now() + interval '1 day', now() + interval '2 days',
       '["Yes","No"]'::jsonb, '["yes-token","no-token"]'::jsonb,
       '{}'::jsonb
     )`,
    [marketId, `market-${suffix}`, eventId],
  );
  await client.query(
    `insert into telegram_trade_intents (
       id, telegram_user_id, user_id, authorization_id, chat_id,
       telegram_message_id, action, venue, market_id, event_id, side,
       amount_usd, status, result, expires_at, idempotency_key
     ) values (
       $1::uuid, $2, $3::uuid, $4::uuid, $2, 101,
       'buy', 'polymarket', $5, $6, 'YES', 15, 'previewed', $7::jsonb,
       now() + interval '2 minutes', $8
     )`,
    [
      sourceIntentId,
      telegramUserId,
      userId,
      authorizationId,
      marketId,
      eventId,
      JSON.stringify({ telegramAuthority: authority }),
      `buy-return-source-${suffix}`,
    ],
  );

  const source = await loadTelegramFundingBuyReturnSourceIntentForUpdate(
    client,
    { sourceIntentId, telegramAccountId },
  );
  assert.equal(source?.authorization_id, authorizationId);
  assert.equal(source?.status, "previewed");
  assert.equal(source?.amount_usd, "15.000000");
  const storedAuthority = parseTelegramBotTradeAuthorityBinding(
    source?.telegram_authority,
  );
  assert.ok(storedAuthority);
  assert.equal(
    telegramBotTradeAuthorityFingerprint(storedAuthority),
    telegramBotTradeAuthorityFingerprint(authority),
  );

  await client.query("rollback");
  console.log(
    "[telegram-funding-buy-return-source-integration-tests] production source-intent authority lock query passed",
  );
} catch (error) {
  await client.query("rollback").catch(() => undefined);
  throw error;
} finally {
  client.release();
  await pool.end();
}
