// @requires-db

import assert from "node:assert/strict";
import crypto from "node:crypto";

import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";

import type { User } from "./auth.js";
import { pool, type DbQuery } from "./db.js";
import { createTelegramBotTradingRoutes } from "./routes/telegram-bot-trading.js";
import type { PrivyServerSignerStatus } from "./services/api-trading-wallet-signing.js";
import type { ApiBotTradingExecutor } from "./services/api-trading-service.js";

const client = await pool.connect();

try {
  await client.query("begin");
  const db: DbQuery = {
    query: client.query.bind(client) as DbQuery["query"],
  };

  const suffix = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const privyUserId = `did:privy:telegram-trading-${suffix}`;
  const telegramUserId = `telegram-trading-${suffix}`;
  const walletAddress = "0x0000000000000000000000000000000000000137";
  const walletId = `wallet-${suffix}`;
  const signerId = `signer-${suffix}`;
  const policyId = `policy-${suffix}`;
  const eventId = `polymarket:telegram-trading-${suffix}`;
  const marketId = `polymarket:telegram-trading-market-${suffix}`;
  const now = new Date();

  await client.query(
    `insert into users (id, privy_user_id, is_active, is_verified)
     values ($1, $2, true, true)`,
    [userId, privyUserId],
  );
  await client.query(
    `insert into user_telegram_accounts (
       user_id,
       privy_user_id,
       telegram_user_id,
       username
     )
     values ($1, $2, $3, 'integration-user')`,
    [userId, privyUserId, telegramUserId],
  );
  await client.query(
    `insert into user_wallets (
       user_id,
       wallet_address,
       wallet_type,
       is_primary,
       is_verified
     )
     values ($1, $2, 'ethereum', true, true)`,
    [userId, walletAddress],
  );
  await client.query(
    `insert into runtime_policies (
       policy_key,
       effective_at,
       payload,
       created_by
     )
     values ('signal_bot', now(), $1::jsonb, $2)`,
    [
      JSON.stringify({
        tradingEnabled: true,
        tradingActions: ["buy"],
        tradingVenues: ["polymarket"],
        buyAmountPresetsUsd: [1],
        maxTradeAmountUsd: 2,
        maxSlippageBps: 500,
        intentTtlSec: 120,
      }),
      userId,
    ],
  );
  await client.query(
    `insert into unified_events (
       id,
       venue,
       venue_event_id,
       title,
       status,
       end_date
     )
     values ($1, 'polymarket', $2, 'Trading lifecycle event', 'ACTIVE', now() + interval '1 day')`,
    [eventId, `event-${suffix}`],
  );
  await client.query(
    `insert into unified_markets (
       id,
       venue,
       venue_market_id,
       event_id,
       title,
       status,
       market_type,
       close_time,
       expiration_time,
       outcomes,
       clob_token_ids,
       metadata
     )
     values (
       $1,
       'polymarket',
       $2,
       $3,
       'Trading lifecycle market',
       'ACTIVE',
       'binary',
       now() + interval '1 day',
       now() + interval '1 day',
       '["Yes","No"]',
       '["yes-token","no-token"]',
       '{}'::jsonb
     )`,
    [marketId, `market-${suffix}`, eventId],
  );

  const user: User = {
    createdAt: now,
    id: userId,
    isActive: true,
    isAdmin: false,
    isVerified: true,
    kalshiProofBypass: false,
    privyUserId,
    updatedAt: now,
  };
  let signerAttached = false;
  const signerInspector = async (input: {
    authorizationEnabled: boolean;
    signer: string;
  }): Promise<PrivyServerSignerStatus> => {
    const grant = {
      policyIds: [policyId],
      signerId,
      walletAddress: input.signer,
      walletChain: "ethereum" as const,
    };
    if (!signerAttached) {
      return {
        attached: false,
        canRemoveAllSigners: true,
        grant,
        message: "Grant bot access in Hunch Settings.",
        policyId,
        policyMaxBuyUsd: 2,
        signerId,
        state: "grant_required",
      };
    }
    return {
      attached: true,
      canRemoveAllSigners: true,
      grant,
      message: input.authorizationEnabled
        ? null
        : "Bot access is still attached and must be revoked.",
      policyId,
      policyMaxBuyUsd: 2,
      signerId,
      state: input.authorizationEnabled ? "ready" : "revoke_required",
    };
  };
  const trading = {
    getReadiness: async () => ({
      capabilities: {
        authorizationModes: ["server_delegated"],
        supportsBuy: true,
        supportsCancel: false,
        supportsExecutionSync: false,
        supportsOrderSync: false,
        supportsPositionSync: false,
        supportsSell: false,
        supportsSetup: false,
        venue: "polymarket" as const,
      },
      executable: true,
      message: null,
      ready: true,
      reasonCode: null,
      setupRequired: false,
    }),
  } as unknown as ApiBotTradingExecutor;

  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(
    createTelegramBotTradingRoutes({
      authPreHandler: async (request) => {
        request.user = user;
      },
      createTrading: () => trading,
      db,
      reconciliationEnabled: true,
      resolveInternalWallets: async () => [
        {
          privyWalletId: walletId,
          walletAddress,
          walletChain: "ethereum",
        },
      ],
      signerInspector,
    }),
  );

  const enable = () =>
    app.inject({
      method: "POST",
      payload: {
        enabledVenues: ["polymarket"],
        maxAmountUsd: 2,
      },
      url: "/telegram/bot-trading/enable",
    });

  const grantRequired = await enable();
  assert.equal(grantRequired.statusCode, 409);
  assert.equal(
    grantRequired.json().error,
    "privy_server_signer_grant_required",
  );
  assert.deepEqual(grantRequired.json().grants, [
    {
      policyIds: [policyId],
      signerId,
      walletAddress,
      walletChain: "ethereum",
    },
  ]);
  assert.equal(
    Number(
      (
        await client.query(
          `select count(*)::int as count
             from telegram_bot_trading_authorizations
            where user_id = $1`,
          [userId],
        )
      ).rows[0]?.count ?? -1,
    ),
    0,
  );

  signerAttached = true;
  const enabled = await enable();
  assert.equal(enabled.statusCode, 200, enabled.body);
  assert.equal(enabled.json().status.directExecutionReady, true);
  const authorization = (
    await client.query<{ id: string }>(
      `select id
         from telegram_bot_trading_authorizations
        where user_id = $1
          and enabled = true`,
      [userId],
    )
  ).rows[0];
  assert.ok(authorization?.id);

  const insertIntent = (status: "draft" | "executing") =>
    client.query(
      `insert into telegram_trade_intents (
         telegram_user_id,
         user_id,
         authorization_id,
         action,
         venue,
         market_id,
         side,
         amount_usd,
         status,
         expires_at,
         idempotency_key
       )
       values ($1, $2, $3, 'buy', 'polymarket', $4, 'YES', 1, $5, now() + interval '2 minutes', $6)
       returning id`,
      [
        telegramUserId,
        userId,
        authorization.id,
        marketId,
        status,
        `${status}-${suffix}`,
      ],
    );
  const draftId = (await insertIntent("draft")).rows[0]?.id;
  const executingId = (await insertIntent("executing")).rows[0]?.id;

  const disabled = await app.inject({
    method: "POST",
    url: "/telegram/bot-trading/disable",
  });
  assert.equal(disabled.statusCode, 200);
  const intentStatuses = await client.query<{ id: string; status: string }>(
    `select id, status
       from telegram_trade_intents
      where id = any($1::uuid[])
      order by id`,
    [[draftId, executingId]],
  );
  assert.equal(
    intentStatuses.rows.find((row) => row.id === draftId)?.status,
    "cancelled",
  );
  assert.equal(
    intentStatuses.rows.find((row) => row.id === executingId)?.status,
    "executing",
  );

  const revokeRequired = await app.inject({
    method: "GET",
    url: "/telegram/bot-trading/status",
  });
  assert.equal(revokeRequired.statusCode, 200);
  assert.equal(
    revokeRequired.json().status.signerStatus.state,
    "revoke_required",
  );
  assert.equal(revokeRequired.json().status.enabled, false);

  signerAttached = false;
  const revoked = await app.inject({
    method: "GET",
    url: "/telegram/bot-trading/status",
  });
  assert.equal(revoked.statusCode, 200);
  assert.equal(revoked.json().status.signerStatus.state, "grant_required");

  const regrantRequired = await enable();
  assert.equal(regrantRequired.statusCode, 409);
  signerAttached = true;
  const reenabled = await enable();
  assert.equal(reenabled.statusCode, 200);
  assert.equal(reenabled.json().status.directExecutionReady, true);

  signerAttached = false;
  const safetyDisabled = await app.inject({
    method: "GET",
    url: "/telegram/bot-trading/status",
  });
  assert.equal(safetyDisabled.statusCode, 200);
  assert.equal(safetyDisabled.json().status.enabled, false);
  assert.equal(
    safetyDisabled.json().status.signerStatus.state,
    "grant_required",
  );
  assert.equal(
    (
      await client.query<{ enabled: boolean }>(
        `select enabled
           from telegram_bot_trading_authorizations
          where id = $1`,
        [authorization.id],
      )
    ).rows[0]?.enabled,
    false,
  );

  await app.close();
  console.log(
    "[telegram-bot-trading-lifecycle-integration-tests] passed 24/24",
  );
} finally {
  await client.query("rollback");
  client.release();
}
