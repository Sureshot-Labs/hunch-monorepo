// @requires-db
import assert from "node:assert/strict";
import crypto from "node:crypto";
import "./integration-test-database-guard.js";
import { pool, type DbQuery } from "./db.js";
import {
  telegramBotTradingTestHooks,
  buildTelegramBotTradingMarketMessage,
  captureTelegramBotTradingCallback,
} from "./services/telegram-bot-trading.js";
import type { ApiBotTradingExecutor } from "./services/api-trading-service.js";
import { env } from "./env.js";
import { parseTelegramBotTradeAuthorityBinding } from "./services/telegram-bot-trade-input-context.js";

const client = await pool.connect();
// The fixture already owns a transaction; expose only its query interface,
// not PoolClient.connect(), and serialize parallel reads on this connection.
let queryQueue = Promise.resolve();
const db: DbQuery = {
  query: ((...args: unknown[]) => {
    const result = queryQueue.then(() =>
      (
        client.query as unknown as (...queryArgs: unknown[]) => Promise<unknown>
      )(...args),
    );
    queryQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }) as DbQuery["query"],
};
const previousMiniAppLink = env.telegramMiniAppLinkBase;
env.telegramMiniAppLinkBase = "https://t.me/hunch_bot/hunch";
try {
  await client.query("begin");
  const userId = crypto.randomUUID();
  const walletId = crypto.randomUUID();
  const telegramId = String(9_000_000_000 + crypto.randomInt(1_000_000_000));
  const address = `0x${crypto.randomBytes(20).toString("hex")}`;
  await client.query(
    `insert into users (id, privy_user_id, is_active) values ($1, $2, true)`,
    [userId, `did:privy:${userId}`],
  );
  await client.query(
    `insert into user_telegram_accounts (user_id, privy_user_id, telegram_user_id)
    values ($1, $2, $3)`,
    [userId, `did:privy:${userId}`, telegramId],
  );
  await client.query(
    `insert into user_wallets
    (id, user_id, wallet_type, wallet_address, is_verified, is_primary,
     privy_wallet_id, wallet_source, is_internal_wallet, privy_profile_updated_at)
    values ($1,$2,'ethereum',$3,true,true,$4,'embedded',true,now())`,
    [walletId, userId, address, `privy-${walletId}`],
  );
  const loadIdentity = () =>
    telegramBotTradingTestHooks.loadEnabledEvmAuthorization(
      client,
      telegramId,
      { allowInactiveForV2: true, lock: true },
    );
  const identity = await loadIdentity();
  assert.ok(identity);
  assert.equal(identity.id, null);
  assert.equal(identity.enabled, false);
  assert.equal(identity.wallet_address, address);
  const binding =
    telegramBotTradingTestHooks.buildTelegramTradeAuthorityBinding(identity);
  assert.ok(binding);
  assert.equal(binding.authorizationId, null);
  assert.deepEqual(parseTelegramBotTradeAuthorityBinding(binding), binding);
  assert.equal(
    await telegramBotTradingTestHooks.loadEnabledAuthorization(
      client,
      telegramId,
      "polymarket",
    ),
    null,
  );
  assert.equal(
    await telegramBotTradingTestHooks.loadEnabledEvmAuthorization(
      client,
      telegramId,
    ),
    null,
  );
  const rows = await client.query<{ grants: string; preferences: string }>(
    `select (select count(*)::text from telegram_bot_trading_authorizations where user_id=$1) as grants,
      (select count(*)::text from telegram_bot_trading_preferences where user_id=$1) as preferences`,
    [userId],
  );
  assert.deepEqual(rows.rows[0], { grants: "0", preferences: "0" });
  const eventId = `limitless:identity-${userId}`;
  const marketId = `limitless:identity-market-${userId}`;
  await client.query(
    `insert into runtime_policies (policy_key,effective_at,payload,created_by)
    values ('signal_bot',now(),$1::jsonb,$2)`,
    [
      JSON.stringify({
        miniAppHandoffMode: "always",
        miniAppHandoffContractVersion: 2,
        tradingEnabled: true,
        tradingActions: ["buy"],
        tradingVenues: [],
        buyContinuationEnabled: true,
        fundingReceiveEnabled: true,
        buyAmountPresetsUsd: [1],
        maxTradeAmountUsd: 25,
      }),
      userId,
    ],
  );
  await client.query(
    `insert into unified_events (id,venue,venue_event_id,title,status,end_date)
    values ($1,'limitless',$1,'Identity event','ACTIVE',now()+interval '1 day')`,
    [eventId],
  );
  await client.query(
    `insert into unified_markets
    (id,venue,venue_market_id,event_id,title,status,market_type,close_time,expiration_time,outcomes,clob_token_ids,metadata)
    values ($1,'limitless',$1,$2,'Identity market','ACTIVE','binary',now()+interval '1 day',now()+interval '1 day',
      '["Yes","No"]','["identity-yes","identity-no"]','{}')`,
    [marketId, eventId],
  );
  await client.query(
    `insert into unified_market_tokens (market_id,token_id,venue,outcome_side)
    values ($1,'identity-yes','limitless','YES'),($1,'identity-no','limitless','NO')`,
    [marketId],
  );
  let serverCalls = 0;
  const unexpectedServerCall = async () => {
    serverCalls += 1;
    throw new Error("No automation signing or submission is allowed");
  };
  const trading = {
    getReadiness: async () => ({
      executable: false,
      ready: false,
      maxExecutableBuyUsd: 2,
      setupRequired: false,
      reasonCode: "server_signer_unavailable",
      message: "Server signer is unavailable",
      capabilities: {
        venue: "limitless",
        authorizationModes: [],
        supportsBuy: false,
        supportsSell: false,
      },
    }),
    quote: async (input: {
      intent: { amount: { type: "usd"; value: string }; target: unknown };
    }) => ({
      action: "BUY",
      amount: input.intent.amount,
      target: input.intent.target,
      venue: "limitless",
      currentPrice: 0.5,
      price: 0.5,
      estimatedNotionalUsd: 1,
      estimatedShares: 2,
      maxSpendUsd: 1,
      minReceiveShares: 1.9,
      meetsVenueMinimum: true,
      fees: {},
      expiresAt: new Date(Date.now() + 60_000),
    }),
    prepareTrade: unexpectedServerCall,
    submitPreparedTrade: unexpectedServerCall,
  } as unknown as ApiBotTradingExecutor;
  const card = await buildTelegramBotTradingMarketMessage({
    appBaseUrl: "https://app.hunch.trade",
    db,
    marketRef: marketId,
    chatId: telegramId,
    telegramUserId: telegramId,
    telegramMiniAppEnabled: true,
    trading,
    signerInspector: unexpectedServerCall,
  });
  const buyButton = card.reply_markup?.inline_keyboard
    .flat()
    .find(
      (button) =>
        "callback_data" in button &&
        button.callback_data?.startsWith("hbt:buy:"),
    );
  assert.ok(
    buyButton && "callback_data" in buyButton && buyButton.callback_data,
  );
  assert.doesNotMatch(
    JSON.stringify(card.reply_markup),
    /Enable Telegram Trading/,
  );
  const preview = await captureTelegramBotTradingCallback({
    appBaseUrl: "https://app.hunch.trade",
    db,
    telegramMiniAppEnabled: true,
    trading,
    signerInspector: unexpectedServerCall,
    expectedIntentId: buyButton.callback_data.split(":").at(-1),
    expectedType: "buy",
    callbackQuery: {
      data: buyButton.callback_data,
      from: { id: Number(telegramId) },
      id: `identity-${userId}`,
      message: { chat: { id: telegramId, type: "private" }, message_id: 10 },
    },
  });
  assert.equal(preview.handled, true);
  assert.match(
    preview.messages.at(-1)?.text ?? "",
    /Confirm buy/,
    JSON.stringify(preview),
  );
  const stored = await client.query<{
    authorization_id: string | null;
    delivery_mode: string;
    has_plan: boolean;
  }>(
    `select authorization_id,delivery_mode,result ? 'appHandoffV2' as has_plan
      from telegram_trade_intents where id=$1::uuid`,
    [buyButton.callback_data.split(":").at(-1)],
  );
  assert.deepEqual(stored.rows[0], {
    authorization_id: null,
    delivery_mode: "app_handoff",
    has_plan: true,
  });
  const intentId = buyButton.callback_data.split(":").at(-1);
  const cancelled = await captureTelegramBotTradingCallback({
    appBaseUrl: "https://app.hunch.trade",
    db,
    telegramMiniAppEnabled: true,
    trading,
    signerInspector: unexpectedServerCall,
    expectedIntentId: intentId,
    expectedType: "cancel",
    callbackQuery: {
      data: `hbt:cancel:${intentId}`,
      from: { id: Number(telegramId) },
      id: `cancel-${userId}`,
      message: { chat: { id: telegramId, type: "private" }, message_id: 10 },
    },
  });
  assert.equal(cancelled.handled, true);
  const cancelledRow = await client.query<{ status: string }>(
    `select status from telegram_trade_intents where id=$1::uuid`,
    [intentId],
  );
  assert.equal(cancelledRow.rows[0]?.status, "cancelled");
  assert.equal(
    serverCalls,
    0,
    "no signer inspection, preparation or submit for a new Mini App user",
  );
  await client.query(`update user_wallets set is_verified=false where id=$1`, [
    walletId,
  ]);
  assert.equal(await loadIdentity(), null);
  await client.query(`update user_wallets set is_verified=true where id=$1`, [
    walletId,
  ]);
  await client.query(`update users set is_active=false where id=$1`, [userId]);
  assert.equal(await loadIdentity(), null);
  await client.query(`update users set is_active=true where id=$1`, [userId]);
  await client.query(
    `update user_wallets set is_internal_wallet=false, wallet_source='external' where id=$1`,
    [walletId],
  );
  assert.equal(await loadIdentity(), null);
  console.log(
    "[telegram-mini-app-identity] new user, no grant/preferences, locked identity, disabled user, unverified/external wallet passed",
  );
} finally {
  env.telegramMiniAppLinkBase = previousMiniAppLink;
  await client.query("rollback");
  client.release();
}
