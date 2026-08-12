// @api-integration

import assert from "node:assert/strict";
import crypto from "node:crypto";

import { tx } from "@hunch/infra";

import { stableWalletOpaqueId } from "./account-value/canonical.js";
import { canonicalJsonHash } from "./funding/persistence/canonical.js";
import { fundingSidecarRuntimeConfig } from "./funding/runtime/sidecar-runtime-config.js";
import type { ApiBotTradingExecutor } from "./services/api-trading-service.js";
import {
  appendTelegramFundingBuyReturnInTransaction,
  hasReadyTelegramFundingDestinationReceipt,
  issueTelegramFundingBuyContinuation,
} from "./services/telegram-funding-buy-continuation.js";
import {
  captureTelegramBotTradingCallback,
  createTelegramFundingBuyContinuationDecorator,
  resumeTelegramFundingBuyContinuation,
  telegramBotTradingTestHooks,
} from "./services/telegram-bot-trading.js";
import { cleanupTelegramFundingContexts } from "./services/telegram-funding-delivery.js";
import { createOrReuseTelegramFundingSession } from "./services/telegram-funding-sessions.js";
import { telegramBotTradeAuthorityFingerprint } from "./services/telegram-bot-trade-input-context.js";
import {
  buildTelegramFundingBuyReturnRequestFingerprint,
  TelegramFundingService,
} from "./services/telegram-funding.js";
import { telegramPolygonFundingPresentation } from "./services/telegram-funding-route.js";
import { createIntegrationTestPool } from "./test-database-target.js";

const pool = await createIntegrationTestPool({
  options: "-c jit=off",
  max: 24,
});

const suffix = crypto.randomUUID();
const userId = crypto.randomUUID();
const telegramAccountId = crypto.randomUUID();
const authorizationId = crypto.randomUUID();
const receiveSessionId = crypto.randomUUID();
const telegramUserId = String(
  (BigInt(`0x${suffix.replaceAll("-", "").slice(0, 12)}`) %
    800_000_000_000_000n) +
    100_000_000_000_000n,
);
const eventId = `polymarket:slice-b-event-${suffix}`;
const marketId = `polymarket:slice-b-market-${suffix}`;
const destinationOptionId = `slice-b-destination-${suffix}`;
const venueBindingOptionId = `slice-b-binding-${suffix}`;
const now = new Date();
const walletAddress = `0x${suffix.replaceAll("-", "").slice(0, 40).padEnd(40, "0")}`;
const controllerWalletId = stableWalletOpaqueId({
  walletType: "ethereum",
  networkId: "evm:137",
  address: walletAddress,
});
const destinationAddress = "0x1111111111111111111111111111111111111111";
const sourceShortfallIntentId = crypto.randomUUID();
const readyVariantId = `slice-b-ready-${suffix}`;
const sourceAuthorityFingerprint = telegramBotTradeAuthorityFingerprint({
  authorizationId,
  privyWalletId: `wallet-${suffix}`,
  telegramAccountLinkId: telegramAccountId,
  userId,
  walletAddress,
  walletChain: "ethereum",
});
let contextId: string | null = null;
let intentId: string | null = null;
let cleanupError: unknown;

function fingerprint(label: string): string {
  return canonicalJsonHash({ label, suffix });
}

