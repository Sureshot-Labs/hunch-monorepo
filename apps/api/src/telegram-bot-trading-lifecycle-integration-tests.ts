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
import { createTelegramBotTradingRoutes } from "./routes/telegram-bot-trading.js";
import type { PrivyServerSignerStatus } from "./services/api-trading-wallet-signing.js";
import type { ApiBotTradingExecutor } from "./services/api-trading-service.js";
import {
  buildTelegramBotTradingMarketMessage,
  buildTelegramBotTradingStatusMessage,
  captureTelegramBotTradingCallback,
  reconcileStaleTelegramTradeIntents,
} from "./services/telegram-bot-trading.js";
import { runTelegramTradeLifecycleProjectionBatchInTransaction } from "./services/telegram-trade-lifecycle-progress.js";

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

  const awaitingClient =
    await runTelegramTradeLifecycleProjectionBatchInTransaction(client);
  assert.equal(awaitingClient.created, 1);
  await client.query(
    `update telegram_trade_intents
        set status = 'executing',
            submit_started_at = now(),
            updated_at = now()
      where id = $1::uuid`,
    [directLifecycleIntentId],
  );
  const submittingDirect =
    await runTelegramTradeLifecycleProjectionBatchInTransaction(client);
  assert.equal(submittingDirect.created, 1);
  await client.query(
    `update telegram_trade_intents
        set status = 'filled',
            venue_order_id = 'direct-lifecycle-order',
            updated_at = now()
      where id = $1::uuid`,
    [directLifecycleIntentId],
  );
  const filledDirect =
    await runTelegramTradeLifecycleProjectionBatchInTransaction(client);
  assert.equal(filledDirect.created, 1);
  const unchangedDirect =
    await runTelegramTradeLifecycleProjectionBatchInTransaction(client);
  assert.equal(unchangedDirect.created, 0);
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
        [staleFundingIntent.rows[0]?.id],
      )
    ).rows[0]?.status,
    "failed",
  );
  const projectedTerminalFunding =
    await runTelegramTradeLifecycleProjectionBatchInTransaction(client);
  assert.equal(projectedTerminalFunding.created, 1);
  assert.equal(
    (
      await client.query<{ state: string | null }>(
        `select result -> 'shortfallProgress' ->> 'state' as state
           from telegram_trade_intents
          where id = $1::uuid`,
        [staleFundingIntent.rows[0]?.id],
      )
    ).rows[0]?.state,
    "stopped",
    "A terminal funded shortfall keeps the existing Funding stopped renderer",
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

  await app.close();
  console.log(
    "[telegram-bot-trading-lifecycle-integration-tests] passed lifecycle and market-exit regressions",
  );
} finally {
  await client.query("rollback");
  client.release();
}
