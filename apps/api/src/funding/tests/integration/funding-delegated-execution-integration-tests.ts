#!/usr/bin/env tsx

// @requires-db

import assert from "node:assert/strict";
import crypto from "node:crypto";

import { POLYMARKET_FUNDING_ROUTER } from "@hunch/contracts";
import { getAddress, Interface } from "ethers";
import { tx, type PoolClient } from "@hunch/infra";

import "../../../integration-test-database-guard.js";
import { stableWalletOpaqueId } from "../../../account-value/canonical.js";
import { pool } from "../../../db.js";
import { normalizedActionSchema } from "../../domain/schemas.js";
import type { JsonValue, NormalizedAction } from "../../domain/types.js";
import {
  createPolymarketWrapDelegatedFundingProfile,
  DelegatedFundingExecutor,
  type DelegatedFundingExecutionClaim,
  type DelegatedFundingExecutionResult,
  type DelegatedFundingNetworkDriver,
} from "../../execution/delegated-funding-executor.js";
import {
  DELEGATED_PROVIDER_LOOKUP_DELAY_MS,
  DELEGATED_PROVIDER_REPLAY_MS,
} from "../../execution/delegated-funding-recovery-policy.js";
import type {
  PolymarketWrapExecutionConfiguration,
  RelayEvmExecutionConfiguration,
} from "../../execution/delegated-funding-config.js";
import {
  createRelayEvmDelegatedFundingProfile,
  RELAY_CLEANUP_CANONICAL_WATCH_MS,
  type RelayEvmAllowanceReader,
} from "../../execution/relay-evm-delegated-executor-profile.js";
import { lockTelegramFundingLinkLifecycle } from "../../execution/telegram-funding-link-lifecycle-lock.js";
import {
  POLYMARKET_DEPOSIT_USDCE_WRAP_PROFILE_ID,
  validatePolymarketDepositUsdceWrapAction,
} from "../../execution/delegated-funding-profiles.js";
import {
  ensureTelegramFundingAuthorization,
  ensureTelegramRelayEvmFundingAuthorization,
  grantTelegramFundingAuthorization,
  loadActiveTelegramFundingAuthorization,
  revokeTelegramFundingAuthorization,
  telegramFundingAuthorizationFingerprint,
} from "../../execution/telegram-funding-authorization.js";
import {
  buildTelegramFundingAutomationPolicyV2,
  buildTelegramRelayEvmAutomationPolicyV3,
  telegramFundingAutomationPolicyJson,
} from "../../execution/telegram-funding-automation-policy.js";
import {
  TELEGRAM_RELAY_EVM_FUNDING_PROFILE_ID,
  TELEGRAM_RELAY_POLYGON_PUSD_PROFILE_ID,
} from "../../execution/delegated-funding-profile-ids.js";
import {
  BASE_USDC,
  POLYGON_PUSD,
  RELAY_DEPOSITORY_V2,
  RELAY_SELF_DEPOSITOR,
} from "../../../funding-providers/relay/rehearsal.js";
import { resolveTelegramPolymarketWrapCapability } from "../../execution/delegated-funding-capability-resolver.js";
import type { FundingTransactionReferenceCodec } from "../../execution/transaction-reference-codec.js";
import {
  commitFundingOperation,
  commitFundingOperationInTransaction,
  createFundingQuote,
  createFundingQuoteInTransaction,
  FundingPersistenceError,
  allocateFundingObservationInTransaction,
  transitionFundingOperationInTransaction,
  wakeFundingReconciliationInTransaction,
  type FundingCommitPlan,
} from "../../persistence/funding-operation-repository.js";
import {
  applyFundingStepReceiptEvidenceInTransaction,
  listFundingStepReceiptTargets,
} from "../../persistence/funding-step-receipt-repository.js";
import {
  claimFundingReceiveCanonicalEventAllocation,
  claimFundingReceiveReceiptOperationLinkInTransaction,
  createOrReuseFundingReceiveSession,
  deferFundingReceiveReceiptRouting,
  finalizeFundingReceiveCanonicalEventAllocation,
  fundingReceiveReceiptOperationIdempotencyKey,
  insertFundingReceiveReceipt,
  listFundingReceiveRoutingReceiptIdsAfterBroadcastBoundary,
  listFundingReceiveReceiptsForRouting,
  linkFundingReceiveReceiptOperationInTransaction,
  settleFundingReceiveReceiptRouting,
} from "../../persistence/funding-receive-session-repository.js";
import { canonicalJsonHash } from "../../persistence/canonical.js";
import { lockFundingAuthorizationReservationScope } from "../../persistence/funding-authorization-reservation-lock.js";
import {
  lockFundingPolicyForTransaction,
  resolveFundingPolicy,
} from "../../policies/funding-policy-service.js";
import { fundingSidecarRuntimeConfig } from "../../runtime/sidecar-runtime-config.js";
import { FundingReceiveReceiptRouter } from "../../receive/receive-receipt-router.js";
import {
  reduceFundingOperation,
  runFundingReconciliationBatch,
} from "../../reconciliation/funding-reducer.js";
import { OwnedRouteDestinationObserver } from "../../reconciliation/owned-route-destination-observer.js";
import { RelayOwnedRefundObserver } from "../../reconciliation/relay-owned-refund-observer.js";
import { PolymarketFundingPostconditionDriver } from "../../preparation/polymarket-funding-reconciler.js";
import { hasReadyTelegramFundingDestinationReceipt } from "../../../services/telegram-funding-buy-continuation.js";
import { validatePolymarketFundingOperationLink } from "../../../services/telegram-funding-polymarket-evidence.js";
import {
  appendTelegramFundingConsent,
  TelegramFundingPersistenceError,
} from "../../../services/telegram-funding-sessions.js";
import { runTelegramFundingProgressProjectionBatch } from "../../../services/telegram-funding-progress-projector.js";
import {
  resolveTelegramFundingReceiptDisposition,
  telegramPolygonFundingPresentation,
  telegramUsdceWrapRoutingAuthorized,
  telegramUsdceWrapRoutingDecision,
} from "../../../services/telegram-funding-route.js";
import {
  buildPolymarketFundingPlan,
  type PolymarketFundingPlan,
} from "../../../services/polymarket-funding-router.js";

const suffix = crypto.randomUUID();
const now = new Date();
const authorizationPrivateKey = crypto
  .generateKeyPairSync("ec", { namedCurve: "P-256" })
  .privateKey.export({ format: "der", type: "pkcs8" })
  .toString("base64");
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
const router = POLYMARKET_FUNDING_ROUTER.polygon;
const profileConfiguration = {
  enabled: true,
  profileId: POLYMARKET_DEPOSIT_USDCE_WRAP_PROFILE_ID,
  signerId: `signer_${suffix}`,
  signerFingerprint: crypto
    .createHash("sha256")
    .update(`signer:${suffix}`)
    .digest("hex"),
  policyId: `policy_${suffix}`,
  policyFingerprint: crypto
    .createHash("sha256")
    .update(`policy:${suffix}`)
    .digest("hex"),
} as const;
const relayConfiguration: RelayEvmExecutionConfiguration = {
  enabled: true,
  profileId: TELEGRAM_RELAY_EVM_FUNDING_PROFILE_ID,
  signerId: profileConfiguration.signerId,
  signerFingerprint: profileConfiguration.signerFingerprint,
  policyId: profileConfiguration.policyId,
  policyFingerprint: profileConfiguration.policyFingerprint,
  maxSourceRaw: "10000000",
  minimumSequentialTtlMs: 30_000,
};
const referenceCodec: FundingTransactionReferenceCodec = {
  keyVersion: 1,
  encrypt: (value) => `cipher:${value}`,
  decrypt: (value) => value.replace(/^cipher:/u, ""),
  fingerprint: (value) =>
    crypto.createHash("sha256").update(`reference:${value}`).digest("hex"),
};
type JsonRecord = Readonly<Record<string, JsonValue>>;

type Fixture = Readonly<{
  actionWalletId: string;
  authorizationId: string;
  consentFingerprint: string;
  consentId: string;
  destinationAddress: string;
  destinationLocationId: string;
  operationId: string;
  fundingPlan: PolymarketFundingPlan;
  privyWalletId: string;
  pUsdVariantId: string;
  quoteId: string;
  receiptIds: readonly string[];
  receiveSessionId: string;
  telegramFundingSessionId: string;
  telegramAccountId: string;
  userId: string;
  userWalletId: string;
  signerAddress: string;
  plan: FundingCommitPlan;
}>;

const fixtures: Fixture[] = [];
const extraAuthorizationIds: string[] = [];
const policyIds: string[] = [];
const relayArtifactOperationIds: string[] = [];
const relayArtifactQuoteIds: string[] = [];
const relayArtifactReceiptIds: string[] = [];
const tradeOriginIntentIds: string[] = [];
const tradeOriginMarketIds: string[] = [];
const tradeOriginEventIds: string[] = [];
let policyOffsetMs = -1_000;

