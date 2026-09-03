// @requires-db

import assert from "node:assert/strict";
import crypto from "node:crypto";

import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";

import "./integration-test-database-guard.js";
import type { User } from "./auth.js";
import { pool, type DbQuery } from "./db.js";
import { env } from "./env.js";
import { createTelegramBotTradingRoutes } from "./routes/telegram-bot-trading.js";
import type { PrivyServerSignerStatus } from "./services/api-trading-wallet-signing.js";
import type { ApiBotTradingExecutor } from "./services/api-trading-service.js";
import { SOLANA_NATIVE_ASSET } from "./funding/domain/network-fees.js";
import { fundingSidecarRuntimeConfig } from "./funding/runtime/sidecar-runtime-config.js";
import { parseTelegramAppHandoffV2Plan } from "./services/telegram-app-handoff-v2.js";
import {
  buildTelegramBotTradingMarketMessage,
  buildTelegramBotTradingStatusMessage,
  captureTelegramBotTradingCallback,
  reconcileStaleTelegramTradeIntents,
} from "./services/telegram-bot-trading.js";
import {
  deliverTelegramTradeLifecycleProgress,
  runTelegramTradeLifecycleProjectionBatchInTransaction,
  telegramTradeLifecycleProgressTestHooks,
} from "./services/telegram-trade-lifecycle-progress.js";
import { fenceTelegramTradeLifecycleNavigation } from "./services/telegram-trade-delivery-contract.js";
import { telegramNotificationDeliveryTestHooks } from "./services/telegram-notification-delivery.js";

const originalTelegramMiniAppLinkBase = env.telegramMiniAppLinkBase;
const originalTelegramBotToken = env.telegramBotToken;
env.telegramMiniAppLinkBase = "https://t.me/hunch_bot/hunch";
env.telegramBotToken = "integration-telegram-bot-token";

const client = await pool.connect();

