#!/usr/bin/env tsx

// @requires-db

import assert from "node:assert/strict";
import crypto from "node:crypto";

import "../../../integration-test-database-guard.js";
import { stableWalletOpaqueId } from "../../../account-value/canonical.js";
import { AuthService } from "../../../auth.js";
import { pool } from "../../../db.js";
import { fundingSidecarRuntimeConfig } from "../../runtime/sidecar-runtime-config.js";
import { canonicalJsonHash } from "../../persistence/canonical.js";
import { resolveTelegramFundingManagedWalletIdentity } from "../../execution/telegram-funding-managed-wallet.js";
import { lockTelegramFundingLinkLifecycle } from "../../execution/telegram-funding-link-lifecycle-lock.js";
import { FUNDING_POLICY_KEY } from "../../policies/funding-policy.js";
import {
  cancelFundingReceiveSessionForUser,
  createOrReuseFundingReceiveSession,
  insertFundingReceiveReceipt,
  listFundingReceiveReceiptsForRouting,
} from "../../persistence/funding-receive-session-repository.js";
import {
  appendTelegramFundingConsent,
  cancelTelegramFundingSessionContext,
  createOrReuseTelegramFundingSession,
  createOrReuseTelegramFundingSessionInTransaction,
  fetchTelegramFundingSessionContext,
  prepareTelegramFundingSessionOpenInTransaction,
  reuseActiveTelegramFundingSession,
  TelegramFundingPersistenceError,
} from "../../../services/telegram-funding-sessions.js";
import { runTelegramFundingProgressProjectionBatch } from "../../../services/telegram-funding-progress-projector.js";
import {
  cleanupTelegramFundingContexts,
  deliverTelegramFundingActions,
  rearmTelegramFundingCurrentAddressDelivery,
  rearmTelegramFundingTerminalDelivery,
} from "../../../services/telegram-funding-delivery.js";
import { fetchUserFinancialLifecycleSummary } from "../../../services/user-financial-lifecycle.js";
import {
  TelegramFundingError,
  TelegramFundingService,
} from "../../../services/telegram-funding.js";
import { telegramPolygonFundingPresentation } from "../../../services/telegram-funding-route.js";

const now = new Date();
const suffix = crypto.randomUUID();
const userId = crypto.randomUUID();
const telegramUserId = `7${Date.now()}`;
const pUsd = {
  networkId: "evm:137",
  assetId: fundingSidecarRuntimeConfig.polymarketPusdAddress,
  decimals: 6,
} as const;
const usdce = {
  networkId: "evm:137",
  assetId: fundingSidecarRuntimeConfig.polymarketUsdceAddress,
  decimals: 6,
} as const;
const baseUsdc = {
  networkId: "evm:8453",
  assetId: fundingSidecarRuntimeConfig.limitlessUsdcAddress,
  decimals: 6,
} as const;
const directPolicySnapshot = {
  mode: "direct",
  automationEnabled: false,
  presentationMode: "pusd_direct",
  presentation: telegramPolygonFundingPresentation("pusd_direct"),
} as const;
const destinationAddress = "0x1111111111111111111111111111111111111111";
const privyWalletId = `privy-wallet-${suffix}`;
const controllerWalletId = stableWalletOpaqueId({
  walletType: "ethereum",
  networkId: "evm:137",
  address: destinationAddress,
});
const limitlessControllerWalletId = stableWalletOpaqueId({
  walletType: "ethereum",
  networkId: "evm:8453",
  address: destinationAddress,
});
const receiveTargetId = `receive_target_telegram_${suffix}`;
const pUsdVariantId = `telegram_pusd_${suffix}`;
const usdceVariantId = `telegram_usdce_${suffix}`;
let receiveSessionId: string | null = null;
let fundingContextId: string | null = null;
let signalPolicyId: string | null = null;
let cleanupFailure: unknown;
const renderCoordinator = {
  claim: async () => {},
  isCurrent: async () => true,
  runExclusive: async <T>(input: { deliver: () => Promise<T> }) => ({
    status: "completed" as const,
    value: await input.deliver(),
  }),
};

function hash(label: string): string {
  return crypto.createHash("sha256").update(`${suffix}:${label}`).digest("hex");
}

function openFingerprint(
  input: Readonly<{
    chatId?: string;
    telegramMessageId: number | null;
    venueId?: string;
  }>,
): string {
  return canonicalJsonHash({
    action: "open",
    chatId: input.chatId ?? telegramUserId,
    telegramMessageId: input.telegramMessageId,
    telegramUserId,
    userId,
    venue: input.venueId ?? "polymarket",
  });
}

async function enableManagedTrading(
  managedTelegramUserId: string,
  privyUserId: string,
): Promise<void> {
  await pool.query(
    `insert into telegram_bot_trading_authorizations (
       user_id, telegram_user_id, privy_user_id, wallet_address,
       wallet_chain, privy_wallet_id, enabled, enabled_venues
     ) values (
       $1, $2, $3, $4, 'ethereum', $5, true, array['polymarket']::text[]
     )
     on conflict (telegram_user_id, wallet_chain) do update
       set user_id = excluded.user_id,
           privy_user_id = excluded.privy_user_id,
           wallet_address = excluded.wallet_address,
           privy_wallet_id = excluded.privy_wallet_id,
           enabled = true,
           enabled_venues = excluded.enabled_venues,
           disabled_at = null,
           updated_at = now()`,
    [
      userId,
      managedTelegramUserId,
      privyUserId,
      destinationAddress,
      privyWalletId,
    ],
  );
}

