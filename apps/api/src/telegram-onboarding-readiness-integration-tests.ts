// @requires-db
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { Keypair } from "@solana/web3.js";
import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import { createTelegramBotTradingRoutes } from "./routes/telegram-bot-trading.js";
import "./integration-test-database-guard.js";
import { pool } from "./db.js";
import { stableWalletOpaqueId } from "./account-value/canonical.js";
import { inspectTelegramOnboardingReadiness } from "./services/telegram-onboarding-readiness.js";
import {
  getDefaultSignalBotPolicy,
  normalizeSignalBotPolicy,
  resolveSignalBotTradingPolicyStateFromDb,
} from "./services/signal-bot-trading-policy.js";
import { ensureTelegramBotTradingPreferenceForLink } from "./services/telegram-bot-trading-preferences.js";
import { getTelegramBotTradingStatus } from "./services/telegram-bot-trading.js";
import { deliverTelegramBotOnboardingActions } from "./services/telegram-bot-onboarding-delivery.js";
import type { FundingDestinationOption } from "./funding/domain/types.js";

const client = await pool.connect();
try {
  await client.query("begin");
  const userId = crypto.randomUUID();
  const telegramUserId = `8${Date.now()}`;
  const walletAddress = `0x${crypto.randomBytes(20).toString("hex")}`;
  await client.query(
    `insert into users (id, privy_user_id, is_active, is_verified) values ($1, $2, true, true)`,
    [userId, `did:privy:${userId}`],
  );
  const link = (
    await client.query<{ id: string }>(
      `insert into user_telegram_accounts (user_id, privy_user_id, telegram_user_id) values ($1, $2, $3) returning id`,
      [userId, `did:privy:${userId}`, telegramUserId],
    )
  ).rows[0];
  assert.ok(link);
  const wallet = (
    await client.query<{ id: string }>(
      `insert into user_wallets (user_id, wallet_address, wallet_type, is_primary, is_verified, is_internal_wallet, privy_wallet_id, wallet_source, privy_profile_updated_at) values ($1, $2, 'ethereum', true, true, true, $3, 'embedded', now()) returning id`,
      [userId, walletAddress, `privy-${userId}`],
    )
  ).rows[0];
  assert.ok(wallet);
  await client.query(
    `insert into user_wallets (user_id, wallet_address, wallet_type, is_verified, is_internal_wallet, privy_wallet_id, wallet_source, privy_profile_updated_at) values ($1, $2, 'solana', true, true, $3, 'embedded', now())`,
    [userId, Keypair.generate().publicKey.toBase58(), `solana-${userId}`],
  );
  await client.query(
    `insert into runtime_policies (policy_key, effective_at, payload, created_by) values ('funding_control_plane', now(), $1::jsonb, $2)`,
    [
      JSON.stringify({
        version: 2,
        venues: ["polymarket"],
        receive: {
          assets: ["polygon:pusd", "solana:sol", "solana:usdc"],
          privy: false,
        },
        paused: false,
      }),
      userId,
    ],
  );
  const policy = normalizeSignalBotPolicy({
    ...getDefaultSignalBotPolicy(),
    fundingReceiveEnabled: true,
    tradingEnabled: true,
    miniAppHandoffMode: "always",
    miniAppHandoffContractVersion: 2,
    tradingVenues: ["polymarket"],
  });
  await client.query(
    `insert into runtime_policies (policy_key, effective_at, payload, created_by) values ('signal_bot', now(), $1::jsonb, $2)`,
    [JSON.stringify(policy), userId],
  );
  await ensureTelegramBotTradingPreferenceForLink(client, {
    userId,
    isNewLink: true,
  });
  const status = await getTelegramBotTradingStatus(
    client,
    telegramUserId,
    undefined,
    async () => {
      throw new Error("no bot signer should be inspected for a new user");
    },
    { readOnly: true, resolveActionReadiness: false },
  );
  assert.equal(status.preference?.desiredEnabled, false);
  assert.deepEqual(status.authorizations, []);
  const policyState = await resolveSignalBotTradingPolicyStateFromDb(client);
  const option: FundingDestinationOption = {
    destinationOptionId: "destination_test",
    venueId: "polymarket",
    venueBindingId: "binding_test",
    venueBindingOptionId: "option_test",
    controllerWalletId: stableWalletOpaqueId({
      walletType: "ethereum",
      networkId: "evm:137",
      address: walletAddress,
    }),
    safeLabel: "Polymarket",
    requiredAsset: {
      networkId: "evm:137",
      assetId: "0xc011a7e12a19f7b1f670d46f03b03f3342e82dfb",
      decimals: 6,
    },
    networkLabel: "Polygon",
    readinessClass: "internal_managed",
    preparationStatus: "ready",
    preparationPurpose: "fund",
    executionMode: "venue_relayer",
    marketClass: null,
    topology: "deposit_wallet",
    inspectionRevision: "inspection_test",
    recommended: true,
    selectable: true,
    reasonCodes: [],
  };
  let prepared = false;
  const inspect = () =>
    inspectTelegramOnboardingReadiness({
      db: client,
      userId,
      policyState,
      status,
      runtime: {
        capabilities: async () => ({
          fundingApiVersion: 1,
          receiveSessionsVersion: 1,
          creationMode: "on",
          destinationVenues: ["polymarket"],
          supportedActionKinds: [
            "add_funds",
            "trade_shortfall",
            "convert_asset",
            "withdrawal",
            "redeem",
          ],
        }),
        destinations: async (_userId, query) => {
          assert.equal(query.controllerWalletRef, wallet.id);
          return [
            {
              ...option,
              marketClass: query.marketClass ?? null,
              preparationPurpose: query.purpose,
              selectable: query.purpose === "fund" || prepared,
            },
          ];
        },
      },
    });
  assert.equal((await inspect()).state, "pending");
  // Exercise the actual outbox deferral SQL, scoped to this test's row.
  await client.query(
    `update telegram_bot_action_outbox set next_attempt_at = now() + interval '1 day' where action = 'welcome_menu' and user_id <> $1 and status in ('pending', 'retry')`,
    [userId],
  );
  const config = {
    adminUserIds: new Set<number>(),
    appBaseUrl: "https://app.hunch.trade",
    telegramMiniAppLinkBase: null,
  };
  let sent = 0;
  const deliver = () =>
    deliverTelegramBotOnboardingActions({
      db: client,
      config,
      isReady: async (scope) => {
        assert.equal(scope.telegramAccountId, link.id);
        assert.equal(scope.userId, userId);
        return (await inspect()).state === "ready";
      },
      telegram: {
        sendMessage: async () => {
          sent++;
          return { ok: true, messageId: 42 };
        },
      },
    });
  await deliver();
  assert.equal(sent, 0);
  const deferred = (
    await client.query(
      `select status, attempt_count, last_error, extract(epoch from next_attempt_at - now())::int as retry_seconds from telegram_bot_action_outbox where user_id=$1 and action='welcome_menu'`,
      [userId],
    )
  ).rows[0];
  assert.equal(deferred.status, "retry");
  assert.equal(deferred.attempt_count, 0);
  assert.equal(deferred.last_error, "onboarding_not_ready");
  assert.equal(deferred.retry_seconds, 5);
  await client.query(
    `update telegram_bot_action_outbox set created_at=now()-interval '3 minutes', next_attempt_at=now() where user_id=$1 and action='welcome_menu'`,
    [userId],
  );
  await deliver();
  const slowRetry = (
    await client.query(
      `select extract(epoch from next_attempt_at-now())::int as seconds from telegram_bot_action_outbox where user_id=$1 and action='welcome_menu'`,
      [userId],
    )
  ).rows[0];
  assert.equal(
    slowRetry.seconds,
    60,
    "old incomplete setup does not create a rapid retry loop",
  );
  prepared = true;
  assert.equal((await inspect()).state, "ready");
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(
    createTelegramBotTradingRoutes({
      db: client,
      reconciliationEnabled: false,
      authPreHandler: async (request) => {
        request.user = {
          id: userId,
          privyUserId: `did:privy:${userId}`,
          isActive: true,
          isVerified: true,
          isAdmin: false,
          kalshiProofBypass: false,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
      },
      internalPreHandler: async () => undefined,
      createTrading: () => ({}) as never,
      resolveInternalWallets: async () => [
        {
          privyWalletId: `privy-${userId}`,
          walletAddress,
          walletChain: "ethereum",
        },
      ],
      signerInspector: async () => {
        throw new Error(
          "Mini App status must not require bot signer configuration",
        );
      },
      inspectOnboarding: async (scope) => {
        assert.equal(scope.userId, userId);
        assert.equal(
          scope.policyState.policyRevision,
          policyState.policyRevision,
        );
        return inspect();
      },
    }),
  );
  try {
    const response = await app.inject({
      method: "GET",
      url: "/telegram/bot-trading/status",
    });
    assert.equal(response.statusCode, 200, response.body);
    const payload = response.json();
    assert.equal(payload.status.userId, userId);
    assert.equal(payload.status.onboarding.state, "ready");
    assert.equal(payload.status.onboarding.walletAddress, walletAddress);
    assert.equal(
      payload.status.onboarding.policyRevision,
      payload.policy.policyRevision,
    );
    assert.deepEqual(payload.status.authorizations, []);
    assert.equal(payload.status.preference.desiredEnabled, false);
    const internal = await app.inject({
      method: "POST",
      url: "/internal/telegram-bot/trading/onboarding",
      payload: { userId, telegramAccountId: link.id, telegramUserId },
    });
    assert.equal(internal.statusCode, 200, internal.body);
    assert.deepEqual(internal.json().onboarding, payload.status.onboarding);
    const foreignLink = await app.inject({
      method: "POST",
      url: "/internal/telegram-bot/trading/onboarding",
      payload: {
        userId,
        telegramAccountId: crypto.randomUUID(),
        telegramUserId,
      },
    });
    assert.equal(foreignLink.statusCode, 409);
  } finally {
    await app.close();
  }
  await client.query(
    `update telegram_bot_action_outbox set next_attempt_at=now() where user_id=$1 and action='welcome_menu'`,
    [userId],
  );
  await deliver();
  await deliver();
  assert.equal(sent, 1, "Welcome is sent once after readiness");
  assert.equal(
    (
      await client.query(
        `select count(*)::int as count from telegram_bot_trading_authorizations where user_id=$1`,
        [userId],
      )
    ).rows[0].count,
    0,
  );
  assert.equal(
    (
      await client.query(
        `select count(*)::int as count from funding_operations where user_id=$1`,
        [userId],
      )
    ).rows[0].count,
    0,
  );
  // A second unselected internal controller cannot be certified.
  await client.query(
    `insert into user_wallets (user_id, wallet_address, wallet_type, is_verified, is_internal_wallet, privy_wallet_id, wallet_source, privy_profile_updated_at) values ($1, $2, 'ethereum', true, true, $3, 'embedded', now())`,
    [userId, `0x${crypto.randomBytes(20).toString("hex")}`, `second-${userId}`],
  );
  assert.equal((await inspect()).reasonCode, "receive_wallet_ambiguous");
  console.log(
    "[telegram-onboarding-readiness-integration-tests] new zero-balance user, no bot authorization, recovery, exact ownership and deferred/deduplicated Welcome passed",
  );
} finally {
  await client.query("rollback");
  client.release();
}