try {
  await client.query("begin");
  let queryQueue = Promise.resolve();
  const db: DbQuery = {
    query: ((...args: unknown[]) => {
      const result = queryQueue.then(() =>
        (
          client.query as unknown as (
            ...queryArgs: unknown[]
          ) => Promise<unknown>
        )(...args),
      );
      queryQueue = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    }) as DbQuery["query"],
  };
  const renderCoordinator = {
    claim: async () => undefined,
    claimBackground: async () => true,
    isCurrent: async () => true,
    runExclusive: async <T>(input: { deliver: () => Promise<T> }) => ({
      status: "completed" as const,
      value: await input.deliver(),
    }),
  };

  const suffix = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const privyUserId = `did:privy:telegram-trading-${suffix}`;
  const telegramUserId = String(
    9_000_000_000 + crypto.randomInt(1_000_000_000),
  );
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
       is_verified,
       is_internal_wallet,
       privy_wallet_id,
       wallet_source,
       privy_profile_updated_at
     )
     values ($1, $2, 'ethereum', true, true, true, $3, 'embedded', now())`,
    [userId, walletAddress, walletId],
  );
  await client.query(
    `insert into telegram_bot_trading_preferences (
       user_id, desired_enabled, decision_source, decision_version
     ) values ($1, true, 'auto_link', 1)`,
    [userId],
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
        autoEnableOnTelegramLink: true,
        autoManagedMaxAmountUsd: 2,
        autoManagedVenues: ["polymarket"],
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
  let replacementRequired = false;
  let readinessUnavailable = false;
  const signerInspector = async (input: {
    authorizationEnabled: boolean;
    signer: string;
  }): Promise<PrivyServerSignerStatus> => {
    const grant = {
      policyIds: [policyId] as [string],
      policyProfile: "buy" as const,
      replaceExistingSigner: replacementRequired,
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
    if (replacementRequired) {
      return {
        attached: true,
        canRemoveAllSigners: true,
        grant,
        message: "Replace signer policy.",
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
    getReadiness: async () => {
      if (readinessUnavailable) {
        throw new Error("transient readiness failure");
      }
      return {
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
      };
    },
    quote: async (input: {
      intent: { amount: { type: "usd"; value: string }; target: unknown };
    }) => ({
      action: "BUY" as const,
      amount: input.intent.amount,
      currentPrice: 0.5,
      estimatedNotionalUsd: Number(input.intent.amount.value),
      estimatedShares: Number(input.intent.amount.value) * 2,
      expiresAt: new Date(Date.now() + 60_000),
      fees: {},
      maxSpendUsd: Number(input.intent.amount.value),
      meetsVenueMinimum: true,
      minReceiveShares: Number(input.intent.amount.value) * 1.9,
      price: 0.52,
      target: input.intent.target,
      venue: "polymarket" as const,
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
      internalPreHandler: async () => undefined,
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
      policyProfile: "buy",
      replaceExistingSigner: false,
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
  readinessUnavailable = true;
  const enabled = await enable();
  assert.equal(enabled.statusCode, 200, enabled.body);
  assert.equal(enabled.json().status.enabled, true);
  assert.equal(enabled.json().status.directExecutionReady, false);
  assert.equal(
    enabled.json().status.venueStatuses[0]?.reasonCode,
    "internal_api_unavailable",
  );
  readinessUnavailable = false;
  const recoveredReadiness = await app.inject({
    method: "GET",
    url: "/telegram/bot-trading/status",
  });
  assert.equal(recoveredReadiness.statusCode, 200);
  assert.equal(recoveredReadiness.json().status.directExecutionReady, true);
  replacementRequired = true;
  const replacement = await enable();
  assert.equal(replacement.statusCode, 409);
  assert.equal(
    replacement.json().error,
    "privy_server_signer_replacement_required",
  );
  assert.equal(replacement.json().grants[0]?.replaceExistingSigner, true);
  replacementRequired = false;
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

  // A sealed Mini App handoff is intentionally usable even where the
  // unattended executor has no CLOB slippage guard. Its initial draft must
  // reach preview, which is the transition that records the sealed v2 plan.
  await client.query(
    `update runtime_policies
        set payload = $2::jsonb
      where policy_key = 'signal_bot'
        and created_by = $1::uuid`,
    [
      userId,
      JSON.stringify({
        autoEnableOnTelegramLink: true,
        autoManagedMaxAmountUsd: 2,
        autoManagedVenues: ["polymarket"],
        buyContinuationEnabled: true,
        customTradeInputEnabled: true,
        fundingReceiveEnabled: true,
        miniAppHandoffContractVersion: 2,
        miniAppHandoffMode: "fallback",
        tradingEnabled: true,
        tradingActions: ["buy"],
        tradingVenues: ["polymarket"],
        buyAmountPresetsUsd: [1],
        maxTradeAmountUsd: 2,
        maxSlippageBps: 500,
        intentTtlSec: 120,
      }),
    ],
  );
  const limitlessEventId = `limitless:telegram-handoff-${suffix}`;
  const limitlessMarketId = `limitless:telegram-handoff-market-${suffix}`;
  await client.query(
    `insert into unified_events (
       id, venue, venue_event_id, title, status, end_date
     ) values ($1, 'limitless', $2, 'Limitless handoff event', 'ACTIVE', now() + interval '1 day')`,
    [limitlessEventId, `event-${suffix}`],
  );
  await client.query(
    `insert into unified_markets (
       id, venue, venue_market_id, event_id, title, status, market_type,
       close_time, expiration_time, outcomes, clob_token_ids, metadata
     ) values (
       $1, 'limitless', $2, $3, 'Limitless handoff market', 'ACTIVE', 'binary',
       now() + interval '1 day', now() + interval '1 day',
       '["Yes","No"]', '["limitless-yes","limitless-no"]', '{}'::jsonb
     )`,
    [limitlessMarketId, `market-${suffix}`, limitlessEventId],
  );
  // Trade handoff seals the exact venue outcome token. Production markets get
  // these identities from the indexer rather than inferring them from the
  // display-only clob_token_ids JSON, so the fixture must model that boundary.
  await client.query(
    `insert into unified_market_tokens (market_id, token_id, venue, outcome_side)
     values
       ($1, 'limitless-yes', 'limitless', 'YES'),
       ($1, 'limitless-no', 'limitless', 'NO')`,
    [limitlessMarketId],
  );
  const limitlessHandoffIntent = await client.query<{ id: string }>(
    `insert into telegram_trade_intents (
       telegram_user_id, user_id, authorization_id, chat_id,
       telegram_message_id, delivery_mode, action, venue, market_id, event_id,
       side, amount_usd, status, quote_snapshot, policy_snapshot, result,
       expires_at, idempotency_key
     ) values (
       $1, $2, $3, $1, '701', 'app_handoff', 'buy', 'limitless', $4, $5,
       'YES', 1, 'draft', '{}'::jsonb, '{}'::jsonb,
       jsonb_build_object(
         'telegramAuthority',
         jsonb_build_object(
           'version', 1,
           'authorizationId', $9::text,
           'telegramAccountLinkId', (
             select id::text from user_telegram_accounts where user_id = $2 limit 1
           ),
           'userId', $2::text,
           'walletAddress', $6::text,
           'walletChain', 'ethereum',
           'privyWalletId', $7::text
         )
       ),
       now() + interval '2 minutes', $8
     ) returning id`,
    [
      telegramUserId,
      userId,
      authorization.id,
      limitlessMarketId,
      limitlessEventId,
      walletAddress,
      walletId,
      `limitless-initial-handoff:${suffix}`,
      authorization.id,
    ],
  );
  const limitlessHandoffIntentId = limitlessHandoffIntent.rows[0]?.id;
  assert.ok(limitlessHandoffIntentId);
  const limitlessClobHandoffTrading = {
    getReadiness: async () => ({
      capabilities: {
        authorizationModes: ["server_delegated"],
        supportsBuy: false,
        supportsCancel: false,
        supportsExecutionSync: false,
        supportsOrderSync: false,
        supportsPositionSync: false,
        supportsSell: false,
        supportsSetup: false,
        venue: "limitless" as const,
      },
      executable: false,
      maxExecutableBuyUsd: 2,
      message:
        "Limitless CLOB bot trading is disabled until slippage can be enforced by the submitted order.",
      ready: false,
      reasonCode: "limitless_clob_slippage_guard_unavailable",
      setupRequired: false,
    }),
    quote: async (input: {
      intent: { amount: { type: "usd"; value: string }; target: unknown };
    }) => ({
      action: "BUY" as const,
      amount: input.intent.amount,
      currentPrice: 0.5,
      estimatedNotionalUsd: Number(input.intent.amount.value),
      estimatedShares: Number(input.intent.amount.value) * 2,
      expiresAt: new Date(Date.now() + 60_000),
      fees: {},
      maxSpendUsd: Number(input.intent.amount.value),
      meetsVenueMinimum: true,
      minReceiveShares: Number(input.intent.amount.value) * 1.9,
      price: 0.52,
      target: input.intent.target,
      venue: "limitless" as const,
    }),
  } as unknown as ApiBotTradingExecutor;
  const limitlessTemporarilyUnavailableFundingTrading = {
    ...limitlessClobHandoffTrading,
    getReadiness: async () => ({
      capabilities: {
        authorizationModes: ["server_delegated"],
        supportsBuy: false,
        supportsCancel: false,
        supportsExecutionSync: false,
        supportsOrderSync: false,
        supportsPositionSync: false,
        supportsSell: false,
        supportsSetup: false,
        venue: "limitless" as const,
      },
      executable: false,
      maxExecutableBuyUsd: 0,
      message:
        "Limitless CLOB bot trading is disabled until slippage can be enforced by the submitted order.",
      ready: false,
      reasonCode: "limitless_clob_slippage_guard_unavailable",
      setupRequired: false,
    }),
  } as ApiBotTradingExecutor;
  const limitlessInitialHandoff = await captureTelegramBotTradingCallback({
    appBaseUrl: "https://app.hunch.trade",
    callbackQuery: {
      data: `hbt:buy:${limitlessHandoffIntentId}`,
      from: { id: telegramUserId as never },
      id: `limitless-initial-handoff:${suffix}`,
      message: {
        chat: { id: telegramUserId, type: "private" },
        message_id: 701,
      },
    },
    db,
    expectedIntentId: limitlessHandoffIntentId,
    expectedType: "buy",
    signerInspector,
    telegramMiniAppEnabled: true,
    trading: limitlessClobHandoffTrading,
  });
  assert.equal(limitlessInitialHandoff.handled, true);
  assert.equal(limitlessInitialHandoff.intentStatus, "previewed");
  assert.match(
    limitlessInitialHandoff.messages.at(-1)?.text ?? "",
    /Confirm buy/u,
    "the initial Limitless handoff must publish its Review instead of the server readiness failure",
  );
  assert.equal(
    (
      await client.query<{ has_plan: boolean }>(
        `select result ? 'appHandoffV2' as has_plan
           from telegram_trade_intents
          where id = $1::uuid`,
        [limitlessHandoffIntentId],
      )
    ).rows[0]?.has_plan,
    true,
    "the initial preview must persist the v2 plan needed by its later Confirm callback",
  );
  const initialDirectPlanResult = await client.query<{ plan: unknown }>(
    `select result #> '{appHandoffV2,plan}' as plan
       from telegram_trade_intents
      where id = $1::uuid`,
    [limitlessHandoffIntentId],
  );
  const initialDirectPlan = parseTelegramAppHandoffV2Plan(
    initialDirectPlanResult.rows[0]?.plan as never,
  );
  assert.equal(initialDirectPlan.kind, "direct_trade");
  const limitlessUsdc = {
    assetId: fundingSidecarRuntimeConfig.limitlessUsdcAddress,
    decimals: 6,
    networkId: "evm:8453",
  } as const;
  const recoveredFundingPlan = parseTelegramAppHandoffV2Plan({
    executionContractVersion: 2,
    funding: {
      discoveryRequest: {
        confirmedSourceAmount: null,
        consumerIntent: {
          marketContextId: "limitless-yes",
          marketId: limitlessMarketId,
          side: "BUY",
          spend: { asset: limitlessUsdc, raw: "1000000" },
          venueId: "limitless",
        },
        deadline: new Date(Date.now() + 60_000).toISOString(),
        destinationOptionId: "limitless-controller-usdc",
        marketContextId: "limitless-yes",
        maxFeeUsd: "1",
        maxSlippageBps: 500,
        purpose: "trade_shortfall",
        requestedDestinationAmount: {
          asset: limitlessUsdc,
          raw: "1000000",
        },
        serverAdditionalDestinationAmount: {
          asset: limitlessUsdc,
          raw: "500000",
        },
        venueBindingOptionId: "limitless-controller-binding",
        withdrawalRecipientId: null,
      },
      destination: {
        controllerWalletId: `limitless-controller-${suffix}`,
        destinationOptionId: "limitless-controller-usdc",
        requiredAsset: limitlessUsdc,
        topology: "solana_relay_base_usdc",
        venueBindingId: "limitless-controller-binding",
        venueBindingOptionId: "limitless-controller-binding",
        venueId: "limitless",
      },
      fundingPolicyRevision: `funding-policy-${suffix}`,
      sourceDebits: [
        {
          asset: SOLANA_NATIVE_ASSET,
          locationId: `solana-wallet-${suffix}`,
          maximumRaw: "52000000",
          sourceFingerprint: "a".repeat(64),
        },
      ],
    },
    kind: "funding",
    trade: initialDirectPlan.trade,
    version: 2,
  });
  await client.query(
    `update telegram_trade_intents
        set status = 'previewed',
            submit_started_at = null,
            funding_operation_id = null,
            result = (result - 'appHandoffV2') || jsonb_build_object(
              'fundingReasonCodes', jsonb_build_array('destination_unavailable'),
              'fundingState', 'checking_internal_balance',
              'stage', 'funding_preview'
            ),
            updated_at = now()
      where id = $1::uuid`,
    [limitlessHandoffIntentId],
  );
  await client.query(
    `delete from telegram_app_handoffs
      where trade_intent_id = $1::uuid`,
    [limitlessHandoffIntentId],
  );
  const retryableLimitlessHandoff = await captureTelegramBotTradingCallback({
    appBaseUrl: "https://app.hunch.trade",
    callbackQuery: {
      data: `hbt:retry_buy:${limitlessHandoffIntentId}`,
      from: { id: telegramUserId as never },
      id: `limitless-retryable-handoff:${suffix}`,
      message: {
        chat: { id: telegramUserId, type: "private" },
        message_id: 701,
      },
    },
    db,
    expectedIntentId: limitlessHandoffIntentId,
    inspectMiniAppFunding: async () => ({
      kind: "temporarily_unavailable",
      reasonCodes: ["destination_unavailable"],
    }),
    inspectTradeShortfall: async () => ({
      kind: "temporarily_unavailable",
      reasonCodes: ["destination_unavailable"],
    }),
    signerInspector,
    telegramMiniAppEnabled: true,
    trading: limitlessTemporarilyUnavailableFundingTrading,
  });
  assert.equal(retryableLimitlessHandoff.handled, true);
  assert.equal(retryableLimitlessHandoff.intentStatus, "previewed");
  assert.match(
    retryableLimitlessHandoff.messages.at(-1)?.text ?? "",
    /Checking available Hunch funds/u,
  );
  assert.doesNotMatch(
    retryableLimitlessHandoff.messages.at(-1)?.text ?? "",
    /Direct bot trading is not ready/u,
  );
  let markUnavailableInspectionStarted!: () => void;
  const unavailableInspectionStarted = new Promise<void>((resolve) => {
    markUnavailableInspectionStarted = resolve;
  });
  let releaseUnavailableInspection!: () => void;
  const unavailableInspectionRelease = new Promise<void>((resolve) => {
    releaseUnavailableInspection = resolve;
  });
  const losingUnavailableHandoff = captureTelegramBotTradingCallback({
    appBaseUrl: "https://app.hunch.trade",
    callbackQuery: {
      data: `hbt:retry_buy:${limitlessHandoffIntentId}`,
      from: { id: telegramUserId as never },
      id: `limitless-concurrent-unavailable:${suffix}`,
      message: {
        chat: { id: telegramUserId, type: "private" },
        message_id: 701,
      },
    },
    db,
    expectedIntentId: limitlessHandoffIntentId,
    inspectMiniAppFunding: async () => {
      markUnavailableInspectionStarted();
      await unavailableInspectionRelease;
      return {
        kind: "temporarily_unavailable" as const,
        reasonCodes: ["destination_unavailable"],
      };
    },
    inspectTradeShortfall: async () => ({
      kind: "temporarily_unavailable",
      reasonCodes: ["destination_unavailable"],
    }),
    signerInspector,
    telegramMiniAppEnabled: true,
    trading: limitlessTemporarilyUnavailableFundingTrading,
  });
  await unavailableInspectionStarted;
  const recoveredLimitlessHandoff = await captureTelegramBotTradingCallback({
    appBaseUrl: "https://app.hunch.trade",
    callbackQuery: {
      data: `hbt:retry_buy:${limitlessHandoffIntentId}`,
      from: { id: telegramUserId as never },
      id: `limitless-recovered-handoff:${suffix}`,
      message: {
        chat: { id: telegramUserId, type: "private" },
        message_id: 701,
      },
    },
    db,
    expectedIntentId: limitlessHandoffIntentId,
    inspectMiniAppFunding: async () => ({ kind: "destination_ready" }),
    inspectTradeShortfall: async () => ({
      kind: "temporarily_unavailable",
      reasonCodes: ["destination_unavailable"],
    }),
    signerInspector,
    telegramMiniAppEnabled: true,
    trading: limitlessClobHandoffTrading,
  });
  releaseUnavailableInspection();
  const unavailableAfterRecovery = await losingUnavailableHandoff;
  assert.equal(recoveredLimitlessHandoff.handled, true);
  assert.equal(recoveredLimitlessHandoff.intentStatus, "previewed");
  assert.match(
    recoveredLimitlessHandoff.messages.at(-1)?.text ?? "",
    /Confirm buy/u,
  );
  assert.equal(unavailableAfterRecovery.messages.length, 0);
  assert.deepEqual(
    (
      await client.query<{
        funding_state: string | null;
        has_plan: boolean;
      }>(
        `select result ? 'appHandoffV2' as has_plan,
                result ->> 'fundingState' as funding_state
           from telegram_trade_intents
          where id = $1::uuid`,
        [limitlessHandoffIntentId],
      )
    ).rows[0],
    { funding_state: "destination_ready", has_plan: true },
  );
  await client.query(
    `delete from telegram_app_handoffs
      where trade_intent_id = $1::uuid`,
    [limitlessHandoffIntentId],
  );
  await client.query(
    `update telegram_trade_intents
        set status = 'previewed',
            submit_started_at = null,
            funding_operation_id = null,
            result = (result - 'appHandoffV2') || jsonb_build_object(
              'fundingState', 'deposit',
              'stage', 'funding_preview'
            ),
            updated_at = now()
      where id = $1::uuid`,
    [limitlessHandoffIntentId],
  );
  const recoveredFromDeposit = await captureTelegramBotTradingCallback({
    appBaseUrl: "https://app.hunch.trade",
    callbackQuery: {
      data: `hbt:retry_buy:${limitlessHandoffIntentId}`,
      from: { id: telegramUserId as never },
      id: `limitless-deposit-to-plan:${suffix}`,
      message: {
        chat: { id: telegramUserId, type: "private" },
        message_id: 701,
      },
    },
    db,
    expectedIntentId: limitlessHandoffIntentId,
    inspectMiniAppFunding: async () => ({
      kind: "web_funding_plan",
      plan: recoveredFundingPlan,
    }),
    inspectTradeShortfall: async () => ({
      kind: "temporarily_unavailable",
      reasonCodes: ["destination_unavailable"],
    }),
    signerInspector,
    telegramMiniAppEnabled: true,
    trading: limitlessTemporarilyUnavailableFundingTrading,
  });
  assert.equal(recoveredFromDeposit.handled, true);
  assert.equal(
    recoveredFromDeposit.intentStatus,
    "confirming",
    "a safe deposit preview must be replaceable by the exact sealed funding plan",
  );
  assert.match(
    recoveredFromDeposit.messages.at(-1)?.text ?? "",
    /Confirm buy/u,
    "the replacement plan must immediately publish its one-click Review",
  );
  assert.equal(
    recoveredFromDeposit.messages
      .at(-1)
      ?.reply_markup?.inline_keyboard.flat()
      .some((button) => button.text === "Confirm buy" && "url" in button),
    true,
    "the Review must carry the pre-issued Mini App handoff instead of another callback",
  );
  assert.deepEqual(
    (
      await client.query<{
        funding_state: string | null;
        handoffs: string;
        has_plan: boolean;
      }>(
        `select intent.result ? 'appHandoffV2' as has_plan,
                intent.result ->> 'fundingState' as funding_state,
                count(handoff.*)::text as handoffs
           from telegram_trade_intents intent
           left join telegram_app_handoffs handoff
             on handoff.trade_intent_id = intent.id
          where intent.id = $1::uuid
          group by intent.id`,
        [limitlessHandoffIntentId],
      )
    ).rows[0],
    { funding_state: "web_funding_plan", handoffs: "1", has_plan: true },
    "same-key recovery must create one durable plan and one handoff",
  );
  await client.query(
    `delete from telegram_app_handoffs
      where trade_intent_id = $1::uuid`,
    [limitlessHandoffIntentId],
  );
  await client.query(`delete from telegram_trade_intents where id = $1::uuid`, [
    limitlessHandoffIntentId,
  ]);
  const insertMarketExitIntent = async (label: string) => {
    const result = await client.query<{ id: string }>(
      `insert into telegram_trade_intents (
         telegram_user_id, user_id, authorization_id, chat_id,
         telegram_message_id, action, venue, market_id, side, amount_usd,
         status, expires_at, idempotency_key
       ) values (
         $1, $2, $3, $1, '700', 'buy', 'polymarket', $4, 'YES', 1,
         'confirming', now() + interval '2 minutes', $5
       )
       returning id`,
      [
        telegramUserId,
        userId,
        authorization.id,
        marketId,
        `${label}-${suffix}`,
      ],
    );
    const id = result.rows[0]?.id;
    assert.ok(id);
    return id;
  };
  const invokeMarketExit = async (
    intentId: string,
    type: "cancel" | "change_amount",
  ) =>
    captureTelegramBotTradingCallback({
      appBaseUrl: "https://app.hunch.trade",
      callbackQuery: {
        data: `hbt:${type}:${intentId}`,
        from: { id: telegramUserId as never },
        id: `${type}-${suffix}`,
        message: {
          chat: { id: telegramUserId, type: "private" },
          message_id: 700,
        },
      },
      db,
      expectedIntentId: intentId,
      expectedType: type,
      signerInspector,
      trading,
    });

  const changeAmountIntentId = await insertMarketExitIntent("change-amount");
  const changedAmount = await invokeMarketExit(
    changeAmountIntentId,
    "change_amount",
  );
  assert.equal(changedAmount.handled, true);
  const changedAmountButtons =
    changedAmount.messages.at(-1)?.reply_markup?.inline_keyboard.flat() ?? [];
  assert.equal(
    changedAmountButtons.some((button) => button.text.includes("$1 · YES")),
    true,
    JSON.stringify(changedAmount.messages.at(-1)),
  );
  assert.equal(
    changedAmountButtons.some((button) => button.text.includes("$1 · NO")),
    false,
    "Change amount keeps the selected side while rebuilding fresh amount choices",
  );
  assert.deepEqual(
    (
      await client.query<{ error_code: string | null; status: string }>(
        `select status, error_code
           from telegram_trade_intents
          where id = $1::uuid`,
        [changeAmountIntentId],
      )
    ).rows[0],
    { error_code: "amount_change_requested", status: "cancelled" },
  );

  await client.query(
    `update telegram_trade_intents
        set status = 'cancelled', updated_at = now()
      where user_id = $1::uuid and status = 'draft'`,
    [userId],
  );
  const cancelIntentId = await insertMarketExitIntent("cancel-to-market");
  const cancelledToMarket = await invokeMarketExit(cancelIntentId, "cancel");
  assert.equal(cancelledToMarket.handled, true);
  const cancelButtons =
    cancelledToMarket.messages.at(-1)?.reply_markup?.inline_keyboard.flat() ??
    [];
  assert.equal(
    cancelButtons.some((button) => button.text.includes("$1 · YES")),
    true,
  );
  assert.equal(
    cancelButtons.some((button) => button.text.includes("$1 · NO")),
    true,
    "Cancel returns to the complete market action card instead of ending navigation",
  );

  const insertExpiredIntent = async (
    label: string,
    action: "buy" | "redeem" | "sell",
  ) => {
    const result = await client.query<{ id: string }>(
      `insert into telegram_trade_intents (
         telegram_user_id, user_id, authorization_id, chat_id,
         telegram_message_id, action, venue, market_id, side, amount_usd,
         shares_raw, status, expires_at, idempotency_key
       ) values (
         $1, $2, $3, $1, '700', $5, 'polymarket', $4,
         case when $5 = 'redeem' then null else 'YES' end,
         case when $5 = 'buy' then 1 else null end,
         case when $5 = 'sell' then '1000000' else null end,
         'confirming', now() - interval '1 minute', $6
       ) returning id`,
      [
        telegramUserId,
        userId,
        authorization.id,
        marketId,
        action,
        `${label}-${suffix}`,
      ],
    );
    const id = result.rows[0]?.id;
    assert.ok(id);
    return id;
  };
  const invokeIntentNavigation = async (
    intentId: string,
    type: "cancel" | "open_market" | "retry_buy",
    messageId = 700,
  ) =>
    captureTelegramBotTradingCallback({
      appBaseUrl: "https://app.hunch.trade",
      callbackQuery: {
        data: `hbt:${type}:${intentId}`,
        from: { id: telegramUserId as never },
        id: `${type}-navigation-${suffix}`,
        message: {
          chat: { id: telegramUserId, type: "private" },
          message_id: messageId,
        },
      },
      db,
      expectedIntentId: intentId,
      ...(type === "open_market" ? { expectedType: type } : {}),
      signerInspector,
      trading,
    });
  for (const action of ["buy", "sell", "redeem"] as const) {
    const expiredIntentId = await insertExpiredIntent(
      `expired-${action}`,
      action,
    );
    const expiredExit = await invokeIntentNavigation(expiredIntentId, "cancel");
    assert.equal(expiredExit.handled, true);
    assert.equal(
      (
        await client.query<{ status: string }>(
          `select status from telegram_trade_intents where id = $1::uuid`,
          [expiredIntentId],
        )
      ).rows[0]?.status,
      "expired",
      `expired ${action} exits without reviving its intent`,
    );
    assert.ok(
      expiredExit.messages
        .at(-1)
        ?.reply_markup?.inline_keyboard.some((row) =>
          row.some((button) => button.text === "🏠 Home"),
        ),
      `expired ${action} returns a navigable market card`,
    );
  }
  const expiredOpenIntentId = await insertExpiredIntent("expired-open", "buy");
  const expiredOpen = await invokeIntentNavigation(
    expiredOpenIntentId,
    "open_market",
  );
  assert.equal(expiredOpen.handled, true);
  assert.match(
    expiredOpen.answers[0]?.text ?? "",
    /Opening the current market card/u,
  );
  assert.equal(
    (
      await client.query<{ status: string }>(
        `select status from telegram_trade_intents where id = $1::uuid`,
        [expiredOpenIntentId],
      )
    ).rows[0]?.status,
    "confirming",
    "open_market is navigation only and must not revive or otherwise mutate an expired intent",
  );

  const appHandoffExit = await client.query<{ id: string }>(
    `insert into telegram_trade_intents (
       telegram_user_id, user_id, authorization_id, chat_id,
       telegram_message_id, action, venue, market_id, side, amount_usd,
       status, expires_at, idempotency_key, delivery_mode, result
     ) values (
       $1, $2, $3, $1, '700', 'buy', 'polymarket', $4, 'YES', 1,
       'external_handoff', now() + interval '2 minutes', $5, 'app_handoff',
       jsonb_build_object(
         'appHandoffExecution',
         jsonb_build_object('version', 2, 'committedAt', now()::text)
       )
     ) returning id`,
    [
      telegramUserId,
      userId,
      authorization.id,
      marketId,
      `external-handoff-exit:${suffix}`,
    ],
  );
  const appHandoffExitId = appHandoffExit.rows[0]?.id;
  assert.ok(appHandoffExitId);
  const cancelledHandoff = await invokeIntentNavigation(
    appHandoffExitId,
    "cancel",
  );
  assert.equal(cancelledHandoff.handled, true);
  assert.equal(
    (
      await client.query<{ status: string }>(
        `select status from telegram_trade_intents where id = $1::uuid`,
        [appHandoffExitId],
      )
    ).rows[0]?.status,
    "cancelled",
    "a pre-submit Mini App handoff must be cancelled rather than treated as terminal navigation",
  );
  await client.query(`delete from telegram_trade_intents where id = $1::uuid`, [
    appHandoffExitId,
  ]);

  const expiringDirectHandoffId = (
    await client.query<{ id: string }>(
      `insert into telegram_trade_intents (
         telegram_user_id, user_id, authorization_id, chat_id,
         telegram_message_id, action, venue, market_id, side, amount_usd,
         status, expires_at, idempotency_key, delivery_mode, result
       ) values (
         $1, $2, $3, $1, '700', 'buy', 'polymarket', $4, 'YES', 1,
         'previewed', now() - interval '1 minute', $5, 'app_handoff',
         '{}'::jsonb
       ) returning id::text`,
      [
        telegramUserId,
        userId,
        authorization.id,
        marketId,
        `expiring-direct-handoff:${suffix}`,
      ],
    )
  ).rows[0]?.id;
  assert.ok(expiringDirectHandoffId);
  assert.deepEqual(
    (
      await client.query<{
        expired: boolean;
        has_consent: boolean;
        has_execution: boolean;
      }>(
        `select expires_at <= now() as expired,
                coalesce(result #>> '{appHandoffConsent,version}' = '2', false) as has_consent,
                coalesce(result #>> '{appHandoffExecution,version}' = '2', false) as has_execution
           from telegram_trade_intents
          where id = $1::uuid`,
        [expiringDirectHandoffId],
      )
    ).rows[0],
    { expired: true, has_consent: false, has_execution: false },
  );
  const expiredDirectHandoff = await captureTelegramBotTradingCallback({
    appBaseUrl: "https://app.hunch.trade",
    callbackQuery: {
      data: `hbt:confirm:${expiringDirectHandoffId}`,
      from: { id: telegramUserId as never },
      id: `expired-direct-confirm-${suffix}`,
      message: {
        chat: { id: telegramUserId, type: "private" },
        message_id: 700,
      },
    },
    db,
    expectedIntentId: expiringDirectHandoffId,
    expectedType: "confirm",
    signerInspector,
    trading,
  });
  assert.equal(
    expiredDirectHandoff.intentStatus,
    "expired",
    JSON.stringify(expiredDirectHandoff),
  );
  assert.equal(
    expiredDirectHandoff.lifecycleOwnsTerminalDelivery,
    false,
    "expired has no lifecycle projection and must retain its callback-rendered market card",
  );
  assert.ok(expiredDirectHandoff.messages.at(-1));
  await client.query(`delete from telegram_trade_intents where id = $1::uuid`, [
    expiringDirectHandoffId,
  ]);

  const insertTerminalSellIntent = async (label: string, status: string) => {
    const result = await client.query<{ id: string }>(
      `insert into telegram_trade_intents (
         telegram_user_id, user_id, authorization_id, chat_id,
         telegram_message_id, action, venue, market_id, side, shares_raw,
         status, venue_order_id, expires_at, idempotency_key
       ) values (
         $1, $2, $3, $1, '700', 'sell', 'polymarket', $4, 'YES', '1000000',
         $5, case when $5 = 'filled' then 'terminal-sell-' || $6 else null end,
         now() + interval '2 minutes', $6
       ) returning id`,
      [
        telegramUserId,
        userId,
        authorization.id,
        marketId,
        status,
        `${label}-${suffix}`,
      ],
    );
    const id = result.rows[0]?.id;
    assert.ok(id);
    return id;
  };
  for (const status of ["filled", "failed"]) {
    const intentId = await insertTerminalSellIntent(`sell-${status}`, status);
    const reopened = await invokeIntentNavigation(intentId, "retry_buy");
    assert.equal(reopened.handled, true);
    assert.match(
      reopened.answers[0]?.text ?? "",
      /Opening a fresh market card/u,
      `legacy terminal Sell ${status} card still reopens the market`,
    );
  }

  // A direct v2 handoff has no FundingOperation. Its exact Buy still owns the
  // original Telegram card, so each ordinary intent transition must create one
  // monotonic edit rather than wait for the funding-only projector forever.
  const directLifecycleIntent = await client.query<{ id: string }>(
    `insert into telegram_trade_intents (
       telegram_user_id, user_id, authorization_id, chat_id,
       telegram_message_id, action, venue, market_id, event_id, side,
       amount_usd, status, expires_at, idempotency_key, delivery_mode, result
     ) values (
       $1, $2, $3, $1, '701', 'buy', 'polymarket', $4, $5, 'YES',
       1, 'external_handoff', now() + interval '2 minutes', $6, 'app_handoff',
       jsonb_build_object(
         'appHandoffExecution',
         jsonb_build_object('version', 2, 'committedAt', now()::text)
       )
     ) returning id`,
    [
      telegramUserId,
      userId,
      authorization.id,
      marketId,
      eventId,
      `direct-lifecycle:${suffix}`,
    ],
  );
  const directLifecycleIntentId = directLifecycleIntent.rows[0]?.id;
  assert.ok(directLifecycleIntentId);
  const directUpdatedAtBeforeProjection = (
    await client.query<{ updated_at: string }>(
      `select updated_at::text
         from telegram_trade_intents
        where id = $1::uuid`,
      [directLifecycleIntentId],
    )
  ).rows[0]?.updated_at;
  assert.ok(directUpdatedAtBeforeProjection);

  const awaitingClient =
    await runTelegramTradeLifecycleProjectionBatchInTransaction(client);
  assert.equal(awaitingClient.created, 1);
  assert.equal(
    (
      await client.query<{ updated_at: string }>(
        `select updated_at::text
           from telegram_trade_intents
          where id = $1::uuid`,
        [directLifecycleIntentId],
      )
    ).rows[0]?.updated_at,
    directUpdatedAtBeforeProjection,
    "derived lifecycle projection must not advance the intent source timestamp",
  );
  assert.equal(
    (
      await telegramTradeLifecycleProgressTestHooks.listCandidateIds(client)
    ).includes(directLifecycleIntentId),
    false,
    "an unchanged projected direct handoff is removed from the candidate loop",
  );
  await client.query(
    `update telegram_trade_intents
        set status = 'executing',
            submit_started_at = clock_timestamp(),
            updated_at = clock_timestamp()
      where id = $1::uuid`,
    [directLifecycleIntentId],
  );
  assert.equal(
    (
      await telegramTradeLifecycleProgressTestHooks.listCandidateIds(client)
    ).includes(directLifecycleIntentId),
    true,
    "an intent transition newer than its projection watermark wakes the card",
  );
  const submittingDirect =
    await runTelegramTradeLifecycleProjectionBatchInTransaction(client);
  assert.equal(submittingDirect.created, 1);
  await client.query(
    `update telegram_trade_intents
        set status = 'filled',
            venue_order_id = 'direct-lifecycle-order',
            updated_at = clock_timestamp()
      where id = $1::uuid`,
    [directLifecycleIntentId],
  );
  const filledDirect =
    await runTelegramTradeLifecycleProjectionBatchInTransaction(client);
  assert.equal(filledDirect.created, 1);
  const reopenedDirectHandoff = await captureTelegramBotTradingCallback({
    appBaseUrl: "https://app.hunch.trade",
    callbackQuery: {
      data: `hbt:retry_buy:${directLifecycleIntentId}`,
      from: { id: telegramUserId as never },
      id: `reopen-direct-handoff-${suffix}`,
      message: {
        chat: { id: telegramUserId, type: "private" },
        message_id: 701,
      },
    },
    db,
    signerInspector,
    trading,
  });
  assert.equal(reopenedDirectHandoff.lifecycleOwnsTerminalDelivery, false);
  assert.match(
    reopenedDirectHandoff.answers[0]?.text ?? "",
    /Opening a fresh market card/u,
  );
  assert.ok(
    reopenedDirectHandoff.messages.at(-1),
    "a terminal retry_buy compatibility button must still render its market navigation",
  );
  const unchangedDirect =
    await runTelegramTradeLifecycleProjectionBatchInTransaction(client);
  assert.equal(unchangedDirect.created, 0);
  const directRevisionBeforeWatermarkBackfill = Number(
    (
      await client.query<{ revision: string }>(
        `update telegram_trade_intents
            set result = result - 'shortfallProgressSourceWatermark'
          where id = $1::uuid
          returning result ->> 'shortfallProgressRevision' as revision`,
        [directLifecycleIntentId],
      )
    ).rows[0]?.revision,
  );
  assert.equal(
    (
      await telegramTradeLifecycleProgressTestHooks.listCandidateIds(client)
    ).includes(directLifecycleIntentId),
    true,
    "a legacy projection without a source watermark is selected once",
  );
  await runTelegramTradeLifecycleProjectionBatchInTransaction(client, {
    limit: 100,
  });
  assert.equal(
    Number(
      (
        await client.query<{ revision: string }>(
          `select result ->> 'shortfallProgressRevision' as revision
             from telegram_trade_intents
            where id = $1::uuid`,
          [directLifecycleIntentId],
        )
      ).rows[0]?.revision,
    ),
    directRevisionBeforeWatermarkBackfill,
    "watermark backfill does not create a duplicate lifecycle revision",
  );
  assert.equal(
    (
      await telegramTradeLifecycleProgressTestHooks.listCandidateIds(client)
    ).includes(directLifecycleIntentId),
    false,
    "the backfilled legacy projection stays out of later candidate batches",
  );
  await client.query(
    `update telegram_trade_intents
        set result = jsonb_set(
              result,
              '{shortfallProgressSourceWatermark,projectionVersion}',
              '5'::jsonb
            )
      where id = $1::uuid`,
    [directLifecycleIntentId],
  );
  assert.equal(
    (
      await telegramTradeLifecycleProgressTestHooks.listCandidateIds(client)
    ).includes(directLifecycleIntentId),
    true,
    "a stale projector version invalidates the source watermark",
  );
  await runTelegramTradeLifecycleProjectionBatchInTransaction(client, {
    limit: 100,
  });
  assert.deepEqual(
    (
      await client.query<{
        projection_version: string;
        revision: string;
      }>(
        `select result #>> '{shortfallProgressSourceWatermark,projectionVersion}'
                  as projection_version,
                result ->> 'shortfallProgressRevision' as revision
           from telegram_trade_intents
          where id = $1::uuid`,
        [directLifecycleIntentId],
      )
    ).rows[0],
    {
      projection_version: "7",
      revision: String(directRevisionBeforeWatermarkBackfill),
    },
    "projector invalidation refreshes only the watermark when rendering is unchanged",
  );
  assert.equal(
    (
      await telegramTradeLifecycleProgressTestHooks.listCandidateIds(client)
    ).includes(directLifecycleIntentId),
    false,
    "the current projector version settles after one pass",
  );
  const directLifecycleOutbox = await client.query<{
    revision: number;
    state: string;
    status: string;
  }>(
    `select outbox.state_revision as revision,
            outbox.payload ->> 'state' as state,
            outbox.status
       from telegram_bot_action_outbox outbox
      where outbox.trade_intent_id = $1::uuid
        and outbox.action = 'trade_funding_edit'
      order by outbox.state_revision`,
    [directLifecycleIntentId],
  );
  assert.deepEqual(directLifecycleOutbox.rows, [
    { revision: 1, state: "awaiting_client", status: "dead" },
    { revision: 2, state: "submitting_trade", status: "dead" },
    { revision: 3, state: "filled", status: "pending" },
  ]);
  const pendingTerminalOutbox = await client.query<{
    delivery_attempt_id: string;
    id: string;
  }>(
    `update telegram_bot_action_outbox
        set status = 'sending',
            delivery_attempt_id = gen_random_uuid(),
            delivery_started_at = clock_timestamp() - interval '30 seconds'
      where trade_intent_id = $1::uuid
        and state_revision = 3
      returning id::text, delivery_attempt_id::text`,
    [directLifecycleIntentId],
  );
  let pendingTerminalRow = pendingTerminalOutbox.rows[0];
  assert.ok(pendingTerminalRow);
  assert.equal(
    await telegramTradeLifecycleProgressTestHooks.recoverStaleTelegramTradeLifecycleDeliveries(
      { pool: client },
    ),
    1,
    "a crashed lifecycle edit must be quarantined at its unknown Telegram boundary",
  );
  assert.deepEqual(
    (
      await client.query<{
        delivery_attempt_id: string | null;
        delivery_started_at: Date | null;
        last_error: string | null;
        status: string;
      }>(
        `select status, delivery_attempt_id::text, delivery_started_at,
                last_error
           from telegram_bot_action_outbox
          where id = $1::uuid`,
        [pendingTerminalRow.id],
      )
    ).rows[0],
    {
      delivery_attempt_id: null,
      delivery_started_at: null,
      last_error: "telegram_trade_lifecycle_edit_delivery_unknown",
      status: "dead",
    },
  );
  pendingTerminalRow = (
    await client.query<{
      delivery_attempt_id: string;
      id: string;
    }>(
      `update telegram_bot_action_outbox
          set status = 'sending',
              delivery_attempt_id = gen_random_uuid(),
              delivery_started_at = clock_timestamp()
        where id = $1::uuid
        returning id::text, delivery_attempt_id::text`,
      [pendingTerminalRow.id],
    )
  ).rows[0];
  assert.ok(pendingTerminalRow);
  await telegramTradeLifecycleProgressTestHooks.markTelegramTradeLifecycleDelivered(
    {
      delivery: "edit",
      deliveryAttemptId: pendingTerminalRow.delivery_attempt_id,
      messageId: 701,
      outboxId: pendingTerminalRow.id,
      pool: client,
      sourceMessageId: 701,
      terminalFill: true,
    },
  );
  assert.equal(
    telegramTradeLifecycleProgressTestHooks.telegramLifecycleEditSucceeded({
      ok: false,
    }),
    false,
    "a resolved Telegram API error must not be marked delivered",
  );
  assert.deepEqual(
    telegramTradeLifecycleProgressTestHooks.resolveTelegramLifecycleEditFailure(
      {
        error: "message_not_editable",
        message: "message to edit not found",
        ok: false,
      },
      1,
    ),
    {
      code: "message_not_editable",
      disposition: "dead",
      retryAfterSec: 3,
    },
    "a deleted lifecycle card must not retry forever",
  );
  assert.deepEqual(
    telegramTradeLifecycleProgressTestHooks.resolveTelegramLifecycleEditFailure(
      { error: "ambiguous", message: "timeout", ok: false },
      1,
    ),
    { code: "ambiguous", disposition: "dead", retryAfterSec: 3 },
    "an ambiguous edit crosses an unknowable delivery boundary and must not overwrite a newer card",
  );
  assert.deepEqual(
    telegramTradeLifecycleProgressTestHooks.resolveTelegramLifecycleEditFailure(
      { error: "ambiguous", message: "timeout", ok: false },
      5,
    ),
    { code: "ambiguous", disposition: "dead", retryAfterSec: 3 },
    "ambiguous lifecycle edits remain terminal at the old retry ceiling",
  );
  assert.deepEqual(
    telegramTradeLifecycleProgressTestHooks.resolveTelegramLifecycleEditFailure(
      {
        error: "other",
        message: "Too Many Requests",
        ok: false,
        retryAfterSec: 600,
      },
      1,
    ),
    { code: "other", disposition: "retry", retryAfterSec: 600 },
    "Telegram retry_after must never be shortened into the provider's 429 window",
  );
  assert.deepEqual(
    (
      await client.query<{
        delivery: string | null;
        delivered_at: string | null;
        intent_status: string | null;
        message_id: string | null;
        outbox_status: string;
      }>(
        `select intent_row.result #>> '{telegramReceipt,delivery}' as delivery,
                intent_row.result #>> '{telegramReceipt,deliveredAt}' as delivered_at,
                intent_row.result #>> '{telegramReceipt,intentStatus}' as intent_status,
                intent_row.result #>> '{telegramReceipt,messageId}' as message_id,
                outbox.status as outbox_status
           from telegram_trade_intents intent_row
           join telegram_bot_action_outbox outbox
             on outbox.trade_intent_id = intent_row.id
            and outbox.state_revision = 3
          where intent_row.id = $1::uuid`,
        [directLifecycleIntentId],
      )
    ).rows.map((row) => ({
      delivery: row.delivery,
      hasDeliveredAt: row.delivered_at != null,
      intentStatus: row.intent_status,
      messageId: row.message_id,
      outboxStatus: row.outbox_status,
    })),
    [
      {
        delivery: "edit",
        hasDeliveredAt: true,
        intentStatus: "filled",
        messageId: "701",
        outboxStatus: "sent",
      },
    ],
    "a filled lifecycle edit must suppress the later generic Order filled notification",
  );
  await client.query(
    `update telegram_bot_action_outbox
        set status = 'retry',
            attempt_count = 1,
            last_error = 'telegram_trade_lifecycle_edit_failed:ambiguous',
            delivery_attempt_id = null,
            delivery_started_at = null
      where id = $1::uuid`,
    [pendingTerminalRow.id],
  );
  assert.equal(
    await telegramTradeLifecycleProgressTestHooks.recoverStaleTelegramTradeLifecycleDeliveries(
      { pool: client },
    ),
    1,
    "a retry row created by an older ambiguous-delivery worker must be quarantined",
  );
  assert.deepEqual(
    (
      await client.query<{ last_error: string | null; status: string }>(
        `select status, last_error
           from telegram_bot_action_outbox
          where id = $1::uuid`,
        [pendingTerminalRow.id],
      )
    ).rows[0],
    {
      last_error: "telegram_trade_lifecycle_edit_delivery_unknown",
      status: "dead",
    },
  );
  await client.query(
    `update telegram_bot_action_outbox
        set status = 'retry',
            attempt_count = 1,
            last_error = 'telegram_trade_lifecycle_stale_sending_retry'
      where id = $1::uuid`,
    [pendingTerminalRow.id],
  );
  assert.equal(
    await telegramTradeLifecycleProgressTestHooks.recoverStaleTelegramTradeLifecycleDeliveries(
      { pool: client },
    ),
    1,
    "the deployed stale-sending retry marker must retain its unknown delivery boundary",
  );
  assert.deepEqual(
    (
      await client.query<{ last_error: string | null; status: string }>(
        `select status, last_error
           from telegram_bot_action_outbox
          where id = $1::uuid`,
        [pendingTerminalRow.id],
      )
    ).rows[0],
    {
      last_error: "telegram_trade_lifecycle_edit_delivery_unknown",
      status: "dead",
    },
  );
  await client.query(
    `update telegram_bot_action_outbox
        set status = 'retry',
            attempt_count = 0,
            last_error = 'Historical lifecycle delivery needs receipt verification.'
      where id = $1::uuid`,
    [pendingTerminalRow.id],
  );
  assert.equal(
    await telegramTradeLifecycleProgressTestHooks.recoverStaleTelegramTradeLifecycleDeliveries(
      { pool: client },
    ),
    1,
    "a deployed historical rearm marker must restore its already-sent evidence",
  );
  assert.deepEqual(
    (
      await client.query<{ last_error: string | null; status: string }>(
        `select status, last_error
           from telegram_bot_action_outbox
          where id = $1::uuid`,
        [pendingTerminalRow.id],
      )
    ).rows[0],
    {
      last_error: "telegram_trade_lifecycle_historical_sent_restored",
      status: "sent",
    },
  );
  await client.query(
    `update telegram_bot_action_outbox
        set status = 'sending',
            attempt_count = 5,
            delivery_attempt_id = gen_random_uuid(),
            delivery_started_at = clock_timestamp() - interval '30 seconds'
      where id = $1::uuid`,
    [pendingTerminalRow.id],
  );
  assert.equal(
    await telegramTradeLifecycleProgressTestHooks.recoverStaleTelegramTradeLifecycleDeliveries(
      { pool: client },
    ),
    1,
    "a crashed lifecycle edit at the attempt limit must be recovered terminally",
  );
  assert.deepEqual(
    (
      await client.query<{
        last_error: string | null;
        status: string;
      }>(
        `select status, last_error
           from telegram_bot_action_outbox
          where id = $1::uuid`,
        [pendingTerminalRow.id],
      )
    ).rows[0],
    {
      last_error: "telegram_trade_lifecycle_edit_delivery_unknown",
      status: "dead",
    },
    "a stale terminal claim at the attempt limit has an unknown delivery boundary",
  );
  await client.query(
    `update telegram_bot_action_outbox
        set status = 'retry',
            last_error = null,
            delivery_attempt_id = null,
            delivery_started_at = null
      where id = $1::uuid`,
    [pendingTerminalRow.id],
  );
  assert.equal(
    await telegramTradeLifecycleProgressTestHooks.recoverStaleTelegramTradeLifecycleDeliveries(
      { pool: client },
    ),
    1,
    "an exhausted retry row from an older worker must be quarantined before claim",
  );
  assert.deepEqual(
    (
      await client.query<{
        last_error: string | null;
        status: string;
      }>(
        `select status, last_error
           from telegram_bot_action_outbox
          where id = $1::uuid`,
        [pendingTerminalRow.id],
      )
    ).rows[0],
    {
      last_error: "telegram_trade_lifecycle_edit_attempts_exhausted",
      status: "dead",
    },
  );

  const genericFillNotificationId = (
    await client.query<{ id: string }>(
      `insert into telegram_notification_outbox (
         user_id, event_key, topic, event_occurred_at, payload, status
       ) values (
         $1::uuid, $2::text, 'order_filled', now() - interval '1 minute',
         jsonb_build_object(
           'type', 'order_filled',
           'data', jsonb_build_object(
             'source', 'telegram_bot',
             'sourceIntentId', $3::text,
             'venue', 'polymarket',
             'orderId', 'direct-lifecycle-order'
           )
         ),
         'sending'
       )
       returning id::text`,
      [
        userId,
        `terminal-delivery-ownership:${suffix}`,
        directLifecycleIntentId,
      ],
    )
  ).rows[0]?.id;
  assert.ok(genericFillNotificationId);

  await client.query(
    `update telegram_trade_intents
        set status = 'submitted', updated_at = clock_timestamp()
      where id = $1::uuid`,
    [directLifecycleIntentId],
  );
  assert.equal(
    await telegramNotificationDeliveryTestHooks.resolveTelegramOrderFilledDeliveryOwnership(
      {
        db: client,
        outboxId: genericFillNotificationId,
        payload: {
          data: {
            orderId: "direct-lifecycle-order",
            source: "telegram_bot",
            sourceIntentId: directLifecycleIntentId,
            venue: "polymarket",
          },
        },
        userId,
      },
    ),
    "deferred_to_lifecycle",
    "an exact fill notification cannot bypass lifecycle ownership before intent finalization",
  );
  assert.equal(
    (
      await client.query<{ status: string }>(
        `select status
           from telegram_notification_outbox
          where id = $1::uuid`,
        [genericFillNotificationId],
      )
    ).rows[0]?.status,
    "retry",
  );
  await client.query(
    `update telegram_trade_intents
        set status = 'filled', updated_at = clock_timestamp()
      where id = $1::uuid`,
    [directLifecycleIntentId],
  );
  await client.query(
    `update telegram_notification_outbox
        set status = 'sending', attempt_count = 1
      where id = $1::uuid`,
    [genericFillNotificationId],
  );
  assert.equal(
    await telegramNotificationDeliveryTestHooks.resolveTelegramOrderFilledDeliveryOwnership(
      {
        db: client,
        outboxId: genericFillNotificationId,
        payload: {
          data: {
            orderId: "direct-lifecycle-order",
            source: "telegram_bot",
            sourceIntentId: directLifecycleIntentId,
            venue: "polymarket",
          },
        },
        userId,
      },
    ),
    "skipped_for_lifecycle",
    "a durable lifecycle receipt owns terminal delivery",
  );
  assert.equal(
    (
      await client.query<{ status: string }>(
        `select status
           from telegram_notification_outbox
          where id = $1::uuid`,
        [genericFillNotificationId],
      )
    ).rows[0]?.status,
    "skipped",
  );

  await client.query(
    `update telegram_trade_intents
        set result = (result - 'telegramReceipt') || jsonb_build_object(
              'telegramReceipt',
              jsonb_build_object(
                'deliveredAt', clock_timestamp(),
                'delivery', 'edit',
                'messageId', 701
              )
            )
      where id = $1::uuid`,
    [directLifecycleIntentId],
  );
  await client.query(
    `update telegram_bot_action_outbox
        set status = 'sent',
            attempt_count = 5,
            payload = jsonb_set(payload, '{state}', '"confirming_trade"'::jsonb)
      where id = $1::uuid`,
    [pendingTerminalRow.id],
  );
  await client.query(
    `update telegram_notification_outbox
        set status = 'sending', attempt_count = 1
      where id = $1::uuid`,
    [genericFillNotificationId],
  );
  assert.equal(
    await telegramNotificationDeliveryTestHooks.resolveTelegramOrderFilledDeliveryOwnership(
      {
        db: client,
        outboxId: genericFillNotificationId,
        payload: {
          data: {
            orderId: "direct-lifecycle-order",
            source: "telegram_bot",
            sourceIntentId: directLifecycleIntentId,
            venue: "polymarket",
          },
        },
        userId,
      },
    ),
    "deferred_to_lifecycle",
    "a delivered nonterminal card cannot suppress the later terminal fill",
  );
  assert.deepEqual(
    (
      await client.query<{ attempt_count: number; status: string }>(
        `select status, attempt_count
           from telegram_bot_action_outbox
          where id = $1::uuid`,
        [pendingTerminalRow.id],
      )
    ).rows[0],
    { attempt_count: 5, status: "sent" },
    "delivery ownership inspection must not rearm a historical edit",
  );
  await client.query(
    `update telegram_bot_action_outbox
        set payload = jsonb_set(payload, '{state}', '"filled"'::jsonb)
      where id = $1::uuid`,
    [pendingTerminalRow.id],
  );
  await client.query(
    `update telegram_notification_outbox
        set status = 'sending', attempt_count = 1
      where id = $1::uuid`,
    [genericFillNotificationId],
  );
  assert.equal(
    await telegramNotificationDeliveryTestHooks.resolveTelegramOrderFilledDeliveryOwnership(
      {
        db: client,
        outboxId: genericFillNotificationId,
        payload: {
          data: {
            orderId: "direct-lifecycle-order",
            source: "telegram_bot",
            sourceIntentId: directLifecycleIntentId,
            venue: "polymarket",
          },
        },
        userId,
      },
    ),
    "skipped_for_lifecycle",
    "a sent filled payload is durable proof of terminal lifecycle delivery",
  );
  assert.equal(
    (
      await client.query<{ status: string }>(
        `select status
           from telegram_notification_outbox
          where id = $1::uuid`,
        [genericFillNotificationId],
      )
    ).rows[0]?.status,
    "skipped",
  );
  await client.query(
    `update telegram_bot_action_outbox
        set status = 'retry',
            attempt_count = 1,
            next_attempt_at = clock_timestamp() + interval '10 minutes'
      where id = $1::uuid`,
    [pendingTerminalRow.id],
  );
  await client.query(
    `update telegram_notification_outbox
        set status = 'sending', attempt_count = 1
      where id = $1::uuid`,
    [genericFillNotificationId],
  );
  assert.equal(
    await telegramNotificationDeliveryTestHooks.resolveTelegramOrderFilledDeliveryOwnership(
      {
        db: client,
        outboxId: genericFillNotificationId,
        payload: {
          data: {
            orderId: "direct-lifecycle-order",
            source: "telegram_bot",
            sourceIntentId: directLifecycleIntentId,
            venue: "polymarket",
          },
        },
        userId,
      },
    ),
    "deferred_to_lifecycle",
    "a provider retry_after on the lifecycle edit must defer the generic fill instead of duplicating it",
  );
  const deferredGenericFill = (
    await client.query<{
      attempt_count: number;
      delayed: boolean;
      status: string;
    }>(
      `select status,
              attempt_count,
              next_attempt_at >= clock_timestamp() + interval '9 minutes'
                as delayed
         from telegram_notification_outbox
        where id = $1::uuid`,
      [genericFillNotificationId],
    )
  ).rows[0];
  assert.deepEqual(deferredGenericFill, {
    attempt_count: 0,
    delayed: true,
    status: "retry",
  });

  await client.query(
    `update telegram_bot_action_outbox
        set status = 'dead',
            last_error = 'telegram_trade_lifecycle_edit_terminal:ambiguous'
      where id = $1::uuid`,
    [pendingTerminalRow.id],
  );
  await client.query(
    `update telegram_notification_outbox
        set status = 'sending', attempt_count = 1
      where id = $1::uuid`,
    [genericFillNotificationId],
  );
  assert.equal(
    await telegramNotificationDeliveryTestHooks.resolveTelegramOrderFilledDeliveryOwnership(
      {
        db: client,
        outboxId: genericFillNotificationId,
        payload: {
          data: {
            orderId: "direct-lifecycle-order",
            source: "telegram_bot",
            sourceIntentId: directLifecycleIntentId,
            venue: "polymarket",
          },
        },
        userId,
      },
    ),
    "lifecycle_delivery_unknown",
    "an ambiguously exhausted terminal edit must never create a duplicate generic fill",
  );
  assert.equal(
    (
      await client.query<{ status: string }>(
        `select status
           from telegram_notification_outbox
          where id = $1::uuid`,
        [genericFillNotificationId],
      )
    ).rows[0]?.status,
    "delivery_unknown",
  );
  assert.equal(
    (
      await client.query<{ owner: string | null }>(
        `select result ->> 'telegramTerminalDeliveryOwner' as owner
           from telegram_trade_intents
          where id = $1::uuid`,
        [directLifecycleIntentId],
      )
    ).rows[0]?.owner,
    null,
    "an unknown delivery boundary must not assign generic ownership",
  );

  await client.query(
    `update telegram_trade_intents
        set result = result - 'telegramReceipt',
            updated_at = clock_timestamp()
      where id = $1::uuid`,
    [directLifecycleIntentId],
  );
  await client.query(
    `update telegram_bot_action_outbox
        set last_error = 'telegram_trade_lifecycle_edit_terminal:message_not_editable'
      where id = $1::uuid`,
    [pendingTerminalRow.id],
  );
  await client.query(
    `update telegram_notification_outbox
        set status = 'sending', attempt_count = 1
      where id = $1::uuid`,
    [genericFillNotificationId],
  );
  assert.equal(
    await telegramNotificationDeliveryTestHooks.resolveTelegramOrderFilledDeliveryOwnership(
      {
        db: client,
        outboxId: genericFillNotificationId,
        payload: {
          data: {
            orderId: "direct-lifecycle-order",
            source: "telegram_bot",
            sourceIntentId: directLifecycleIntentId,
            venue: "polymarket",
          },
        },
        userId,
      },
    ),
    "generic_fallback",
    "a definitively undeliverable lifecycle edit must hand terminal delivery to the standalone notification",
  );
  assert.equal(
    (
      await client.query<{ owner: string | null }>(
        `select result ->> 'telegramTerminalDeliveryOwner' as owner
           from telegram_trade_intents
          where id = $1::uuid`,
        [directLifecycleIntentId],
      )
    ).rows[0]?.owner,
    "generic_notification",
  );
  await client.query(
    `update telegram_trade_intents
        set venue_order_id = 'generic-owner-order', updated_at = clock_timestamp()
      where id = $1::uuid`,
    [directLifecycleIntentId],
  );
  assert.equal(
    (
      await runTelegramTradeLifecycleProjectionBatchInTransaction(client, {
        limit: 100,
      })
    ).created,
    0,
    "a generic-owned terminal intent must never recreate a lifecycle edit",
  );

  const backloggedLifecycleIntentId = (
    await client.query<{ id: string }>(
      `insert into telegram_trade_intents (
         telegram_user_id, user_id, authorization_id, chat_id,
         telegram_message_id, action, venue, market_id, event_id, side,
         amount_usd, status, venue_order_id, expires_at, idempotency_key,
         delivery_mode, result
       ) values (
         $1, $2::uuid, $3::uuid, $1, '705', 'buy', 'polymarket', $4, $5,
         'YES', 1, 'filled', 'backlogged-lifecycle-order',
         now() + interval '2 minutes', $6, 'app_handoff',
         jsonb_build_object(
           'appHandoffExecution',
           jsonb_build_object('version', 2, 'committedAt', now()::text)
         )
       ) returning id::text`,
      [
        telegramUserId,
        userId,
        authorization.id,
        marketId,
        eventId,
        `backlogged-lifecycle:${suffix}`,
      ],
    )
  ).rows[0]?.id;
  assert.ok(backloggedLifecycleIntentId);
  const backloggedNotificationId = (
    await client.query<{ id: string }>(
      `insert into telegram_notification_outbox (
         user_id, event_key, topic, event_occurred_at, payload, status
       ) values (
         $1::uuid, $2, 'order_filled', now() - interval '1 minute',
         jsonb_build_object(
           'type', 'order_filled',
           'data', jsonb_build_object(
             'source', 'telegram_bot',
             'sourceIntentId', $3::text,
             'venue', 'polymarket',
             'orderId', 'backlogged-lifecycle-order'
           )
         ),
         'sending'
       ) returning id::text`,
      [
        userId,
        `backlogged-terminal-delivery:${suffix}`,
        backloggedLifecycleIntentId,
      ],
    )
  ).rows[0]?.id;
  assert.ok(backloggedNotificationId);
  assert.equal(
    await telegramNotificationDeliveryTestHooks.resolveTelegramOrderFilledDeliveryOwnership(
      {
        db: client,
        outboxId: backloggedNotificationId,
        payload: {
          data: {
            orderId: "backlogged-lifecycle-order",
            source: "telegram_bot",
            sourceIntentId: backloggedLifecycleIntentId,
            venue: "polymarket",
          },
        },
        userId,
      },
    ),
    "deferred_to_lifecycle",
    "projector backlog must not let the generic notification steal lifecycle ownership",
  );
  assert.equal(
    (
      await client.query<{ owner: string | null }>(
        `select result ->> 'telegramTerminalDeliveryOwner' as owner
           from telegram_trade_intents
          where id = $1::uuid`,
        [backloggedLifecycleIntentId],
      )
    ).rows[0]?.owner,
    null,
  );
  assert.equal(
    (
      await runTelegramTradeLifecycleProjectionBatchInTransaction(client, {
        limit: 100,
      })
    ).created,
    1,
    "the normal projector remains authoritative after a generic notification defers",
  );
  await client.query(
    `delete from telegram_notification_outbox where id = $1::uuid`,
    [backloggedNotificationId],
  );
  await client.query(`delete from telegram_trade_intents where id = $1::uuid`, [
    backloggedLifecycleIntentId,
  ]);

  const submittedReceiptIntentId = (
    await client.query<{ id: string }>(
      `insert into telegram_trade_intents (
         telegram_user_id, user_id, authorization_id, chat_id,
         telegram_message_id, action, venue, market_id, event_id, side,
         amount_usd, status, venue_order_id, expires_at, idempotency_key,
         delivery_mode, result
       ) values (
         $1, $2::uuid, $3::uuid, $1, '706', 'buy', 'polymarket', $4, $5,
         'YES', 1, 'filled', 'submitted-receipt-order',
         now() + interval '2 minutes', $6, 'bot_submit',
         jsonb_build_object(
           'telegramReceipt', jsonb_build_object(
             'deliveredAt', now()::text,
             'delivery', 'edit',
             'messageId', 706,
             'intentStatus', 'submitted'
           )
         )
       ) returning id::text`,
      [
        telegramUserId,
        userId,
        authorization.id,
        marketId,
        eventId,
        `submitted-receipt:${suffix}`,
      ],
    )
  ).rows[0]?.id;
  assert.ok(submittedReceiptIntentId);
  const submittedReceiptNotificationId = (
    await client.query<{ id: string }>(
      `insert into telegram_notification_outbox (
         user_id, event_key, topic, event_occurred_at, payload, status
       ) values (
         $1::uuid, $2, 'order_filled', now() - interval '1 minute',
         jsonb_build_object(
           'type', 'order_filled',
           'data', jsonb_build_object(
             'source', 'telegram_bot',
             'sourceIntentId', $3::text,
             'venue', 'polymarket',
             'orderId', 'submitted-receipt-order'
           )
         ),
         'sending'
       ) returning id::text`,
      [
        userId,
        `submitted-receipt-terminal:${suffix}`,
        submittedReceiptIntentId,
      ],
    )
  ).rows[0]?.id;
  assert.ok(submittedReceiptNotificationId);
  assert.equal(
    await telegramNotificationDeliveryTestHooks.resolveTelegramOrderFilledDeliveryOwnership(
      {
        db: client,
        outboxId: submittedReceiptNotificationId,
        payload: {
          data: {
            orderId: "submitted-receipt-order",
            source: "telegram_bot",
            sourceIntentId: submittedReceiptIntentId,
            venue: "polymarket",
          },
        },
        userId,
      },
    ),
    "generic_fallback",
    "a submitted-card receipt must not suppress the later terminal fill",
  );
  await client.query(
    `update telegram_trade_intents
        set result = jsonb_build_object(
              'telegramReceipt',
              jsonb_build_object(
                'deliveredAt', now()::text,
                'delivery', 'edit',
                'messageId', 706
              )
            ),
            updated_at = clock_timestamp()
      where id = $1::uuid`,
    [submittedReceiptIntentId],
  );
  await client.query(
    `update telegram_notification_outbox
        set status = 'sending', attempt_count = 1
      where id = $1::uuid`,
    [submittedReceiptNotificationId],
  );
  assert.equal(
    await telegramNotificationDeliveryTestHooks.resolveTelegramOrderFilledDeliveryOwnership(
      {
        db: client,
        outboxId: submittedReceiptNotificationId,
        payload: {
          data: {
            orderId: "submitted-receipt-order",
            source: "telegram_bot",
            sourceIntentId: submittedReceiptIntentId,
            venue: "polymarket",
          },
        },
        userId,
      },
    ),
    "lifecycle_delivery_unknown",
    "a legacy status-less receipt cannot prove that a terminal fill was or was not delivered",
  );
  assert.equal(
    (
      await client.query<{ status: string }>(
        `select status
           from telegram_notification_outbox
          where id = $1::uuid`,
        [submittedReceiptNotificationId],
      )
    ).rows[0]?.status,
    "delivery_unknown",
  );
  await client.query(
    `delete from telegram_notification_outbox where id = $1::uuid`,
    [submittedReceiptNotificationId],
  );
  await client.query(`delete from telegram_trade_intents where id = $1::uuid`, [
    submittedReceiptIntentId,
  ]);

  const routeReceiptIntentId = (
    await client.query<{ id: string }>(
      `insert into telegram_trade_intents (
         telegram_user_id, user_id, authorization_id, action, venue,
         market_id, event_id, side, amount_usd, status, venue_order_id,
         expires_at, idempotency_key, delivery_mode
       ) values (
         $1, $2::uuid, $3::uuid, 'buy', 'polymarket', $4, $5, 'YES', 1,
         'filled', 'route-receipt-order', now() + interval '2 minutes', $6,
         'bot_submit'
       ) returning id::text`,
      [
        telegramUserId,
        userId,
        authorization.id,
        marketId,
        eventId,
        `route-receipt:${suffix}`,
      ],
    )
  ).rows[0]?.id;
  assert.ok(routeReceiptIntentId);
  const recordedTerminalReceipt = await app.inject({
    method: "POST",
    payload: {
      delivery: "edit",
      messageId: 707,
      telegramUserId,
    },
    url: `/internal/telegram-bot/trading/intents/${routeReceiptIntentId}/receipt`,
  });
  assert.equal(recordedTerminalReceipt.statusCode, 200);
  assert.equal(recordedTerminalReceipt.json().marked, true);
  assert.equal(
    (
      await client.query<{ intent_status: string | null }>(
        `select result #>> '{telegramReceipt,intentStatus}' as intent_status
           from telegram_trade_intents
          where id = $1::uuid`,
        [routeReceiptIntentId],
      )
    ).rows[0]?.intent_status,
    "filled",
    "the receipt endpoint records the status of the card it actually delivered",
  );
  await client.query(`delete from telegram_trade_intents where id = $1::uuid`, [
    routeReceiptIntentId,
  ]);

  // More than one bounded batch of old, unchanged projections must not starve
  // a newly confirmed Mini App Sell. Production accumulated terminal funding
  // rows here and the old oldest-first ordering never reached the live card.
  const projectedDirect = await client.query<{
    progress: Record<string, unknown>;
  }>(
    `select result -> 'shortfallProgress' as progress
       from telegram_trade_intents
      where id = $1::uuid`,
    [directLifecycleIntentId],
  );
  const blockerIds: string[] = [];
  for (let index = 0; index < 30; index += 1) {
    const blockerId = crypto.randomUUID();
    blockerIds.push(blockerId);
    const blockerProgress = {
      ...projectedDirect.rows[0]?.progress,
      intentId: blockerId,
      venueOrderId: `historical-order-${index}`,
    };
    await client.query(
      `insert into telegram_trade_intents (
         id, telegram_user_id, user_id, authorization_id, chat_id,
         telegram_message_id, action, venue, market_id, event_id, side,
         amount_usd, status, venue_order_id, expires_at, idempotency_key,
         delivery_mode, result, updated_at
       ) values (
         $1::uuid, $2, $3::uuid, $4::uuid, $2, '703', 'buy',
         'polymarket', $5, $6, 'YES', 1, 'filled', $7,
         now() + interval '2 minutes', $8, 'app_handoff',
         jsonb_build_object(
           'appHandoffExecution', jsonb_build_object(
             'committedAt', now()::text,
             'kind', 'direct_trade',
             'version', 2
           ),
           'shortfallProgress', $9::jsonb,
           'shortfallProgressRevision', 1
         ),
         now() - interval '1 day'
       )`,
      [
        blockerId,
        telegramUserId,
        userId,
        authorization.id,
        marketId,
        eventId,
        `historical-order-${index}`,
        `historical-lifecycle:${index}:${suffix}`,
        JSON.stringify(blockerProgress),
      ],
    );
  }
  const liveSellIntentId = crypto.randomUUID();
  await client.query(
    `insert into telegram_trade_intents (
       id, telegram_user_id, user_id, authorization_id, chat_id,
       telegram_message_id, action, venue, market_id, event_id, side,
       shares_raw, status, expires_at, idempotency_key, delivery_mode, result
     ) values (
       $1::uuid, $2, $3::uuid, $4::uuid, $2, '704', 'sell',
       'polymarket', $5, $6, 'YES', '1000000', 'external_handoff',
       now() + interval '2 minutes', $7, 'app_handoff',
       jsonb_build_object(
         'appHandoffExecution', jsonb_build_object(
           'committedAt', now()::text,
           'kind', 'direct_trade',
           'version', 2
         )
       )
     )`,
    [
      liveSellIntentId,
      telegramUserId,
      userId,
      authorization.id,
      marketId,
      eventId,
      `live-sell-lifecycle:${suffix}`,
    ],
  );
  await runTelegramTradeLifecycleProjectionBatchInTransaction(client, {
    limit: 25,
  });
  assert.deepEqual(
    (
      await client.query<{ action: string; state: string }>(
        `select result -> 'shortfallProgress' ->> 'action' as action,
                result -> 'shortfallProgress' ->> 'state' as state
           from telegram_trade_intents
          where id = $1::uuid`,
        [liveSellIntentId],
      )
    ).rows[0],
    { action: "sell", state: "awaiting_client" },
    "a live Mini App Sell must be projected despite a full batch of unchanged historical cards",
  );
  assert.deepEqual(
    (
      await client.query<{
        action: string;
        payload_state: string;
        state_revision: number;
      }>(
        `select action,
                state_revision,
                payload ->> 'state' as payload_state
           from telegram_bot_action_outbox
          where trade_intent_id = $1::uuid
          order by state_revision`,
        [liveSellIntentId],
      )
    ).rows,
    [
      {
        action: "trade_funding_edit",
        payload_state: "awaiting_client",
        state_revision: 1,
      },
    ],
    "the live Sell projection must enqueue the source-card edit",
  );
  await client.query(
    `delete from telegram_trade_intents
      where id = any($1::uuid[])`,
    [[...blockerIds, liveSellIntentId]],
  );

  const staleHandoffIntent = await client.query<{ id: string }>(
    `insert into telegram_trade_intents (
       telegram_user_id, user_id, authorization_id, chat_id,
       telegram_message_id, action, venue, market_id, event_id, side,
       amount_usd, status, expires_at, idempotency_key, delivery_mode, result
     ) values (
       $1, $2, $3, $1, '702', 'buy', 'polymarket', $4, $5, 'YES',
       1, 'external_handoff', now() - interval '10 minutes', $6, 'app_handoff',
       jsonb_build_object(
         'appHandoffV2',
         jsonb_build_object('version', 2, 'plan', jsonb_build_object())
       )
     ) returning id`,
    [
      telegramUserId,
      userId,
      authorization.id,
      marketId,
      eventId,
      `stale-direct-handoff:${suffix}`,
    ],
  );
  const staleHandoffIntentId = staleHandoffIntent.rows[0]?.id;
  assert.ok(staleHandoffIntentId);
  const staleTokenHash = crypto
    .createHash("sha256")
    .update(`stale-direct-handoff-token:${suffix}`)
    .digest("hex");
  await client.query(
    `insert into telegram_app_handoffs (
       trade_intent_id, user_id, telegram_user_id, token_hash, state,
       plan_fingerprint, policy_revision, authority_fingerprint,
       quote_snapshot, plan_snapshot, issued_at, expires_at,
       claimed_at, claimed_by_user_id
     ) values (
       $1::uuid, $2::uuid, $3, $4, 'claimed', repeat('a', 64),
       'stale-handoff-policy', repeat('b', 64), '{}'::jsonb, '{}'::jsonb,
       now() - interval '20 minutes', now() - interval '10 minutes',
       now() - interval '15 minutes', $2::uuid
     )`,
    [staleHandoffIntentId, userId, telegramUserId, staleTokenHash],
  );
  await reconcileStaleTelegramTradeIntents(client, {
    now: new Date(),
    telegramUserId,
  });
  assert.deepEqual(
    (
      await client.query<{
        handoff_state: string;
        intent_status: string;
      }>(
        `select handoff_row.state as handoff_state,
                intent_row.status as intent_status
           from telegram_trade_intents intent_row
           join telegram_app_handoffs handoff_row
             on handoff_row.trade_intent_id = intent_row.id
          where intent_row.id = $1::uuid
          limit 1`,
        [staleHandoffIntentId],
      )
    ).rows[0],
    {
      handoff_state: "expired",
      intent_status: "expired",
    },
  );
  // This fixture proves abandoned-handoff expiry only. Remove it before the
  // later lifecycle projector assertion, which intentionally counts a single
  // unrelated terminal-funding revision.
  await client.query(
    `delete from telegram_app_handoffs
      where trade_intent_id = $1::uuid`,
    [staleHandoffIntentId],
  );
  await client.query(`delete from telegram_trade_intents where id = $1::uuid`, [
    staleHandoffIntentId,
  ]);

  const terminalFundingQuote = await client.query<{ id: string }>(
    `insert into funding_quotes (
       user_id, discovery_projection_id, selected_source_option_snapshot,
       destination_option_snapshot, plan_snapshot, policy_version,
       policy_revision, canonical_request_hash, plan_hash, consent_token_hash,
       expires_at, consumed_at
     ) values (
       $1, 'telegram-terminal-funding', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
       1, 'telegram-terminal-funding', repeat('a', 64), repeat('b', 64),
       repeat('c', 64), now() + interval '1 hour', now()
     ) returning id`,
    [userId],
  );
  const terminalFundingOperation = await client.query<{ id: string }>(
    `insert into funding_operations (
       user_id, quote_id, purpose, status, progress_stage, experience_mode,
       plan_kind, idempotency_key, commit_request_hash, plan_hash,
       policy_version, policy_revision, destination_target_snapshot, market_id,
       placement_snapshot, quote_snapshot, consent_snapshot,
       original_subject_lookup_hmac, subject_lookup_key_version, expires_at,
       completed_at
     ) values (
       $1, $2, 'trade_shortfall', 'cancelled', 'terminal', 'instant',
       'already_available', $3, repeat('d', 64), repeat('b', 64), 1,
       'telegram-terminal-funding', '{}'::jsonb, $4, '{}'::jsonb, '{}'::jsonb,
       '{}'::jsonb, repeat('e', 64), 1, now() + interval '1 hour', now()
     ) returning id`,
    [
      userId,
      terminalFundingQuote.rows[0]?.id,
      `terminal-funding:${suffix}`,
      marketId,
    ],
  );
  await client.query(
    `insert into funding_operation_steps (
       operation_id, ordinal, step_kind, state, action_fingerprint,
       executor_id, payer_requirement, normalized_action,
       action_validation_result, created_at, updated_at
     ) values (
       $1::uuid, 0, 'transaction', 'succeeded', repeat('f', 64),
       'telegram_relay_evm_funding_v1', 'privy_sponsor', '{}'::jsonb,
       '{}'::jsonb, clock_timestamp(), clock_timestamp()
     )`,
    [terminalFundingOperation.rows[0]?.id],
  );
  // A funding operation becomes terminal when its reservation is consumed.
  // The linked intent may already be submitting or reconciling a venue order;
  // that trade boundary must remain authoritative over the funding status.
  const fundedSubmittingIntent = await client.query<{ id: string }>(
    `insert into telegram_trade_intents (
       telegram_user_id, user_id, authorization_id, chat_id,
       telegram_message_id, action, venue, market_id, event_id, side,
       amount_usd, status, expires_at, idempotency_key, delivery_mode,
       funding_operation_id, submit_started_at
     ) values (
       $1, $2, $3, $1, '702', 'buy', 'polymarket', $4, $5, 'YES',
       1, 'executing', now() + interval '2 minutes', $6, 'bot_submit',
       $7::uuid, now()
     ) returning id`,
    [
      telegramUserId,
      userId,
      authorization.id,
      marketId,
      eventId,
      `funded-submitting:${suffix}`,
      terminalFundingOperation.rows[0]?.id,
    ],
  );
  const fundedSubmittingIntentId = fundedSubmittingIntent.rows[0]?.id;
  assert.ok(fundedSubmittingIntentId);
  await runTelegramTradeLifecycleProjectionBatchInTransaction(client);
  assert.deepEqual(
    (
      await client.query<{ can_cancel: boolean; state: string }>(
        `select (result -> 'shortfallProgress' ->> 'canCancel')::boolean as can_cancel,
                result -> 'shortfallProgress' ->> 'state' as state
           from telegram_trade_intents
          where id = $1::uuid`,
        [fundedSubmittingIntentId],
      )
    ).rows[0],
    { can_cancel: false, state: "submitting_trade" },
  );
  await client.query(
    `update telegram_trade_intents
        set status = 'submitted',
            venue_order_id = 'funded-submitting-order',
            updated_at = clock_timestamp()
      where id = $1::uuid`,
    [fundedSubmittingIntentId],
  );
  await runTelegramTradeLifecycleProjectionBatchInTransaction(client);
  assert.deepEqual(
    (
      await client.query<{ can_cancel: boolean; state: string }>(
        `select (result -> 'shortfallProgress' ->> 'canCancel')::boolean as can_cancel,
                result -> 'shortfallProgress' ->> 'state' as state
           from telegram_trade_intents
          where id = $1::uuid`,
        [fundedSubmittingIntentId],
      )
    ).rows[0],
    { can_cancel: false, state: "confirming_trade" },
  );
  await client.query(
    `delete from telegram_bot_action_outbox
      where trade_intent_id = $1::uuid`,
    [fundedSubmittingIntentId],
  );
  await client.query(`delete from telegram_trade_intents where id = $1::uuid`, [
    fundedSubmittingIntentId,
  ]);
  const protectedFundingReservation = await client.query<{ id: string }>(
    `insert into balance_reservations (
       user_id, operation_id, component_id, location_id, network_id,
       asset_id, asset_decimals, raw_amount, mode, state, expires_at
     ) values (
       $1::uuid, $2::uuid, $3, 'polymarket:controller', 'evm:137',
       'pusd', 6, '1000000', 'settled_for_consumer', 'active',
       now() + interval '30 minutes'
     ) returning id`,
    [
      userId,
      terminalFundingOperation.rows[0]?.id,
      `protected-handoff-reservation:${suffix}`,
    ],
  );
  const protectedFundingReservationId = protectedFundingReservation.rows[0]?.id;
  assert.ok(protectedFundingReservationId);
  const insertProtectedExpiredHandoff = async (input: {
    committed?: boolean;
    fundingOperationId?: string;
    fundingReservationId?: string;
    label: string;
    status?: "draft" | "external_handoff" | "previewed";
    submitStarted?: boolean;
  }): Promise<string> => {
    const protectedIntent = await client.query<{ id: string }>(
      `insert into telegram_trade_intents (
         telegram_user_id, user_id, authorization_id, chat_id,
         telegram_message_id, action, venue, market_id, event_id, side,
         amount_usd, status, expires_at, idempotency_key, delivery_mode,
         funding_operation_id, funding_reservation_id, submit_started_at, result
       ) values (
         $1, $2, $3, $1, null, 'buy', 'polymarket', $4, $5, 'YES',
         1, $9, now() - interval '10 minutes', $6,
         'app_handoff', $7::uuid, $10::uuid,
         case when $8::boolean then now() else null end,
         case
           when $8::boolean then jsonb_build_object(
             'appHandoffExecution', jsonb_build_object(
               'committedAt', now()::text,
               'kind', 'direct_trade',
               'version', 2
             )
           )
           else '{}'::jsonb
         end
       ) returning id`,
      [
        telegramUserId,
        userId,
        authorization.id,
        marketId,
        eventId,
        `protected-stale-handoff:${input.label}:${suffix}`,
        input.fundingOperationId ?? null,
        input.submitStarted === true,
        input.status ?? "external_handoff",
        input.fundingReservationId ?? null,
      ],
    );
    const intentId = protectedIntent.rows[0]?.id;
    assert.ok(intentId);
    const tokenHash = crypto
      .createHash("sha256")
      .update(`protected-stale-handoff-token:${input.label}:${suffix}`)
      .digest("hex");
    await client.query(
      `insert into telegram_app_handoffs (
         trade_intent_id, user_id, telegram_user_id, token_hash, state,
         plan_fingerprint, policy_revision, authority_fingerprint,
         quote_snapshot, plan_snapshot, issued_at, expires_at,
         claimed_at, claimed_by_user_id
       ) values (
         $1::uuid, $2::uuid, $3, $4, 'claimed', repeat('a', 64),
         $5, repeat('b', 64), '{}'::jsonb, '{}'::jsonb,
         now() - interval '20 minutes', now() - interval '10 minutes',
         now() - interval '15 minutes', $2::uuid
       )`,
      [
        intentId,
        userId,
        telegramUserId,
        tokenHash,
        `protected-stale-handoff:${input.label}`,
      ],
    );
    if (input.committed === true) {
      await client.query(
        `update telegram_app_handoffs
            set state = 'committed', committed_at = now()
          where trade_intent_id = $1::uuid`,
        [intentId],
      );
    }
    return intentId;
  };
  const fundingLinkedHandoffIntentId = await insertProtectedExpiredHandoff({
    fundingOperationId: terminalFundingOperation.rows[0]?.id,
    label: "funding-linked",
  });
  const reservedPendingHandoffIntentId = await insertProtectedExpiredHandoff({
    fundingOperationId: terminalFundingOperation.rows[0]?.id,
    fundingReservationId: protectedFundingReservationId,
    label: "reserved-pending",
    status: "draft",
  });
  const submittedBoundaryHandoffIntentId = await insertProtectedExpiredHandoff({
    label: "submit-started",
    submitStarted: true,
  });
  const committedHandoffIntentId = await insertProtectedExpiredHandoff({
    committed: true,
    label: "committed",
  });
  await reconcileStaleTelegramTradeIntents(client, {
    now: new Date(),
    telegramUserId,
  });
  const protectedExpiredHandoffs = await client.query<{
    handoff_state: string;
    intent_id: string;
    intent_status: string;
  }>(
    `select handoff_row.state as handoff_state,
            intent_row.id::text as intent_id,
            intent_row.status as intent_status
       from telegram_trade_intents intent_row
       join telegram_app_handoffs handoff_row
         on handoff_row.trade_intent_id = intent_row.id
      where intent_row.id = any($1::uuid[])
      order by intent_row.id`,
    [
      [
        fundingLinkedHandoffIntentId,
        reservedPendingHandoffIntentId,
        submittedBoundaryHandoffIntentId,
        committedHandoffIntentId,
      ],
    ],
  );
  assert.deepEqual(
    Object.fromEntries(
      protectedExpiredHandoffs.rows.map((row) => [
        row.intent_id,
        {
          handoffState: row.handoff_state,
          intentStatus: row.intent_status,
        },
      ]),
    ),
    {
      [committedHandoffIntentId]: {
        handoffState: "committed",
        intentStatus: "external_handoff",
      },
      [fundingLinkedHandoffIntentId]: {
        handoffState: "claimed",
        intentStatus: "external_handoff",
      },
      [reservedPendingHandoffIntentId]: {
        handoffState: "claimed",
        intentStatus: "draft",
      },
      [submittedBoundaryHandoffIntentId]: {
        handoffState: "claimed",
        intentStatus: "external_handoff",
      },
    },
  );
  // These rows exist only to exercise the cleanup predicate. Remove the exact
  // fixtures after their invariant is proven so they cannot participate in
  // the unrelated market/lifecycle assertions below.
  await client.query(
    `delete from telegram_app_handoffs
      where trade_intent_id = any($1::uuid[])`,
    [
      [
        fundingLinkedHandoffIntentId,
        reservedPendingHandoffIntentId,
        submittedBoundaryHandoffIntentId,
        committedHandoffIntentId,
      ],
    ],
  );
  await client.query(
    `delete from telegram_trade_intents
      where id = any($1::uuid[])`,
    [
      [
        fundingLinkedHandoffIntentId,
        submittedBoundaryHandoffIntentId,
        committedHandoffIntentId,
      ],
    ],
  );
  const staleFundingIntent = await client.query<{ id: string }>(
    `insert into telegram_trade_intents (
       telegram_user_id, user_id, authorization_id, action, venue, market_id,
       event_id, side, amount_usd, status, expires_at, idempotency_key,
       funding_operation_id
     ) values (
       $1, $2, $3, 'buy', 'polymarket', $4, $5, 'YES', 1, 'funding',
       now() + interval '2 minutes', $6, $7
     ) returning id`,
    [
      telegramUserId,
      userId,
      authorization.id,
      marketId,
      eventId,
      `stale-terminal-funding:${suffix}`,
      terminalFundingOperation.rows[0]?.id,
    ],
  );
  const staleFundingIntentId = staleFundingIntent.rows[0]?.id;
  assert.ok(staleFundingIntentId);
  const marketAfterTerminalFunding = await buildTelegramBotTradingMarketMessage(
    {
      appBaseUrl: "https://app.hunch.trade",
      chatId: telegramUserId,
      db,
      marketRef: marketId,
      signerInspector,
      telegramMiniAppEnabled: true,
      telegramUserId,
      trading,
    },
  );
  assert.doesNotMatch(
    marketAfterTerminalFunding.text,
    /Trade still resolving/u,
    "A terminal funding operation must not block a fresh market action",
  );
  const statusAfterTerminalFunding = await buildTelegramBotTradingStatusMessage(
    db,
    telegramUserId,
    trading,
    { reconcileLocal: false },
  );
  assert.doesNotMatch(
    statusAfterTerminalFunding.text,
    /Resolving trades/u,
    "A terminal funding operation must disappear from Telegram trading status",
  );
  const reconciledTerminalFunding = await reconcileStaleTelegramTradeIntents(
    db,
    { telegramUserId },
  );
  assert.equal(reconciledTerminalFunding.failedInactiveFunding, 1);
  assert.equal(
    (
      await client.query<{ status: string }>(
        `select status from telegram_trade_intents where id = $1::uuid`,
        [staleFundingIntentId],
      )
    ).rows[0]?.status,
    "failed",
  );
  const projectedTerminalFunding =
    await runTelegramTradeLifecycleProjectionBatchInTransaction(client);
  assert.ok(projectedTerminalFunding.created >= 1);
  assert.equal(
    (
      await client.query<{ state: string | null }>(
        `select result -> 'shortfallProgress' ->> 'state' as state
           from telegram_trade_intents
          where id = $1::uuid`,
        [staleFundingIntentId],
      )
    ).rows[0]?.state,
    "stopped",
    "A terminal funded shortfall keeps the existing Funding stopped renderer",
  );

  const expectStaleFundingCandidate = async (
    expected: boolean,
    message: string,
  ) => {
    assert.equal(
      (
        await telegramTradeLifecycleProgressTestHooks.listCandidateIds(client)
      ).includes(staleFundingIntentId),
      expected,
      message,
    );
  };
  const settleStaleFundingProjection = async (message: string) => {
    await runTelegramTradeLifecycleProjectionBatchInTransaction(client, {
      limit: 100,
    });
    await expectStaleFundingCandidate(false, message);
  };

  await expectStaleFundingCandidate(
    false,
    "an unchanged terminal funding projection is not polled again",
  );

  const lifecycleContinuationQuote = await client.query<{ id: string }>(
    `insert into funding_quotes (
       user_id, discovery_projection_id, selected_source_option_snapshot,
       destination_option_snapshot, plan_snapshot, policy_version,
       policy_revision, canonical_request_hash, plan_hash, consent_token_hash,
       expires_at, consumed_at, created_at, updated_at
     ) values (
       $1, 'telegram-lifecycle-source-gate', '{}'::jsonb, '{}'::jsonb,
       '{}'::jsonb, 1, 'telegram-lifecycle-source-gate', repeat('6', 64),
       repeat('7', 64), repeat('8', 64), now() + interval '1 hour', now(),
       clock_timestamp(), clock_timestamp()
     ) returning id`,
    [userId],
  );
  const lifecycleContinuation = await client.query<{ id: string }>(
    `insert into funding_operations (
       user_id, quote_id, purpose, status, progress_stage, experience_mode,
       plan_kind, idempotency_key, commit_request_hash, plan_hash,
       policy_version, policy_revision, destination_target_snapshot, market_id,
       placement_snapshot, quote_snapshot, consent_snapshot,
       original_subject_lookup_hmac, subject_lookup_key_version, expires_at,
       completed_at, support_metadata, created_at, updated_at
     ) values (
       $1, $2, 'trade_shortfall', 'cancelled', 'terminal', 'instant',
       'already_available', $3, repeat('9', 64), repeat('7', 64), 1,
       'telegram-lifecycle-source-gate', '{}'::jsonb, $4, '{}'::jsonb,
       '{}'::jsonb, '{}'::jsonb, repeat('a', 64), 1,
       now() + interval '1 hour', now(),
       jsonb_build_object(
         'telegramTradeIntentId', $5::text,
         'continuationOfOperationId', $6::text
       ),
       clock_timestamp(), clock_timestamp()
     ) returning id`,
    [
      userId,
      lifecycleContinuationQuote.rows[0]?.id,
      `lifecycle-source-gate-continuation:${suffix}`,
      marketId,
      staleFundingIntentId,
      terminalFundingOperation.rows[0]?.id,
    ],
  );
  const lifecycleContinuationId = lifecycleContinuation.rows[0]?.id;
  assert.ok(lifecycleContinuationId);
  await expectStaleFundingCandidate(
    true,
    "a newly created continuation wakes the projected funding intent",
  );
  await settleStaleFundingProjection(
    "the continuation watermark settles after one projection",
  );

  const lifecycleStep = await client.query<{ id: string }>(
    `insert into funding_operation_steps (
       operation_id, ordinal, step_kind, state, action_fingerprint,
       executor_id, payer_requirement, normalized_action,
       action_validation_result, created_at, updated_at
     ) values (
       $1::uuid, 0, 'server_action', 'planned', repeat('b', 64),
       'telegram-lifecycle-source-gate', 'none', '{}'::jsonb, '{}'::jsonb,
       clock_timestamp(), clock_timestamp()
     ) returning id`,
    [lifecycleContinuationId],
  );
  const lifecycleStepId = lifecycleStep.rows[0]?.id;
  assert.ok(lifecycleStepId);
  await expectStaleFundingCandidate(
    true,
    "a new operation step wakes the projected funding intent",
  );
  await settleStaleFundingProjection(
    "the step watermark settles after one projection",
  );

  const lifecycleAttempt = await client.query<{ id: string }>(
    `insert into funding_operation_step_attempts (
       step_id, attempt_number, canonical_action_fingerprint, executor_id,
       outcome, broadcast_may_have_occurred, reference_kind,
       receipt_ref_ciphertext, receipt_ref_lookup_hmac, lookup_key_version,
       started_at, finished_at, created_at, updated_at
     ) values (
       $1::uuid, 1, repeat('b', 64), 'telegram-lifecycle-source-gate',
       'submitted', true, 'transaction', 'cipher:lifecycle-source-gate',
       repeat('c', 64), 1, clock_timestamp(), clock_timestamp(),
       clock_timestamp(), clock_timestamp()
     ) returning id`,
    [lifecycleStepId],
  );
  const lifecycleAttemptId = lifecycleAttempt.rows[0]?.id;
  assert.ok(lifecycleAttemptId);
  await expectStaleFundingCandidate(
    true,
    "a new operation attempt wakes the projected funding intent",
  );
  await settleStaleFundingProjection(
    "the attempt watermark settles after one projection",
  );

  await client.query(
    `insert into funding_step_receipt_observations (
       operation_id, step_id, attempt_id, network_id, status, action_match,
       canonical, evidence, first_seen_at, observed_at, created_at, updated_at
     ) values (
       $1::uuid, $2::uuid, $3::uuid, 'evm:137', 'pending', null, true,
       '{"lifecycleSourceGate":true}'::jsonb, clock_timestamp(),
       clock_timestamp(), clock_timestamp(), clock_timestamp()
     )`,
    [lifecycleContinuationId, lifecycleStepId, lifecycleAttemptId],
  );
  await expectStaleFundingCandidate(
    true,
    "a new receipt observation wakes the projected funding intent",
  );
  await settleStaleFundingProjection(
    "the receipt watermark settles after one projection",
  );

  const cancellableFundingQuote = await client.query<{ id: string }>(
    `insert into funding_quotes (
       user_id, discovery_projection_id, selected_source_option_snapshot,
       destination_option_snapshot, plan_snapshot, policy_version,
       policy_revision, canonical_request_hash, plan_hash, consent_token_hash,
       expires_at, consumed_at
     ) values (
       $1, 'telegram-cancellable-handoff', '{}'::jsonb, '{}'::jsonb,
       '{}'::jsonb, 1, 'telegram-cancellable-handoff', repeat('1', 64),
       repeat('2', 64), repeat('3', 64), now() + interval '1 hour', now()
     ) returning id`,
    [userId],
  );
  const cancellableFundingOperation = await client.query<{ id: string }>(
    `insert into funding_operations (
       user_id, quote_id, purpose, status, progress_stage, experience_mode,
       plan_kind, idempotency_key, commit_request_hash, plan_hash,
       policy_version, policy_revision, destination_target_snapshot, market_id,
       placement_snapshot, quote_snapshot, consent_snapshot,
       original_subject_lookup_hmac, subject_lookup_key_version, expires_at
     ) values (
       $1, $2, 'trade_shortfall', 'ready', 'ready_for_consumer', 'instant',
       'already_available', $3, repeat('4', 64), repeat('2', 64), 1,
       'telegram-cancellable-handoff', jsonb_build_object(
         'kind', 'owned_location',
         'location', jsonb_build_object(
           'kind', 'venue_account',
           'details', jsonb_build_object('venueId', 'polymarket')
         )
       ), $4, '{}'::jsonb,
       '{}'::jsonb, '{}'::jsonb, repeat('5', 64), 1,
       now() + interval '1 hour'
     ) returning id`,
    [
      userId,
      cancellableFundingQuote.rows[0]?.id,
      `cancellable-handoff-funding:${suffix}`,
      marketId,
    ],
  );
  await client.query(
    `insert into funding_operation_steps (
       operation_id, ordinal, step_kind, state, action_fingerprint,
       executor_id, payer_requirement, normalized_action,
       action_validation_result, created_at, updated_at
     ) values (
       $1::uuid, 0, 'transaction', 'succeeded', repeat('6', 64),
       'telegram_relay_evm_funding_v1', 'privy_sponsor', '{}'::jsonb,
       '{}'::jsonb, clock_timestamp(), clock_timestamp()
     )`,
    [cancellableFundingOperation.rows[0]?.id],
  );
  const cancellableFundingReservation = await client.query<{ id: string }>(
    `insert into balance_reservations (
       user_id, operation_id, component_id, location_id, network_id,
       asset_id, asset_decimals, raw_amount, mode, state, expires_at
     ) values (
       $1::uuid, $2::uuid, $3, 'polymarket:controller', 'evm:137',
       'pusd', 6, '1000000', 'settled_for_consumer', 'active',
       now() + interval '30 minutes'
     ) returning id`,
    [
      userId,
      cancellableFundingOperation.rows[0]?.id,
      `cancellable-handoff-reservation:${suffix}`,
    ],
  );
  const cancellableHandoffId = crypto.randomUUID();
  const cancellableFundedIntent = await client.query<{ id: string }>(
    `insert into telegram_trade_intents (
       telegram_user_id, user_id, authorization_id, chat_id,
       telegram_message_id, action, venue, market_id, event_id, side,
       amount_usd, status, expires_at, idempotency_key, delivery_mode,
       funding_operation_id, funding_reservation_id, result
     ) values (
       $1, $2, $3, $1, '700', 'buy', 'polymarket', $4, $5, 'YES',
       1, 'external_handoff', now() - interval '10 minutes', $6,
       'app_handoff', $7::uuid, $8::uuid,
       jsonb_build_object(
         'appHandoffExecution', jsonb_build_object(
           'committedAt', now()::text,
           'handoffId', $9::uuid,
           'kind', 'funding',
           'version', 2
         )
       )
     ) returning id`,
    [
      telegramUserId,
      userId,
      authorization.id,
      marketId,
      eventId,
      `cancellable-funded-handoff:${suffix}`,
      cancellableFundingOperation.rows[0]?.id,
      cancellableFundingReservation.rows[0]?.id,
      cancellableHandoffId,
    ],
  );
  const cancellableFundedIntentId = cancellableFundedIntent.rows[0]?.id;
  assert.ok(cancellableFundedIntentId);
  await runTelegramTradeLifecycleProjectionBatchInTransaction(client, {
    limit: 100,
  });
  assert.equal(
    (
      await client.query<{ state: string | null }>(
        `select result -> 'shortfallProgress' ->> 'state' as state
           from telegram_trade_intents
          where id = $1::uuid`,
        [cancellableFundedIntentId],
      )
    ).rows[0]?.state,
    "ready",
    "an exact Polymarket destination is consumer-ready without a Router continuation child",
  );
  const cancelledFundedHandoff = await invokeIntentNavigation(
    cancellableFundedIntentId,
    "cancel",
  );
  assert.match(
    cancelledFundedHandoff.answers[0]?.text ?? "",
    /Buy cancelled.*Funding will settle safely/u,
  );
  assert.equal(
    (
      await client.query<{ status: string }>(
        `select status from telegram_trade_intents where id = $1::uuid`,
        [cancellableFundedIntentId],
      )
    ).rows[0]?.status,
    "cancelled",
    "an expired quote cannot turn cancellation of a committed funded handoff into an orphaned expired intent",
  );
  await runTelegramTradeLifecycleProjectionBatchInTransaction(client, {
    limit: 100,
  });
  assert.equal(
    (
      await client.query<{ state: string }>(
        `select state from balance_reservations where id = $1::uuid`,
        [cancellableFundingReservation.rows[0]?.id],
      )
    ).rows[0]?.state,
    "released",
    "Cancel Buy releases the ready consumer reservation while leaving settled venue cash untouched",
  );

  await client.query(
    `update funding_operations
        set status = 'recovery_required',
            progress_stage = 'source_action',
            error_code = 'reconciliation_evidence_timeout',
            recovery_mode = 'automatic_evidence',
            completed_at = null,
            version = version + 1,
            updated_at = clock_timestamp()
      where id = $1::uuid`,
    [cancellableFundingOperation.rows[0]?.id],
  );
  const recoveryFundingIntent = await client.query<{ id: string }>(
    `insert into telegram_trade_intents (
       telegram_user_id, user_id, authorization_id, chat_id,
       telegram_message_id, action, venue, market_id, event_id, side,
       amount_usd, status, expires_at, idempotency_key, delivery_mode,
       funding_operation_id
     ) values (
       $1, $2, $3, $1, '702', 'buy', 'polymarket', $4, $5, 'YES',
       1, 'funding', now() + interval '1 hour', $6, 'app_handoff', $7::uuid
     ) returning id`,
    [
      telegramUserId,
      userId,
      authorization.id,
      marketId,
      eventId,
      `recovery-funding-intent:${suffix}`,
      cancellableFundingOperation.rows[0]?.id,
    ],
  );
  const recoveryFundingIntentId = recoveryFundingIntent.rows[0]?.id;
  assert.ok(recoveryFundingIntentId);
  const staleRecoveryCancellation = await invokeIntentNavigation(
    recoveryFundingIntentId,
    "cancel",
    701,
  );
  assert.match(
    staleRecoveryCancellation.answers[0]?.text ?? "",
    /Buy cancelled.*Funding will settle safely/u,
    "an earlier card for the exact owned intent may safely cancel the Buy",
  );
  assert.deepEqual(
    (
      await client.query<{ intent_status: string; operation_status: string }>(
        `select intent.status as intent_status,
                operation.status as operation_status
           from telegram_trade_intents intent
           join funding_operations operation
             on operation.id = intent.funding_operation_id
          where intent.id = $1::uuid`,
        [recoveryFundingIntentId],
      )
    ).rows[0],
    { intent_status: "cancelled", operation_status: "recovery_required" },
    "Cancel Buy detaches the trade while preserving funding reconciliation",
  );
  const autoDetachedRecoveryIntent = await client.query<{ id: string }>(
    `insert into telegram_trade_intents (
       telegram_user_id, user_id, authorization_id, chat_id,
       telegram_message_id, action, venue, market_id, event_id, side,
       amount_usd, status, expires_at, idempotency_key, delivery_mode,
       funding_operation_id
     ) values (
       $1, $2, $3, $1, '703', 'buy', 'polymarket', $4, $5, 'YES',
       1, 'funding', now() + interval '1 hour', $6, 'app_handoff', $7::uuid
     ) returning id`,
    [
      telegramUserId,
      userId,
      authorization.id,
      marketId,
      eventId,
      `auto-detached-recovery-intent:${suffix}`,
      cancellableFundingOperation.rows[0]?.id,
    ],
  );
  const autoDetachedRecoveryIntentId = autoDetachedRecoveryIntent.rows[0]?.id;
  assert.ok(autoDetachedRecoveryIntentId);
  await runTelegramTradeLifecycleProjectionBatchInTransaction(client, {
    limit: 100,
  });
  assert.deepEqual(
    (
      await client.query<{ error_code: string | null; status: string }>(
        `select status, error_code
           from telegram_trade_intents
          where id = $1::uuid`,
        [autoDetachedRecoveryIntentId],
      )
    ).rows[0],
    { error_code: "funding_recovery_detached", status: "cancelled" },
    "a recovery-required route automatically revokes an unsubmitted Buy",
  );

  const actionRows = await client.query<{ action: string }>(
    `insert into telegram_trade_intents (
       telegram_user_id, user_id, authorization_id, action, venue, market_id,
       side, amount_usd, sell_percent, shares_raw, status, expires_at,
       idempotency_key
     ) values
       ($1, $2, $3, 'sell', 'polymarket', $4, 'YES', null, 50, '1000000', 'failed', now() + interval '2 minutes', $5),
       ($1, $2, $3, 'redeem', 'polymarket', $4, null, null, null, null, 'failed', now() + interval '2 minutes', $6)
     returning action`,
    [
      telegramUserId,
      userId,
      authorization.id,
      marketId,
      `sell-${suffix}`,
      `redeem-${suffix}`,
    ],
  );
  assert.deepEqual(actionRows.rows.map((row) => row.action).sort(), [
    "redeem",
    "sell",
  ]);

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
    "cancelled",
  );
  const preferenceAfterDisable = await client.query<{
    decision_version: string;
    desired_enabled: boolean;
  }>(
    `select desired_enabled, decision_version
       from telegram_bot_trading_preferences
      where user_id = $1`,
    [userId],
  );
  assert.equal(preferenceAfterDisable.rows[0]?.desired_enabled, false);
  assert.equal(Number(preferenceAfterDisable.rows[0]?.decision_version), 2);

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

  const standaloneIntent = await client.query<{ id: string }>(
    `insert into telegram_trade_intents (
       telegram_user_id, user_id, authorization_id, chat_id,
       telegram_message_id, action, venue, market_id, event_id, side,
       amount_usd, status, venue_order_id, expires_at, idempotency_key,
       delivery_mode, result
     ) values (
       $1, $2, $3, $1, '1701', 'buy', 'polymarket', $4, $5, 'YES',
       1, 'filled', 'standalone-order', now() + interval '2 minutes', $6,
       'app_handoff',
       jsonb_build_object(
         'appHandoffExecution',
         jsonb_build_object('version', 2, 'committedAt', now()::text)
       )
     ) returning id`,
    [
      telegramUserId,
      userId,
      authorization.id,
      marketId,
      eventId,
      `standalone-lifecycle:${suffix}`,
    ],
  );
  const standaloneIntentId = standaloneIntent.rows[0]?.id;
  assert.ok(standaloneIntentId);
  assert.equal(
    (
      await runTelegramTradeLifecycleProjectionBatchInTransaction(client, {
        limit: 100,
      })
    ).created >= 1,
    true,
  );
  await client.query(
    `update telegram_bot_action_outbox
        set next_attempt_at = '2000-01-01T00:00:00Z'::timestamptz
      where trade_intent_id = $1::uuid
        and action = 'trade_funding_edit'
        and status in ('pending', 'retry')`,
    [standaloneIntentId],
  );
  const standaloneNavigation = await invokeIntentNavigation(
    standaloneIntentId,
    "open_market",
    1701,
  );
  assert.equal(standaloneNavigation.handled, true);
  assert.equal(
    (
      await client.query<{ reason: string | null }>(
        `select result #>> '{telegramLifecycleMessageBoundary,reason}' as reason
           from telegram_trade_intents
          where id = $1::uuid`,
        [standaloneIntentId],
      )
    ).rows[0]?.reason,
    "navigation",
    "market navigation fences the old editable Telegram generation",
  );
  const transactionBoundPool = {
    connect: async () => ({
      query: (async (statement: unknown, values?: readonly unknown[]) => {
        if (
          typeof statement === "string" &&
          /^(?:begin|commit|rollback)$/iu.test(statement.trim())
        ) {
          return {
            command: statement.trim().toUpperCase(),
            fields: [],
            oid: 0,
            rowCount: null,
            rows: [],
          };
        }
        return client.query(statement as string, values as unknown[]);
      }) as typeof client.query,
      release: () => undefined,
    }),
    query: client.query.bind(client),
  } as unknown as typeof pool;
  let standaloneEdits = 0;
  let standaloneSends = 0;
  assert.deepEqual(
    await deliverTelegramTradeLifecycleProgress({
      limit: 1,
      pool: transactionBoundPool,
      renderCoordinator,
      telegram: {
        editMessageText: async () => {
          standaloneEdits += 1;
          return { messageId: 1701, ok: true };
        },
        sendMessage: async () => {
          standaloneSends += 1;
          assert.equal(
            await fenceTelegramTradeLifecycleNavigation({
              chatId: telegramUserId,
              db,
              intentId: standaloneIntentId,
              messageId: 1701,
              telegramUserId,
            }),
            1,
            "navigation during a standalone send must not rearm that send",
          );
          return { messageId: 1702, ok: true };
        },
      },
    }),
    { claimed: 1, delivered: 1, retried: 0 },
    "a navigation fence moves the authoritative terminal lifecycle to a new message",
  );
  assert.equal(standaloneEdits, 0);
  assert.equal(standaloneSends, 1);
  assert.deepEqual(
    (
      await client.query<{
        boundary: unknown;
        delivery: string | null;
        message_id: string | null;
      }>(
        `select result -> 'telegramLifecycleMessageBoundary' as boundary,
                result #>> '{telegramReceipt,delivery}' as delivery,
                telegram_message_id::text as message_id
           from telegram_trade_intents
          where id = $1::uuid`,
        [standaloneIntentId],
      )
    ).rows[0],
    { boundary: null, delivery: "send", message_id: "1702" },
    "a successful standalone delivery establishes the next editable generation",
  );
  const staleStandaloneNavigation = await invokeIntentNavigation(
    standaloneIntentId,
    "open_market",
    1701,
  );
  assert.match(
    staleStandaloneNavigation.answers[0]?.text ?? "",
    /no longer current/iu,
  );
  assert.equal(
    (
      await client.query<{ message_id: string | null }>(
        `select telegram_message_id::text as message_id
           from telegram_trade_intents
          where id = $1::uuid`,
        [standaloneIntentId],
      )
    ).rows[0]?.message_id,
    "1702",
    "a callback from the old card cannot regress a successful standalone rebind",
  );
  await client.query(
    `update telegram_trade_intents
        set venue_order_id = 'standalone-order-reconciled',
            updated_at = clock_timestamp()
      where id = $1::uuid`,
    [standaloneIntentId],
  );
  assert.equal(
    (
      await runTelegramTradeLifecycleProjectionBatchInTransaction(client, {
        limit: 100,
      })
    ).created >= 1,
    true,
  );
  await client.query(
    `update telegram_bot_action_outbox
        set next_attempt_at = '2000-01-01T00:00:00Z'::timestamptz
      where trade_intent_id = $1::uuid
        and action = 'trade_funding_edit'
        and status in ('pending', 'retry')`,
    [standaloneIntentId],
  );
  let fallbackEdits = 0;
  let fallbackSends = 0;
  assert.deepEqual(
    await deliverTelegramTradeLifecycleProgress({
      limit: 1,
      pool: transactionBoundPool,
      renderCoordinator,
      telegram: {
        editMessageText: async () => {
          fallbackEdits += 1;
          return {
            error: "message_not_editable",
            message: "message cannot be edited",
            ok: false,
          };
        },
        sendMessage: async () => {
          fallbackSends += 1;
          return { messageId: 1703, ok: true };
        },
      },
    }),
    { claimed: 1, delivered: 1, retried: 0 },
    "a definite edit failure falls back to a preference-independent terminal send",
  );
  assert.equal(fallbackEdits, 1);
  assert.equal(fallbackSends, 1);
  assert.equal(
    (
      await client.query<{ message_id: string | null }>(
        `select telegram_message_id::text as message_id
           from telegram_trade_intents
          where id = $1::uuid`,
        [standaloneIntentId],
      )
    ).rows[0]?.message_id,
    "1703",
  );

  const orderedIntent = await client.query<{ id: string }>(
    `insert into telegram_trade_intents (
       telegram_user_id, user_id, authorization_id, chat_id,
       telegram_message_id, action, venue, market_id, event_id, side,
       amount_usd, status, expires_at, idempotency_key, delivery_mode, result
     ) values (
       $1, $2, $3, $1, '1801', 'buy', 'polymarket', $4, $5, 'YES',
       1, 'executing', now() + interval '2 minutes', $6, 'app_handoff',
       jsonb_build_object(
         'appHandoffExecution',
         jsonb_build_object('version', 2, 'committedAt', now()::text)
       )
     ) returning id`,
    [
      telegramUserId,
      userId,
      authorization.id,
      marketId,
      eventId,
      `ordered-lifecycle:${suffix}`,
    ],
  );
  const orderedIntentId = orderedIntent.rows[0]?.id;
  assert.ok(orderedIntentId);
  await runTelegramTradeLifecycleProjectionBatchInTransaction(client, {
    limit: 100,
  });
  const orderedRevision = Number(
    (
      await client.query<{ revision: string }>(
        `select result ->> 'shortfallProgressRevision' as revision
           from telegram_trade_intents
          where id = $1::uuid`,
        [orderedIntentId],
      )
    ).rows[0]?.revision,
  );
  await client.query(
    `update telegram_bot_action_outbox
        set status = 'sending',
            delivery_attempt_id = gen_random_uuid(),
            delivery_started_at = clock_timestamp()
      where trade_intent_id = $1::uuid
        and action = 'trade_funding_edit'
        and state_revision = $2::int`,
    [orderedIntentId, orderedRevision],
  );
  await client.query(
    `update telegram_trade_intents
        set status = 'filled', venue_order_id = 'ordered-fill',
            updated_at = clock_timestamp()
      where id = $1::uuid`,
    [orderedIntentId],
  );
  await runTelegramTradeLifecycleProjectionBatchInTransaction(client, {
    limit: 100,
  });
  assert.equal(
    Number(
      (
        await client.query<{ revision: string }>(
          `select result ->> 'shortfallProgressRevision' as revision
             from telegram_trade_intents
            where id = $1::uuid`,
          [orderedIntentId],
        )
      ).rows[0]?.revision,
    ),
    orderedRevision,
    "a newer durable state waits until the older Telegram mutation leaves sending",
  );
  await client.query(
    `update telegram_bot_action_outbox
        set status = 'sent', delivery_attempt_id = null,
            delivery_started_at = null
      where trade_intent_id = $1::uuid
        and action = 'trade_funding_edit'
        and state_revision = $2::int`,
    [orderedIntentId, orderedRevision],
  );
  await runTelegramTradeLifecycleProjectionBatchInTransaction(client, {
    limit: 100,
  });
  assert.equal(
    Number(
      (
        await client.query<{ revision: string }>(
          `select result ->> 'shortfallProgressRevision' as revision
             from telegram_trade_intents
            where id = $1::uuid`,
          [orderedIntentId],
        )
      ).rows[0]?.revision,
    ),
    orderedRevision + 1,
    "the latest state is projected immediately after the previous mutation settles",
  );

  const lateNavigationIntent = await client.query<{ id: string }>(
    `insert into telegram_trade_intents (
       telegram_user_id, user_id, authorization_id, chat_id,
       telegram_message_id, action, venue, market_id, event_id, side,
       amount_usd, status, venue_order_id, expires_at, idempotency_key,
       delivery_mode, result
     ) values (
       $1, $2, $3, $1, '1901', 'buy', 'polymarket', $4, $5, 'YES',
       1, 'filled', 'late-navigation-fill', now() + interval '2 minutes', $6,
       'app_handoff',
       jsonb_build_object(
         'appHandoffExecution',
         jsonb_build_object('version', 2, 'committedAt', now()::text)
       )
     ) returning id`,
    [
      telegramUserId,
      userId,
      authorization.id,
      marketId,
      eventId,
      `late-navigation-lifecycle:${suffix}`,
    ],
  );
  const lateNavigationIntentId = lateNavigationIntent.rows[0]?.id;
  assert.ok(lateNavigationIntentId);
  await runTelegramTradeLifecycleProjectionBatchInTransaction(client, {
    limit: 100,
  });
  await client.query(
    `update telegram_bot_action_outbox
        set status = 'dead', last_error = 'test_isolation'
      where action = 'trade_funding_edit'
        and trade_intent_id <> $1::uuid
        and status in ('pending', 'retry')`,
    [lateNavigationIntentId],
  );
  await client.query(
    `update telegram_bot_action_outbox
        set next_attempt_at = '2000-01-01T00:00:00Z'::timestamptz
      where trade_intent_id = $1::uuid
        and action = 'trade_funding_edit'
        and status in ('pending', 'retry')`,
    [lateNavigationIntentId],
  );
  let lateNavigationEdits = 0;
  let lateNavigationSends = 0;
  assert.deepEqual(
    await deliverTelegramTradeLifecycleProgress({
      limit: 1,
      pool: transactionBoundPool,
      renderCoordinator: {
        claim: async () => undefined,
        claimBackground: async () => true,
        isCurrent: async () => true,
        runExclusive: async <T>(input: { deliver: () => Promise<T> }) => {
          await client.query(
            `update telegram_trade_intents
                set result = result || jsonb_build_object(
                      'telegramLifecycleMessageBoundary',
                      jsonb_build_object(
                        'messageId', telegram_message_id,
                        'reason', 'navigation',
                        'mutation', 'navigation'
                      )
                    )
              where id = $1::uuid`,
            [lateNavigationIntentId],
          );
          return { status: "completed" as const, value: await input.deliver() };
        },
      },
      telegram: {
        editMessageText: async () => {
          lateNavigationEdits += 1;
          return { messageId: 1901, ok: true };
        },
        sendMessage: async () => {
          lateNavigationSends += 1;
          return { messageId: 1902, ok: true };
        },
      },
    }),
    { claimed: 1, delivered: 1, retried: 0 },
    "a navigation fence written after claim is revalidated before Telegram mutation",
  );
  assert.equal(lateNavigationEdits, 0);
  assert.equal(lateNavigationSends, 1);

  await client.query(
    `update telegram_trade_intents
        set venue_order_id = 'late-navigation-fill-reconciled',
            updated_at = clock_timestamp()
      where id = $1::uuid`,
    [lateNavigationIntentId],
  );
  await runTelegramTradeLifecycleProjectionBatchInTransaction(client, {
    limit: 100,
  });
  await client.query(
    `update telegram_bot_action_outbox
        set next_attempt_at = '2000-01-01T00:00:00Z'::timestamptz
      where trade_intent_id = $1::uuid
        and action = 'trade_funding_edit'
        and status in ('pending', 'retry')`,
    [lateNavigationIntentId],
  );
  let navigationDuringEditSends = 0;
  assert.deepEqual(
    await deliverTelegramTradeLifecycleProgress({
      limit: 1,
      pool: transactionBoundPool,
      renderCoordinator,
      telegram: {
        editMessageText: async () => {
          assert.equal(
            await fenceTelegramTradeLifecycleNavigation({
              chatId: telegramUserId,
              db,
              intentId: lateNavigationIntentId,
              messageId: 1902,
              telegramUserId,
            }),
            1,
          );
          return { messageId: 1902, ok: true };
        },
        sendMessage: async () => {
          navigationDuringEditSends += 1;
          return { messageId: 1903, ok: true };
        },
      },
    }),
    { claimed: 1, delivered: 0, retried: 0 },
    "navigation during an edit rearms that revision instead of losing it",
  );
  assert.deepEqual(
    await deliverTelegramTradeLifecycleProgress({
      limit: 1,
      pool: transactionBoundPool,
      renderCoordinator,
      telegram: {
        editMessageText: async () => {
          assert.fail(
            "the rearmed lifecycle revision must not edit the market card",
          );
        },
        sendMessage: async () => {
          navigationDuringEditSends += 1;
          return { messageId: 1903, ok: true };
        },
      },
    }),
    { claimed: 1, delivered: 1, retried: 0 },
    "the rearmed revision is delivered once as the next standalone generation",
  );
  assert.equal(navigationDuringEditSends, 1);

  const ambiguousSendIntent = await client.query<{ id: string }>(
    `insert into telegram_trade_intents (
       telegram_user_id, user_id, authorization_id, chat_id,
       telegram_message_id, action, venue, market_id, event_id, side,
       amount_usd, status, venue_order_id, expires_at, idempotency_key,
       delivery_mode, result
     ) values (
       $1, $2, $3, $1, '2001', 'buy', 'polymarket', $4, $5, 'YES',
       1, 'filled', 'ambiguous-send-fill', now() + interval '2 minutes', $6,
       'app_handoff',
       jsonb_build_object(
         'appHandoffExecution',
         jsonb_build_object('version', 2, 'committedAt', now()::text),
         'telegramLifecycleMessageBoundary',
         jsonb_build_object(
           'messageId', 2001,
           'reason', 'navigation',
           'mutation', 'navigation'
         )
       )
     ) returning id`,
    [
      telegramUserId,
      userId,
      authorization.id,
      marketId,
      eventId,
      `ambiguous-send-lifecycle:${suffix}`,
    ],
  );
  const ambiguousSendIntentId = ambiguousSendIntent.rows[0]?.id;
  assert.ok(ambiguousSendIntentId);
  await runTelegramTradeLifecycleProjectionBatchInTransaction(client, {
    limit: 100,
  });
  await client.query(
    `update telegram_bot_action_outbox
        set next_attempt_at = '2000-01-01T00:00:00Z'::timestamptz
      where trade_intent_id = $1::uuid
        and action = 'trade_funding_edit'
        and status in ('pending', 'retry')`,
    [ambiguousSendIntentId],
  );
  assert.deepEqual(
    await deliverTelegramTradeLifecycleProgress({
      limit: 1,
      pool: transactionBoundPool,
      renderCoordinator,
      telegram: {
        editMessageText: async () => {
          assert.fail("a fenced lifecycle revision must not edit the old card");
        },
        sendMessage: async () => ({
          error: "ambiguous",
          message: "request timeout after send",
          ok: false,
        }),
      },
    }),
    { claimed: 1, delivered: 0, retried: 0 },
  );
  assert.equal(
    (
      await client.query<{ mutation: string | null }>(
        `select result #>> '{telegramLifecycleMessageBoundary,mutation}' as mutation
           from telegram_trade_intents
          where id = $1::uuid`,
        [ambiguousSendIntentId],
      )
    ).rows[0]?.mutation,
    "send",
    "an ambiguous standalone send quarantines that message generation",
  );
  const ambiguousSendNavigation = await invokeIntentNavigation(
    ambiguousSendIntentId,
    "open_market",
    2001,
  );
  assert.equal(ambiguousSendNavigation.handled, true);
  assert.equal(
    (
      await client.query<{ mutation: string | null }>(
        `select result #>> '{telegramLifecycleMessageBoundary,mutation}' as mutation
           from telegram_trade_intents
          where id = $1::uuid`,
        [ambiguousSendIntentId],
      )
    ).rows[0]?.mutation,
    "send",
    "navigation cannot clear an ambiguous standalone-send quarantine",
  );
  await client.query(
    `update telegram_trade_intents
        set venue_order_id = 'ambiguous-send-fill-reconciled',
            updated_at = clock_timestamp()
      where id = $1::uuid`,
    [ambiguousSendIntentId],
  );
  await runTelegramTradeLifecycleProjectionBatchInTransaction(client, {
    limit: 100,
  });
  await client.query(
    `update telegram_bot_action_outbox
        set next_attempt_at = '2000-01-01T00:00:00Z'::timestamptz
      where trade_intent_id = $1::uuid
        and action = 'trade_funding_edit'
        and status in ('pending', 'retry')`,
    [ambiguousSendIntentId],
  );
  assert.deepEqual(
    await deliverTelegramTradeLifecycleProgress({
      limit: 1,
      pool: transactionBoundPool,
      renderCoordinator,
      telegram: {
        editMessageText: async () => {
          assert.fail("a quarantined generation must not edit");
        },
        sendMessage: async () => {
          assert.fail("a quarantined generation must not send twice");
        },
      },
    }),
    { claimed: 0, delivered: 0, retried: 0 },
    "later revisions cannot cross an ambiguous standalone-send boundary",
  );

  const emptyLifecycleDelivery = await deliverTelegramTradeLifecycleProgress({
    limit: 1,
    pool,
    renderCoordinator,
    telegram: {
      editMessageText: async () => {
        throw new Error(
          "the uncommitted fixture must not be externally visible",
        );
      },
      sendMessage: async () => {
        throw new Error(
          "the uncommitted fixture must not be externally visible",
        );
      },
    },
  });
  assert.deepEqual(
    emptyLifecycleDelivery,
    { claimed: 0, delivered: 0, retried: 0 },
    "the production lifecycle claim query must parse and remain idle without a committed row",
  );

  await app.close();
  console.log(
    "[telegram-bot-trading-lifecycle-integration-tests] passed lifecycle and market-exit regressions",
  );
} finally {
  await client.query("rollback");
  client.release();
  env.telegramMiniAppLinkBase = originalTelegramMiniAppLinkBase;
  env.telegramBotToken = originalTelegramBotToken;
}