try {
  await pool.query(
    `insert into users (id, email, is_active, is_verified)
     values ($1, $2, true, true)`,
    [userId, `telegram-funding-${suffix}@example.com`],
  );
  const account = await pool.query<{ id: string }>(
    `insert into user_telegram_accounts (
       user_id, privy_user_id, telegram_user_id, username
     ) values ($1, $2, $3, 'telegram-funding-test')
     returning id`,
    [userId, `did:privy:${suffix}`, telegramUserId],
  );
  const telegramAccountId = account.rows[0]?.id;
  assert.ok(telegramAccountId);
  await pool.query(
    `insert into telegram_bot_trading_preferences (
       user_id, desired_enabled, decision_source
     ) values ($1, true, 'manual_enable')`,
    [userId],
  );
  await pool.query(
    `insert into user_wallets (
       user_id, wallet_address, wallet_type, is_primary, is_verified,
       privy_wallet_id, wallet_source, is_internal_wallet,
       privy_profile_updated_at
     ) values ($1, $2, 'ethereum', true, true, $3, 'embedded', true, $4)`,
    [userId, destinationAddress, privyWalletId, now],
  );
  await enableManagedTrading(telegramUserId, `did:privy:${suffix}`);

  const canonicalInput = {
    userId,
    ownerChannel: "telegram",
    venueId: "polymarket",
    destinationOptionId: `destination_${suffix}`,
    venueBindingOptionId: `binding_${suffix}`,
    destinationAsset: pUsd,
    destinationTargetSnapshot: {
      kind: "owned_location",
      location: {
        kind: "venue_account",
        locationId: `location_${suffix}`,
        accountId: userId,
        asset: pUsd,
        details: {
          venueId: "polymarket",
          accountRef: `account_${suffix}`,
          controllerWalletId,
          address: destinationAddress,
        },
      },
    },
    venueBindingSnapshot: { bindingId: `binding_${suffix}` },
    methods: [
      {
        methodId: `method_${suffix}`,
        kind: "manual",
        safeLabel: "Send pUSD",
        ingress: {
          ingressKind: "manual",
          sourceNetworkId: null,
          sourceAsset: null,
          receiveTargets: [
            {
              receiveTargetId,
              networkId: "evm:137",
              destinationAddress,
              acceptedAssets: [
                { asset: pUsd, handling: "direct" },
                { asset: usdce, handling: "automatic_conversion" },
              ],
              safeInstructions: ["Send only the selected asset."],
            },
          ],
          recommendedReceiveTargetId: receiveTargetId,
          destinationOptionId: `destination_${suffix}`,
          destinationAddress,
          requestedAmount: null,
          amountSemantics: "minimum",
          expiresAt: new Date(now.getTime() + 86_400_000).toISOString(),
          safeInstructions: ["Send only the selected asset."],
        },
      },
    ],
    receiveTargets: [
      {
        receiveTargetId,
        networkId: "evm:137",
        destinationAddress,
        acceptedAssets: [
          { asset: pUsd, handling: "direct" },
          { asset: usdce, handling: "automatic_conversion" },
        ],
        safeInstructions: ["Send only the selected asset."],
      },
    ],
    observationVariants: [
      {
        variantId: pUsdVariantId,
        networkId: "evm:137",
        asset: pUsd,
        destinationAddress,
        destinationLocationId: `location_${suffix}`,
        baselineRaw: "0",
        baselineRevision: `baseline_pusd_${suffix}`,
        observation: {
          adapterId: "owned_wallet_liquid_balances_v1",
          payload: { eventIdentity: "evm_erc20_transfer_v1" },
        },
        completion: { kind: "direct_destination_credit" },
      },
      {
        variantId: usdceVariantId,
        networkId: "evm:137",
        asset: usdce,
        destinationAddress,
        destinationLocationId: `location_${suffix}`,
        baselineRaw: "0",
        baselineRevision: `baseline_usdce_${suffix}`,
        observation: {
          adapterId: "owned_wallet_liquid_balances_v1",
          payload: { eventIdentity: "evm_erc20_transfer_v1" },
        },
        completion: { kind: "child_funding_operation" },
      },
    ],
    selectedReceiveTargetId: null,
    automationPolicy: {
      stableConversion: "automatic_within_caps",
      volatileConversion: "review_required",
      maximumFeeUsd: "1",
      maximumFeeBps: 500,
      maximumSlippageBps: 100,
    },
    policyVersion: 1,
    policyRevision: `telegram_a1_${suffix}`,
    ownershipRevision: `owner_${suffix}`,
    expiresAt: new Date(now.getTime() + 86_400_000),
    observeUntil: new Date(now.getTime() + 8 * 86_400_000),
    now,
  } as const;
  const rolledBackDestination = `atomic-rollback-destination-${suffix}`;
  const rolledBackBinding = `atomic-rollback-binding-${suffix}`;
  await assert.rejects(
    createOrReuseFundingReceiveSession(
      pool,
      {
        ...canonicalInput,
        destinationOptionId: rolledBackDestination,
        venueBindingOptionId: rolledBackBinding,
      },
      async () => {
        throw new Error("telegram_context_finalize_failed");
      },
    ),
    /telegram_context_finalize_failed/u,
  );
  const rolledBackCanonical = await pool.query<{ count: string }>(
    `select count(*)::text as count
     from funding_receive_sessions
     where user_id = $1
       and destination_option_id = $2
       and venue_binding_option_id = $3`,
    [userId, rolledBackDestination, rolledBackBinding],
  );
  assert.equal(
    rolledBackCanonical.rows[0]?.count,
    "0",
    "a Telegram context failure must roll back its canonical session",
  );

  const limitlessReceiveTargetId = `limitless_receive_target_${suffix}`;
  const limitlessVariantId = `limitless_base_usdc_${suffix}`;
  const limitlessDestinationOptionId = `limitless_destination_${suffix}`;
  const limitlessVenueBindingOptionId = `limitless_binding_${suffix}`;
  const limitlessOpenedAt = new Date(now.getTime() + 10);
  let limitlessContextId: string | null = null;
  const limitlessCanonical = await createOrReuseFundingReceiveSession(
    pool,
    {
      ...canonicalInput,
      venueId: "limitless",
      destinationOptionId: limitlessDestinationOptionId,
      venueBindingOptionId: limitlessVenueBindingOptionId,
      destinationAsset: baseUsdc,
      destinationTargetSnapshot: {
        kind: "owned_location",
        location: {
          kind: "venue_account",
          locationId: `limitless_location_${suffix}`,
          accountId: userId,
          asset: baseUsdc,
          details: {
            venueId: "limitless",
            accountRef: `limitless_account_${suffix}`,
            controllerWalletId: limitlessControllerWalletId,
            address: destinationAddress,
          },
        },
      },
      venueBindingSnapshot: { bindingId: limitlessVenueBindingOptionId },
      methods: [
        {
          methodId: `limitless_method_${suffix}`,
          kind: "manual",
          safeLabel: "Send Base USDC",
          ingress: {
            ingressKind: "manual",
            sourceNetworkId: null,
            sourceAsset: null,
            receiveTargets: [
              {
                receiveTargetId: limitlessReceiveTargetId,
                networkId: "evm:8453",
                destinationAddress,
                acceptedAssets: [{ asset: baseUsdc, handling: "direct" }],
                safeInstructions: ["Send only Base USDC."],
              },
            ],
            recommendedReceiveTargetId: limitlessReceiveTargetId,
            destinationOptionId: limitlessDestinationOptionId,
            destinationAddress,
            requestedAmount: null,
            amountSemantics: "minimum",
            expiresAt: new Date(
              limitlessOpenedAt.getTime() + 86_400_000,
            ).toISOString(),
            safeInstructions: ["Send only Base USDC."],
          },
        },
      ],
      receiveTargets: [
        {
          receiveTargetId: limitlessReceiveTargetId,
          networkId: "evm:8453",
          destinationAddress,
          acceptedAssets: [{ asset: baseUsdc, handling: "direct" }],
          safeInstructions: ["Send only Base USDC."],
        },
      ],
      observationVariants: [
        {
          variantId: limitlessVariantId,
          networkId: "evm:8453",
          asset: baseUsdc,
          destinationAddress,
          destinationLocationId: `limitless_location_${suffix}`,
          baselineRaw: "0",
          baselineRevision: `limitless_baseline_${suffix}`,
          observation: {
            adapterId: "owned_wallet_liquid_balances_v1",
            payload: { eventIdentity: "evm_erc20_transfer_v1" },
          },
          completion: { kind: "direct_destination_credit" },
        },
      ],
      policyRevision: `limitless_direct_${suffix}`,
      ownershipRevision: `limitless_owner_${suffix}`,
      now: limitlessOpenedAt,
    },
    async (client, persisted) => {
      const opened = await createOrReuseTelegramFundingSessionInTransaction(
        client,
        {
          userId,
          telegramAccountId,
          telegramUserId,
          chatId: telegramUserId,
          telegramMessageId: 77,
          receiveSessionId: persisted.snapshot.session.receiveSessionId,
          idempotencyKey: `limitless_open_${suffix}`,
          expiresAt: new Date(persisted.snapshot.session.expiresAt),
          now: limitlessOpenedAt,
        },
      );
      limitlessContextId = opened.context.id;
    },
    async (client) => {
      assert.equal(
        await prepareTelegramFundingSessionOpenInTransaction(client, {
          userId,
          telegramAccountId,
          telegramUserId,
          chatId: telegramUserId,
          telegramMessageId: 77,
          venueId: "limitless",
          controllerWalletId: limitlessControllerWalletId,
          destinationOptionId: limitlessDestinationOptionId,
          venueBindingOptionId: limitlessVenueBindingOptionId,
          now: limitlessOpenedAt,
        }),
        null,
        "a fresh Base Limitless context must pass the managed-wallet boundary",
      );
    },
  );
  assert.ok(limitlessContextId);
  assert.equal(
    (
      await reuseActiveTelegramFundingSession(pool, {
        userId,
        telegramAccountId,
        telegramUserId,
        chatId: telegramUserId,
        telegramMessageId: 77,
        venueId: "limitless",
        controllerWalletId: limitlessControllerWalletId,
        venueBindingOptionId: limitlessVenueBindingOptionId,
        idempotencyKey: `limitless_reuse_${suffix}`,
        requestFingerprint: openFingerprint({
          telegramMessageId: 77,
          venueId: "limitless",
        }),
        now: new Date(limitlessOpenedAt.getTime() + 1),
      })
    )?.id,
    limitlessContextId,
    "the Base-specific controller must remain reusable",
  );
  const limitlessConsent = await appendTelegramFundingConsent(pool, {
    contextId: limitlessContextId,
    userId,
    telegramAccountId,
    telegramUserId,
    chatId: telegramUserId,
    telegramMessageId: 77,
    controllerWalletId: limitlessControllerWalletId,
    receiveTargetId: limitlessReceiveTargetId,
    asset: baseUsdc,
    variantIds: [limitlessVariantId],
    automationEnabled: false,
    policySnapshot: { mode: "limitless_base_usdc_direct" },
    fingerprint: hash("limitless-consent"),
    now: new Date(limitlessOpenedAt.getTime() + 2),
  });
  assert.equal(limitlessConsent.consent.asset.networkId, "evm:8453");
  assert.equal(
    limitlessCanonical.snapshot.session.destinationAsset.assetId,
    baseUsdc.assetId,
  );
  await cancelTelegramFundingSessionContext(pool, {
    contextId: limitlessContextId,
    userId,
    telegramAccountId,
    telegramUserId,
    chatId: telegramUserId,
    telegramMessageId: 77,
    idempotencyKey: `limitless_cancel_${suffix}`,
    requestFingerprint: hash("limitless-cancel"),
    responsePayload: { text: "cancelled" },
    now: new Date(limitlessOpenedAt.getTime() + 3),
  });
  const limitlessCleanup = await pool.connect();
  try {
    await limitlessCleanup.query("begin");
    await limitlessCleanup.query(
      "set local session_replication_role = replica",
    );
    await limitlessCleanup.query(
      "delete from telegram_funding_mutations where funding_context_id = $1",
      [limitlessContextId],
    );
    await limitlessCleanup.query(
      "delete from telegram_funding_consents where telegram_funding_session_id = $1",
      [limitlessContextId],
    );
    await limitlessCleanup.query(
      "delete from telegram_funding_sessions where id = $1",
      [limitlessContextId],
    );
    await limitlessCleanup.query(
      "delete from funding_receive_sessions where id = $1",
      [limitlessCanonical.snapshot.session.receiveSessionId],
    );
    await limitlessCleanup.query("commit");
  } catch (error) {
    await limitlessCleanup.query("rollback");
    throw error;
  } finally {
    limitlessCleanup.release();
  }

  const canonical = await createOrReuseFundingReceiveSession(
    pool,
    canonicalInput,
  );
  receiveSessionId = canonical.snapshot.session.receiveSessionId;
  assert.equal(canonical.snapshot.session.selectedReceiveTargetId, null);
  const sameChannelReplay = await createOrReuseFundingReceiveSession(
    pool,
    canonicalInput,
  );
  assert.equal(sameChannelReplay.replayed, true);
  assert.equal(
    sameChannelReplay.snapshot.session.receiveSessionId,
    receiveSessionId,
  );
  const revisedTelegramReplay = await createOrReuseFundingReceiveSession(pool, {
    ...canonicalInput,
    observationVariants: canonicalInput.observationVariants.map((variant) => ({
      ...variant,
      baselineRevision: `${variant.baselineRevision}:new-cursor`,
    })),
    ownershipRevision: `owner_changed_${suffix}`,
    policyRevision: `telegram_a1_changed_${suffix}`,
    now: new Date(now.getTime() + 50),
  });
  assert.equal(revisedTelegramReplay.replayed, true);
  assert.equal(
    revisedTelegramReplay.snapshot.session.receiveSessionId,
    receiveSessionId,
  );
  assert.equal(
    revisedTelegramReplay.snapshot.ownershipRevision,
    canonical.snapshot.ownershipRevision,
    "Telegram replay must preserve the original capability revision",
  );
  assert.deepEqual(
    revisedTelegramReplay.snapshot.observationVariants,
    canonical.snapshot.observationVariants,
    "a newly verified cursor must not replace the frozen Telegram baseline",
  );
  await assert.rejects(
    createOrReuseFundingReceiveSession(pool, {
      ...canonicalInput,
      ownerChannel: "web",
    }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "receive_channel_conflict",
  );
  const unchangedOwner = await pool.query<{ owner_channel: string }>(
    `select owner_channel from funding_receive_sessions where id = $1`,
    [receiveSessionId],
  );
  assert.equal(unchangedOwner.rows[0]?.owner_channel, "telegram");
  assert.equal(
    await cancelFundingReceiveSessionForUser(pool, {
      userId,
      receiveSessionId,
      ownerChannel: "web",
      now: new Date(now.getTime() + 100),
    }),
    null,
    "a web cancel must not close a Telegram-owned session",
  );
  const isolatedWeb = await createOrReuseFundingReceiveSession(pool, {
    ...canonicalInput,
    ownerChannel: "web",
    destinationOptionId: `web-destination-${suffix}`,
    venueBindingOptionId: `web-binding-${suffix}`,
    policyRevision: `web-policy-${suffix}`,
    ownershipRevision: `web-owner-${suffix}`,
  });
  const isolatedWebId = isolatedWeb.snapshot.session.receiveSessionId;
  assert.equal(
    await cancelFundingReceiveSessionForUser(pool, {
      userId,
      receiveSessionId: isolatedWebId,
      ownerChannel: "telegram",
      now: new Date(now.getTime() + 200),
    }),
    null,
    "a Telegram cancel must not close a web-owned session",
  );
  const closedWeb = await cancelFundingReceiveSessionForUser(pool, {
    userId,
    receiveSessionId: isolatedWebId,
    ownerChannel: "web",
    now: new Date(now.getTime() + 300),
  });
  assert.equal(closedWeb?.session.status, "cancelled");
  await pool.query(`delete from funding_receive_sessions where id = $1`, [
    isolatedWebId,
  ]);

  const [firstContext, replayedContext] = await Promise.all([
    createOrReuseTelegramFundingSession(pool, {
      userId,
      telegramAccountId,
      telegramUserId,
      chatId: telegramUserId,
      telegramMessageId: 101,
      receiveSessionId,
      idempotencyKey: `telegram-open:${suffix}`,
      expiresAt: new Date(now.getTime() + 86_400_000),
      now,
    }),
    createOrReuseTelegramFundingSession(pool, {
      userId,
      telegramAccountId,
      telegramUserId,
      chatId: telegramUserId,
      telegramMessageId: 101,
      receiveSessionId,
      idempotencyKey: `telegram-open:${suffix}`,
      expiresAt: new Date(now.getTime() + 86_400_000),
      now,
    }),
  ]);
  fundingContextId = firstContext.context.id;
  assert.equal(replayedContext.context.id, fundingContextId);
  assert.deepEqual([firstContext.replayed, replayedContext.replayed].sort(), [
    false,
    true,
  ]);
  const refreshedDestinationOptionId = `destination_after_inspection_${suffix}`;
  await pool.query(
    `update funding_receive_sessions
        set destination_option_id = $2
      where id = $1`,
    [receiveSessionId, refreshedDestinationOptionId],
  );
  const fastReplay = await reuseActiveTelegramFundingSession(pool, {
    userId,
    telegramAccountId,
    telegramUserId,
    chatId: telegramUserId,
    telegramMessageId: 101,
    venueId: "polymarket",
    controllerWalletId,
    venueBindingOptionId: canonicalInput.venueBindingOptionId,
    idempotencyKey: `telegram-open-fast-replay:${suffix}`,
    requestFingerprint: openFingerprint({ telegramMessageId: 101 }),
    now: new Date(now.getTime() + 500),
  });
  assert.equal(fastReplay?.id, fundingContextId);
  assert.equal(fastReplay?.receiveSessionId, receiveSessionId);
  assert.equal(fastReplay?.telegramMessageId, 101);
  assert.equal(fastReplay?.expiresAt, firstContext.context.expiresAt);
  assert.equal(fastReplay?.activeConsentRevision, null);
  await pool.query(
    `update telegram_bot_trading_preferences
        set desired_enabled = false
      where user_id = $1`,
    [userId],
  );
  await pool.query(
    `update telegram_bot_trading_authorizations
        set enabled = false
      where user_id = $1`,
    [userId],
  );
  assert.equal(
    (
      await reuseActiveTelegramFundingSession(pool, {
        userId,
        telegramAccountId,
        telegramUserId,
        chatId: telegramUserId,
        telegramMessageId: 101,
        venueId: "polymarket",
        controllerWalletId,
        venueBindingOptionId: canonicalInput.venueBindingOptionId,
        idempotencyKey: `telegram-open-soft-paused:${suffix}`,
        requestFingerprint: openFingerprint({ telegramMessageId: 101 }),
        now: new Date(now.getTime() + 500),
      })
    )?.id,
    fundingContextId,
    "soft pause must preserve identity-based 24h context reuse",
  );
  await pool.query(
    `update telegram_bot_trading_preferences
        set desired_enabled = true
      where user_id = $1`,
    [userId],
  );
  await pool.query(
    `update telegram_bot_trading_authorizations
        set enabled = true
      where user_id = $1`,
    [userId],
  );
  await pool.query(
    `update funding_receive_sessions
        set destination_option_id = $2
      where id = $1`,
    [receiveSessionId, canonicalInput.destinationOptionId],
  );
  assert.equal(
    await reuseActiveTelegramFundingSession(pool, {
      userId,
      telegramAccountId,
      telegramUserId,
      chatId: telegramUserId,
      telegramMessageId: 101,
      venueId: "polymarket",
      controllerWalletId: `different_controller_${suffix}`,
      venueBindingOptionId: canonicalInput.venueBindingOptionId,
      idempotencyKey: `telegram-open-wallet-change:${suffix}`,
      requestFingerprint: openFingerprint({ telegramMessageId: 101 }),
      now: new Date(now.getTime() + 500),
    }),
    null,
    "an active context for a different managed wallet must not be reused",
  );
  assert.equal(
    await reuseActiveTelegramFundingSession(pool, {
      userId,
      telegramAccountId,
      telegramUserId,
      chatId: telegramUserId,
      telegramMessageId: 101,
      venueId: "polymarket",
      controllerWalletId,
      venueBindingOptionId: `different_binding_${suffix}`,
      idempotencyKey: `telegram-open-route-change:${suffix}`,
      requestFingerprint: openFingerprint({ telegramMessageId: 101 }),
      now: new Date(now.getTime() + 500),
    }),
    null,
    "an active context for a different venue binding must not be reused",
  );
  const provisionedAuthorizations: unknown[] = [];
  let provisionAttempts = 0;
  const service = new TelegramFundingService(pool, {
    provisionAuthorization: async (input) => {
      provisionAttempts += 1;
      provisionedAuthorizations.push(input);
      if (provisionAttempts === 1) {
        throw new Error("temporary_funding_authorization_failure");
      }
    },
  });
  await assert.rejects(
    service.open(
      {
        chatId: telegramUserId,
        idempotencyKey: `telegram-open-new-callback:${suffix}`,
        telegramMessageId: 101,
        telegramUserId,
        venue: "polymarket",
      },
      new Date(now.getTime() + 500),
    ),
    /temporary_funding_authorization_failure/u,
    "a provisioning failure must surface after the durable open mutation",
  );
  const disabledPolicyReplay = await service.open(
    {
      chatId: telegramUserId,
      idempotencyKey: `telegram-open-new-callback:${suffix}`,
      telegramMessageId: 101,
      telegramUserId,
      venue: "polymarket",
    },
    new Date(now.getTime() + 500),
  );
  assert.equal(disabledPolicyReplay.fundingContextId, fundingContextId);
  assert.deepEqual(provisionedAuthorizations, [
    {
      userId,
      telegramAccountId,
      telegramUserId,
      controllerWalletId,
      destinationOptionId: canonicalInput.destinationOptionId,
      venueBindingOptionId: canonicalInput.venueBindingOptionId,
      venueId: "polymarket",
      now: new Date(now.getTime() + 500),
    },
    {
      userId,
      telegramAccountId,
      telegramUserId,
      controllerWalletId,
      destinationOptionId: canonicalInput.destinationOptionId,
      venueBindingOptionId: canonicalInput.venueBindingOptionId,
      venueId: "polymarket",
      now: new Date(now.getTime() + 500),
    },
  ]);
  assert.match(
    disabledPolicyReplay.text,
    /Confirm the supported receive assets/u,
  );
  assert.doesNotMatch(disabledPolicyReplay.text, /USDC\.e/u);
  await assert.rejects(
    new TelegramFundingService(pool, {
      resolveManagedWallet: async () => null,
    }).open(
      {
        chatId: telegramUserId,
        idempotencyKey: `telegram-open-without-managed-wallet:${suffix}`,
        telegramMessageId: 209,
        telegramUserId,
        venue: "polymarket",
      },
      new Date(now.getTime() + 600),
    ),
    (error: unknown) =>
      error instanceof TelegramFundingError &&
      error.code === "destination_ambiguous",
    "production mode must not fall back to an arbitrary verified wallet",
  );
  const openMutation = await pool.query<{
    action: string;
    funding_context_id: string;
    response_context_id: string | null;
  }>(
    `select action,
            funding_context_id,
            response_payload->>'fundingContextId' as response_context_id
     from telegram_funding_mutations
     where idempotency_key = $1`,
    [`telegram-open-new-callback:${suffix}`],
  );
  assert.deepEqual(openMutation.rows, [
    {
      action: "open",
      funding_context_id: fundingContextId,
      response_context_id: fundingContextId,
    },
  ]);
  await assert.rejects(
    service.open(
      {
        chatId: telegramUserId,
        idempotencyKey: `telegram-open-new-callback:${suffix}`,
        telegramMessageId: 999,
        telegramUserId,
        venue: "polymarket",
      },
      new Date(now.getTime() + 500),
    ),
    (error: unknown) =>
      error instanceof TelegramFundingError &&
      error.code === "idempotency_conflict",
    "reusing an open key with a different request must fail closed",
  );
  assert.equal(
    await reuseActiveTelegramFundingSession(pool, {
      userId,
      telegramAccountId,
      telegramUserId,
      chatId: telegramUserId,
      telegramMessageId: 203,
      venueId: "limitless",
      idempotencyKey: `telegram-open-other-venue:${suffix}`,
      requestFingerprint: openFingerprint({
        telegramMessageId: 203,
        venueId: "limitless",
      }),
      now: new Date(now.getTime() + 500),
    }),
    null,
    "a different venue must not reuse the Polymarket context",
  );
  assert.equal(
    await reuseActiveTelegramFundingSession(pool, {
      userId,
      telegramAccountId,
      telegramUserId,
      chatId: `${telegramUserId}0`,
      telegramMessageId: 203,
      venueId: "polymarket",
      idempotencyKey: `telegram-open-foreign-chat:${suffix}`,
      requestFingerprint: openFingerprint({
        chatId: `${telegramUserId}0`,
        telegramMessageId: 203,
      }),
      now: new Date(now.getTime() + 500),
    }),
    null,
    "a foreign chat must not discover a reusable context",
  );

  const concurrentDestination = `concurrent-destination-${suffix}`;
  const concurrentBinding = `concurrent-binding-${suffix}`;
  const concurrentOpens = await Promise.all(
    ["a", "b"].map((attempt, index) =>
      createOrReuseFundingReceiveSession(
        pool,
        {
          ...canonicalInput,
          venueId: "limitless",
          destinationOptionId: concurrentDestination,
          venueBindingOptionId: concurrentBinding,
          policyRevision: `concurrent-policy-${attempt}-${suffix}`,
          ownershipRevision: `concurrent-owner-${attempt}-${suffix}`,
          observationVariants: canonicalInput.observationVariants.map(
            (variant) => ({
              ...variant,
              baselineRevision: `${variant.baselineRevision}:${attempt}`,
            }),
          ),
          now: new Date(now.getTime() + 510 + index),
        },
        async (client, persisted) => {
          await createOrReuseTelegramFundingSessionInTransaction(client, {
            userId,
            telegramAccountId,
            telegramUserId,
            chatId: telegramUserId,
            telegramMessageId: 300,
            receiveSessionId: persisted.snapshot.session.receiveSessionId,
            idempotencyKey: `telegram-open-concurrent-${attempt}:${suffix}`,
            expiresAt: new Date(persisted.snapshot.session.expiresAt),
            now: new Date(now.getTime() + 510 + index),
          });
        },
      ),
    ),
  );
  assert.equal(
    concurrentOpens[0]?.snapshot.session.receiveSessionId,
    concurrentOpens[1]?.snapshot.session.receiveSessionId,
  );
  assert.deepEqual(concurrentOpens.map((result) => result.replayed).sort(), [
    false,
    true,
  ]);
  const concurrentContextRows = await pool.query<{
    id: string;
    receive_session_id: string;
    telegram_message_id: string;
  }>(
    `select id, receive_session_id, telegram_message_id::text
     from telegram_funding_sessions
     where receive_session_id = $1`,
    [concurrentOpens[0]?.snapshot.session.receiveSessionId],
  );
  assert.equal(
    concurrentContextRows.rowCount,
    1,
    "different callback idempotency keys must still create one context",
  );
  const concurrentContext = concurrentContextRows.rows[0];
  const concurrentReceiveExpiresAt =
    concurrentOpens[0]?.snapshot.session.expiresAt;
  assert.ok(concurrentContext);
  assert.ok(concurrentReceiveExpiresAt);
  await assert.rejects(
    createOrReuseTelegramFundingSession(pool, {
      userId,
      telegramAccountId,
      telegramUserId,
      chatId: telegramUserId,
      telegramMessageId: 301,
      receiveSessionId: concurrentContext.receive_session_id,
      idempotencyKey: `telegram-open-cross-message-bypass:${suffix}`,
      expiresAt: new Date(concurrentReceiveExpiresAt),
      now: new Date(now.getTime() + 540),
    }),
    (error: unknown) =>
      error instanceof TelegramFundingPersistenceError &&
      error.code === "telegram_funding_session_active_elsewhere",
    "low-level reuse must not bypass lifecycle terminalization by rebinding a message",
  );
  assert.ok(
    await cancelTelegramFundingSessionContext(pool, {
      contextId: concurrentContext.id,
      userId,
      telegramAccountId,
      telegramUserId,
      chatId: telegramUserId,
      telegramMessageId: Number(concurrentContext.telegram_message_id),
      idempotencyKey: `telegram-cancel-concurrent:${suffix}`,
      requestFingerprint: hash("cancel-concurrent-context"),
      responsePayload: { text: "cancelled" },
      now: new Date(now.getTime() + 550),
    }),
  );

  const ambiguousCanonical = await createOrReuseFundingReceiveSession(pool, {
    ...canonicalInput,
    destinationOptionId: `ambiguous-destination-${suffix}`,
    venueBindingOptionId: `ambiguous-binding-${suffix}`,
    ownershipRevision: `ambiguous-owner-${suffix}`,
    now: new Date(now.getTime() + 600),
  });
  const ambiguousContext = await createOrReuseTelegramFundingSession(pool, {
    userId,
    telegramAccountId,
    telegramUserId,
    chatId: telegramUserId,
    telegramMessageId: 204,
    receiveSessionId: ambiguousCanonical.snapshot.session.receiveSessionId,
    idempotencyKey: `telegram-open-ambiguous:${suffix}`,
    expiresAt: new Date(ambiguousCanonical.snapshot.session.expiresAt),
    now: new Date(now.getTime() + 600),
  });
  await assert.rejects(
    reuseActiveTelegramFundingSession(pool, {
      userId,
      telegramAccountId,
      telegramUserId,
      chatId: telegramUserId,
      telegramMessageId: 205,
      venueId: "polymarket",
      idempotencyKey: `telegram-open-ambiguous-replay:${suffix}`,
      requestFingerprint: openFingerprint({ telegramMessageId: 205 }),
      now: new Date(now.getTime() + 700),
    }),
    (error: unknown) =>
      error instanceof TelegramFundingPersistenceError &&
      error.code === "telegram_funding_active_context_ambiguous",
    "multiple active contexts for one venue must fail closed",
  );
  const ambiguousCancelled = await cancelTelegramFundingSessionContext(pool, {
    contextId: ambiguousContext.context.id,
    userId,
    telegramAccountId,
    telegramUserId,
    chatId: telegramUserId,
    telegramMessageId: 204,
    idempotencyKey: `telegram-cancel-ambiguous:${suffix}`,
    requestFingerprint: hash("cancel-ambiguous-context"),
    responsePayload: { text: "cancelled" },
    now: new Date(now.getTime() + 800),
  });
  assert.ok(ambiguousCancelled);
  assert.equal(
    (
      await reuseActiveTelegramFundingSession(pool, {
        userId,
        telegramAccountId,
        telegramUserId,
        chatId: telegramUserId,
        telegramMessageId: 101,
        venueId: "polymarket",
        idempotencyKey: `telegram-open-after-ambiguous-cancel:${suffix}`,
        requestFingerprint: openFingerprint({ telegramMessageId: 101 }),
        now: new Date(now.getTime() + 900),
      })
    )?.id,
    fundingContextId,
    "a cancelled context must not remain reusable",
  );

  const selectIdempotencyKey = `telegram-select:${suffix}`;
  const selectRequestFingerprint = canonicalJsonHash({
    action: "select_target",
    chatId: telegramUserId,
    choiceToken: "p",
    contextId: fundingContextId,
    telegramMessageId: 101,
    telegramUserId,
    userId,
  });
  const consentInput = {
    contextId: fundingContextId,
    userId,
    telegramAccountId,
    telegramUserId,
    chatId: telegramUserId,
    telegramMessageId: 101,
    controllerWalletId,
    receiveTargetId,
    asset: pUsd,
    variantIds: [pUsdVariantId],
    policySnapshot: directPolicySnapshot,
    fingerprint: hash("consent"),
    mutation: {
      idempotencyKey: selectIdempotencyKey,
      requestFingerprint: selectRequestFingerprint,
      responsePayload: { text: "verified pUSD address" },
    },
    now: new Date(now.getTime() + 1_000),
  };
  const exactManagedService = new TelegramFundingService(pool, {
    resolveManagedWallet: (input) =>
      resolveTelegramFundingManagedWalletIdentity(pool, input),
  });
  await pool.query(
    `update funding_receive_sessions
        set destination_option_id = $2
      where id = $1`,
    [receiveSessionId, `destination_after_balance_change_${suffix}`],
  );
  const refreshedInspectionMessage = await exactManagedService.session(
    {
      chatId: telegramUserId,
      contextId: fundingContextId,
      telegramUserId,
    },
    new Date(now.getTime() + 950),
  );
  assert.doesNotMatch(
    refreshedInspectionMessage.text,
    /Receive unavailable/u,
    "mutable destination inspection IDs must not invalidate the current managed wallet context",
  );
  await pool.query(
    `update funding_receive_sessions
        set destination_option_id = $2
      where id = $1`,
    [receiveSessionId, canonicalInput.destinationOptionId],
  );

  const replacementWalletAddress = "0x3333333333333333333333333333333333333333";
  const replacementPrivyWalletId = `replacement-privy-wallet-${suffix}`;
  await pool.query(
    `insert into user_wallets (
       user_id, wallet_address, wallet_type, is_primary, is_verified,
       privy_wallet_id, wallet_source, is_internal_wallet,
       privy_profile_updated_at
     ) values ($1, $2, 'ethereum', false, true, $3, 'embedded', true, $4)`,
    [userId, replacementWalletAddress, replacementPrivyWalletId, now],
  );
  await pool.query(
    `update telegram_bot_trading_authorizations
        set wallet_address = $2,
            privy_wallet_id = $3,
            updated_at = $4
      where user_id = $1
        and telegram_user_id = $5
        and wallet_chain = 'ethereum'`,
    [
      userId,
      replacementWalletAddress,
      replacementPrivyWalletId,
      new Date(now.getTime() + 975),
      telegramUserId,
    ],
  );
  const staleControllerMessage = await exactManagedService.session(
    {
      chatId: telegramUserId,
      contextId: fundingContextId,
      telegramUserId,
    },
    new Date(now.getTime() + 980),
  );
  assert.match(
    staleControllerMessage.text,
    /Receive unavailable/u,
    "a context for the previous wallet must not reveal its address after a managed wallet switch",
  );
  await assert.rejects(
    appendTelegramFundingConsent(pool, consentInput),
    (error: unknown) =>
      error instanceof TelegramFundingPersistenceError &&
      error.code === "telegram_funding_session_unavailable",
    "direct consent must recheck the exact managed controller under the lifecycle lock",
  );
  await pool.query(
    `update telegram_bot_trading_authorizations
        set wallet_address = $2,
            privy_wallet_id = $3,
            updated_at = $4
      where user_id = $1
        and telegram_user_id = $5
        and wallet_chain = 'ethereum'`,
    [
      userId,
      destinationAddress,
      privyWalletId,
      new Date(now.getTime() + 990),
      telegramUserId,
    ],
  );
  const staleAutomaticSelectionKey = `telegram-select-stale-automatic:${suffix}`;
  const signalPolicy = await pool.query<{ id: string }>(
    `insert into runtime_policies (
       policy_key, effective_at, payload, created_by
     ) values ('signal_bot', $1, $2::jsonb, null)
     returning id`,
    [
      new Date(Date.now() - 1_000),
      JSON.stringify({ fundingReceiveEnabled: true }),
    ],
  );
  signalPolicyId = signalPolicy.rows[0]?.id ?? null;
  assert.ok(signalPolicyId);
  await assert.rejects(
    exactManagedService.selectTarget(
      {
        chatId: telegramUserId,
        choiceToken: "a",
        contextId: fundingContextId,
        idempotencyKey: staleAutomaticSelectionKey,
        telegramMessageId: 101,
        telegramUserId,
      },
      new Date(now.getTime() + 995),
    ),
    (error: unknown) =>
      error instanceof TelegramFundingError &&
      error.code === "invalid_funding_choice",
    "a stale automatic choice must not be rewritten as direct pUSD consent",
  );
  const staleAutomaticMutation = await pool.query<{ count: string }>(
    `select count(*)::text as count
       from telegram_funding_mutations
      where idempotency_key = $1`,
    [staleAutomaticSelectionKey],
  );
  assert.equal(staleAutomaticMutation.rows[0]?.count, "0");
  const concurrentConsents = await Promise.all([
    appendTelegramFundingConsent(pool, consentInput),
    appendTelegramFundingConsent(pool, consentInput),
  ]);
  const firstConsent = concurrentConsents.find((result) => !result.replayed);
  const replayedConsent = concurrentConsents.find((result) => result.replayed);
  assert.ok(firstConsent);
  assert.ok(replayedConsent);
  assert.equal(replayedConsent.consent.revision, 1);
  assert.equal(replayedConsent.consent.automationEnabled, false);
  assert.equal(replayedConsent.consent.maximumAutomaticRaw, null);
  assert.deepEqual(replayedConsent.mutationResponse, {
    text: "verified pUSD address",
  });
  const buyAttachmentClient = await pool.connect();
  try {
    await buyAttachmentClient.query("begin");
    const attached = await prepareTelegramFundingSessionOpenInTransaction(
      buyAttachmentClient,
      {
        chatId: telegramUserId,
        controllerWalletId,
        destinationOptionId: canonicalInput.destinationOptionId,
        now: new Date(now.getTime() + 1_020),
        reuseActiveContextForBuyReturn: true,
        telegramAccountId,
        telegramMessageId: 999,
        telegramUserId,
        userId,
        venueBindingOptionId: canonicalInput.venueBindingOptionId,
        venueId: "polymarket",
      },
    );
    assert.equal(
      attached,
      null,
      "a consented address without an observed transfer is not active funding for a new Buy",
    );
  } finally {
    await buyAttachmentClient.query("rollback").catch(() => undefined);
    buyAttachmentClient.release();
  }
  const interactiveWaiting = await exactManagedService.session(
    {
      chatId: telegramUserId,
      contextId: fundingContextId,
      telegramUserId,
      view: "progress",
    },
    new Date(now.getTime() + 1_025),
  );
  assert.equal(interactiveWaiting.durableFundingDeliveryRequired, true);
  assert.equal(interactiveWaiting.qrText, undefined);
  assert.doesNotMatch(
    interactiveWaiting.text,
    new RegExp(destinationAddress, "iu"),
    "interactive callbacks must never receive the address-bearing render",
  );
  const waitingProjection = await runTelegramFundingProgressProjectionBatch(
    pool,
    { limit: 10, now: new Date(now.getTime() + 1_050) },
  );
  assert.equal(waitingProjection.created, 1);
  const frozenDeliveryProjection = await pool.query<{
    projection: unknown;
  }>(
    `select latest_progress_projection as projection
       from telegram_funding_sessions
      where id = $1`,
    [fundingContextId],
  );
  const deliveryWaiting = await exactManagedService.session(
    {
      chatId: telegramUserId,
      contextId: fundingContextId,
      deliveryProjection: frozenDeliveryProjection.rows[0]?.projection,
      telegramUserId,
      view: "delivery",
    },
    new Date(now.getTime() + 1_030),
  );
  assert.match(
    deliveryWaiting.text,
    new RegExp(destinationAddress, "iu"),
    "only the durable delivery view may materialize the address",
  );
  for (const unsafeAction of ["funding_send", "funding_replacement"] as const) {
    await assert.rejects(
      pool.query(
        `insert into telegram_bot_action_outbox (
           action, telegram_account_id, user_id, telegram_user_id,
           funding_session_id, state_revision, payload
         )
         select $2, context.telegram_account_id, context.user_id,
                context.telegram_user_id, context.id,
                context.progress_revision, context.latest_progress_projection
           from telegram_funding_sessions context
          where context.id = $1`,
        [fundingContextId, unsafeAction],
      ),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "23514" &&
        error.message.includes(
          "telegram_bot_action_outbox_address_egress_check",
        ),
      `${unsafeAction} must reject an address-bearing projection at the DB boundary`,
    );
  }
  let releaseAddressEdit!: () => void;
  let reportAddressEditStarted!: () => void;
  const addressEditStarted = new Promise<void>((resolve) => {
    reportAddressEditStarted = resolve;
  });
  const addressEditReleased = new Promise<void>((resolve) => {
    releaseAddressEdit = resolve;
  });
  const addressDeliveryPromise = deliverTelegramFundingActions({
    pool,
    renderCoordinator,
    telegram: {
      editMessageText: async (message) => {
        assert.match(message.text, new RegExp(destinationAddress, "u"));
        reportAddressEditStarted();
        await addressEditReleased;
        return { ok: true, messageId: 101 };
      },
      sendMessage: async () => {
        assert.fail("the selected funding card must be edited");
      },
    },
  });
  await addressEditStarted;
  const inFlightDisclosure = await pool.query<{
    address_disclosure_attempt_revision: number;
    address_disclosure_message_id: string;
  }>(
    `select
       address_disclosure_attempt_revision,
       address_disclosure_message_id::text
       from telegram_funding_sessions
      where id = $1`,
    [fundingContextId],
  );
  assert.deepEqual(inFlightDisclosure.rows[0], {
    address_disclosure_attempt_revision: 1,
    address_disclosure_message_id: "101",
  });
  const competingLifecycle = await pool.connect();
  try {
    await competingLifecycle.query("begin");
    await competingLifecycle.query("set local lock_timeout = '75ms'");
    await lockTelegramFundingLinkLifecycle(competingLifecycle, userId);
    await competingLifecycle.query("rollback");
    await competingLifecycle.query("begin");
    await competingLifecycle.query("set local lock_timeout = '75ms'");
    await competingLifecycle.query(
      "select pg_advisory_xact_lock(hashtext($1))",
      [FUNDING_POLICY_KEY],
    );
    await competingLifecycle.query("rollback");
  } finally {
    competingLifecycle.release();
  }
  releaseAddressEdit();
  const addressDelivery = await addressDeliveryPromise;
  assert.equal(addressDelivery.sent, 1);
  const addressProof = await pool.query<{
    address_disclosure_attempt_revision: number;
    address_disclosure_message_id: string;
    address_delivered_revision: number;
    last_delivered_revision: number;
  }>(
    `select
       address_disclosure_attempt_revision,
       address_disclosure_message_id::text,
       address_delivered_revision,
       last_delivered_revision
       from telegram_funding_sessions
      where id = $1`,
    [fundingContextId],
  );
  assert.deepEqual(addressProof.rows[0], {
    address_disclosure_attempt_revision: 1,
    address_disclosure_message_id: "101",
    address_delivered_revision: 1,
    last_delivered_revision: 1,
  });
  const currentAddressContext = await fetchTelegramFundingSessionContext(pool, {
    contextId: fundingContextId,
    userId,
    telegramUserId,
    chatId: telegramUserId,
  });
  assert.ok(currentAddressContext);
  assert.equal(
    await rearmTelegramFundingCurrentAddressDelivery({
      context: {
        ...currentAddressContext,
        progressRevision: currentAddressContext.progressRevision + 1,
      },
      pool,
      telegramAccountId,
      telegramUserId,
      userId,
    }),
    false,
    "a stale context revision must not rearm an unrelated durable response",
  );
  const claimBoundary = await pool.connect();
  const claimBoundaryAttemptId = crypto.randomUUID();
  try {
    await claimBoundary.query("begin");
    const lockedOutbox = await claimBoundary.query<{ id: string }>(
      `select id
         from telegram_bot_action_outbox
        where funding_session_id = $1
          and action = 'funding_edit'
        for update`,
      [fundingContextId],
    );
    const lockedOutboxId = lockedOutbox.rows[0]?.id;
    assert.ok(lockedOutboxId);
    const concurrentRearm = service.open(
      {
        chatId: telegramUserId,
        idempotencyKey: `telegram-open-during-claim:${suffix}`,
        telegramMessageId: 101,
        telegramUserId,
        venue: "polymarket",
      },
      new Date(now.getTime() + 1_070),
    );
    let rearmWaitingOnOutbox = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const waiting = await pool.query<{ waiting: boolean }>(
        `select exists (
           select 1
             from pg_stat_activity
            where datname = current_database()
              and pid <> pg_backend_pid()
              and wait_event_type = 'Lock'
              and query like '%insert into telegram_bot_action_outbox%'
         ) as waiting`,
      );
      rearmWaitingOnOutbox = waiting.rows[0]?.waiting === true;
      if (rearmWaitingOnOutbox) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(rearmWaitingOnOutbox, true);
    await claimBoundary.query(
      `update telegram_bot_action_outbox
          set status = 'sending',
              delivery_attempt_id = $2,
              delivery_started_at = now(),
              updated_at = now()
        where id = $1`,
      [lockedOutboxId, claimBoundaryAttemptId],
    );
    await claimBoundary.query("commit");
    assert.equal((await concurrentRearm).durableFundingDeliveryRequired, true);
    const preservedAttempt = await pool.query<{
      delivery_attempt_id: string;
      status: string;
    }>(
      `select delivery_attempt_id::text, status
         from telegram_bot_action_outbox
        where id = $1`,
      [lockedOutboxId],
    );
    assert.deepEqual(preservedAttempt.rows[0], {
      delivery_attempt_id: claimBoundaryAttemptId,
      status: "sending",
    });
    await pool.query(
      `update telegram_bot_action_outbox
          set status = 'sent',
              delivery_attempt_id = null,
              delivery_started_at = null,
              updated_at = now()
        where id = $1`,
      [lockedOutboxId],
    );
  } catch (error) {
    await claimBoundary.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    claimBoundary.release();
  }
  const reopenedAfterMenuOverwrite = await service.open(
    {
      chatId: telegramUserId,
      idempotencyKey: `telegram-open-after-menu-overwrite:${suffix}`,
      telegramMessageId: 101,
      telegramUserId,
      venue: "polymarket",
    },
    new Date(now.getTime() + 1_075),
  );
  assert.equal(reopenedAfterMenuOverwrite.fundingContextId, fundingContextId);
  assert.equal(reopenedAfterMenuOverwrite.durableFundingDeliveryRequired, true);
  const rearmedCurrentCard = await pool.query<{
    state_revision: number;
    status: string;
  }>(
    `select state_revision, status
       from telegram_bot_action_outbox
      where funding_session_id = $1
        and action = 'funding_edit'`,
    [fundingContextId],
  );
  assert.deepEqual(rearmedCurrentCard.rows, [
    { state_revision: 1, status: "pending" },
  ]);
  let redisplayedAddress = false;
  const redisplayedDelivery = await deliverTelegramFundingActions({
    pool,
    renderCoordinator,
    telegram: {
      editMessageText: async (message) => {
        redisplayedAddress = true;
        assert.equal(message.message_id, 101);
        assert.match(message.text, new RegExp(destinationAddress, "u"));
        return { ok: true, messageId: 101 };
      },
      sendMessage: async () => {
        assert.fail("a reused funding context must retain its edit target");
      },
    },
  });
  assert.equal(redisplayedDelivery.sent, 1);
  assert.equal(redisplayedAddress, true);
  // Simulate the crash boundary: Telegram accepted the address edit, but the
  // process lost the acknowledgement before durable success recording.
  await pool.query(
    `update telegram_funding_sessions
        set address_delivered_revision = 0,
            last_delivered_revision = 0
      where id = $1`,
    [fundingContextId],
  );
  await pool.query(
    `update telegram_bot_action_outbox
        set action = 'funding_send',
            status = 'delivery_unknown',
            payload = jsonb_set(payload, '{receiveAddress}', 'null'::jsonb),
            sent_at = null,
            last_error = 'simulated_address_ack_loss'
      where funding_session_id = $1
        and state_revision = 1
        and status = 'sent'`,
    [fundingContextId],
  );
  await pool.query(
    `update telegram_bot_trading_authorizations
        set wallet_address = $2,
            privy_wallet_id = $3,
            updated_at = $4
      where user_id = $1
        and telegram_user_id = $5
        and wallet_chain = 'ethereum'`,
    [
      userId,
      replacementWalletAddress,
      replacementPrivyWalletId,
      new Date(now.getTime() + 1_100),
      telegramUserId,
    ],
  );
  const staleControllerProjection =
    await runTelegramFundingProgressProjectionBatch(pool, {
      limit: 10,
      now: new Date(now.getTime() + 61_200),
    });
  assert.equal(staleControllerProjection.created, 1);
  const staleControllerProjectionEvidence = await pool.query<{
    action: string;
    outbox_count: string;
    progress_revision: number;
    state: string;
  }>(
    `select
       context.progress_revision,
       context.latest_progress_projection->>'state' as state,
       (
         select count(*)::text
         from telegram_bot_action_outbox outbox
         where outbox.funding_session_id = context.id
           and outbox.status in ('pending', 'retry', 'sending')
       ) as outbox_count,
       (
         select outbox.action
         from telegram_bot_action_outbox outbox
         where outbox.funding_session_id = context.id
           and outbox.state_revision = context.progress_revision
         limit 1
       ) as action
     from telegram_funding_sessions context
     where context.id = $1`,
    [fundingContextId],
  );
  assert.deepEqual(staleControllerProjectionEvidence.rows[0], {
    action: "funding_edit",
    outbox_count: "1",
    progress_revision: 2,
    state: "unavailable",
  });
  let redactionText = "";
  const redactionDelivery = await deliverTelegramFundingActions({
    pool,
    renderCoordinator,
    telegram: {
      editMessageText: async (message) => {
        redactionText = message.text;
        return { ok: true, messageId: 101 };
      },
      sendMessage: async () => {
        assert.fail("a disclosed address must be redacted in place");
      },
    },
  });
  assert.equal(redactionDelivery.sent, 1);
  assert.match(redactionText, /Receive unavailable/u);
  assert.doesNotMatch(redactionText, new RegExp(destinationAddress, "u"));
  // A relink/start recovery must retry the known address-free edit. A new
  // replacement card cannot prove that the old address card was overwritten.
  await pool.query(
    `update telegram_funding_sessions
        set address_redacted_revision = 0
      where id = $1`,
    [fundingContextId],
  );
  await pool.query(
    `update telegram_bot_action_outbox
        set status = 'retry', sent_at = null, updated_at = now()
      where funding_session_id = $1
        and action = 'funding_edit'
        and state_revision = 2`,
    [fundingContextId],
  );
  assert.ok(
    (await rearmTelegramFundingTerminalDelivery({
      pool,
      telegramUserId,
    })) >= 1,
  );
  const redactionRearm = await pool.query<{
    pending_edits: string;
    pending_replacements: string;
  }>(
    `select
       count(*) filter (
         where action = 'funding_edit' and status = 'pending'
       )::text as pending_edits,
       count(*) filter (
         where action = 'funding_replacement' and status = 'pending'
       )::text as pending_replacements
     from telegram_bot_action_outbox
     where funding_session_id = $1`,
    [fundingContextId],
  );
  assert.deepEqual(redactionRearm.rows[0], {
    pending_edits: "1",
    pending_replacements: "0",
  });
  const rearmedRedactionDelivery = await deliverTelegramFundingActions({
    pool,
    renderCoordinator,
    telegram: {
      editMessageText: async (message) => {
        assert.match(message.text, /Receive unavailable/u);
        assert.doesNotMatch(message.text, new RegExp(destinationAddress, "u"));
        return { ok: true, messageId: 101 };
      },
      sendMessage: async () => {
        assert.fail("rearmed redaction must edit the disclosed card");
      },
    },
  });
  assert.equal(rearmedRedactionDelivery.sent, 1);
  await pool.query(
    `update telegram_bot_trading_authorizations
        set wallet_address = $2,
            privy_wallet_id = $3,
            updated_at = $4
      where user_id = $1
        and telegram_user_id = $5
        and wallet_chain = 'ethereum'`,
    [
      userId,
      destinationAddress,
      privyWalletId,
      new Date(now.getTime() + 1_300),
      telegramUserId,
    ],
  );
  await pool.query(
    `update funding_receive_sessions
        set version = version + 1,
            updated_at = $2
      where id = $1`,
    [receiveSessionId, new Date(now.getTime() + 61_300)],
  );
  const restoredControllerProjection =
    await runTelegramFundingProgressProjectionBatch(pool, {
      limit: 10,
      now: new Date(now.getTime() + 61_300),
    });
  assert.equal(restoredControllerProjection.created, 0);
  assert.equal(
    restoredControllerProjection.skipped,
    restoredControllerProjection.candidates,
  );
  assert.ok(
    restoredControllerProjection.candidates >= 1,
    "the terminal redacted context must be inspected",
  );
  const absorbingTerminal = await pool.query<{
    address_redacted_revision: number;
    progress_revision: number;
    receive_address: string | null;
    state: string;
  }>(
    `select
       address_redacted_revision,
       progress_revision,
       latest_progress_projection->>'receiveAddress' as receive_address,
       latest_progress_projection->>'state' as state
     from telegram_funding_sessions
     where id = $1`,
    [fundingContextId],
  );
  assert.deepEqual(absorbingTerminal.rows[0], {
    address_redacted_revision: 2,
    progress_revision: 2,
    receive_address: null,
    state: "unavailable",
  });
  const staleDelivery = await exactManagedService.session(
    {
      chatId: telegramUserId,
      contextId: fundingContextId,
      deliveryProjection: frozenDeliveryProjection.rows[0]?.projection,
      telegramUserId,
      view: "delivery",
    },
    new Date(now.getTime() + 61_350),
  );
  assert.match(staleDelivery.text, /Receive unavailable/u);
  assert.doesNotMatch(staleDelivery.text, new RegExp(destinationAddress, "iu"));
  const staleQr = await exactManagedService.session(
    {
      chatId: telegramUserId,
      contextId: fundingContextId,
      telegramUserId,
      view: "address",
    },
    new Date(now.getTime() + 61_400),
  );
  assert.match(staleQr.text, /Receive unavailable/u);
  assert.doesNotMatch(staleQr.text, new RegExp(destinationAddress, "iu"));
  let staleProgressDecorations = 0;
  const staleProgress = await exactManagedService.session(
    {
      chatId: telegramUserId,
      contextId: fundingContextId,
      telegramUserId,
      view: "progress",
    },
    new Date(now.getTime() + 61_425),
    async () => {
      staleProgressDecorations += 1;
      return {
        parse_mode: "MarkdownV2",
        text: "Review Buy must not revive a terminal context",
      };
    },
  );
  assert.match(staleProgress.text, /Receive unavailable/u);
  assert.equal(
    staleProgressDecorations,
    0,
    "interactive progress cannot decorate a retained non-ready terminal state",
  );
  const lateReadyClient = await pool.connect();
  let lateReadyReceiptId = "";
  try {
    await lateReadyClient.query("begin");
    const inserted = await insertFundingReceiveReceipt(lateReadyClient, {
      receiveSessionId,
      userId,
      variantId: pUsdVariantId,
      asset: pUsd,
      destinationAddress,
      rawAmount: "1",
      observationRevision: `late_ready_${suffix}`,
      canonicalEvent: {
        transactionHash: `0x${hash("late-ready-tx")}`,
        eventIndex: "9",
        ledgerHeight: "99",
        blockHash: `0x${hash("late-ready-block")}`,
        sourceAddress: "0x2222222222222222222222222222222222222222",
      },
      observedAt: new Date(now.getTime() + 61_430),
      status: "ready",
      handling: "direct",
      evidence: { canonical: true },
      now: new Date(now.getTime() + 61_430),
    });
    lateReadyReceiptId = inserted.receipt.receiptId;
    await lateReadyClient.query(
      `update funding_receive_sessions
          set status = 'completed',
              closed_at = $2,
              version = version + 1,
              updated_at = $2
        where id = $1`,
      [receiveSessionId, new Date(now.getTime() + 61_430)],
    );
    await lateReadyClient.query("commit");
  } catch (error) {
    await lateReadyClient.query("rollback");
    throw error;
  } finally {
    lateReadyClient.release();
  }
  assert.deepEqual(
    await runTelegramFundingProgressProjectionBatch(pool, {
      limit: 10,
      now: new Date(now.getTime() + 61_435),
    }),
    { candidates: 1, created: 0, skipped: 1 },
    "a late ready receipt cannot replace the first retained terminal state",
  );
  const terminalAfterLateReady = await pool.query<{ state: string }>(
    `select latest_terminal_projection->>'state' as state
       from telegram_funding_sessions
      where id = $1`,
    [fundingContextId],
  );
  assert.equal(terminalAfterLateReady.rows[0]?.state, "unavailable");
  const lateReadyCleanupClient = await pool.connect();
  try {
    await lateReadyCleanupClient.query("begin");
    await lateReadyCleanupClient.query(
      "set local session_replication_role = replica",
    );
    await lateReadyCleanupClient.query(
      `delete from funding_receive_canonical_events
        where allocated_receipt_id = $1`,
      [lateReadyReceiptId],
    );
    await lateReadyCleanupClient.query(
      `delete from funding_receive_receipts where id = $1`,
      [lateReadyReceiptId],
    );
    await lateReadyCleanupClient.query(
      `update funding_receive_sessions
          set status = 'open', closed_at = null, version = version + 1
        where id = $1`,
      [receiveSessionId],
    );
    await lateReadyCleanupClient.query("commit");
  } catch (error) {
    await lateReadyCleanupClient.query("rollback");
    throw error;
  } finally {
    lateReadyCleanupClient.release();
  }
  await pool.query(
    `update telegram_funding_sessions
        set latest_progress_projection = $2::jsonb,
            latest_terminal_projection = $2::jsonb,
            progress_fingerprint = 'malformed-terminal-regression',
            projection_checked_at = null
      where id = $1`,
    [fundingContextId, JSON.stringify({ version: 1 })],
  );
  const malformedTerminalProgress = await exactManagedService.session(
    {
      chatId: telegramUserId,
      contextId: fundingContextId,
      telegramUserId,
      view: "progress",
    },
    new Date(now.getTime() + 61_440),
  );
  assert.match(malformedTerminalProgress.text, /Receive unavailable/u);
  const repairedMalformedTerminal =
    await runTelegramFundingProgressProjectionBatch(pool, {
      limit: 10,
      now: new Date(now.getTime() + 61_450),
    });
  assert.deepEqual(repairedMalformedTerminal, {
    candidates: 1,
    created: 1,
    skipped: 0,
  });
  const repairedTerminal = await pool.query<{
    receive_address: string | null;
    state: string;
    version: string;
  }>(
    `select
       latest_progress_projection->>'receiveAddress' as receive_address,
       latest_progress_projection->>'state' as state,
       latest_progress_projection->>'version' as version
     from telegram_funding_sessions
     where id = $1`,
    [fundingContextId],
  );
  assert.deepEqual(repairedTerminal.rows[0], {
    receive_address: null,
    state: "unavailable",
    version: "2",
  });
  await pool.query(
    `delete from telegram_bot_action_outbox
      where funding_session_id = $1`,
    [fundingContextId],
  );
  await pool.query(
    `update telegram_funding_sessions
        set progress_revision = 0,
            progress_fingerprint = null,
            latest_progress_projection = null,
            latest_terminal_revision = null,
            latest_terminal_projection = null,
            address_disclosure_attempt_revision = 0,
            address_disclosure_message_id = null,
            address_delivered_revision = 0,
            address_redacted_revision = 0,
            last_delivered_revision = 0,
            projected_receive_version = 0,
            projected_consent_revision = 0,
            projection_checked_at = null,
            delivery_lease_outbox_id = null,
            delivery_lease_attempt_id = null,
            delivery_lease_expires_at = null
      where id = $1`,
    [fundingContextId],
  );
  const selectedReplay = await service.open(
    {
      chatId: telegramUserId,
      idempotencyKey: `telegram-open-after-consent:${suffix}`,
      telegramMessageId: 101,
      telegramUserId,
      venue: "polymarket",
    },
    new Date(now.getTime() + 1_500),
  );
  assert.equal(selectedReplay.fundingContextId, fundingContextId);
  assert.equal(selectedReplay.durableFundingDeliveryRequired, true);
  assert.match(selectedReplay.text, /Receive update queued/u);
  assert.doesNotMatch(selectedReplay.text, new RegExp(destinationAddress, "u"));
  const unchangedReplayEvidence = await pool.query<{
    consents: string;
    mutations: string;
    outbox: string;
    progress_revision: number;
  }>(
    `select
       (select count(*)::text from telegram_funding_consents where telegram_funding_session_id = context.id) as consents,
       (select count(*)::text from telegram_funding_mutations where funding_context_id = context.id) as mutations,
       (select count(*)::text from telegram_bot_action_outbox where funding_session_id = context.id) as outbox,
       context.progress_revision
     from telegram_funding_sessions context
     where context.id = $1`,
    [fundingContextId],
  );
  assert.deepEqual(unchangedReplayEvidence.rows[0], {
    consents: "1",
    mutations: "8",
    outbox: "0",
    progress_revision: 0,
  });
  await assert.rejects(
    appendTelegramFundingConsent(pool, {
      ...consentInput,
      mutation: {
        ...consentInput.mutation,
        requestFingerprint: hash("different-select-request"),
      },
    }),
    (error: unknown) =>
      error instanceof TelegramFundingPersistenceError &&
      error.code === "telegram_funding_idempotency_conflict",
  );
  const lifecycle = await fetchUserFinancialLifecycleSummary(pool, [userId]);
  assert.ok(
    lifecycle.activeReasons.includes("active_telegram_funding_context"),
  );
  assert.ok(lifecycle.protectedReasons.includes("telegram_funding_evidence"));

  await assert.rejects(
    pool.query(
      `update telegram_funding_consents
       set selected_asset_decimals = 18
       where id = $1`,
      [firstConsent.consent.id],
    ),
    /append-only/,
  );
  await assert.rejects(
    pool.query(
      `insert into telegram_funding_sessions (
         user_id, telegram_account_id, telegram_user_id, chat_id,
         receive_session_id, origin, idempotency_key, expires_at
       ) values ($1, $2, $3, '-100123', $4, 'generic_add_funds', $5, $6)`,
      [
        userId,
        telegramAccountId,
        telegramUserId,
        receiveSessionId,
        `telegram-cross-chat:${suffix}`,
        new Date(now.getTime() + 86_400_000),
      ],
    ),
    /private_chat_check/,
  );

  const receiptClient = await pool.connect();
  try {
    await receiptClient.query("begin");
    await insertFundingReceiveReceipt(receiptClient, {
      receiveSessionId,
      userId,
      variantId: pUsdVariantId,
      asset: pUsd,
      destinationAddress,
      rawAmount: "2500000",
      observationRevision: `pusd_observation_${suffix}`,
      canonicalEvent: {
        transactionHash: `0x${hash("pusd-tx")}`,
        eventIndex: "1",
        ledgerHeight: "100",
        blockHash: `0x${hash("pusd-block")}`,
        sourceAddress: "0x2222222222222222222222222222222222222222",
      },
      observedAt: new Date(now.getTime() + 2_000),
      status: "ready",
      handling: "direct",
      evidence: { canonical: true },
      now: new Date(now.getTime() + 2_000),
    });
    await receiptClient.query("commit");
  } catch (error) {
    await receiptClient.query("rollback");
    throw error;
  } finally {
    receiptClient.release();
  }

  await assert.rejects(
    appendTelegramFundingConsent(pool, {
      ...consentInput,
      fingerprint: hash("consent-after-receipt"),
      mutation: {
        idempotencyKey: `telegram-select-after-receipt:${suffix}`,
        requestFingerprint: hash("select-after-receipt-request"),
        responsePayload: { text: "must not disclose an address" },
      },
      now: new Date(now.getTime() + 2_100),
    }),
    (error: unknown) =>
      error instanceof TelegramFundingPersistenceError &&
      error.code === "telegram_funding_session_unavailable",
    "receipt evidence must fence any later consent or address disclosure",
  );

  const concurrentProjection = await Promise.all([
    runTelegramFundingProgressProjectionBatch(pool, {
      limit: 10,
      now: new Date(now.getTime() + 3_000),
    }),
    runTelegramFundingProgressProjectionBatch(pool, {
      limit: 10,
      now: new Date(now.getTime() + 3_000),
    }),
  ]);
  const concurrentProjectionEvidence = await pool.query<{
    cancelled: boolean;
    context_id: string;
    progress_revision: number;
    state: string | null;
  }>(
    `select id as context_id,
            cancelled_at is not null as cancelled,
            progress_revision,
            latest_progress_projection->>'state' as state
       from telegram_funding_sessions
      where user_id = $1::uuid
      order by id`,
    [userId],
  );
  assert.equal(
    concurrentProjection.reduce((total, result) => total + result.created, 0),
    1,
    JSON.stringify({
      concurrentProjection,
      evidence: concurrentProjectionEvidence.rows,
    }),
  );
  const firstProgress = await pool.query<{
    progress_revision: number;
    state: string;
    outbox_count: string;
  }>(
    `select
       context.progress_revision,
       context.latest_progress_projection->>'state' as state,
       (
         select count(*)::text
         from telegram_bot_action_outbox outbox
         where outbox.funding_session_id = context.id
           and outbox.state_revision = context.progress_revision
       ) as outbox_count
     from telegram_funding_sessions context
     where context.id = $1`,
    [fundingContextId],
  );
  assert.deepEqual(firstProgress.rows[0], {
    progress_revision: 1,
    state: "ready",
    outbox_count: "1",
  });
  assert.equal(
    await reuseActiveTelegramFundingSession(pool, {
      userId,
      telegramAccountId,
      telegramUserId,
      chatId: telegramUserId,
      telegramMessageId: 207,
      venueId: "polymarket",
      idempotencyKey: `telegram-open-terminal-probe:${suffix}`,
      requestFingerprint: openFingerprint({ telegramMessageId: 207 }),
      now: new Date(now.getTime() + 3_100),
    }),
    null,
    "a terminal context must not be reopened",
  );
  const terminalOpenReplay = await service.open(
    {
      chatId: telegramUserId,
      idempotencyKey: `telegram-open:${suffix}`,
      telegramMessageId: 209,
      telegramUserId,
      venue: "polymarket",
    },
    new Date(now.getTime() + 3_100),
  );
  assert.match(terminalOpenReplay.text, /pUSD ready/u);
  const terminalAliasReplay = await service.open(
    {
      chatId: telegramUserId,
      idempotencyKey: `telegram-open-new-callback:${suffix}`,
      telegramMessageId: 101,
      telegramUserId,
      venue: "polymarket",
    },
    new Date(now.getTime() + 3_100),
  );
  assert.equal(terminalAliasReplay.fundingContextId, fundingContextId);
  assert.match(
    terminalAliasReplay.text,
    /pUSD ready/u,
    "every accepted open key must replay the original context after terminal",
  );
  const safeTerminalReplay = await new TelegramFundingService(
    pool,
  ).selectTarget(
    {
      chatId: telegramUserId,
      choiceToken: "p",
      contextId: fundingContextId,
      idempotencyKey: selectIdempotencyKey,
      telegramMessageId: 101,
      telegramUserId,
    },
    new Date(now.getTime() + 3_100),
  );
  assert.doesNotMatch(
    safeTerminalReplay.text,
    new RegExp(destinationAddress, "iu"),
    "an exact select replay must not redisclose a terminal address",
  );
  assert.match(safeTerminalReplay.text, /pUSD ready/u);
  let editCalls = 0;
  let releaseEdit!: () => void;
  let reportEditStarted!: () => void;
  const editStarted = new Promise<void>((resolve) => {
    reportEditStarted = resolve;
  });
  const editReleased = new Promise<void>((resolve) => {
    releaseEdit = resolve;
  });
  const deliveryClient = {
    editMessageText: async () => {
      editCalls += 1;
      reportEditStarted();
      await editReleased;
      return { ok: true as const, messageId: 101 };
    },
    sendMessage: async () => {
      assert.fail("an editable progress card must not fall back to send");
    },
  };
  const concurrentDeliveriesPromise = Promise.all([
    deliverTelegramFundingActions({
      pool,
      renderCoordinator,
      telegram: deliveryClient,
    }),
    deliverTelegramFundingActions({
      pool,
      renderCoordinator,
      telegram: deliveryClient,
    }),
  ]);
  await editStarted;
  await pool.query(
    `update telegram_funding_sessions
     set telegram_message_id = 202
     where id = $1`,
    [fundingContextId],
  );
  releaseEdit();
  const concurrentDeliveries = await concurrentDeliveriesPromise;
  assert.equal(
    concurrentDeliveries.reduce((total, result) => total + result.sent, 0),
    1,
    JSON.stringify(concurrentDeliveries),
  );
  assert.equal(editCalls, 1);
  const currentMessage = await pool.query<{ telegram_message_id: string }>(
    `select telegram_message_id::text
     from telegram_funding_sessions
     where id = $1`,
    [fundingContextId],
  );
  assert.equal(
    currentMessage.rows[0]?.telegram_message_id,
    "202",
    "an old edit completing on M1 must not reattach the context away from M2",
  );

  const usdceClient = await pool.connect();
  try {
    await usdceClient.query("begin");
    await insertFundingReceiveReceipt(usdceClient, {
      receiveSessionId,
      userId,
      variantId: usdceVariantId,
      asset: usdce,
      destinationAddress,
      rawAmount: "3000000",
      observationRevision: `usdce_observation_${suffix}`,
      canonicalEvent: {
        transactionHash: `0x${hash("usdce-tx")}`,
        eventIndex: "2",
        ledgerHeight: "101",
        blockHash: `0x${hash("usdce-block")}`,
        sourceAddress: "0x3333333333333333333333333333333333333333",
      },
      observedAt: new Date(now.getTime() + 4_000),
      status: "observed",
      handling: "automatic_conversion",
      evidence: { canonical: true },
      now: new Date(now.getTime() + 4_000),
    });
    await usdceClient.query("commit");
  } catch (error) {
    await usdceClient.query("rollback");
    throw error;
  } finally {
    usdceClient.release();
  }
  const routable = await listFundingReceiveReceiptsForRouting(pool, {
    limit: 25,
    now: new Date(now.getTime() + 5_000),
  });
  assert.equal(
    routable.some(
      (target) => target.receipt.receiveSessionId === receiveSessionId,
    ),
    false,
    "direct pUSD Telegram consent must not authorize USDC.e routing",
  );
  await pool.query(
    `insert into telegram_funding_consents (
       telegram_funding_session_id,
       revision,
       selected_receive_target_id,
       selected_asset_network_id,
       selected_asset_id,
       selected_asset_decimals,
       consented_variant_ids,
       automation_enabled,
       max_auto_execute_source_raw,
       automation_policy_snapshot,
       consent_fingerprint,
       consented_at
     ) values ($1, 2, $2, $3, $4, $5, $6::text[], true, $7, $8::jsonb, $9, $10)`,
    [
      fundingContextId,
      receiveTargetId,
      usdce.networkId,
      usdce.assetId,
      usdce.decimals,
      [usdceVariantId],
      "10000000",
      JSON.stringify({
        mode: "future_automatic_test",
        presentationMode: "pusd_or_usdce_automatic",
        presentation: telegramPolygonFundingPresentation(
          "pusd_or_usdce_automatic",
        ),
      }),
      hash("late-automatic-consent"),
      new Date(now.getTime() + 6_000),
    ],
  );
  await pool.query(
    `update telegram_funding_sessions
     set active_consent_revision = 2
     where id = $1`,
    [fundingContextId],
  );
  const afterLateConsent = await listFundingReceiveReceiptsForRouting(pool, {
    limit: 25,
    now: new Date(now.getTime() + 7_000),
  });
  assert.equal(
    afterLateConsent.some(
      (target) => target.receipt.receiveSessionId === receiveSessionId,
    ),
    false,
    "a consent recorded after observation must not authorize an old receipt",
  );
  const attentionProjection = await runTelegramFundingProgressProjectionBatch(
    pool,
    { limit: 10, now: new Date(now.getTime() + 5_000) },
  );
  assert.equal(
    attentionProjection.created,
    0,
    "a later terminal attention state cannot replace the first ready terminal",
  );
  const latest = await pool.query<{ revision: number; state: string }>(
    `select progress_revision as revision,
            latest_progress_projection->>'state' as state
     from telegram_funding_sessions where id = $1`,
    [fundingContextId],
  );
  assert.deepEqual(latest.rows[0], { revision: 1, state: "ready" });

  // Start an isolated terminal-delivery fixture for the unlink/relink checks
  // below. Production never clears the retained terminal watermark.
  await pool.query(
    `update telegram_funding_sessions
        set latest_terminal_revision = null,
            latest_terminal_projection = null,
            projection_checked_at = null
      where id = $1`,
    [fundingContextId],
  );
  const terminalAttentionProjection =
    await runTelegramFundingProgressProjectionBatch(pool, {
      limit: 10,
      now: new Date(now.getTime() + 5_001),
    });
  assert.equal(terminalAttentionProjection.created, 1);
  const terminalAttention = await pool.query<{
    revision: number;
    state: string;
  }>(
    `select progress_revision as revision,
            latest_progress_projection->>'state' as state
       from telegram_funding_sessions where id = $1`,
    [fundingContextId],
  );
  assert.deepEqual(terminalAttention.rows[0], {
    revision: 2,
    state: "needs_attention",
  });

  await pool.query(`delete from user_telegram_accounts where id = $1`, [
    telegramAccountId,
  ]);
  const unlinkedDelivery = await deliverTelegramFundingActions({
    pool,
    renderCoordinator,
    telegram: {
      editMessageText: async () => {
        assert.fail("unlinked funding progress must not edit Telegram");
      },
      sendMessage: async () => {
        assert.fail("unlinked funding progress must not send Telegram");
      },
    },
  });
  assert.equal(unlinkedDelivery.skipped, 1);

  const relink = await pool.query<{ id: string }>(
    `insert into user_telegram_accounts (
       user_id, privy_user_id, telegram_user_id, username
     ) values ($1, $2, $3, 'telegram-funding-relinked')
     returning id`,
    [userId, `did:privy:${suffix}:relinked`, telegramUserId],
  );
  const relinkedTelegramAccountId = relink.rows[0]?.id;
  assert.ok(relinkedTelegramAccountId);
  const rearmed = await pool.query<{
    pending_edits: string;
    pending_replacements: string;
  }>(
    `select
       count(*) filter (
         where action = 'funding_edit' and status = 'pending'
       )::text as pending_edits,
       count(*) filter (
         where action = 'funding_replacement' and status = 'pending'
       )::text as pending_replacements
     from telegram_bot_action_outbox
     where funding_session_id = $1 and state_revision = 2`,
    [fundingContextId],
  );
  assert.deepEqual(rearmed.rows[0], {
    pending_edits: "1",
    pending_replacements: "0",
  });
  const relinkWithoutManagedTrading = await deliverTelegramFundingActions({
    pool,
    renderCoordinator,
    telegram: {
      editMessageText: async () => {
        assert.fail("a bare relink must not edit a stale funding card");
      },
      sendMessage: async () => {
        assert.fail("a bare relink must not send a stale funding card");
      },
    },
  });
  assert.equal(relinkWithoutManagedTrading.skipped, 1);
  await pool.query(
    `update telegram_bot_action_outbox
        set status = 'pending',
            attempt_count = 0,
            next_attempt_at = now(),
            last_error = null,
            delivery_attempt_id = null,
            delivery_started_at = null,
            updated_at = now()
      where funding_session_id = $1
        and state_revision = 2
        and action = 'funding_edit'
        and status = 'skipped'`,
    [fundingContextId],
  );
  await enableManagedTrading(telegramUserId, `did:privy:${suffix}:relinked`);
  let ownerEdits = 0;
  const ownerEditDelivery = await deliverTelegramFundingActions({
    pool,
    renderCoordinator,
    telegram: {
      editMessageText: async (message) => {
        ownerEdits += 1;
        assert.equal(message.message_id, 202);
        return { ok: true, messageId: 202 };
      },
      sendMessage: async () => {
        assert.fail("relink must never copy-send an owned funding context");
      },
    },
  });
  assert.equal(ownerEditDelivery.sent, 1);
  assert.equal(ownerEdits, 1);
  await pool.query(`delete from user_telegram_accounts where id = $1`, [
    relinkedTelegramAccountId,
  ]);
  const retained = await pool.query<{
    telegram_account_id: string | null;
    telegram_user_id: string;
  }>(
    `select telegram_account_id, telegram_user_id
     from telegram_funding_sessions where id = $1`,
    [fundingContextId],
  );
  assert.deepEqual(retained.rows[0], {
    telegram_account_id: null,
    telegram_user_id: telegramUserId,
  });

  const ageClient = await pool.connect();
  try {
    await ageClient.query("begin");
    await ageClient.query("set local session_replication_role = replica");
    await ageClient.query(
      `update funding_receive_sessions
       set status = 'completed', closed_at = now(), updated_at = now()
       where id = $1`,
      [receiveSessionId],
    );
    await ageClient.query(
      `update telegram_funding_sessions
       set updated_at = now() - interval '31 days'
       where id = $1`,
      [fundingContextId],
    );
    await ageClient.query("commit");
  } catch (error) {
    await ageClient.query("rollback");
    throw error;
  } finally {
    ageClient.release();
  }
  assert.equal(
    await cleanupTelegramFundingContexts({
      pool,
      retentionDays: 30,
      limit: 10,
    }),
    0,
    "non-terminal receipt evidence must block context cleanup",
  );
  await pool.query(
    `update funding_receive_receipts
     set status = 'ready', updated_at = now()
     where receive_session_id = $1 and variant_id = $2`,
    [receiveSessionId, usdceVariantId],
  );
  assert.equal(
    await cleanupTelegramFundingContexts({
      pool,
      retentionDays: 30,
      limit: 10,
    }),
    1,
    "terminal retained context must be safely cleaned exactly once",
  );

  const fairnessTelegramUserId = `8${Date.now()}`;
  const fairnessAccount = await pool.query<{ id: string }>(
    `insert into user_telegram_accounts (
       user_id, privy_user_id, telegram_user_id, username
     ) values ($1, $2, $3, 'telegram-funding-fairness')
     returning id`,
    [userId, `did:privy:${suffix}:fairness`, fairnessTelegramUserId],
  );
  const fairnessTelegramAccountId = fairnessAccount.rows[0]?.id;
  assert.ok(fairnessTelegramAccountId);
  await enableManagedTrading(
    fairnessTelegramUserId,
    `did:privy:${suffix}:fairness`,
  );
  const fairnessReceiveIds: string[] = [];
  const fairnessContextIds: string[] = [];
  let fairnessCleanupFailure: unknown;
  try {
    for (let index = 0; index < 26; index += 1) {
      const created = await createOrReuseFundingReceiveSession(pool, {
        ...canonicalInput,
        destinationOptionId: `fair-destination-${index}-${suffix}`,
        venueBindingOptionId: `fair-binding-${index}-${suffix}`,
        policyRevision: `fair-policy-${index}-${suffix}`,
        ownershipRevision: `fair-owner-${index}-${suffix}`,
        now: new Date(now.getTime() + 10_000 + index),
      });
      const fairReceiveId = created.snapshot.session.receiveSessionId;
      fairnessReceiveIds.push(fairReceiveId);
      const fairContext = await createOrReuseTelegramFundingSession(pool, {
        userId,
        telegramAccountId: fairnessTelegramAccountId,
        telegramUserId: fairnessTelegramUserId,
        chatId: fairnessTelegramUserId,
        telegramMessageId: 500 + index,
        receiveSessionId: fairReceiveId,
        idempotencyKey: `fair-open-${index}-${suffix}`,
        expiresAt: new Date(
          now.getTime() + (index === 2 ? 26_000 : 86_400_000),
        ),
        now: new Date(now.getTime() + 11_000 + index),
      });
      fairnessContextIds.push(fairContext.context.id);
      await appendTelegramFundingConsent(pool, {
        contextId: fairContext.context.id,
        userId,
        telegramAccountId: fairnessTelegramAccountId,
        telegramUserId: fairnessTelegramUserId,
        chatId: fairnessTelegramUserId,
        telegramMessageId: 500 + index,
        controllerWalletId,
        receiveTargetId,
        asset: pUsd,
        variantIds: [pUsdVariantId],
        policySnapshot: directPolicySnapshot,
        fingerprint: hash(`fair-consent-${index}`),
        mutation: {
          idempotencyKey: `fair-select-${index}-${suffix}`,
          requestFingerprint: hash(`fair-select-request-${index}`),
          responsePayload: { text: `fair-${index}` },
        },
        now: new Date(now.getTime() + 12_000 + index),
      });
    }
    const initialFairnessProjection =
      await runTelegramFundingProgressProjectionBatch(pool, {
        limit: 100,
        now: new Date(now.getTime() + 20_000),
      });
    assert.equal(initialFairnessProjection.created, 26);
    const readyReceiveId = fairnessReceiveIds[25];
    const readyContextId = fairnessContextIds[25];
    assert.ok(readyReceiveId);
    assert.ok(readyContextId);
    await pool.query(
      `update telegram_funding_sessions
       set telegram_message_id = null
       where id = $1`,
      [readyContextId],
    );
    await pool.query(
      `update telegram_funding_sessions
       set projection_checked_at = case
         when id = $2 then $3::timestamptz + interval '1 hour'
         else $3::timestamptz
       end
       where id = any($1::uuid[])`,
      [fairnessContextIds, readyContextId, new Date(now.getTime() + 21_000)],
    );
    await pool.query(
      `update funding_receive_sessions
       set version = version + 1, updated_at = $2
       where id = any($1::uuid[])`,
      [fairnessReceiveIds, new Date(now.getTime() + 22_000)],
    );
    const readyReceiptClient = await pool.connect();
    try {
      await readyReceiptClient.query("begin");
      await insertFundingReceiveReceipt(readyReceiptClient, {
        receiveSessionId: readyReceiveId,
        userId,
        variantId: pUsdVariantId,
        asset: pUsd,
        destinationAddress,
        rawAmount: "1000000",
        observationRevision: `fair-ready-${suffix}`,
        canonicalEvent: {
          transactionHash: `0x${hash("fair-ready-tx")}`,
          eventIndex: "26",
          ledgerHeight: "126",
          blockHash: `0x${hash("fair-ready-block")}`,
          sourceAddress: "0x4444444444444444444444444444444444444444",
        },
        observedAt: new Date(now.getTime() + 23_000),
        status: "ready",
        handling: "direct",
        evidence: { canonical: true },
        now: new Date(now.getTime() + 23_000),
      });
      await readyReceiptClient.query(
        `update funding_receive_sessions
         set version = version + 1, updated_at = $2
         where id = $1`,
        [readyReceiveId, new Date(now.getTime() + 23_000)],
      );
      await readyReceiptClient.query("commit");
    } catch (error) {
      await readyReceiptClient.query("rollback");
      throw error;
    } finally {
      readyReceiptClient.release();
    }
    const unchangedBatch = await runTelegramFundingProgressProjectionBatch(
      pool,
      { limit: 25, now: new Date(now.getTime() + 24_000) },
    );
    assert.deepEqual(unchangedBatch, {
      candidates: 25,
      created: 0,
      skipped: 25,
    });
    const readyBatch = await runTelegramFundingProgressProjectionBatch(pool, {
      limit: 25,
      now: new Date(now.getTime() + 25_000),
    });
    assert.equal(readyBatch.created, 1);
    const fairnessReady = await pool.query<{
      progress_revision: number;
      state: string;
    }>(
      `select progress_revision,
              latest_progress_projection->>'state' as state
       from telegram_funding_sessions
       where id = $1`,
      [readyContextId],
    );
    assert.deepEqual(fairnessReady.rows[0], {
      progress_revision: 2,
      state: "ready",
    });
    const supersededPending = await pool.query<{ status: string }>(
      `select status
       from telegram_bot_action_outbox
       where funding_session_id = $1
         and state_revision = 1
         and action = 'funding_edit'`,
      [readyContextId],
    );
    assert.equal(
      supersededPending.rows[0]?.status,
      "skipped",
      "publishing a new revision must retire older pending delivery rows",
    );
    await pool.query(
      `delete from telegram_bot_action_outbox
       where funding_session_id = any($1::uuid[])
         and not (funding_session_id = $2 and state_revision = 2)`,
      [fairnessContextIds, readyContextId],
    );
    let supersededSendCalls = 0;
    const supersededDelivery = await deliverTelegramFundingActions({
      pool,
      renderCoordinator,
      telegram: {
        editMessageText: async () => {
          assert.fail("the first progress card must use funding_send");
        },
        sendMessage: async () => {
          supersededSendCalls += 1;
          await pool.query(
            `update telegram_funding_sessions
             set progress_revision = 3,
                 progress_fingerprint = $2,
                 latest_terminal_revision = 3
             where id = $1`,
            [readyContextId, hash("superseded-progress")],
          );
          await pool.query(
            `insert into telegram_bot_action_outbox (
               action,
               telegram_account_id,
               user_id,
               telegram_user_id,
               funding_session_id,
               state_revision,
               payload
             )
             select
               'funding_send',
               telegram_account_id,
               user_id,
               telegram_user_id,
               id,
               progress_revision,
               latest_progress_projection
             from telegram_funding_sessions
             where id = $1`,
            [readyContextId],
          );
          return { ok: true, messageId: 900 };
        },
      },
    });
    assert.equal(supersededDelivery.sent, 1);
    assert.equal(supersededSendCalls, 1);
    const supersededState = await pool.query<{
      last_delivered_revision: number;
      progress_revision: number;
      telegram_message_id: string;
      edit_count: string;
      retired_send_count: string;
    }>(
      `select
         context.last_delivered_revision,
         context.progress_revision,
         context.telegram_message_id::text,
         count(*) filter (
           where outbox.state_revision = 3
             and outbox.action = 'funding_edit'
             and outbox.status = 'pending'
         )::text as edit_count,
         count(*) filter (
           where outbox.state_revision = 3
             and outbox.action = 'funding_send'
             and outbox.status = 'skipped'
         )::text as retired_send_count
       from telegram_funding_sessions context
       left join telegram_bot_action_outbox outbox
         on outbox.funding_session_id = context.id
       where context.id = $1
       group by context.id`,
      [readyContextId],
    );
    assert.deepEqual(supersededState.rows[0], {
      last_delivered_revision: 2,
      progress_revision: 3,
      telegram_message_id: "900",
      edit_count: "1",
      retired_send_count: "1",
    });
    await pool.query(
      `update telegram_bot_action_outbox
       set status = 'skipped', last_error = 'test_setup'
       where funding_session_id = $1
         and state_revision = 3
         and action = 'funding_edit'`,
      [readyContextId],
    );
    const staleAttemptId = crypto.randomUUID();
    const staleOutbox = await pool.query<{ id: string }>(
      `insert into telegram_bot_action_outbox (
         action,
         telegram_account_id,
         user_id,
         telegram_user_id,
         funding_session_id,
         state_revision,
         payload,
         status,
         attempt_count,
         delivery_attempt_id,
         delivery_started_at,
         updated_at
       )
       select
         'funding_replacement',
         telegram_account_id,
         user_id,
         telegram_user_id,
         id,
         progress_revision,
         latest_progress_projection,
         'sending',
         1,
         $2,
         now() - interval '10 minutes',
         now() - interval '10 minutes'
       from telegram_funding_sessions
       where id = $1
       returning id`,
      [readyContextId, staleAttemptId],
    );
    const staleOutboxId = staleOutbox.rows[0]?.id;
    assert.ok(staleOutboxId);
    await pool.query(
      `update telegram_funding_sessions
       set delivery_lease_outbox_id = $2,
           delivery_lease_attempt_id = $3,
           delivery_lease_expires_at = now() - interval '5 minutes'
       where id = $1`,
      [readyContextId, staleOutboxId, staleAttemptId],
    );
    let recoverySendCalls = 0;
    const recoveredUnknown = await deliverTelegramFundingActions({
      pool,
      renderCoordinator,
      telegram: {
        editMessageText: async () => {
          assert.fail("a stale send attempt must not become an edit");
        },
        sendMessage: async () => {
          recoverySendCalls += 1;
          return { ok: true, messageId: 901 };
        },
      },
    });
    assert.equal(recoveredUnknown.claimed, 0);
    assert.equal(recoverySendCalls, 0);
    const unknownState = await pool.query<{
      lease_id: string | null;
      status: string;
    }>(
      `select
         outbox.status,
         context.delivery_lease_outbox_id::text as lease_id
       from telegram_bot_action_outbox outbox
       join telegram_funding_sessions context
         on context.id = outbox.funding_session_id
       where outbox.id = $1`,
      [staleOutboxId],
    );
    assert.deepEqual(unknownState.rows[0], {
      lease_id: null,
      status: "delivery_unknown",
    });
    await pool.query(
      `update telegram_bot_action_outbox
       set status = 'pending', last_error = null, updated_at = now()
       where funding_session_id = $1
         and state_revision = 3
         and action = 'funding_edit'`,
      [readyContextId],
    );
    assert.equal(
      await rearmTelegramFundingTerminalDelivery({
        pool,
        telegramUserId: fairnessTelegramUserId,
      }),
      1,
    );
    const explicitlyRearmed = await pool.query<{
      delivery_attempt_id: string | null;
      status: string;
    }>(
      `select delivery_attempt_id::text, status
       from telegram_bot_action_outbox
       where id = $1`,
      [staleOutboxId],
    );
    assert.deepEqual(explicitlyRearmed.rows[0], {
      delivery_attempt_id: null,
      status: "skipped",
    });
    const deterministicRearm = await pool.query<{
      edit_status: string;
      replacement_status: string;
    }>(
      `select
         max(status) filter (where action = 'funding_edit') as edit_status,
         max(status) filter (where action = 'funding_replacement') as replacement_status
       from telegram_bot_action_outbox
       where funding_session_id = $1 and state_revision = 3`,
      [readyContextId],
    );
    assert.deepEqual(deterministicRearm.rows[0], {
      edit_status: "pending",
      replacement_status: "skipped",
    });
    const activeAttemptId = crypto.randomUUID();
    await pool.query(
      `update telegram_bot_action_outbox
       set status = 'sending',
           delivery_attempt_id = $2,
           delivery_started_at = now(),
           updated_at = now()
       where id = $1`,
      [staleOutboxId, activeAttemptId],
    );
    await pool.query(
      `update telegram_funding_sessions
       set delivery_lease_outbox_id = $2,
           delivery_lease_attempt_id = $3,
           delivery_lease_expires_at = now() + interval '5 minutes'
       where id = $1`,
      [readyContextId, staleOutboxId, activeAttemptId],
    );
    assert.equal(
      await rearmTelegramFundingTerminalDelivery({
        pool,
        telegramUserId: fairnessTelegramUserId,
      }),
      0,
      "explicit recovery must not replace an active external send",
    );
    const activeAttempt = await pool.query<{
      lease_id: string | null;
      status: string;
    }>(
      `select outbox.status,
              context.delivery_lease_outbox_id::text as lease_id
       from telegram_bot_action_outbox outbox
       join telegram_funding_sessions context
         on context.id = outbox.funding_session_id
       where outbox.id = $1`,
      [staleOutboxId],
    );
    assert.deepEqual(activeAttempt.rows[0], {
      lease_id: staleOutboxId,
      status: "sending",
    });
    await pool.query(
      `update telegram_bot_action_outbox
       set delivery_started_at = now() - interval '6 minutes',
           updated_at = now() - interval '6 minutes'
       where id = $1`,
      [staleOutboxId],
    );
    assert.equal(
      await rearmTelegramFundingTerminalDelivery({
        pool,
        telegramUserId: fairnessTelegramUserId,
      }),
      1,
      "one explicit recovery must rearm an abandoned send",
    );
    const staleAttemptRearmed = await pool.query<{
      attempt_id: string | null;
      edit_status: string;
      lease_id: string | null;
      status: string;
    }>(
      `select
         outbox.delivery_attempt_id::text as attempt_id,
         context.delivery_lease_outbox_id::text as lease_id,
         outbox.status,
         edit.status as edit_status
       from telegram_bot_action_outbox outbox
       join telegram_funding_sessions context
         on context.id = outbox.funding_session_id
       join telegram_bot_action_outbox edit
         on edit.funding_session_id = context.id
        and edit.state_revision = context.progress_revision
        and edit.action = 'funding_edit'
       where outbox.id = $1`,
      [staleOutboxId],
    );
    assert.deepEqual(staleAttemptRearmed.rows[0], {
      attempt_id: null,
      edit_status: "pending",
      lease_id: null,
      status: "skipped",
    });
    await pool.query(
      `update telegram_bot_action_outbox
       set status = 'skipped', last_error = 'test_setup'
       where id = $1`,
      [staleOutboxId],
    );
    await pool.query(
      `update telegram_funding_sessions
       set delivery_lease_outbox_id = null,
           delivery_lease_attempt_id = null,
           delivery_lease_expires_at = null
       where id = $1`,
      [readyContextId],
    );
    const unselectedReceive = await createOrReuseFundingReceiveSession(pool, {
      ...canonicalInput,
      destinationOptionId: `unselected-destination-${suffix}`,
      venueBindingOptionId: `unselected-binding-${suffix}`,
      policyRevision: `unselected-policy-${suffix}`,
      ownershipRevision: `unselected-owner-${suffix}`,
      now: new Date(now.getTime() + 25_500),
    });
    const unselectedReceiveId =
      unselectedReceive.snapshot.session.receiveSessionId;
    fairnessReceiveIds.push(unselectedReceiveId);
    const unselectedContext = await createOrReuseTelegramFundingSession(pool, {
      userId,
      telegramAccountId: fairnessTelegramAccountId,
      telegramUserId: fairnessTelegramUserId,
      chatId: fairnessTelegramUserId,
      telegramMessageId: 700,
      receiveSessionId: unselectedReceiveId,
      idempotencyKey: `unselected-open-${suffix}`,
      expiresAt: new Date(now.getTime() + 86_400_000),
      now: new Date(now.getTime() + 25_600),
    });
    fairnessContextIds.push(unselectedContext.context.id);
    const cancelContextId = fairnessContextIds[0];
    const cancelReceiveId = fairnessReceiveIds[0];
    const expiredContextId = fairnessContextIds[2];
    assert.ok(cancelContextId);
    assert.ok(cancelReceiveId);
    assert.ok(expiredContextId);
    const cancelMutation = {
      contextId: cancelContextId,
      userId,
      telegramAccountId: fairnessTelegramAccountId,
      telegramUserId: fairnessTelegramUserId,
      chatId: fairnessTelegramUserId,
      telegramMessageId: 500,
      idempotencyKey: `fair-cancel-${suffix}`,
      requestFingerprint: hash("fair-cancel-request"),
      responsePayload: { text: "cancelled" },
      now: new Date(now.getTime() + 26_000),
    };
    const concurrentCancels = await Promise.all([
      cancelTelegramFundingSessionContext(pool, cancelMutation),
      cancelTelegramFundingSessionContext(pool, cancelMutation),
    ]);
    assert.equal(
      concurrentCancels.filter((result) => result?.mutationResponse === null)
        .length,
      1,
    );
    assert.equal(
      concurrentCancels.filter(
        (result) => result?.mutationResponse?.text === "cancelled",
      ).length,
      1,
    );
    const cancelledCanonical = await pool.query<{ status: string }>(
      `select status from funding_receive_sessions where id = $1`,
      [cancelReceiveId],
    );
    assert.equal(cancelledCanonical.rows[0]?.status, "cancelled");
    const unselectedCancel = await cancelTelegramFundingSessionContext(pool, {
      contextId: unselectedContext.context.id,
      userId,
      telegramAccountId: fairnessTelegramAccountId,
      telegramUserId: fairnessTelegramUserId,
      chatId: fairnessTelegramUserId,
      telegramMessageId: 700,
      idempotencyKey: `unselected-cancel-${suffix}`,
      requestFingerprint: hash("unselected-cancel-request"),
      responsePayload: { text: "cancelled" },
      now: new Date(now.getTime() + 26_500),
    });
    assert.ok(unselectedCancel);
    const terminalProjection = await runTelegramFundingProgressProjectionBatch(
      pool,
      {
        limit: 100,
        now: new Date(now.getTime() + 26_600),
      },
    );
    assert.deepEqual(terminalProjection, {
      candidates: 3,
      created: 2,
      skipped: 1,
    });
    const terminalStates = await pool.query<{
      id: string;
      projection_checked_at: Date | null;
      state: string | null;
    }>(
      `select id,
              projection_checked_at,
              latest_progress_projection->>'state' as state
       from telegram_funding_sessions
       where id = any($1::uuid[])
       order by id`,
      [[cancelContextId, expiredContextId, unselectedContext.context.id]],
    );
    assert.equal(
      terminalStates.rows.find((row) => row.id === cancelContextId)?.state,
      "cancelled",
    );
    assert.equal(
      terminalStates.rows.find((row) => row.id === expiredContextId)?.state,
      "expired",
    );
    assert.ok(
      terminalStates.rows.find((row) => row.id === unselectedContext.context.id)
        ?.projection_checked_at,
      "a null terminal projection still needs a durable checked watermark",
    );
    assert.deepEqual(
      await runTelegramFundingProgressProjectionBatch(pool, {
        limit: 100,
        now: new Date(now.getTime() + 26_700),
      }),
      { candidates: 0, created: 0, skipped: 0 },
      "cancelled and unselected contexts must not remain permanent candidates",
    );
    await assert.rejects(
      appendTelegramFundingConsent(pool, {
        contextId: cancelContextId,
        userId,
        telegramAccountId: fairnessTelegramAccountId,
        telegramUserId: fairnessTelegramUserId,
        chatId: fairnessTelegramUserId,
        telegramMessageId: 500,
        controllerWalletId,
        receiveTargetId,
        asset: pUsd,
        variantIds: [pUsdVariantId],
        policySnapshot: directPolicySnapshot,
        fingerprint: hash("fair-cancel-key-reuse-consent"),
        mutation: {
          idempotencyKey: cancelMutation.idempotencyKey,
          requestFingerprint: hash("fair-cancel-key-reused-for-select"),
          responsePayload: { text: "must not be returned" },
        },
        now: new Date(now.getTime() + 27_000),
      }),
      (error: unknown) =>
        error instanceof TelegramFundingPersistenceError &&
        error.code === "telegram_funding_idempotency_conflict",
    );

    const lateReadyReceipt = await pool.connect();
    try {
      await lateReadyReceipt.query("begin");
      await insertFundingReceiveReceipt(lateReadyReceipt, {
        receiveSessionId: cancelReceiveId,
        userId,
        variantId: pUsdVariantId,
        asset: pUsd,
        destinationAddress,
        rawAmount: "2000000",
        observationRevision: `late-ready-${suffix}`,
        canonicalEvent: {
          transactionHash: `0x${hash("late-ready-tx")}`,
          eventIndex: "28",
          ledgerHeight: "128",
          blockHash: `0x${hash("late-ready-block")}`,
          sourceAddress: "0x6666666666666666666666666666666666666666",
        },
        observedAt: new Date(now.getTime() + 27_100),
        status: "ready",
        handling: "direct",
        evidence: { canonical: true },
        now: new Date(now.getTime() + 27_100),
      });
      await lateReadyReceipt.query(
        `update funding_receive_sessions
         set version = version + 1, updated_at = $2
         where id = $1`,
        [cancelReceiveId, new Date(now.getTime() + 27_100)],
      );
      await lateReadyReceipt.query("commit");
    } catch (error) {
      await lateReadyReceipt.query("rollback");
      throw error;
    } finally {
      lateReadyReceipt.release();
    }
    assert.deepEqual(
      await runTelegramFundingProgressProjectionBatch(pool, {
        limit: 100,
        now: new Date(now.getTime() + 27_200),
      }),
      { candidates: 1, created: 0, skipped: 1 },
      "a late ready receipt cannot replace a retained cancellation",
    );
    const lateReadyState = await pool.query<{ state: string }>(
      `select latest_progress_projection->>'state' as state
       from telegram_funding_sessions where id = $1`,
      [cancelContextId],
    );
    assert.equal(lateReadyState.rows[0]?.state, "cancelled");
    assert.deepEqual(
      await runTelegramFundingProgressProjectionBatch(pool, {
        limit: 100,
        now: new Date(now.getTime() + 27_300),
      }),
      { candidates: 0, created: 0, skipped: 0 },
      "the retained cancellation still advances the observed receive watermark once",
    );

    const cleanupAge = await pool.connect();
    try {
      await cleanupAge.query("begin");
      await cleanupAge.query("set local session_replication_role = replica");
      await cleanupAge.query(
        `update telegram_funding_sessions
         set updated_at = now() - interval '31 days'
         where id = $1`,
        [cancelContextId],
      );
      await cleanupAge.query("commit");
    } catch (error) {
      await cleanupAge.query("rollback");
      throw error;
    } finally {
      cleanupAge.release();
    }
    assert.equal(
      await cleanupTelegramFundingContexts({
        pool,
        retentionDays: 30,
        limit: 100,
      }),
      0,
      "retention cleanup must preserve a context with pending delivery",
    );
    await pool.query(
      `update telegram_bot_action_outbox
       set status = 'skipped', last_error = 'test_cleanup_release'
       where funding_session_id = $1
         and status in ('pending', 'retry', 'sending', 'delivery_unknown')`,
      [cancelContextId],
    );
    assert.equal(
      await cleanupTelegramFundingContexts({
        pool,
        retentionDays: 30,
        limit: 100,
      }),
      1,
      "retention cleanup may remove the context after delivery is resolved",
    );

    const preterminalContextId = fairnessContextIds[1];
    const preterminalReceiveId = fairnessReceiveIds[1];
    assert.ok(preterminalContextId);
    assert.ok(preterminalReceiveId);
    await pool.query(`delete from user_telegram_accounts where id = $1`, [
      fairnessTelegramAccountId,
    ]);
    const preterminalRelink = await pool.query<{ id: string }>(
      `insert into user_telegram_accounts (
         user_id, privy_user_id, telegram_user_id, username
       ) values ($1, $2, $3, 'telegram-funding-fairness-relinked')
       returning id`,
      [userId, `did:privy:${suffix}:fairness-relinked`, fairnessTelegramUserId],
    );
    const preterminalRelinkId = preterminalRelink.rows[0]?.id;
    assert.ok(preterminalRelinkId);
    await enableManagedTrading(
      fairnessTelegramUserId,
      `did:privy:${suffix}:fairness-relinked`,
    );
    const reattached = await pool.query<{ telegram_account_id: string | null }>(
      `select telegram_account_id
       from telegram_funding_sessions
       where id = $1`,
      [preterminalContextId],
    );
    assert.equal(
      reattached.rows[0]?.telegram_account_id,
      preterminalRelinkId,
      "relink before a terminal transition must restore the future destination",
    );
    await pool.query(
      `update telegram_funding_sessions
       set telegram_message_id = null
       where id = $1`,
      [preterminalContextId],
    );
    const relinkReceipt = await pool.connect();
    try {
      await relinkReceipt.query("begin");
      await insertFundingReceiveReceipt(relinkReceipt, {
        receiveSessionId: preterminalReceiveId,
        userId,
        variantId: pUsdVariantId,
        asset: pUsd,
        destinationAddress,
        rawAmount: "3000000",
        observationRevision: `relink-ready-${suffix}`,
        canonicalEvent: {
          transactionHash: `0x${hash("relink-ready-tx")}`,
          eventIndex: "27",
          ledgerHeight: "127",
          blockHash: `0x${hash("relink-ready-block")}`,
          sourceAddress: "0x5555555555555555555555555555555555555555",
        },
        observedAt: new Date(now.getTime() + 28_000),
        status: "ready",
        handling: "direct",
        evidence: { canonical: true },
        now: new Date(now.getTime() + 28_000),
      });
      await relinkReceipt.query(
        `update funding_receive_sessions
         set version = version + 1, updated_at = $2
         where id = $1`,
        [preterminalReceiveId, new Date(now.getTime() + 28_000)],
      );
      await relinkReceipt.query("commit");
    } catch (error) {
      await relinkReceipt.query("rollback");
      throw error;
    } finally {
      relinkReceipt.release();
    }
    const relinkProjection = await runTelegramFundingProgressProjectionBatch(
      pool,
      { limit: 100, now: new Date(now.getTime() + 28_100) },
    );
    assert.equal(relinkProjection.created, 1);
    const relinkedOutbox = await pool.query<{
      telegram_account_id: string | null;
    }>(
      `select telegram_account_id
       from telegram_bot_action_outbox
       where funding_session_id = $1
         and state_revision = 2
         and action = 'funding_send'`,
      [preterminalContextId],
    );
    assert.equal(
      relinkedOutbox.rows[0]?.telegram_account_id,
      preterminalRelinkId,
    );
    await pool.query(
      `update telegram_bot_action_outbox
       set status = 'skipped', last_error = 'test_delivery_isolation'
       where funding_session_id <> $1
         and funding_session_id = any($2::uuid[])
         and status in ('pending', 'retry')`,
      [preterminalContextId, fairnessContextIds],
    );
    let raceRelinkId: string | null = null;
    const raceDelivery = await deliverTelegramFundingActions({
      pool,
      renderCoordinator,
      telegram: {
        editMessageText: async () => {
          assert.fail("the preterminal relink card must use funding_send");
        },
        sendMessage: async () => {
          await pool.query(`delete from user_telegram_accounts where id = $1`, [
            preterminalRelinkId,
          ]);
          const raceRelink = await pool.query<{ id: string }>(
            `insert into user_telegram_accounts (
               user_id, privy_user_id, telegram_user_id, username
             ) values ($1, $2, $3, 'telegram-funding-race-relinked')
             returning id`,
            [
              userId,
              `did:privy:${suffix}:race-relinked`,
              fairnessTelegramUserId,
            ],
          );
          raceRelinkId = raceRelink.rows[0]?.id ?? null;
          assert.ok(raceRelinkId);
          return { ok: true, messageId: 1200 };
        },
      },
    });
    assert.equal(raceDelivery.sent, 1);
    await enableManagedTrading(
      fairnessTelegramUserId,
      `did:privy:${suffix}:race-relinked`,
    );
    const raceRecorded = await pool.query<{
      followup_account_id: string | null;
      followup_action: string | null;
      followup_status: string | null;
      last_delivered_revision: number;
      telegram_account_id: string | null;
      telegram_message_id: string | null;
      outbox_account_id: string | null;
      outbox_status: string;
    }>(
      `select
         context.last_delivered_revision,
         context.telegram_account_id::text,
         context.telegram_message_id::text,
         outbox.telegram_account_id::text as outbox_account_id,
         outbox.status as outbox_status,
         followup.telegram_account_id::text as followup_account_id,
         followup.action as followup_action,
         followup.status as followup_status
       from telegram_funding_sessions context
       join telegram_bot_action_outbox outbox
         on outbox.funding_session_id = context.id
        and outbox.state_revision = 2
        and outbox.action = 'funding_send'
       left join telegram_bot_action_outbox followup
         on followup.funding_session_id = context.id
        and followup.state_revision = 2
        and followup.action = 'funding_edit'
       where context.id = $1`,
      [preterminalContextId],
    );
    assert.deepEqual(raceRecorded.rows[0], {
      followup_account_id: raceRelinkId,
      followup_action: "funding_edit",
      followup_status: "pending",
      last_delivered_revision: 0,
      telegram_account_id: raceRelinkId,
      telegram_message_id: "1200",
      outbox_account_id: preterminalRelinkId,
      outbox_status: "sent",
    });

    const replacementStartAccountId = raceRelinkId;
    assert.ok(replacementStartAccountId);
    await pool.query(
      `update telegram_bot_action_outbox
          set status = 'skipped', last_error = 'test_relink_replacement_conflict'
        where funding_session_id = $1
          and state_revision = 2
          and action = 'funding_edit'`,
      [preterminalContextId],
    );
    await pool.query(
      `insert into telegram_bot_action_outbox (
         action, telegram_account_id, user_id, telegram_user_id,
         funding_session_id, state_revision, payload
       )
       select 'funding_replacement', $2::uuid, context.user_id,
              context.telegram_user_id, context.id, 2,
              context.latest_progress_projection
         from telegram_funding_sessions context
        where context.id = $1`,
      [preterminalContextId, replacementStartAccountId],
    );
    await pool.query(
      `update telegram_bot_action_outbox
          set status = 'skipped', last_error = 'test_replacement_race_isolation'
        where funding_session_id <> $1
          and funding_session_id = any($2::uuid[])
          and status in ('pending', 'retry')`,
      [preterminalContextId, fairnessContextIds],
    );
    const replacementRace = await deliverTelegramFundingActions({
      pool,
      renderCoordinator,
      telegram: {
        editMessageText: async () => {
          assert.fail("historical replacement must not edit");
        },
        sendMessage: async () => {
          assert.fail("historical replacement must not copy-send");
        },
      },
    });
    assert.equal(replacementRace.failed, 1);
    const replacementFollowup = await pool.query<{
      owner_account_id: string | null;
      owner_message_id: string | null;
      replacement_error: string | null;
      replacement_status: string;
    }>(
      `select
         context.telegram_account_id::text as owner_account_id,
         context.telegram_message_id::text as owner_message_id,
         replacement.last_error as replacement_error,
         replacement.status as replacement_status
       from telegram_funding_sessions context
       join telegram_bot_action_outbox replacement
         on replacement.funding_session_id = context.id
        and replacement.state_revision = 2
        and replacement.action = 'funding_replacement'
       where context.id = $1`,
      [preterminalContextId],
    );
    assert.deepEqual(replacementFollowup.rows[0], {
      owner_account_id: raceRelinkId,
      owner_message_id: "1200",
      replacement_error: "funding_owner_scoped_replacement_disabled",
      replacement_status: "dead",
    });
  } finally {
    const fairnessCleanup = await pool.connect();
    try {
      await fairnessCleanup.query("begin");
      await fairnessCleanup.query(
        "set local session_replication_role = replica",
      );
      await fairnessCleanup.query(
        `delete from telegram_bot_action_outbox
         where funding_session_id = any($1::uuid[])`,
        [fairnessContextIds],
      );
      await fairnessCleanup.query(
        `delete from telegram_funding_mutations
         where funding_context_id = any($1::uuid[])`,
        [fairnessContextIds],
      );
      await fairnessCleanup.query(
        `delete from telegram_funding_consents
         where telegram_funding_session_id = any($1::uuid[])`,
        [fairnessContextIds],
      );
      await fairnessCleanup.query(
        `delete from telegram_funding_sessions
         where id = any($1::uuid[])`,
        [fairnessContextIds],
      );
      await fairnessCleanup.query(
        `delete from funding_receive_receipts
         where receive_session_id = any($1::uuid[])`,
        [fairnessReceiveIds],
      );
      await fairnessCleanup.query(
        `delete from funding_receive_sessions
         where id = any($1::uuid[])`,
        [fairnessReceiveIds],
      );
      await fairnessCleanup.query("commit");
    } catch (error) {
      fairnessCleanupFailure = error;
      await fairnessCleanup.query("rollback").catch(() => undefined);
    } finally {
      fairnessCleanup.release();
    }
    if (!fairnessCleanupFailure) {
      await pool.query(`delete from user_telegram_accounts where id = $1`, [
        fairnessTelegramAccountId,
      ]);
    }
  }
  if (fairnessCleanupFailure) throw fairnessCleanupFailure;

  const retainedFundingIdentity = await pool.query<{
    telegram_account_id: string;
    user_wallet_id: string;
  }>(
    `select account.id as telegram_account_id, wallet.id as user_wallet_id
       from user_telegram_accounts account
       join user_wallets wallet
         on wallet.user_id = account.user_id
        and wallet.privy_wallet_id = $2
      where account.user_id = $1
        and account.telegram_user_id = $3
      limit 1`,
    [userId, privyWalletId, fairnessTelegramUserId],
  );
  const retainedIdentity = retainedFundingIdentity.rows[0];
  assert.ok(retainedIdentity);
  const retainedAuthorization = await pool.query<{ id: string }>(
    `insert into telegram_funding_authorizations (
       user_id, telegram_account_id, telegram_user_id, user_wallet_id,
       privy_wallet_id, wallet_address, wallet_chain, profile_id,
       security_class, signer_id, signer_fingerprint, policy_id,
       policy_fingerprint, venue_id, destination_option_id,
       venue_binding_option_id, source_network_id, source_asset_id,
       source_asset_decimals, destination_network_id, destination_asset_id,
       destination_asset_decimals
     ) values (
       $1, $2, $3, $4, $5, $6, 'ethereum', 'delete-user-test-profile',
       'closed_destination_transform', 'delete-user-test-signer', $7,
       'delete-user-test-policy', $8, 'polymarket', $9, $10,
       $11, $12, 6, $13, $14, 6
     ) returning id`,
    [
      userId,
      retainedIdentity.telegram_account_id,
      fairnessTelegramUserId,
      retainedIdentity.user_wallet_id,
      privyWalletId,
      destinationAddress,
      hash("delete-user-signer"),
      hash("delete-user-policy"),
      canonicalInput.destinationOptionId,
      canonicalInput.venueBindingOptionId,
      usdce.networkId,
      usdce.assetId,
      pUsd.networkId,
      pUsd.assetId,
    ],
  );
  const deletion = await AuthService.deleteUser(userId);
  assert.equal(deletion.disposition, "deactivated");
  const revokedAuthorization = await pool.query<{
    granted_at: Date;
    revoked_at: Date | null;
  }>(
    `select granted_at, revoked_at
       from telegram_funding_authorizations
      where id = $1`,
    [retainedAuthorization.rows[0]?.id],
  );
  const revokedAuthorizationRow = revokedAuthorization.rows[0];
  assert.ok(revokedAuthorizationRow?.revoked_at);
  assert.ok(
    revokedAuthorizationRow.revoked_at.getTime() >=
      revokedAuthorizationRow.granted_at.getTime(),
  );

  console.log(
    "[telegram-funding-receive-integration-tests] channel ownership, concurrent mutation replay, fair projection watermarks, exact historical authority, durable delivery, and safe lifecycle cleanup passed",
  );
} finally {
  const cleanup = await pool.connect();
  try {
    await cleanup.query("begin");
    await cleanup.query("set local session_replication_role = replica");
    await cleanup.query(
      `delete from telegram_bot_action_outbox
       where funding_session_id in (
         select id from telegram_funding_sessions where user_id = $1
       )`,
      [userId],
    );
    await cleanup.query(
      `delete from telegram_funding_mutations
       where funding_context_id in (
         select id from telegram_funding_sessions where user_id = $1
       )`,
      [userId],
    );
    await cleanup.query(
      `delete from telegram_funding_consents
       where telegram_funding_session_id in (
         select id from telegram_funding_sessions where user_id = $1
       )`,
      [userId],
    );
    await cleanup.query(
      "delete from telegram_funding_sessions where user_id = $1",
      [userId],
    );
    await cleanup.query(
      `delete from funding_receive_receipts
       where receive_session_id in (
         select id from funding_receive_sessions where user_id = $1
       )`,
      [userId],
    );
    await cleanup.query(
      "delete from funding_receive_sessions where user_id = $1",
      [userId],
    );
    await cleanup.query(
      "delete from telegram_bot_action_outbox where user_id = $1",
      [userId],
    );
    await cleanup.query(
      "delete from telegram_bot_trading_authorizations where user_id = $1",
      [userId],
    );
    await cleanup.query(
      "delete from telegram_bot_trading_preferences where user_id = $1",
      [userId],
    );
    if (signalPolicyId) {
      await cleanup.query("delete from runtime_policies where id = $1", [
        signalPolicyId,
      ]);
    }
    await cleanup.query(
      "delete from telegram_funding_authorizations where user_id = $1",
      [userId],
    );
    await cleanup.query("delete from user_wallets where user_id = $1", [
      userId,
    ]);
    await cleanup.query(
      "delete from user_telegram_accounts where user_id = $1",
      [userId],
    );
    await cleanup.query("delete from users where id = $1", [userId]);
    await cleanup.query("commit");
  } catch (error) {
    cleanupFailure = error;
    await cleanup.query("rollback").catch(() => undefined);
  } finally {
    cleanup.release();
  }
}

if (cleanupFailure) {
  throw cleanupFailure;
}
