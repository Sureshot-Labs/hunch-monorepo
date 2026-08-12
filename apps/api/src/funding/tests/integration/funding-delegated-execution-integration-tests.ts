#!/usr/bin/env tsx

// @requires-db

import assert from "node:assert/strict";
import crypto from "node:crypto";

import { POLYMARKET_FUNDING_ROUTER } from "@hunch/contracts";
import { tx, type PoolClient } from "@hunch/infra";
import { Interface } from "ethers";

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
} from "../../execution/delegated-funding-executor.js";
import type { PolymarketWrapExecutionConfiguration } from "../../execution/delegated-funding-config.js";
import { lockTelegramFundingLinkLifecycle } from "../../execution/telegram-funding-link-lifecycle-lock.js";
import {
  POLYMARKET_DEPOSIT_USDCE_WRAP_PROFILE_ID,
  validatePolymarketDepositUsdceWrapAction,
} from "../../execution/delegated-funding-profiles.js";
import {
  ensureTelegramFundingAuthorization,
  grantTelegramFundingAuthorization,
  revokeTelegramFundingAuthorization,
  telegramFundingAuthorizationFingerprint,
} from "../../execution/telegram-funding-authorization.js";
import {
  buildTelegramFundingAutomationPolicyV2,
  telegramFundingAutomationPolicyJson,
} from "../../execution/telegram-funding-automation-policy.js";
import { resolveTelegramPolymarketWrapCapability } from "../../execution/delegated-funding-capability-resolver.js";
import type { FundingTransactionReferenceCodec } from "../../execution/transaction-reference-codec.js";
import {
  commitFundingOperation,
  commitFundingOperationInTransaction,
  createFundingQuote,
  FundingPersistenceError,
  type FundingCommitPlan,
} from "../../persistence/funding-operation-repository.js";
import {
  claimFundingReceiveCanonicalEventAllocation,
  claimFundingReceiveReceiptOperationLinkInTransaction,
  createOrReuseFundingReceiveSession,
  deferFundingReceiveReceiptRouting,
  finalizeFundingReceiveCanonicalEventAllocation,
  insertFundingReceiveReceipt,
  listFundingReceiveRoutingReceiptIdsAfterBroadcastBoundary,
  listFundingReceiveReceiptsForRouting,
  linkFundingReceiveReceiptOperationInTransaction,
} from "../../persistence/funding-receive-session-repository.js";
import { canonicalJsonHash } from "../../persistence/canonical.js";
import {
  lockFundingPolicyForTransaction,
  resolveFundingPolicy,
} from "../../policies/funding-policy-service.js";
import { fundingSidecarRuntimeConfig } from "../../runtime/sidecar-runtime-config.js";
import { FundingReceiveReceiptRouter } from "../../receive/receive-receipt-router.js";
import { reduceFundingOperation } from "../../reconciliation/funding-reducer.js";
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
const referenceCodec: FundingTransactionReferenceCodec = {
  keyVersion: 1,
  encrypt: (value) => `cipher:${value}`,
  decrypt: (value) => value.replace(/^cipher:/u, ""),
  fingerprint: (value) =>
    crypto.createHash("sha256").update(`reference:${value}`).digest("hex"),
};
const fundInterface = new Interface([
  "function fund(uint256 expectedNonce,uint256 totalAmount,uint256 pUsdAmount)",
]);

type JsonRecord = Readonly<Record<string, JsonValue>>;

type Fixture = Readonly<{
  actionWalletId: string;
  authorizationId: string;
  consentFingerprint: string;
  consentId: string;
  operationId: string;
  privyWalletId: string;
  quoteId: string;
  receiptIds: readonly string[];
  receiveSessionId: string;
  telegramFundingSessionId: string;
  telegramAccountId: string;
  userId: string;
  userWalletId: string;
  plan: FundingCommitPlan;
}>;

const fixtures: Fixture[] = [];
const extraAuthorizationIds: string[] = [];
const policyIds: string[] = [];
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
        locationId: opaque("destination_location"),
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
  const action = {
    kind: "evm_transaction",
    actionId: opaque("wrap_action"),
    networkId: "evm:137",
    senderWalletId: actionWalletId,
    to: router,
    data: fundInterface.encodeFunctionData("fund", [77n, BigInt(raw), 0n]),
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
      venueBindingSnapshot: { venueBindingOptionId },
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
        actionValidationResult: { valid: true },
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
    venueBindingSnapshot: { venueBindingOptionId },
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
    operationId: committed.operation.id,
    privyWalletId,
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
    plan,
  };
  fixtures.push(fixture);
  return fixture;
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
): DelegatedFundingExecutor {
  return executorForConfiguration(
    profileConfiguration,
    execute,
    recover,
    codec,
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
): DelegatedFundingExecutor {
  const profile = createPolymarketWrapDelegatedFundingProfile({
    configuration,
    driver: { execute, recover },
  });
  assert.ok(profile);
  return new DelegatedFundingExecutor(pool, {
    profiles: [profile],
    referenceCodec: codec,
    startedAttemptRecoveryMs: 60_000,
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
    driver: { execute, recover: execute },
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
    startedAttemptRecoveryMs: 60_000,
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

  const hugeRaw = (2n ** 255n).toString();
  const concurrent = await createFixture(hugeRaw, true);
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
    operation_id: string;
    outcome: string;
    reference_kind: string | null;
    updated_at: Date;
  }>(
    `select step.operation_id, attempt.outcome, attempt.reference_kind,
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
      return { kind: "ambiguous" };
    },
    async () => {
      boundaryRecoveryCalls += 1;
      return {
        kind: "submitted",
        transactionReference: `0x${"4".repeat(64)}`,
      };
    },
  ).runBatch({ limit: 1, now: new Date(now.getTime() + 10 * 60_000) });
  assert.equal(recoveredBoundary.recovered, 1);
  assert.equal(recoveredBoundary.submitted, 1);
  assert.equal(boundaryExecuteCalls, 0);
  assert.equal(boundaryRecoveryCalls, 1);

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
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    testFailure ??= error;
  } finally {
    client.release();
  }
}

if (testFailure) throw testFailure;