try {
  await pool.query(`insert into users (id, username) values ($1::uuid, $2)`, [
    userId,
    `slice-b-${suffix}`,
  ]);
  await pool.query(
    `insert into user_telegram_accounts (
       id, user_id, privy_user_id, telegram_user_id, username
     ) values ($1::uuid, $2::uuid, $3, $4, $5)`,
    [
      telegramAccountId,
      userId,
      `did:privy:${suffix}`,
      telegramUserId,
      `slice-b-${suffix}`,
    ],
  );
  await pool.query(
    `insert into user_wallets (
       user_id, wallet_address, wallet_type, is_primary, is_verified
     ) values ($1::uuid, $2, 'ethereum', true, true)`,
    [userId, walletAddress],
  );
  await pool.query(
    `insert into telegram_bot_trading_preferences (
       user_id, desired_enabled, decision_source
     ) values ($1::uuid, true, 'manual_enable')`,
    [userId],
  );
  await pool.query(
    `insert into telegram_bot_trading_authorizations (
       id, user_id, telegram_user_id, privy_user_id, wallet_address,
       wallet_chain, privy_wallet_id, enabled, enabled_venues, max_amount_usd
     ) values (
       $1::uuid, $2::uuid, $3, $4, $5, 'ethereum', $6, true,
       array['polymarket']::text[], 50
     )`,
    [
      authorizationId,
      userId,
      telegramUserId,
      `did:privy:${suffix}`,
      walletAddress,
      `wallet-${suffix}`,
    ],
  );
  const policy = await pool.query<{ id: string }>(
    `insert into runtime_policies (policy_key, effective_at, payload, created_by)
     values ('signal_bot', now(), $1::jsonb, $2::uuid)
     returning id`,
    [
      JSON.stringify({
        buyContinuationEnabled: true,
        tradingEnabled: true,
        tradingActions: ["buy"],
        tradingVenues: ["polymarket"],
        maxTradeAmountUsd: 50,
        maxSlippageBps: 500,
        intentTtlSec: 120,
      }),
      userId,
    ],
  );
  const policyRevision = policy.rows[0]?.id;
  assert.ok(policyRevision);
  await pool.query(
    `insert into unified_events (
       id, venue, venue_event_id, title, status, end_date
     ) values (
       $1, 'polymarket', $2, 'Slice B continuation event', 'ACTIVE',
       now() + interval '2 days'
     )`,
    [eventId, `event-${suffix}`],
  );
  await pool.query(
    `insert into unified_markets (
       id, venue, venue_market_id, event_id, title, status, market_type,
       close_time, expiration_time, outcomes, clob_token_ids, metadata
     ) values (
       $1, 'polymarket', $2, $3, 'Slice B continuation market',
       'ACTIVE', 'binary', now() + interval '1 day', now() + interval '2 days',
       '["Yes","No"]'::jsonb, '["yes-token","no-token"]'::jsonb,
       '{}'::jsonb
     )`,
    [marketId, `market-${suffix}`, eventId],
  );
  await pool.query(
    `insert into funding_receive_sessions (
       id, user_id, status, venue_id, destination_option_id,
       venue_binding_option_id, destination_asset, destination_target_snapshot,
       venue_binding_snapshot, funding_methods, receive_targets,
       observation_variants, selected_receive_target_id, automation_policy,
       policy_version, policy_revision, ownership_revision, version,
       expires_at, observe_until, observation_start_variants, owner_channel
     ) values (
       $1::uuid, $2::uuid, 'open', 'polymarket', $3, $4, $5::jsonb,
       $12::jsonb, '{}'::jsonb, '[{}]'::jsonb, $13::jsonb,
       $11::jsonb, null, $6::jsonb, 1, $7, $8, 7,
       $9, $10, $11::jsonb, 'telegram'
     )`,
    [
      receiveSessionId,
      userId,
      destinationOptionId,
      venueBindingOptionId,
      JSON.stringify({
        assetId: fundingSidecarRuntimeConfig.polymarketPusdAddress,
        decimals: 6,
        networkId: "evm:137",
      }),
      JSON.stringify({
        maximumFeeBps: 500,
        maximumFeeUsd: "1",
        maximumSlippageBps: 100,
        stableConversion: "automatic_within_caps",
        volatileConversion: "review_required",
      }),
      `policy-${suffix}`,
      `ownership-${suffix}`,
      new Date(now.getTime() + 86_400_000),
      new Date(now.getTime() + 8 * 86_400_000),
      JSON.stringify([
        {
          asset: {
            assetId: fundingSidecarRuntimeConfig.polymarketPusdAddress,
            decimals: 6,
            networkId: "evm:137",
          },
          completion: { kind: "direct_destination_credit" },
          destinationAddress,
          networkId: "evm:137",
          variantId: readyVariantId,
        },
      ]),
      JSON.stringify({
        kind: "owned_location",
        location: {
          kind: "venue_account",
          locationId: `slice-b-location-${suffix}`,
          accountId: userId,
          asset: {
            assetId: fundingSidecarRuntimeConfig.polymarketPusdAddress,
            decimals: 6,
            networkId: "evm:137",
          },
          details: {
            venueId: "polymarket",
            accountRef: destinationAddress,
            controllerWalletId,
            address: destinationAddress,
          },
        },
      }),
      JSON.stringify([
        {
          receiveTargetId: `slice-b-target-${suffix}`,
          networkId: "evm:137",
          destinationAddress,
          acceptedAssets: [
            {
              asset: {
                assetId: fundingSidecarRuntimeConfig.polymarketPusdAddress,
                decimals: 6,
                networkId: "evm:137",
              },
              handling: "direct",
            },
            {
              asset: {
                assetId: fundingSidecarRuntimeConfig.polymarketUsdceAddress,
                decimals: 6,
                networkId: "evm:137",
              },
              handling: "automatic_conversion",
            },
          ],
          safeInstructions: ["Send pUSD or USDC.e on Polygon."],
        },
      ]),
    ],
  );
  const created = await createOrReuseTelegramFundingSession(pool, {
    userId,
    telegramAccountId,
    telegramUserId,
    chatId: telegramUserId,
    telegramMessageId: 101,
    receiveSessionId,
    idempotencyKey: `slice-b-context-${suffix}`,
    expiresAt: new Date(now.getTime() + 86_400_000),
    now,
  });
  contextId = created.context.id;
  const readyContextId = created.context.id;

  const attachClient = await pool.connect();
  const reviewClient = await pool.connect();
  let reviewLock: Promise<boolean> | null = null;
  try {
    await attachClient.query("begin");
    await reviewClient.query("begin");
    const reviewPid = await reviewClient.query<{ pid: number }>(
      "select pg_backend_pid() as pid",
    );
    await attachClient.query(
      "select id from funding_receive_sessions where id = $1::uuid for update",
      [receiveSessionId],
    );
    await attachClient.query(
      "select id from telegram_funding_sessions where id = $1::uuid for update",
      [contextId],
    );
    reviewLock =
      telegramBotTradingTestHooks.lockTelegramFundingReturnBeforeMarket(
        reviewClient,
        {
          fundingContextId: contextId,
          marketId,
          telegramUserId,
        },
      );
    let waitingOnFundingLock = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const activity = await pool.query<{ waiting: boolean }>(
        `select wait_event_type = 'Lock' as waiting
           from pg_stat_activity
          where pid = $1`,
        [reviewPid.rows[0]?.pid],
      );
      if (activity.rows[0]?.waiting) {
        waitingOnFundingLock = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(
      waitingOnFundingLock,
      true,
      "Review fence must wait for funding rows before taking the market lock",
    );
    const marketLock = await attachClient.query<{ locked: boolean }>(
      `select pg_try_advisory_xact_lock(hashtextextended($1, 0)) as locked`,
      [["telegram-bot-trade", telegramUserId, marketId].join(":")],
    );
    assert.equal(
      marketLock.rows[0]?.locked,
      true,
      "a concurrent Buy attachment must not deadlock behind Review's market lock",
    );
    await attachClient.query("commit");
    assert.equal(await reviewLock, true);
    await reviewClient.query("commit");
  } finally {
    await attachClient.query("rollback").catch(() => undefined);
    if (reviewLock) await reviewLock.catch(() => undefined);
    await reviewClient.query("rollback").catch(() => undefined);
    attachClient.release();
    reviewClient.release();
  }

  await pool.query(
    `insert into telegram_funding_consents (
       telegram_funding_session_id, revision, selected_receive_target_id,
       selected_asset_network_id, selected_asset_id, selected_asset_decimals,
       consented_variant_ids, automation_enabled,
       max_auto_execute_source_raw, automation_policy_snapshot,
       consent_fingerprint, consented_at
     ) values (
       $1::uuid, 1, $2, 'evm:137', $3, 6, array[$4]::text[], false,
       null, $7::jsonb, $5, $6
     )`,
    [
      contextId,
      `slice-b-target-${suffix}`,
      fundingSidecarRuntimeConfig.polymarketPusdAddress,
      readyVariantId,
      fingerprint("consent"),
      now,
      JSON.stringify({
        version: 1,
        mode: "direct",
        automationEnabled: false,
        presentationMode: "pusd_direct",
        presentation: telegramPolygonFundingPresentation("pusd_direct"),
      }),
    ],
  );
  await pool.query(
    `update telegram_funding_sessions
     set active_consent_revision = 1,
         progress_revision = 1,
         progress_fingerprint = $2,
         latest_progress_projection = $3::jsonb,
         latest_terminal_revision = 1,
         latest_terminal_projection = $3::jsonb,
         projected_receive_version = 7,
         projection_checked_at = $4
     where id = $1::uuid`,
    [
      contextId,
      fingerprint("ready"),
      JSON.stringify({
        assetSymbol: "pUSD",
        expiresAt: new Date(now.getTime() + 86_400_000).toISOString(),
        fundingContextId: contextId,
        observedAt: now.toISOString(),
        rawAmount: "5000000",
        receiveAddress: null,
        presentation: telegramPolygonFundingPresentation("pusd_direct"),
        state: "ready",
        terminal: true,
        version: 2,
      }),
      now,
    ],
  );
  const assertReceiptRejected = async (input: {
    destination: string;
    label: string;
    receiptUserId: string;
    variantId: string;
  }) => {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(
        `insert into funding_receive_receipts (
           receive_session_id, user_id, variant_id, network_id, asset_id,
           asset_decimals, destination_address, raw_amount,
           observation_revision, observed_at, status, handling, evidence
         ) values (
           $1::uuid, $2::uuid, $3, 'evm:137', $4, 6, $5, 5000000,
           $6, $7, 'ready', 'direct', '{}'::jsonb
         )`,
        [
          receiveSessionId,
          input.receiptUserId,
          input.variantId,
          fundingSidecarRuntimeConfig.polymarketPusdAddress,
          input.destination,
          `slice-b-negative-${input.label}-${suffix}`,
          now,
        ],
      );
      assert.equal(
        await hasReadyTelegramFundingDestinationReceipt(client, readyContextId),
        false,
        input.label,
      );
    } finally {
      await client.query("rollback");
      client.release();
    }
  };
  await assertReceiptRejected({
    destination: "0x2222222222222222222222222222222222222222",
    label: "a different destination cannot unlock Review Buy",
    receiptUserId: userId,
    variantId: readyVariantId,
  });
  await assertReceiptRejected({
    destination: destinationAddress,
    label: "a variant outside the active consent cannot unlock Review Buy",
    receiptUserId: userId,
    variantId: "foreign-variant",
  });
  await pool.query(
    `insert into telegram_funding_consents (
       telegram_funding_session_id, revision, selected_receive_target_id,
       selected_asset_network_id, selected_asset_id, selected_asset_decimals,
       consented_variant_ids, automation_enabled,
       max_auto_execute_source_raw, automation_policy_snapshot,
       consent_fingerprint, consented_at
     ) values (
       $1::uuid, 2, $2, 'evm:137', $3, 6, array['foreign-variant']::text[],
       false, null, '{}'::jsonb, $4, $5
     )`,
    [
      contextId,
      `slice-b-target-foreign-${suffix}`,
      fundingSidecarRuntimeConfig.polymarketPusdAddress,
      fingerprint("foreign-consent"),
      now,
    ],
  );
  await pool.query(
    `update telegram_funding_sessions
     set active_consent_revision = 2
     where id = $1::uuid`,
    [contextId],
  );
  await assertReceiptRejected({
    destination: destinationAddress,
    label: "an asset outside the active consent cannot unlock Review Buy",
    receiptUserId: userId,
    variantId: readyVariantId,
  });
  await pool.query(
    `update telegram_funding_sessions
     set active_consent_revision = 1
     where id = $1::uuid`,
    [contextId],
  );
  await pool.query(
    `insert into funding_receive_receipts (
       receive_session_id, user_id, variant_id, network_id, asset_id,
       asset_decimals, destination_address, raw_amount,
       observation_revision, observed_at, status, handling, evidence
     ) values (
       $1::uuid, $2::uuid, $3, 'evm:137', $4, 6, $5, 5000000,
       $6, $7, 'ready', 'direct', '{}'::jsonb
     )`,
    [
      receiveSessionId,
      userId,
      readyVariantId,
      fundingSidecarRuntimeConfig.polymarketPusdAddress,
      destinationAddress,
      `slice-b-observation-${suffix}`,
      now,
    ],
  );
  assert.equal(
    await hasReadyTelegramFundingDestinationReceipt(pool, contextId),
    true,
  );

  const initialReturnOpenRequest = {
    authorizationId,
    chatId: telegramUserId,
    eventId,
    idempotencyKey: `slice-b-attach-${suffix}`,
    marketId,
    requestedSpendUsd: "0.300000",
    side: "YES" as const,
    sourceIntentId: sourceShortfallIntentId,
    telegramMessageId: 101,
    telegramUserId,
    venue: "polymarket" as const,
  };
  const attachInput = {
    contextId,
    userId,
    telegramAccountId,
    telegramUserId,
    chatId: telegramUserId,
    marketId,
    eventId,
    side: "YES" as const,
    requestedSpendUsd: "0.300000",
    sourceShortfallIntentId,
    sourceAuthorityFingerprint,
    venueId: "polymarket",
    destinationOptionId,
    venueBindingOptionId,
    idempotencyKey: `slice-b-attach-${suffix}`,
    requestFingerprint: buildTelegramFundingBuyReturnRequestFingerprint({
      destinationOptionId,
      identity: { chatId: telegramUserId, telegramUserId },
      link: { linkId: telegramAccountId, userId },
      request: initialReturnOpenRequest,
      venueBindingOptionId,
    }),
    responsePayload: { fundingContextId: contextId },
    now,
  };
  const identical = await Promise.all(
    Array.from({ length: 20 }, () =>
      tx(pool, (client) =>
        appendTelegramFundingBuyReturnInTransaction(client, attachInput),
      ),
    ),
  );
  assert.equal(
    new Set(identical.map((entry) => entry.revision.revision)).size,
    1,
  );
  assert.equal(identical[0]?.revision.revision, 1);
  const identicalCounts = await pool.query<{
    mutations: string;
    revisions: string;
  }>(
    `select
       (select count(*)::text from telegram_funding_buy_return_revisions
        where telegram_funding_session_id = $1::uuid) as revisions,
       (select count(*)::text from telegram_funding_mutations
        where funding_context_id = $1::uuid and action = 'set_buy_return') as mutations`,
    [contextId],
  );
  assert.deepEqual(identicalCounts.rows[0], {
    mutations: "1",
    revisions: "1",
  });

  const superseded = await Promise.all(
    ["A", "B"].map((label) =>
      tx(pool, (client) =>
        appendTelegramFundingBuyReturnInTransaction(client, {
          ...attachInput,
          idempotencyKey: `slice-b-attach-${label}-${suffix}`,
          requestFingerprint: fingerprint(`attach-${label}`),
          requestedSpendUsd: label === "A" ? "0.400000" : "0.500000",
          sourceShortfallIntentId: crypto.randomUUID(),
        }),
      ),
    ),
  );
  assert.deepEqual(
    superseded.map((entry) => entry.revision.revision).sort((a, b) => a - b),
    [2, 3],
  );
  const active = await pool.query<{
    active_buy_return_revision: number | null;
    revisions: string;
  }>(
    `select context.active_buy_return_revision,
            count(buy_return.*)::text as revisions
     from telegram_funding_sessions context
     join telegram_funding_buy_return_revisions buy_return
       on buy_return.telegram_funding_session_id = context.id
     where context.id = $1::uuid
     group by context.active_buy_return_revision`,
    [contextId],
  );
  assert.deepEqual(active.rows[0], {
    active_buy_return_revision: 3,
    revisions: "3",
  });

  const continuationsBeforePolicyRace = await pool.query<{ count: string }>(
    `select count(*)::text as count
     from telegram_funding_buy_continuations
     where telegram_funding_session_id = $1::uuid`,
    [contextId],
  );
  await assert.rejects(
    issueTelegramFundingBuyContinuation({
      pool,
      contextId: created.context.id,
      returnRevision: 3,
      progressRevision: 1,
      receiveVersion: 7,
      telegramAccountId,
      telegramUserId,
      chatId: telegramUserId,
      policyRevision,
      validateBeforeIssue: async () => false,
      now,
    }),
    /telegram_funding_buy_continuation_stale/u,
  );
  const continuationsAfterPolicyRace = await pool.query<{ count: string }>(
    `select count(*)::text as count
     from telegram_funding_buy_continuations
     where telegram_funding_session_id = $1::uuid`,
    [contextId],
  );
  assert.deepEqual(
    continuationsAfterPolicyRace.rows,
    continuationsBeforePolicyRace.rows,
    "a policy change before issuance cannot leave a Review button capability",
  );
  await pool.query(
    `update telegram_funding_sessions
        set latest_terminal_projection = jsonb_set(
          latest_progress_projection,
          '{state}',
          '"unavailable"'::jsonb
        )
      where id = $1::uuid`,
    [contextId],
  );
  await assert.rejects(
    issueTelegramFundingBuyContinuation({
      pool,
      contextId,
      returnRevision: 3,
      progressRevision: 1,
      receiveVersion: 7,
      telegramAccountId,
      telegramUserId,
      chatId: telegramUserId,
      policyRevision,
      now,
    }),
    /telegram_funding_buy_continuation_stale/u,
    "a retained non-ready terminal projection blocks Review issuance",
  );
  await pool.query(
    `update telegram_funding_sessions
        set latest_progress_projection = jsonb_set(
              latest_progress_projection,
              '{expiresAt}',
              '"invalid"'::jsonb
            ),
            latest_terminal_projection = jsonb_set(
              latest_progress_projection,
              '{expiresAt}',
              '"invalid"'::jsonb
            )
      where id = $1::uuid`,
    [contextId],
  );
  await assert.rejects(
    issueTelegramFundingBuyContinuation({
      pool,
      contextId,
      returnRevision: 3,
      progressRevision: 1,
      receiveVersion: 7,
      telegramAccountId,
      telegramUserId,
      chatId: telegramUserId,
      policyRevision,
      now,
    }),
    /telegram_funding_buy_continuation_stale/u,
    "JSONB-equal ready rows still require the strict canonical parser",
  );
  await pool.query(
    `update telegram_funding_sessions
        set latest_progress_projection = jsonb_set(
              latest_progress_projection,
              '{expiresAt}',
              to_jsonb($2::text)
            ),
            latest_terminal_projection = jsonb_set(
              latest_progress_projection,
              '{expiresAt}',
              to_jsonb($2::text)
            )
      where id = $1::uuid`,
    [contextId, new Date(now.getTime() + 86_400_000).toISOString()],
  );

  const issued = await Promise.all(
    Array.from({ length: 20 }, () =>
      issueTelegramFundingBuyContinuation({
        pool,
        contextId: created.context.id,
        returnRevision: 3,
        progressRevision: 1,
        receiveVersion: 7,
        telegramAccountId,
        telegramUserId,
        chatId: telegramUserId,
        policyRevision,
        now,
      }),
    ),
  );
  assert.equal(new Set(issued.map((entry) => entry.token)).size, 20);
  for (const entry of issued) {
    assert.match(entry.token, /^[A-Za-z0-9_-]{22}$/u);
    assert.equal(entry.continuation.tokenHash.includes(entry.token), false);
  }

  const beforeResume = await pool.query<{ intents: string }>(
    `select count(*)::text as intents from telegram_trade_intents
     where idempotency_key like $1`,
    [`telegram-funding-resume:${contextId}:%`],
  );
  assert.equal(
    beforeResume.rows[0]?.intents,
    "0",
    "readiness alone creates no intent",
  );
  let releaseConcurrentQuotes: (() => void) | null = null;
  const concurrentQuotesReady = new Promise<void>((resolve) => {
    releaseConcurrentQuotes = resolve;
  });
  let resumeQuoteCalls = 0;
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
      maxExecutableBuyUsd: 50,
      message: null,
      ready: true,
      reasonCode: null,
      setupRequired: false,
    }),
    normalizeError: (_venue: string, error: unknown) => ({
      code: "quote_failed",
      message: error instanceof Error ? error.message : "quote failed",
      raw: error,
      statusCode: 503,
      venue: "polymarket" as const,
    }),
    quote: async (input: never) => {
      const quoteSequence = ++resumeQuoteCalls;
      if (quoteSequence === 2) releaseConcurrentQuotes?.();
      await concurrentQuotesReady;
      if (quoteSequence === 2) {
        const intentId = (input as { intent: { id?: string } }).intent.id;
        assert.ok(intentId);
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const current = await pool.query<{ status: string }>(
            "select status from telegram_trade_intents where id = $1::uuid",
            [intentId],
          );
          if (current.rows[0]?.status === "confirming") break;
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        throw new Error("late concurrent quote failure");
      }
      const price = 0.45 + quoteSequence / 1_000;
      return {
        action: "BUY" as const,
        amount: { type: "usd" as const, value: "0.5" },
        estimatedNotionalUsd: 0.5,
        estimatedShares: 1,
        expiresAt: new Date(Date.now() + 60_000),
        fees: {},
        maxSpendUsd: 0.5 + quoteSequence / 1_000,
        meetsVenueMinimum: true,
        minReceiveShares: 0.95,
        price,
        target: (input as { intent: { target: unknown } }).intent.target,
        venue: "polymarket" as const,
      };
    },
  } as unknown as ApiBotTradingExecutor;
  const deactivatedCard = await issueTelegramFundingBuyContinuation({
    pool,
    contextId,
    returnRevision: 3,
    progressRevision: 1,
    receiveVersion: 7,
    telegramAccountId,
    telegramUserId,
    chatId: telegramUserId,
    policyRevision,
  });
  const intentsBeforeDeactivation = await pool.query<{ count: string }>(
    `select count(*)::text as count
       from telegram_trade_intents
      where idempotency_key like $1`,
    [`telegram-funding-resume:${contextId}:%`],
  );
  await pool.query("update users set is_active = false where id = $1::uuid", [
    userId,
  ]);
  try {
    const inactiveReview = await resumeTelegramFundingBuyContinuation({
      appBaseUrl: "https://app.hunch.trade",
      chatId: telegramUserId,
      db: pool,
      idempotencyKey: `slice-b-inactive-review-${suffix}`,
      telegramMessageId: 101,
      telegramUserId,
      token: deactivatedCard.token,
      trading,
    });
    assert.match(inactiveReview.text, /Review unavailable/u);
    const intentsAfterDeactivation = await pool.query<{ count: string }>(
      `select count(*)::text as count
         from telegram_trade_intents
        where idempotency_key like $1`,
      [`telegram-funding-resume:${contextId}:%`],
    );
    assert.deepEqual(
      intentsAfterDeactivation.rows,
      intentsBeforeDeactivation.rows,
      "an inactive user cannot create a continuation intent",
    );
  } finally {
    await pool.query("update users set is_active = true where id = $1::uuid", [
      userId,
    ]);
  }

  const partialTrading = {
    ...trading,
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
      executable: false,
      maxExecutableBuyUsd: 0.1,
      message: "More funds are required.",
      ready: false,
      reasonCode: "insufficient_funds",
      setupRequired: false,
    }),
    quote: async (input: Parameters<ApiBotTradingExecutor["quote"]>[0]) => ({
      action: "BUY" as const,
      amount: { type: "usd" as const, value: "0.5" },
      estimatedNotionalUsd: 0.5,
      estimatedShares: 1,
      expiresAt: new Date(Date.now() + 60_000),
      fees: {},
      maxSpendUsd: 0.503,
      meetsVenueMinimum: true,
      minReceiveShares: 0.95,
      price: 0.45,
      target: input.intent.target,
      venue: "polymarket" as const,
    }),
  } as ApiBotTradingExecutor;
  const decoratePartialFunding = createTelegramFundingBuyContinuationDecorator({
    pool,
    trading: partialTrading,
  });
  const partialFundingPresentation = {
    consent: {
      receiveTargetId: `slice-b-target-${suffix}`,
      asset: {
        assetId: fundingSidecarRuntimeConfig.polymarketPusdAddress,
        decimals: 6,
        networkId: "evm:137",
      },
    } as never,
    context: created.context,
    now,
    presentationMode: "pusd_or_usdce_automatic" as const,
    session: {
      destinationAsset: {
        assetId: fundingSidecarRuntimeConfig.polymarketPusdAddress,
        decimals: 6,
        networkId: "evm:137",
      },
      destinationOptionId,
      receiveTargets: [
        {
          acceptedAssets: [
            {
              asset: {
                assetId: fundingSidecarRuntimeConfig.polymarketPusdAddress,
                decimals: 6,
                networkId: "evm:137",
              },
              handling: "direct",
            },
            {
              asset: {
                assetId: fundingSidecarRuntimeConfig.polymarketUsdceAddress,
                decimals: 6,
                networkId: "evm:137",
              },
              handling: "automatic_conversion",
            },
          ],
          destinationAddress,
          networkId: "evm:137",
          receiveTargetId: `slice-b-target-${suffix}`,
          safeInstructions: [],
        },
      ],
      venueBindingOptionId,
      venueId: "polymarket",
      version: 7,
    } as never,
  };
  const waitingFundingMessage = await decoratePartialFunding({
    ...partialFundingPresentation,
    message: { qrText: destinationAddress, text: "Waiting for transfer" },
    progress: { state: "waiting_for_transfer" } as never,
  });
  assert.match(waitingFundingMessage.text, /Funding for this Buy/u);
  assert.match(waitingFundingMessage.text, /Maximum spend now/u);
  assert.match(waitingFundingMessage.text, /Send at least/u);
  assert.match(waitingFundingMessage.text, /pUSD/u);
  assert.equal(waitingFundingMessage.qrText, destinationAddress);

  const pickerFundingMessage = await decoratePartialFunding({
    ...partialFundingPresentation,
    consent: null,
    message: { text: "Choose the exact asset" },
    progress: null,
  });
  assert.match(pickerFundingMessage.text, /Funding for this Buy/u);
  assert.match(pickerFundingMessage.text, /Send at least/u);
  assert.match(pickerFundingMessage.text, /Choose the exact asset/u);
  assert.equal(
    pickerFundingMessage.qrText,
    undefined,
    "the picker shows the destination requirement without disclosing an address",
  );

  const fundsReceivedMessage = await decoratePartialFunding({
    ...partialFundingPresentation,
    message: { text: "Funds received and processing" },
    progress: { state: "funds_received" } as never,
  });
  assert.match(fundsReceivedMessage.text, /Funding for this Buy/u);
  assert.match(fundsReceivedMessage.text, /Send at least/u);
  assert.match(
    fundsReceivedMessage.text,
    /Funds received and processing/u,
    "amount guidance decorates rather than replaces the current funding state",
  );

  const expiredQuoteMessage =
    await createTelegramFundingBuyContinuationDecorator({
      pool,
      trading: {
        ...partialTrading,
        quote: async (
          input: Parameters<ApiBotTradingExecutor["quote"]>[0],
        ) => ({
          ...(await partialTrading.quote(input)),
          expiresAt: new Date(now.getTime() - 1),
        }),
      } as ApiBotTradingExecutor,
    })({
      ...partialFundingPresentation,
      message: { text: "Waiting for transfer" },
      progress: { state: "waiting_for_transfer" } as never,
    });
  assert.match(expiredQuoteMessage.text, /Amount temporarily unavailable/u);
  assert.doesNotMatch(
    expiredQuoteMessage.text,
    /Send at least/u,
    "an expired quote never renders a fabricated deposit amount",
  );

  const partialFundingMessage = await decoratePartialFunding({
    ...partialFundingPresentation,
    message: { text: "pUSD ready" },
    progress: { state: "ready" } as never,
  });
  assert.match(partialFundingMessage.text, /Funding for this Buy/u);
  assert.match(partialFundingMessage.text, /Maximum spend now/u);
  assert.match(partialFundingMessage.text, /Send at least/u);
  assert.equal(
    partialFundingMessage.qrText,
    undefined,
    "Buy continuation must not reconstruct an address outside durable delivery",
  );
  assert.equal(
    partialFundingMessage.qrPresentation,
    undefined,
    "an address-free ready projection must remain address-free",
  );
  assert.equal(
    partialFundingMessage.reply_markup,
    undefined,
    "the decorator must not synthesize address controls for an address-free card",
  );
  const resumeInput = {
    appBaseUrl: "https://app.hunch.trade",
    chatId: telegramUserId,
    db: pool,
    telegramMessageId: 101,
    telegramUserId,
    trading,
  };
  const terminalBlockedCard = await issueTelegramFundingBuyContinuation({
    pool,
    contextId,
    returnRevision: 3,
    progressRevision: 1,
    receiveVersion: 7,
    telegramAccountId,
    telegramUserId,
    chatId: telegramUserId,
    policyRevision,
    now,
  });
  const staleMessageReview = await resumeTelegramFundingBuyContinuation({
    ...resumeInput,
    idempotencyKey: `slice-b-stale-message-${suffix}`,
    telegramMessageId: 100,
    token: terminalBlockedCard.token,
  });
  assert.match(
    staleMessageReview.text,
    /Review unavailable/u,
    "Review Buy must fail closed outside the context's exact owner message",
  );
  await pool.query(
    `update telegram_funding_sessions
        set latest_terminal_projection = jsonb_set(
          latest_progress_projection,
          '{state}',
          '"unavailable"'::jsonb
        )
      where id = $1::uuid`,
    [contextId],
  );
  const terminalBlockedReview = await resumeTelegramFundingBuyContinuation({
    ...resumeInput,
    idempotencyKey: `slice-b-terminal-absorbed-${suffix}`,
    token: terminalBlockedCard.token,
  });
  assert.match(terminalBlockedReview.text, /Review unavailable/u);
  await pool.query(
    `update telegram_funding_sessions
        set latest_terminal_projection = latest_progress_projection
      where id = $1::uuid`,
    [contextId],
  );
  const resumed = await Promise.all(
    issued.map((entry, index) =>
      resumeTelegramFundingBuyContinuation({
        ...resumeInput,
        idempotencyKey: `slice-b-resume-${index}-${suffix}`,
        token: entry.token,
      }),
    ),
  );
  assert.equal(
    resumed.every(
      (message) =>
        !/retry_buy|Deposit to continue/u.test(JSON.stringify(message)),
    ),
    true,
    "resumed Buy never re-enters the legacy deposit/retry surface",
  );
  assert.equal(
    resumed.every((message) =>
      message.reply_markup?.inline_keyboard.some((row) =>
        row.some((button) => button.text.includes("Confirm")),
      ),
    ),
    true,
    `explicit Review must reach the ordinary confirmation surface: ${JSON.stringify(
      resumed.map((message) => message.text),
    )}`,
  );
  assert.ok(
    resumeQuoteCalls >= 2,
    "the regression must exercise concurrent distinct fresh quotes",
  );
  assert.equal(
    new Set(resumed.map((message) => JSON.stringify(message))).size,
    1,
    "all concurrent Review cards must show the one quote persisted by the draft CAS",
  );
  const resumeEvidence = await pool.query<{
    generations: string;
    intents: string;
    mutations: string;
    resume_intent_id: string | null;
  }>(
    `select context.resume_intent_id::text,
       (select count(*)::text from telegram_funding_buy_resume_generations
        where telegram_funding_session_id = context.id) as generations,
       (select count(*)::text from telegram_trade_intents
        where idempotency_key like $2) as intents,
       (select count(*)::text from telegram_funding_mutations
        where funding_context_id = context.id and action = 'resume_buy') as mutations
     from telegram_funding_sessions context where context.id = $1::uuid`,
    [contextId, `telegram-funding-resume:${contextId}:%`],
  );
  assert.deepEqual(
    resumeEvidence.rows[0] && {
      generations: resumeEvidence.rows[0].generations,
      intents: resumeEvidence.rows[0].intents,
      mutations: resumeEvidence.rows[0].mutations,
    },
    { generations: "1", intents: "1", mutations: "20" },
  );
  intentId = resumeEvidence.rows[0]?.resume_intent_id ?? null;
  assert.ok(intentId);

  const replayCard = issued[1];
  assert.ok(replayCard);
  const secondCardReplay = await resumeTelegramFundingBuyContinuation({
    ...resumeInput,
    idempotencyKey: `slice-b-resume-1-${suffix}`,
    token: replayCard.token,
  });
  assert.equal(
    secondCardReplay.reply_markup?.inline_keyboard.some((row) =>
      row.some((button) => button.text.includes("Confirm")),
    ),
    true,
    "an exact callback replay returns the same active generation",
  );
  const secondCardEvidence = await pool.query<{
    generations: string;
    intents: string;
    mutations: string;
  }>(
    `select
       (select count(*)::text from telegram_funding_buy_resume_generations
        where telegram_funding_session_id = $1::uuid) as generations,
       (select count(*)::text from telegram_trade_intents
        where idempotency_key like $2) as intents,
       (select count(*)::text from telegram_funding_mutations
        where funding_context_id = $1::uuid and action = 'resume_buy') as mutations`,
    [contextId, `telegram-funding-resume:${contextId}:%`],
  );
  assert.deepEqual(secondCardEvidence.rows[0], {
    generations: "1",
    intents: "1",
    mutations: "20",
  });

  let inactiveIrreversibleCalls = 0;
  await pool.query("update users set is_active = false where id = $1::uuid", [
    userId,
  ]);
  try {
    const inactiveConfirm = await captureTelegramBotTradingCallback({
      appBaseUrl: "https://app.hunch.trade",
      callbackQuery: {
        data: `hbt:confirm:${intentId}`,
        from: { id: Number(telegramUserId) },
        id: `slice-b-inactive-confirm-${suffix}`,
        message: {
          chat: { id: telegramUserId, type: "private" },
          message_id: 101,
        },
      },
      db: pool,
      expectedIntentId: intentId,
      expectedType: "confirm",
      signerInspector: async () => ({ state: "ready" }) as never,
      trading: {
        ...trading,
        prepareTrade: async () => {
          inactiveIrreversibleCalls += 1;
          throw new Error("inactive user reached prepare");
        },
        executePreparedTrade: async () => {
          inactiveIrreversibleCalls += 1;
          throw new Error("inactive user reached submit");
        },
      } as ApiBotTradingExecutor,
    });
    assert.equal(inactiveConfirm.handled, true);
    assert.equal(
      inactiveIrreversibleCalls,
      0,
      "account deactivation must win before setup or order broadcast",
    );
  } finally {
    await pool.query("update users set is_active = true where id = $1::uuid", [
      userId,
    ]);
  }

  const refreshedPolicy = await pool.query<{ id: string }>(
    `insert into runtime_policies (policy_key, effective_at, payload, created_by)
     values ('signal_bot', now(), $1::jsonb, $2::uuid)
     returning id`,
    [
      JSON.stringify({
        buyContinuationEnabled: true,
        tradingEnabled: true,
        tradingActions: ["buy"],
        tradingVenues: ["polymarket"],
        maxTradeAmountUsd: 50,
        maxSlippageBps: 500,
        intentTtlSec: 120,
      }),
      userId,
    ],
  );
  const refreshedPolicyRevision = refreshedPolicy.rows[0]?.id;
  assert.ok(refreshedPolicyRevision);
  const refreshedCard = await issueTelegramFundingBuyContinuation({
    pool,
    contextId,
    returnRevision: 3,
    progressRevision: 1,
    receiveVersion: 7,
    telegramAccountId,
    telegramUserId,
    chatId: telegramUserId,
    policyRevision: refreshedPolicyRevision,
  });
  const staleIntentId = intentId;
  const refreshedReview = await resumeTelegramFundingBuyContinuation({
    ...resumeInput,
    idempotencyKey: `slice-b-refreshed-policy-${suffix}`,
    token: refreshedCard.token,
  });
  assert.equal(
    refreshedReview.reply_markup?.inline_keyboard.some((row) =>
      row.some((button) => button.text.includes("Confirm")),
    ),
    true,
    `a fresh Review card must replace, not reuse, a generation bound to an older policy revision: ${JSON.stringify(refreshedReview)}`,
  );
  const refreshedGeneration = await pool.query<{
    old_status: string;
    resume_generation: number;
    resume_intent_id: string;
  }>(
    `select context.resume_generation,
            context.resume_intent_id::text,
            old_intent.status as old_status
       from telegram_funding_sessions context
       join telegram_trade_intents old_intent on old_intent.id = $2::uuid
      where context.id = $1::uuid`,
    [contextId, staleIntentId],
  );
  assert.equal(refreshedGeneration.rows[0]?.resume_generation, 2);
  assert.equal(refreshedGeneration.rows[0]?.old_status, "failed");
  intentId = refreshedGeneration.rows[0]?.resume_intent_id ?? null;
  assert.ok(intentId);

  const continuationsBeforePolicyFlip = await pool.query<{ count: string }>(
    `select count(*)::text as count
     from telegram_funding_buy_continuations
     where telegram_funding_session_id = $1::uuid`,
    [contextId],
  );
  let decoratorPolicyRevision: string | null = null;
  const policyRaceTrading = {
    ...trading,
    getReadiness: async (
      request: Parameters<ApiBotTradingExecutor["getReadiness"]>[0],
    ) => {
      const inserted = await pool.query<{ id: string }>(
        `insert into runtime_policies (
           policy_key, effective_at, payload, created_by
         ) values ('signal_bot', now(), $1::jsonb, $2::uuid)
         returning id`,
        [JSON.stringify({ buyContinuationEnabled: false }), userId],
      );
      decoratorPolicyRevision = inserted.rows[0]?.id ?? null;
      assert.ok(decoratorPolicyRevision);
      return trading.getReadiness(request);
    },
  } as ApiBotTradingExecutor;
  const policyRaceBaseMessage = { text: "pUSD ready before policy flip" };
  const policyRaceMessage = await createTelegramFundingBuyContinuationDecorator(
    { pool, trading: policyRaceTrading },
  )({
    consent: {} as never,
    context: {
      id: contextId,
      chatId: telegramUserId,
      progressRevision: 1,
      telegramAccountId,
      telegramUserId,
    } as never,
    message: policyRaceBaseMessage,
    now: new Date(),
    presentationMode: "pusd_direct",
    progress: { state: "ready" } as never,
    session: {
      destinationAsset: {
        assetId: fundingSidecarRuntimeConfig.polymarketPusdAddress,
        decimals: 6,
        networkId: "evm:137",
      },
      destinationOptionId,
      venueBindingOptionId,
      venueId: "polymarket",
      version: 7,
    } as never,
  });
  assert.deepEqual(
    policyRaceMessage,
    policyRaceBaseMessage,
    "policy OFF before issuance suppresses the Review Buy button",
  );
  const continuationsAfterPolicyFlip = await pool.query<{ count: string }>(
    `select count(*)::text as count
     from telegram_funding_buy_continuations
     where telegram_funding_session_id = $1::uuid`,
    [contextId],
  );
  assert.deepEqual(
    continuationsAfterPolicyFlip.rows,
    continuationsBeforePolicyFlip.rows,
  );
  assert.ok(decoratorPolicyRevision);
  await pool.query("delete from runtime_policies where id = $1::uuid", [
    decoratorPolicyRevision,
  ]);

  let broadcastCalls = 0;
  let setupAuditCalls = 0;
  let setupBroadcastCalls = 0;
  let racePolicyRevision: string | null = null;
  const authorityRaceTrading = {
    ...trading,
    prepareTrade: async (input: never) => {
      const disabled = await pool.query<{ id: string }>(
        `insert into runtime_policies (policy_key, effective_at, payload, created_by)
         values ('signal_bot', now(), $1::jsonb, $2::uuid)
         returning id`,
        [
          JSON.stringify({
            buyContinuationEnabled: true,
            tradingEnabled: true,
            tradingActions: ["buy"],
            tradingVenues: ["polymarket"],
            maxTradeAmountUsd: 50,
            maxSlippageBps: 100,
            intentTtlSec: 120,
          }),
          userId,
        ],
      );
      racePolicyRevision = disabled.rows[0]?.id ?? null;
      assert.ok(racePolicyRevision);
      await (
        input as {
          onBeforeSetupTransactionBroadcast?: () => Promise<void>;
        }
      ).onBeforeSetupTransactionBroadcast?.();
      await (
        input as {
          onSetupTransactionSubmitted?: (setup: {
            kind: "funding_router";
            transactionId: null;
            txHash: null;
          }) => Promise<void>;
        }
      ).onSetupTransactionSubmitted?.({
        kind: "funding_router",
        transactionId: null,
        txHash: null,
      });
      setupAuditCalls += 1;
      setupBroadcastCalls += 1;
      return {
        authorizationMode: "server_delegated" as const,
        authorizationRequests: [],
        expiresAt: null,
        intent: (input as { intent: never }).intent,
        preparedId: `slice-b-race-${suffix}`,
        quote: null,
        reconcileKeys: {},
        venue: "polymarket" as const,
        venuePayload: {},
      };
    },
    executePreparedTrade: async (input: never) => {
      const lifecycle = input as {
        onBeforeBroadcast?: () => Promise<void>;
      };
      await lifecycle.onBeforeBroadcast?.();
      broadcastCalls += 1;
      throw new Error("broadcast must remain unreachable");
    },
  } as unknown as ApiBotTradingExecutor;
  const authorityRace = await captureTelegramBotTradingCallback({
    appBaseUrl: "https://app.hunch.trade",
    callbackQuery: {
      data: `hbt:confirm:${intentId}`,
      from: { id: Number(telegramUserId) },
      id: `slice-b-authority-race-${suffix}`,
      message: {
        chat: { id: telegramUserId, type: "private" },
        message_id: 101,
      },
    },
    db: pool,
    expectedIntentId: intentId,
    expectedType: "confirm",
    signerInspector: async () => ({ state: "ready" }) as never,
    trading: authorityRaceTrading,
  });
  assert.equal(authorityRace.handled, true);
  assert.ok(racePolicyRevision, "the policy mutation race reached prepare");
  assert.equal(
    setupAuditCalls,
    0,
    "a changed policy revision before the setup fence must not record funding evidence",
  );
  assert.equal(
    setupBroadcastCalls,
    0,
    "a changed policy revision after Confirm must win before funding setup broadcast",
  );
  assert.equal(
    broadcastCalls,
    0,
    "policy revocation after prepare must win before venue broadcast",
  );
  const fencedIntent = await pool.query<{
    status: string;
    submit_started_at: Date | null;
  }>(
    `select status, submit_started_at
     from telegram_trade_intents
     where id = $1::uuid`,
    [intentId],
  );
  assert.equal(fencedIntent.rows[0]?.submit_started_at, null);
  assert.notEqual(fencedIntent.rows[0]?.status, "submitted");
  assert.notEqual(fencedIntent.rows[0]?.status, "filled");

  const restoredAfterRace = await pool.query<{ id: string }>(
    `insert into runtime_policies (policy_key, effective_at, payload, created_by)
     values ('signal_bot', now(), $1::jsonb, $2::uuid)
     returning id`,
    [
      JSON.stringify({
        buyContinuationEnabled: true,
        tradingEnabled: true,
        tradingActions: ["buy"],
        tradingVenues: ["polymarket"],
        maxTradeAmountUsd: 50,
        maxSlippageBps: 500,
        intentTtlSec: 120,
      }),
      userId,
    ],
  );
  assert.ok(restoredAfterRace.rows[0]?.id);

  const cancelled = await issueTelegramFundingBuyContinuation({
    pool,
    contextId,
    returnRevision: 3,
    progressRevision: 1,
    receiveVersion: 7,
    telegramAccountId,
    telegramUserId,
    chatId: telegramUserId,
    policyRevision,
  });
  await pool.query(
    "update telegram_funding_sessions set cancelled_at = now() where id = $1::uuid",
    [contextId],
  );
  const cancelledMessage = await resumeTelegramFundingBuyContinuation({
    ...resumeInput,
    idempotencyKey: `slice-b-cancelled-${suffix}`,
    token: cancelled.token,
  });
  assert.match(cancelledMessage.text, /no longer current/u);
  await pool.query(
    "update telegram_funding_sessions set cancelled_at = null where id = $1::uuid",
    [contextId],
  );
  const expired = await issueTelegramFundingBuyContinuation({
    pool,
    contextId,
    returnRevision: 3,
    progressRevision: 1,
    receiveVersion: 7,
    telegramAccountId,
    telegramUserId,
    chatId: telegramUserId,
    policyRevision,
    now: new Date(Date.now() - 3 * 60_000),
  });
  const expiredMessage = await resumeTelegramFundingBuyContinuation({
    ...resumeInput,
    idempotencyKey: `slice-b-expired-${suffix}`,
    token: expired.token,
  });
  assert.match(expiredMessage.text, /no longer current/u);

  const offPolicy = await pool.query<{ id: string }>(
    `insert into runtime_policies (policy_key, effective_at, payload, created_by)
     values ('signal_bot', now(), $1::jsonb, $2::uuid) returning id`,
    [JSON.stringify({ buyContinuationEnabled: false }), userId],
  );
  const offPolicyRevision = offPolicy.rows[0]?.id;
  assert.ok(offPolicyRevision);
  const policyOff = await issueTelegramFundingBuyContinuation({
    pool,
    contextId,
    returnRevision: 3,
    progressRevision: 1,
    receiveVersion: 7,
    telegramAccountId,
    telegramUserId,
    chatId: telegramUserId,
    policyRevision: offPolicyRevision,
  });
  const policyOffMessage = await resumeTelegramFundingBuyContinuation({
    ...resumeInput,
    idempotencyKey: `slice-b-policy-off-${suffix}`,
    token: policyOff.token,
  });
  assert.match(policyOffMessage.text, /no longer current/u);
  const revisionsBeforeReplay = await pool.query<{ count: string }>(
    `select count(*)::text as count
     from telegram_funding_buy_return_revisions
     where telegram_funding_session_id = $1::uuid`,
    [contextId],
  );
  const replayedFunding = await new TelegramFundingService(pool).openBuyReturn(
    initialReturnOpenRequest,
  );
  assert.equal(replayedFunding.fundingContextId, contextId);
  assert.match(replayedFunding.text, /pUSD ready/u);
  const revisionsAfterReplay = await pool.query<{ count: string }>(
    `select count(*)::text as count
     from telegram_funding_buy_return_revisions
     where telegram_funding_session_id = $1::uuid`,
    [contextId],
  );
  assert.deepEqual(
    revisionsAfterReplay.rows,
    revisionsBeforeReplay.rows,
    "exact attachment replay must bypass current OFF policy and never append a revision",
  );

  const onPolicy = await pool.query<{ id: string }>(
    `insert into runtime_policies (policy_key, effective_at, payload, created_by)
     values ('signal_bot', now(), $1::jsonb, $2::uuid) returning id`,
    [
      JSON.stringify({
        buyContinuationEnabled: true,
        tradingEnabled: true,
        tradingActions: ["buy"],
        tradingVenues: ["polymarket"],
        maxTradeAmountUsd: 50,
        maxSlippageBps: 500,
        intentTtlSec: 120,
      }),
      userId,
    ],
  );
  const onPolicyRevision = onPolicy.rows[0]?.id;
  assert.ok(onPolicyRevision);
  await pool.query(
    `update telegram_trade_intents
     set status = 'cancelled',
         error_code = 'test_user_abandoned_confirmation',
         updated_at = now()
     where id = $1::uuid and status = 'confirming'`,
    [intentId],
  );
  const nextReturn = await tx(pool, (client) =>
    appendTelegramFundingBuyReturnInTransaction(client, {
      ...attachInput,
      idempotencyKey: `slice-b-quote-failure-return-${suffix}`,
      requestFingerprint: fingerprint("quote-failure-return"),
      sourceShortfallIntentId: crypto.randomUUID(),
    }),
  );
  assert.equal(nextReturn.revision.revision, 4);
  const quoteFailure = await issueTelegramFundingBuyContinuation({
    pool,
    contextId,
    returnRevision: 4,
    progressRevision: 1,
    receiveVersion: 7,
    telegramAccountId,
    telegramUserId,
    chatId: telegramUserId,
    policyRevision: onPolicyRevision,
  });
  const replacementWallet = `0x${crypto.randomBytes(20).toString("hex")}`;
  await pool.query(
    `insert into user_wallets (
       user_id, wallet_address, wallet_type, is_primary, is_verified
     ) values ($1::uuid, $2, 'ethereum', false, true)`,
    [userId, replacementWallet],
  );
  await pool.query(
    `update telegram_bot_trading_authorizations
     set wallet_address = $2,
         privy_wallet_id = $3,
         updated_at = now()
     where id = $1::uuid`,
    [authorizationId, replacementWallet, `replacement-wallet-${suffix}`],
  );
  const reboundAuthority = await resumeTelegramFundingBuyContinuation({
    ...resumeInput,
    idempotencyKey: `slice-b-rebound-authority-${suffix}`,
    token: quoteFailure.token,
  });
  assert.match(reboundAuthority.text, /no longer current/u);
  const generationBeforeAuthorityRestore = await pool.query<{ value: number }>(
    `select resume_generation as value
     from telegram_funding_sessions
     where id = $1::uuid`,
    [contextId],
  );
  assert.equal(
    generationBeforeAuthorityRestore.rows[0]?.value,
    2,
    "changing the wallet under the same authorization row cannot rebind a Buy return",
  );
  await pool.query(
    `update telegram_bot_trading_authorizations
     set wallet_address = $2,
         privy_wallet_id = $3,
         updated_at = now()
     where id = $1::uuid`,
    [authorizationId, walletAddress, `wallet-${suffix}`],
  );
  await pool.query(
    `delete from user_wallets
     where user_id = $1::uuid and lower(wallet_address) = lower($2)`,
    [userId, replacementWallet],
  );
  const failingTrading = {
    ...trading,
    quote: async () => {
      throw new Error("deterministic fresh quote failure");
    },
  } as unknown as ApiBotTradingExecutor;
  const quoteFailureInput = {
    ...resumeInput,
    idempotencyKey: `slice-b-quote-failure-${suffix}`,
    token: quoteFailure.token,
    trading: failingTrading,
  };
  const firstQuoteFailure =
    await resumeTelegramFundingBuyContinuation(quoteFailureInput);
  const replayedQuoteFailure =
    await resumeTelegramFundingBuyContinuation(quoteFailureInput);
  assert.match(firstQuoteFailure.text, /Unable to build a safe current quote/u);
  assert.match(replayedQuoteFailure.text, /already processed/u);
  assert.equal(
    /retry_buy|Deposit to continue/u.test(
      JSON.stringify([firstQuoteFailure, replayedQuoteFailure]),
    ),
    false,
  );
  const afterQuoteFailure = await pool.query<{
    generations: string;
    intents: string;
    resume_generation: number;
  }>(
    `select context.resume_generation,
       (select count(*)::text from telegram_funding_buy_resume_generations
        where telegram_funding_session_id = context.id) as generations,
       (select count(*)::text from telegram_trade_intents
        where idempotency_key like $2) as intents
     from telegram_funding_sessions context where context.id = $1::uuid`,
    [contextId, `telegram-funding-resume:${contextId}:%`],
  );
  assert.deepEqual(afterQuoteFailure.rows[0], {
    generations: "3",
    intents: "3",
    resume_generation: 3,
  });

  const recoveredQuote = await resumeTelegramFundingBuyContinuation({
    ...resumeInput,
    idempotencyKey: `slice-b-quote-recovery-${suffix}`,
    token: quoteFailure.token,
  });
  assert.equal(
    recoveredQuote.reply_markup?.inline_keyboard.some((row) =>
      row.some((button) => button.text.includes("Confirm")),
    ),
    true,
    "a new click on the same unexpired Review capability starts one fresh generation after a terminal quote failure",
  );
  const afterQuoteRecovery = await pool.query<{
    generations: string;
    intents: string;
    resume_generation: number;
  }>(
    `select context.resume_generation,
       (select count(*)::text from telegram_funding_buy_resume_generations
        where telegram_funding_session_id = context.id) as generations,
       (select count(*)::text from telegram_trade_intents
        where idempotency_key like $2) as intents
     from telegram_funding_sessions context where context.id = $1::uuid`,
    [contextId, `telegram-funding-resume:${contextId}:%`],
  );
  assert.deepEqual(afterQuoteRecovery.rows[0], {
    generations: "4",
    intents: "4",
    resume_generation: 4,
  });

  const staleAfterFill = await issueTelegramFundingBuyContinuation({
    pool,
    contextId,
    returnRevision: 4,
    progressRevision: 1,
    receiveVersion: 7,
    telegramAccountId,
    telegramUserId,
    chatId: telegramUserId,
    policyRevision: onPolicyRevision,
  });
  await pool.query(
    `update telegram_trade_intents
     set status = 'filled',
         submit_started_at = now(),
         venue_order_id = $2,
         updated_at = now()
     where id = (
       select resume_intent_id
       from telegram_funding_sessions
       where id = $1::uuid
     )`,
    [contextId, `slice-b-filled-${suffix}`],
  );
  const staleAfterFillMessage = await resumeTelegramFundingBuyContinuation({
    ...resumeInput,
    idempotencyKey: `slice-b-stale-after-fill-${suffix}`,
    token: staleAfterFill.token,
  });
  assert.match(staleAfterFillMessage.text, /no longer current/u);
  const afterFilledReplay = await pool.query<{
    generations: string;
    resume_generation: number;
  }>(
    `select context.resume_generation,
       (select count(*)::text
          from telegram_funding_buy_resume_generations
         where telegram_funding_session_id = context.id) as generations
     from telegram_funding_sessions context
     where context.id = $1::uuid`,
    [contextId],
  );
  assert.deepEqual(
    afterFilledReplay.rows[0],
    { generations: "4", resume_generation: 4 },
    "a stale Review card cannot create another generation after a filled Buy",
  );
  await pool.query(
    `update telegram_trade_intents
     set status = 'confirming',
         submit_started_at = null,
         venue_order_id = null,
         updated_at = now()
     where id = (
       select resume_intent_id
       from telegram_funding_sessions
       where id = $1::uuid
     )`,
    [contextId],
  );

  const unlinkToken = await issueTelegramFundingBuyContinuation({
    pool,
    contextId,
    returnRevision: 4,
    progressRevision: 1,
    receiveVersion: 7,
    telegramAccountId,
    telegramUserId,
    chatId: telegramUserId,
    policyRevision: onPolicyRevision,
  });

  await pool.query(
    `insert into telegram_bot_action_outbox (
       action, telegram_account_id, user_id, telegram_user_id,
       funding_session_id, state_revision, payload, status, sent_at
     ) values (
       'funding_edit', $1::uuid, $2::uuid, $3, $4::uuid, 1, $5::jsonb,
       'sent', now()
     )`,
    [
      telegramAccountId,
      userId,
      telegramUserId,
      contextId,
      JSON.stringify({ state: "ready", terminal: true, version: 1 }),
    ],
  );
  await pool.query(
    `update telegram_funding_sessions
     set last_delivered_revision = 1
     where id = $1::uuid`,
    [contextId],
  );

  await assert.rejects(
    pool.query(
      `update telegram_funding_buy_return_revisions
       set requested_spend_usd = 99
       where telegram_funding_session_id = $1::uuid and revision = 3`,
      [contextId],
    ),
    /append-only/u,
  );
  await pool.query(`delete from user_telegram_accounts where id = $1::uuid`, [
    telegramAccountId,
  ]);
  const unlinkedMessage = await resumeTelegramFundingBuyContinuation({
    ...resumeInput,
    idempotencyKey: `slice-b-unlinked-${suffix}`,
    token: unlinkToken.token,
  });
  assert.match(unlinkedMessage.text, /no longer current/u);
  const afterUnlink = await pool.query<{
    continuation_account: string | null;
    context_account: string | null;
    snapshot_account: string | null;
  }>(
    `select context.telegram_account_id::text as context_account,
            continuation.telegram_account_id::text as continuation_account,
            buy_return.telegram_account_id_snapshot::text as snapshot_account
     from telegram_funding_sessions context
     join telegram_funding_buy_return_revisions buy_return
       on buy_return.telegram_funding_session_id = context.id
      and buy_return.revision = 3
     join telegram_funding_buy_continuations continuation
       on continuation.telegram_funding_session_id = context.id
     where context.id = $1::uuid
     limit 1`,
    [contextId],
  );
  assert.deepEqual(afterUnlink.rows[0], {
    continuation_account: null,
    context_account: null,
    snapshot_account: telegramAccountId,
  });

  const relinkedTelegramAccountId = crypto.randomUUID();
  await pool.query(
    `insert into user_telegram_accounts (
       id, user_id, privy_user_id, telegram_user_id, username
     ) values ($1::uuid, $2::uuid, $3, $4, $5)`,
    [
      relinkedTelegramAccountId,
      userId,
      `did:privy:${suffix}:relinked`,
      telegramUserId,
      `slice-b-${suffix}-relinked`,
    ],
  );
  const rearmed = await pool.query<{
    action: string;
    context_account: string | null;
    outbox_account: string | null;
    status: string;
  }>(
    `select
       context.telegram_account_id::text as context_account,
       outbox.telegram_account_id::text as outbox_account,
       outbox.action,
       outbox.status
     from telegram_funding_sessions context
     join telegram_bot_action_outbox outbox
       on outbox.funding_session_id = context.id
      and outbox.state_revision = context.latest_terminal_revision
      and outbox.action = 'funding_edit'
     where context.id = $1::uuid`,
    [contextId],
  );
  assert.deepEqual(rearmed.rows[0], {
    action: "funding_edit",
    context_account: relinkedTelegramAccountId,
    outbox_account: relinkedTelegramAccountId,
    status: "pending",
  });
  const continuationsBeforeRelinkRender = await pool.query<{ count: string }>(
    `select count(*)::text as count
     from telegram_funding_buy_continuations
     where telegram_funding_session_id = $1::uuid`,
    [contextId],
  );
  const relinkBaseMessage = {
    text: "pUSD ready without a stale action",
  };
  const relinkRendered = await createTelegramFundingBuyContinuationDecorator({
    pool,
    trading,
  })({
    consent: null,
    context: {
      id: contextId,
      progressRevision: 1,
      telegramAccountId: relinkedTelegramAccountId,
      telegramUserId,
    } as never,
    message: relinkBaseMessage,
    now: new Date(),
    presentationMode: null,
    progress: { state: "ready" } as never,
    session: {
      destinationAsset: {
        assetId: fundingSidecarRuntimeConfig.polymarketPusdAddress,
        decimals: 6,
        networkId: "evm:137",
      },
      destinationOptionId,
      venueBindingOptionId,
      venueId: "polymarket",
    } as never,
  });
  assert.deepEqual(
    relinkRendered,
    relinkBaseMessage,
    "a relinked account must not receive a Review button bound to the old link snapshot",
  );
  const continuationsAfterRelinkRender = await pool.query<{ count: string }>(
    `select count(*)::text as count
     from telegram_funding_buy_continuations
     where telegram_funding_session_id = $1::uuid`,
    [contextId],
  );
  assert.deepEqual(
    continuationsAfterRelinkRender.rows,
    continuationsBeforeRelinkRender.rows,
    "relink rendering must not issue an unusable continuation token",
  );
  await pool.query(
    `update telegram_bot_action_outbox
     set status = 'sent', sent_at = now(), updated_at = now()
     where funding_session_id = $1::uuid
       and action = 'funding_edit'`,
    [contextId],
  );
  const rearmAgain = await pool.query<{ rearmed: number }>(
    `select rearm_telegram_funding_delivery($1, $2::uuid) as rearmed`,
    [telegramUserId, relinkedTelegramAccountId],
  );
  assert.equal(
    Number(rearmAgain.rows[0]?.rearmed ?? 0),
    0,
    "the same link and terminal revision are rearmed exactly once",
  );

  const oldBinaryCleanup = await pool.connect();
  try {
    await oldBinaryCleanup.query("begin");
    await oldBinaryCleanup.query(
      "set local hunch.telegram_funding_retention_cleanup = 'on'",
    );
    await oldBinaryCleanup.query(
      `delete from telegram_funding_mutations
       where funding_context_id = $1::uuid`,
      [contextId],
    );
    await oldBinaryCleanup.query(
      `update telegram_funding_sessions
       set active_consent_revision = null
       where id = $1::uuid`,
      [contextId],
    );
    await oldBinaryCleanup.query(
      `delete from telegram_funding_consents
       where telegram_funding_session_id = $1::uuid`,
      [contextId],
    );
    const oldDelete = await oldBinaryCleanup.query(
      `delete from telegram_funding_sessions where id = $1::uuid`,
      [contextId],
    );
    assert.equal(
      oldDelete.rowCount,
      1,
      "the pre-0203 cleanup sequence remains valid on the additive 0203 schema",
    );
    await oldBinaryCleanup.query("rollback");
  } catch (error) {
    await oldBinaryCleanup.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    oldBinaryCleanup.release();
  }

  await pool.query(
    `update funding_receive_sessions
     set status = 'completed', closed_at = now(), updated_at = now()
     where id = $1::uuid`,
    [receiveSessionId],
  );
  const aging = await pool.connect();
  try {
    await aging.query("begin");
    await aging.query("set local session_replication_role = replica");
    await aging.query(
      `update telegram_funding_sessions
       set projected_buy_return_revision = active_buy_return_revision,
           projected_buy_policy_revision = $2,
           updated_at = now() - interval '31 days'
       where id = $1::uuid`,
      [contextId, onPolicyRevision],
    );
    await aging.query("commit");
  } catch (error) {
    await aging.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    aging.release();
  }
  await pool.query(
    `update telegram_trade_intents
     set status = 'failed',
         submit_started_at = now(),
         result = result - 'setupTransactions',
         updated_at = now()
     where id = (
       select resume_intent_id
       from telegram_funding_sessions
       where id = $1::uuid
     )`,
    [contextId],
  );
  assert.equal(
    await cleanupTelegramFundingContexts({
      pool,
      limit: 10,
      retentionDays: 30,
    }),
    0,
    "a crossed submit boundary keeps its funding audit evidence even without a venue reference",
  );
  await pool.query(
    `update telegram_trade_intents
     set status = 'failed',
         submit_started_at = null,
         result = jsonb_set(
           result,
           '{setupTransactions}',
           '[{"kind":"approval","txHash":"0xslice-b-retained-approval"}]'::jsonb,
           true
         ),
         updated_at = now()
     where id = (
       select resume_intent_id
       from telegram_funding_sessions
       where id = $1::uuid
     )`,
    [contextId],
  );
  assert.equal(
    await cleanupTelegramFundingContexts({
      pool,
      limit: 10,
      retentionDays: 30,
    }),
    0,
    "a failed resumed intent with an on-chain setup transaction keeps its funding audit evidence",
  );
  await pool.query(
    `update telegram_trade_intents
     set result = result - 'setupTransactions',
         updated_at = now()
     where id = (
       select resume_intent_id
       from telegram_funding_sessions
       where id = $1::uuid
     )`,
    [contextId],
  );
  assert.equal(
    await cleanupTelegramFundingContexts({
      pool,
      limit: 10,
      retentionDays: 30,
    }),
    1,
    "projected Buy-return watermarks must not block terminal retention cleanup",
  );
  const cleanedContext = await pool.query<{ count: string }>(
    `select count(*)::text as count
     from telegram_funding_sessions
     where id = $1::uuid`,
    [contextId],
  );
  assert.equal(cleanedContext.rows[0]?.count, "0");

  console.log(
    "[telegram-funding-buy-continuation-integration-tests] lock ordering, policy issuance fence, post-fill replay denial, return CAS, multi-card evidence, retention, and unlink invalidation passed",
  );
} finally {
  const cleanup = await pool.connect();
  try {
    await cleanup.query("begin");
    await cleanup.query(
      "set local hunch.telegram_funding_retention_cleanup = 'on'",
    );
    if (contextId) {
      await cleanup.query(
        `delete from telegram_funding_mutations where funding_context_id = $1::uuid`,
        [contextId],
      );
      await cleanup.query(
        `delete from telegram_funding_buy_resume_generations
         where telegram_funding_session_id = $1::uuid`,
        [contextId],
      );
      await cleanup.query(
        `delete from telegram_funding_buy_continuations
         where telegram_funding_session_id = $1::uuid`,
        [contextId],
      );
      await cleanup.query(
        `update telegram_funding_sessions
         set active_buy_return_revision = null,
             projected_buy_return_revision = 0,
             projected_buy_policy_revision = null,
             resume_intent_id = null
         where id = $1::uuid`,
        [contextId],
      );
      await cleanup.query(
        `delete from telegram_funding_buy_return_revisions
         where telegram_funding_session_id = $1::uuid`,
        [contextId],
      );
      await cleanup.query(
        `delete from telegram_funding_sessions where id = $1::uuid`,
        [contextId],
      );
    }
    if (intentId) {
      await cleanup.query(
        `delete from telegram_trade_intents where id = $1::uuid`,
        [intentId],
      );
    }
    await cleanup.query(
      `delete from telegram_trade_intents
       where idempotency_key like $1`,
      [`telegram-funding-resume:${contextId}:%`],
    );
    await cleanup.query("set local session_replication_role = replica");
    await cleanup.query(
      `delete from funding_receive_receipts where receive_session_id = $1::uuid`,
      [receiveSessionId],
    );
    await cleanup.query(
      `delete from funding_receive_sessions where id = $1::uuid`,
      [receiveSessionId],
    );
    await cleanup.query(`delete from unified_markets where id = $1`, [
      marketId,
    ]);
    await cleanup.query(`delete from unified_events where id = $1`, [eventId]);
    await cleanup.query(
      `delete from runtime_policies where policy_key = 'signal_bot' and created_by = $1::uuid`,
      [userId],
    );
    await cleanup.query(`delete from users where id = $1::uuid`, [userId]);
    await cleanup.query("commit");
  } catch (error) {
    cleanupError = error;
    await cleanup.query("rollback").catch(() => undefined);
  } finally {
    cleanup.release();
    await pool.end();
  }
}

if (cleanupError) throw cleanupError;
