#!/usr/bin/env tsx

// @requires-db

import assert from "node:assert/strict";
import crypto from "node:crypto";

import { fundingSidecarRuntimeConfig } from "../../runtime/sidecar-runtime-config.js";
import { canonicalJsonHash } from "../../persistence/canonical.js";
import { pool } from "../../../db.js";
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
  TelegramFundingPersistenceError,
} from "../../../services/telegram-funding-sessions.js";
import { runTelegramFundingProgressProjectionBatch } from "../../../services/telegram-funding-progress-projector.js";
import {
  cleanupTelegramFundingContexts,
  deliverTelegramFundingActions,
  rearmTelegramFundingTerminalDelivery,
} from "../../../services/telegram-funding-delivery.js";
import { fetchUserFinancialLifecycleSummary } from "../../../services/user-financial-lifecycle.js";
import { TelegramFundingService } from "../../../services/telegram-funding.js";

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
const destinationAddress = "0x1111111111111111111111111111111111111111";
const receiveTargetId = `receive_target_telegram_${suffix}`;
const pUsdVariantId = `telegram_pusd_${suffix}`;
const usdceVariantId = `telegram_usdce_${suffix}`;
let receiveSessionId: string | null = null;
let fundingContextId: string | null = null;
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

  const canonicalInput = {
    userId,
    ownerChannel: "telegram",
    venueId: "polymarket",
    destinationOptionId: `destination_${suffix}`,
    venueBindingOptionId: `binding_${suffix}`,
    destinationAsset: pUsd,
    destinationTargetSnapshot: { locationId: `location_${suffix}` },
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
    receiveTargetId,
    asset: pUsd,
    variantIds: [pUsdVariantId],
    policySnapshot: { mode: "direct", automationEnabled: false } as const,
    fingerprint: hash("consent"),
    mutation: {
      idempotencyKey: selectIdempotencyKey,
      requestFingerprint: selectRequestFingerprint,
      responsePayload: { text: "verified pUSD address" },
    },
    now: new Date(now.getTime() + 1_000),
  };
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
  assert.equal(
    concurrentProjection.reduce((total, result) => total + result.created, 0),
    1,
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
      JSON.stringify({ mode: "future_automatic_test" }),
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
  assert.equal(attentionProjection.created, 1);
  const latest = await pool.query<{ revision: number; state: string }>(
    `select progress_revision as revision,
            latest_progress_projection->>'state' as state
     from telegram_funding_sessions where id = $1`,
    [fundingContextId],
  );
  assert.deepEqual(latest.rows[0], { revision: 2, state: "needs_attention" });

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
    replacement_count: string;
    retired_count: string;
  }>(
    `select
       count(*) filter (
         where action = 'funding_replacement' and status = 'pending'
       )::text as replacement_count,
       count(*) filter (
         where action = 'funding_edit' and status = 'skipped'
       )::text as retired_count
     from telegram_bot_action_outbox
     where funding_session_id = $1 and state_revision = 2`,
    [fundingContextId],
  );
  assert.deepEqual(rearmed.rows[0], {
    replacement_count: "1",
    retired_count: "1",
  });
  let replacementSends = 0;
  const replacementDelivery = await deliverTelegramFundingActions({
    pool,
    renderCoordinator,
    telegram: {
      editMessageText: async () => {
        assert.fail("a rearmed terminal projection must use replacement send");
      },
      sendMessage: async () => {
        replacementSends += 1;
        return { ok: true, messageId: 202 };
      },
    },
  });
  assert.equal(replacementDelivery.sent, 1);
  assert.equal(replacementSends, 1);
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
        receiveTargetId,
        asset: pUsd,
        variantIds: [pUsdVariantId],
        policySnapshot: { mode: "direct", automationEnabled: false },
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
      status: "pending",
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
      edit_status: "skipped",
      replacement_status: "pending",
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
      lease_id: string | null;
      status: string;
    }>(
      `select
         outbox.delivery_attempt_id::text as attempt_id,
         context.delivery_lease_outbox_id::text as lease_id,
         outbox.status
       from telegram_bot_action_outbox outbox
       join telegram_funding_sessions context
         on context.id = outbox.funding_session_id
       where outbox.id = $1`,
      [staleOutboxId],
    );
    assert.deepEqual(staleAttemptRearmed.rows[0], {
      attempt_id: null,
      lease_id: null,
      status: "pending",
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
        receiveTargetId,
        asset: pUsd,
        variantIds: [pUsdVariantId],
        policySnapshot: { mode: "direct", automationEnabled: false },
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
      { candidates: 1, created: 1, skipped: 0 },
    );
    const lateReadyState = await pool.query<{ state: string }>(
      `select latest_progress_projection->>'state' as state
       from telegram_funding_sessions where id = $1`,
      [cancelContextId],
    );
    assert.equal(lateReadyState.rows[0]?.state, "ready");
    assert.deepEqual(
      await runTelegramFundingProgressProjectionBatch(pool, {
        limit: 100,
        now: new Date(now.getTime() + 27_300),
      }),
      { candidates: 0, created: 0, skipped: 0 },
      "a late ready receipt after cancellation must advance the watermark once",
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
    const raceRecorded = await pool.query<{
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
         outbox.status as outbox_status
       from telegram_funding_sessions context
       join telegram_bot_action_outbox outbox
         on outbox.funding_session_id = context.id
        and outbox.state_revision = 2
        and outbox.action = 'funding_send'
       where context.id = $1`,
      [preterminalContextId],
    );
    assert.deepEqual(raceRecorded.rows[0], {
      last_delivered_revision: 2,
      telegram_account_id: raceRelinkId,
      telegram_message_id: "1200",
      outbox_account_id: raceRelinkId,
      outbox_status: "sent",
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

  console.log(
    "[telegram-funding-receive-integration-tests] channel ownership, concurrent mutation replay, fair projection watermarks, exact historical authority, durable delivery, and safe lifecycle cleanup passed",
  );
} finally {
  const cleanup = await pool.connect();
  try {
    await cleanup.query("begin");
    await cleanup.query("set local session_replication_role = replica");
    if (fundingContextId) {
      await cleanup.query(
        "delete from telegram_bot_action_outbox where funding_session_id = $1",
        [fundingContextId],
      );
      await cleanup.query(
        "delete from telegram_funding_mutations where funding_context_id = $1",
        [fundingContextId],
      );
      await cleanup.query(
        "delete from telegram_funding_consents where telegram_funding_session_id = $1",
        [fundingContextId],
      );
      await cleanup.query(
        "delete from telegram_funding_sessions where id = $1",
        [fundingContextId],
      );
    }
    if (receiveSessionId) {
      await cleanup.query(
        "delete from funding_receive_receipts where receive_session_id = $1",
        [receiveSessionId],
      );
      await cleanup.query(
        "delete from funding_receive_sessions where id = $1",
        [receiveSessionId],
      );
    }
    await cleanup.query(
      "delete from telegram_bot_action_outbox where user_id = $1",
      [userId],
    );
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