function opaque(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

function rawAmount(raw: string) {
  return { asset: usdce, raw } as unknown as JsonRecord;
}

async function waitForLifecycleAdvisoryWait(): Promise<boolean> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const waiting = await pool.query<{ waiting: boolean }>(
      `select exists (
         select 1
           from pg_stat_activity
          where datname = current_database()
            and wait_event_type = 'Lock'
            and wait_event = 'advisory'
            and query like '%pg_advisory_xact_lock%'
       ) as waiting`,
    );
    if (waiting.rows[0]?.waiting) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

async function publishFundingPolicy(
  paused: boolean,
  receivePrivy = false,
  options: Readonly<{
    assets?: readonly string[];
    db?: PoolClient;
    delegatedRelayEvmDailyCapUsd?: string;
    venues?: readonly string[];
  }> = {},
): Promise<void> {
  const result = await (options.db ?? pool).query<{ id: string }>(
    `insert into runtime_policies (
       policy_key, effective_at, payload, created_by
     ) values (
       'funding_control_plane', $1, $2::jsonb, null
     ) returning id`,
    [
      new Date(now.getTime() + policyOffsetMs),
      JSON.stringify({
        version: 2,
        venues: options.venues ?? ["polymarket"],
        receive: {
          assets: options.assets ?? ["polygon:pusd", "polygon:usdce"],
          privy: receivePrivy,
          ...(options.delegatedRelayEvmDailyCapUsd
            ? {
                delegatedRelayEvmDailyCapUsd:
                  options.delegatedRelayEvmDailyCapUsd,
              }
            : {}),
        },
        paused,
      }),
    ],
  );
  policyOffsetMs += 100;
  const id = result.rows[0]?.id;
  assert.ok(id);
  policyIds.push(id);
}

async function createFixture(
  raw: string,
  verifyRoutingAuthority = false,
): Promise<Fixture> {
  const userId = crypto.randomUUID();
  const telegramAccountId = crypto.randomUUID();
  const telegramUserId = `8${Math.floor(Math.random() * 1_000_000_000_000)}`;
  const walletAddress = `0x${crypto.randomBytes(20).toString("hex")}`;
  const privyWalletId = opaque("wallet");
  const actionWalletId = stableWalletOpaqueId({
    walletType: "ethereum",
    networkId: "evm:137",
    address: walletAddress,
  });
  const destinationOptionId = opaque("destination");
  const venueBindingOptionId = opaque("binding");
  const receiveTargetId = opaque("receive_target");
  const variantId = opaque("usdce_variant");
  const pUsdVariantId = opaque("pusd_variant");
  const destinationAddress = `0x${crypto.randomBytes(20).toString("hex")}`;
  const destinationLocationId = opaque("destination_location");
  const sourceLocationId = opaque("deposit_location");

  await pool.query(
    `insert into users (id, email, is_active, is_verified)
     values ($1, $2, true, true)`,
    [userId, `delegated-funding-${userId}@example.com`],
  );
  await pool.query(
    `insert into user_telegram_accounts (
       id, user_id, privy_user_id, telegram_user_id
     ) values ($1, $2, $3, $4)`,
    [telegramAccountId, userId, `did:privy:${userId}`, telegramUserId],
  );
  await pool.query(
    `insert into telegram_bot_trading_preferences (
       user_id, desired_enabled, decision_source
     ) values ($1, true, 'manual_enable')`,
    [userId],
  );
  const wallet = await pool.query<{ id: string }>(
    `insert into user_wallets (
       user_id, wallet_address, wallet_type, is_primary, is_verified,
       privy_wallet_id, wallet_source, is_internal_wallet,
       privy_profile_updated_at
     ) values (
       $1, $2, 'ethereum', true, true, $3, 'embedded', true, $4
     ) returning id`,
    [userId, walletAddress, privyWalletId, now],
  );
  const userWalletId = wallet.rows[0]?.id;
  assert.ok(userWalletId);
  await pool.query(
    `insert into telegram_bot_trading_authorizations (
       user_id, telegram_user_id, privy_user_id, wallet_address,
       wallet_chain, privy_wallet_id, enabled, enabled_venues
     ) values (
       $1, $2, $3, $4, 'ethereum', $5, true, array['polymarket']::text[]
     )`,
    [
      userId,
      telegramUserId,
      `did:privy:${userId}`,
      walletAddress,
      privyWalletId,
    ],
  );
  const authorizationInput = {
    userId,
    telegramAccountId,
    telegramUserId,
    userWalletId,
    privyWalletId,
    walletAddress,
    destinationOptionId,
    venueBindingOptionId,
    configuration: profileConfiguration,
    now,
  } as const;
  const authorization = await ensureTelegramFundingAuthorization(
    pool,
    {
      userId,
      telegramAccountId,
      telegramUserId,
      controllerWalletId: actionWalletId,
      destinationOptionId,
      venueBindingOptionId,
      now,
    },
    {
      configuration: profileConfiguration,
      environmentReady: true,
      inspectWalletProfile: async (input) => {
        assert.deepEqual(input, {
          walletAddress,
          walletId: privyWalletId,
        });
        return "valid";
      },
    },
  );
  assert.ok(authorization);
  const authorizationReplay = await grantTelegramFundingAuthorization(
    pool,
    authorizationInput,
  );
  assert.equal(authorizationReplay.id, authorization.id);

  const usdceVariant = {
    variantId,
    networkId: "evm:137",
    asset: usdce,
    destinationAddress,
    destinationLocationId: sourceLocationId,
    baselineRaw: "0",
    baselineRevision: opaque("baseline"),
    observation: {
      adapterId: "polymarket_deposit_wallet_assets_v1",
      payload: {
        eventIdentity: "evm_erc20_transfer_v1",
        eventCursorBlock: "100",
      },
    },
    completion: {
      kind: "committed_venue_preparation" as const,
      stepOrdinal: 0,
    },
  };
  const pUsdVariant = {
    ...usdceVariant,
    variantId: pUsdVariantId,
    asset: pUsd,
    destinationLocationId,
    completion: {
      kind: "direct_destination_credit" as const,
    },
  };

  const canonical = await createOrReuseFundingReceiveSession(pool, {
    userId,
    ownerChannel: "telegram",
    venueId: "polymarket",
    destinationOptionId,
    venueBindingOptionId,
    destinationAsset: pUsd,
    destinationTargetSnapshot: {
      kind: "owned_location",
      location: {
        kind: "venue_account",
        locationId: destinationLocationId,
        accountId: userId,
        asset: pUsd,
        details: {
          venueId: "polymarket",
          accountRef: destinationAddress,
          controllerWalletId: actionWalletId,
          address: destinationAddress,
        },
      },
    },
    venueBindingSnapshot: { venueBindingOptionId },
    methods: [
      {
        methodId: opaque("method"),
        kind: "manual",
        safeLabel: "Send pUSD or USDC.e",
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
              safeInstructions: ["Send only USDC.e on Polygon."],
            },
          ],
          recommendedReceiveTargetId: receiveTargetId,
          destinationOptionId,
          destinationAddress,
          requestedAmount: null,
          amountSemantics: "minimum",
          expiresAt: new Date(now.getTime() + 86_400_000).toISOString(),
          safeInstructions: ["Send only USDC.e on Polygon."],
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
        safeInstructions: [],
      },
    ],
    observationVariants: [pUsdVariant, usdceVariant],
    selectedReceiveTargetId: receiveTargetId,
    automationPolicy: {
      stableConversion: "automatic_within_caps",
      volatileConversion: "review_required",
      maximumFeeUsd: "0",
      maximumFeeBps: 0,
      maximumSlippageBps: 0,
    },
    policyVersion: 2,
    policyRevision: opaque("policy_revision"),
    ownershipRevision: opaque("ownership_revision"),
    expiresAt: new Date(now.getTime() + 86_400_000),
    observeUntil: new Date(now.getTime() + 8 * 86_400_000),
    now,
  });
  const telegramContext = await pool.query<{ id: string }>(
    `insert into telegram_funding_sessions (
       user_id, telegram_account_id, telegram_user_id, chat_id,
       receive_session_id, origin, idempotency_key, expires_at
     ) values ($1, $2, $3, $3, $4, 'generic_add_funds', $5, $6)
     returning id`,
    [
      userId,
      telegramAccountId,
      telegramUserId,
      canonical.snapshot.session.receiveSessionId,
      opaque("telegram_funding_open"),
      new Date(now.getTime() + 86_400_000),
    ],
  );
  const telegramFundingSessionId = telegramContext.rows[0]?.id;
  assert.ok(telegramFundingSessionId);
  const consentCapability = await resolveTelegramPolymarketWrapCapability(
    pool,
    {
      userId,
      telegramAccountId,
      telegramUserId,
      destinationOptionId,
      venueBindingOptionId,
      now,
    },
  );
  const automationPolicy = {
    ...telegramFundingAutomationPolicyJson(
      buildTelegramFundingAutomationPolicyV2({
        authorization,
        sourceAsset: usdce,
        destinationAsset: pUsd,
        fundingPolicyRevision: consentCapability.fundingPolicyRevision,
        variants: [usdceVariant],
      }),
    ),
    presentationMode: "pusd_or_usdce_automatic",
    presentation: telegramPolygonFundingPresentation("pusd_or_usdce_automatic"),
  } as const;
  const consentInput = {
    contextId: telegramFundingSessionId,
    userId,
    telegramAccountId,
    telegramUserId,
    chatId: telegramUserId,
    telegramMessageId: null,
    controllerWalletId: actionWalletId,
    receiveTargetId,
    asset: pUsd,
    variantIds: [pUsdVariantId, variantId],
    automationEnabled: true,
    maximumAutomaticRaw: null,
    policySnapshot: automationPolicy,
    fingerprint: canonicalJsonHash(automationPolicy),
    now,
  } as const;
  let consentAppended = false;
  let consentEvidence: Readonly<{ id: string; fingerprint: string }> | null =
    null;
  if (verifyRoutingAuthority) {
    assert.equal(consentCapability.decision.kind, "allowed");
    await pool.query(
      `update telegram_bot_trading_preferences
       set desired_enabled = false
       where user_id = $1`,
      [userId],
    );
    await assert.rejects(
      appendTelegramFundingConsent(pool, consentInput),
      (error: unknown) =>
        error instanceof TelegramFundingPersistenceError &&
        error.code === "telegram_funding_session_unavailable",
      "consent persistence must reject capability lost after preflight",
    );
    const staleConsent = await pool.query<{ count: string }>(
      `select count(*)::text as count
       from telegram_funding_consents
       where telegram_funding_session_id = $1`,
      [telegramFundingSessionId],
    );
    assert.equal(staleConsent.rows[0]?.count, "0");
    await pool.query(
      `update telegram_bot_trading_preferences
       set desired_enabled = true
       where user_id = $1`,
      [userId],
    );
    const stalePolicySnapshot = {
      ...automationPolicy,
      fundingPolicyRevision: opaque("stale_funding_policy"),
    } as const;
    await assert.rejects(
      appendTelegramFundingConsent(pool, {
        ...consentInput,
        policySnapshot: stalePolicySnapshot,
        fingerprint: canonicalJsonHash(stalePolicySnapshot),
      }),
      (error: unknown) =>
        error instanceof TelegramFundingPersistenceError &&
        error.code === "telegram_funding_session_unavailable",
      "automatic consent must reject a Funding Policy revision that lost the locked race",
    );

    const lifecycleClient = await pool.connect();
    let lifecycleCommitted = false;
    let pendingConsent:
      | ReturnType<typeof appendTelegramFundingConsent>
      | undefined;
    let pendingConsentSettled = false;
    try {
      await lifecycleClient.query("begin");
      await lockTelegramFundingLinkLifecycle(lifecycleClient, userId);
      pendingConsent = appendTelegramFundingConsent(pool, consentInput);

      assert.equal(
        await waitForLifecycleAdvisoryWait(),
        true,
        "consent must acquire the lifecycle lock before its session row lock",
      );

      const contextProbe = await pool.connect();
      try {
        await contextProbe.query("begin");
        await contextProbe.query(
          `select id
             from telegram_funding_sessions
            where id = $1
            for update nowait`,
          [telegramFundingSessionId],
        );
        await contextProbe.query("rollback");
      } catch (error) {
        await contextProbe.query("rollback");
        throw error;
      } finally {
        contextProbe.release();
      }

      await lifecycleClient.query("commit");
      lifecycleCommitted = true;
      const appended = await pendingConsent;
      consentEvidence = {
        id: appended.consent.id,
        fingerprint: appended.consent.fingerprint,
      };
      pendingConsentSettled = true;
      consentAppended = true;
    } finally {
      if (!lifecycleCommitted) await lifecycleClient.query("rollback");
      lifecycleClient.release();
      if (pendingConsent && !pendingConsentSettled) {
        await pendingConsent.catch(() => undefined);
      }
    }
  }
  if (!consentAppended) {
    const appended = await appendTelegramFundingConsent(pool, consentInput);
    consentEvidence = {
      id: appended.consent.id,
      fingerprint: appended.consent.fingerprint,
    };
  }
  assert.ok(consentEvidence);
  const oldReceipt = await insertFundingReceiveReceipt(pool, {
    receiveSessionId: canonical.snapshot.session.receiveSessionId,
    userId,
    variantId,
    asset: usdce,
    destinationAddress,
    rawAmount: "1",
    observationRevision: opaque("old_observation"),
    canonicalEvent: {
      transactionHash: `0x${crypto.randomBytes(32).toString("hex")}`,
      eventIndex: "0",
      ledgerHeight: "100",
      blockHash: `0x${crypto.randomBytes(32).toString("hex")}`,
      sourceAddress: `0x${crypto.randomBytes(20).toString("hex")}`,
    },
    observedAt: new Date(now.getTime() + 1_000),
    handling: "automatic_conversion",
    status: "observed",
    evidence: { fixture: true, beforeConsentCursor: true },
    now: new Date(now.getTime() + 1_000),
  });
  const receiptEvent = {
    transactionHash: `0x${crypto.randomBytes(32).toString("hex")}`,
    eventIndex: "0",
    ledgerHeight: "101",
    blockHash: `0x${crypto.randomBytes(32).toString("hex")}`,
    sourceAddress: `0x${crypto.randomBytes(20).toString("hex")}`,
  } as const;
  const receiptClient = await pool.connect();
  let insertedReceipt: Awaited<ReturnType<typeof insertFundingReceiveReceipt>>;
  try {
    await receiptClient.query("begin");
    const allocation = await claimFundingReceiveCanonicalEventAllocation(
      receiptClient,
      {
        networkId: usdce.networkId,
        asset: usdce,
        destinationAddress,
        sourceAddress: receiptEvent.sourceAddress,
        rawAmount: raw,
        transactionHash: receiptEvent.transactionHash,
        eventIndex: receiptEvent.eventIndex,
        ledgerHeight: receiptEvent.ledgerHeight,
        blockHash: receiptEvent.blockHash,
        observedAt: now,
        now: new Date(now.getTime() + 1),
      },
    );
    assert.equal(
      allocation.targetReceiveSessionId,
      canonical.snapshot.session.receiveSessionId,
    );
    if (verifyRoutingAuthority) {
      const laterPolicySnapshot = {
        ...automationPolicy,
        testConsentRevision: 2,
      } as const;
      const laterConsent = await receiptClient.query<{ id: string }>(
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
         ) values (
           $1, 2, $2, $3, $4, $5, $6::text[], true, null, $7::jsonb, $8, $9
         )
         returning id`,
        [
          telegramFundingSessionId,
          receiveTargetId,
          pUsd.networkId,
          pUsd.assetId,
          pUsd.decimals,
          [pUsdVariantId, variantId],
          JSON.stringify(laterPolicySnapshot),
          canonicalJsonHash(laterPolicySnapshot),
          new Date(now.getTime() + 2),
        ],
      );
      assert.ok(laterConsent.rows[0]?.id);
      await receiptClient.query(
        `update telegram_funding_sessions
         set active_consent_revision = 2
         where id = $1`,
        [telegramFundingSessionId],
      );
    }
    insertedReceipt = await insertFundingReceiveReceipt(receiptClient, {
      receiveSessionId: canonical.snapshot.session.receiveSessionId,
      userId,
      variantId,
      asset: usdce,
      destinationAddress,
      rawAmount: raw,
      observationRevision: opaque("observation"),
      canonicalEvent: receiptEvent,
      observedAt: now,
      handling: "automatic_conversion",
      status: "observed",
      evidence: { fixture: true },
      now,
    });
    assert.equal(
      await finalizeFundingReceiveCanonicalEventAllocation(receiptClient, {
        eventId: allocation.eventId,
        receiveSessionId: canonical.snapshot.session.receiveSessionId,
        receiptId: insertedReceipt.receipt.receiptId,
        now: new Date(now.getTime() + 1),
      }),
      true,
    );
    await receiptClient.query("commit");
  } catch (error) {
    await receiptClient.query("rollback");
    throw error;
  } finally {
    receiptClient.release();
  }
  const routable = await listFundingReceiveReceiptsForRouting(pool, {
    limit: 100,
    now: new Date(now.getTime() + 10 * 60_000),
  });
  const routableIds = routable
    .filter((target) => target.userId === userId)
    .map((target) => target.receipt.receiptId);
  assert.deepEqual(routableIds, [insertedReceipt.receipt.receiptId]);
  if (verifyRoutingAuthority) {
    const target = routable.find(
      (candidate) =>
        candidate.receipt.receiptId === insertedReceipt.receipt.receiptId,
    );
    assert.ok(target);
    assert.equal(target.ownerChannel, "telegram");
    assert.equal(target.telegramFundingConsentId, consentEvidence.id);
    assert.equal(
      target.telegramFundingConsentFingerprint,
      consentEvidence.fingerprint,
    );
    assert.equal(
      target.telegramAutomationPolicy?.presentationMode,
      "pusd_or_usdce_automatic",
      "a later active consent must not replace authority frozen at immutable first-seen",
    );
    assert.equal(await telegramUsdceWrapRoutingAuthorized(pool, target), true);
    await pool.query(
      `update telegram_bot_trading_preferences
       set desired_enabled = false
       where user_id = $1`,
      [userId],
    );
    assert.equal(
      await telegramUsdceWrapRoutingAuthorized(pool, target),
      false,
      "routing must stop automatic conversion when Telegram automation is disabled",
    );
    await pool.query(
      `update telegram_bot_trading_preferences
       set desired_enabled = true
       where user_id = $1`,
      [userId],
    );
    await pool.query(
      `update user_wallets set is_verified = false where id = $1`,
      [userWalletId],
    );
    assert.equal(
      await telegramUsdceWrapRoutingAuthorized(pool, target),
      false,
      "routing must reject a grant whose wallet authority is no longer current",
    );
    const configuredSignerId = process.env.PRIVY_WALLET_AUTHORIZATION_ID;
    process.env.PRIVY_WALLET_AUTHORIZATION_ID = "";
    try {
      assert.deepEqual(
        await telegramUsdceWrapRoutingDecision(pool, target),
        { kind: "hard_invalid", reasonCode: "delegated_authority_invalid" },
        "hard wallet invalidation must win over incomplete runtime config",
      );
    } finally {
      process.env.PRIVY_WALLET_AUTHORIZATION_ID = configuredSignerId;
    }
    await pool.query(
      `update user_wallets set is_verified = true where id = $1`,
      [userWalletId],
    );
    await pool.query(
      `update telegram_funding_sessions
       set telegram_account_id = null
       where id = $1`,
      [telegramFundingSessionId],
    );
    const unlinkedTarget = (
      await listFundingReceiveReceiptsForRouting(pool, {
        limit: 25,
        now: new Date(now.getTime() + 2_000),
      })
    ).find(
      (candidate) =>
        candidate.receipt.receiptId === insertedReceipt.receipt.receiptId,
    );
    assert.ok(unlinkedTarget);
    assert.equal(unlinkedTarget.ownerChannel, "telegram");
    assert.equal(unlinkedTarget.telegramAccountId, null);
    let genericPlanningCalls = 0;
    const unexpectedPlanningCall = async () => {
      genericPlanningCalls += 1;
      throw new Error("hard-invalid Telegram receipt reached generic planning");
    };
    const unlinkedRouting = await new FundingReceiveReceiptRouter(
      pool,
      {
        liquidity: unexpectedPlanningCall,
        quote: unexpectedPlanningCall,
        commit: unexpectedPlanningCall,
      } as never,
      resolveTelegramFundingReceiptDisposition,
    ).runBatch({
      limit: 25,
      now: new Date(now.getTime() + 2_000),
    });
    assert.equal(genericPlanningCalls, 0);
    assert.equal(unlinkedRouting.recoveriesRequired, 1);
    const unlinkedReceipt = await pool.query<{
      child_funding_operation_id: string | null;
      routing_last_error_code: string | null;
      status: string;
    }>(
      `select child_funding_operation_id, routing_last_error_code, status
       from funding_receive_receipts
       where id = $1`,
      [insertedReceipt.receipt.receiptId],
    );
    assert.deepEqual(unlinkedReceipt.rows[0], {
      child_funding_operation_id: null,
      routing_last_error_code: "delegated_authority_invalid",
      status: "recovery_required",
    });
    await pool.query(
      `update telegram_funding_sessions
       set telegram_account_id = $2
       where id = $1`,
      [telegramFundingSessionId, telegramAccountId],
    );
    await pool.query(
      `update funding_receive_receipts
       set status = 'observed',
           routing_disposition = 'pending',
           routing_attempt_count = 0,
           routing_last_error_code = null
       where id = $1`,
      [insertedReceipt.receipt.receiptId],
    );
    await pool.query(
      `update funding_receive_sessions
       set status = 'processing'
       where id = $1`,
      [canonical.snapshot.session.receiveSessionId],
    );
  }

  const resolvedPolicy = await resolveFundingPolicy(pool);
  const fundingPlan = buildPolymarketFundingPlan({
    signer: walletAddress,
    depositWallet: destinationAddress,
    routerAddress: router,
    routerNonce: 77n,
    requiredRaw: BigInt(raw),
    depositPusdRaw: 0n,
    depositLockedRaw: 0n,
    depositUsdceRaw: BigInt(raw),
    depositRouterUsdceAllowanceRaw: BigInt(raw),
    signerPusdRaw: 0n,
    signerUsdceRaw: 0n,
    routerPusdAllowanceRaw: 0n,
    routerUsdceAllowanceRaw: 0n,
    fundingCapRaw: BigInt(raw),
  });
  assert.ok(fundingPlan);
  const venueBinding = {
    bindingId: venueBindingOptionId,
    venueId: "polymarket",
    controllerWalletId: actionWalletId,
    executionWalletId: actionWalletId,
    accountRef: destinationAddress,
    settlementLocation: {
      kind: "venue_account",
      locationId: opaque("settlement_location"),
      accountId: userId,
      asset: pUsd,
      details: {
        address: destinationAddress,
        venueId: "polymarket",
      },
    },
    signingMode: "privy_authorization",
  } as const;
  const action = {
    kind: "evm_transaction",
    actionId: opaque("wrap_action"),
    networkId: "evm:137",
    senderWalletId: actionWalletId,
    to: router,
    data: fundingPlan.calldata,
    valueRaw: "0",
    gasLimitRaw: null,
  } as const;
  const plan: FundingCommitPlan = {
    operation: {
      purpose: "add_funds",
      initialState: { status: "in_progress", stage: "committed" },
      experienceMode: "prepare_first",
      planKind: "venue_preparation",
      sourceSnapshot: {
        receiveSessionId: canonical.snapshot.session.receiveSessionId,
      },
      destinationTargetSnapshot: { destinationOptionId },
      externalRecipientId: null,
      venueId: "polymarket",
      marketId: null,
      marketContextSnapshot: null,
      venueBindingSnapshot: venueBinding as unknown as JsonRecord,
      walletExecutionSnapshot: {
        walletId: actionWalletId,
        address: walletAddress,
      },
      placementSnapshot: {},
      requestedSourceAmount: rawAmount(raw),
      requestedDestinationAmount: {
        asset: pUsd,
        raw,
      } as unknown as JsonRecord,
      supportMetadata: {
        preparationKind: "polymarket_funding_router",
        venueBindingOptionId,
        fundingAuthorizationId: authorization.id,
        fundingAuthorizationFingerprint:
          telegramFundingAuthorizationFingerprint(authorization),
        fundingReceiveReceiptId: insertedReceipt.receipt.receiptId,
        telegramFundingConsentId: consentEvidence.id,
        telegramFundingConsentFingerprint: consentEvidence.fingerprint,
        fundingPlan: fundingPlan as unknown as JsonRecord,
        before: {
          routerNonceRaw: "77",
          depositPusdRaw: "0",
          clobPusdRaw: "0",
          observedAt: now.toISOString(),
        },
      },
    },
    segments: [],
    steps: [
      {
        ordinal: 0,
        segmentOrdinal: null,
        stepKind: "venue_preparation",
        state: "action_required",
        actionFingerprint: canonicalJsonHash(action),
        executorId: POLYMARKET_DEPOSIT_USDCE_WRAP_PROFILE_ID,
        payerRequirement: "privy_sponsor",
        dependsOnOrdinal: null,
        normalizedAction: action as unknown as JsonRecord,
        actionValidationResult: { valid: true, signerAddress: walletAddress },
      },
    ],
    reservations: [
      {
        segmentOrdinal: null,
        componentId: variantId,
        locationId: sourceLocationId,
        networkId: usdce.networkId,
        assetId: usdce.assetId,
        assetDecimals: usdce.decimals,
        rawAmount: raw,
        mode: "subtract_available",
        expiresAt: new Date(now.getTime() + 60_000).toISOString(),
      },
    ],
  };
  const consentToken = opaque("consent_token");
  const quote = await createFundingQuote(pool, {
    userId,
    discoveryProjectionId: opaque("projection"),
    selectedSourceOptionSnapshot: {
      receiveSessionId: canonical.snapshot.session.receiveSessionId,
    },
    marketContextSnapshot: null,
    destinationOptionSnapshot: { destinationOptionId },
    venueBindingSnapshot: plan.operation.venueBindingSnapshot,
    planSnapshot: plan,
    policyVersion: resolvedPolicy.runtime.contractVersion,
    policyRevision: resolvedPolicy.revision,
    canonicalRequest: { receiptId: insertedReceipt.receipt.receiptId, raw },
    consentToken,
    expiresAt: new Date(now.getTime() + 60_000),
  });
  const committed = await commitFundingOperation(pool, {
    userId,
    quoteId: quote.id,
    consentToken,
    idempotencyKey: opaque("receipt_wrap"),
    plan,
    subjectLookupHmac: crypto.createHash("sha256").update(userId).digest("hex"),
    subjectLookupKeyVersion: 1,
    now,
  });
  await pool.query(
    `update funding_receive_receipts
     set status = 'routing', child_funding_operation_id = $2, updated_at = $3
     where id = $1`,
    [insertedReceipt.receipt.receiptId, committed.operation.id, now],
  );
  const fixture = {
    actionWalletId,
    authorizationId: authorization.id,
    consentFingerprint: consentEvidence.fingerprint,
    consentId: consentEvidence.id,
    destinationAddress,
    destinationLocationId,
    fundingPlan,
    operationId: committed.operation.id,
    privyWalletId,
    pUsdVariantId,
    quoteId: quote.id,
    receiptIds: [
      oldReceipt.receipt.receiptId,
      insertedReceipt.receipt.receiptId,
    ],
    receiveSessionId: canonical.snapshot.session.receiveSessionId,
    telegramFundingSessionId,
    telegramAccountId,
    userId,
    userWalletId,
    signerAddress: walletAddress,
    plan,
  };
  fixtures.push(fixture);
  return fixture;
}

async function insertReadyPusdReceipt(
  fixture: Fixture,
  rawAmount: string,
  observedAt: Date,
  transactionHash = `0x${crypto.randomBytes(32).toString("hex")}`,
): Promise<string> {
  const inserted = await insertFundingReceiveReceipt(pool, {
    receiveSessionId: fixture.receiveSessionId,
    userId: fixture.userId,
    variantId: fixture.pUsdVariantId,
    asset: pUsd,
    destinationAddress: fixture.destinationAddress,
    rawAmount,
    observationRevision: opaque("pusd_ready_observation"),
    canonicalEvent: {
      transactionHash,
      eventIndex: "0",
      ledgerHeight: "102",
      blockHash: `0x${crypto.randomBytes(32).toString("hex")}`,
      sourceAddress: router,
    },
    observedAt,
    handling: "direct",
    status: "ready",
    evidence: { fixture: true, exactConversionOutput: true },
    now: observedAt,
  });
  return inserted.receipt.receiptId;
}

type RelayFixture = Readonly<{
  authorizationId: string;
  authorizationFingerprint: string;
  base: Fixture;
  consentFingerprint: string;
  consentId: string;
  depositStepId: string;
  operationId: string;
  approvalStepId: string;
  plan: FundingCommitPlan;
  receiptId: string;
  walletAddress: string;
  walletId: string;
}>;

async function createRelayFixture(
  raw = "2000000",
  options: Readonly<{
    base?: Fixture;
    checksumReceiptAddresses?: boolean;
    expectCapReservation?: boolean;
  }> = {},
): Promise<RelayFixture> {
  await publishFundingPolicy(false, true, {
    assets: ["polygon:pusd", "polygon:usdce", "base:usdc"],
    delegatedRelayEvmDailyCapUsd: "10",
  });
  const base = options.base ?? (await createFixture(raw));
  const binding = await pool.query<{
    destination_option_id: string;
    telegram_user_id: string;
    venue_binding_option_id: string;
    wallet_address: string;
  }>(
    `select destination_option_id, venue_binding_option_id,
            telegram_user_id, wallet_address
       from telegram_funding_authorizations
      where id = $1`,
    [base.authorizationId],
  );
  const identity = binding.rows[0];
  assert.ok(identity);
  const walletId = stableWalletOpaqueId({
    walletType: "ethereum",
    networkId: "evm:8453",
    address: identity.wallet_address,
  });
  const authorization = await ensureTelegramRelayEvmFundingAuthorization(
    pool,
    {
      userId: base.userId,
      telegramAccountId: base.telegramAccountId,
      telegramUserId: identity.telegram_user_id,
      controllerWalletId: base.actionWalletId,
      destinationOptionId: identity.destination_option_id,
      venueBindingOptionId: identity.venue_binding_option_id,
      now,
    },
    {
      configuration: relayConfiguration,
      inspectWalletProfile: async () => "valid",
    },
  );
  assert.ok(authorization);
  extraAuthorizationIds.push(authorization.id);
  const policy = await resolveFundingPolicy(pool);
  const relayVariantId = opaque("base_usdc_variant");
  const automationPolicy = {
    ...buildTelegramRelayEvmAutomationPolicyV3({
      authorization,
      sourceAsset: {
        networkId: "evm:8453",
        assetId: BASE_USDC,
        decimals: 6,
      },
      destinationAsset: {
        networkId: "evm:137",
        assetId: POLYGON_PUSD,
        decimals: 6,
      },
      fundingPolicyRevision: policy.revision,
      variants: [
        {
          variantId: relayVariantId,
          networkId: "evm:8453",
          asset: {
            networkId: "evm:8453",
            assetId: BASE_USDC,
            decimals: 6,
          },
          destinationAddress: identity.wallet_address,
          destinationLocationId: opaque("base_location"),
          baselineRaw: "0",
          baselineRevision: opaque("base_baseline"),
          observation: {
            adapterId: "base_usdc_receive_v1",
            payload: {
              eventIdentity: "evm_erc20_transfer_v1",
              eventCursorBlock: "100",
            },
          },
          completion: { kind: "committed_venue_preparation", stepOrdinal: 1 },
        },
      ],
    }),
    presentationMode: "base_usdc_relay_automatic",
    presentation: telegramPolygonFundingPresentation(
      "base_usdc_relay_automatic",
    ),
  } as const;
  const activeConsent = await pool.query<{
    receive_target_id: string;
    revision: number;
  }>(
    `select selected_receive_target_id as receive_target_id,
            coalesce(max(revision), 0)::integer as revision
       from telegram_funding_consents
      where telegram_funding_session_id = $1
      group by selected_receive_target_id
      order by revision desc limit 1`,
    [base.telegramFundingSessionId],
  );
  const consentRevision = (activeConsent.rows[0]?.revision ?? 0) + 1;
  const consentFingerprint = canonicalJsonHash(automationPolicy);
  const consent = await pool.query<{ id: string }>(
    `insert into telegram_funding_consents (
       telegram_funding_session_id, revision, selected_receive_target_id,
       selected_asset_network_id, selected_asset_id,
       selected_asset_decimals, consented_variant_ids, automation_enabled,
       max_auto_execute_source_raw, automation_policy_snapshot,
       consent_fingerprint, consented_at
     ) values (
       $1, $2, $3, 'evm:137', $4, 6, $5::text[], true, $6::numeric,
       $7::jsonb, $8, $9
     ) returning id`,
    [
      base.telegramFundingSessionId,
      consentRevision,
      activeConsent.rows[0]?.receive_target_id,
      POLYGON_PUSD,
      [relayVariantId],
      relayConfiguration.maxSourceRaw,
      JSON.stringify(automationPolicy),
      consentFingerprint,
      now,
    ],
  );
  const consentId = consent.rows[0]?.id;
  assert.ok(consentId);
  await pool.query(
    `update telegram_funding_sessions
        set active_consent_revision = $2
      where id = $1`,
    [base.telegramFundingSessionId, consentRevision],
  );
  const receiptSourceAddress = `0x${crypto.randomBytes(20).toString("hex")}`;
  const receipt = await insertFundingReceiveReceipt(pool, {
    receiveSessionId: base.receiveSessionId,
    userId: base.userId,
    variantId: relayVariantId,
    asset: { networkId: "evm:8453", assetId: BASE_USDC, decimals: 6 },
    destinationAddress: options.checksumReceiptAddresses
      ? getAddress(identity.wallet_address)
      : identity.wallet_address,
    rawAmount: raw,
    observationRevision: opaque("relay_receipt_observation"),
    canonicalEvent: {
      transactionHash: `0x${crypto.randomBytes(32).toString("hex")}`,
      eventIndex: "0",
      ledgerHeight: "101",
      blockHash: `0x${crypto.randomBytes(32).toString("hex")}`,
      sourceAddress: options.checksumReceiptAddresses
        ? getAddress(receiptSourceAddress)
        : receiptSourceAddress,
    },
    observedAt: now,
    handling: "automatic_conversion",
    status: "observed",
    evidence: { relayFixture: true },
    now,
  });
  const receiptId = receipt.receipt.receiptId;
  relayArtifactReceiptIds.push(receiptId);
  const erc20 = new Interface([
    "function approve(address spender,uint256 amount)",
  ]);
  const depository = new Interface([
    "function depositErc20(address depositor,address token,uint256 amount,bytes32 id)",
  ]);
  const approvalAction = {
    kind: "evm_transaction" as const,
    actionId: `${opaque("relay")}:approve`,
    networkId: "evm:8453",
    senderWalletId: walletId,
    to: BASE_USDC,
    data: erc20.encodeFunctionData("approve", [RELAY_DEPOSITORY_V2, raw]),
    valueRaw: "0",
    gasLimitRaw: null,
  };
  const depositAction = {
    ...approvalAction,
    actionId: `${opaque("relay")}:deposit`,
    to: RELAY_DEPOSITORY_V2,
    data: depository.encodeFunctionData("depositErc20", [
      RELAY_SELF_DEPOSITOR,
      BASE_USDC,
      raw,
      `0x${crypto.randomBytes(32).toString("hex")}`,
    ]),
  };
  const relaySourceAmount = {
    asset: { networkId: "evm:8453", assetId: BASE_USDC, decimals: 6 },
    raw,
  } as unknown as JsonRecord;
  const relayDestinationAmount = {
    asset: { networkId: "evm:137", assetId: POLYGON_PUSD, decimals: 6 },
    raw,
  } as unknown as JsonRecord;
  const plan: FundingCommitPlan = {
    operation: {
      purpose: "add_funds",
      initialState: { status: "in_progress", stage: "committed" },
      experienceMode: "prepare_first",
      planKind: "wallet_route",
      sourceSnapshot: { receiveSessionId: base.receiveSessionId },
      destinationTargetSnapshot: {
        destinationOptionId: identity.destination_option_id,
        kind: "owned_location",
        location: {
          kind: "venue_account",
          locationId: base.destinationLocationId,
          accountId: base.userId,
          asset: relayDestinationAmount.asset,
          details: {
            address: base.destinationAddress,
            venueId: "polymarket",
          },
        },
      },
      externalRecipientId: null,
      venueId: "polymarket",
      marketId: null,
      marketContextSnapshot: null,
      venueBindingSnapshot: {
        venueBindingOptionId: identity.venue_binding_option_id,
      },
      walletExecutionSnapshot: {
        walletId,
        address: identity.wallet_address,
      },
      placementSnapshot: {},
      requestedSourceAmount: relaySourceAmount,
      requestedDestinationAmount: relayDestinationAmount,
      supportMetadata: {
        routeId: "base-usdc-to-polygon-pusd",
        relayApprovalBaselineAllowanceRaw: "0",
        relayApprovalBaselineAllowanceBlock: "100",
        relayApprovalBaselineAllowanceBlockHash: `0x${"aa".repeat(32)}`,
        relayApprovalBaselineAllowanceRevision: "b".repeat(64),
      },
    },
    segments: [
      {
        providerId: "relay",
        adapterId: "relay_wallet_v2",
        adapterVersion: 1,
        segmentKind: "cross_network_swap",
        status: "planned",
        sourceSnapshot: {
          receiveSessionId: base.receiveSessionId,
          amount: relaySourceAmount,
        },
        destinationTargetSnapshot: {
          destinationOptionId: identity.destination_option_id,
          amount: relayDestinationAmount,
        },
        quotedInput: relaySourceAmount,
        quotedExpectedOutput: relayDestinationAmount,
        quotedMinOutput: relayDestinationAmount,
        providerQuoteRefCiphertext: "cipher:relay-quote",
        providerQuoteRefLookupHmac: crypto
          .createHash("sha256")
          .update(`${base.userId}:relay-quote`)
          .digest("hex"),
        depositAddressCiphertext: null,
        depositAddressLookupHmac: null,
        lookupKeyVersion: 1,
        refundLocationSnapshot: { receiveSessionId: base.receiveSessionId },
        quoteExpiresAt: new Date(now.getTime() + 40 * 60_000).toISOString(),
      },
    ],
    reservations: [
      {
        segmentOrdinal: 0,
        componentId: relayVariantId,
        locationId: walletId,
        networkId: "evm:8453",
        assetId: BASE_USDC,
        assetDecimals: 6,
        rawAmount: raw,
        mode: "subtract_available",
        expiresAt: new Date(now.getTime() + 40 * 60_000).toISOString(),
      },
    ],
    steps: [
      {
        ordinal: 0,
        segmentOrdinal: 0,
        stepKind: "approval",
        state: "planned",
        actionFingerprint: canonicalJsonHash(approvalAction),
        executorId: TELEGRAM_RELAY_EVM_FUNDING_PROFILE_ID,
        payerRequirement: "privy_sponsor",
        dependsOnOrdinal: null,
        normalizedAction: approvalAction as unknown as JsonRecord,
        actionValidationResult: { relayStepKind: "approve" },
        actionExpiresAt: new Date(now.getTime() + 40 * 60_000).toISOString(),
      },
      {
        ordinal: 1,
        segmentOrdinal: 0,
        stepKind: "transaction",
        state: "planned",
        actionFingerprint: canonicalJsonHash(depositAction),
        executorId: TELEGRAM_RELAY_EVM_FUNDING_PROFILE_ID,
        payerRequirement: "privy_sponsor",
        dependsOnOrdinal: 0,
        normalizedAction: depositAction as unknown as JsonRecord,
        actionValidationResult: {
          relayStepKind: "deposit",
          postconditionEvidenceKind: "exact_erc20_source_debit_v1",
          expectedSourceAssetId: BASE_USDC,
          expectedSourceAddress: identity.wallet_address,
          expectedSourceRecipient: RELAY_DEPOSITORY_V2,
          expectedSourceRaw: raw,
        },
        actionExpiresAt: new Date(now.getTime() + 40 * 60_000).toISOString(),
      },
    ],
  };
  const sourceSnapshot = plan.operation.sourceSnapshot;
  assert.ok(sourceSnapshot);
  const consentToken = opaque("relay_consent_token");
  const quote = await createFundingQuote(pool, {
    userId: base.userId,
    discoveryProjectionId: opaque("relay_projection"),
    selectedSourceOptionSnapshot: sourceSnapshot,
    marketContextSnapshot: null,
    destinationOptionSnapshot: plan.operation.destinationTargetSnapshot,
    venueBindingSnapshot: plan.operation.venueBindingSnapshot,
    planSnapshot: plan,
    policyVersion: policy.runtime.contractVersion,
    policyRevision: policy.revision,
    canonicalRequest: { receiptId, raw, relay: true },
    consentToken,
    expiresAt: new Date(now.getTime() + 40 * 60_000),
  });
  relayArtifactQuoteIds.push(quote.id);
  const committed = await commitFundingOperation(pool, {
    userId: base.userId,
    quoteId: quote.id,
    consentToken,
    idempotencyKey: opaque("relay_operation"),
    plan,
    subjectLookupHmac: crypto
      .createHash("sha256")
      .update(`${base.userId}:relay`)
      .digest("hex"),
    subjectLookupKeyVersion: 1,
    now,
  });
  relayArtifactOperationIds.push(committed.operation.id);
  const beforeLink = await pool.query<{ ordinal: number; state: string }>(
    `select ordinal, state from funding_operation_steps
      where operation_id = $1 order by ordinal`,
    [committed.operation.id],
  );
  assert.deepEqual(beforeLink.rows, [
    { ordinal: 0, state: "planned" },
    { ordinal: 1, state: "planned" },
  ]);
  const link = () =>
    tx(pool, (client) =>
      linkFundingReceiveReceiptOperationInTransaction(client, {
        receiptId,
        userId: base.userId,
        childFundingOperationId: committed.operation.id,
        authorizationId: authorization.id,
        authorizationFingerprint:
          telegramFundingAuthorizationFingerprint(authorization),
        telegramFundingConsentId: consentId,
        telegramFundingConsentFingerprint: consentFingerprint,
        serverExecutionProfileId: TELEGRAM_RELAY_EVM_FUNDING_PROFILE_ID,
        now,
      }),
    );
  if (options.expectCapReservation === false) {
    await assert.rejects(
      link,
      /routed funding authorization cap is unavailable/,
    );
  } else {
    assert.equal(await link(), true);
  }
  const steps = await pool.query<{
    id: string;
    ordinal: number;
    state: string;
  }>(
    `select id, ordinal, state from funding_operation_steps
      where operation_id = $1 order by ordinal`,
    [committed.operation.id],
  );
  assert.equal(
    steps.rows[0]?.state,
    options.expectCapReservation === false ? "planned" : "action_required",
  );
  assert.equal(steps.rows[1]?.state, "planned");
  const approvalStepId = steps.rows[0]?.id;
  const depositStepId = steps.rows[1]?.id;
  assert.ok(approvalStepId);
  assert.ok(depositStepId);
  return {
    authorizationId: authorization.id,
    authorizationFingerprint:
      telegramFundingAuthorizationFingerprint(authorization),
    base,
    consentFingerprint,
    consentId,
    approvalStepId,
    depositStepId,
    operationId: committed.operation.id,
    plan,
    receiptId,
    walletAddress: identity.wallet_address,
    walletId,
  };
}

async function prepareRelayRefundWatch(
  fixture: RelayFixture,
  input: Readonly<{
    refundTransactionHash: string;
    refundBlockHash: string;
    referenceTransactionHashes: readonly string[];
    sourceBlock?: string;
    refundBlock?: string;
  }>,
) {
  const preparedAt = new Date();
  const segment = await pool.query<{ id: string }>(
    `select id
       from funding_operation_segments
      where operation_id = $1::uuid
        and ordinal = 0`,
    [fixture.operationId],
  );
  const segmentId = segment.rows[0]?.id;
  assert.ok(segmentId);
  await pool.query(
    `update funding_operation_segments
        set support_metadata = support_metadata || jsonb_build_object(
              'relayStatusCategory', 'refund_in_progress',
              'relayTransactionReferenceFingerprints', $2::jsonb
            )
      where id = $1::uuid`,
    [
      segmentId,
      JSON.stringify(
        input.referenceTransactionHashes.map((reference) =>
          referenceCodec.fingerprint(reference),
        ),
      ),
    ],
  );
  await tx(pool, async (client) => {
    await allocateFundingObservationInTransaction(client, {
      operationId: fixture.operationId,
      segmentId,
      kind: "source_debit",
      networkId: "evm:8453",
      assetId: BASE_USDC,
      assetDecimals: 6,
      txHash: `0x${crypto.randomBytes(32).toString("hex")}`,
      eventIndex: "0",
      fromAddress: fixture.walletAddress,
      toAddress: RELAY_DEPOSITORY_V2,
      rawAmount: "2000000",
      observedAt: preparedAt,
      ledgerHeight: input.sourceBlock ?? "110",
      blockHash: `0x${crypto.randomBytes(32).toString("hex")}`,
      finalityStatus: "finalized",
      finalizedAt: preparedAt,
      metadata: { relayDeposit: true },
    });
    await allocateFundingObservationInTransaction(client, {
      operationId: fixture.operationId,
      segmentId,
      kind: "refund_credit",
      networkId: "evm:8453",
      assetId: BASE_USDC,
      assetDecimals: 6,
      txHash: input.refundTransactionHash,
      eventIndex: "0",
      fromAddress: RELAY_DEPOSITORY_V2,
      toAddress: fixture.walletAddress,
      rawAmount: "2000000",
      observedAt: preparedAt,
      ledgerHeight: input.refundBlock ?? "120",
      blockHash: input.refundBlockHash,
      finalityStatus: "finalized",
      finalizedAt: preparedAt,
      metadata: {
        observerId: "relay_owned_refund_observation_v1",
        relayTransactionReferenceMatched: true,
      },
    });
  });
  const reduced = await reduceFundingOperation(pool, {
    operationId: fixture.operationId,
    now: preparedAt,
  });
  assert.deepEqual(reduced.finalState, {
    status: "refunded",
    stage: "terminal",
  });
  const reservation = await pool.query<{ status: string }>(
    `select status
       from telegram_funding_authorization_reservations
      where funding_operation_id = $1::uuid`,
    [fixture.operationId],
  );
  assert.equal(reservation.rows[0]?.status, "refunded");
  return { segmentId, preparedAt };
}

function relayAllowanceEvidence(
  raw: string,
  serial: string,
  ownershipSerial = raw,
  lastMutationTransactionHash = raw === "0" ? null : `0x${"51".repeat(32)}`,
  finality: "latest" | "finalized" = "latest",
  blockNumber = "200",
) {
  return {
    raw,
    blockNumber,
    blockHash: `0x${serial.padStart(64, "0").slice(-64)}`,
    finality,
    revision: crypto
      .createHash("sha256")
      .update(`allowance:${raw}:${serial}`)
      .digest("hex"),
    ownershipRevision: crypto
      .createHash("sha256")
      .update(`allowance-ownership:${ownershipSerial}`)
      .digest("hex"),
    lastMutationTransactionHash,
  } as const;
}

function relayExecutor(
  observations: Array<ReturnType<typeof relayAllowanceEvidence>>,
  onExecute: (claim: DelegatedFundingExecutionClaim) => void,
  onAllowanceRead?: (input: Parameters<RelayEvmAllowanceReader>[0]) => void,
) {
  let last = observations.at(-1) ?? relayAllowanceEvidence("0", "1");
  return new DelegatedFundingExecutor(pool, {
    profiles: [
      createRelayEvmDelegatedFundingProfile({
        configuration: relayConfiguration,
        allowanceReader: async (input) => {
          onAllowanceRead?.(input);
          last = observations.shift() ?? last;
          return last;
        },
        driver: {
          execute: async (claim) => {
            onExecute(claim);
            return {
              kind: "submitted" as const,
              transactionReference: `0x${crypto.randomBytes(32).toString("hex")}`,
            };
          },
          recover: async () => ({ kind: "pending" as const }),
          lookupProviderReference: async () => ({ kind: "pending" as const }),
        },
      }),
    ],
    referenceCodec,
    providerLookupDelayMs: 1,
    providerReplayMs: 1,
    unbroadcastRetryMs: 1,
  });
}

function relayExecutorWithBoundaryMutation(
  observations: Array<ReturnType<typeof relayAllowanceEvidence>>,
  onExecute: (claim: DelegatedFundingExecutionClaim) => void,
  mutate: (client: PoolClient) => Promise<void>,
) {
  let last = observations.at(-1) ?? relayAllowanceEvidence("0", "1");
  const profile = createRelayEvmDelegatedFundingProfile({
    configuration: relayConfiguration,
    allowanceReader: async () => {
      last = observations.shift() ?? last;
      return last;
    },
    driver: {
      execute: async (claim) => {
        onExecute(claim);
        return {
          kind: "submitted" as const,
          transactionReference: `0x${crypto.randomBytes(32).toString("hex")}`,
        };
      },
      recover: async () => ({ kind: "pending" as const }),
      lookupProviderReference: async () => ({ kind: "pending" as const }),
    },
  });
  const decide = profile.preBroadcastDecisionInTransaction;
  let mutated = false;
  return new DelegatedFundingExecutor(pool, {
    profiles: [
      {
        ...profile,
        preBroadcastDecisionInTransaction: async (client, input) => {
          if (!mutated) {
            mutated = true;
            await mutate(client);
          }
          return decide(client, input);
        },
      },
    ],
    referenceCodec,
    providerLookupDelayMs: 1,
    providerReplayMs: 1,
    unbroadcastRetryMs: 1,
  });
}

async function recordRelayApprovalFailure(
  fixture: RelayFixture,
  at: Date,
  stepId = fixture.approvalStepId,
): Promise<void> {
  const attempt = await pool.query<{ id: string }>(
    `select id from funding_operation_step_attempts
      where step_id = $1 order by attempt_number desc limit 1`,
    [stepId],
  );
  const attemptId = attempt.rows[0]?.id;
  assert.ok(attemptId);
  await tx(pool, (client) =>
    applyFundingStepReceiptEvidenceInTransaction(client, {
      operationId: fixture.operationId,
      stepId,
      attemptId,
      networkId: "evm:8453",
      receipt: {
        status: "failed",
        actionMatch: true,
        ledgerHeight: "150",
        blockHash: `0x${crypto.randomBytes(32).toString("hex")}`,
        canonical: true,
        failureCode: "sponsored_user_operation_failed",
        evidence: { failureFinalized: true },
      },
      now: at,
    }),
  );
}

async function exhaustRelayDeposit(
  fixture: RelayFixture,
  executeCounter: { value: number },
  ownershipSerial: string,
): Promise<void> {
  const approval = relayAllowanceEvidence(
    "2000000",
    ownershipSerial,
    ownershipSerial,
  );
  const serial = BigInt(ownershipSerial);
  const executor = relayExecutor(
    [
      relayAllowanceEvidence("0", (serial + 100n).toString()),
      approval,
      relayAllowanceEvidence(
        "2000000",
        (serial + 200n).toString(),
        ownershipSerial,
      ),
      relayAllowanceEvidence(
        "2000000",
        (serial + 300n).toString(),
        ownershipSerial,
      ),
    ],
    () => {
      executeCounter.value += 1;
    },
  );
  assert.equal((await executor.runBatch({ limit: 1, now })).submitted, 1);
  await recordRelayApprovalSuccess(
    fixture,
    new Date(now.getTime() + 1),
    approval.blockHash,
  );
  assert.equal(
    (await executor.runBatch({ limit: 1, now: new Date(now.getTime() + 2) }))
      .submitted,
    1,
  );
  await recordRelayApprovalFailure(
    fixture,
    new Date(now.getTime() - 31 * 60_000),
    fixture.depositStepId,
  );
  assert.equal(
    (
      await executor.runBatch({
        limit: 1,
        now: new Date(now.getTime() + 15 * 60_000 + 3),
      })
    ).submitted,
    1,
  );
  await recordRelayApprovalFailure(
    fixture,
    new Date(now.getTime() - 16 * 60_000),
    fixture.depositStepId,
  );
  assert.equal(executeCounter.value, 3);
}

async function recordRelayApprovalSuccess(
  fixture: RelayFixture,
  at: Date,
  blockHash: string,
): Promise<void> {
  const attempt = await pool.query<{ id: string }>(
    `select id from funding_operation_step_attempts
      where step_id = $1 order by attempt_number desc limit 1`,
    [fixture.approvalStepId],
  );
  const attemptId = attempt.rows[0]?.id;
  assert.ok(attemptId);
  await tx(pool, (client) =>
    applyFundingStepReceiptEvidenceInTransaction(client, {
      operationId: fixture.operationId,
      stepId: fixture.approvalStepId,
      attemptId,
      networkId: "evm:8453",
      receipt: {
        status: "finalized",
        actionMatch: true,
        ledgerHeight: "200",
        blockHash,
        canonical: true,
        failureCode: null,
        evidence: {
          singleOperationBundle: true,
          transactionHash: `0x${"51".repeat(32)}`,
        },
      },
      now: at,
    }),
  );
}

async function recordRelayDepositSuccess(
  fixture: RelayFixture,
  input: Readonly<{
    at: Date;
    blockHash: string;
    ledgerHeight?: string;
    transactionHash: string;
  }>,
): Promise<void> {
  const attempt = await pool.query<{ id: string }>(
    `select id from funding_operation_step_attempts
      where step_id = $1 order by attempt_number desc limit 1`,
    [fixture.depositStepId],
  );
  const attemptId = attempt.rows[0]?.id;
  assert.ok(attemptId);
  await tx(pool, (client) =>
    applyFundingStepReceiptEvidenceInTransaction(client, {
      operationId: fixture.operationId,
      stepId: fixture.depositStepId,
      attemptId,
      networkId: "evm:8453",
      receipt: {
        status: "finalized",
        actionMatch: true,
        ledgerHeight: input.ledgerHeight ?? "201",
        blockHash: input.blockHash,
        canonical: true,
        failureCode: null,
        evidence: {
          attributedSourceRaw: "2000000",
          singleOperationBundle: true,
          sourceDebitEventIndex: "0",
          transactionHash: input.transactionHash,
        },
      },
      now: input.at,
    }),
  );
}

async function exhaustRelayApproval(
  fixture: RelayFixture,
  executeCounter: { value: number },
): Promise<void> {
  const executor = relayExecutor(
    [relayAllowanceEvidence("0", "11"), relayAllowanceEvidence("0", "12")],
    () => {
      executeCounter.value += 1;
    },
  );
  const first = await executor.runBatch({ limit: 1, now });
  assert.equal(first.submitted, 1, JSON.stringify(first));
  await recordRelayApprovalFailure(
    fixture,
    new Date(now.getTime() - 31 * 60_000),
  );
  assert.equal(
    (
      await executor.runBatch({
        limit: 1,
        now: new Date(now.getTime() + 15 * 60_000 + 1),
      })
    ).submitted,
    1,
  );
  await recordRelayApprovalFailure(
    fixture,
    new Date(now.getTime() - 16 * 60_000),
  );
  assert.equal(executeCounter.value, 2);
}

async function assertSecondSourceReservationBlocked(
  fixture: Fixture,
): Promise<void> {
  const consentToken = opaque("second_consent");
  const policy = await resolveFundingPolicy(pool);
  const quote = await createFundingQuote(pool, {
    userId: fixture.userId,
    discoveryProjectionId: opaque("second_projection"),
    selectedSourceOptionSnapshot: fixture.plan.operation.sourceSnapshot ?? {},
    marketContextSnapshot: null,
    destinationOptionSnapshot: fixture.plan.operation.destinationTargetSnapshot,
    venueBindingSnapshot: fixture.plan.operation.venueBindingSnapshot,
    planSnapshot: fixture.plan,
    policyVersion: policy.runtime.contractVersion,
    policyRevision: policy.revision,
    canonicalRequest: { secondRouterOperation: true },
    consentToken,
    expiresAt: new Date(Date.now() + 60_000),
  });
  try {
    await assert.rejects(
      commitFundingOperation(pool, {
        userId: fixture.userId,
        quoteId: quote.id,
        consentToken,
        idempotencyKey: opaque("second_router_operation"),
        plan: fixture.plan,
        subjectLookupHmac: crypto
          .createHash("sha256")
          .update(`${fixture.userId}:second`)
          .digest("hex"),
        subjectLookupKeyVersion: 1,
      }),
      (error: unknown) =>
        error instanceof FundingPersistenceError &&
        error.code === "quote_invalidated",
    );
  } finally {
    await pool.query(`delete from funding_quotes where id = $1`, [quote.id]);
  }
}

async function finalizeRecoveredFixture(
  fixture: Fixture,
  input: Readonly<{ attemptId: string; stepId: string; now: Date }>,
): Promise<void> {
  await tx(pool, (client) =>
    applyFundingStepReceiptEvidenceInTransaction(client, {
      operationId: fixture.operationId,
      stepId: input.stepId,
      attemptId: input.attemptId,
      networkId: "evm:137",
      receipt: {
        status: "finalized",
        actionMatch: true,
        ledgerHeight: "102",
        blockHash: `0x${crypto.randomBytes(32).toString("hex")}`,
        canonical: true,
        failureCode: null,
        evidence: {
          attributedDestinationRaw: fixture.fundingPlan.totalAmountRaw,
        },
      },
      now: input.now,
    }),
  );
  assert.deepEqual(
    await new PolymarketFundingPostconditionDriver(referenceCodec, {
      observe: async ({ signerAddress }) => {
        assert.equal(signerAddress.toLowerCase(), fixture.signerAddress);
        return {
          routerNonceRaw: "78",
          depositPusdRaw: fixture.fundingPlan.totalAmountRaw,
          clobPusdRaw: fixture.fundingPlan.totalAmountRaw,
          observedAt: input.now.toISOString(),
        };
      },
    }).pollOperation(pool, fixture.operationId, input.now),
    { postconditionsPolled: 1 },
  );
  const reduction = await reduceFundingOperation(pool, {
    operationId: fixture.operationId,
    now: input.now,
  });
  assert.deepEqual(reduction.finalState, {
    status: "completed",
    stage: "terminal",
  });
  const routing = await new FundingReceiveReceiptRouter(
    pool,
    undefined,
    resolveTelegramFundingReceiptDisposition,
  ).runBatch({ limit: 100, now: input.now });
  assert.ok(routing.receiptsReady >= 1);
  const receipt = await pool.query<{
    routing_disposition: string;
    status: string;
  }>(
    `select status, routing_disposition
       from funding_receive_receipts
      where child_funding_operation_id = $1`,
    [fixture.operationId],
  );
  assert.deepEqual(receipt.rows[0], {
    status: "ready",
    routing_disposition: "ready",
  });
  assert.equal(
    await hasReadyTelegramFundingDestinationReceipt(
      pool,
      fixture.telegramFundingSessionId,
    ),
    true,
  );
}

async function strandFixtureForAutomaticEvidence(
  fixture: Fixture,
): Promise<void> {
  await reduceFundingOperation(pool, {
    operationId: fixture.operationId,
    now: new Date(now.getTime() + 1),
  });
  await tx(pool, async (client) => {
    await client.query(
      `update funding_operations
          set status = 'recovery_required',
              recovery_mode = 'automatic_evidence',
              error_code = 'reconciliation_evidence_timeout',
              version = version + 1
        where id = $1
          and status = 'reconcile_required'
          and progress_stage = 'source_action'`,
      [fixture.operationId],
    );
    await client.query(
      `update funding_operation_steps
          set state = 'recovery_required'
        where operation_id = $1
          and state = 'reconcile_required'`,
      [fixture.operationId],
    );
  });
}

async function assertOperationAttachmentFailureRollsBack(
  fixture: Fixture,
  input: Readonly<{ plannedStep?: boolean }> = {},
): Promise<void> {
  const consentToken = opaque("atomic_link_consent");
  const idempotencyKey = opaque("atomic_link_operation");
  const policy = await resolveFundingPolicy(pool);
  const linkPlan: FundingCommitPlan = input.plannedStep
    ? {
        ...fixture.plan,
        steps: fixture.plan.steps.map((step) => ({
          ...step,
          state: "planned" as const,
        })),
      }
    : fixture.plan;
  if (input.plannedStep) {
    const consentPolicy = await pool.query<{ revision: string | null }>(
      `select automation_policy_snapshot ->> 'fundingPolicyRevision' as revision
         from telegram_funding_consents
        where id = $1`,
      [fixture.consentId],
    );
    assert.notEqual(
      policy.revision,
      consentPolicy.rows[0]?.revision,
      "the atomic-link race fixture requires different operation and consent policy revisions",
    );
  }
  const quote = await createFundingQuote(pool, {
    userId: fixture.userId,
    discoveryProjectionId: opaque("atomic_link_projection"),
    selectedSourceOptionSnapshot: fixture.plan.operation.sourceSnapshot ?? {},
    marketContextSnapshot: null,
    destinationOptionSnapshot: fixture.plan.operation.destinationTargetSnapshot,
    venueBindingSnapshot: fixture.plan.operation.venueBindingSnapshot,
    planSnapshot: linkPlan,
    policyVersion: policy.runtime.contractVersion,
    policyRevision: policy.revision,
    canonicalRequest: { atomicLinkRollback: true },
    consentToken,
    expiresAt: new Date(Date.now() + 60_000),
  });
  const receiptId = fixture.receiptIds[1];
  const linkTarget = (
    await listFundingReceiveReceiptsForRouting(pool, {
      limit: 500,
      now: new Date(),
    })
  ).find((target) => target.receipt.receiptId === receiptId);
  assert.ok(linkTarget);
  const authorizationId =
    fixture.plan.operation.supportMetadata?.fundingAuthorizationId;
  const authorizationFingerprint =
    fixture.plan.operation.supportMetadata?.fundingAuthorizationFingerprint;
  assert.ok(receiptId);
  if (
    typeof authorizationId !== "string" ||
    typeof authorizationFingerprint !== "string"
  ) {
    assert.fail("fixture lacks its exact funding authorization binding");
  }
  try {
    await assert.rejects(
      tx(pool, async (client) => {
        await client.query(
          `update funding_operations
              set status = 'completed',
                  progress_stage = 'terminal',
                  completed_at = now(),
                  version = version + 1,
                  updated_at = now()
            where id = $1`,
          [fixture.operationId],
        );
        await client.query(
          `update balance_reservations
              set state = 'released',
                  released_at = now(),
                  outcome_reason = 'atomic_link_rollback_fixture'
            where operation_id = $1 and state = 'active'`,
          [fixture.operationId],
        );
        await client.query(
          `update funding_receive_receipts
              set status = 'observed', child_funding_operation_id = null
            where id = $1`,
          [receiptId],
        );
        assert.equal(
          await claimFundingReceiveReceiptOperationLinkInTransaction(client, {
            receiptId,
            userId: fixture.userId,
          }),
          true,
        );
        const committed = await commitFundingOperationInTransaction(client, {
          userId: fixture.userId,
          quoteId: quote.id,
          consentToken,
          idempotencyKey,
          plan: linkPlan,
          subjectLookupHmac: crypto
            .createHash("sha256")
            .update(`${fixture.userId}:atomic-link`)
            .digest("hex"),
          subjectLookupKeyVersion: 1,
        });
        if (
          !(await validatePolymarketFundingOperationLink(client, {
            operationId: committed.operation.id,
            target: linkTarget,
            consentId: fixture.consentId,
            consentFingerprint: fixture.consentFingerprint,
            authorizationId,
            authorizationFingerprint,
          }))
        ) {
          throw new Error("automatic funding operation evidence is invalid");
        }
        await linkFundingReceiveReceiptOperationInTransaction(client, {
          receiptId,
          userId: fixture.userId,
          childFundingOperationId: committed.operation.id,
          authorizationId,
          authorizationFingerprint,
          telegramFundingConsentId: fixture.consentId,
          telegramFundingConsentFingerprint: fixture.consentFingerprint,
          serverExecutionProfileId: POLYMARKET_DEPOSIT_USDCE_WRAP_PROFILE_ID,
          now: new Date(),
        });
      }),
      /automatic funding operation evidence is invalid/u,
      "an exact-link validation failure must roll back the operation commit",
    );
    const operation = await pool.query<{ count: string }>(
      `select count(*)::text as count
         from funding_operations
        where user_id = $1 and idempotency_key = $2`,
      [fixture.userId, idempotencyKey],
    );
    assert.equal(operation.rows[0]?.count, "0");
    const receipt = await pool.query<{
      child_funding_operation_id: string | null;
      status: string;
    }>(
      `select status, child_funding_operation_id
         from funding_receive_receipts
        where id = $1`,
      [receiptId],
    );
    assert.deepEqual(receipt.rows[0], {
      status: "routing",
      child_funding_operation_id: fixture.operationId,
    });
  } finally {
    await pool.query(`delete from funding_quotes where id = $1`, [quote.id]);
  }
}

function executor(
  execute: (
    claim: DelegatedFundingExecutionClaim,
  ) => Promise<DelegatedFundingExecutionResult>,
  recover: (
    claim: DelegatedFundingExecutionClaim,
  ) => Promise<DelegatedFundingExecutionResult> = execute,
  codec: FundingTransactionReferenceCodec = referenceCodec,
  recoveryTimingMs = 60_000,
  lookupProviderReference: DelegatedFundingNetworkDriver["lookupProviderReference"] = async () => ({
    kind: "pending" as const,
  }),
  providerLookupDelayMs = recoveryTimingMs,
): DelegatedFundingExecutor {
  return executorForConfiguration(
    profileConfiguration,
    execute,
    recover,
    codec,
    recoveryTimingMs,
    lookupProviderReference,
    providerLookupDelayMs,
  );
}

function executorForConfiguration(
  configuration: PolymarketWrapExecutionConfiguration,
  execute: (
    claim: DelegatedFundingExecutionClaim,
  ) => Promise<DelegatedFundingExecutionResult>,
  recover: (
    claim: DelegatedFundingExecutionClaim,
  ) => Promise<DelegatedFundingExecutionResult> = execute,
  codec: FundingTransactionReferenceCodec = referenceCodec,
  recoveryTimingMs = 60_000,
  lookupProviderReference: DelegatedFundingNetworkDriver["lookupProviderReference"] = async () => ({
    kind: "pending" as const,
  }),
  providerLookupDelayMs = recoveryTimingMs,
): DelegatedFundingExecutor {
  const profile = createPolymarketWrapDelegatedFundingProfile({
    configuration,
    driver: {
      execute,
      recover,
      lookupProviderReference,
    },
  });
  assert.ok(profile);
  return new DelegatedFundingExecutor(pool, {
    profiles: [profile],
    referenceCodec: codec,
    providerLookupDelayMs,
    providerReplayMs: recoveryTimingMs,
    unbroadcastRetryMs: recoveryTimingMs,
  });
}

function executorWithBoundaryMutation(
  execute: (
    claim: DelegatedFundingExecutionClaim,
  ) => Promise<DelegatedFundingExecutionResult>,
  mutate: (client: PoolClient) => Promise<void>,
): DelegatedFundingExecutor {
  const profile = createPolymarketWrapDelegatedFundingProfile({
    configuration: profileConfiguration,
    driver: {
      execute,
      recover: execute,
      lookupProviderReference: async () => ({ kind: "pending" as const }),
    },
  });
  assert.ok(profile);
  const decide = profile.preBroadcastDecisionInTransaction;
  let mutated = false;
  return new DelegatedFundingExecutor(pool, {
    profiles: [
      {
        ...profile,
        preBroadcastDecisionInTransaction: async (client, input) => {
          if (!mutated) {
            mutated = true;
            await mutate(client);
          }
          return decide(client, input);
        },
      },
    ],
    referenceCodec,
    providerLookupDelayMs: 60_000,
    providerReplayMs: 60_000,
    unbroadcastRetryMs: 60_000,
  });
}

let testFailure: unknown;
try {
  process.env.HUNCH_FINANCE_EXECUTE = "true";
  process.env.HUNCH_FUNDING_PM_WRAP_EXECUTE = "true";
  process.env.PRIVY_APP_ID = "test-app";
  process.env.PRIVY_APP_SECRET = "test-secret";
  process.env.PRIVY_WALLET_AUTHORIZATION_KEY = authorizationPrivateKey;
  process.env.CREDENTIALS_ENCRYPTION_KEY = "00".repeat(32);
  process.env.FUNDING_REFERENCE_LOOKUP_HMAC_KEY = "test-hmac-key";
  process.env.POLYMARKET_FUNDING_ROUTER_ADDRESS = router;
  process.env.PRIVY_WALLET_AUTHORIZATION_ID = profileConfiguration.signerId;
  process.env.PRIVY_WALLET_AUTHORIZATION_FINGERPRINT =
    profileConfiguration.signerFingerprint;
  process.env.PRIVY_POLYMARKET_BOT_BUY_SELL_POLICY_ID =
    profileConfiguration.policyId;
  process.env.PRIVY_POLYMARKET_BOT_BUY_SELL_POLICY_FINGERPRINT =
    profileConfiguration.policyFingerprint;
  await publishFundingPolicy(false);

  const tradeOriginWrap = await createFixture("750000");
  const tradeAuthorization = await pool.query<{ id: string }>(
    `select id
       from telegram_bot_trading_authorizations
      where user_id = $1::uuid
        and telegram_user_id = (
          select telegram_user_id
            from user_telegram_accounts
           where id = $2::uuid
        )
        and enabled = true
      limit 1`,
    [tradeOriginWrap.userId, tradeOriginWrap.telegramAccountId],
  );
  assert.ok(tradeAuthorization.rows[0]?.id);
  const tradeOriginEventId = crypto.randomUUID();
  const tradeOriginMarketId = crypto.randomUUID();
  tradeOriginEventIds.push(tradeOriginEventId);
  tradeOriginMarketIds.push(tradeOriginMarketId);
  await pool.query(
    `insert into unified_events (
       id, venue, venue_event_id, title, status, end_date
     ) values (
       $1::uuid, 'polymarket', $2, 'Trade origin funding event', 'ACTIVE',
       clock_timestamp() + interval '1 day'
     )`,
    [tradeOriginEventId, `trade-origin-event-${suffix}`],
  );
  await pool.query(
    `insert into unified_markets (
       id, venue, venue_market_id, event_id, title, status, market_type,
       close_time, expiration_time, outcomes, clob_token_ids, metadata
     ) values (
       $1::uuid, 'polymarket', $2, $3::uuid, 'Trade origin funding market',
       'ACTIVE', 'binary', clock_timestamp() + interval '1 day',
       clock_timestamp() + interval '1 day', '["Yes","No"]',
       '["trade-origin-yes","trade-origin-no"]', '{}'::jsonb
     )`,
    [tradeOriginMarketId, `trade-origin-market-${suffix}`, tradeOriginEventId],
  );
  const tradeOriginIntentId = crypto.randomUUID();
  tradeOriginIntentIds.push(tradeOriginIntentId);
  await pool.query(
    `insert into telegram_trade_intents (
       id, telegram_user_id, user_id, authorization_id, chat_id,
       telegram_message_id, action, venue, market_id, side, amount_usd,
       status, expires_at, idempotency_key, funding_operation_id
     )
     select $1::uuid, telegram_account.telegram_user_id, $2::uuid, $3::uuid,
            telegram_account.telegram_user_id, '750', 'buy', 'polymarket',
            $4, 'YES', 0.75, 'funding', clock_timestamp() + interval '30 minutes',
            $5, $6::uuid
       from user_telegram_accounts telegram_account
      where telegram_account.id = $7::uuid`,
    [
      tradeOriginIntentId,
      tradeOriginWrap.userId,
      tradeAuthorization.rows[0]?.id,
      tradeOriginMarketId,
      `trade-origin-wrap-${suffix}`,
      tradeOriginWrap.operationId,
      tradeOriginWrap.telegramAccountId,
    ],
  );
  await tx(pool, async (client) => {
    // The generic fixture is committed as a receive-origin operation. Convert
    // only this test row into the exact shape that the production shortfall
    // commit creates; bypassing the immutable-plan trigger here is fixture
    // construction, not an application transition.
    await client.query("set local session_replication_role = replica");
    await client.query(
      `update funding_operations
          set purpose = 'trade_shortfall',
              support_metadata =
                (support_metadata - 'fundingReceiveReceiptId'
                                  - 'telegramFundingConsentId'
                                  - 'telegramFundingConsentFingerprint') ||
                jsonb_build_object(
                  'telegramTradeIntentId', $2::text,
                  'delegatedOriginKind', 'trade_shortfall_intent'
                )
        where id = $1::uuid`,
      [tradeOriginWrap.operationId, tradeOriginIntentId],
    );
  });
  let tradeOriginWrapSends = 0;
  const tradeOriginWrapResult = await executor(async (claim) => {
    tradeOriginWrapSends += 1;
    assert.equal(claim.operationId, tradeOriginWrap.operationId);
    assert.equal(claim.receiptRaw, "750000");
    return {
      kind: "submitted",
      transactionReference: `0x${"75".repeat(32)}`,
    };
  }).runBatch({ limit: 1, now });
  const tradeOriginAttempt = await pool.query<{ actual_costs: JsonRecord }>(
    `select attempt.actual_costs
       from funding_operation_step_attempts attempt
       join funding_operation_steps step on step.id = attempt.step_id
      where step.operation_id = $1::uuid
      order by attempt.started_at desc
      limit 1`,
    [tradeOriginWrap.operationId],
  );
  assert.equal(
    tradeOriginWrapResult.submitted,
    1,
    JSON.stringify({
      batch: tradeOriginWrapResult,
      attempt: tradeOriginAttempt.rows[0]?.actual_costs,
    }),
  );
  assert.equal(tradeOriginWrapSends, 1);
  const tradeOriginRelayReservation = await pool.query<{ count: string }>(
    `select count(*)::text as count
       from telegram_funding_authorization_reservations
      where source_trade_intent_id = $1::uuid`,
    [tradeOriginIntentId],
  );
  assert.equal(
    tradeOriginRelayReservation.rows[0]?.count,
    "0",
    "Slice C trade shortfall must not create a Relay cap/lane reservation",
  );
  const isolatedTradeProjection =
    await runTelegramFundingProgressProjectionBatch(pool, {
      limit: 1,
      now: new Date(now.getTime() + 1),
    });
  assert.equal(isolatedTradeProjection.created, 1);
  await pool.query(
    `delete from telegram_bot_action_outbox where funding_session_id = $1::uuid`,
    [tradeOriginWrap.telegramFundingSessionId],
  );
  await pool.query(
    `update telegram_funding_sessions
        set projection_checked_at = $2
      where id = $1::uuid`,
    [
      tradeOriginWrap.telegramFundingSessionId,
      new Date(now.getTime() + 86_400_000),
    ],
  );

  const hugeRaw = (2n ** 255n).toString();
  const concurrent = await createFixture(hugeRaw, true);
  const limitlessIdentity = await pool.query<{ telegram_user_id: string }>(
    `select telegram_user_id
       from user_telegram_accounts
      where id = $1::uuid`,
    [concurrent.telegramAccountId],
  );
  const limitlessTelegramUserId = limitlessIdentity.rows[0]?.telegram_user_id;
  assert.ok(limitlessTelegramUserId);
  const limitlessDestinationOptionId = opaque("limitless_destination");
  const limitlessBindingOptionId = opaque("limitless_binding");
  const limitlessFundingAuthorization = await grantTelegramFundingAuthorization(
    pool,
    {
      userId: concurrent.userId,
      telegramAccountId: concurrent.telegramAccountId,
      telegramUserId: limitlessTelegramUserId,
      userWalletId: concurrent.userWalletId,
      privyWalletId: concurrent.privyWalletId,
      walletAddress: concurrent.signerAddress,
      destinationOptionId: limitlessDestinationOptionId,
      venueBindingOptionId: limitlessBindingOptionId,
      configuration: profileConfiguration,
      profileId: TELEGRAM_RELAY_POLYGON_PUSD_PROFILE_ID,
      securityClass: "routed_value_movement",
      sourceAsset: pUsd,
      destinationAsset: {
        networkId: "evm:8453",
        assetId: BASE_USDC,
        decimals: 6,
      },
      venueId: "limitless",
      maxSourceRaw: "20000000",
      now: new Date(now.getTime() + 1),
    },
  );
  extraAuthorizationIds.push(limitlessFundingAuthorization.id);
  assert.ok(
    await loadActiveTelegramFundingAuthorization(pool, {
      userId: concurrent.userId,
      telegramAccountId: concurrent.telegramAccountId,
      telegramUserId: limitlessTelegramUserId,
      destinationOptionId: limitlessDestinationOptionId,
      venueBindingOptionId: limitlessBindingOptionId,
      profileId: TELEGRAM_RELAY_POLYGON_PUSD_PROFILE_ID,
      securityClass: "routed_value_movement",
      sourceAsset: pUsd,
      destinationAsset: {
        networkId: "evm:8453",
        assetId: BASE_USDC,
        decimals: 6,
      },
      venueId: "limitless",
    }),
    "Limitless Relay funding must not require Limitless in the bot-order signer venue allowlist",
  );
  const concurrentReceiptId = concurrent.receiptIds[1];
  assert.ok(concurrentReceiptId);
  const unusedReceiptId = crypto.randomUUID();
  assert.equal(
    await fundingReceiveReceiptOperationIdempotencyKey(pool, {
      receiptId: unusedReceiptId,
      userId: concurrent.userId,
    }),
    `receive-receipt:${unusedReceiptId}`,
    "an unseen receipt starts at the legacy generation-zero key",
  );
  assert.equal(
    await fundingReceiveReceiptOperationIdempotencyKey(pool, {
      receiptId: concurrentReceiptId,
      userId: concurrent.userId,
    }),
    `receive-receipt:${concurrentReceiptId}:retry:1`,
    "a persisted child advances the exact receipt to retry generation one",
  );
  await assertSecondSourceReservationBlocked(concurrent);
  await assertOperationAttachmentFailureRollsBack(concurrent);
  const persistedAction = await pool.query<{
    action_fingerprint: string;
    consent_fingerprint: string;
    consent_id: string;
    normalized_action: JsonRecord;
    receipt_raw: string;
  }>(
    `select step.action_fingerprint,
            step.normalized_action,
            receipt.raw_amount::text as receipt_raw,
            operation.support_metadata ->> 'telegramFundingConsentId'
              as consent_id,
            operation.support_metadata ->> 'telegramFundingConsentFingerprint'
              as consent_fingerprint
     from funding_operation_steps step
     join funding_operations operation on operation.id = step.operation_id
     join funding_receive_receipts receipt
       on receipt.id::text = operation.support_metadata ->> 'fundingReceiveReceiptId'
     join telegram_funding_authorizations funding_authorization
       on funding_authorization.id::text =
            operation.support_metadata ->> 'fundingAuthorizationId'
     where operation.id = $1`,
    [concurrent.operationId],
  );
  const persistedActionRow = persistedAction.rows[0];
  assert.ok(persistedActionRow);
  assert.equal(persistedActionRow.consent_id, concurrent.consentId);
  assert.equal(
    persistedActionRow.consent_fingerprint,
    concurrent.consentFingerprint,
  );
  const parsedPersistedAction = normalizedActionSchema.safeParse(
    persistedActionRow.normalized_action,
  );
  assert.equal(
    parsedPersistedAction.success,
    true,
    parsedPersistedAction.error?.message,
  );
  const validatedPersistedAction =
    parsedPersistedAction.data as NormalizedAction;
  assert.equal(
    canonicalJsonHash(validatedPersistedAction),
    persistedActionRow.action_fingerprint,
  );
  assert.doesNotThrow(() =>
    validatePolymarketDepositUsdceWrapAction({
      action: validatedPersistedAction,
      expectedRaw: persistedActionRow.receipt_raw,
      routerAddress: router,
      walletId: concurrent.actionWalletId,
    }),
  );
  const serializedReceiptId = concurrent.receiptIds[0];
  assert.ok(serializedReceiptId);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    assert.equal(
      await deferFundingReceiveReceiptRouting(pool, {
        receiptId: serializedReceiptId,
        userId: concurrent.userId,
        errorCode: "routing_predecessor_unresolved",
        retryAt: new Date(now.getTime() + 60_000 + attempt),
        now: new Date(now.getTime() + attempt),
      }),
      true,
    );
  }
  const serializedReceipt = await pool.query<{
    routing_attempt_count: number;
    routing_last_error_code: string | null;
  }>(
    `select routing_attempt_count, routing_last_error_code
     from funding_receive_receipts where id = $1`,
    [serializedReceiptId],
  );
  assert.equal(serializedReceipt.rows[0]?.routing_attempt_count, 0);
  assert.equal(
    serializedReceipt.rows[0]?.routing_last_error_code,
    "routing_predecessor_unresolved",
  );
  let submittedCalls = 0;
  const concurrentResults = await Promise.all(
    Array.from({ length: 20 }, () =>
      executor(async (claim) => {
        assert.equal(
          claim.broadcastBoundaryCrossed,
          true,
          "the driver must only receive a claim marked after the durable broadcast boundary",
        );
        assert.equal(claim.actionWalletId, concurrent.actionWalletId);
        assert.equal(claim.privyWalletId, concurrent.privyWalletId);
        assert.notEqual(claim.actionWalletId, claim.privyWalletId);
        submittedCalls += 1;
        return {
          kind: "submitted" as const,
          transactionReference: `0x${"1".repeat(64)}`,
        };
      }).runBatch({ limit: 1, now }),
    ),
  );
  assert.equal(
    concurrentResults.reduce((sum, result) => sum + result.claimed, 0),
    1,
  );
  assert.equal(submittedCalls, 1);
  const submittedAttempts = await pool.query<{
    broadcast_may_have_occurred: boolean;
    count: string;
    outcome: string;
    reference_kind: string | null;
  }>(
    `select count(*)::text as count,
            min(outcome) as outcome,
            min(reference_kind) as reference_kind,
            bool_and(broadcast_may_have_occurred) as broadcast_may_have_occurred
     from funding_operation_step_attempts attempt
     join funding_operation_steps step on step.id = attempt.step_id
     where step.operation_id = $1`,
    [concurrent.operationId],
  );
  assert.equal(submittedAttempts.rows[0]?.count, "1");
  assert.equal(submittedAttempts.rows[0]?.outcome, "ambiguous");
  assert.equal(submittedAttempts.rows[0]?.reference_kind, "transaction");
  assert.equal(submittedAttempts.rows[0]?.broadcast_may_have_occurred, true);

  assert.deepEqual(
    await listFundingReceiveRoutingReceiptIdsAfterBroadcastBoundary(pool, {
      userId: concurrent.userId,
      receiveSessionId: concurrent.receiveSessionId,
    }),
    [concurrent.receiptIds[1]],
    "progress must read the executor's durable broadcast boundary",
  );
  await pool.query(
    `update telegram_funding_sessions context
     set progress_revision = 1,
         progress_fingerprint = $2,
         latest_progress_projection =
           '{"state":"waiting_for_routing","terminal":false}'::jsonb,
         projected_receive_version = receive.version,
         projected_consent_revision =
           coalesce(context.active_consent_revision, 0),
         projection_checked_at = $3
     from funding_receive_sessions receive
     where context.id = $1
       and receive.id = context.receive_session_id`,
    [
      concurrent.telegramFundingSessionId,
      canonicalJsonHash({ state: "waiting_for_routing" }),
      new Date(now.getTime() + 1_000),
    ],
  );
  const boundaryProjectionBatch =
    await runTelegramFundingProgressProjectionBatch(pool, {
      limit: 25,
      now: new Date(now.getTime() + 2_000),
    });
  assert.equal(
    boundaryProjectionBatch.created,
    1,
    "the attempt-only durable boundary must wake progress projection once",
  );
  assert.equal(
    boundaryProjectionBatch.created + boundaryProjectionBatch.skipped,
    boundaryProjectionBatch.candidates,
  );
  const boundaryProjection = await pool.query<{
    progress_revision: number;
    state: string | null;
  }>(
    `select progress_revision,
            latest_progress_projection->>'state' as state
     from telegram_funding_sessions
     where id = $1`,
    [concurrent.telegramFundingSessionId],
  );
  assert.deepEqual(boundaryProjection.rows[0], {
    progress_revision: 2,
    state: "converting",
  });
  const noHotLoopBatch = await runTelegramFundingProgressProjectionBatch(pool, {
    limit: 25,
    now: new Date(now.getTime() + 3_000),
  });
  assert.equal(
    noHotLoopBatch.created,
    0,
    "a converting projection must not remain a hot-loop candidate",
  );

  const expiredOperationLifetime = await createFixture("1010000");
  const expireOperationLifetime = await pool.connect();
  try {
    await expireOperationLifetime.query("begin");
    await expireOperationLifetime.query(
      "set local session_replication_role = replica",
    );
    await expireOperationLifetime.query(
      `update funding_operations
       set expires_at = created_at + interval '1 millisecond'
       where id = $1`,
      [expiredOperationLifetime.operationId],
    );
    await expireOperationLifetime.query("commit");
  } catch (error) {
    await expireOperationLifetime.query("rollback");
    throw error;
  } finally {
    expireOperationLifetime.release();
  }
  let expiredOperationCalls = 0;
  const expiredOperation = await executor(async () => {
    expiredOperationCalls += 1;
    return {
      kind: "proven_nonbroadcast_failure",
      reasonCode: "test_provider_failure",
    };
  }).runBatch({ limit: 1, now: new Date(now.getTime() + 5_000) });
  assert.equal(expiredOperation.claimed, 1);
  assert.equal(expiredOperation.definitivelyFailed, 1);
  assert.equal(expiredOperationCalls, 1);

  const expiredBeforeClaim = await createFixture("1015000");
  await pool.query(
    `update funding_operation_steps
        set action_expires_at = created_at + interval '1 millisecond'
      where operation_id = $1`,
    [expiredBeforeClaim.operationId],
  );
  let expiredClaimCalls = 0;
  const expiredClaim = await executor(async () => {
    expiredClaimCalls += 1;
    return { kind: "ambiguous" };
  }).runBatch({ limit: 1, now: new Date(now.getTime() + 5_500) });
  assert.equal(expiredClaim.claimed, 0);
  assert.equal(expiredClaimCalls, 0);
  assert.equal(
    (
      await pool.query<{ count: string }>(
        `select count(*)::text as count
         from funding_operation_step_attempts attempt
         join funding_operation_steps step on step.id = attempt.step_id
         where step.operation_id = $1`,
        [expiredBeforeClaim.operationId],
      )
    ).rows[0]?.count,
    "0",
    "an expired provider action must not acquire an execution attempt",
  );

  const expiredAtBoundary = await createFixture("1020000");
  let expiredBoundaryCalls = 0;
  const expiredBoundary = await executorWithBoundaryMutation(
    async () => {
      expiredBoundaryCalls += 1;
      return { kind: "ambiguous" };
    },
    async (client) => {
      await client.query("set local session_replication_role = replica");
      await client.query(
        `update funding_operation_steps
         set action_expires_at = created_at + interval '1 millisecond'
         where operation_id = $1`,
        [expiredAtBoundary.operationId],
      );
    },
  ).runBatch({ limit: 1, now: new Date(now.getTime() + 6_000) });
  assert.equal(expiredBoundary.definitivelyFailed, 1);
  assert.equal(expiredBoundaryCalls, 0);
  assert.deepEqual(
    (
      await pool.query<{
        broadcast_may_have_occurred: boolean;
        outcome: string;
        reason_code: string | null;
      }>(
        `select attempt.outcome,
                attempt.broadcast_may_have_occurred,
                attempt.actual_costs ->> 'reasonCode' as reason_code
         from funding_operation_step_attempts attempt
         join funding_operation_steps step on step.id = attempt.step_id
         where step.operation_id = $1`,
        [expiredAtBoundary.operationId],
      )
    ).rows,
    [
      {
        broadcast_may_have_occurred: false,
        outcome: "failed",
        reason_code: "delegated_quote_expired",
      },
    ],
    "deadline expiry after claim must fail before the provider boundary",
  );

  const destinationReady = await createFixture("4250000");
  assert.equal(
    await hasReadyTelegramFundingDestinationReceipt(
      pool,
      destinationReady.telegramFundingSessionId,
    ),
    false,
    "a committed conversion must not unlock Review Buy before completion",
  );
  await pool.query(
    `update funding_operation_steps
     set state = 'submitted', updated_at = $2
     where operation_id = $1`,
    [destinationReady.operationId, now],
  );
  await pool.query(
    `update funding_operation_steps
     set state = 'succeeded', updated_at = $2
     where operation_id = $1`,
    [destinationReady.operationId, now],
  );
  await pool.query(
    `update funding_operations
     set status = 'completed', progress_stage = 'terminal',
         completed_at = $2, version = version + 1, updated_at = $2
     where id = $1`,
    [destinationReady.operationId, now],
  );
  await pool.query(
    `update funding_receive_receipts
     set status = 'ready', routing_disposition = 'ready', updated_at = $2
     where child_funding_operation_id = $1`,
    [destinationReady.operationId, now],
  );
  assert.equal(
    await hasReadyTelegramFundingDestinationReceipt(
      pool,
      destinationReady.telegramFundingSessionId,
    ),
    true,
    "the completed exact child conversion must unlock Review Buy",
  );
  const destinationTamper = await pool.connect();
  try {
    await destinationTamper.query("begin");
    await destinationTamper.query(
      `update funding_operations
       set support_metadata = jsonb_set(
             support_metadata,
             '{fundingReceiveReceiptId}',
             to_jsonb($2::text)
           ),
           version = version + 1
       where id = $1`,
      [destinationReady.operationId, crypto.randomUUID()],
    );
    assert.equal(
      await hasReadyTelegramFundingDestinationReceipt(
        destinationTamper,
        destinationReady.telegramFundingSessionId,
      ),
      false,
      "a completed child bound to a different receipt is not readiness evidence",
    );
  } finally {
    await destinationTamper.query("rollback");
    destinationTamper.release();
  }

  const fastLookup = await createFixture("999999999");
  let fastLookupExecuteCalls = 0;
  let fastLookupRecoverCalls = 0;
  let fastLookupCalls = 0;
  const fastLookupTransactionHash = `0x${"2".repeat(64)}`;
  let releaseConcurrentLookups: (() => void) | undefined;
  const concurrentLookups = new Promise<void>((resolve) => {
    releaseConcurrentLookups = resolve;
  });
  const createFastLookupExecutor = () =>
    executor(
      async () => {
        fastLookupExecuteCalls += 1;
        return { kind: "ambiguous" };
      },
      async () => {
        fastLookupRecoverCalls += 1;
        return { kind: "pending" };
      },
      referenceCodec,
      DELEGATED_PROVIDER_REPLAY_MS,
      async (claim) => {
        fastLookupCalls += 1;
        assert.equal(claim.operationId, fastLookup.operationId);
        if (fastLookupCalls === 2) releaseConcurrentLookups?.();
        await concurrentLookups;
        return {
          kind: "submitted",
          transactionReference: fastLookupTransactionHash,
        };
      },
      DELEGATED_PROVIDER_LOOKUP_DELAY_MS,
    );
  const fastLookupExecutor = createFastLookupExecutor();
  assert.equal(
    (await fastLookupExecutor.runBatch({ limit: 10, now })).ambiguous,
    1,
  );
  const fastLookupResolved = await Promise.all(
    [createFastLookupExecutor(), createFastLookupExecutor()].map((worker) =>
      worker.runBatch({
        limit: 10,
        now: new Date(now.getTime() + 2_000),
      }),
    ),
  );
  assert.equal(
    fastLookupResolved.reduce((sum, result) => sum + result.providerLookups, 0),
    2,
    "each worker may perform the same harmless read-only lookup once",
  );
  assert.equal(
    fastLookupResolved.reduce(
      (sum, result) => sum + result.providerReferencesResolved,
      0,
    ),
    2,
    "both workers may observe the same idempotently resolved provider reference",
  );
  assert.equal(fastLookupCalls, 2);
  assert.equal(fastLookupExecuteCalls, 1);
  assert.equal(
    fastLookupRecoverCalls,
    0,
    "fast reference resolution never enters the replay path",
  );
  const fastLookupAttempt = await pool.query<{
    count: string;
    reference_kind: string | null;
  }>(
    `select count(*)::text as count,
            min(attempt.reference_kind) as reference_kind
       from funding_operation_step_attempts attempt
       join funding_operation_steps step on step.id = attempt.step_id
      where step.operation_id = $1`,
    [fastLookup.operationId],
  );
  assert.deepEqual(fastLookupAttempt.rows[0], {
    count: "1",
    reference_kind: "transaction",
  });

  const crashRecovery = await createFixture("1000000000");
  let ambiguousCalls = 0;
  let recoveryCalls = 0;
  const ambiguousExecutor = executor(
    async () => {
      ambiguousCalls += 1;
      return { kind: "ambiguous" };
    },
    async () => {
      recoveryCalls += 1;
      return {
        kind: "submitted",
        transactionReference: `0x${"3".repeat(64)}`,
      };
    },
    referenceCodec,
    5 * 60_000,
  );
  assert.equal(
    (await ambiguousExecutor.runBatch({ limit: 1, now })).ambiguous,
    1,
  );
  assert.equal(
    (await ambiguousExecutor.runBatch({ limit: 1, now })).claimed,
    0,
  );
  assert.equal(
    ambiguousCalls,
    1,
    "an ambiguous attempt must never rebroadcast",
  );
  await new FundingReceiveReceiptRouter(
    pool,
    undefined,
    resolveTelegramFundingReceiptDisposition,
  ).runBatch({
    limit: 100,
    now: new Date(now.getTime() + 1),
  });
  const ambiguousReceipt = await pool.query<{ status: string }>(
    `select status
       from funding_receive_receipts
      where id = $1`,
    [crashRecovery.receiptIds[1]],
  );
  assert.equal(
    ambiguousReceipt.rows[0]?.status,
    "routing",
    "router must retain the exact receipt while its child awaits reconciliation",
  );
  const pendingAttempts = await pool.query<{
    attempt_id: string;
    operation_id: string;
    outcome: string;
    reference_kind: string | null;
    step_id: string;
    updated_at: Date;
  }>(
    `select attempt.id as attempt_id, step.id as step_id,
            step.operation_id, attempt.outcome, attempt.reference_kind,
            attempt.updated_at
     from funding_operation_step_attempts attempt
     join funding_operation_steps step on step.id = attempt.step_id
     where step.operation_id = $1`,
    [crashRecovery.operationId],
  );
  assert.deepEqual(
    pendingAttempts.rows.map((row) => ({
      operationId: row.operation_id,
      outcome: row.outcome,
      referenceKind: row.reference_kind,
    })),
    [
      {
        operationId: crashRecovery.operationId,
        outcome: "ambiguous",
        referenceKind: "provider_receipt",
      },
    ],
  );
  const crashRecoveryAttempt = pendingAttempts.rows[0];
  assert.ok(crashRecoveryAttempt);
  const providerRecoveryDeadline = new Date(now.getTime() + 2 * 60_000);
  await reduceFundingOperation(pool, {
    operationId: crashRecovery.operationId,
    now: new Date(now.getTime() + 1),
  });
  await pool.query(
    `update funding_operations
        set support_metadata = support_metadata || jsonb_build_object(
              'reconciliationActiveSince', $2::text,
              'reconciliationActiveAttemptBaseline', 0
            ),
            version = version + 1
      where id = $1`,
    [crashRecovery.operationId, now.toISOString()],
  );
  await pool.query(
    `update funding_reconciliation_jobs
        set due_at = to_timestamp(0),
            status = 'scheduled',
            lease_owner = null,
            lease_token = null,
            lease_until = null
      where operation_id = $1`,
    [crashRecovery.operationId],
  );
  assert.equal(
    (
      await ambiguousExecutor.runBatch({
        limit: 1,
        now: providerRecoveryDeadline,
      })
    ).claimed,
    0,
    "provider recovery must not claim before the production five-minute lease",
  );
  assert.equal(recoveryCalls, 0);
  const genericReconciliation = await runFundingReconciliationBatch(pool, {
    workerId: opaque("provider_reference_timeout_worker"),
    limit: 1,
    terminalTimeoutMs: 90_000,
    now: providerRecoveryDeadline,
  });
  assert.deepEqual(genericReconciliation.operationIds, [
    crashRecovery.operationId,
  ]);
  const providerReferenceJob = await pool.query<{ due_at: Date }>(
    `select due_at
       from funding_reconciliation_jobs
      where operation_id = $1`,
    [crashRecovery.operationId],
  );
  assert.equal(
    providerReferenceJob.rows[0]?.due_at.toISOString(),
    new Date(
      crashRecoveryAttempt.updated_at.getTime() + DELEGATED_PROVIDER_REPLAY_MS,
    ).toISOString(),
    "generic reconciliation must sleep until the provider recovery lease instead of hot-looping",
  );
  const providerRecoveryState = await pool.query<{
    active_since: string | null;
    error_code: string | null;
    recovery_mode: string | null;
    status: string;
  }>(
    `select status,
            error_code,
            recovery_mode,
            support_metadata ->> 'reconciliationActiveSince' as active_since
       from funding_operations
      where id = $1`,
    [crashRecovery.operationId],
  );
  assert.deepEqual(providerRecoveryState.rows[0], {
    status: "reconcile_required",
    error_code: null,
    recovery_mode: null,
    active_since: null,
  });
  await pool.query(
    `update funding_operations
        set support_metadata = support_metadata || jsonb_build_object(
              'reconciliationActiveSince', $2::text,
              'reconciliationActiveAttemptBaseline', 0
            ),
            version = version + 1
      where id = $1`,
    [crashRecovery.operationId, now.toISOString()],
  );
  assert.equal(
    await revokeTelegramFundingAuthorization(pool, {
      authorizationId: crashRecovery.authorizationId,
      userId: crashRecovery.userId,
      now: new Date(now.getTime() + 2_000),
    }),
    true,
  );
  const recoveryOnlyExecutor = executorForConfiguration(
    { ...profileConfiguration, enabled: false, signerId: "" },
    async () => {
      throw new Error("disabled configuration must not create a new claim");
    },
    async () => {
      recoveryCalls += 1;
      return {
        kind: "submitted",
        transactionReference: `0x${"3".repeat(64)}`,
      };
    },
    referenceCodec,
    5 * 60_000,
  );
  const recovered = await recoveryOnlyExecutor.runBatch({
    limit: 1,
    now: new Date(now.getTime() + 10 * 60_000),
  });
  assert.equal(recovered.recovered, 1);
  assert.equal(recovered.submitted, 1);
  assert.equal(recoveryCalls, 1);
  assert.equal(ambiguousCalls, 1, "recovery must not call execute again");
  assert.deepEqual(recovered.operationIds, [crashRecovery.operationId]);
  const clearedAtProviderResolution = await pool.query<{
    active_since: string | null;
  }>(
    `select support_metadata ->> 'reconciliationActiveSince' as active_since
       from funding_operations
      where id = $1`,
    [crashRecovery.operationId],
  );
  assert.equal(clearedAtProviderResolution.rows[0]?.active_since, null);
  await pool.query(
    `update funding_reconciliation_jobs
        set due_at = to_timestamp(0),
            status = 'scheduled',
            lease_owner = null,
            lease_token = null,
            lease_until = null
      where operation_id = $1`,
    [crashRecovery.operationId],
  );
  const postRecoveryReconciliationNow = new Date(
    now.getTime() + 10 * 60_000 + 1,
  );
  const postRecoveryReconciliation = await runFundingReconciliationBatch(pool, {
    workerId: opaque("resolved_provider_reference_worker"),
    limit: 1,
    terminalTimeoutMs: 90_000,
    now: postRecoveryReconciliationNow,
  });
  assert.deepEqual(postRecoveryReconciliation.operationIds, [
    crashRecovery.operationId,
  ]);
  const freshReconciliationWindow = await pool.query<{
    active_since: string | null;
    error_code: string | null;
    recovery_mode: string | null;
    status: string;
  }>(
    `select status,
            error_code,
            recovery_mode,
            support_metadata ->> 'reconciliationActiveSince' as active_since
       from funding_operations
      where id = $1`,
    [crashRecovery.operationId],
  );
  assert.deepEqual(freshReconciliationWindow.rows[0], {
    status: "reconcile_required",
    error_code: null,
    recovery_mode: null,
    active_since: postRecoveryReconciliationNow.toISOString(),
  });
  const recoveredAttempts = await pool.query<{
    count: string;
    outcome: string;
    reference_kind: string | null;
  }>(
    `select count(*)::text as count,
            min(outcome) as outcome,
            min(reference_kind) as reference_kind
     from funding_operation_step_attempts attempt
     join funding_operation_steps step on step.id = attempt.step_id
     where step.operation_id = $1`,
    [crashRecovery.operationId],
  );
  assert.equal(recoveredAttempts.rows[0]?.count, "1");
  assert.equal(recoveredAttempts.rows[0]?.outcome, "ambiguous");
  assert.equal(recoveredAttempts.rows[0]?.reference_kind, "transaction");
  await finalizeRecoveredFixture(crashRecovery, {
    attemptId: crashRecoveryAttempt.attempt_id,
    stepId: crashRecoveryAttempt.step_id,
    now: new Date(now.getTime() + 10 * 60_000 + 2),
  });

  const evidenceRecovery = await createFixture("10000");
  let evidenceExecuteCalls = 0;
  let evidenceReplayCalls = 0;
  let evidenceLookupCalls = 0;
  const evidenceTransactionHash = `0x${"9".repeat(64)}`;
  const evidenceRecoveryExecutor = executor(
    async () => {
      evidenceExecuteCalls += 1;
      return { kind: "ambiguous" };
    },
    async () => {
      evidenceReplayCalls += 1;
      return { kind: "pending" };
    },
    referenceCodec,
    DELEGATED_PROVIDER_REPLAY_MS,
    async () => {
      evidenceLookupCalls += 1;
      return {
        kind: "submitted",
        transactionReference: evidenceTransactionHash,
      };
    },
    DELEGATED_PROVIDER_LOOKUP_DELAY_MS,
  );
  assert.equal(
    (await evidenceRecoveryExecutor.runBatch({ limit: 1, now })).ambiguous,
    1,
  );
  const evidenceAttemptBeforeLookup = await pool.query<{
    attempt_id: string;
    finished_at: Date;
    step_id: string;
  }>(
    `select attempt.id as attempt_id,
            attempt.finished_at,
            step.id as step_id
       from funding_operation_step_attempts attempt
       join funding_operation_steps step on step.id = attempt.step_id
      where step.operation_id = $1`,
    [evidenceRecovery.operationId],
  );
  const evidenceAttempt = evidenceAttemptBeforeLookup.rows[0];
  assert.ok(evidenceAttempt);
  await insertReadyPusdReceipt(
    evidenceRecovery,
    "10000",
    new Date(evidenceAttempt.finished_at.getTime() + 500),
  );
  const evidenceLookup = await evidenceRecoveryExecutor.runBatch({
    limit: 1,
    now: new Date(
      evidenceAttempt.finished_at.getTime() +
        DELEGATED_PROVIDER_LOOKUP_DELAY_MS +
        1,
    ),
  });
  assert.equal(evidenceLookup.providerReferencesResolved, 1);
  assert.equal(evidenceLookup.recovered, 0);
  assert.equal(evidenceExecuteCalls, 1);
  assert.equal(evidenceLookupCalls, 1);
  assert.equal(
    evidenceReplayCalls,
    0,
    "exact destination evidence must not shorten the five-minute replay lease",
  );
  await finalizeRecoveredFixture(evidenceRecovery, {
    attemptId: evidenceAttempt.attempt_id,
    stepId: evidenceAttempt.step_id,
    now: new Date(
      evidenceAttempt.finished_at.getTime() +
        DELEGATED_PROVIDER_LOOKUP_DELAY_MS +
        2,
    ),
  });

  const preBoundaryEvidence = await createFixture("11000");
  const preBoundaryExecutionAt = new Date(now.getTime() + 30_000);
  await insertReadyPusdReceipt(
    preBoundaryEvidence,
    "11000",
    new Date(preBoundaryExecutionAt.getTime() - 1_000),
  );
  let preBoundaryRecoveryCalls = 0;
  let preBoundaryLookupCalls = 0;
  const preBoundaryEvidenceExecutor = executor(
    async () => ({ kind: "ambiguous" }),
    async () => {
      preBoundaryRecoveryCalls += 1;
      return {
        kind: "submitted",
        transactionReference: `0x${"8".repeat(64)}`,
      };
    },
    referenceCodec,
    DELEGATED_PROVIDER_REPLAY_MS,
    async () => {
      preBoundaryLookupCalls += 1;
      return { kind: "pending" };
    },
    DELEGATED_PROVIDER_LOOKUP_DELAY_MS,
  );
  assert.equal(
    (
      await preBoundaryEvidenceExecutor.runBatch({
        limit: 1,
        now: preBoundaryExecutionAt,
      })
    ).ambiguous,
    1,
  );
  const preBoundaryAttempt = await pool.query<{
    attempt_id: string;
    finished_at: Date;
    step_id: string;
    updated_at: Date;
  }>(
    `select attempt.id as attempt_id,
            attempt.finished_at,
            attempt.updated_at,
            step.id as step_id
       from funding_operation_step_attempts attempt
       join funding_operation_steps step on step.id = attempt.step_id
      where step.operation_id = $1`,
    [preBoundaryEvidence.operationId],
  );
  const preBoundaryAttemptRow = preBoundaryAttempt.rows[0];
  assert.ok(preBoundaryAttemptRow);
  assert.equal(
    (
      await preBoundaryEvidenceExecutor.runBatch({
        limit: 1,
        now: new Date(
          preBoundaryAttemptRow.finished_at.getTime() +
            DELEGATED_PROVIDER_LOOKUP_DELAY_MS +
            1,
        ),
      })
    ).claimed,
    0,
    "destination funds observed before the provider boundary must not accelerate recovery",
  );
  assert.equal(preBoundaryLookupCalls, 1);
  assert.equal(preBoundaryRecoveryCalls, 0);
  const preBoundaryRecovered = await preBoundaryEvidenceExecutor.runBatch({
    limit: 1,
    now: new Date(
      preBoundaryAttemptRow.updated_at.getTime() +
        DELEGATED_PROVIDER_REPLAY_MS +
        1,
    ),
  });
  assert.equal(preBoundaryRecovered.recovered, 1);
  assert.equal(preBoundaryRecovered.submitted, 1);
  assert.equal(preBoundaryRecoveryCalls, 1);
  await finalizeRecoveredFixture(preBoundaryEvidence, {
    attemptId: preBoundaryAttemptRow.attempt_id,
    stepId: preBoundaryAttemptRow.step_id,
    now: new Date(
      preBoundaryAttemptRow.updated_at.getTime() +
        DELEGATED_PROVIDER_REPLAY_MS +
        2,
    ),
  });

  const strandedRecovery = await createFixture("1000000001");
  let strandedExecuteCalls = 0;
  let strandedRecoveryCalls = 0;
  const strandedExecutor = executor(
    async () => {
      strandedExecuteCalls += 1;
      return { kind: "ambiguous" };
    },
    async () => {
      strandedRecoveryCalls += 1;
      return {
        kind: "submitted",
        transactionReference: `0x${"4".repeat(64)}`,
      };
    },
  );
  assert.equal(
    (await strandedExecutor.runBatch({ limit: 1, now })).ambiguous,
    1,
  );
  await strandFixtureForAutomaticEvidence(strandedRecovery);
  const recoveredStranded = await strandedExecutor.runBatch({
    limit: 1,
    now: new Date(now.getTime() + 10 * 60_000),
  });
  assert.equal(recoveredStranded.recovered, 1);
  assert.equal(recoveredStranded.submitted, 1);
  assert.equal(strandedExecuteCalls, 1);
  assert.equal(strandedRecoveryCalls, 1);
  assert.deepEqual(recoveredStranded.operationIds, [
    strandedRecovery.operationId,
  ]);
  const strandedAttempt = await pool.query<{
    attempt_id: string;
    operation_status: string;
    reference_kind: string | null;
    step_id: string;
    step_state: string;
  }>(
    `select attempt.id as attempt_id,
            step.id as step_id,
            attempt.reference_kind,
            step.state as step_state,
            operation.status as operation_status
       from funding_operation_step_attempts attempt
       join funding_operation_steps step on step.id = attempt.step_id
       join funding_operations operation on operation.id = step.operation_id
      where operation.id = $1`,
    [strandedRecovery.operationId],
  );
  assert.equal(strandedAttempt.rows[0]?.reference_kind, "transaction");
  assert.equal(strandedAttempt.rows[0]?.step_state, "recovery_required");
  assert.equal(strandedAttempt.rows[0]?.operation_status, "recovery_required");
  assert.ok(strandedAttempt.rows[0]?.attempt_id);
  assert.ok(strandedAttempt.rows[0]?.step_id);
  await finalizeRecoveredFixture(strandedRecovery, {
    attemptId: strandedAttempt.rows[0].attempt_id,
    stepId: strandedAttempt.rows[0].step_id,
    now: new Date(now.getTime() + 10 * 60_000 + 1),
  });

  const strandedFailure = await createFixture("1000000002");
  let strandedFailureExecuteCalls = 0;
  let strandedFailureRecoveryCalls = 0;
  const strandedFailureExecutor = executor(
    async () => {
      strandedFailureExecuteCalls += 1;
      return { kind: "ambiguous" };
    },
    async () => {
      strandedFailureRecoveryCalls += 1;
      return {
        kind: "proven_nonbroadcast_failure",
        reasonCode: "provider_request_not_found",
      };
    },
  );
  assert.equal(
    (await strandedFailureExecutor.runBatch({ limit: 1, now })).ambiguous,
    1,
  );
  await strandFixtureForAutomaticEvidence(strandedFailure);
  const failedStranded = await strandedFailureExecutor.runBatch({
    limit: 1,
    now: new Date(now.getTime() + 10 * 60_000),
  });
  assert.equal(failedStranded.recovered, 1);
  assert.equal(failedStranded.definitivelyFailed, 1);
  assert.equal(strandedFailureExecuteCalls, 1);
  assert.equal(strandedFailureRecoveryCalls, 1);
  const failedStrandedState = await pool.query<{
    attempt_count: string;
    attempt_outcome: string;
    error_code: string | null;
    operation_status: string;
    recovery_mode: string | null;
    step_state: string;
  }>(
    `select operation.status as operation_status,
            operation.recovery_mode,
            operation.error_code,
            step.state as step_state,
            count(attempt.id)::text as attempt_count,
            min(attempt.outcome) as attempt_outcome
       from funding_operations operation
       join funding_operation_steps step on step.operation_id = operation.id
       join funding_operation_step_attempts attempt on attempt.step_id = step.id
      where operation.id = $1
      group by operation.status, operation.recovery_mode,
               operation.error_code, step.state`,
    [strandedFailure.operationId],
  );
  assert.deepEqual(failedStrandedState.rows[0], {
    operation_status: "recovery_required",
    recovery_mode: "manual_review",
    error_code: "delegated_provider_reference_failed",
    step_state: "failed",
    attempt_count: "1",
    attempt_outcome: "failed",
  });
  const failedRouting = await new FundingReceiveReceiptRouter(
    pool,
    undefined,
    resolveTelegramFundingReceiptDisposition,
  ).runBatch({ limit: 100, now: new Date(now.getTime() + 10 * 60_000 + 1) });
  assert.ok(failedRouting.recoveriesRequired >= 1);
  assert.equal(
    (
      await pool.query<{ status: string }>(
        `select status from funding_receive_receipts
          where child_funding_operation_id = $1`,
        [strandedFailure.operationId],
      )
    ).rows[0]?.status,
    "recovery_required",
  );

  const boundaryCrash = await createFixture("1100000000");
  let boundaryExecuteCalls = 0;
  let boundaryRecoveryCalls = 0;
  const brokenCodec: FundingTransactionReferenceCodec = {
    ...referenceCodec,
    encrypt: () => {
      throw new Error("injected crash before external call");
    },
  };
  await assert.rejects(
    executor(
      async () => {
        boundaryExecuteCalls += 1;
        return { kind: "ambiguous" };
      },
      async () => {
        throw new Error("broken codec must fail before recovery");
      },
      brokenCodec,
    ).runBatch({ limit: 1, now }),
    /injected crash before external call/u,
  );
  assert.equal(boundaryExecuteCalls, 0);
  const startedBoundary = await pool.query<{
    outcome: string;
    reference_kind: string | null;
  }>(
    `select attempt.outcome, attempt.reference_kind
     from funding_operation_step_attempts attempt
     join funding_operation_steps step on step.id = attempt.step_id
     where step.operation_id = $1`,
    [boundaryCrash.operationId],
  );
  assert.deepEqual(startedBoundary.rows, [
    { outcome: "started", reference_kind: null },
  ]);
  const recoveredBoundary = await executor(
    async () => {
      boundaryExecuteCalls += 1;
      return {
        kind: "submitted",
        transactionReference: `0x${"4".repeat(64)}`,
      };
    },
    async () => {
      boundaryRecoveryCalls += 1;
      throw new Error("a pre-boundary attempt must execute, not recover");
    },
  ).runBatch({ limit: 1, now: new Date(now.getTime() + 10 * 60_000) });
  assert.equal(recoveredBoundary.recovered, 1);
  assert.equal(recoveredBoundary.submitted, 1);
  assert.equal(boundaryExecuteCalls, 1);
  assert.equal(boundaryRecoveryCalls, 0);

  const corruptedAction = await createFixture("1200000");
  const corruptionClient = await pool.connect();
  try {
    await corruptionClient.query("begin");
    await corruptionClient.query(
      "set local session_replication_role = replica",
    );
    await corruptionClient.query(
      `update funding_operation_steps
       set normalized_action = jsonb_set(
         normalized_action,
         '{to}',
         to_jsonb('0x2222222222222222222222222222222222222222'::text)
       )
       where operation_id = $1`,
      [corruptedAction.operationId],
    );
    await corruptionClient.query("commit");
  } catch (error) {
    await corruptionClient.query("rollback");
    throw error;
  } finally {
    corruptionClient.release();
  }
  let corruptedActionCalls = 0;
  const corruptedResult = await executor(async () => {
    corruptedActionCalls += 1;
    return { kind: "ambiguous" };
  }).runBatch({ limit: 1, now: new Date(now.getTime() + 500) });
  assert.equal(corruptedResult.definitivelyFailed, 1);
  assert.equal(corruptedActionCalls, 0);
  const corruptedAttempt = await pool.query<{
    broadcast_may_have_occurred: boolean;
    count: string;
    outcome: string;
    reason_code: string | null;
  }>(
    `select count(*)::text as count,
            min(attempt.outcome) as outcome,
            bool_or(attempt.broadcast_may_have_occurred) as broadcast_may_have_occurred,
            min(attempt.actual_costs ->> 'reasonCode') as reason_code
     from funding_operation_step_attempts attempt
     join funding_operation_steps step on step.id = attempt.step_id
     where step.operation_id = $1`,
    [corruptedAction.operationId],
  );
  assert.deepEqual(corruptedAttempt.rows[0], {
    broadcast_may_have_occurred: false,
    count: "1",
    outcome: "failed",
    reason_code: "delegated_action_invalid",
  });
  assert.equal(
    (
      await executor(async () => {
        corruptedActionCalls += 1;
        return { kind: "ambiguous" };
      }).runBatch({ limit: 1, now: new Date(now.getTime() + 600) })
    ).claimed,
    0,
    "an invalid immutable action must be terminalized once, not poison the queue",
  );

  const policyBlocked = await createFixture("3000000");
  await publishFundingPolicy(true, false, { venues: [] });
  const policyBlockedTarget = (
    await listFundingReceiveReceiptsForRouting(pool, {
      limit: 100,
      now: new Date(now.getTime() + 700),
    })
  ).find((target) => target.receipt.receiptId === policyBlocked.receiptIds[1]);
  assert.ok(policyBlockedTarget);
  assert.deepEqual(
    await telegramUsdceWrapRoutingDecision(pool, policyBlockedTarget),
    { kind: "soft_paused", reasonCode: "funding_policy_paused" },
    "a paused replacement policy must not terminalize consent for the exact resumable revision",
  );
  let policyBlockedCalls = 0;
  const policyPaused = await executorForConfiguration(
    { ...profileConfiguration, enabled: false },
    async () => {
      policyBlockedCalls += 1;
      return { kind: "ambiguous" };
    },
  ).runBatch({ limit: 10, now });
  assert.equal(policyPaused.claimed, 1);
  assert.equal(policyPaused.softPaused, 1);
  assert.equal(
    policyPaused.operationIds.includes(policyBlocked.operationId),
    true,
  );
  assert.equal(policyBlockedCalls, 0);
  await reduceFundingOperation(pool, {
    operationId: policyBlocked.operationId,
    now,
  });
  const policyBlockedState = await pool.query<{
    attempts: string;
    status: string;
  }>(
    `select operation.status,
            count(attempt.id)::text as attempts
     from funding_operations operation
     join funding_operation_steps step on step.operation_id = operation.id
     left join funding_operation_step_attempts attempt on attempt.step_id = step.id
     where operation.id = $1
     group by operation.status`,
    [policyBlocked.operationId],
  );
  assert.equal(policyBlockedState.rows[0]?.status, "in_progress");
  assert.equal(policyBlockedState.rows[0]?.attempts, "1");
  await publishFundingPolicy(false);
  let resumedAfterPolicyCalls = 0;
  const resumedAfterPolicy = await executor(async () => {
    resumedAfterPolicyCalls += 1;
    return {
      kind: "submitted",
      transactionReference: `0x${"5".repeat(64)}`,
    };
  }).runBatch({ limit: 1, now: new Date(now.getTime() + 10 * 60_000) });
  assert.equal(resumedAfterPolicy.recovered, 1);
  assert.equal(resumedAfterPolicy.submitted, 1);
  assert.deepEqual(resumedAfterPolicy.operationIds, [
    policyBlocked.operationId,
  ]);
  assert.equal(resumedAfterPolicyCalls, 1);

  const policyPublicationRace = await createFixture("3250000");
  await publishFundingPolicy(false, false, { venues: [] });
  const policyPublisher = await pool.connect();
  let policyPublisherCommitted = false;
  let racedExecution:
    | ReturnType<DelegatedFundingExecutor["runBatch"]>
    | undefined;
  try {
    await policyPublisher.query("begin");
    await lockFundingPolicyForTransaction(policyPublisher);
    await publishFundingPolicy(false, false, { db: policyPublisher });
    racedExecution = executorForConfiguration(
      { ...profileConfiguration, enabled: false },
      async () => {
        throw new Error("a soft-paused policy race must not call the provider");
      },
    ).runBatch({ limit: 1, now: new Date(now.getTime() + 1_250) });
    assert.equal(
      await waitForLifecycleAdvisoryWait(),
      true,
      "early rejection must wait behind Funding Policy publication",
    );
    await policyPublisher.query("commit");
    policyPublisherCommitted = true;
  } finally {
    if (!policyPublisherCommitted) await policyPublisher.query("rollback");
    policyPublisher.release();
  }
  assert.ok(racedExecution);
  const publicationRacePaused = await racedExecution;
  assert.equal(publicationRacePaused.claimed, 1);
  assert.equal(publicationRacePaused.softPaused, 1);
  assert.equal(publicationRacePaused.definitivelyFailed, 0);
  assert.deepEqual(publicationRacePaused.operationIds, [
    policyPublicationRace.operationId,
  ]);
  const publicationRaceResumed = await executor(async () => ({
    kind: "submitted",
    transactionReference: `0x${"6".repeat(64)}`,
  })).runBatch({ limit: 1, now: new Date(now.getTime() + 10 * 60_000) });
  assert.equal(publicationRaceResumed.recovered, 1);
  assert.equal(publicationRaceResumed.submitted, 1);
  assert.deepEqual(publicationRaceResumed.operationIds, [
    policyPublicationRace.operationId,
  ]);

  const desiredBeforeClaim = await createFixture("3500000");
  await pool.query(
    `update telegram_bot_trading_preferences
     set desired_enabled = false
     where user_id = $1`,
    [desiredBeforeClaim.userId],
  );
  let desiredBeforeClaimCalls = 0;
  const pausedBeforeClaim = await executor(async () => {
    desiredBeforeClaimCalls += 1;
    return { kind: "ambiguous" };
  }).runBatch({ limit: 1, now: new Date(now.getTime() + 1_500) });
  assert.equal(pausedBeforeClaim.claimed, 1);
  assert.equal(pausedBeforeClaim.softPaused, 1);
  assert.equal(desiredBeforeClaimCalls, 0);
  await reduceFundingOperation(pool, {
    operationId: desiredBeforeClaim.operationId,
    now: new Date(now.getTime() + 2 * 60_000),
  });
  const pausedBeforeClaimState = await pool.query<{
    attempts: string;
    outcome: string | null;
    status: string;
  }>(
    `select operation.status,
            count(attempt.id)::text as attempts,
            min(attempt.outcome) as outcome
     from funding_operations operation
     join funding_operation_steps step on step.operation_id = operation.id
     left join funding_operation_step_attempts attempt on attempt.step_id = step.id
     where operation.id = $1
     group by operation.status`,
    [desiredBeforeClaim.operationId],
  );
  assert.deepEqual(pausedBeforeClaimState.rows[0], {
    attempts: "1",
    outcome: "started",
    status: "in_progress",
  });
  await pool.query(
    `update telegram_bot_trading_preferences
     set desired_enabled = true
     where user_id = $1`,
    [desiredBeforeClaim.userId],
  );
  const resumedBeforeClaim = await executor(async () => {
    desiredBeforeClaimCalls += 1;
    return {
      kind: "submitted",
      transactionReference: `0x${"8".repeat(64)}`,
    };
  }).runBatch({ limit: 1, now: new Date(now.getTime() + 12 * 60_000) });
  assert.equal(resumedBeforeClaim.recovered, 1);
  assert.equal(resumedBeforeClaim.submitted, 1);
  assert.equal(desiredBeforeClaimCalls, 1);

  const routerEnvironmentLoss = await createFixture("3600000");
  const configuredRouterAddress = process.env.POLYMARKET_FUNDING_ROUTER_ADDRESS;
  let routerEnvironmentCalls = 0;
  try {
    delete process.env.POLYMARKET_FUNDING_ROUTER_ADDRESS;
    const pausedForRouterEnvironment = await executor(async () => {
      routerEnvironmentCalls += 1;
      return { kind: "ambiguous" };
    }).runBatch({ limit: 1, now: new Date(now.getTime() + 1_600) });
    assert.equal(pausedForRouterEnvironment.claimed, 1);
    assert.equal(pausedForRouterEnvironment.softPaused, 1);
    assert.equal(pausedForRouterEnvironment.definitivelyFailed, 0);
    assert.equal(routerEnvironmentCalls, 0);
  } finally {
    if (configuredRouterAddress == null) {
      delete process.env.POLYMARKET_FUNDING_ROUTER_ADDRESS;
    } else {
      process.env.POLYMARKET_FUNDING_ROUTER_ADDRESS = configuredRouterAddress;
    }
  }
  const routerEnvironmentAttempt = await pool.query<{
    broadcast_may_have_occurred: boolean;
    outcome: string;
  }>(
    `select attempt.outcome, attempt.broadcast_may_have_occurred
     from funding_operation_step_attempts attempt
     join funding_operation_steps step on step.id = attempt.step_id
     where step.operation_id = $1`,
    [routerEnvironmentLoss.operationId],
  );
  assert.deepEqual(routerEnvironmentAttempt.rows, [
    { broadcast_may_have_occurred: false, outcome: "started" },
  ]);
  const resumedAfterRouterEnvironment = await executor(async () => {
    routerEnvironmentCalls += 1;
    return {
      kind: "submitted",
      transactionReference: `0x${"9".repeat(64)}`,
    };
  }).runBatch({ limit: 1, now: new Date(now.getTime() + 12 * 60_000) });
  assert.equal(resumedAfterRouterEnvironment.recovered, 1);
  assert.equal(resumedAfterRouterEnvironment.submitted, 1);
  assert.equal(routerEnvironmentCalls, 1);

  const stalePolicy = await createFixture("3750000");
  await publishFundingPolicy(false, true);
  let stalePolicyCalls = 0;
  const stalePolicyResult = await executor(async () => {
    stalePolicyCalls += 1;
    return { kind: "ambiguous" };
  }).runBatch({ limit: 1, now: new Date(now.getTime() + 1_750) });
  assert.equal(stalePolicyResult.definitivelyFailed, 1);
  assert.equal(stalePolicyCalls, 0);
  const stalePolicyAttempt = await pool.query<{
    outcome: string;
    reason_code: string | null;
  }>(
    `select attempt.outcome,
            attempt.actual_costs ->> 'reasonCode' as reason_code
     from funding_operation_step_attempts attempt
     join funding_operation_steps step on step.id = attempt.step_id
     where step.operation_id = $1`,
    [stalePolicy.operationId],
  );
  assert.deepEqual(stalePolicyAttempt.rows, [
    { outcome: "failed", reason_code: "funding_policy_changed" },
  ]);
  await publishFundingPolicy(false);

  const desiredBoundary = await createFixture("4000000");
  let desiredBoundaryCalls = 0;
  const softPausedAtBoundary = await executorWithBoundaryMutation(
    async () => {
      desiredBoundaryCalls += 1;
      return {
        kind: "submitted",
        transactionReference: `0x${"6".repeat(64)}`,
      };
    },
    async (client) => {
      await client.query(
        `update telegram_bot_trading_preferences
         set desired_enabled = false
         where user_id = $1`,
        [desiredBoundary.userId],
      );
    },
  ).runBatch({ limit: 1, now: new Date(now.getTime() + 2_000) });
  assert.equal(softPausedAtBoundary.softPaused, 1);
  assert.equal(softPausedAtBoundary.pending, 1);
  assert.equal(desiredBoundaryCalls, 0);
  const desiredPausedAttempt = await pool.query<{
    count: string;
    outcome: string;
  }>(
    `select count(*)::text as count, min(attempt.outcome) as outcome
     from funding_operation_step_attempts attempt
     join funding_operation_steps step on step.id = attempt.step_id
     where step.operation_id = $1`,
    [desiredBoundary.operationId],
  );
  assert.deepEqual(desiredPausedAttempt.rows[0], {
    count: "1",
    outcome: "started",
  });
  await pool.query(
    `update telegram_bot_trading_preferences
     set desired_enabled = true
     where user_id = $1`,
    [desiredBoundary.userId],
  );
  const resumedAfterDesired = await executor(async () => {
    desiredBoundaryCalls += 1;
    return {
      kind: "submitted",
      transactionReference: `0x${"6".repeat(64)}`,
    };
  }).runBatch({ limit: 1, now: new Date(now.getTime() + 10 * 60_000) });
  assert.equal(resumedAfterDesired.recovered, 1);
  assert.equal(resumedAfterDesired.submitted, 1);
  assert.equal(desiredBoundaryCalls, 1);
  const desiredResumedAttempt = await pool.query<{ count: string }>(
    `select count(*)::text as count
     from funding_operation_step_attempts attempt
     join funding_operation_steps step on step.id = attempt.step_id
     where step.operation_id = $1`,
    [desiredBoundary.operationId],
  );
  assert.equal(desiredResumedAttempt.rows[0]?.count, "1");

  const unlinkedBeforeBoundary = await createFixture("4500000");
  let unlinkedCalls = 0;
  const waitingBeforeUnlink = await executorWithBoundaryMutation(
    async () => {
      unlinkedCalls += 1;
      return { kind: "ambiguous" };
    },
    async (client) => {
      await client.query(
        `update telegram_bot_trading_preferences
         set desired_enabled = false
         where user_id = $1`,
        [unlinkedBeforeBoundary.userId],
      );
    },
  ).runBatch({ limit: 1, now: new Date(now.getTime() + 2_500) });
  assert.equal(waitingBeforeUnlink.softPaused, 1);
  assert.equal(unlinkedCalls, 0);
  await pool.query(`delete from user_telegram_accounts where id = $1`, [
    unlinkedBeforeBoundary.telegramAccountId,
  ]);
  const unlinkedHardInvalid = await executorForConfiguration(
    { ...profileConfiguration, enabled: false, signerId: "" },
    async () => {
      unlinkedCalls += 1;
      return { kind: "ambiguous" };
    },
  ).runBatch({ limit: 1, now: new Date(now.getTime() + 10 * 60_000) });
  assert.equal(unlinkedHardInvalid.definitivelyFailed, 1);
  assert.deepEqual(unlinkedHardInvalid.operationIds, [
    unlinkedBeforeBoundary.operationId,
  ]);
  assert.equal(
    unlinkedCalls,
    0,
    "hard unlink must win over simultaneous execution/config/preference pauses",
  );

  const revokedAtBoundary = await createFixture("5000000");
  let revokedAtBoundaryCalls = 0;
  const hardInvalidAtBoundary = await executorWithBoundaryMutation(
    async () => {
      revokedAtBoundaryCalls += 1;
      return { kind: "ambiguous" };
    },
    async (client) => {
      await client.query(
        `update telegram_funding_authorizations
         set revoked_at = $2, updated_at = $2
         where id = $1`,
        [revokedAtBoundary.authorizationId, new Date(now.getTime() + 3_000)],
      );
    },
  ).runBatch({ limit: 1, now: new Date(now.getTime() + 3_000) });
  assert.equal(hardInvalidAtBoundary.definitivelyFailed, 1);
  assert.equal(revokedAtBoundaryCalls, 0);
  await reduceFundingOperation(pool, {
    operationId: revokedAtBoundary.operationId,
    now: new Date(now.getTime() + 3_000),
  });
  const revokedAtBoundaryState = await pool.query<{ status: string }>(
    `select status from funding_operations where id = $1`,
    [revokedAtBoundary.operationId],
  );
  assert.equal(revokedAtBoundaryState.rows[0]?.status, "failed");

  const revokedAfterBoundary = await createFixture("6000000");
  let revokedAfterBoundaryCalls = 0;
  const completedAfterBoundary = await executor(async () => {
    revokedAfterBoundaryCalls += 1;
    assert.equal(
      await revokeTelegramFundingAuthorization(pool, {
        authorizationId: revokedAfterBoundary.authorizationId,
        userId: revokedAfterBoundary.userId,
        now: new Date(now.getTime() + 4_000),
      }),
      true,
    );
    return {
      kind: "submitted",
      transactionReference: `0x${"7".repeat(64)}`,
    };
  }).runBatch({ limit: 1, now: new Date(now.getTime() + 4_000) });
  assert.equal(completedAfterBoundary.submitted, 1);
  assert.equal(revokedAfterBoundaryCalls, 1);

  const revoked = await createFixture("2000000");
  assert.equal(
    await revokeTelegramFundingAuthorization(pool, {
      authorizationId: revoked.authorizationId,
      userId: revoked.userId,
      now,
    }),
    true,
  );
  let revokedCalls = 0;
  assert.equal(
    (
      await executor(async () => {
        revokedCalls += 1;
        return { kind: "ambiguous" };
      }).runBatch({ limit: 10, now })
    ).operationIds.includes(revoked.operationId),
    true,
  );
  assert.equal(revokedCalls, 0);
  await reduceFundingOperation(pool, { operationId: revoked.operationId, now });
  const revokedState = await pool.query<{ status: string }>(
    `select status from funding_operations where id = $1`,
    [revoked.operationId],
  );
  assert.equal(revokedState.rows[0]?.status, "failed");

  const boundaryLockOrder = await createFixture("6500000");
  const boundaryLifecycleClient = await pool.connect();
  let boundaryLifecycleCommitted = false;
  let boundaryExecution:
    | ReturnType<DelegatedFundingExecutor["runBatch"]>
    | undefined;
  let boundaryLockOrderCalls = 0;
  try {
    await boundaryLifecycleClient.query("begin");
    await lockTelegramFundingLinkLifecycle(
      boundaryLifecycleClient,
      boundaryLockOrder.userId,
    );
    boundaryExecution = executor(async () => {
      boundaryLockOrderCalls += 1;
      return { kind: "ambiguous" };
    }).runBatch({ limit: 1, now: new Date(now.getTime() + 4_500) });
    assert.equal(
      await waitForLifecycleAdvisoryWait(),
      true,
      "pre-broadcast validation must wait on lifecycle before locking mutable link authority",
    );
    await boundaryLifecycleClient.query(
      `update telegram_bot_trading_preferences
       set desired_enabled = false
       where user_id = $1`,
      [boundaryLockOrder.userId],
    );
    await boundaryLifecycleClient.query(
      `update telegram_funding_authorizations
       set revoked_at = $2, updated_at = $2
       where id = $1 and revoked_at is null`,
      [boundaryLockOrder.authorizationId, new Date(now.getTime() + 4_500)],
    );
    await boundaryLifecycleClient.query("commit");
    boundaryLifecycleCommitted = true;
  } finally {
    if (!boundaryLifecycleCommitted) {
      await boundaryLifecycleClient.query("rollback");
    }
    boundaryLifecycleClient.release();
  }
  assert.ok(boundaryExecution);
  const boundaryLockOrderResult = await boundaryExecution;
  assert.equal(boundaryLockOrderResult.definitivelyFailed, 1);
  assert.equal(boundaryLockOrderCalls, 0);

  const staleConsentPolicy = await createFixture("6750000");
  const staleConsentTarget = (
    await listFundingReceiveReceiptsForRouting(pool, {
      limit: 500,
      now: new Date(now.getTime() + 5_000),
    })
  ).find(
    (target) => target.receipt.receiptId === staleConsentPolicy.receiptIds[1],
  );
  assert.ok(staleConsentTarget);
  assert.deepEqual(
    await telegramUsdceWrapRoutingDecision(pool, staleConsentTarget),
    { kind: "allowed" },
  );
  await publishFundingPolicy(false, true);
  assert.deepEqual(
    await telegramUsdceWrapRoutingDecision(pool, staleConsentTarget),
    { kind: "hard_invalid", reasonCode: "funding_policy_changed" },
    "a new enabled Funding Policy revision must not reuse prior frozen consent",
  );
  await assertOperationAttachmentFailureRollsBack(staleConsentPolicy, {
    plannedStep: true,
  });

  const projectorWake = await createFixture("6900000");
  const projectionBaseline = new Date(now.getTime() + 10_000);
  await pool.query(
    `update telegram_funding_sessions context
     set progress_revision = 1,
         progress_fingerprint = $2,
         latest_progress_projection =
           '{"state":"converting","terminal":false}'::jsonb,
         projected_receive_version = receive.version,
         projected_consent_revision =
           coalesce(context.active_consent_revision, 0),
         projection_checked_at = $3
     from funding_receive_sessions receive
     where context.id = $1
       and receive.id = context.receive_session_id`,
    [
      projectorWake.telegramFundingSessionId,
      canonicalJsonHash({ state: "converting", terminal: false }),
      projectionBaseline,
    ],
  );
  const projectionReceiveVersion = await pool.query<{ version: number }>(
    `select receive.version
       from telegram_funding_sessions context
       join funding_receive_sessions receive
         on receive.id = context.receive_session_id
      where context.id = $1`,
    [projectorWake.telegramFundingSessionId],
  );
  await pool.query(
    `update telegram_bot_trading_preferences
     set desired_enabled = false
     where user_id = $1`,
    [projectorWake.userId],
  );
  await pool.query(
    `update telegram_bot_trading_authorizations
        set enabled = false
      where user_id = $1`,
    [projectorWake.userId],
  );
  await runTelegramFundingProgressProjectionBatch(pool, {
    limit: 500,
    now: new Date(projectionBaseline.getTime() + 30_000),
  });
  const beforeCapabilityRecheck = await pool.query<{ state: string }>(
    `select latest_progress_projection->>'state' as state
       from telegram_funding_sessions where id = $1`,
    [projectorWake.telegramFundingSessionId],
  );
  assert.equal(beforeCapabilityRecheck.rows[0]?.state, "converting");
  await runTelegramFundingProgressProjectionBatch(pool, {
    limit: 500,
    now: new Date(projectionBaseline.getTime() + 61_000),
  });
  const afterCapabilityRecheck = await pool.query<{
    state: string;
    version: number;
  }>(
    `select context.latest_progress_projection->>'state' as state,
            receive.version
       from telegram_funding_sessions context
       join funding_receive_sessions receive
         on receive.id = context.receive_session_id
      where context.id = $1`,
    [projectorWake.telegramFundingSessionId],
  );
  assert.deepEqual(afterCapabilityRecheck.rows[0], {
    state: "waiting_for_routing",
    version: projectionReceiveVersion.rows[0]?.version,
  });
  await pool.query(
    `update telegram_bot_trading_preferences
     set desired_enabled = true
     where user_id = $1`,
    [projectorWake.userId],
  );
  await pool.query(
    `update telegram_bot_trading_authorizations
        set enabled = true
      where user_id = $1`,
    [projectorWake.userId],
  );

  const transientInspection = await createFixture("6925000");
  const transientFacts = await pool.query<{
    destination_option_id: string;
    telegram_user_id: string;
    venue_binding_option_id: string;
  }>(
    `select telegram_user_id, destination_option_id, venue_binding_option_id
       from telegram_funding_authorizations
      where id = $1`,
    [transientInspection.authorizationId],
  );
  const transientIdentity = transientFacts.rows[0];
  assert.ok(transientIdentity);
  assert.equal(
    await ensureTelegramFundingAuthorization(
      pool,
      {
        userId: transientInspection.userId,
        telegramAccountId: transientInspection.telegramAccountId,
        telegramUserId: transientIdentity.telegram_user_id,
        controllerWalletId: transientInspection.actionWalletId,
        destinationOptionId: transientIdentity.destination_option_id,
        venueBindingOptionId: transientIdentity.venue_binding_option_id,
        now: new Date(now.getTime() + 4_700),
      },
      {
        configuration: profileConfiguration,
        environmentReady: true,
        inspectWalletProfile: async () => {
          throw new Error("temporary Privy outage");
        },
      },
    ),
    null,
    "a transient profile inspection failure must fail softly",
  );
  const transientAuthority = await pool.query<{ revoked_at: Date | null }>(
    `select revoked_at
       from telegram_funding_authorizations
      where id = $1`,
    [transientInspection.authorizationId],
  );
  assert.equal(
    transientAuthority.rows[0]?.revoked_at,
    null,
    "a transient profile inspection failure must preserve pinned authority",
  );

  const operatorRevocation = await createFixture("6935000");
  const operatorRevocationFacts = await pool.query<{
    destination_option_id: string;
    privy_wallet_id: string;
    telegram_user_id: string;
    venue_binding_option_id: string;
    wallet_address: string;
  }>(
    `select telegram_user_id, privy_wallet_id, wallet_address,
            destination_option_id, venue_binding_option_id
       from telegram_funding_authorizations
      where id = $1`,
    [operatorRevocation.authorizationId],
  );
  const operatorIdentity = operatorRevocationFacts.rows[0];
  assert.ok(operatorIdentity);
  assert.equal(
    await revokeTelegramFundingAuthorization(pool, {
      authorizationId: operatorRevocation.authorizationId,
      userId: operatorRevocation.userId,
      now: new Date(now.getTime() + 4_710),
    }),
    true,
  );
  let operatorRevocationInspectionCalls = 0;
  assert.equal(
    await ensureTelegramFundingAuthorization(
      pool,
      {
        userId: operatorRevocation.userId,
        telegramAccountId: operatorRevocation.telegramAccountId,
        telegramUserId: operatorIdentity.telegram_user_id,
        controllerWalletId: operatorRevocation.actionWalletId,
        destinationOptionId: operatorIdentity.destination_option_id,
        venueBindingOptionId: operatorIdentity.venue_binding_option_id,
        now: new Date(now.getTime() + 4_720),
      },
      {
        configuration: profileConfiguration,
        environmentReady: true,
        inspectWalletProfile: async () => {
          operatorRevocationInspectionCalls += 1;
          return "valid";
        },
      },
    ),
    null,
    "automatic provisioning must honor an explicit operator revoke",
  );
  assert.equal(operatorRevocationInspectionCalls, 0);
  const operatorBlocked = await pool.query<{
    active_count: string;
    funding_operator_revoked_at: Date | null;
  }>(
    `select preference.funding_operator_revoked_at,
            (count(funding_authorization.id) filter (
              where funding_authorization.revoked_at is null
            ))::text as active_count
       from telegram_bot_trading_preferences preference
       left join telegram_funding_authorizations funding_authorization
         on funding_authorization.user_id = preference.user_id
      where preference.user_id = $1
      group by preference.funding_operator_revoked_at`,
    [operatorRevocation.userId],
  );
  assert.ok(operatorBlocked.rows[0]?.funding_operator_revoked_at);
  assert.equal(operatorBlocked.rows[0]?.active_count, "0");
  const operatorRegrant = await grantTelegramFundingAuthorization(pool, {
    userId: operatorRevocation.userId,
    telegramAccountId: operatorRevocation.telegramAccountId,
    telegramUserId: operatorIdentity.telegram_user_id,
    userWalletId: operatorRevocation.userWalletId,
    privyWalletId: operatorIdentity.privy_wallet_id,
    walletAddress: operatorIdentity.wallet_address,
    destinationOptionId: operatorIdentity.destination_option_id,
    venueBindingOptionId: operatorIdentity.venue_binding_option_id,
    configuration: profileConfiguration,
    now: new Date(now.getTime() + 4_730),
    operatorOverride: true,
  });
  extraAuthorizationIds.push(operatorRegrant.id);
  const operatorUnblocked = await pool.query<{
    funding_operator_revoked_at: Date | null;
  }>(
    `select funding_operator_revoked_at
       from telegram_bot_trading_preferences
      where user_id = $1`,
    [operatorRevocation.userId],
  );
  assert.equal(
    operatorUnblocked.rows[0]?.funding_operator_revoked_at,
    null,
    "an explicit operator grant must clear the emergency stop",
  );
  await pool.query(
    `update telegram_bot_trading_preferences
        set funding_operator_revoked_at = $2
      where user_id = $1`,
    [operatorRevocation.userId, new Date(now.getTime() + 4_740)],
  );
  const blockedWithRetainedGrant =
    await resolveTelegramPolymarketWrapCapability(pool, {
      userId: operatorRevocation.userId,
      telegramAccountId: operatorRevocation.telegramAccountId,
      telegramUserId: operatorIdentity.telegram_user_id,
      destinationOptionId: operatorIdentity.destination_option_id,
      venueBindingOptionId: operatorIdentity.venue_binding_option_id,
      configuration: profileConfiguration,
      expectedAuthorizationId: operatorRegrant.id,
      expectedAuthorizationFingerprint:
        telegramFundingAuthorizationFingerprint(operatorRegrant),
      now: new Date(now.getTime() + 4_741),
    });
  assert.equal(
    blockedWithRetainedGrant.decision.kind,
    "hard_invalid",
    "an operator tombstone must override even a retained active grant",
  );
  const operatorReplay = await grantTelegramFundingAuthorization(pool, {
    userId: operatorRevocation.userId,
    telegramAccountId: operatorRevocation.telegramAccountId,
    telegramUserId: operatorIdentity.telegram_user_id,
    userWalletId: operatorRevocation.userWalletId,
    privyWalletId: operatorIdentity.privy_wallet_id,
    walletAddress: operatorIdentity.wallet_address,
    destinationOptionId: operatorIdentity.destination_option_id,
    venueBindingOptionId: operatorIdentity.venue_binding_option_id,
    configuration: profileConfiguration,
    now: new Date(now.getTime() + 4_750),
    operatorOverride: true,
  });
  assert.equal(operatorReplay.id, operatorRegrant.id);

  const routeReplacement = await createFixture("6950000");
  const routeReplacementFacts = await pool.query<{
    destination_option_id: string;
    privy_wallet_id: string;
    telegram_user_id: string;
    venue_binding_option_id: string;
    wallet_address: string;
  }>(
    `select telegram_user_id, privy_wallet_id, wallet_address,
            destination_option_id, venue_binding_option_id
       from telegram_funding_authorizations
      where id = $1`,
    [routeReplacement.authorizationId],
  );
  const routeReplacementIdentity = routeReplacementFacts.rows[0];
  assert.ok(routeReplacementIdentity);
  let releaseStaleVerification:
    | ((inspection: "valid" | "invalid" | "unavailable") => void)
    | undefined;
  let markVerificationStarted: (() => void) | undefined;
  const verificationStarted = new Promise<void>((resolve) => {
    markVerificationStarted = resolve;
  });
  const staleVerificationResult = new Promise<
    "valid" | "invalid" | "unavailable"
  >((resolve) => {
    releaseStaleVerification = resolve;
  });
  const staleEnsure = ensureTelegramFundingAuthorization(
    pool,
    {
      userId: routeReplacement.userId,
      telegramAccountId: routeReplacement.telegramAccountId,
      telegramUserId: routeReplacementIdentity.telegram_user_id,
      controllerWalletId: routeReplacement.actionWalletId,
      destinationOptionId: routeReplacementIdentity.destination_option_id,
      venueBindingOptionId: routeReplacementIdentity.venue_binding_option_id,
      now: new Date(now.getTime() + 4_800),
    },
    {
      configuration: profileConfiguration,
      environmentReady: true,
      inspectWalletProfile: async () => {
        markVerificationStarted?.();
        return staleVerificationResult;
      },
    },
  );
  await verificationStarted;
  const replacement = await grantTelegramFundingAuthorization(pool, {
    userId: routeReplacement.userId,
    telegramAccountId: routeReplacement.telegramAccountId,
    telegramUserId: routeReplacementIdentity.telegram_user_id,
    userWalletId: routeReplacement.userWalletId,
    privyWalletId: routeReplacementIdentity.privy_wallet_id,
    walletAddress: routeReplacementIdentity.wallet_address,
    destinationOptionId: opaque("replacement_destination"),
    venueBindingOptionId: opaque("replacement_binding"),
    configuration: profileConfiguration,
    now: new Date(now.getTime() + 4_900),
    replaceExisting: true,
  });
  extraAuthorizationIds.push(replacement.id);
  releaseStaleVerification?.("valid");
  assert.equal(
    await staleEnsure,
    null,
    "a stale successful profile check must fail closed",
  );
  const replacementRows = await pool.query<{
    id: string;
    revoked_at: Date | null;
  }>(
    `select id, revoked_at
       from telegram_funding_authorizations
      where id = any($1::uuid[])
      order by id`,
    [[routeReplacement.authorizationId, replacement.id]],
  );
  assert.equal(
    replacementRows.rows.filter((row) => row.revoked_at === null).length,
    1,
    "a route change must leave exactly one active profile authority",
  );
  assert.equal(
    replacementRows.rows.find(
      (row) => row.id === routeReplacement.authorizationId,
    )?.revoked_at != null,
    true,
    "a new route must revoke the prior active authority",
  );
  assert.equal(
    replacementRows.rows.find((row) => row.id === replacement.id)?.revoked_at,
    null,
    "a stale successful profile check must not replace a newer authority",
  );

  const lifecycleRace = await createFixture("7000000");
  const lifecycleGrantFacts = await pool.query<{
    destination_option_id: string;
    privy_wallet_id: string;
    telegram_user_id: string;
    venue_binding_option_id: string;
    wallet_address: string;
  }>(
    `select telegram_user_id, privy_wallet_id, wallet_address,
            destination_option_id, venue_binding_option_id
       from telegram_funding_authorizations
      where id = $1`,
    [lifecycleRace.authorizationId],
  );
  const lifecycleGrant = lifecycleGrantFacts.rows[0];
  assert.ok(lifecycleGrant);
  const unlinkClient = await pool.connect();
  let unlinkCommitted = false;
  let concurrentGrant:
    | Promise<
        | { authorizationId: string; error: null }
        | { authorizationId: null; error: unknown }
      >
    | undefined;
  try {
    await unlinkClient.query("begin");
    await lockTelegramFundingLinkLifecycle(unlinkClient, lifecycleRace.userId);
    await unlinkClient.query(
      `update telegram_funding_authorizations
          set revoked_at = $2, updated_at = $2
        where id = $1 and revoked_at is null`,
      [lifecycleRace.authorizationId, new Date(now.getTime() + 5_000)],
    );
    concurrentGrant = grantTelegramFundingAuthorization(pool, {
      userId: lifecycleRace.userId,
      telegramAccountId: lifecycleRace.telegramAccountId,
      telegramUserId: lifecycleGrant.telegram_user_id,
      userWalletId: lifecycleRace.userWalletId,
      privyWalletId: lifecycleGrant.privy_wallet_id,
      walletAddress: lifecycleGrant.wallet_address,
      destinationOptionId: lifecycleGrant.destination_option_id,
      venueBindingOptionId: lifecycleGrant.venue_binding_option_id,
      configuration: profileConfiguration,
      now: new Date(now.getTime() + 5_001),
    }).then(
      (authorization) => ({ authorizationId: authorization.id, error: null }),
      (error: unknown) => ({ authorizationId: null, error }),
    );
    assert.equal(
      await waitForLifecycleAdvisoryWait(),
      true,
      "concurrent grant must wait behind the unlink lifecycle lock",
    );
    await unlinkClient.query(
      `delete from user_telegram_accounts
        where id = $1 and user_id = $2`,
      [lifecycleRace.telegramAccountId, lifecycleRace.userId],
    );
    await unlinkClient.query("commit");
    unlinkCommitted = true;
  } finally {
    if (!unlinkCommitted) await unlinkClient.query("rollback");
    unlinkClient.release();
  }
  assert.ok(concurrentGrant);
  const lifecycleGrantResult = await concurrentGrant;
  assert.equal(lifecycleGrantResult.authorizationId, null);
  assert.match(
    String(lifecycleGrantResult.error),
    /funding authorization identity is not current/u,
  );
  const activeLifecycleGrants = await pool.query<{ count: string }>(
    `select count(*)::text as count
       from telegram_funding_authorizations
      where user_id = $1 and revoked_at is null`,
    [lifecycleRace.userId],
  );
  assert.equal(activeLifecycleGrants.rows[0]?.count, "0");
  const retainedWalletEvidenceBefore = await pool.query<{
    privy_wallet_id: string;
    wallet_address: string;
  }>(
    `select privy_wallet_id, wallet_address
       from telegram_funding_authorizations
      where id = $1`,
    [lifecycleRace.authorizationId],
  );
  await pool.query(`delete from user_wallets where id = $1`, [
    lifecycleRace.userWalletId,
  ]);
  const retainedWalletEvidenceAfter = await pool.query<{
    privy_wallet_id: string;
    revoked_at: Date | null;
    user_wallet_id: string | null;
    wallet_address: string;
  }>(
    `select user_wallet_id, privy_wallet_id, wallet_address, revoked_at
       from telegram_funding_authorizations
      where id = $1`,
    [lifecycleRace.authorizationId],
  );
  assert.deepEqual(
    {
      privy_wallet_id:
        retainedWalletEvidenceAfter.rows[0]?.privy_wallet_id ?? null,
      wallet_address:
        retainedWalletEvidenceAfter.rows[0]?.wallet_address ?? null,
    },
    retainedWalletEvidenceBefore.rows[0],
    "wallet unlink must preserve snapshotted authorization evidence",
  );
  assert.equal(retainedWalletEvidenceAfter.rows[0]?.user_wallet_id, null);
  assert.ok(retainedWalletEvidenceAfter.rows[0]?.revoked_at);

  const immutableBaselineRelay = await createRelayFixture();
  const immutableBaselineAt = new Date();
  const immutableBaselineSegment = await pool.query<{ id: string }>(
    `select id
       from funding_operation_segments
      where operation_id = $1::uuid
        and ordinal = 0`,
    [immutableBaselineRelay.operationId],
  );
  const immutableBaselineSegmentId = immutableBaselineSegment.rows[0]?.id;
  assert.ok(immutableBaselineSegmentId);
  await pool.query(
    `update funding_operation_steps
        set state = 'submitted'
      where operation_id = $1::uuid`,
    [immutableBaselineRelay.operationId],
  );
  await pool.query(
    `update funding_operation_steps
        set state = 'succeeded'
      where operation_id = $1::uuid`,
    [immutableBaselineRelay.operationId],
  );
  await pool.query(
    `update funding_operation_segments
        set status = 'submitted',
            submitted_at = $2,
            raw_status = 'success',
            support_metadata = support_metadata || jsonb_build_object(
              'relayStatusCategory', 'provider_success',
              'originTransactionReferenceCount', 1,
              'destinationTransactionReferenceCount', 1,
              'providerUpdatedAt', $3::bigint
            )
      where id = $1::uuid`,
    [
      immutableBaselineSegmentId,
      immutableBaselineAt,
      immutableBaselineAt.getTime(),
    ],
  );
  const ingressCreditReduction = await reduceFundingOperation(pool, {
    operationId: immutableBaselineRelay.operationId,
    now: immutableBaselineAt,
  });
  assert.deepEqual(ingressCreditReduction.finalState, {
    status: "in_progress",
    stage: "source_observed",
  });
  await tx(pool, (client) =>
    allocateFundingObservationInTransaction(client, {
      operationId: immutableBaselineRelay.operationId,
      segmentId: immutableBaselineSegmentId,
      kind: "source_debit",
      networkId: "evm:8453",
      assetId: BASE_USDC,
      assetDecimals: 6,
      txHash: `0x${crypto.randomBytes(32).toString("hex")}`,
      eventIndex: "0",
      fromAddress: immutableBaselineRelay.walletAddress,
      toAddress: RELAY_DEPOSITORY_V2,
      rawAmount: "2000000",
      observedAt: immutableBaselineAt,
      ledgerHeight: "250",
      blockHash: `0x${crypto.randomBytes(32).toString("hex")}`,
      finalityStatus: "finalized",
      finalizedAt: immutableBaselineAt,
      metadata: { relayDeposit: true },
    }),
  );
  let immutableBaselineObserved = false;
  const immutableBaselineObserver = new OwnedRouteDestinationObserver({
    observe: async (_db, target) => {
      immutableBaselineObserved = true;
      assert.equal(target.baselineRaw, "0");
      assert.match(target.baselineRevision, /^baseline_/u);
      assert.equal(
        target.destinationLocationId,
        immutableBaselineRelay.base.destinationLocationId,
      );
      return {
        observedRaw: "2000000",
        revision: opaque("immutable_receive_destination"),
        observedAt: new Date(
          immutableBaselineAt.getTime() + 1_000,
        ).toISOString(),
      };
    },
  });
  assert.deepEqual(
    await immutableBaselineObserver.pollOperation(
      pool,
      immutableBaselineRelay.operationId,
      new Date(immutableBaselineAt.getTime() + 1_000),
    ),
    { destinationsPolled: 1, destinationSatisfied: true },
  );
  assert.equal(
    immutableBaselineObserved,
    true,
    "immutable receive-session baseline must replace missing operation metadata",
  );
  const immutableBaselineReduction = await reduceFundingOperation(pool, {
    operationId: immutableBaselineRelay.operationId,
    now: new Date(immutableBaselineAt.getTime() + 1_001),
  });
  assert.deepEqual(immutableBaselineReduction.finalState, {
    status: "completed",
    stage: "terminal",
  });
  const immutableBaselineActualInput = await pool.query<{
    actual_input: { raw?: string } | null;
  }>(
    `select actual_input
       from funding_operation_segments
      where id = $1::uuid`,
    [immutableBaselineSegmentId],
  );
  assert.equal(
    immutableBaselineActualInput.rows[0]?.actual_input?.raw,
    "2000000",
    "the later route debit must replace, not add to, its ingress credit",
  );
  assert.equal(
    await settleFundingReceiveReceiptRouting(pool, {
      receiptId: immutableBaselineRelay.receiptId,
      receiveSessionId: immutableBaselineRelay.base.receiveSessionId,
      userId: immutableBaselineRelay.base.userId,
      childOperationId: immutableBaselineRelay.operationId,
      childOperationStatus: "completed",
      status: "ready",
      now: new Date(immutableBaselineAt.getTime() + 1_002),
    }),
    true,
  );
  assert.equal(
    await hasReadyTelegramFundingDestinationReceipt(
      pool,
      immutableBaselineRelay.base.telegramFundingSessionId,
    ),
    true,
    "terminal Relay destination evidence must unlock Buy continuation without rearm",
  );

  const exactReceiptRelay = await createRelayFixture();
  const exactReceiptAt = new Date(immutableBaselineAt.getTime() + 10_000);
  const exactDestinationTransactionHash = `0x${crypto
    .randomBytes(32)
    .toString("hex")}`;
  const exactReceiptSegment = await pool.query<{ id: string }>(
    `select id
       from funding_operation_segments
      where operation_id = $1::uuid
        and ordinal = 0`,
    [exactReceiptRelay.operationId],
  );
  const exactReceiptSegmentId = exactReceiptSegment.rows[0]?.id;
  assert.ok(exactReceiptSegmentId);
  await pool.query(
    `update funding_operation_steps
        set state = 'submitted'
      where operation_id = $1::uuid`,
    [exactReceiptRelay.operationId],
  );
  await pool.query(
    `update funding_operation_steps
        set state = 'succeeded'
      where operation_id = $1::uuid`,
    [exactReceiptRelay.operationId],
  );
  await pool.query(
    `update funding_operation_segments
        set status = 'submitted',
            submitted_at = $2,
            raw_status = 'success',
            support_metadata = support_metadata || jsonb_build_object(
              'relayStatusCategory', 'provider_success',
              'originTransactionReferenceCount', 1,
              'destinationTransactionReferenceCount', 1,
              'providerUpdatedAt', $3::bigint,
              'relayTransactionReferenceFingerprints', $4::jsonb
            )
      where id = $1::uuid`,
    [
      exactReceiptSegmentId,
      exactReceiptAt,
      exactReceiptAt.getTime(),
      JSON.stringify([
        referenceCodec.fingerprint(exactDestinationTransactionHash),
      ]),
    ],
  );
  await reduceFundingOperation(pool, {
    operationId: exactReceiptRelay.operationId,
    now: exactReceiptAt,
  });
  await tx(pool, (client) =>
    allocateFundingObservationInTransaction(client, {
      operationId: exactReceiptRelay.operationId,
      segmentId: exactReceiptSegmentId,
      kind: "source_debit",
      networkId: "evm:8453",
      assetId: BASE_USDC,
      assetDecimals: 6,
      txHash: `0x${crypto.randomBytes(32).toString("hex")}`,
      eventIndex: "0",
      fromAddress: exactReceiptRelay.walletAddress,
      toAddress: RELAY_DEPOSITORY_V2,
      rawAmount: "2000000",
      observedAt: exactReceiptAt,
      ledgerHeight: "251",
      blockHash: `0x${crypto.randomBytes(32).toString("hex")}`,
      finalityStatus: "finalized",
      finalizedAt: exactReceiptAt,
      metadata: { relayDeposit: true },
    }),
  );
  const exactDestinationReceiptId = await insertReadyPusdReceipt(
    exactReceiptRelay.base,
    "2000000",
    new Date(exactReceiptAt.getTime() + 1_000),
    exactDestinationTransactionHash,
  );
  const exactReceiptObserver = new OwnedRouteDestinationObserver({
    referenceCodec,
    observe: async () => {
      throw new Error(
        "an exact Relay destination receipt must not depend on current balance",
      );
    },
  });
  assert.deepEqual(
    await exactReceiptObserver.pollOperation(
      pool,
      exactReceiptRelay.operationId,
      new Date(exactReceiptAt.getTime() + 2_000),
    ),
    { destinationsPolled: 1, destinationSatisfied: true },
  );
  const exactReceiptObservation = await pool.query<{
    raw_amount: string;
    tx_hash: string;
    metadata: { receiveReceiptId?: string };
  }>(
    `select raw_amount::text as raw_amount, tx_hash, metadata
       from funding_observations
      where operation_id = $1::uuid
        and kind = 'destination_credit'`,
    [exactReceiptRelay.operationId],
  );
  assert.deepEqual(exactReceiptObservation.rows, [
    {
      raw_amount: "2000000",
      tx_hash: exactDestinationTransactionHash,
      metadata: {
        observerId: "relay_owned_destination_observation_v1",
        receiveReceiptId: exactDestinationReceiptId,
        receiveSessionId: exactReceiptRelay.base.receiveSessionId,
        relayTransactionReferenceMatched: true,
        relayTransactionReferenceFingerprint: referenceCodec.fingerprint(
          exactDestinationTransactionHash,
        ),
      },
    },
  ]);
  const exactReceiptReduction = await reduceFundingOperation(pool, {
    operationId: exactReceiptRelay.operationId,
    now: new Date(exactReceiptAt.getTime() + 2_001),
  });
  assert.deepEqual(exactReceiptReduction.finalState, {
    status: "completed",
    stage: "terminal",
  });

  const relayPolicyRace = await createRelayFixture();
  let relayPolicyRaceBroadcasts = 0;
  const relayPolicyRaceResult = await relayExecutorWithBoundaryMutation(
    [relayAllowanceEvidence("0", "49")],
    () => {
      relayPolicyRaceBroadcasts += 1;
    },
    async (client) => {
      const policy = await client.query<{ id: string }>(
        `insert into runtime_policies (
           policy_key, effective_at, payload, created_by
         ) values (
           'funding_control_plane',
           clock_timestamp() - interval '1 second',
           $1::jsonb,
           null
         ) returning id`,
        [
          JSON.stringify({
            version: 2,
            venues: ["polymarket", "limitless"],
            receive: {
              assets: ["polygon:pusd", "polygon:usdce", "base:usdc"],
              privy: true,
              delegatedRelayEvmDailyCapUsd: "10",
            },
            paused: false,
          }),
        ],
      );
      const id = policy.rows[0]?.id;
      assert.ok(id);
      policyIds.push(id);
    },
  ).runBatch({ limit: 1, now });
  assert.equal(relayPolicyRaceResult.definitivelyFailed, 1);
  assert.equal(
    relayPolicyRaceBroadcasts,
    0,
    "an active funding-policy revision change at the durable boundary must prevent Relay broadcast",
  );
  const relayPolicyRaceAttempt = await pool.query<{
    broadcast_may_have_occurred: boolean;
    outcome: string;
    reason_code: string;
  }>(
    `select attempt.outcome,
            attempt.broadcast_may_have_occurred,
            attempt.actual_costs ->> 'reasonCode' as reason_code
       from funding_operation_step_attempts attempt
      where attempt.step_id = $1
      order by attempt.attempt_number desc
      limit 1`,
    [relayPolicyRace.approvalStepId],
  );
  assert.deepEqual(relayPolicyRaceAttempt.rows[0], {
    broadcast_may_have_occurred: false,
    outcome: "failed",
    reason_code: "funding_policy_changed",
  });

  const delayedLaneHead = await createRelayFixture("2000000");
  const delayedLaneLockClient = await pool.connect();
  let delayedLaneLockCommitted = false;
  let delayedLaneFollowerPromise: Promise<RelayFixture> | undefined;
  try {
    await delayedLaneLockClient.query("begin");
    assert.equal(
      await lockFundingAuthorizationReservationScope(delayedLaneLockClient, {
        authorizationId: delayedLaneHead.authorizationId,
        userId: delayedLaneHead.base.userId,
      }),
      true,
    );
    delayedLaneFollowerPromise = createRelayFixture("3000000", {
      base: delayedLaneHead.base,
    });
    assert.equal(
      await waitForLifecycleAdvisoryWait(),
      true,
      "a concurrent reservation must wait on the shared allowance lane lock",
    );
    const routerLockOrder = await delayedLaneLockClient.query(
      `select wallet.id
         from users app_user
         join user_wallets wallet on wallet.user_id = app_user.id
        where app_user.id = $1::uuid
          and wallet.id = $2::uuid
        for update of app_user, wallet nowait`,
      [delayedLaneHead.base.userId, delayedLaneHead.base.userWalletId],
    );
    assert.equal(
      routerLockOrder.rowCount,
      1,
      "a router waiting on the allowance lane must not already hold wallet rows",
    );
    let delayedLaneBroadcasts = 0;
    const delayedLaneWhileLocked = await relayExecutor(
      [relayAllowanceEvidence("0", "99")],
      () => {
        delayedLaneBroadcasts += 1;
      },
    ).runBatch({ limit: 20, now });
    assert.equal(delayedLaneWhileLocked.claimed, 0);
    assert.equal(delayedLaneBroadcasts, 0);
    await delayedLaneLockClient.query("commit");
    delayedLaneLockCommitted = true;
  } finally {
    if (!delayedLaneLockCommitted)
      await delayedLaneLockClient.query("rollback");
    delayedLaneLockClient.release();
  }
  assert.ok(delayedLaneFollowerPromise);
  const delayedLaneFollower = await delayedLaneFollowerPromise;
  const delayedLaneOrder = await pool.query<{ operation_id: string }>(
    `select funding_operation_id::text as operation_id
       from telegram_funding_authorization_reservations
      where funding_operation_id in ($1::uuid, $2::uuid)
      order by reserved_at, id`,
    [delayedLaneHead.operationId, delayedLaneFollower.operationId],
  );
  assert.deepEqual(
    delayedLaneOrder.rows.map((row) => row.operation_id),
    [delayedLaneHead.operationId, delayedLaneFollower.operationId],
    "database-time ordering must not let a delayed insertion become a retroactive lane head",
  );
  await pool.query(
    `update telegram_funding_authorization_reservations
        set status = 'settled',
            resolved_at = $3,
            resolution_evidence = resolution_evidence ||
              jsonb_build_object('testResolution', 'lane_lock_complete'),
            updated_at = $3
      where funding_operation_id in ($1::uuid, $2::uuid)
        and status = 'reserved'`,
    [
      delayedLaneHead.operationId,
      delayedLaneFollower.operationId,
      new Date(now.getTime() + 1),
    ],
  );

  const relayLaneFirst = await createRelayFixture("2000000");
  const relayLaneSecond = await createRelayFixture("3000000", {
    base: relayLaneFirst.base,
  });
  const relayLaneOrder = await pool.query<{ operation_id: string }>(
    `select funding_operation_id::text as operation_id
       from telegram_funding_authorization_reservations
      where funding_operation_id in ($1::uuid, $2::uuid)
      order by reserved_at, id`,
    [relayLaneFirst.operationId, relayLaneSecond.operationId],
  );
  const relayLaneHead = relayLaneOrder.rows[0]?.operation_id;
  const relayLaneFollower = relayLaneOrder.rows[1]?.operation_id;
  assert.ok(relayLaneHead);
  assert.ok(relayLaneFollower);
  const relayLaneBroadcasts: string[] = [];
  const relayLaneExecutor = relayExecutor(
    [relayAllowanceEvidence("0", "94"), relayAllowanceEvidence("0", "95")],
    (claim) => relayLaneBroadcasts.push(claim.operationId),
  );
  const relayLaneFirstWave = await relayLaneExecutor.runBatch({
    limit: 20,
    now,
  });
  assert.equal(relayLaneFirstWave.submitted, 1);
  assert.deepEqual(relayLaneBroadcasts, [relayLaneHead]);
  assert.equal(
    (await relayLaneExecutor.runBatch({ limit: 20, now })).claimed,
    0,
    "a follower must not enter a wallet allowance lane while its head is unresolved",
  );
  await pool.query(
    `update telegram_funding_authorization_reservations
        set status = 'settled',
            resolved_at = $2,
            resolution_evidence = resolution_evidence ||
              jsonb_build_object('testResolution', 'lane_head_settled'),
            updated_at = $2
      where funding_operation_id = $1::uuid
        and status = 'reserved'`,
    [relayLaneHead, new Date(now.getTime() + 1)],
  );
  const relayLaneSecondWave = await relayLaneExecutor.runBatch({
    limit: 20,
    now: new Date(now.getTime() + 2),
  });
  assert.equal(relayLaneSecondWave.submitted, 1);
  assert.deepEqual(relayLaneBroadcasts, [relayLaneHead, relayLaneFollower]);

  const relayDepositOwnershipRace = await createRelayFixture();
  const relayDepositOwnershipBroadcasts = { value: 0 };
  const relayDepositOwnedApproval = relayAllowanceEvidence(
    "2000000",
    "96",
    "96",
  );
  const relayDepositApprovalExecutor = relayExecutor(
    [relayAllowanceEvidence("0", "97")],
    () => {
      relayDepositOwnershipBroadcasts.value += 1;
    },
  );
  assert.equal(
    (await relayDepositApprovalExecutor.runBatch({ limit: 1, now })).submitted,
    1,
  );
  await recordRelayApprovalSuccess(
    relayDepositOwnershipRace,
    new Date(now.getTime() + 1),
    relayDepositOwnedApproval.blockHash,
  );
  const relayDepositForeignMutation = relayAllowanceEvidence(
    "2000000",
    "98",
    "foreign-after-activation",
    `0x${"99".repeat(32)}`,
  );
  const relayDepositOwnershipResult = await relayExecutor(
    [relayDepositOwnedApproval, relayDepositForeignMutation],
    () => {
      relayDepositOwnershipBroadcasts.value += 1;
    },
  ).runBatch({ limit: 20, now: new Date(now.getTime() + 2) });
  assert.equal(relayDepositOwnershipResult.definitivelyFailed, 1);
  assert.equal(
    relayDepositOwnershipBroadcasts.value,
    1,
    "a same-value foreign allowance mutation before the durable deposit boundary must prevent broadcast",
  );
  const relayDepositOwnershipState = await pool.query<{
    error_code: string | null;
    operation_status: string;
    ownership_rejected: boolean;
    reservation_status: string;
  }>(
    `select operation.status as operation_status,
            operation.error_code,
            reservation.status as reservation_status,
            coalesce(
              approval_receipt.evidence ->> 'allowanceOwnershipRejected' =
                'true',
              false
            ) as ownership_rejected
       from funding_operations operation
       join funding_operation_steps approval_step
         on approval_step.operation_id = operation.id
        and approval_step.action_validation_result ->> 'relayStepKind' =
              'approve'
       join funding_step_receipt_observations approval_receipt
         on approval_receipt.step_id = approval_step.id
       join telegram_funding_authorization_reservations reservation
         on reservation.funding_operation_id = operation.id
      where operation.id = $1::uuid`,
    [relayDepositOwnershipRace.operationId],
  );
  assert.deepEqual(relayDepositOwnershipState.rows[0], {
    error_code: "relay_allowance_ownership_changed",
    operation_status: "failed",
    ownership_rejected: true,
    reservation_status: "released",
  });

  const relayApprovalReorgRace = await createRelayFixture();
  let relayApprovalReorgBroadcasts = 0;
  const relayApprovalObservation = relayAllowanceEvidence(
    "2000000",
    "48",
    "48",
  );
  const relayApprovalExecutor = relayExecutor(
    [relayAllowanceEvidence("0", "47")],
    () => {
      relayApprovalReorgBroadcasts += 1;
    },
  );
  assert.equal(
    (await relayApprovalExecutor.runBatch({ limit: 1, now })).submitted,
    1,
  );
  await recordRelayApprovalSuccess(
    relayApprovalReorgRace,
    new Date(now.getTime() + 1),
    relayApprovalObservation.blockHash,
  );
  const relayApprovalAttempt = await pool.query<{ id: string }>(
    `select id
       from funding_operation_step_attempts
      where step_id = $1
      order by attempt_number desc
      limit 1`,
    [relayApprovalReorgRace.approvalStepId],
  );
  const relayApprovalAttemptId = relayApprovalAttempt.rows[0]?.id;
  assert.ok(relayApprovalAttemptId);
  const relayApprovalReorgResult = await relayExecutorWithBoundaryMutation(
    [relayApprovalObservation, relayApprovalObservation],
    () => {
      relayApprovalReorgBroadcasts += 1;
    },
    (client) =>
      applyFundingStepReceiptEvidenceInTransaction(client, {
        operationId: relayApprovalReorgRace.operationId,
        stepId: relayApprovalReorgRace.approvalStepId,
        attemptId: relayApprovalAttemptId,
        networkId: "evm:8453",
        receipt: {
          status: "reorged",
          actionMatch: true,
          ledgerHeight: "200",
          blockHash: relayApprovalObservation.blockHash,
          canonical: false,
          failureCode: "receipt_block_not_canonical",
          evidence: { receiptObserved: true },
        },
        now: new Date(now.getTime() + 2),
      }).then(() => undefined),
  ).runBatch({ limit: 1, now: new Date(now.getTime() + 3) });
  assert.equal(relayApprovalReorgResult.definitivelyFailed, 1);
  assert.equal(
    relayApprovalReorgBroadcasts,
    1,
    "a reorg committed before the deposit boundary must prevent the deposit send",
  );

  const recoveredApprovalMaintenance = await createRelayFixture();
  const recoveredApprovalObservation = relayAllowanceEvidence("2000000", "102");
  let recoveredApprovalBroadcasts = 0;
  const recoveredApprovalReads: Array<Parameters<RelayEvmAllowanceReader>[0]> =
    [];
  const recoveredApprovalExecutor = relayExecutor(
    [relayAllowanceEvidence("0", "101"), recoveredApprovalObservation],
    () => {
      recoveredApprovalBroadcasts += 1;
    },
    (input) => recoveredApprovalReads.push(input),
  );
  assert.equal(
    (await recoveredApprovalExecutor.runBatch({ limit: 20, now })).submitted,
    1,
  );
  await recordRelayApprovalSuccess(
    recoveredApprovalMaintenance,
    new Date(now.getTime() + 1),
    recoveredApprovalObservation.blockHash,
  );
  await pool.query(
    `update funding_operation_steps
        set state = 'action_required',
            updated_at = $2
      where id = $1::uuid
        and state = 'planned'`,
    [recoveredApprovalMaintenance.depositStepId, new Date(now.getTime() + 2)],
  );
  let prematureClaimOperationId: string | null = null;
  await assert.rejects(
    tx(pool, async (client) => {
      const claimPolicy = await resolveFundingPolicy(client);
      const claim = await createRelayEvmDelegatedFundingProfile({
        configuration: relayConfiguration,
        allowanceReader: async () => recoveredApprovalObservation,
        driver: {
          execute: async () => {
            throw new Error("premature deposit executed");
          },
          recover: async () => ({ kind: "pending" as const }),
          lookupProviderReference: async () => ({ kind: "pending" as const }),
        },
      }).claimInTransaction(client, {
        policy: claimPolicy,
        now: new Date(now.getTime() + 2),
      });
      prematureClaimOperationId = claim
        ? claim.kind === "execution"
          ? claim.claim.operationId
          : claim.operationId
        : null;
      throw new Error("rollback dependency-evidence claim probe");
    }),
    /rollback dependency-evidence claim probe/,
  );
  assert.notEqual(
    prematureClaimOperationId,
    recoveredApprovalMaintenance.operationId,
    "deposit must not be claimed before exact allowance ownership evidence exists",
  );
  const prematureDepositAttempts = await pool.query<{ count: string }>(
    `select count(*)::text as count
       from funding_operation_step_attempts
      where step_id = $1::uuid`,
    [recoveredApprovalMaintenance.depositStepId],
  );
  assert.equal(prematureDepositAttempts.rows[0]?.count, "0");
  const recoveredApprovalMaintenanceResult =
    await recoveredApprovalExecutor.runBatch({
      limit: 1,
      now: new Date(now.getTime() + 3),
    });
  assert.equal(recoveredApprovalMaintenanceResult.submitted, 1);
  assert.equal(recoveredApprovalBroadcasts, 2);
  assert.equal(
    recoveredApprovalReads.at(-1)?.mutationBaselineBlock,
    "200",
    "deposit ownership must scan from its exact finalized approval receipt block",
  );
  const recoveredApprovalEvidence = await pool.query<{
    allowance_exact: boolean;
    allowance_raw: string | null;
  }>(
    `select coalesce(evidence ->> 'allowanceExact' = 'true', false)
              as allowance_exact,
            evidence ->> 'allowanceRaw' as allowance_raw
       from funding_step_receipt_observations
      where step_id = $1::uuid
        and status = 'finalized'
        and canonical
      order by observed_at desc
      limit 1`,
    [recoveredApprovalMaintenance.approvalStepId],
  );
  assert.deepEqual(recoveredApprovalEvidence.rows[0], {
    allowance_exact: true,
    allowance_raw: "2000000",
  });
  await pool.query(
    `update telegram_funding_authorization_reservations
        set status = 'settled',
            resolved_at = $2,
            resolution_evidence = resolution_evidence ||
              jsonb_build_object(
                'testResolution', 'recovered_approval_maintenance_complete'
              ),
            updated_at = $2
      where funding_operation_id = $1::uuid
        and status = 'reserved'`,
    [recoveredApprovalMaintenance.operationId, new Date(now.getTime() + 4)],
  );

  const hashAnchoredRelay = await createRelayFixture();
  const hashAnchoredBroadcasts = { value: 0 };
  const approvalBlockHash = `0x${"61".repeat(32)}`;
  const hashAnchoredExecutor = relayExecutor(
    [
      relayAllowanceEvidence("0", "50"),
      relayAllowanceEvidence("2000000", "51"),
    ],
    () => {
      hashAnchoredBroadcasts.value += 1;
    },
  );
  const hashAnchoredApproval = await hashAnchoredExecutor.runBatch({
    limit: 20,
    now,
  });
  assert.equal(
    hashAnchoredApproval.submitted,
    1,
    JSON.stringify(hashAnchoredApproval),
  );
  await recordRelayApprovalSuccess(
    hashAnchoredRelay,
    new Date(now.getTime() + 1),
    approvalBlockHash,
  );
  const mismatchedHash = await hashAnchoredExecutor.runBatch({
    limit: 1,
    now: new Date(now.getTime() + 2),
  });
  assert.equal(mismatchedHash.claimed, 0);
  assert.equal(hashAnchoredBroadcasts.value, 1);
  const hashAnchoredState = await pool.query<{ state: string }>(
    `select state from funding_operation_steps where id = $1`,
    [hashAnchoredRelay.depositStepId],
  );
  assert.equal(
    hashAnchoredState.rows[0]?.state,
    "reconcile_required",
    "same-height allowance from another block must not activate deposit",
  );
  await pool.query(
    `update funding_step_receipt_observations
        set evidence = evidence || jsonb_build_object(
          'allowanceAnchorRejected', true
        )
      where step_id = $1`,
    [hashAnchoredRelay.approvalStepId],
  );

  const foreignApprovalMutationRelay = await createRelayFixture();
  const foreignApprovalMutationBroadcasts = { value: 0 };
  const foreignApprovalMutation = relayAllowanceEvidence(
    "2000000",
    "52",
    "52",
    `0x${"99".repeat(32)}`,
  );
  const foreignApprovalMutationExecutor = relayExecutor(
    [relayAllowanceEvidence("0", "53"), foreignApprovalMutation],
    () => {
      foreignApprovalMutationBroadcasts.value += 1;
    },
  );
  assert.equal(
    (await foreignApprovalMutationExecutor.runBatch({ limit: 20, now }))
      .submitted,
    1,
  );
  await recordRelayApprovalSuccess(
    foreignApprovalMutationRelay,
    new Date(now.getTime() + 1),
    foreignApprovalMutation.blockHash,
  );
  const foreignApprovalActivation =
    await foreignApprovalMutationExecutor.runBatch({
      limit: 20,
      now: new Date(now.getTime() + 2),
    });
  assert.equal(foreignApprovalActivation.submitted, 0);
  assert.equal(foreignApprovalMutationBroadcasts.value, 1);
  const foreignApprovalMutationState = await pool.query<{
    operation_status: string;
    ownership_rejected: boolean;
    reservation_status: string;
    state: string;
  }>(
    `select deposit.state,
            operation.status as operation_status,
            reservation.status as reservation_status,
            coalesce(
              approval_receipt.evidence ->> 'allowanceOwnershipRejected' =
                'true',
              false
            ) as ownership_rejected
       from funding_operation_steps deposit
       join funding_operation_steps approval
         on approval.id = deposit.depends_on_step_id
       join funding_step_receipt_observations approval_receipt
         on approval_receipt.step_id = approval.id
       join funding_operations operation on operation.id = deposit.operation_id
       join telegram_funding_authorization_reservations reservation
         on reservation.funding_operation_id = operation.id
      where deposit.id = $1`,
    [foreignApprovalMutationRelay.depositStepId],
  );
  assert.deepEqual(foreignApprovalMutationState.rows[0], {
    operation_status: "failed",
    ownership_rejected: true,
    reservation_status: "released",
    state: "failed",
  });

  const releasedRelay = await createRelayFixture();
  const releasedBroadcasts = { value: 0 };
  await exhaustRelayApproval(releasedRelay, releasedBroadcasts);
  const releasedTerminal = await relayExecutor(
    [relayAllowanceEvidence("0", "21")],
    () => {
      throw new Error("exhausted zero-allowance approval broadcast again");
    },
  ).runBatch({ limit: 20, now: new Date(now.getTime() + 15 * 60_000 + 5) });
  assert.equal(releasedTerminal.claimed, 0);
  const releasedState = await pool.query<{
    approval_state: string;
    deposit_state: string;
    operation_status: string;
    reservation_status: string;
  }>(
    `select operation.status as operation_status,
            approval.state as approval_state,
            deposit.state as deposit_state,
            reservation.status as reservation_status
       from funding_operations operation
       join funding_operation_steps approval
         on approval.operation_id = operation.id and approval.ordinal = 0
       join funding_operation_steps deposit
         on deposit.operation_id = operation.id and deposit.ordinal = 1
       join telegram_funding_authorization_reservations reservation
         on reservation.funding_operation_id = operation.id
      where operation.id = $1`,
    [releasedRelay.operationId],
  );
  assert.deepEqual(releasedState.rows[0], {
    approval_state: "failed",
    deposit_state: "planned",
    operation_status: "failed",
    reservation_status: "released",
  });
  const immutableCap = await pool.query(
    `update telegram_funding_authorizations
        set max_source_raw = max_source_raw + 1
      where id = $1`,
    [releasedRelay.authorizationId],
  );
  assert.equal(immutableCap.rowCount, 0, "authorization cap is immutable");
  const immutableReservation = await pool.query(
    `update telegram_funding_authorization_reservations
        set source_raw = source_raw + 1
      where funding_operation_id = $1`,
    [releasedRelay.operationId],
  );
  assert.equal(
    immutableReservation.rowCount,
    0,
    "reservation amount is append-only evidence",
  );

  const expiredRelay = await createRelayFixture();
  await pool.query(
    `update funding_operation_steps
        set action_expires_at = created_at + interval '1 millisecond'
      where id = $1 and state = 'action_required'`,
    [expiredRelay.approvalStepId],
  );
  const expiredResult = await relayExecutor(
    [relayAllowanceEvidence("0", "22")],
    () => {
      throw new Error("expired zero-allowance approval broadcast");
    },
  ).runBatch({ limit: 1, now: new Date(now.getTime() + 15 * 60_000 + 5) });
  assert.equal(expiredResult.claimed, 0);
  const expiredState = await pool.query<{
    approval_state: string;
    deposit_state: string;
    operation_status: string;
    reservation_status: string;
  }>(
    `select operation.status as operation_status,
            approval.state as approval_state,
            deposit.state as deposit_state,
            reservation.status as reservation_status
       from funding_operations operation
       join funding_operation_steps approval
         on approval.operation_id = operation.id and approval.ordinal = 0
       join funding_operation_steps deposit
         on deposit.operation_id = operation.id and deposit.ordinal = 1
       join telegram_funding_authorization_reservations reservation
         on reservation.funding_operation_id = operation.id
      where operation.id = $1`,
    [expiredRelay.operationId],
  );
  assert.deepEqual(expiredState.rows[0], {
    approval_state: "failed",
    deposit_state: "planned",
    operation_status: "failed",
    reservation_status: "released",
  });

  const expiredDuringAllowanceOutage = await createRelayFixture();
  await pool.query(
    `update funding_operation_steps
        set action_expires_at = created_at + interval '1 millisecond'
      where id = $1 and state = 'action_required'`,
    [expiredDuringAllowanceOutage.approvalStepId],
  );
  let expiredOutageBroadcasts = 0;
  const expiredOutageResult = await relayExecutor(
    [relayAllowanceEvidence("0", "23")],
    () => {
      expiredOutageBroadcasts += 1;
    },
    () => {
      throw new Error("allowance RPC unavailable");
    },
  ).runBatch({ limit: 1, now: new Date(now.getTime() + 15 * 60_000 + 6) });
  assert.equal(expiredOutageResult.expiredWithoutBroadcast, 1);
  assert.equal(expiredOutageBroadcasts, 0);
  const expiredOutageState = await pool.query<{
    error_code: string | null;
    operation_status: string;
    reservation_status: string;
    diagnostic: string | null;
  }>(
    `select operation.status as operation_status,
            operation.error_code,
            operation.support_metadata ->> 'relayPreclaimDiagnostic' as diagnostic,
            reservation.status as reservation_status
       from funding_operations operation
       join telegram_funding_authorization_reservations reservation
         on reservation.funding_operation_id = operation.id
      where operation.id = $1`,
    [expiredDuringAllowanceOutage.operationId],
  );
  assert.deepEqual(expiredOutageState.rows[0], {
    diagnostic: "action_expired_without_attempt",
    error_code: "relay_action_expired_before_broadcast",
    operation_status: "failed",
    reservation_status: "released",
  });

  const terminalLaneHolder = await createRelayFixture();
  const holderMutation = await pool.connect();
  try {
    await holderMutation.query("begin");
    await holderMutation.query("set local session_replication_role = replica");
    await holderMutation.query(
      `update funding_operations
          set status = 'cancelled', progress_stage = 'terminal'
        where id = $1`,
      [terminalLaneHolder.operationId],
    );
    await holderMutation.query(
      `update funding_operation_steps set state = 'cancelled'
        where operation_id = $1`,
      [terminalLaneHolder.operationId],
    );
    await holderMutation.query("commit");
  } catch (error) {
    await holderMutation.query("rollback");
    throw error;
  } finally {
    holderMutation.release();
  }
  const expiredLaneFollower = await createRelayFixture("2000000", {
    base: terminalLaneHolder.base,
  });
  await pool.query(
    `update funding_operation_steps
        set action_expires_at = created_at + interval '1 millisecond'
      where id = $1 and state = 'action_required'`,
    [expiredLaneFollower.approvalStepId],
  );
  const terminalHolderCleanup = await relayExecutor(
    [relayAllowanceEvidence("0", "24")],
    () => {
      throw new Error("terminal lane holder must not broadcast");
    },
    () => {
      throw new Error("allowance RPC unavailable");
    },
  ).runBatch({ limit: 1, now: new Date(now.getTime() + 15 * 60_000 + 7) });
  assert.equal(terminalHolderCleanup.expiredWithoutBroadcast, 1);
  const terminalHolderState = await pool.query<{
    holder_reservation_status: string;
    holder_reason: string | null;
    follower_operation_status: string;
    follower_reservation_status: string;
  }>(
    `select holder_reservation.status as holder_reservation_status,
            holder_reservation.resolution_evidence ->> 'reason' as holder_reason,
            follower_operation.status as follower_operation_status,
            follower_reservation.status as follower_reservation_status
       from telegram_funding_authorization_reservations holder_reservation
       join telegram_funding_authorization_reservations follower_reservation
         on follower_reservation.funding_operation_id = $2::uuid
       join funding_operations follower_operation
         on follower_operation.id = follower_reservation.funding_operation_id
      where holder_reservation.funding_operation_id = $1::uuid`,
    [terminalLaneHolder.operationId, expiredLaneFollower.operationId],
  );
  assert.deepEqual(terminalHolderState.rows[0], {
    follower_operation_status: "failed",
    follower_reservation_status: "released",
    holder_reason: "terminal_without_broadcast",
    holder_reservation_status: "released",
  });

  const alreadyZeroRelay = await createRelayFixture();
  const alreadyZeroBroadcasts = { value: 0 };
  await exhaustRelayDeposit(alreadyZeroRelay, alreadyZeroBroadcasts, "31");
  const alreadyZeroResult = await relayExecutor(
    [
      relayAllowanceEvidence("2000000", "31", "31"),
      relayAllowanceEvidence("0", "32", "0", null, "finalized"),
    ],
    () => {
      alreadyZeroBroadcasts.value += 1;
    },
  ).runBatch({ limit: 1, now: new Date(now.getTime() + 15 * 60_000 + 5) });
  assert.equal(alreadyZeroResult.alreadySatisfied, 1);
  assert.equal(alreadyZeroBroadcasts.value, 3);
  const alreadyZeroState = await pool.query<{
    approval_state: string;
    cleanup_status: string;
    deposit_state: string;
    parent_status: string;
    reservation_status: string;
  }>(
    `select cleanup.status as cleanup_status,
            parent.status as parent_status,
            approval.state as approval_state,
            deposit.state as deposit_state,
            reservation.status as reservation_status
       from telegram_funding_authorization_reservations reservation
       join funding_operations cleanup
         on cleanup.id = reservation.cleanup_operation_id
       join funding_operations parent
         on parent.id = reservation.funding_operation_id
       join funding_operation_steps approval
         on approval.operation_id = parent.id and approval.ordinal = 0
       join funding_operation_steps deposit
         on deposit.operation_id = parent.id and deposit.ordinal = 1
      where reservation.funding_operation_id = $1`,
    [alreadyZeroRelay.operationId],
  );
  assert.deepEqual(alreadyZeroState.rows[0], {
    approval_state: "succeeded",
    cleanup_status: "completed",
    deposit_state: "action_required",
    parent_status: "failed",
    reservation_status: "cleaned",
  });

  const reorgableZeroRelay = await createRelayFixture();
  const reorgableZeroBroadcasts = { value: 0 };
  await exhaustRelayDeposit(reorgableZeroRelay, reorgableZeroBroadcasts, "131");
  const ownedResidual = relayAllowanceEvidence("2000000", "131", "131");
  const tipZeroResult = await relayExecutor(
    [ownedResidual, relayAllowanceEvidence("0", "132")],
    () => {
      reorgableZeroBroadcasts.value += 1;
    },
  ).runBatch({ limit: 1, now: new Date(now.getTime() + 15 * 60_000 + 5) });
  assert.equal(tipZeroResult.softPaused, 1);
  assert.equal(tipZeroResult.alreadySatisfied, 0);
  assert.equal(
    reorgableZeroBroadcasts.value,
    3,
    "a zero observed only at the latest tip must not release the cleanup lane",
  );
  const tipZeroState = await pool.query<{
    cleanup_status: string;
    parent_status: string;
    reservation_status: string;
  }>(
    `select cleanup.status as cleanup_status,
            parent.status as parent_status,
            reservation.status as reservation_status
       from telegram_funding_authorization_reservations reservation
       join funding_operations cleanup
         on cleanup.id = reservation.cleanup_operation_id
       join funding_operations parent
         on parent.id = reservation.funding_operation_id
      where reservation.funding_operation_id = $1`,
    [reorgableZeroRelay.operationId],
  );
  assert.deepEqual(tipZeroState.rows[0], {
    cleanup_status: "in_progress",
    parent_status: "in_progress",
    reservation_status: "cleanup_required",
  });
  const restoredResidualResult = await relayExecutor([ownedResidual], () => {
    reorgableZeroBroadcasts.value += 1;
  }).runBatch({ limit: 1, now: new Date(now.getTime() + 15 * 60_000 + 7) });
  assert.equal(restoredResidualResult.recovered, 1);
  assert.equal(restoredResidualResult.submitted, 1);
  assert.equal(
    reorgableZeroBroadcasts.value,
    4,
    "a residual restored by a tip reorg must still be revoked",
  );

  const postDepositAlreadyZeroRelay = await createRelayFixture();
  const postDepositAlreadyZeroBroadcasts = { value: 0 };
  const postDepositApproval = relayAllowanceEvidence("2000000", "133", "133");
  const postDepositApprovalExecutor = relayExecutor(
    [relayAllowanceEvidence("0", "132")],
    () => {
      postDepositAlreadyZeroBroadcasts.value += 1;
    },
  );
  assert.equal(
    (await postDepositApprovalExecutor.runBatch({ limit: 1, now })).submitted,
    1,
  );
  await recordRelayApprovalSuccess(
    postDepositAlreadyZeroRelay,
    new Date(now.getTime() + 1),
    postDepositApproval.blockHash,
  );
  const postDepositExecutor = relayExecutor(
    [postDepositApproval, postDepositApproval],
    () => {
      postDepositAlreadyZeroBroadcasts.value += 1;
    },
  );
  assert.equal(
    (
      await postDepositExecutor.runBatch({
        limit: 1,
        now: new Date(now.getTime() + 2),
      })
    ).submitted,
    1,
  );
  const postDepositTransactionHash = `0x${"62".repeat(32)}`;
  const postDepositResidual = relayAllowanceEvidence(
    "1000000",
    "134",
    "post-deposit-residual",
    postDepositTransactionHash,
  );
  await recordRelayDepositSuccess(postDepositAlreadyZeroRelay, {
    at: new Date(now.getTime() + 3),
    blockHash: postDepositResidual.blockHash,
    ledgerHeight: postDepositResidual.blockNumber,
    transactionHash: postDepositTransactionHash,
  });
  const postDepositAlreadyZero = await relayExecutor(
    [
      postDepositResidual,
      relayAllowanceEvidence("0", "135", "0", null, "finalized"),
    ],
    () => {
      postDepositAlreadyZeroBroadcasts.value += 1;
    },
  ).runBatch({ limit: 1, now: new Date(now.getTime() + 4) });
  assert.equal(
    postDepositAlreadyZero.alreadySatisfied,
    1,
    JSON.stringify(postDepositAlreadyZero),
  );
  assert.equal(
    postDepositAlreadyZeroBroadcasts.value,
    2,
    "an already-zero post-deposit cleanup must not broadcast a revoke",
  );
  const postDepositAlreadyZeroState = await pool.query<{
    cleanup_status: string;
    parent_status: string;
    reservation_status: string;
    source_debit_count: string;
    source_debit_raw: string | null;
  }>(
    `select cleanup.status as cleanup_status,
            parent.status as parent_status,
            reservation.status as reservation_status,
            count(source_debit.id)::text as source_debit_count,
            max(source_debit.raw_amount)::text as source_debit_raw
       from telegram_funding_authorization_reservations reservation
       join funding_operations cleanup
         on cleanup.id = reservation.cleanup_operation_id
       join funding_operations parent
         on parent.id = reservation.funding_operation_id
       left join funding_observations source_debit
         on source_debit.operation_id = parent.id
        and source_debit.kind = 'source_debit'
        and source_debit.canonical
      where reservation.funding_operation_id = $1::uuid
      group by cleanup.status, parent.status, reservation.status`,
    [postDepositAlreadyZeroRelay.operationId],
  );
  assert.deepEqual(postDepositAlreadyZeroState.rows[0], {
    cleanup_status: "completed",
    parent_status: "in_progress",
    reservation_status: "cleaned",
    source_debit_count: "1",
    source_debit_raw: "2000000",
  });

  const foreignDriftRelay = await createRelayFixture();
  const foreignDriftBroadcasts = { value: 0 };
  await exhaustRelayDeposit(foreignDriftRelay, foreignDriftBroadcasts, "41");
  const foreignDriftResult = await relayExecutor(
    [
      relayAllowanceEvidence("2000000", "41", "41"),
      relayAllowanceEvidence("2000000", "42", "foreign"),
    ],
    () => {
      foreignDriftBroadcasts.value += 1;
    },
  ).runBatch({ limit: 1, now: new Date(now.getTime() + 15 * 60_000 + 5) });
  assert.equal(foreignDriftResult.definitivelyFailed, 1);
  assert.equal(foreignDriftBroadcasts.value, 3);
  const foreignDriftState = await pool.query<{
    cleanup_operation_status: string;
    cleanup_step_state: string;
    parent_status: string;
    reservation_status: string;
  }>(
    `select cleanup_step.state as cleanup_step_state,
            cleanup.status as cleanup_operation_status,
            parent.status as parent_status,
            reservation.status as reservation_status
       from telegram_funding_authorization_reservations reservation
       join funding_operations cleanup
         on cleanup.id = reservation.cleanup_operation_id
       join funding_operations parent
         on parent.id = reservation.funding_operation_id
       join funding_operation_steps cleanup_step
         on cleanup_step.operation_id = reservation.cleanup_operation_id
      where reservation.funding_operation_id = $1`,
    [foreignDriftRelay.operationId],
  );
  assert.deepEqual(foreignDriftState.rows[0], {
    cleanup_operation_status: "recovery_required",
    cleanup_step_state: "failed",
    parent_status: "recovery_required",
    reservation_status: "cleanup_required",
  });

  const foreignLastMutationRelay = await createRelayFixture();
  const foreignLastMutationBroadcasts = { value: 0 };
  await exhaustRelayDeposit(
    foreignLastMutationRelay,
    foreignLastMutationBroadcasts,
    "43",
  );
  const foreignLastMutationResult = await relayExecutor(
    [relayAllowanceEvidence("2000000", "43", "43", `0x${"99".repeat(32)}`)],
    () => {
      foreignLastMutationBroadcasts.value += 1;
    },
  ).runBatch({ limit: 1, now: new Date(now.getTime() + 15 * 60_000 + 5) });
  assert.equal(foreignLastMutationResult.claimed, 0);
  assert.equal(foreignLastMutationBroadcasts.value, 3);
  const foreignLastMutationState = await pool.query<{
    cleanup_operation_id: string | null;
    operation_status: string;
    ownership_rejected: boolean;
    reservation_status: string;
  }>(
    `select reservation.cleanup_operation_id,
            reservation.status as reservation_status,
            operation.status as operation_status,
            coalesce(
              approval_receipt.evidence ->> 'allowanceOwnershipRejected' =
                'true',
              false
            ) as ownership_rejected
       from telegram_funding_authorization_reservations reservation
       join funding_operation_steps approval_step
         on approval_step.operation_id = reservation.funding_operation_id
        and approval_step.ordinal = 0
       join funding_step_receipt_observations approval_receipt
         on approval_receipt.step_id = approval_step.id
       join funding_operations operation
         on operation.id = reservation.funding_operation_id
      where reservation.funding_operation_id = $1`,
    [foreignLastMutationRelay.operationId],
  );
  assert.deepEqual(foreignLastMutationState.rows[0], {
    cleanup_operation_id: null,
    operation_status: "failed",
    ownership_rejected: true,
    reservation_status: "released",
  });

  const unchangedOwnedRelay = await createRelayFixture("2000000", {
    checksumReceiptAddresses: true,
  });
  const unchangedOwnedBroadcasts = { value: 0 };
  await exhaustRelayDeposit(
    unchangedOwnedRelay,
    unchangedOwnedBroadcasts,
    "35",
  );
  const unchangedOwnedResult = await relayExecutor(
    [
      relayAllowanceEvidence("2000000", "35", "35"),
      relayAllowanceEvidence("2000000", "36", "35"),
    ],
    () => {
      unchangedOwnedBroadcasts.value += 1;
    },
  ).runBatch({ limit: 1, now: new Date(now.getTime() + 15 * 60_000 + 5) });
  assert.equal(
    unchangedOwnedResult.submitted,
    1,
    "a later block with unchanged owned mutation history remains cleanable",
  );
  assert.equal(unchangedOwnedBroadcasts.value, 4);
  const cleanupScope = await pool.query<{
    attempt_id: string;
    cleanup_operation_id: string;
    cleanup_step_id: string;
  }>(
    `select cleanup.id as cleanup_operation_id,
            cleanup_step.id as cleanup_step_id,
            cleanup_attempt.id as attempt_id
       from telegram_funding_authorization_reservations reservation
       join funding_operations cleanup
         on cleanup.id = reservation.cleanup_operation_id
       join funding_operation_steps cleanup_step
         on cleanup_step.operation_id = cleanup.id
        and cleanup_step.action_validation_result ->> 'relayStepKind' = 'cleanup'
       join funding_operation_step_attempts cleanup_attempt
         on cleanup_attempt.step_id = cleanup_step.id
      where reservation.funding_operation_id = $1
      order by cleanup_attempt.attempt_number desc
      limit 1`,
    [unchangedOwnedRelay.operationId],
  );
  const cleanup = cleanupScope.rows[0];
  assert.ok(cleanup);
  const cleanupReceiptTargets = await listFundingStepReceiptTargets(
    pool,
    cleanup.cleanup_operation_id,
    new Date(now.getTime() + 15 * 60_000 + 6),
  );
  assert.equal(cleanupReceiptTargets.length, 1);
  assert.equal(
    cleanupReceiptTargets[0]?.actionValidationResult.signerAddress,
    unchangedOwnedRelay.walletAddress,
    "Relay cleanup receipts require the committed managed-wallet signer",
  );
  const cleanupWalletSnapshot = await pool.query<{
    wallet_address: string | null;
  }>(
    `select wallet_execution_snapshot ->> 'address' as wallet_address
       from funding_operations
      where id = $1::uuid`,
    [cleanup.cleanup_operation_id],
  );
  assert.equal(
    cleanupWalletSnapshot.rows[0]?.wallet_address,
    unchangedOwnedRelay.walletAddress,
  );
  const timedOutCleanupStep = await pool.query(
    `update funding_operation_steps
        set state = 'recovery_required', updated_at = $2
      where id = $1::uuid
        and state in ('submitted', 'reconcile_required')`,
    [cleanup.cleanup_step_id, new Date(now.getTime() + 19 * 60_000)],
  );
  assert.equal(timedOutCleanupStep.rowCount, 1);
  const cleanupFinalizedAt = new Date(now.getTime() + 20 * 60_000);
  const cleanupZero = relayAllowanceEvidence(
    "0",
    "37",
    "cleanup-owned-zero",
    `0x${"77".repeat(32)}`,
  );
  await tx(pool, (client) =>
    applyFundingStepReceiptEvidenceInTransaction(client, {
      operationId: cleanup.cleanup_operation_id,
      stepId: cleanup.cleanup_step_id,
      attemptId: cleanup.attempt_id,
      networkId: "evm:8453",
      receipt: {
        status: "finalized",
        actionMatch: true,
        ledgerHeight: cleanupZero.blockNumber,
        blockHash: cleanupZero.blockHash,
        canonical: true,
        failureCode: null,
        evidence: {
          singleOperationBundle: true,
          transactionHash: `0x${"77".repeat(32)}`,
        },
      },
      now: cleanupFinalizedAt,
    }),
  );
  const beforeCleanupMaturity = await relayExecutor([cleanupZero], () => {
    throw new Error("cleanup canonical watch rebroadcast unexpectedly");
  }).runBatch({
    limit: 20,
    now: new Date(
      cleanupFinalizedAt.getTime() + RELAY_CLEANUP_CANONICAL_WATCH_MS - 1,
    ),
  });
  assert.equal(beforeCleanupMaturity.claimed, 0);
  const beforeMaturityState = await pool.query<{
    allowance_zero: boolean;
    cleanup_state: string;
    cleanup_status: string;
    parent_status: string;
    reservation_status: string;
  }>(
    `select cleanup.status as cleanup_status,
            cleanup_step.state as cleanup_state,
            parent.status as parent_status,
            reservation.status as reservation_status,
            coalesce(
              cleanup_receipt.evidence ->> 'allowanceZero' = 'true',
              false
            ) as allowance_zero
       from telegram_funding_authorization_reservations reservation
       join funding_operations cleanup
         on cleanup.id = reservation.cleanup_operation_id
       join funding_operations parent
         on parent.id = reservation.funding_operation_id
       join funding_operation_steps cleanup_step
         on cleanup_step.operation_id = cleanup.id
       join funding_step_receipt_observations cleanup_receipt
         on cleanup_receipt.step_id = cleanup_step.id
      where reservation.funding_operation_id = $1`,
    [unchangedOwnedRelay.operationId],
  );
  assert.deepEqual(beforeMaturityState.rows[0], {
    allowance_zero: false,
    cleanup_state: "recovery_required",
    cleanup_status: "in_progress",
    parent_status: "in_progress",
    reservation_status: "cleanup_required",
  });
  const preMaturityParent = await pool.query<{
    progress_stage: "committed" | "source_action" | "source_observed";
    status: "in_progress";
    version: string | number;
  }>(
    `select status, progress_stage, version
       from funding_operations
      where id = $1::uuid`,
    [unchangedOwnedRelay.operationId],
  );
  const preMaturityParentRow = preMaturityParent.rows[0];
  assert.ok(preMaturityParentRow);
  await tx(pool, async (client) => {
    let version = Number(preMaturityParentRow.version);
    let stage = preMaturityParentRow.progress_stage;
    if (stage === "committed") {
      const sourceAction = await transitionFundingOperationInTransaction(
        client,
        {
          operationId: unchangedOwnedRelay.operationId,
          scope: { kind: "worker" },
          expectedVersion: version,
          expectedState: { status: "in_progress", stage },
          nextState: { status: "in_progress", stage: "source_action" },
          now: new Date(
            cleanupFinalizedAt.getTime() + RELAY_CLEANUP_CANONICAL_WATCH_MS - 3,
          ),
        },
      );
      version = sourceAction.version;
      stage = "source_action";
    }
    if (stage === "source_action") {
      const sourceObserved = await transitionFundingOperationInTransaction(
        client,
        {
          operationId: unchangedOwnedRelay.operationId,
          scope: { kind: "worker" },
          expectedVersion: version,
          expectedState: { status: "in_progress", stage },
          nextState: { status: "in_progress", stage: "source_observed" },
          now: new Date(
            cleanupFinalizedAt.getTime() + RELAY_CLEANUP_CANONICAL_WATCH_MS - 2,
          ),
        },
      );
      version = sourceObserved.version;
    }
    await transitionFundingOperationInTransaction(client, {
      operationId: unchangedOwnedRelay.operationId,
      scope: { kind: "worker" },
      expectedVersion: version,
      expectedState: { status: "in_progress", stage: "source_observed" },
      nextState: { status: "recovery_required", stage: "source_observed" },
      errorCode: "reconciliation_evidence_timeout",
      now: new Date(
        cleanupFinalizedAt.getTime() + RELAY_CLEANUP_CANONICAL_WATCH_MS - 1,
      ),
    });
  });
  const atCleanupMaturity = await relayExecutor([cleanupZero], () => {
    throw new Error("mature cleanup rebroadcast unexpectedly");
  }).runBatch({
    limit: 20,
    now: new Date(
      cleanupFinalizedAt.getTime() + RELAY_CLEANUP_CANONICAL_WATCH_MS,
    ),
  });
  assert.equal(atCleanupMaturity.claimed, 0);
  const matureState = await pool.query<{
    cleanup_state: string;
    cleanup_status: string;
    parent_status: string;
    reservation_status: string;
  }>(
    `select cleanup.status as cleanup_status,
            cleanup_step.state as cleanup_state,
            parent.status as parent_status,
            reservation.status as reservation_status
       from telegram_funding_authorization_reservations reservation
       join funding_operations cleanup
         on cleanup.id = reservation.cleanup_operation_id
       join funding_operations parent
         on parent.id = reservation.funding_operation_id
       join funding_operation_steps cleanup_step
         on cleanup_step.operation_id = cleanup.id
      where reservation.funding_operation_id = $1`,
    [unchangedOwnedRelay.operationId],
  );
  assert.deepEqual(matureState.rows[0], {
    cleanup_state: "succeeded",
    cleanup_status: "completed",
    parent_status: "failed",
    reservation_status: "cleaned",
  });
  await assert.rejects(
    tx(pool, async (client) => {
      const retryNow = new Date(
        cleanupFinalizedAt.getTime() + RELAY_CLEANUP_CANONICAL_WATCH_MS + 1,
      );
      const detached = await client.query(
        `update funding_receive_receipts
            set status = 'observed',
                child_funding_operation_id = null,
                routing_disposition = 'pending',
                routing_last_error_code = null,
                routing_next_attempt_at = $3,
                evidence = jsonb_set(
                  evidence,
                  '{routingOperationHistory}',
                  jsonb_build_array(jsonb_build_object(
                    'operationId', $2::text,
                    'outcome', 'failed',
                    'detachedAt', $3::timestamptz
                  )),
                  true
                ),
                updated_at = $3
          where id = $1::uuid
            and child_funding_operation_id = $2::uuid
            and status in ('routing', 'recovery_required')`,
        [
          unchangedOwnedRelay.receiptId,
          unchangedOwnedRelay.operationId,
          retryNow,
        ],
      );
      assert.equal(detached.rowCount, 1);
      const retryPolicy = await resolveFundingPolicy(client);
      const retryConsentToken = opaque("relay_retry_consent");
      const retrySourceSnapshot =
        unchangedOwnedRelay.plan.operation.sourceSnapshot;
      assert.ok(retrySourceSnapshot);
      const retryQuote = await createFundingQuoteInTransaction(client, {
        userId: unchangedOwnedRelay.base.userId,
        discoveryProjectionId: opaque("relay_retry_projection"),
        selectedSourceOptionSnapshot: retrySourceSnapshot,
        marketContextSnapshot: null,
        destinationOptionSnapshot:
          unchangedOwnedRelay.plan.operation.destinationTargetSnapshot,
        venueBindingSnapshot:
          unchangedOwnedRelay.plan.operation.venueBindingSnapshot,
        planSnapshot: unchangedOwnedRelay.plan,
        policyVersion: retryPolicy.runtime.contractVersion,
        policyRevision: retryPolicy.revision,
        canonicalRequest: {
          receiptId: unchangedOwnedRelay.receiptId,
          relay: true,
          retry: 1,
        },
        consentToken: retryConsentToken,
        expiresAt: new Date(retryNow.getTime() + 4 * 60_000),
      });
      const retryIdempotencyKey =
        await fundingReceiveReceiptOperationIdempotencyKey(client, {
          receiptId: unchangedOwnedRelay.receiptId,
          userId: unchangedOwnedRelay.base.userId,
        });
      assert.equal(
        retryIdempotencyKey,
        `receive-receipt:${unchangedOwnedRelay.receiptId}:retry:1`,
      );
      const retryOperation = await commitFundingOperationInTransaction(client, {
        userId: unchangedOwnedRelay.base.userId,
        quoteId: retryQuote.id,
        consentToken: retryConsentToken,
        idempotencyKey: retryIdempotencyKey,
        plan: unchangedOwnedRelay.plan,
        subjectLookupHmac: crypto
          .createHash("sha256")
          .update(`${unchangedOwnedRelay.base.userId}:relay-retry`)
          .digest("hex"),
        subjectLookupKeyVersion: 1,
        now: retryNow,
      });
      assert.notEqual(
        retryOperation.operation.id,
        unchangedOwnedRelay.operationId,
      );
      const checksumReallocation = await client.query<{
        observation_asset: string;
        observation_from: string;
        observation_to: string;
        receipt_asset: string;
        receipt_from: string;
        receipt_to: string;
      }>(
        `select observation.asset_id as observation_asset,
                observation.from_address as observation_from,
                observation.to_address as observation_to,
                receipt.asset_id as receipt_asset,
                receipt.source_address as receipt_from,
                receipt.destination_address as receipt_to
           from funding_observations observation
           join funding_receive_receipts receipt
             on receipt.id = $1::uuid
          where observation.operation_id = $2::uuid
            and observation.kind = 'source_credit'`,
        [unchangedOwnedRelay.receiptId, unchangedOwnedRelay.operationId],
      );
      const checksumEvidence = checksumReallocation.rows[0];
      assert.ok(checksumEvidence);
      assert.equal(
        checksumEvidence.observation_asset.toLowerCase(),
        checksumEvidence.receipt_asset.toLowerCase(),
      );
      assert.equal(
        checksumEvidence.observation_from.toLowerCase(),
        checksumEvidence.receipt_from.toLowerCase(),
      );
      assert.equal(
        checksumEvidence.observation_to.toLowerCase(),
        checksumEvidence.receipt_to.toLowerCase(),
      );
      assert.ok(
        checksumEvidence.observation_asset !== checksumEvidence.receipt_asset ||
          checksumEvidence.observation_from !== checksumEvidence.receipt_from ||
          checksumEvidence.observation_to !== checksumEvidence.receipt_to,
        "fixture must exercise checksum receipt against normalized EVM evidence",
      );
      assert.equal(
        await linkFundingReceiveReceiptOperationInTransaction(client, {
          receiptId: unchangedOwnedRelay.receiptId,
          userId: unchangedOwnedRelay.base.userId,
          childFundingOperationId: retryOperation.operation.id,
          authorizationId: unchangedOwnedRelay.authorizationId,
          authorizationFingerprint:
            unchangedOwnedRelay.authorizationFingerprint,
          telegramFundingConsentId: unchangedOwnedRelay.consentId,
          telegramFundingConsentFingerprint:
            unchangedOwnedRelay.consentFingerprint,
          serverExecutionProfileId: TELEGRAM_RELAY_EVM_FUNDING_PROFILE_ID,
          now: retryNow,
        }),
        true,
      );
      const retryReservations = await client.query<{
        funding_operation_id: string;
        status: string;
      }>(
        `select funding_operation_id, status
           from telegram_funding_authorization_reservations
          where receive_receipt_id = $1::uuid
          order by reserved_at, id`,
        [unchangedOwnedRelay.receiptId],
      );
      assert.deepEqual(retryReservations.rows, [
        {
          funding_operation_id: unchangedOwnedRelay.operationId,
          status: "cleaned",
        },
        {
          funding_operation_id: retryOperation.operation.id,
          status: "reserved",
        },
      ]);
      const reallocatedSourceCredit = await client.query<{
        history_length: number;
        operation_id: string;
      }>(
        `select operation_id,
                jsonb_array_length(
                  metadata -> 'receiveReceiptAllocationHistory'
                ) as history_length
           from funding_observations
          where metadata ->> 'receiptId' = $1`,
        [unchangedOwnedRelay.receiptId],
      );
      assert.deepEqual(reallocatedSourceCredit.rows[0], {
        history_length: 1,
        operation_id: retryOperation.operation.id,
      });
      throw new Error("rollback validated Relay receipt rearm generation");
    }),
    /rollback validated Relay receipt rearm generation/,
  );

  const foreignCleanupRelay = await createRelayFixture();
  const foreignCleanupBroadcasts = { value: 0 };
  await exhaustRelayDeposit(
    foreignCleanupRelay,
    foreignCleanupBroadcasts,
    "105",
  );
  const foreignCleanupClaim = await relayExecutor(
    [
      relayAllowanceEvidence("2000000", "105", "105"),
      relayAllowanceEvidence("2000000", "106", "105"),
    ],
    () => {
      foreignCleanupBroadcasts.value += 1;
    },
  ).runBatch({ limit: 1, now: new Date(now.getTime() + 15 * 60_000 + 5) });
  assert.equal(foreignCleanupClaim.submitted, 1);
  const foreignCleanupScope = await pool.query<{
    attempt_id: string;
    cleanup_operation_id: string;
    cleanup_step_id: string;
  }>(
    `select cleanup.id as cleanup_operation_id,
            cleanup_step.id as cleanup_step_id,
            cleanup_attempt.id as attempt_id
       from telegram_funding_authorization_reservations reservation
       join funding_operations cleanup
         on cleanup.id = reservation.cleanup_operation_id
       join funding_operation_steps cleanup_step
         on cleanup_step.operation_id = cleanup.id
       join funding_operation_step_attempts cleanup_attempt
         on cleanup_attempt.step_id = cleanup_step.id
      where reservation.funding_operation_id = $1::uuid
      order by cleanup_attempt.attempt_number desc
      limit 1`,
    [foreignCleanupRelay.operationId],
  );
  const foreignCleanup = foreignCleanupScope.rows[0];
  assert.ok(foreignCleanup);
  const foreignCleanupFinalizedAt = new Date(now.getTime() + 20 * 60_000);
  const foreignCleanupReceiptTransactionHash = `0x${"78".repeat(32)}`;
  await tx(pool, (client) =>
    applyFundingStepReceiptEvidenceInTransaction(client, {
      operationId: foreignCleanup.cleanup_operation_id,
      stepId: foreignCleanup.cleanup_step_id,
      attemptId: foreignCleanup.attempt_id,
      networkId: "evm:8453",
      receipt: {
        status: "finalized",
        actionMatch: true,
        ledgerHeight: "201",
        blockHash: `0x${"79".repeat(32)}`,
        canonical: true,
        failureCode: null,
        evidence: {
          singleOperationBundle: true,
          transactionHash: foreignCleanupReceiptTransactionHash,
        },
      },
      now: foreignCleanupFinalizedAt,
    }),
  );
  const foreignCleanupMaturity = await relayExecutor(
    [
      relayAllowanceEvidence(
        "0",
        "107",
        "foreign-cleanup-zero",
        `0x${"99".repeat(32)}`,
      ),
    ],
    () => {
      throw new Error("a finalized cleanup with foreign later mutation sent");
    },
  ).runBatch({
    limit: 20,
    now: new Date(
      foreignCleanupFinalizedAt.getTime() + RELAY_CLEANUP_CANONICAL_WATCH_MS,
    ),
  });
  assert.equal(foreignCleanupMaturity.claimed, 0);
  const foreignCleanupState = await pool.query<{
    cleanup_status: string;
    ownership_rejected: boolean;
    parent_status: string;
    reservation_status: string;
  }>(
    `select cleanup.status as cleanup_status,
            parent.status as parent_status,
            reservation.status as reservation_status,
            coalesce(
              cleanup_receipt.evidence ->> 'allowanceOwnershipRejected' =
                'true',
              false
            ) as ownership_rejected
       from telegram_funding_authorization_reservations reservation
       join funding_operations cleanup
         on cleanup.id = reservation.cleanup_operation_id
       join funding_operations parent
         on parent.id = reservation.funding_operation_id
       join funding_operation_steps cleanup_step
         on cleanup_step.operation_id = cleanup.id
       join funding_step_receipt_observations cleanup_receipt
         on cleanup_receipt.step_id = cleanup_step.id
      where reservation.funding_operation_id = $1::uuid`,
    [foreignCleanupRelay.operationId],
  );
  assert.deepEqual(foreignCleanupState.rows[0], {
    cleanup_status: "recovery_required",
    ownership_rejected: true,
    parent_status: "recovery_required",
    reservation_status: "cleanup_required",
  });
  const firstCapGeneration = await createRelayFixture("6000000");
  await pool.query(
    `update telegram_funding_authorizations
        set revoked_at = $2
      where id = $1 and revoked_at is null`,
    [firstCapGeneration.authorizationId, new Date(now.getTime() + 1)],
  );
  const rejectedNextGeneration = await createRelayFixture("5000000", {
    base: firstCapGeneration.base,
    expectCapReservation: false,
  });
  assert.notEqual(
    rejectedNextGeneration.authorizationId,
    firstCapGeneration.authorizationId,
  );
  const crossGenerationReservations = await pool.query<{ total_raw: string }>(
    `select coalesce(sum(reservation.source_raw), 0)::text as total_raw
       from telegram_funding_authorization_reservations reservation
       join telegram_funding_authorizations authority
         on authority.id = reservation.authorization_id
      where authority.user_id = $1
        and lower(authority.wallet_address) = lower($2)
        and authority.profile_id = $3
        and reservation.status <> 'released'`,
    [
      firstCapGeneration.base.userId,
      firstCapGeneration.walletAddress,
      TELEGRAM_RELAY_EVM_FUNDING_PROFILE_ID,
    ],
  );
  assert.equal(
    crossGenerationReservations.rows[0]?.total_raw,
    "6000000",
    "regranting the same wallet/profile must not reset its rolling cap",
  );

  const cursorReservation = await createRelayFixture();
  const firstCursor = await pool.query(
    `update telegram_funding_authorization_reservations
        set refund_cursor_block = 120, updated_at = $2
      where funding_operation_id = $1
      returning id`,
    [cursorReservation.operationId, now],
  );
  assert.equal(firstCursor.rowCount, 1);
  const laterCursor = await pool.query(
    `update telegram_funding_authorization_reservations
        set refund_cursor_block = 121, updated_at = $2
      where funding_operation_id = $1
      returning id`,
    [cursorReservation.operationId, new Date(now.getTime() + 1)],
  );
  assert.equal(laterCursor.rowCount, 1);
  const regressedCursor = await pool.query(
    `update telegram_funding_authorization_reservations
        set refund_cursor_block = 119, updated_at = $2
      where funding_operation_id = $1
      returning id`,
    [cursorReservation.operationId, new Date(now.getTime() + 2)],
  );
  assert.equal(regressedCursor.rowCount, 0);

  const highBlockRefundRelay = await createRelayFixture();
  const highBlockRefundTransactionHash = `0x${"80".repeat(32)}`;
  const highBlockRefundHash = `0x${"8f".repeat(32)}`;
  const highBlockRefundPrepared = await prepareRelayRefundWatch(
    highBlockRefundRelay,
    {
      refundTransactionHash: highBlockRefundTransactionHash,
      refundBlockHash: highBlockRefundHash,
      referenceTransactionHashes: [highBlockRefundTransactionHash],
      sourceBlock: "10000",
      refundBlock: "12010",
    },
  );
  await pool.query(
    `update funding_operation_segments
        set support_metadata = support_metadata || jsonb_build_object(
              'relayStatusCategory', 'success_observed',
              'relayTransactionReferenceFingerprints', '[]'::jsonb,
              'providerUpdatedAt', 999
            )
      where id = $1::uuid`,
    [highBlockRefundPrepared.segmentId],
  );
  const highBlockRefundRanges: Array<readonly [bigint, bigint]> = [];
  const highBlockRefundObserver = new RelayOwnedRefundObserver(referenceCodec, {
    blockNumber: async () => 12011n,
    transferLogs: async (input) => {
      highBlockRefundRanges.push([input.fromBlock, input.toBlock]);
      return [
        {
          transactionHash: highBlockRefundTransactionHash,
          logIndex: 0,
          blockNumber: 12010n,
          blockHash: highBlockRefundHash,
          fromAddress: RELAY_DEPOSITORY_V2,
          toAddress: highBlockRefundRelay.walletAddress,
          rawAmount: 2_000_000n,
        },
      ];
    },
  });
  assert.deepEqual(
    await highBlockRefundObserver.pollOperation(
      pool,
      highBlockRefundRelay.operationId,
      new Date(now.getTime() + 500),
    ),
    { refundsPolled: 1, refundSatisfied: true },
  );
  assert.deepEqual(
    highBlockRefundRanges,
    [[10011n, 12010n]],
    "the bounded high-block scan must include the original refund block",
  );

  const replacementRefundRelay = await createRelayFixture();
  const originalRefundTransactionHash = `0x${"81".repeat(32)}`;
  const replacementRefundTransactionHash = `0x${"82".repeat(32)}`;
  const originalRefundBlockHash = `0x${"83".repeat(32)}`;
  const replacementRefundPrepared = await prepareRelayRefundWatch(
    replacementRefundRelay,
    {
      refundTransactionHash: originalRefundTransactionHash,
      refundBlockHash: originalRefundBlockHash,
      referenceTransactionHashes: [originalRefundTransactionHash],
    },
  );
  let replacementRefundLogs: readonly {
    transactionHash: string;
    logIndex: number;
    blockNumber: bigint;
    blockHash: string;
    fromAddress: string;
    toAddress: string;
    rawAmount: bigint;
  }[] = [];
  const replacementRefundScanStarts: bigint[] = [];
  const replacementRefundObserver = new RelayOwnedRefundObserver(
    referenceCodec,
    {
      blockNumber: async () => 123n,
      transferLogs: async (input) => {
        replacementRefundScanStarts.push(input.fromBlock);
        return replacementRefundLogs;
      },
    },
  );
  const refundReorgAt = new Date(
    replacementRefundPrepared.preparedAt.getTime() + 1_000,
  );
  const missingRefund = await replacementRefundObserver.pollOperation(
    pool,
    replacementRefundRelay.operationId,
    refundReorgAt,
  );
  assert.deepEqual(missingRefund, {
    refundsPolled: 1,
    refundSatisfied: false,
  });
  await pool.query(
    `update funding_operation_segments
        set support_metadata = support_metadata || jsonb_build_object(
              'relayTransactionReferenceFingerprints', $2::jsonb,
              'providerUpdatedAt', 2
            )
      where id = $1::uuid`,
    [
      replacementRefundPrepared.segmentId,
      JSON.stringify([
        referenceCodec.fingerprint(originalRefundTransactionHash),
        referenceCodec.fingerprint(replacementRefundTransactionHash),
      ]),
    ],
  );
  replacementRefundLogs = [
    {
      transactionHash: replacementRefundTransactionHash,
      logIndex: 0,
      // A fork may re-mine the replacement below the old refund height (120).
      // The terminal observer must use its bounded reorg lookback, not 119 as
      // an exclusive cursor that would make this canonical credit unreachable.
      blockNumber: 119n,
      blockHash: `0x${"84".repeat(32)}`,
      fromAddress: RELAY_DEPOSITORY_V2,
      toAddress: replacementRefundRelay.walletAddress,
      rawAmount: 2_000_000n,
    },
  ];
  const replacementRefund = await replacementRefundObserver.pollOperation(
    pool,
    replacementRefundRelay.operationId,
    new Date(refundReorgAt.getTime() + 1_000),
  );
  assert.equal(
    replacementRefundScanStarts.at(-1),
    110n,
    "terminal refund recovery must scan from immediately after source debit",
  );
  assert.deepEqual(replacementRefund, {
    refundsPolled: 1,
    refundSatisfied: true,
  });
  const replacementRefundState = await pool.query<{
    canonical: boolean;
    finality_status: string;
    reservation_status: string;
    status: string;
    tx_hash: string;
  }>(
    `select observation.tx_hash,
            observation.finality_status,
            observation.canonical,
            operation.status,
            reservation.status as reservation_status
       from funding_observations observation
       join funding_operations operation
         on operation.id = observation.operation_id
       join telegram_funding_authorization_reservations reservation
         on reservation.funding_operation_id = operation.id
      where observation.operation_id = $1::uuid
        and observation.kind = 'refund_credit'
      order by observation.created_at, observation.id`,
    [replacementRefundRelay.operationId],
  );
  assert.deepEqual(replacementRefundState.rows, [
    {
      canonical: false,
      finality_status: "reorged",
      reservation_status: "refunded",
      status: "refunded",
      tx_hash: originalRefundTransactionHash,
    },
    {
      canonical: true,
      finality_status: "finalized",
      reservation_status: "refunded",
      status: "refunded",
      tx_hash: replacementRefundTransactionHash,
    },
  ]);
  const replacementReduction = await reduceFundingOperation(pool, {
    operationId: replacementRefundRelay.operationId,
    now: new Date(refundReorgAt.getTime() + 2_500),
  });
  assert.equal(
    replacementReduction.reorgBlockedByTerminalState,
    false,
    "an exact canonical replacement refund must supersede the old refund reorg",
  );

  const scheduleReplacementIncident = async (dueAt: Date) => {
    await tx(pool, (client) =>
      wakeFundingReconciliationInTransaction(client, {
        operationId: replacementRefundRelay.operationId,
        dueAt,
        priority: 2000,
      }),
    );
  };
  let replacementBoundaryScans = 0;
  const pollReplacementBoundary = async (boundary: Date) => {
    await scheduleReplacementIncident(boundary);
    return runFundingReconciliationBatch(pool, {
      workerId: opaque(`replacement-refund-boundary-${boundary.getTime()}`),
      limit: 1,
      now: boundary,
      destinationPoll: async (operationId, observedAt) => {
        replacementBoundaryScans += 1;
        const observed = await replacementRefundObserver.pollOperation(
          pool,
          operationId,
          observedAt,
        );
        return {
          destinationsPolled: observed.refundsPolled,
          destinationSatisfied: observed.refundSatisfied,
        };
      },
    });
  };
  const canonicalReplacementBoundary = new Date(
    refundReorgAt.getTime() + 1_000 + 15 * 60_000,
  );
  const stableReplacement = await pollReplacementBoundary(
    canonicalReplacementBoundary,
  );
  assert.deepEqual(stableReplacement.operationIds, [
    replacementRefundRelay.operationId,
  ]);
  assert.deepEqual(
    {
      claimed: stableReplacement.claimed,
      completed: stableReplacement.completed,
      deadLettered: stableReplacement.deadLettered,
      requeued: stableReplacement.requeued,
    },
    { claimed: 1, completed: 1, deadLettered: 0, requeued: 0 },
    "a canonical replacement must complete reconciliation after its watch expires",
  );

  replacementRefundLogs = [];
  const replacementReorgAt = canonicalReplacementBoundary;
  assert.deepEqual(
    await replacementRefundObserver.pollOperation(
      pool,
      replacementRefundRelay.operationId,
      replacementReorgAt,
    ),
    { refundsPolled: 1, refundSatisfied: false },
  );
  const beforeLatestReorgBoundary = new Date(
    replacementReorgAt.getTime() + 15 * 60_000 - 1,
  );
  const beforeLatestReorgMatures = await pollReplacementBoundary(
    beforeLatestReorgBoundary,
  );
  assert.deepEqual(beforeLatestReorgMatures.operationIds, [
    replacementRefundRelay.operationId,
  ]);
  assert.deepEqual(
    {
      claimed: beforeLatestReorgMatures.claimed,
      deadLettered: beforeLatestReorgMatures.deadLettered,
      requeued: beforeLatestReorgMatures.requeued,
    },
    { claimed: 1, deadLettered: 0, requeued: 1 },
    "an older refund reorg must not expire a newer replacement-reorg window",
  );
  const latestReorgBoundary = new Date(
    replacementReorgAt.getTime() + 15 * 60_000,
  );
  const maturedReplacementIncident =
    await pollReplacementBoundary(latestReorgBoundary);
  assert.deepEqual(maturedReplacementIncident.operationIds, [
    replacementRefundRelay.operationId,
  ]);
  assert.deepEqual(
    {
      claimed: maturedReplacementIncident.claimed,
      deadLettered: maturedReplacementIncident.deadLettered,
      requeued: maturedReplacementIncident.requeued,
    },
    { claimed: 1, deadLettered: 1, requeued: 0 },
  );
  assert.equal(
    replacementBoundaryScans,
    3,
    "the exact 15-minute boundary must perform its final canonical scan before dead-lettering",
  );

  const unresolvedRefundRelay = await createRelayFixture();
  const unresolvedRefundPrepared = await prepareRelayRefundWatch(
    unresolvedRefundRelay,
    {
      refundTransactionHash: `0x${"8a".repeat(32)}`,
      refundBlockHash: `0x${"8b".repeat(32)}`,
      referenceTransactionHashes: [`0x${"8a".repeat(32)}`],
    },
  );
  const unresolvedRefundObserver = new RelayOwnedRefundObserver(
    referenceCodec,
    {
      blockNumber: async () => 123n,
      transferLogs: async () => [],
    },
  );
  const unresolvedReorgAt = new Date(
    unresolvedRefundPrepared.preparedAt.getTime() + 1_000,
  );
  await unresolvedRefundObserver.pollOperation(
    pool,
    unresolvedRefundRelay.operationId,
    unresolvedReorgAt,
  );
  await pool.query(
    `update funding_reconciliation_jobs
        set status = 'scheduled',
            due_at = $2,
            priority = 1000,
            lease_owner = null,
            lease_token = null,
            lease_until = null
      where operation_id = $1::uuid`,
    [
      unresolvedRefundRelay.operationId,
      new Date(unresolvedReorgAt.getTime() + 15 * 60_000),
    ],
  );
  const unresolvedRefundBatch = await runFundingReconciliationBatch(pool, {
    workerId: opaque("terminal-refund-incident-worker"),
    limit: 1,
    now: new Date(unresolvedReorgAt.getTime() + 15 * 60_000),
    destinationPoll: async (operationId, observedAt) => {
      const observed = await unresolvedRefundObserver.pollOperation(
        pool,
        operationId,
        observedAt,
      );
      return {
        destinationsPolled: observed.refundsPolled,
        destinationSatisfied: observed.refundSatisfied,
      };
    },
  });
  assert.deepEqual(
    {
      claimed: unresolvedRefundBatch.claimed,
      deadLettered: unresolvedRefundBatch.deadLettered,
      requeued: unresolvedRefundBatch.requeued,
    },
    { claimed: 1, deadLettered: 1, requeued: 0 },
  );
  const unresolvedRefundIncident = await pool.query<{
    error_code: string | null;
    last_error_code: string | null;
    job_status: string;
    operation_status: string;
  }>(
    `select operation.status as operation_status,
            operation.error_code,
            job.status as job_status,
            job.last_error_code
       from funding_operations operation
       join funding_reconciliation_jobs job
         on job.operation_id = operation.id
      where operation.id = $1::uuid`,
    [unresolvedRefundRelay.operationId],
  );
  assert.deepEqual(unresolvedRefundIncident.rows, [
    {
      error_code: "finalized_observation_reorg",
      job_status: "dead_letter",
      last_error_code: "terminal_refund_reorg_unresolved",
      operation_status: "refunded",
    },
  ]);

  const terminalReceiptReorgRelay = await createRelayFixture();
  const terminalReceiptPrepared = await prepareRelayRefundWatch(
    terminalReceiptReorgRelay,
    {
      refundTransactionHash: `0x${"8c".repeat(32)}`,
      refundBlockHash: `0x${"8d".repeat(32)}`,
      referenceTransactionHashes: [`0x${"8c".repeat(32)}`],
    },
  );
  for (const stepState of ["action_required", "submitted", "succeeded"]) {
    await pool.query(
      `update funding_operation_steps
          set state = $2,
              updated_at = $3
        where id = $1::uuid`,
      [
        terminalReceiptReorgRelay.depositStepId,
        stepState,
        terminalReceiptPrepared.preparedAt,
      ],
    );
  }
  const terminalReceiptAttempt = await pool.query<{ id: string }>(
    `insert into funding_operation_step_attempts (
       step_id, attempt_number, canonical_action_fingerprint, executor_id,
       outcome, broadcast_may_have_occurred, reference_kind,
       receipt_ref_ciphertext, receipt_ref_lookup_hmac, lookup_key_version,
       finished_at, started_at
     )
     select step.id, 1, step.action_fingerprint, step.executor_id,
            'submitted', true, 'transaction', 'cipher:terminal-reorg',
            repeat('8f', 32), 1, $2, $2
       from funding_operation_steps step
      where step.id = $1::uuid
     returning id`,
    [
      terminalReceiptReorgRelay.depositStepId,
      terminalReceiptPrepared.preparedAt,
    ],
  );
  const terminalReceiptAttemptId = terminalReceiptAttempt.rows[0]?.id;
  assert.ok(terminalReceiptAttemptId);
  const terminalReceiptBlockHash = `0x${"8e".repeat(32)}`;
  await pool.query(
    `insert into funding_step_receipt_observations (
       operation_id, step_id, attempt_id, network_id, status, action_match,
       ledger_height, block_hash, canonical, evidence, first_seen_at,
       observed_at, finalized_at
     ) values (
       $1::uuid, $2::uuid, $3::uuid, 'evm:8453', 'finalized', true,
       '120', $4, true, '{"terminalReceiptFixture":true}'::jsonb,
       $5, $5, $5
     )`,
    [
      terminalReceiptReorgRelay.operationId,
      terminalReceiptReorgRelay.depositStepId,
      terminalReceiptAttemptId,
      terminalReceiptBlockHash,
      terminalReceiptPrepared.preparedAt,
    ],
  );
  await pool.query(
    `update funding_observations
        set metadata = metadata || jsonb_build_object(
              'receiptAttemptId', $2::text
            )
      where operation_id = $1::uuid
        and kind = 'source_debit'`,
    [terminalReceiptReorgRelay.operationId, terminalReceiptAttemptId],
  );
  const terminalReceiptReorgAt = new Date(
    terminalReceiptPrepared.preparedAt.getTime() + 1_000,
  );
  await tx(pool, (client) =>
    applyFundingStepReceiptEvidenceInTransaction(client, {
      operationId: terminalReceiptReorgRelay.operationId,
      stepId: terminalReceiptReorgRelay.depositStepId,
      attemptId: terminalReceiptAttemptId,
      networkId: "evm:8453",
      receipt: {
        status: "reorged",
        actionMatch: true,
        ledgerHeight: "120",
        blockHash: terminalReceiptBlockHash,
        canonical: false,
        failureCode: "receipt_block_not_canonical",
        evidence: { terminalReceiptFixture: true },
      },
      now: terminalReceiptReorgAt,
    }),
  );
  const terminalReceiptReorgEvidence = await pool.query<{
    finality_status: string;
    receipt_status: string;
  }>(
    `select source_debit.finality_status,
            receipt.status as receipt_status
       from funding_observations source_debit
       join funding_step_receipt_observations receipt
         on receipt.attempt_id = $2::uuid
      where source_debit.operation_id = $1::uuid
        and source_debit.kind = 'source_debit'`,
    [terminalReceiptReorgRelay.operationId, terminalReceiptAttemptId],
  );
  assert.deepEqual(terminalReceiptReorgEvidence.rows, [
    { finality_status: "reorged", receipt_status: "reorged" },
  ]);
  const terminalReceiptBeforeIncidentAt = new Date(
    terminalReceiptReorgAt.getTime() + 15 * 60_000 - 1,
  );
  await tx(pool, (client) =>
    wakeFundingReconciliationInTransaction(client, {
      operationId: terminalReceiptReorgRelay.operationId,
      dueAt: terminalReceiptBeforeIncidentAt,
      priority: 3000,
    }),
  );
  const terminalReceiptBeforeIncident = await runFundingReconciliationBatch(
    pool,
    {
      workerId: opaque("terminal-relay-receipt-before-incident-worker"),
      limit: 1,
      now: terminalReceiptBeforeIncidentAt,
      receiptPoll: async () => {
        throw new Error("reorg receipt RPC temporarily unavailable");
      },
      destinationPoll: async () => ({
        destinationsPolled: 1,
        destinationSatisfied: false,
      }),
    },
  );
  assert.deepEqual(
    {
      deadLettered: terminalReceiptBeforeIncident.deadLettered,
      requeued: terminalReceiptBeforeIncident.requeued,
    },
    { deadLettered: 0, requeued: 1 },
    "a reorg plus receipt RPC outage remains recoverable inside the watch",
  );
  const terminalReceiptIncidentAt = new Date(
    terminalReceiptReorgAt.getTime() + 15 * 60_000,
  );
  await tx(pool, (client) =>
    wakeFundingReconciliationInTransaction(client, {
      operationId: terminalReceiptReorgRelay.operationId,
      dueAt: terminalReceiptIncidentAt,
      priority: 3000,
    }),
  );
  let terminalReceiptDestinationScans = 0;
  const terminalReceiptIncident = await runFundingReconciliationBatch(pool, {
    workerId: opaque("terminal-relay-receipt-incident-worker"),
    limit: 1,
    now: terminalReceiptIncidentAt,
    receiptPoll: async () => {
      throw new Error("reorg receipt RPC remains unavailable");
    },
    destinationPoll: async () => {
      terminalReceiptDestinationScans += 1;
      return { destinationsPolled: 1, destinationSatisfied: false };
    },
  });
  assert.deepEqual(terminalReceiptIncident.operationIds, [
    terminalReceiptReorgRelay.operationId,
  ]);
  const terminalReceiptIncidentState = await pool.query<{
    job_error_code: string | null;
    job_error_summary: string | null;
    job_status: string;
    operation_status: string;
  }>(
    `select operation.status as operation_status,
            job.status as job_status,
            job.last_error_code as job_error_code,
            job.last_error_summary as job_error_summary
       from funding_operations operation
       join funding_reconciliation_jobs job
         on job.operation_id = operation.id
      where operation.id = $1::uuid`,
    [terminalReceiptReorgRelay.operationId],
  );
  assert.deepEqual(
    {
      completed: terminalReceiptIncident.completed,
      deadLettered: terminalReceiptIncident.deadLettered,
      failed: terminalReceiptIncident.failed,
      requeued: terminalReceiptIncident.requeued,
      scans: terminalReceiptDestinationScans,
      state: terminalReceiptIncidentState.rows,
    },
    {
      completed: 0,
      deadLettered: 1,
      failed: 0,
      requeued: 0,
      scans: 1,
      state: terminalReceiptIncidentState.rows,
    },
  );
  assert.deepEqual(terminalReceiptIncidentState.rows, [
    {
      job_error_code: "terminal_relay_evidence_reorg_unresolved",
      job_error_summary:
        "terminal Relay receipt reorg remained unresolved after its canonical watch window",
      job_status: "dead_letter",
      operation_status: "refunded",
    },
  ]);

  const terminalReceiptVerificationRelay = await createRelayFixture();
  const terminalReceiptVerificationPrepared = await prepareRelayRefundWatch(
    terminalReceiptVerificationRelay,
    {
      refundTransactionHash: `0x${"90".repeat(32)}`,
      refundBlockHash: `0x${"91".repeat(32)}`,
      referenceTransactionHashes: [`0x${"90".repeat(32)}`],
    },
  );
  for (const stepState of ["action_required", "submitted", "succeeded"]) {
    await pool.query(
      `update funding_operation_steps
          set state = $2,
              updated_at = $3
        where id = $1::uuid`,
      [
        terminalReceiptVerificationRelay.depositStepId,
        stepState,
        terminalReceiptVerificationPrepared.preparedAt,
      ],
    );
  }
  const terminalReceiptVerificationAttempt = await pool.query<{ id: string }>(
    `insert into funding_operation_step_attempts (
       step_id, attempt_number, canonical_action_fingerprint, executor_id,
       outcome, broadcast_may_have_occurred, reference_kind,
       receipt_ref_ciphertext, receipt_ref_lookup_hmac, lookup_key_version,
       finished_at, started_at
     )
     select step.id, 1, step.action_fingerprint, step.executor_id,
            'submitted', true, 'transaction', 'cipher:terminal-verification',
            repeat('92', 32), 1, $2, $2
       from funding_operation_steps step
      where step.id = $1::uuid
     returning id`,
    [
      terminalReceiptVerificationRelay.depositStepId,
      terminalReceiptVerificationPrepared.preparedAt,
    ],
  );
  const terminalReceiptVerificationFreshAttempt = await pool.query<{
    id: string;
  }>(
    `insert into funding_operation_step_attempts (
       step_id, attempt_number, canonical_action_fingerprint, executor_id,
       outcome, broadcast_may_have_occurred, reference_kind,
       receipt_ref_ciphertext, receipt_ref_lookup_hmac, lookup_key_version,
       finished_at, started_at
     )
     select step.id, 2, step.action_fingerprint, step.executor_id,
            'submitted', true, 'transaction', 'cipher:terminal-verification-fresh',
            repeat('94', 32), 1, $2, $2
       from funding_operation_steps step
      where step.id = $1::uuid
     returning id`,
    [
      terminalReceiptVerificationRelay.approvalStepId,
      new Date(
        terminalReceiptVerificationPrepared.preparedAt.getTime() + 5 * 60_000,
      ),
    ],
  );
  const terminalReceiptVerificationFreshAttemptId =
    terminalReceiptVerificationFreshAttempt.rows[0]?.id;
  assert.ok(terminalReceiptVerificationFreshAttemptId);
  await pool.query(
    `insert into funding_step_receipt_observations (
       operation_id, step_id, attempt_id, network_id, status, action_match,
       ledger_height, block_hash, canonical, evidence, first_seen_at,
       observed_at, finalized_at
     ) values (
       $1::uuid, $2::uuid, $3::uuid, 'evm:8453', 'finalized', true,
       '121', $4, true, '{"terminalReceiptVerificationFreshFixture":true}'::jsonb,
       $5, $5, $5
     )`,
    [
      terminalReceiptVerificationRelay.operationId,
      terminalReceiptVerificationRelay.approvalStepId,
      terminalReceiptVerificationFreshAttemptId,
      `0x${"95".repeat(32)}`,
      new Date(
        terminalReceiptVerificationPrepared.preparedAt.getTime() + 5 * 60_000,
      ),
    ],
  );
  const terminalReceiptVerificationAttemptId =
    terminalReceiptVerificationAttempt.rows[0]?.id;
  assert.ok(terminalReceiptVerificationAttemptId);
  await pool.query(
    `insert into funding_step_receipt_observations (
       operation_id, step_id, attempt_id, network_id, status, action_match,
       ledger_height, block_hash, canonical, evidence, first_seen_at,
       observed_at, finalized_at
     ) values (
       $1::uuid, $2::uuid, $3::uuid, 'evm:8453', 'finalized', true,
       '120', $4, true, '{"terminalReceiptVerificationFixture":true}'::jsonb,
       $5, $5, $5
     )`,
    [
      terminalReceiptVerificationRelay.operationId,
      terminalReceiptVerificationRelay.depositStepId,
      terminalReceiptVerificationAttemptId,
      `0x${"93".repeat(32)}`,
      terminalReceiptVerificationPrepared.preparedAt,
    ],
  );
  await tx(pool, (client) =>
    wakeFundingReconciliationInTransaction(client, {
      operationId: terminalReceiptVerificationRelay.operationId,
      dueAt: new Date(
        terminalReceiptVerificationPrepared.preparedAt.getTime() + 15 * 60_000,
      ),
      priority: 4000,
    }),
  );
  const terminalReceiptVerification = await runFundingReconciliationBatch(
    pool,
    {
      workerId: opaque("terminal-relay-receipt-verification-worker"),
      limit: 1,
      now: new Date(
        terminalReceiptVerificationPrepared.preparedAt.getTime() + 15 * 60_000,
      ),
      receiptPoll: async () => {
        throw new Error("Base receipt RPC temporarily unavailable");
      },
      destinationPoll: async () => ({
        destinationsPolled: 1,
        destinationSatisfied: true,
      }),
    },
  );
  assert.deepEqual(terminalReceiptVerification.operationIds, [
    terminalReceiptVerificationRelay.operationId,
  ]);
  assert.deepEqual(
    {
      completed: terminalReceiptVerification.completed,
      deadLettered: terminalReceiptVerification.deadLettered,
      failed: terminalReceiptVerification.failed,
      requeued: terminalReceiptVerification.requeued,
    },
    { completed: 0, deadLettered: 0, failed: 0, requeued: 1 },
    "a fresh staggered receipt must keep unavailable verification recoverable",
  );
  const terminalReceiptVerificationExpired =
    await runFundingReconciliationBatch(pool, {
      workerId: opaque("terminal-relay-receipt-expired-worker"),
      limit: 1,
      now: new Date(
        terminalReceiptVerificationPrepared.preparedAt.getTime() + 20 * 60_000,
      ),
      receiptPoll: async () => {
        throw new Error("Base receipt RPC still unavailable");
      },
      destinationPoll: async () => ({
        destinationsPolled: 1,
        destinationSatisfied: true,
      }),
    });
  assert.deepEqual(
    {
      completed: terminalReceiptVerificationExpired.completed,
      deadLettered: terminalReceiptVerificationExpired.deadLettered,
      failed: terminalReceiptVerificationExpired.failed,
      requeued: terminalReceiptVerificationExpired.requeued,
    },
    { completed: 0, deadLettered: 1, failed: 0, requeued: 0 },
    "verification becomes a bounded incident only after every receipt window expires",
  );

  const completedReceiptVerificationRelay = await createRelayFixture();
  const completedReceiptVerificationAt = new Date();
  await tx(pool, async (client) => {
    const current = await client.query<{
      progress_stage: "committed";
      status: "in_progress";
      version: string | number;
    }>(
      `select status, progress_stage, version
         from funding_operations
        where id = $1::uuid
        for update`,
      [completedReceiptVerificationRelay.operationId],
    );
    const operation = current.rows[0];
    assert.ok(operation);
    const activated = await transitionFundingOperationInTransaction(client, {
      operationId: completedReceiptVerificationRelay.operationId,
      scope: { kind: "worker" },
      expectedVersion: Number(operation.version),
      expectedState: {
        status: operation.status,
        stage: operation.progress_stage,
      },
      nextState: { status: "in_progress", stage: "source_action" },
      now: completedReceiptVerificationAt,
    });
    await transitionFundingOperationInTransaction(client, {
      operationId: completedReceiptVerificationRelay.operationId,
      scope: { kind: "worker" },
      expectedVersion: activated.version,
      expectedState: { status: "in_progress", stage: "source_action" },
      nextState: { status: "completed", stage: "terminal" },
      now: completedReceiptVerificationAt,
    });
  });
  for (const stepState of ["action_required", "submitted", "succeeded"]) {
    await pool.query(
      `update funding_operation_steps
          set state = $2, updated_at = $3
        where id = $1::uuid`,
      [
        completedReceiptVerificationRelay.depositStepId,
        stepState,
        completedReceiptVerificationAt,
      ],
    );
  }
  const completedReceiptVerificationAttempt = await pool.query<{ id: string }>(
    `insert into funding_operation_step_attempts (
       step_id, attempt_number, canonical_action_fingerprint, executor_id,
       outcome, broadcast_may_have_occurred, reference_kind,
       receipt_ref_ciphertext, receipt_ref_lookup_hmac, lookup_key_version,
       finished_at, started_at
     )
     select step.id, 1, step.action_fingerprint, step.executor_id,
            'submitted', true, 'transaction', 'cipher:completed-verification',
            repeat('96', 32), 1, $2, $2
       from funding_operation_steps step
      where step.id = $1::uuid
     returning id`,
    [
      completedReceiptVerificationRelay.depositStepId,
      completedReceiptVerificationAt,
    ],
  );
  const completedReceiptVerificationAttemptId =
    completedReceiptVerificationAttempt.rows[0]?.id;
  assert.ok(completedReceiptVerificationAttemptId);
  await pool.query(
    `insert into funding_step_receipt_observations (
       operation_id, step_id, attempt_id, network_id, status, action_match,
       ledger_height, block_hash, canonical, evidence, first_seen_at,
       observed_at, finalized_at
     ) values (
       $1::uuid, $2::uuid, $3::uuid, 'evm:8453', 'finalized', true,
       '122', $4, true, '{"completedReceiptVerificationFixture":true}'::jsonb,
       $5, $5, $5
     )`,
    [
      completedReceiptVerificationRelay.operationId,
      completedReceiptVerificationRelay.depositStepId,
      completedReceiptVerificationAttemptId,
      `0x${"97".repeat(32)}`,
      completedReceiptVerificationAt,
    ],
  );
  await tx(pool, (client) =>
    wakeFundingReconciliationInTransaction(client, {
      operationId: completedReceiptVerificationRelay.operationId,
      dueAt: new Date(completedReceiptVerificationAt.getTime() + 10 * 60_000),
      priority: 4000,
    }),
  );
  const completedReceiptVerificationRetry = await runFundingReconciliationBatch(
    pool,
    {
      workerId: opaque("completed-relay-receipt-retry-worker"),
      limit: 1,
      now: new Date(completedReceiptVerificationAt.getTime() + 10 * 60_000),
      receiptPoll: async () => {
        throw new Error("completed receipt RPC temporarily unavailable");
      },
    },
  );
  assert.deepEqual(
    {
      deadLettered: completedReceiptVerificationRetry.deadLettered,
      requeued: completedReceiptVerificationRetry.requeued,
    },
    { deadLettered: 0, requeued: 1 },
  );
  const completedReceiptVerificationIncident =
    await runFundingReconciliationBatch(pool, {
      workerId: opaque("completed-relay-receipt-incident-worker"),
      limit: 1,
      now: new Date(completedReceiptVerificationAt.getTime() + 15 * 60_000),
      receiptPoll: async () => {
        throw new Error("completed receipt RPC still unavailable");
      },
    });
  assert.deepEqual(
    {
      deadLettered: completedReceiptVerificationIncident.deadLettered,
      requeued: completedReceiptVerificationIncident.requeued,
    },
    { deadLettered: 1, requeued: 0 },
    "completed Relay receipt verification must terminate as a bounded incident",
  );

  const reminedRefundRelay = await createRelayFixture();
  const reminedRefundTransactionHash = `0x${"85".repeat(32)}`;
  const reminedOriginalBlockHash = `0x${"86".repeat(32)}`;
  const reminedRefundPrepared = await prepareRelayRefundWatch(
    reminedRefundRelay,
    {
      refundTransactionHash: reminedRefundTransactionHash,
      refundBlockHash: reminedOriginalBlockHash,
      referenceTransactionHashes: [reminedRefundTransactionHash],
    },
  );
  let reminedRefundLogs: typeof replacementRefundLogs = [];
  const reminedRefundObserver = new RelayOwnedRefundObserver(referenceCodec, {
    blockNumber: async () => 123n,
    transferLogs: async () => reminedRefundLogs,
  });
  const reminedReorgAt = new Date(
    reminedRefundPrepared.preparedAt.getTime() + 1_000,
  );
  await reminedRefundObserver.pollOperation(
    pool,
    reminedRefundRelay.operationId,
    reminedReorgAt,
  );
  const reminedBlockHash = `0x${"87".repeat(32)}`;
  reminedRefundLogs = [
    {
      transactionHash: reminedRefundTransactionHash,
      logIndex: 0,
      blockNumber: 121n,
      blockHash: reminedBlockHash,
      fromAddress: RELAY_DEPOSITORY_V2,
      toAddress: reminedRefundRelay.walletAddress,
      rawAmount: 2_000_000n,
    },
  ];
  const reminedRefund = await reminedRefundObserver.pollOperation(
    pool,
    reminedRefundRelay.operationId,
    new Date(reminedReorgAt.getTime() + 1_000),
  );
  assert.deepEqual(reminedRefund, {
    refundsPolled: 1,
    refundSatisfied: true,
  });
  const reminedRefundState = await pool.query<{
    block_hash: string;
    canonical: boolean;
    finality_status: string;
    history: unknown;
  }>(
    `select block_hash,
            canonical,
            finality_status,
            metadata -> 'relayRefundCanonicalityHistory' as history
       from funding_observations
      where operation_id = $1::uuid
        and kind = 'refund_credit'`,
    [reminedRefundRelay.operationId],
  );
  assert.equal(reminedRefundState.rows.length, 1);
  assert.equal(reminedRefundState.rows[0]?.block_hash, reminedBlockHash);
  assert.equal(reminedRefundState.rows[0]?.canonical, true);
  assert.equal(reminedRefundState.rows[0]?.finality_status, "finalized");
  assert.ok(Array.isArray(reminedRefundState.rows[0]?.history));

  console.log(
    "[funding-delegated-execution-integration-tests] full-receipt concurrency, malformed action, soft pause/desired-state resume, lifecycle locking, pre-broadcast revocation, and ambiguous recovery passed",
  );
} catch (error) {
  testFailure = error;
} finally {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local session_replication_role = replica");
    await client.query(
      `set local hunch.telegram_funding_retention_cleanup = 'on'`,
    );
    if (tradeOriginIntentIds.length > 0) {
      await client.query(
        `delete from telegram_trade_intents where id = any($1::uuid[])`,
        [tradeOriginIntentIds],
      );
    }
    if (relayArtifactOperationIds.length > 0) {
      const relayOperations = await client.query<{ id: string }>(
        `select id from funding_operations
          where id = any($1::uuid[])
         union
         select cleanup_operation_id
           from telegram_funding_authorization_reservations
          where funding_operation_id = any($1::uuid[])
            and cleanup_operation_id is not null`,
        [relayArtifactOperationIds],
      );
      const operationIds = relayOperations.rows.map((row) => row.id);
      await client.query(
        `delete from funding_step_receipt_observations
          where step_id in (
            select id from funding_operation_steps
             where operation_id = any($1::uuid[])
          )`,
        [operationIds],
      );
      await client.query(
        `delete from funding_operation_step_attempts
          where step_id in (
            select id from funding_operation_steps
             where operation_id = any($1::uuid[])
          )`,
        [operationIds],
      );
      await client.query(
        `delete from funding_reconciliation_jobs
          where operation_id = any($1::uuid[])`,
        [operationIds],
      );
      await client.query(
        `delete from funding_observations
          where operation_id = any($1::uuid[])`,
        [operationIds],
      );
      await client.query(
        `delete from telegram_funding_authorization_reservations
          where funding_operation_id = any($1::uuid[])`,
        [relayArtifactOperationIds],
      );
      await client.query(
        `delete from funding_operation_steps
          where operation_id = any($1::uuid[])`,
        [operationIds],
      );
      await client.query(
        `delete from funding_operations where id = any($1::uuid[])`,
        [operationIds],
      );
    }
    if (relayArtifactQuoteIds.length > 0) {
      await client.query(
        `delete from funding_quotes where id = any($1::uuid[])`,
        [relayArtifactQuoteIds],
      );
    }
    if (relayArtifactReceiptIds.length > 0) {
      await client.query(
        `delete from funding_receive_receipts where id = any($1::uuid[])`,
        [relayArtifactReceiptIds],
      );
    }
    if (extraAuthorizationIds.length > 0) {
      await client.query(
        `delete from telegram_funding_authorizations
          where id = any($1::uuid[])`,
        [extraAuthorizationIds],
      );
    }
    for (const fixture of [...fixtures].reverse()) {
      await client.query(
        `delete from funding_operation_step_attempts
         where step_id in (
           select id from funding_operation_steps where operation_id = $1
         )`,
        [fixture.operationId],
      );
      await client.query(
        `delete from funding_reconciliation_jobs where operation_id = $1`,
        [fixture.operationId],
      );
      await client.query(
        `delete from funding_observations where operation_id = $1`,
        [fixture.operationId],
      );
      await client.query(
        `delete from funding_receive_canonical_events
         where allocated_receipt_id = any($1::uuid[])`,
        [fixture.receiptIds],
      );
      await client.query(
        `delete from funding_receive_receipts where id = any($1::uuid[])`,
        [fixture.receiptIds],
      );
      await client.query(
        `delete from telegram_bot_action_outbox
         where funding_session_id = $1`,
        [fixture.telegramFundingSessionId],
      );
      await client.query(
        `delete from funding_operation_steps where operation_id = $1`,
        [fixture.operationId],
      );
      await client.query(`delete from funding_operations where id = $1`, [
        fixture.operationId,
      ]);
      await client.query(`delete from funding_quotes where id = $1`, [
        fixture.quoteId,
      ]);
      await client.query(
        `delete from telegram_funding_consents
         where telegram_funding_session_id = $1`,
        [fixture.telegramFundingSessionId],
      );
      await client.query(
        `delete from telegram_funding_sessions where id = $1`,
        [fixture.telegramFundingSessionId],
      );
      await client.query(`delete from funding_receive_sessions where id = $1`, [
        fixture.receiveSessionId,
      ]);
      await client.query(
        `delete from telegram_funding_authorizations where id = $1`,
        [fixture.authorizationId],
      );
      await client.query(`delete from user_wallets where id = $1`, [
        fixture.userWalletId,
      ]);
      await client.query(`delete from user_telegram_accounts where id = $1`, [
        fixture.telegramAccountId,
      ]);
      await client.query(
        `delete from telegram_bot_trading_preferences where user_id = $1`,
        [fixture.userId],
      );
      await client.query(`delete from users where id = $1`, [fixture.userId]);
    }
    for (const policyId of policyIds) {
      await client.query(`delete from runtime_policies where id = $1`, [
        policyId,
      ]);
    }
    if (tradeOriginMarketIds.length > 0) {
      await client.query(
        `delete from unified_markets where id = any($1::text[])`,
        [tradeOriginMarketIds],
      );
    }
    if (tradeOriginEventIds.length > 0) {
      await client.query(
        `delete from unified_events where id = any($1::text[])`,
        [tradeOriginEventIds],
      );
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    testFailure ??= error;
  } finally {
    client.release();
  }
}

if (testFailure) throw testFailure;
