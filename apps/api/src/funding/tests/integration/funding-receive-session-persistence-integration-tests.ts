#!/usr/bin/env tsx

// @api-integration

import assert from "node:assert/strict";
import crypto from "node:crypto";

import "../../../integration-test-database-guard.js";
import {
  fetchUser,
  FundingMergeConflictError,
  mergeUsers,
} from "../../../admin-merge-user-core.js";
import { AuthService } from "../../../auth.js";
import { pool } from "../../../db.js";
import { fetchUserFinancialLifecycleSummary } from "../../../services/user-financial-lifecycle.js";
import {
  claimFundingReceiveCanonicalEventAllocation,
  claimObservableFundingReceiveSessions,
  cancelFundingReceiveSessionForUser,
  createOrReuseFundingReceiveSession,
  expireFundingReceiveSessions,
  fetchFundingReceiveReceiptForReview,
  fetchFundingReceiveSessionForUser,
  FundingReceiveSessionChannelConflictError,
  FundingReceiveSessionExactScopeConflictError,
  FundingReceiveSessionOpenIdempotencyConflictError,
  insertFundingReceiveReceipt,
  listFundingReceiveReceiptsForRouting,
  listFundingReceiveReceiptsForUser,
  lockFundingReceiveSessionScope,
  recordFundingReceiveReceiptRoutingDisposition,
  replayFundingReceiveSessionOpenIdempotency,
  settleFundingReceiveReceiptRouting,
  updateFundingReceiveSessionObservation,
} from "../../persistence/funding-receive-session-repository.js";
import { FundingReceiveSessionObserver } from "../../receive/receive-session-observer.js";

const NOW = new Date();
const DESTINATION_OPTION_ID = "destination_receive_persistence_12345678";
const VENUE_BINDING_OPTION_ID = "binding_receive_persistence_12345678";
const RUN_ID = crypto.randomUUID();

function uniqueHash(label: string): string {
  return `0x${crypto.createHash("sha256").update(`${RUN_ID}:${label}`).digest("hex")}`;
}

async function insertUser(): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `
      insert into users (email, is_active, is_verified)
      values ($1, true, true)
      returning id
    `,
    [`funding-receive-${crypto.randomUUID()}@example.com`],
  );
  const userId = rows[0]?.id;
  assert.ok(userId);
  return userId;
}

function sessionInput(userId: string) {
  const asset = {
    networkId: "evm:137",
    assetId: "0xAbCdAbCdAbCdAbCdAbCdAbCdAbCdAbCdAbCdAbCd",
    decimals: 6,
  } as const;
  const receiveTarget = {
    receiveTargetId: "receive_target_persistence_12345678",
    networkId: asset.networkId,
    destinationAddress: "0xDeF0DeF0DeF0DeF0DeF0DeF0DeF0DeF0DeF0DeF0",
    acceptedAssets: [{ asset, handling: "direct" as const }],
    safeInstructions: ["Send only the displayed asset."],
  } as const;
  return {
    userId,
    venueId: "polymarket",
    destinationOptionId: DESTINATION_OPTION_ID,
    venueBindingOptionId: VENUE_BINDING_OPTION_ID,
    destinationAsset: asset,
    destinationTargetSnapshot: { locationId: "location_receive_12345678" },
    venueBindingSnapshot: { bindingId: VENUE_BINDING_OPTION_ID },
    methods: [
      {
        methodId: "receive_method_manual_12345678",
        kind: "manual" as const,
        safeLabel: "Send crypto",
        ingress: {
          ingressKind: "manual" as const,
          sourceNetworkId: null,
          sourceAsset: null,
          receiveTargets: [receiveTarget],
          recommendedReceiveTargetId: receiveTarget.receiveTargetId,
          destinationOptionId: DESTINATION_OPTION_ID,
          destinationAddress: receiveTarget.destinationAddress,
          requestedAmount: null,
          amountSemantics: "minimum" as const,
          expiresAt: new Date(NOW.getTime() + 86_400_000).toISOString(),
          safeInstructions: ["Send only the displayed asset."],
        },
      },
    ],
    receiveTargets: [receiveTarget],
    observationVariants: [
      {
        variantId: "ingress_variant_persistence_12345678",
        networkId: asset.networkId,
        asset,
        destinationAddress: "0xDeF0DeF0DeF0DeF0DeF0DeF0DeF0DeF0DeF0DeF0",
        destinationLocationId: "location_receive_12345678",
        baselineRaw: "0",
        baselineRevision: "baseline_revision_receive_12345678",
        observation: {
          adapterId: "owned_wallet_liquid_balances_v1",
          payload: { balanceKey: "erc20:receive-test" },
        },
        completion: { kind: "direct_destination_credit" as const },
      },
    ],
    selectedReceiveTargetId: "receive_target_persistence_12345678",
    automationPolicy: {
      stableConversion: "automatic_within_caps" as const,
      volatileConversion: "review_required" as const,
      maximumFeeUsd: "1",
      maximumFeeBps: 500,
      maximumSlippageBps: 100,
    },
    policyVersion: 1,
    policyRevision: "policy_revision_receive_12345678",
    ownershipRevision: "ownership_revision_receive_12345678",
    expiresAt: new Date(NOW.getTime() + 86_400_000),
    observeUntil: new Date(NOW.getTime() + 8 * 86_400_000),
    now: NOW,
  } as const;
}

function retainedSolSessionInput(userId: string) {
  const destinationAsset = {
    networkId: "evm:8453",
    assetId: "0x2222222222222222222222222222222222222222",
    decimals: 6,
  } as const;
  const solAsset = {
    networkId: "solana:mainnet",
    assetId: "11111111111111111111111111111111",
    decimals: 9,
  } as const;
  const receiveTarget = {
    receiveTargetId: "receive_target_retained_sol_12345678",
    networkId: solAsset.networkId,
    destinationAddress: "9xQeWvG816bUx9EPjHmaT23yvVMZq4XFmYdWkP3vZC8V",
    acceptedAssets: [{ asset: solAsset, handling: "direct" as const }],
    safeInstructions: ["Send only native SOL."],
  } as const;
  return {
    userId,
    venueId: "limitless",
    destinationOptionId: "destination_retained_sol_12345678",
    venueBindingOptionId: "binding_retained_sol_12345678",
    destinationAsset,
    destinationTargetSnapshot: {
      locationId: "location_retained_destination_12345678",
    },
    venueBindingSnapshot: { bindingId: "binding_retained_sol_12345678" },
    methods: [
      {
        methodId: "receive_method_retained_sol_12345678",
        kind: "manual" as const,
        safeLabel: "Send SOL",
        ingress: {
          ingressKind: "manual" as const,
          sourceNetworkId: null,
          sourceAsset: null,
          receiveTargets: [receiveTarget],
          recommendedReceiveTargetId: receiveTarget.receiveTargetId,
          destinationOptionId: "destination_retained_sol_12345678",
          destinationAddress: receiveTarget.destinationAddress,
          requestedAmount: null,
          amountSemantics: "minimum" as const,
          expiresAt: new Date(NOW.getTime() + 86_400_000).toISOString(),
          safeInstructions: ["Send only native SOL."],
        },
      },
    ],
    receiveTargets: [receiveTarget],
    observationVariants: [
      {
        variantId: "ingress_variant_retained_sol_12345678",
        networkId: solAsset.networkId,
        asset: solAsset,
        destinationAddress: receiveTarget.destinationAddress,
        destinationLocationId: "location_retained_sol_12345678",
        baselineRaw: "0",
        baselineRevision: "baseline_revision_retained_sol_12345678",
        observation: {
          adapterId: "owned_wallet_liquid_balances_v1",
          payload: { eventIdentity: "solana_native_transfer_v1" },
        },
        completion: { kind: "retained_owned_source_credit" as const },
      },
    ],
    selectedReceiveTargetId: receiveTarget.receiveTargetId,
    automationPolicy: {
      stableConversion: "automatic_within_caps" as const,
      volatileConversion: "review_required" as const,
      maximumFeeUsd: "1",
      maximumFeeBps: 500,
      maximumSlippageBps: 100,
    },
    policyVersion: 1,
    policyRevision: "policy_revision_retained_sol_12345678",
    ownershipRevision: "ownership_revision_retained_sol_12345678",
    expiresAt: new Date(NOW.getTime() + 86_400_000),
    observeUntil: new Date(NOW.getTime() + 8 * 86_400_000),
    now: NOW,
  } as const;
}

const userId = await insertUser();
let mergeTargetId: string | null = null;
let genericOptionUserId: string | null = null;
let retainedSolUserId: string | null = null;
let historicalSolUserId: string | null = null;
let historicalSolTransactionHash: string | null = null;
let crossChannelUserId: string | null = null;
let reviewReleaseUserId: string | null = null;
let recoveryReleaseUserId: string | null = null;
let pollingFairnessUserId: string | null = null;
let sameChannelLeaseUserId: string | null = null;
let completedLifecycleUserId: string | null = null;
let expiredReviewSelectionUserId: string | null = null;
let lateClosedReleaseUserId: string | null = null;
try {
  crossChannelUserId = await insertUser();
  const telegramReceive = await createOrReuseFundingReceiveSession(pool, {
    ...sessionInput(crossChannelUserId),
    ownerChannel: "telegram",
  });
  const webReceive = await createOrReuseFundingReceiveSession(pool, {
    ...sessionInput(crossChannelUserId),
    ownerChannel: "web",
    now: new Date(NOW.getTime() + 100),
  });
  assert.notEqual(
    webReceive.snapshot.session.receiveSessionId,
    telegramReceive.snapshot.session.receiveSessionId,
    "a selected receive target without a receipt must not block another channel",
  );
  const supersededReceive = await fetchFundingReceiveSessionForUser(pool, {
    userId: crossChannelUserId,
    receiveSessionId: telegramReceive.snapshot.session.receiveSessionId,
  });
  assert.equal(supersededReceive?.session.status, "cancelled");
  assert.equal(supersededReceive?.ownerChannel, "telegram");
  const observableAfterHandoff = await claimObservableFundingReceiveSessions(
    pool,
    {
      limit: 10,
      minimumPollIntervalMs: 1_000,
      inactivePollIntervalMs: 1_000,
      closedPollIntervalMs: 1_000,
      now: new Date(NOW.getTime() + 1_500),
    },
  );
  assert.ok(
    observableAfterHandoff.some(
      (snapshot) =>
        snapshot.session.receiveSessionId ===
        telegramReceive.snapshot.session.receiveSessionId,
    ),
    "a superseded session must remain observable for a late transfer",
  );

  const receiveInput = sessionInput(crossChannelUserId);
  await insertFundingReceiveReceipt(pool, {
    receiveSessionId: webReceive.snapshot.session.receiveSessionId,
    userId: crossChannelUserId,
    variantId: receiveInput.observationVariants[0].variantId,
    asset: receiveInput.destinationAsset,
    destinationAddress: receiveInput.observationVariants[0].destinationAddress,
    rawAmount: "1",
    observationRevision: "cross_channel_observation_12345678",
    observedAt: new Date(NOW.getTime() + 1_600),
    status: "observed",
    handling: "direct",
    evidence: { test: "cross_channel_money_boundary" },
    now: new Date(NOW.getTime() + 1_600),
  });
  await assert.rejects(
    () =>
      createOrReuseFundingReceiveSession(pool, {
        ...receiveInput,
        ownerChannel: "telegram",
        now: new Date(NOW.getTime() + 2 * 86_400_000),
      }),
    (error: unknown) =>
      error instanceof FundingReceiveSessionChannelConflictError,
    "an observed receipt must retain channel ownership through observe_until, even after expires_at",
  );

  retainedSolUserId = await insertUser();
  const retainedInput = retainedSolSessionInput(retainedSolUserId);
  const retainedSession = await createOrReuseFundingReceiveSession(
    pool,
    retainedInput,
  );
  const retainedReceipt = await insertFundingReceiveReceipt(pool, {
    receiveSessionId: retainedSession.snapshot.session.receiveSessionId,
    userId: retainedSolUserId,
    variantId: retainedInput.observationVariants[0].variantId,
    asset: retainedInput.observationVariants[0].asset,
    destinationAddress: retainedInput.observationVariants[0].destinationAddress,
    rawAmount: "52000000",
    observationRevision: "retained_sol_observation_12345678",
    observedAt: new Date(NOW.getTime() + 1_000),
    status: "ready",
    handling: "direct",
    evidence: { test: "retained_owned_source_credit" },
    now: new Date(NOW.getTime() + 1_000),
  });
  assert.equal(retainedReceipt.receipt.status, "ready");
  assert.equal(retainedReceipt.receipt.childFundingOperationId, null);
  const retainedPersistence = await pool.query<{
    receipt_matches: boolean;
  }>(
    `select funding_receive_receipt_matches_frozen_variant(receipt)
       as receipt_matches
     from funding_receive_receipts receipt
     where receipt.id = $1`,
    [retainedReceipt.receipt.receiptId],
  );
  assert.deepEqual(retainedPersistence.rows[0], {
    receipt_matches: true,
  });

  // A scanner cursor is already past a canonical event once it has been
  // quarantined. Opening an eligible session later must recover that durable
  // event without depending on the chain RPC to emit it a second time.
  historicalSolUserId = await insertUser();
  historicalSolTransactionHash = uniqueHash("historical-native-sol-deposit");
  const historicalInputBase = retainedSolSessionInput(historicalSolUserId);
  const historicalVariant = {
    ...historicalInputBase.observationVariants[0],
    observation: {
      ...historicalInputBase.observationVariants[0].observation,
      payload: {
        ...historicalInputBase.observationVariants[0].observation.payload,
        eventCursorSlot: "100",
        eventIdentity: "solana_transfer_v1",
      },
    },
  } as const;
  const historicalAllocationClient = await pool.connect();
  try {
    await historicalAllocationClient.query("begin");
    const quarantined = await claimFundingReceiveCanonicalEventAllocation(
      historicalAllocationClient,
      {
        networkId: historicalVariant.networkId,
        asset: historicalVariant.asset,
        destinationAddress: historicalVariant.destinationAddress,
        sourceAddress: "7YttLkHDoNj9wyDur4QmK5KdHDAtSdB7TGjEHJx6Ms7D",
        rawAmount: "30000000",
        transactionHash: historicalSolTransactionHash,
        eventIndex: "0",
        ledgerHeight: "102",
        blockHash: uniqueHash("historical-native-sol-block"),
        observedAt: new Date(NOW.getTime() + 1_500),
        now: new Date(NOW.getTime() + 1_500),
      },
    );
    assert.equal(quarantined.status, "recovery_required");
    assert.equal(
      quarantined.errorCode,
      "receive_session_allocation_unavailable",
    );
    await historicalAllocationClient.query("commit");
  } catch (error) {
    await historicalAllocationClient.query("rollback");
    throw error;
  } finally {
    historicalAllocationClient.release();
  }
  const historicalOldSession = await createOrReuseFundingReceiveSession(pool, {
    ...historicalInputBase,
    destinationOptionId: `destination_historical_sol_old_${RUN_ID}`,
    venueBindingOptionId: `binding_historical_sol_old_${RUN_ID}`,
    observationVariants: [historicalVariant],
    now: new Date(NOW.getTime() + 1_800),
  });
  const historicalFreshVariant = {
    ...historicalVariant,
    observation: {
      ...historicalVariant.observation,
      payload: {
        ...historicalVariant.observation.payload,
        eventCursorSlot: "101",
      },
    },
  } as const;
  const historicalSession = await createOrReuseFundingReceiveSession(pool, {
    ...historicalInputBase,
    destinationOptionId: `destination_historical_sol_fresh_${RUN_ID}`,
    venueBindingOptionId: `binding_historical_sol_fresh_${RUN_ID}`,
    observationVariants: [historicalFreshVariant],
    now: new Date(NOW.getTime() + 2_000),
  });
  const recoveryObserver = new FundingReceiveSessionObserver({
    scanCanonicalEvents: async (variants) => ({
      events: [],
      variants,
      cursorAdvanced: false,
    }),
    listPotentialPolymarketHandoffs: async () => [],
  });
  const oldPollAt = new Date(NOW.getTime() + 2_500);
  await pool.query(
    `update funding_receive_sessions
        set observation_requested_at = case
              when id = $1::uuid then $3::timestamptz
              else null
            end,
            last_observed_at = case
              when id = $1::uuid then $3::timestamptz - interval '1 day'
              else $3::timestamptz
            end
      where id = any($2::uuid[])`,
    [
      historicalOldSession.snapshot.session.receiveSessionId,
      [
        historicalOldSession.snapshot.session.receiveSessionId,
        historicalSession.snapshot.session.receiveSessionId,
      ],
      oldPollAt,
    ],
  );
  const oldPoll = await recoveryObserver.pollBatch(pool, {
    limit: 1,
    minimumPollIntervalMs: 0,
    now: oldPollAt,
  });
  assert.equal(oldPoll.retryableErrors, 0);
  const { rows: afterNonTargetRows } = await pool.query<{
    allocation_status: string;
    old_status: string;
    receipts: string;
  }>(
    `select canonical_event.allocation_status,
            old_session.status as old_status,
            (
              select count(*)::text
              from funding_receive_receipts receipt
              where receipt.receive_session_id = old_session.id
            ) as receipts
       from funding_receive_canonical_events canonical_event
       cross join funding_receive_sessions old_session
      where canonical_event.tx_hash = $1
        and old_session.id = $2::uuid`,
    [
      historicalSolTransactionHash,
      historicalOldSession.snapshot.session.receiveSessionId,
    ],
  );
  assert.deepEqual(afterNonTargetRows[0], {
    allocation_status: "recovery_required",
    old_status: "open",
    receipts: "0",
  });
  const freshPollAt = new Date(NOW.getTime() + 3_600);
  await pool.query(
    `update funding_receive_sessions
        set observation_requested_at = $2,
            last_observed_at = $2::timestamptz - interval '2 days'
      where id = $1::uuid`,
    [historicalSession.snapshot.session.receiveSessionId, freshPollAt],
  );
  const recoveredPoll = await recoveryObserver.pollBatch(pool, {
    limit: 1,
    minimumPollIntervalMs: 0,
    now: freshPollAt,
  });
  assert.equal(recoveredPoll.retryableErrors, 0);
  const { rows: historicalRows } = await pool.query<{
    allocation_status: string;
    notification_count: string;
    receipt_status: string;
  }>(
    `
      select canonical_event.allocation_status,
             receipt.status as receipt_status,
             (
               select count(*)::text
               from notifications notification_row
               where notification_row.user_id = $2::uuid
                 and notification_row.type = 'deposit_received'
                 and notification_row.data->>'txHash' = $3
             ) as notification_count
      from funding_receive_canonical_events canonical_event
      join funding_receive_receipts receipt
        on receipt.id = canonical_event.allocated_receipt_id
      where canonical_event.tx_hash = $3
        and receipt.receive_session_id = $1::uuid
    `,
    [
      historicalSession.snapshot.session.receiveSessionId,
      historicalSolUserId,
      historicalSolTransactionHash,
    ],
  );
  assert.deepEqual(historicalRows[0], {
    allocation_status: "allocated",
    receipt_status: "ready",
    notification_count: "1",
  });
  await pool.query(
    `update funding_receive_sessions
        set status = 'processing',
            updated_at = $2,
            version = version + 1
      where id = $1`,
    [
      retainedSession.snapshot.session.receiveSessionId,
      new Date(NOW.getTime() + 1_900),
    ],
  );
  const retainedTelegramSession = await createOrReuseFundingReceiveSession(
    pool,
    {
      ...retainedInput,
      ownerChannel: "telegram",
      now: new Date(NOW.getTime() + 2_000),
    },
  );
  assert.notEqual(
    retainedTelegramSession.snapshot.session.receiveSessionId,
    retainedSession.snapshot.session.receiveSessionId,
    "a settled receipt must not retain an exclusive receive channel lease",
  );

  reviewReleaseUserId = await insertUser();
  const reviewReleaseInput = {
    ...sessionInput(reviewReleaseUserId),
    requireExactReceiveScope: true,
  } as const;
  const reviewReleaseSession = await createOrReuseFundingReceiveSession(pool, {
    ...reviewReleaseInput,
    ownerChannel: "web",
  });
  const reviewReleaseReceipt = await insertFundingReceiveReceipt(pool, {
    receiveSessionId: reviewReleaseSession.snapshot.session.receiveSessionId,
    userId: reviewReleaseUserId,
    variantId: reviewReleaseInput.observationVariants[0].variantId,
    asset: reviewReleaseInput.destinationAsset,
    destinationAddress:
      reviewReleaseInput.observationVariants[0].destinationAddress,
    rawAmount: "1000000",
    observationRevision: "review_release_observation_12345678",
    observedAt: new Date(NOW.getTime() + 2_100),
    status: "review_required",
    handling: "review_required",
    evidence: {
      reviewContinuation: {
        version: 1,
        kind: "convert",
        label: "Convert",
        confirmation: "fresh_quote",
      },
      reviewQuotePlan: {
        version: 1,
        confirmedSourceAmount: null,
        requestedDestinationAmount: {
          asset: reviewReleaseInput.destinationAsset,
          raw: "1000000",
        },
        venuePreparation: false,
      },
    },
    now: new Date(NOW.getTime() + 2_100),
  });
  assert.equal(
    await updateFundingReceiveSessionObservation(pool, {
      receiveSessionId: reviewReleaseSession.snapshot.session.receiveSessionId,
      expectedVersion: reviewReleaseSession.snapshot.session.version,
      observationVariants: reviewReleaseInput.observationVariants,
      status: "review_required",
      lastObservedAt: new Date(NOW.getTime() + 2_100),
      now: new Date(NOW.getTime() + 2_100),
    }),
    true,
  );
  const afterReviewSession = await createOrReuseFundingReceiveSession(pool, {
    ...reviewReleaseInput,
    ownerChannel: "telegram",
    now: new Date(NOW.getTime() + 2_200),
  });
  assert.notEqual(
    afterReviewSession.snapshot.session.receiveSessionId,
    reviewReleaseSession.snapshot.session.receiveSessionId,
    "a review-required receipt must remain resumable without owning the receive selection",
  );
  assert.ok(
    await fetchFundingReceiveReceiptForReview(pool, {
      userId: reviewReleaseUserId,
      ownerChannel: "web",
      receiveSessionId: reviewReleaseSession.snapshot.session.receiveSessionId,
      receiptId: reviewReleaseReceipt.receipt.receiptId,
    }),
    "opening a fresh deposit must not hide the older review receipt",
  );
  await pool.query(
    `update funding_receive_receipts
        set status = 'routing', updated_at = $2
      where id = $1`,
    [reviewReleaseReceipt.receipt.receiptId, new Date(NOW.getTime() + 2_220)],
  );
  await pool.query(
    `update funding_receive_sessions
        set status = 'processing', version = version + 1, updated_at = $2
      where id = $1`,
    [
      reviewReleaseSession.snapshot.session.receiveSessionId,
      new Date(NOW.getTime() + 2_220),
    ],
  );
  assert.equal(
    await settleFundingReceiveReceiptRouting(pool, {
      receiptId: reviewReleaseReceipt.receipt.receiptId,
      receiveSessionId: reviewReleaseSession.snapshot.session.receiveSessionId,
      userId: reviewReleaseUserId,
      status: "ready",
      now: new Date(NOW.getTime() + 2_230),
    }),
    true,
    "an older review receipt must still settle after a fresh session opens",
  );
  const [settledOldReview, stillOpenFreshSession] = await Promise.all([
    fetchFundingReceiveSessionForUser(pool, {
      userId: reviewReleaseUserId,
      receiveSessionId: reviewReleaseSession.snapshot.session.receiveSessionId,
    }),
    fetchFundingReceiveSessionForUser(pool, {
      userId: reviewReleaseUserId,
      receiveSessionId: afterReviewSession.snapshot.session.receiveSessionId,
    }),
  ]);
  assert.equal(
    settledOldReview?.session.status,
    "completed",
    "settled old work must close instead of reclaiming the fresh open slot",
  );
  assert.equal(stillOpenFreshSession?.session.status, "open");
  const completedObservationClient = await pool.connect();
  try {
    await completedObservationClient.query("begin");
    await completedObservationClient.query(
      `update funding_receive_sessions
          set last_observed_at = $2
        where id = $1`,
      [
        reviewReleaseSession.snapshot.session.receiveSessionId,
        new Date(NOW.getTime() - 10 * 60_000),
      ],
    );
    const completedCandidates = await claimObservableFundingReceiveSessions(
      completedObservationClient,
      {
        limit: 1_000,
        minimumPollIntervalMs: 1_000,
        inactivePollIntervalMs: 1_000,
        closedPollIntervalMs: 1_000,
        now: new Date(NOW.getTime() + 2_240),
      },
    );
    assert.equal(
      completedCandidates.some(
        (candidate) =>
          candidate.session.receiveSessionId ===
          reviewReleaseSession.snapshot.session.receiveSessionId,
      ),
      true,
      "completed sessions remain observable for late deposits without owning the live slot",
    );
  } finally {
    await completedObservationClient.query("rollback");
    completedObservationClient.release();
  }
  completedLifecycleUserId = await insertUser();
  const completedLifecycleInput = sessionInput(completedLifecycleUserId);
  const completedLifecycleSession = await createOrReuseFundingReceiveSession(
    pool,
    completedLifecycleInput,
  );
  await insertFundingReceiveReceipt(pool, {
    receiveSessionId:
      completedLifecycleSession.snapshot.session.receiveSessionId,
    userId: completedLifecycleUserId,
    variantId: completedLifecycleInput.observationVariants[0].variantId,
    asset: completedLifecycleInput.observationVariants[0].asset,
    destinationAddress:
      completedLifecycleInput.observationVariants[0].destinationAddress,
    rawAmount: "1",
    observationRevision: "completed_lifecycle_receipt_12345678",
    observedAt: new Date(NOW.getTime() + 2_245),
    status: "ready",
    handling: "direct",
    evidence: { test: "completed_lifecycle" },
    now: new Date(NOW.getTime() + 2_245),
  });
  await pool.query(
    `update funding_receive_sessions
        set status = 'completed',
            closed_at = $2,
            updated_at = $2,
            version = version + 1
      where id = $1`,
    [
      completedLifecycleSession.snapshot.session.receiveSessionId,
      new Date(NOW.getTime() + 2_246),
    ],
  );
  const completedLifecycle = await fetchUserFinancialLifecycleSummary(pool, [
    completedLifecycleUserId,
  ]);
  assert.ok(
    completedLifecycle.activeReasons.includes("active_receive_session"),
    "a completed receive address remains lifecycle-protected through its late-observation window",
  );
  await insertFundingReceiveReceipt(pool, {
    receiveSessionId: afterReviewSession.snapshot.session.receiveSessionId,
    userId: reviewReleaseUserId,
    variantId: reviewReleaseInput.observationVariants[0].variantId,
    asset: reviewReleaseInput.destinationAsset,
    destinationAddress:
      reviewReleaseInput.observationVariants[0].destinationAddress,
    rawAmount: "1000000",
    observationRevision: "settled_cancel_observation_12345678",
    observedAt: new Date(NOW.getTime() + 2_250),
    status: "ready",
    handling: "direct",
    evidence: { test: "settled_session_cancel" },
    now: new Date(NOW.getTime() + 2_250),
  });
  const freshAfterSettled = await createOrReuseFundingReceiveSession(pool, {
    ...reviewReleaseInput,
    ownerChannel: "telegram",
    now: new Date(NOW.getTime() + 2_255),
  });
  assert.notEqual(
    freshAfterSettled.snapshot.session.receiveSessionId,
    afterReviewSession.snapshot.session.receiveSessionId,
    "a new same-channel Deposit must replace a ready-only session",
  );
  const cancelledSettledSession = await cancelFundingReceiveSessionForUser(
    pool,
    {
      userId: reviewReleaseUserId,
      ownerChannel: "telegram",
      receiveSessionId: freshAfterSettled.snapshot.session.receiveSessionId,
      now: new Date(NOW.getTime() + 2_260),
    },
  );
  assert.equal(
    cancelledSettledSession?.session.status,
    "cancelled",
    "the replacement session must remain cancellable before a transfer",
  );
  recoveryReleaseUserId = await insertUser();
  const recoveryBaseInput = sessionInput(recoveryReleaseUserId);
  const recoveryVariant = {
    ...recoveryBaseInput.observationVariants[0],
    observation: {
      ...recoveryBaseInput.observationVariants[0].observation,
      payload: {
        ...recoveryBaseInput.observationVariants[0].observation.payload,
        eventCursorBlock: "100",
        eventIdentity: "evm_erc20_transfer_v1",
      },
    },
  } as const;
  const recoveryReleaseInput = {
    ...recoveryBaseInput,
    observationVariants: [recoveryVariant],
    requireExactReceiveScope: true,
  } as const;
  const recoveryReleaseSession = await createOrReuseFundingReceiveSession(
    pool,
    { ...recoveryReleaseInput, ownerChannel: "web" },
  );
  await insertFundingReceiveReceipt(pool, {
    receiveSessionId: recoveryReleaseSession.snapshot.session.receiveSessionId,
    userId: recoveryReleaseUserId,
    variantId: recoveryVariant.variantId,
    asset: recoveryVariant.asset,
    destinationAddress: recoveryVariant.destinationAddress,
    rawAmount: "1",
    observationRevision: "recovery_release_observation_12345678",
    observedAt: new Date(NOW.getTime() + 2_300),
    status: "recovery_required",
    handling: "automatic_conversion",
    evidence: { test: "recovery_selection_release" },
    now: new Date(NOW.getTime() + 2_300),
  });
  assert.equal(
    await updateFundingReceiveSessionObservation(pool, {
      receiveSessionId:
        recoveryReleaseSession.snapshot.session.receiveSessionId,
      expectedVersion: recoveryReleaseSession.snapshot.session.version,
      observationVariants: [recoveryVariant],
      status: "recovery_required",
      lastObservedAt: new Date(NOW.getTime() + 2_300),
      now: new Date(NOW.getTime() + 2_300),
    }),
    true,
  );
  const pausedRecoveryAllocationClient = await pool.connect();
  try {
    await pausedRecoveryAllocationClient.query("begin");
    const pausedAllocation = await claimFundingReceiveCanonicalEventAllocation(
      pausedRecoveryAllocationClient,
      {
        networkId: recoveryVariant.networkId,
        asset: recoveryVariant.asset,
        destinationAddress: recoveryVariant.destinationAddress,
        sourceAddress: "0x1111111111111111111111111111111111111111",
        rawAmount: "1000000",
        transactionHash: uniqueHash("deposit-while-recovery-paused"),
        eventIndex: "0",
        ledgerHeight: "101",
        blockHash: uniqueHash("deposit-while-recovery-paused-block"),
        observedAt: new Date(NOW.getTime() + 2_350),
        now: new Date(NOW.getTime() + 2_350),
      },
    );
    assert.equal(pausedAllocation.status, "pending");
    assert.equal(
      pausedAllocation.targetReceiveSessionId,
      recoveryReleaseSession.snapshot.session.receiveSessionId,
      "a transfer sent to a paused recovery address must still bind to its owner instead of being quarantined",
    );
  } finally {
    await pausedRecoveryAllocationClient.query("rollback");
    pausedRecoveryAllocationClient.release();
  }
  const freshRecoveryVariant = {
    ...recoveryVariant,
    observation: {
      ...recoveryVariant.observation,
      payload: {
        ...recoveryVariant.observation.payload,
        eventCursorBlock: "101",
      },
    },
  } as const;
  const afterRecoverySession = await createOrReuseFundingReceiveSession(pool, {
    ...recoveryReleaseInput,
    observationVariants: [freshRecoveryVariant],
    ownerChannel: "telegram",
    now: new Date(NOW.getTime() + 2_400),
  });
  assert.notEqual(
    afterRecoverySession.snapshot.session.receiveSessionId,
    recoveryReleaseSession.snapshot.session.receiveSessionId,
    "a recovery-required receipt must not block a fresh deposit session",
  );
  const recoveryStillVisible = await fetchFundingReceiveSessionForUser(pool, {
    userId: recoveryReleaseUserId,
    receiveSessionId: recoveryReleaseSession.snapshot.session.receiveSessionId,
  });
  assert.equal(recoveryStillVisible?.session.status, "recovery_required");
  assert.ok(
    recoveryStillVisible?.session.closedAt,
    "opening a successor must durably mark the paused predecessor as released",
  );
  const allocationClient = await pool.connect();
  try {
    await allocationClient.query("begin");
    const freshAllocation = await claimFundingReceiveCanonicalEventAllocation(
      allocationClient,
      {
        networkId: recoveryVariant.networkId,
        asset: recoveryVariant.asset,
        destinationAddress: recoveryVariant.destinationAddress,
        sourceAddress: "0x1111111111111111111111111111111111111111",
        rawAmount: "2000000",
        transactionHash: uniqueHash("post-recovery-fresh-deposit"),
        eventIndex: "0",
        ledgerHeight: "102",
        blockHash: uniqueHash("post-recovery-fresh-block"),
        observedAt: new Date(NOW.getTime() + 2_500),
        now: new Date(NOW.getTime() + 2_500),
      },
    );
    assert.equal(
      freshAllocation.targetReceiveSessionId,
      afterRecoverySession.snapshot.session.receiveSessionId,
      "a later deposit must bind to the fresh session, not the paused recovery",
    );
  } finally {
    await allocationClient.query("rollback");
    allocationClient.release();
  }

  assert.equal(
    (
      await cancelFundingReceiveSessionForUser(pool, {
        userId: recoveryReleaseUserId,
        ownerChannel: "telegram",
        receiveSessionId:
          afterRecoverySession.snapshot.session.receiveSessionId,
        now: new Date(NOW.getTime() + 2_550),
      })
    )?.session.status,
    "cancelled",
  );
  await pool.query(
    `update funding_receive_sessions successor_session
        set created_at = predecessor_session.created_at - interval '1 second'
       from funding_receive_sessions predecessor_session
      where successor_session.id = $1
        and predecessor_session.id = $2`,
    [
      afterRecoverySession.snapshot.session.receiveSessionId,
      recoveryReleaseSession.snapshot.session.receiveSessionId,
    ],
  );
  const recoveryReleaseReceipt = await pool.query<{ id: string }>(
    `update funding_receive_receipts
        set status = 'routing', updated_at = $2
      where receive_session_id = $1
        and status = 'recovery_required'
      returning id`,
    [
      recoveryReleaseSession.snapshot.session.receiveSessionId,
      new Date(NOW.getTime() + 2_560),
    ],
  );
  const recoveryReleaseReceiptId = recoveryReleaseReceipt.rows[0]?.id;
  assert.ok(recoveryReleaseReceiptId);
  await pool.query(
    `update funding_receive_sessions
        set status = 'processing', updated_at = $2, version = version + 1
      where id = $1`,
    [
      recoveryReleaseSession.snapshot.session.receiveSessionId,
      new Date(NOW.getTime() + 2_560),
    ],
  );
  assert.equal(
    await settleFundingReceiveReceiptRouting(pool, {
      receiptId: recoveryReleaseReceiptId,
      receiveSessionId:
        recoveryReleaseSession.snapshot.session.receiveSessionId,
      userId: recoveryReleaseUserId,
      status: "ready",
      now: new Date(NOW.getTime() + 2_570),
    }),
    true,
  );
  assert.equal(
    (
      await fetchFundingReceiveSessionForUser(pool, {
        userId: recoveryReleaseUserId,
        receiveSessionId:
          recoveryReleaseSession.snapshot.session.receiveSessionId,
      })
    )?.session.status,
    "completed",
    "old recovery work must not resurrect after its newer session has already been cancelled",
  );

  lateClosedReleaseUserId = await insertUser();
  const lateClosedInput = {
    ...sessionInput(lateClosedReleaseUserId),
    requireExactReceiveScope: true,
  } as const;
  const lateClosedSession = await createOrReuseFundingReceiveSession(
    pool,
    lateClosedInput,
  );
  const lateClosedReceipt = await insertFundingReceiveReceipt(pool, {
    receiveSessionId: lateClosedSession.snapshot.session.receiveSessionId,
    userId: lateClosedReleaseUserId,
    variantId: lateClosedInput.observationVariants[0].variantId,
    asset: lateClosedInput.destinationAsset,
    destinationAddress:
      lateClosedInput.observationVariants[0].destinationAddress,
    rawAmount: "1",
    observationRevision: "late_closed_routing_receipt_12345678",
    observedAt: new Date(NOW.getTime() + 2_580),
    status: "routing",
    handling: "automatic_conversion",
    evidence: { lateReceipt: true, test: "late_closed_release" },
    now: new Date(NOW.getTime() + 2_580),
  });
  await pool.query(
    `update funding_receive_sessions
        set status = 'recovery_required',
            closed_at = null,
            updated_at = $2,
            version = version + 1
      where id = $1`,
    [
      lateClosedSession.snapshot.session.receiveSessionId,
      new Date(NOW.getTime() + 2_580),
    ],
  );
  assert.equal(
    await settleFundingReceiveReceiptRouting(pool, {
      receiptId: lateClosedReceipt.receipt.receiptId,
      receiveSessionId: lateClosedSession.snapshot.session.receiveSessionId,
      userId: lateClosedReleaseUserId,
      status: "ready",
      now: new Date(NOW.getTime() + 2_590),
    }),
    true,
  );
  assert.equal(
    (
      await fetchFundingReceiveSessionForUser(pool, {
        userId: lateClosedReleaseUserId,
        receiveSessionId: lateClosedSession.snapshot.session.receiveSessionId,
      })
    )?.session.status,
    "completed",
    "legacy late-receipt evidence must prevent a formerly closed address from reopening even when closed_at was lost",
  );

  sameChannelLeaseUserId = await insertUser();
  const sameChannelLeaseInput = sessionInput(sameChannelLeaseUserId);
  const sameChannelLeaseSession = await createOrReuseFundingReceiveSession(
    pool,
    sameChannelLeaseInput,
  );
  await insertFundingReceiveReceipt(pool, {
    receiveSessionId: sameChannelLeaseSession.snapshot.session.receiveSessionId,
    userId: sameChannelLeaseUserId,
    variantId: sameChannelLeaseInput.observationVariants[0].variantId,
    asset: sameChannelLeaseInput.observationVariants[0].asset,
    destinationAddress:
      sameChannelLeaseInput.observationVariants[0].destinationAddress,
    rawAmount: "1",
    observationRevision: "same_channel_recovery_receipt_12345678",
    observedAt: new Date(NOW.getTime() + 2_510),
    status: "recovery_required",
    handling: "automatic_conversion",
    evidence: { test: "same_channel_mixed_receipts" },
    now: new Date(NOW.getTime() + 2_510),
  });
  await insertFundingReceiveReceipt(pool, {
    receiveSessionId: sameChannelLeaseSession.snapshot.session.receiveSessionId,
    userId: sameChannelLeaseUserId,
    variantId: sameChannelLeaseInput.observationVariants[0].variantId,
    asset: sameChannelLeaseInput.observationVariants[0].asset,
    destinationAddress:
      sameChannelLeaseInput.observationVariants[0].destinationAddress,
    rawAmount: "2",
    observationRevision: "same_channel_routing_receipt_12345678",
    observedAt: new Date(NOW.getTime() + 2_520),
    status: "routing",
    handling: "automatic_conversion",
    evidence: { test: "same_channel_mixed_receipts" },
    now: new Date(NOW.getTime() + 2_520),
  });
  await pool.query(
    `update funding_receive_sessions
        set status = 'recovery_required',
            updated_at = $2,
            version = version + 1
      where id = $1`,
    [
      sameChannelLeaseSession.snapshot.session.receiveSessionId,
      new Date(NOW.getTime() + 2_530),
    ],
  );
  const replayedMixedRecovery = await createOrReuseFundingReceiveSession(pool, {
    ...sameChannelLeaseInput,
    policyRevision: "same_channel_changed_policy_12345678",
    now: new Date(NOW.getTime() + 2_540),
  });
  assert.equal(replayedMixedRecovery.replayed, true);
  assert.equal(
    replayedMixedRecovery.snapshot.session.receiveSessionId,
    sameChannelLeaseSession.snapshot.session.receiveSessionId,
    "a same-channel legacy open must not bypass a routing receipt hidden by aggregate recovery",
  );
  await pool.query(
    `update funding_receive_sessions
        set status = 'expired',
            closed_at = $2,
            updated_at = $2,
            version = version + 1
      where id = $1`,
    [
      sameChannelLeaseSession.snapshot.session.receiveSessionId,
      new Date(NOW.getTime() + 2_550),
    ],
  );
  const replayedClosedRouting = await createOrReuseFundingReceiveSession(pool, {
    ...sameChannelLeaseInput,
    policyRevision: "same_channel_closed_policy_12345678",
    now: new Date(NOW.getTime() + 2_560),
  });
  assert.equal(replayedClosedRouting.replayed, true);
  assert.equal(
    replayedClosedRouting.snapshot.session.receiveSessionId,
    sameChannelLeaseSession.snapshot.session.receiveSessionId,
    "a closed session keeps the same-channel selection lease while its receipt is routing",
  );

  expiredReviewSelectionUserId = await insertUser();
  const expiredReviewInput = sessionInput(expiredReviewSelectionUserId);
  const expiredReviewSession = await createOrReuseFundingReceiveSession(pool, {
    ...expiredReviewInput,
    requireExactReceiveScope: true,
  });
  await insertFundingReceiveReceipt(pool, {
    receiveSessionId: expiredReviewSession.snapshot.session.receiveSessionId,
    userId: expiredReviewSelectionUserId,
    variantId: expiredReviewInput.observationVariants[0].variantId,
    asset: expiredReviewInput.observationVariants[0].asset,
    destinationAddress:
      expiredReviewInput.observationVariants[0].destinationAddress,
    rawAmount: "3000000",
    observationRevision: "expired_review_selection_12345678",
    observedAt: new Date(NOW.getTime() + 2_570),
    status: "review_required",
    handling: "review_required",
    evidence: {
      reviewContinuation: {
        version: 1,
        kind: "convert",
        label: "Convert",
        confirmation: "fresh_quote",
      },
      reviewQuotePlan: {
        version: 1,
        confirmedSourceAmount: null,
        requestedDestinationAmount: {
          asset: expiredReviewInput.destinationAsset,
          raw: "3000000",
        },
        venuePreparation: false,
      },
    },
    now: new Date(NOW.getTime() + 2_570),
  });
  await pool.query(
    `update funding_receive_sessions
        set status = 'expired',
            closed_at = $2,
            expires_at = $2,
            updated_at = $2,
            version = version + 1
      where id = $1`,
    [
      expiredReviewSession.snapshot.session.receiveSessionId,
      new Date(NOW.getTime() + 2_580),
    ],
  );
  const expiredReviewOriginalTarget = expiredReviewInput.receiveTargets[0];
  const expiredReviewOriginalVariant =
    expiredReviewInput.observationVariants[0];
  const expiredReviewAlternateAsset = {
    ...expiredReviewOriginalVariant.asset,
    assetId: "0x9876987698769876987698769876987698769876",
  } as const;
  const expiredReviewAlternateTarget = {
    ...expiredReviewOriginalTarget,
    receiveTargetId: "receive_target_after_expired_review_12345678",
    acceptedAssets: [
      { asset: expiredReviewAlternateAsset, handling: "direct" as const },
    ],
  } as const;
  const expiredReviewAlternateVariant = {
    ...expiredReviewOriginalVariant,
    variantId: "variant_after_expired_review_12345678",
    asset: expiredReviewAlternateAsset,
  } as const;
  const afterExpiredReview = await createOrReuseFundingReceiveSession(pool, {
    ...expiredReviewInput,
    receiveTargets: [expiredReviewAlternateTarget],
    observationVariants: [expiredReviewAlternateVariant],
    selectedReceiveTargetId: expiredReviewAlternateTarget.receiveTargetId,
    requireExactReceiveScope: true,
    now: new Date(NOW.getTime() + 2_590),
  });
  assert.equal(afterExpiredReview.replayed, false);
  assert.notEqual(
    afterExpiredReview.snapshot.session.receiveSessionId,
    expiredReviewSession.snapshot.session.receiveSessionId,
    "an expired review-required receipt remains resumable by id but cannot cause receive_session_selection_conflict for Start new deposit",
  );

  pollingFairnessUserId = await insertUser();
  const pollingSessions: Array<{
    receiveSessionId: string;
    status: "open" | "recovery_required" | "cancelled";
  }> = [];
  for (const [status, count] of [
    ["open", 1],
    ["recovery_required", 1],
    ["cancelled", 1],
  ] as const) {
    for (let index = 0; index < count; index += 1) {
      const suffix = `${status}_${index}`;
      const pollingSession = await createOrReuseFundingReceiveSession(pool, {
        ...sessionInput(pollingFairnessUserId),
        destinationOptionId: `destination_polling_${suffix}_${RUN_ID}`,
        venueBindingOptionId: `binding_polling_${suffix}_${RUN_ID}`,
        ownerChannel: "web",
      });
      const receiveSessionId = pollingSession.snapshot.session.receiveSessionId;
      await pool.query(
        `update funding_receive_sessions
            set status = $2,
                closed_at = case
                  when $2 = 'cancelled' then $3::timestamptz
                  else null
                end,
                last_observed_at = $4,
                observation_requested_at = $3,
                updated_at = $3,
                version = version + 1
          where id = $1`,
        [
          receiveSessionId,
          status,
          new Date(NOW.getTime() + 2_600),
          new Date(NOW.getTime() - 24 * 60 * 60_000),
        ],
      );
      pollingSessions.push({ receiveSessionId, status });
    }
  }
  const pollingStatusById = new Map(
    pollingSessions.map((entry) => [entry.receiveSessionId, entry.status]),
  );
  const fairClaimStatuses: string[] = [];
  for (let claimIndex = 0; claimIndex < 20; claimIndex += 1) {
    const fairClaim = await claimObservableFundingReceiveSessions(pool, {
      limit: 1,
      minimumPollIntervalMs: 1_000,
      inactivePollIntervalMs: 1_000,
      closedPollIntervalMs: 1_000,
      now: new Date(NOW.getTime() + 2_700),
    });
    const status = fairClaim[0]
      ? pollingStatusById.get(fairClaim[0].session.receiveSessionId)
      : null;
    if (status) fairClaimStatuses.push(status);
    if (new Set(fairClaimStatuses).size === 3) break;
  }
  assert.deepEqual(
    [...new Set(fairClaimStatuses)],
    ["open", "recovery_required", "cancelled"],
    "deadline scheduling must make every observer class progress within a bounded number of limit=1 claims",
  );

  const continuouslyWokenSession = await createOrReuseFundingReceiveSession(
    pool,
    {
      ...sessionInput(pollingFairnessUserId),
      destinationOptionId: `destination_continuous_wake_${RUN_ID}`,
      venueBindingOptionId: `binding_continuous_wake_${RUN_ID}`,
      ownerChannel: "web",
      now: new Date(NOW.getTime() + 2_790),
    },
  );
  const overdueClosedSession = await createOrReuseFundingReceiveSession(pool, {
    ...sessionInput(pollingFairnessUserId),
    destinationOptionId: `destination_overdue_closed_${RUN_ID}`,
    venueBindingOptionId: `binding_overdue_closed_${RUN_ID}`,
    ownerChannel: "web",
    now: new Date(NOW.getTime() + 2_780),
  });
  await pool.query(
    `update funding_receive_sessions
        set status = 'cancelled',
            closed_at = $2,
            last_observed_at = $3,
            observation_requested_at = null,
            updated_at = $2,
            version = version + 1
      where id = $1`,
    [
      overdueClosedSession.snapshot.session.receiveSessionId,
      new Date(NOW.getTime() + 2_795),
      new Date(NOW.getTime() - 24 * 60 * 60_000),
    ],
  );
  const wakeCannotStarveOverdue = await claimObservableFundingReceiveSessions(
    pool,
    {
      limit: 1,
      minimumPollIntervalMs: 1_000,
      inactivePollIntervalMs: 1_000,
      closedPollIntervalMs: 1_000,
      now: new Date(NOW.getTime() + 2_800),
    },
  );
  assert.equal(
    wakeCannotStarveOverdue[0]?.session.receiveSessionId,
    overdueClosedSession.snapshot.session.receiveSessionId,
    "a continuously eligible fresh wake must not starve an older overdue late-observation session at limit=1",
  );
  assert.notEqual(
    wakeCannotStarveOverdue[0]?.session.receiveSessionId,
    continuouslyWokenSession.snapshot.session.receiveSessionId,
  );

  genericOptionUserId = await insertUser();
  const genericInput = sessionInput(genericOptionUserId);
  const genericOpen = {
    ...genericInput,
    requireExactReceiveScope: true,
    openIdempotency: {
      key: "generic-receive-open-idempotency-12345678",
      requestFingerprint: "a".repeat(64),
    },
  } as const;
  const firstGeneric = await createOrReuseFundingReceiveSession(
    pool,
    genericOpen,
  );
  const replayedGeneric = await createOrReuseFundingReceiveSession(
    pool,
    genericOpen,
  );
  assert.equal(replayedGeneric.replayed, true);
  assert.equal(
    replayedGeneric.snapshot.session.receiveSessionId,
    firstGeneric.snapshot.session.receiveSessionId,
  );
  const expiredTokenReplay = await replayFundingReceiveSessionOpenIdempotency(
    pool,
    {
      userId: genericOptionUserId,
      ownerChannel: "web",
      idempotencyKey: genericOpen.openIdempotency.key,
      requestFingerprint: genericOpen.openIdempotency.requestFingerprint,
      now: NOW,
    },
  );
  assert.equal(
    expiredTokenReplay?.snapshot.session.receiveSessionId,
    firstGeneric.snapshot.session.receiveSessionId,
    "the durable open key must replay a created session after its option expires",
  );
  const attachedReplayKey = await createOrReuseFundingReceiveSession(pool, {
    ...genericOpen,
    openIdempotency: {
      key: "generic-receive-second-idempotency-12345678",
      requestFingerprint: genericOpen.openIdempotency.requestFingerprint,
    },
  });
  assert.equal(attachedReplayKey.replayed, true);
  assert.equal(
    attachedReplayKey.snapshot.session.receiveSessionId,
    firstGeneric.snapshot.session.receiveSessionId,
    "an exact option with a new caller key must record that key on the same session",
  );

  // Reproduce the former replay/fresh-open deadlock deterministically. The
  // fresh path owns the scope first; an idempotency replay must wait for that
  // scope without holding the old receive-session row lock.
  const scopeOwner = await pool.connect();
  let blockedReplay: ReturnType<
    typeof replayFundingReceiveSessionOpenIdempotency
  > | null = null;
  try {
    await scopeOwner.query("begin");
    await lockFundingReceiveSessionScope(scopeOwner, genericInput);
    blockedReplay = replayFundingReceiveSessionOpenIdempotency(pool, {
      userId: genericOptionUserId,
      ownerChannel: "web",
      idempotencyKey: genericOpen.openIdempotency.key,
      requestFingerprint: genericOpen.openIdempotency.requestFingerprint,
      now: NOW,
    });
    let replayIsWaitingForScope = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const { rows } = await pool.query<{ waiting: boolean }>(
        `select exists (
           select 1
           from pg_locks lock_row
           join pg_stat_activity activity
             on activity.pid = lock_row.pid
          where lock_row.locktype = 'advisory'
            and not lock_row.granted
            and activity.datname = current_database()
         ) as waiting`,
      );
      if (rows[0]?.waiting) {
        replayIsWaitingForScope = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(
      replayIsWaitingForScope,
      true,
      "the replay must reach the shared scope lock before the row-lock assertion",
    );
    await scopeOwner.query("set local lock_timeout = '500ms'");
    await scopeOwner.query(
      `select id
         from funding_receive_sessions
        where id = $1::uuid
        for update`,
      [firstGeneric.snapshot.session.receiveSessionId],
    );
    await scopeOwner.query("commit");
    const replayAfterScope = await blockedReplay;
    assert.equal(
      replayAfterScope?.snapshot.session.receiveSessionId,
      firstGeneric.snapshot.session.receiveSessionId,
    );
  } finally {
    await scopeOwner.query("rollback").catch(() => undefined);
    scopeOwner.release();
    await blockedReplay?.catch(() => undefined);
  }
  await assert.rejects(
    () =>
      createOrReuseFundingReceiveSession(pool, {
        ...genericOpen,
        openIdempotency: {
          ...genericOpen.openIdempotency,
          requestFingerprint: "b".repeat(64),
        },
      }),
    (error: unknown) =>
      error instanceof FundingReceiveSessionOpenIdempotencyConflictError,
  );

  const originalTarget = genericInput.receiveTargets[0];
  const originalVariant = genericInput.observationVariants[0];
  assert.ok(originalTarget);
  assert.ok(originalVariant);
  const alternateAsset = {
    ...genericInput.destinationAsset,
    assetId: "0xEfCdEfCdEfCdEfCdEfCdEfCdEfCdEfCdEfCdEfCd",
  } as const;
  const alternateTarget = {
    ...originalTarget,
    receiveTargetId: "receive_target_generic_alternate_12345678",
    acceptedAssets: [{ asset: alternateAsset, handling: "direct" as const }],
  } as const;
  const alternateVariant = {
    ...originalVariant,
    variantId: "ingress_variant_generic_alternate_12345678",
    asset: alternateAsset,
  } as const;
  await insertFundingReceiveReceipt(pool, {
    receiveSessionId: firstGeneric.snapshot.session.receiveSessionId,
    userId: genericOptionUserId,
    variantId: originalVariant.variantId,
    asset: genericInput.destinationAsset,
    destinationAddress: originalTarget.destinationAddress,
    rawAmount: "1",
    observationRevision: "generic_ready_observation_12345678",
    observedAt: new Date(NOW.getTime() + 500),
    status: "ready",
    handling: "direct",
    evidence: { test: "generic_ready_scope_replacement" },
    now: new Date(NOW.getTime() + 500),
  });
  const settledSessionClosedAt = new Date(NOW.getTime() + 600);
  await pool.query(
    `
      update funding_receive_sessions
      set status = 'expired',
          closed_at = $2,
          expires_at = $2,
          updated_at = $2,
          version = version + 1
      where id = $1
    `,
    [firstGeneric.snapshot.session.receiveSessionId, settledSessionClosedAt],
  );
  const alternateGeneric = await createOrReuseFundingReceiveSession(pool, {
    ...genericInput,
    now: settledSessionClosedAt,
    receiveTargets: [alternateTarget],
    observationVariants: [alternateVariant],
    selectedReceiveTargetId: alternateTarget.receiveTargetId,
    requireExactReceiveScope: true,
    openIdempotency: {
      key: "generic-receive-alternate-idempotency-12345678",
      requestFingerprint: "c".repeat(64),
    },
  });
  assert.equal(alternateGeneric.replayed, false);
  assert.notEqual(
    alternateGeneric.snapshot.session.receiveSessionId,
    firstGeneric.snapshot.session.receiveSessionId,
    "an expired session with a settled receipt must not block a new exact asset scope",
  );
  assert.equal(
    await updateFundingReceiveSessionObservation(pool, {
      receiveSessionId: alternateGeneric.snapshot.session.receiveSessionId,
      expectedVersion: alternateGeneric.snapshot.session.version,
      observationVariants: [alternateVariant],
      // The observed receipt, not aggregate recovery by itself, keeps this
      // generic exact selection bound while money is still in flight.
      status: "recovery_required",
      lastObservedAt: new Date(NOW.getTime() + 1_000),
      now: new Date(NOW.getTime() + 1_000),
    }),
    true,
  );
  await insertFundingReceiveReceipt(pool, {
    receiveSessionId: alternateGeneric.snapshot.session.receiveSessionId,
    userId: genericOptionUserId,
    variantId: alternateVariant.variantId,
    asset: alternateAsset,
    destinationAddress: alternateTarget.destinationAddress,
    rawAmount: "1",
    observationRevision: "generic_alternate_observation_12345678",
    observedAt: new Date(NOW.getTime() + 1_000),
    status: "observed",
    handling: "direct",
    evidence: { test: "generic_receive_scope" },
    now: new Date(NOW.getTime() + 1_000),
  });
  const postMoneyExpiry = new Date(NOW.getTime() + 86_401_000);
  await expireFundingReceiveSessions(pool, { now: postMoneyExpiry });
  await assert.rejects(
    () =>
      createOrReuseFundingReceiveSession(pool, {
        ...genericInput,
        now: postMoneyExpiry,
        expiresAt: new Date(postMoneyExpiry.getTime() + 86_400_000),
        observeUntil: new Date(postMoneyExpiry.getTime() + 8 * 86_400_000),
        requireExactReceiveScope: true,
        openIdempotency: {
          key: "generic-receive-conflict-idempotency-12345678",
          requestFingerprint: "d".repeat(64),
        },
      }),
    (error: unknown) =>
      error instanceof FundingReceiveSessionExactScopeConflictError &&
      error.activeReceiveSessionId ===
        alternateGeneric.snapshot.session.receiveSessionId,
  );
  await assert.rejects(
    () =>
      replayFundingReceiveSessionOpenIdempotency(pool, {
        userId: genericInput.userId,
        ownerChannel: "web",
        idempotencyKey: genericOpen.openIdempotency.key,
        requestFingerprint: genericOpen.openIdempotency.requestFingerprint,
        now: postMoneyExpiry,
      }),
    (error: unknown) =>
      error instanceof FundingReceiveSessionExactScopeConflictError &&
      error.activeReceiveSessionId ===
        alternateGeneric.snapshot.session.receiveSessionId,
    "an expired exact-option retry must not surface a replaced asset after its receipt boundary",
  );
  // The synthetic recovery state above exists only to exercise the
  // post-receipt selection guard; remove it before this integration's normal
  // observable-session assertions choose their fixture.
  await pool.query(
    `
      update funding_receive_sessions
      set status = 'cancelled',
          closed_at = $2::timestamptz,
          expires_at = $2::timestamptz,
          observe_until = $2::timestamptz + interval '1 millisecond',
          updated_at = $2::timestamptz,
          version = version + 1
      where id = $1
    `,
    [
      alternateGeneric.snapshot.session.receiveSessionId,
      new Date(NOW.getTime() + 1_001),
    ],
  );

  const [first, second] = await Promise.all([
    createOrReuseFundingReceiveSession(pool, sessionInput(userId)),
    createOrReuseFundingReceiveSession(pool, sessionInput(userId)),
  ]);

  assert.equal(
    first.snapshot.session.receiveSessionId,
    second.snapshot.session.receiveSessionId,
  );
  assert.deepEqual([first.replayed, second.replayed].sort(), [false, true]);

  const restored = await fetchFundingReceiveSessionForUser(pool, {
    userId,
    receiveSessionId: first.snapshot.session.receiveSessionId,
  });
  assert.equal(
    restored?.session.receiveSessionId,
    first.snapshot.session.receiveSessionId,
  );
  assert.equal(
    restored?.session.observeUntil,
    new Date(NOW.getTime() + 8 * 86_400_000).toISOString(),
  );
  assert.deepEqual(
    restored?.session.automationPolicy,
    sessionInput(userId).automationPolicy,
  );
  assert.deepEqual(restored?.session.methods, [
    {
      methodId: "receive_method_manual_12345678",
      kind: "manual",
      safeLabel: "Send crypto",
      ingress: sessionInput(userId).methods[0]?.ingress,
    },
  ]);

  const { rows: observationBeforeRows } = await pool.query<{
    last_observed_at: Date | null;
    version: number;
  }>(
    `select last_observed_at, version
       from funding_receive_sessions
      where id = $1::uuid`,
    [first.snapshot.session.receiveSessionId],
  );
  const observationBefore = observationBeforeRows[0];
  assert.ok(observationBefore);
  const noOpObservationAt = new Date(NOW.getTime() + 500);
  assert.equal(
    await updateFundingReceiveSessionObservation(pool, {
      receiveSessionId: first.snapshot.session.receiveSessionId,
      expectedVersion: observationBefore.version,
      observationVariants: sessionInput(userId).observationVariants,
      status: "open",
      lastObservedAt: noOpObservationAt,
      now: noOpObservationAt,
    }),
    true,
  );
  const { rows: observationAfterRows } = await pool.query<{
    last_observed_at: Date | null;
    version: number;
  }>(
    `select last_observed_at, version
       from funding_receive_sessions
      where id = $1::uuid`,
    [first.snapshot.session.receiveSessionId],
  );
  assert.equal(
    observationAfterRows[0]?.version,
    observationBefore.version,
    "an identical observation heartbeat must not invalidate semantic receive-version fences",
  );
  assert.equal(
    observationAfterRows[0]?.last_observed_at?.toISOString(),
    noOpObservationAt.toISOString(),
  );

  const recoveryAt = new Date(noOpObservationAt.getTime() + 1_000);
  assert.equal(
    await updateFundingReceiveSessionObservation(pool, {
      receiveSessionId: first.snapshot.session.receiveSessionId,
      expectedVersion: observationAfterRows[0]?.version ?? -1,
      observationVariants: sessionInput(userId).observationVariants,
      status: "recovery_required",
      lastObservedAt: recoveryAt,
      now: recoveryAt,
    }),
    true,
  );
  const recoveryClaimed = await claimObservableFundingReceiveSessions(pool, {
    limit: 1,
    minimumPollIntervalMs: 1_000,
    now: new Date(recoveryAt.getTime() + 61_000),
  });
  assert.equal(recoveryClaimed.length, 1);
  assert.equal(
    recoveryClaimed[0]?.session.status,
    "recovery_required",
    "a recoverable session must remain observable instead of becoming a permanent active shell",
  );

  const legacyAfterPresentationExpiry =
    await createOrReuseFundingReceiveSession(pool, {
      ...genericInput,
      policyRevision: "policy_revision_legacy_expiry_12345678",
      now: postMoneyExpiry,
      expiresAt: new Date(postMoneyExpiry.getTime() + 86_400_000),
      observeUntil: new Date(postMoneyExpiry.getTime() + 8 * 86_400_000),
    });
  assert.equal(
    legacyAfterPresentationExpiry.replayed,
    false,
    "legacy destination-scoped opens retain their expiry-based replacement behaviour",
  );
  await insertFundingReceiveReceipt(pool, {
    receiveSessionId:
      legacyAfterPresentationExpiry.snapshot.session.receiveSessionId,
    userId: genericOptionUserId,
    variantId: originalVariant.variantId,
    asset: genericInput.destinationAsset,
    destinationAddress: originalTarget.destinationAddress,
    rawAmount: "1",
    observationRevision: "legacy_open_receipt_observation_12345678",
    observedAt: postMoneyExpiry,
    status: "observed",
    handling: "direct",
    evidence: { test: "legacy_open_receipt" },
    now: postMoneyExpiry,
  });
  const legacyAfterOpenReceipt = await createOrReuseFundingReceiveSession(
    pool,
    {
      ...genericInput,
      policyRevision: "policy_revision_legacy_receipt_12345678",
      now: new Date(postMoneyExpiry.getTime() + 1_000),
      expiresAt: new Date(postMoneyExpiry.getTime() + 86_401_000),
      observeUntil: new Date(postMoneyExpiry.getTime() + 8 * 86_400_000),
    },
  );
  assert.equal(
    legacyAfterOpenReceipt.replayed,
    true,
    "an observed receipt retains the same in-flight session even if its aggregate status update is delayed",
  );

  const replacement = await createOrReuseFundingReceiveSession(pool, {
    ...sessionInput(userId),
    policyRevision: "policy_revision_receive_changed_12345678",
    now: new Date(NOW.getTime() + 1_000),
    expiresAt: new Date(NOW.getTime() + 86_401_000),
    observeUntil: new Date(NOW.getTime() + 8 * 86_400_000 + 1_000),
  });
  assert.equal(replacement.replayed, false);
  assert.notEqual(
    replacement.snapshot.session.receiveSessionId,
    first.snapshot.session.receiveSessionId,
  );

  const receiptIdentity = {
    receive_session_id: replacement.snapshot.session.receiveSessionId,
    user_id: userId,
    variant_id: "ingress_variant_persistence_12345678",
    network_id: "evm:137",
    asset_id: sessionInput(userId).destinationAsset.assetId.toLowerCase(),
    asset_decimals: 6,
    destination_address:
      sessionInput(userId).receiveTargets[0].destinationAddress.toLowerCase(),
    handling: "direct",
  };
  const matchesFrozenVariant = async (candidate: object): Promise<boolean> => {
    const { rows } = await pool.query<{ matches: boolean }>(
      `select funding_receive_receipt_matches_frozen_variant(
         jsonb_populate_record(null::funding_receive_receipts, $1::jsonb)
       ) as matches`,
      [JSON.stringify(candidate)],
    );
    return rows[0]?.matches === true;
  };
  assert.equal(await matchesFrozenVariant(receiptIdentity), true);
  assert.equal(
    await matchesFrozenVariant({
      ...receiptIdentity,
      asset_id: receiptIdentity.asset_id.replace(/^0x/u, "0X"),
    }),
    false,
    "malformed EVM-looking asset IDs must not alias a valid frozen asset",
  );
  const { rows: identityRows } = await pool.query<{
    evm_alias: boolean;
    malformed_exact: boolean;
    solana_exact: boolean;
  }>(
    `
      select
        funding_account_identifier_equal(
          'evm:137',
          '0xAbCdAbCdAbCdAbCdAbCdAbCdAbCdAbCdAbCdAbCd',
          '0xabcdabcdabcdabcdabcdabcdabcdabcdabcdabcd'
        ) as evm_alias,
        funding_account_identifier_equal(
          'evm:137',
          '0XAbCdAbCdAbCdAbCdAbCdAbCdAbCdAbCdAbCdAbCd',
          '0Xabcdabcdabcdabcdabcdabcdabcdabcdabcdabcd'
        ) as malformed_exact,
        funding_account_identifier_equal(
          'solana:mainnet',
          'So11111111111111111111111111111111111111112',
          'so11111111111111111111111111111111111111112'
        ) as solana_exact
    `,
  );
  assert.equal(identityRows[0]?.evm_alias, true);
  assert.equal(identityRows[0]?.malformed_exact, false);
  assert.equal(identityRows[0]?.solana_exact, false);

  const { rows } = await pool.query<{ status: string }>(
    `
      select status
      from funding_receive_sessions
      where id = $1
    `,
    [first.snapshot.session.receiveSessionId],
  );
  assert.equal(
    rows[0]?.status,
    "recovery_required",
    "the recovery observation window must stay live until its normal expiry",
  );

  const client = await pool.connect();
  try {
    await client.query("begin");
    const canonicalEvent = {
      transactionHash: uniqueHash("global-replay-transaction"),
      eventIndex: "7",
      ledgerHeight: "12345678",
      blockHash: uniqueHash("global-replay-block"),
      sourceAddress: "0x0000000000000000000000000000000000000003",
    };
    const firstReceipt = await insertFundingReceiveReceipt(client, {
      receiveSessionId: replacement.snapshot.session.receiveSessionId,
      userId,
      variantId: "ingress_variant_event_a_12345678",
      asset: sessionInput(userId).destinationAsset,
      destinationAddress:
        sessionInput(userId).receiveTargets[0].destinationAddress,
      rawAmount: "1000000",
      observationRevision: "evm_event_revision_a_12345678",
      canonicalEvent,
      observedAt: NOW,
      status: "ready",
      handling: "direct",
      evidence: { canonical: true },
      now: NOW,
    });
    const replay = await insertFundingReceiveReceipt(client, {
      receiveSessionId: replacement.snapshot.session.receiveSessionId,
      userId,
      variantId: "ingress_variant_event_b_12345678",
      asset: sessionInput(userId).destinationAsset,
      destinationAddress:
        sessionInput(userId).receiveTargets[0].destinationAddress,
      rawAmount: "1000000",
      observationRevision: "evm_event_revision_b_12345678",
      canonicalEvent,
      observedAt: NOW,
      status: "ready",
      handling: "direct",
      evidence: { canonical: true },
      now: NOW,
    });
    assert.equal(firstReceipt.replayed, false);
    assert.equal(replay.replayed, true);
    assert.equal(replay.receipt.receiptId, firstReceipt.receipt.receiptId);
  } finally {
    await client.query("rollback");
    client.release();
  }

  const firstRoutedReceipt = await pool.connect();
  let firstRoutedReceiptId: string;
  try {
    await firstRoutedReceipt.query("begin");
    const inserted = await insertFundingReceiveReceipt(firstRoutedReceipt, {
      receiveSessionId: replacement.snapshot.session.receiveSessionId,
      userId,
      variantId: "ingress_variant_multi_receipt_a_12345678",
      asset: sessionInput(userId).destinationAsset,
      destinationAddress:
        sessionInput(userId).receiveTargets[0].destinationAddress,
      rawAmount: "1000000",
      observationRevision: "evm_event_multi_receipt_a_12345678",
      canonicalEvent: {
        transactionHash: uniqueHash("first-routed-transaction"),
        eventIndex: "1",
        ledgerHeight: "12345679",
        blockHash: uniqueHash("first-routed-block"),
        sourceAddress: "0x0000000000000000000000000000000000000004",
      },
      observedAt: NOW,
      status: "observed",
      handling: "automatic_conversion",
      evidence: { canonical: true },
      now: NOW,
    });
    firstRoutedReceiptId = inserted.receipt.receiptId;
    await firstRoutedReceipt.query(
      `
        update funding_receive_receipts
        set status = 'routing'
        where id = $1
      `,
      [firstRoutedReceiptId],
    );
    await firstRoutedReceipt.query("commit");
  } catch (error) {
    await firstRoutedReceipt.query("rollback");
    throw error;
  } finally {
    firstRoutedReceipt.release();
  }

  await assert.rejects(
    settleFundingReceiveReceiptRouting(pool, {
      receiptId: firstRoutedReceiptId,
      receiveSessionId: replacement.snapshot.session.receiveSessionId,
      userId,
      childOperationId: crypto.randomUUID(),
      childOperationStatus: "failed",
      status: "review_required",
      now: new Date(NOW.getTime() + 1_500),
    }),
    /adapter review evidence/i,
  );
  assert.equal(
    await settleFundingReceiveReceiptRouting(pool, {
      receiptId: firstRoutedReceiptId,
      receiveSessionId: replacement.snapshot.session.receiveSessionId,
      userId,
      status: "ready",
      now: new Date(NOW.getTime() + 2_000),
    }),
    true,
  );
  const afterFirstReceipt = await fetchFundingReceiveSessionForUser(pool, {
    userId,
    receiveSessionId: replacement.snapshot.session.receiveSessionId,
  });
  assert.equal(
    afterFirstReceipt?.session.status,
    "open",
    "a routed receipt must not close an amount-free receive session",
  );

  const secondReceiptClient = await pool.connect();
  try {
    await secondReceiptClient.query("begin");
    const secondReceipt = await insertFundingReceiveReceipt(
      secondReceiptClient,
      {
        receiveSessionId: replacement.snapshot.session.receiveSessionId,
        userId,
        variantId: "ingress_variant_multi_receipt_b_12345678",
        asset: sessionInput(userId).destinationAsset,
        destinationAddress:
          sessionInput(userId).receiveTargets[0].destinationAddress,
        rawAmount: "2000000",
        observationRevision: "evm_event_multi_receipt_b_12345678",
        canonicalEvent: {
          transactionHash: uniqueHash("second-receipt-transaction"),
          eventIndex: "2",
          ledgerHeight: "12345680",
          blockHash: uniqueHash("second-receipt-block"),
          sourceAddress: "0x0000000000000000000000000000000000000005",
        },
        observedAt: new Date(NOW.getTime() + 3_000),
        status: "ready",
        handling: "direct",
        evidence: { canonical: true },
        now: new Date(NOW.getTime() + 3_000),
      },
    );
    assert.equal(secondReceipt.replayed, false);
    await secondReceiptClient.query("commit");
  } catch (error) {
    await secondReceiptClient.query("rollback");
    throw error;
  } finally {
    secondReceiptClient.release();
  }
  const { rows: multiReceiptRows } = await pool.query<{ count: string }>(
    `
      select count(*)::text as count
      from funding_receive_receipts
      where receive_session_id = $1
        and status = 'ready'
    `,
    [replacement.snapshot.session.receiveSessionId],
  );
  assert.equal(multiReceiptRows[0]?.count, "2");

  const reviewReceiptClient = await pool.connect();
  let reviewReceiptId = "";
  try {
    await reviewReceiptClient.query("begin");
    const reviewReceipt = await insertFundingReceiveReceipt(
      reviewReceiptClient,
      {
        receiveSessionId: replacement.snapshot.session.receiveSessionId,
        userId,
        variantId: "ingress_variant_review_receipt_12345678",
        asset: sessionInput(userId).destinationAsset,
        destinationAddress:
          sessionInput(userId).receiveTargets[0].destinationAddress,
        rawAmount: "3000000",
        observationRevision: "evm_event_review_receipt_12345678",
        canonicalEvent: {
          transactionHash: uniqueHash("review-receipt-transaction"),
          eventIndex: "3",
          ledgerHeight: "12345681",
          blockHash: uniqueHash("review-receipt-block"),
          sourceAddress: "0x0000000000000000000000000000000000000006",
        },
        observedAt: new Date(NOW.getTime() + 4_000),
        status: "review_required",
        handling: "review_required",
        evidence: { canonical: true },
        now: new Date(NOW.getTime() + 4_000),
      },
    );
    assert.equal(reviewReceipt.receipt.status, "review_required");
    assert.equal(reviewReceipt.receipt.handling, "review_required");
    await assert.rejects(
      recordFundingReceiveReceiptRoutingDisposition(pool, {
        receiptId: reviewReceipt.receipt.receiptId,
        receiveSessionId: replacement.snapshot.session.receiveSessionId,
        userId,
        disposition: "review_required",
        errorCode: "economic_review_required",
        now: new Date(NOW.getTime() + 3_500),
      }),
      /adapter continuation and quote plan/i,
    );
    reviewReceiptId = reviewReceipt.receipt.receiptId;
    await reviewReceiptClient.query("commit");
  } catch (error) {
    await reviewReceiptClient.query("rollback");
    throw error;
  } finally {
    reviewReceiptClient.release();
  }

  await pool.query(
    `
      update funding_receive_sessions
      set status = 'review_required'
      where id = $1
    `,
    [replacement.snapshot.session.receiveSessionId],
  );
  const reviewSnapshot = await fetchFundingReceiveSessionForUser(pool, {
    userId,
    receiveSessionId: replacement.snapshot.session.receiveSessionId,
  });
  assert.equal(reviewSnapshot?.session.status, "review_required");
  const routableReviews = await listFundingReceiveReceiptsForRouting(pool, {
    limit: 100,
    now: new Date(NOW.getTime() + 5_000),
  });
  assert.ok(
    routableReviews.some(
      (target) => target.receipt.receiptId === reviewReceiptId,
    ),
    "web review receipts without an adapter plan must reach the channel-neutral disposition resolver",
  );
  await pool.query(
    `
      update funding_receive_receipts
      set evidence = evidence || jsonb_build_object(
        'reviewContinuation', jsonb_build_object(
          'version', 2,
          'kind', 'convert',
          'label', 'Convert',
          'confirmation', 'fresh_quote'
        ),
        'reviewQuotePlan', jsonb_build_object(
          'version', 1,
          'confirmedSourceAmount', null,
          'requestedDestinationAmount', jsonb_build_object(
            'asset', jsonb_build_object(
              'networkId', 'evm:137',
              'assetId', 'malformed-plan',
              'decimals', -1
            ),
            'raw', '3000000'
          ),
          'venuePreparation', false
        )
      )
      where id = $1
    `,
    [reviewReceiptId],
  );
  const malformedReviews = await listFundingReceiveReceiptsForRouting(pool, {
    limit: 100,
    now: new Date(NOW.getTime() + 5_500),
  });
  assert.ok(
    malformedReviews.some(
      (target) => target.receipt.receiptId === reviewReceiptId,
    ),
    "present but structurally invalid review evidence must remain repairable",
  );
  assert.equal(
    await recordFundingReceiveReceiptRoutingDisposition(pool, {
      receiptId: reviewReceiptId,
      receiveSessionId: replacement.snapshot.session.receiveSessionId,
      userId,
      disposition: "review_required",
      errorCode: "economic_review_required",
      reviewContinuation: {
        version: 1,
        kind: "convert",
        label: "Convert",
        confirmation: "fresh_quote",
      },
      reviewQuotePlan: {
        version: 1,
        confirmedSourceAmount: null,
        requestedDestinationAmount: {
          asset: sessionInput(userId).destinationAsset,
          raw: "3000000",
        },
        venuePreparation: false,
      },
      now: new Date(NOW.getTime() + 6_000),
    }),
    true,
  );
  const reviewReceipts = await listFundingReceiveReceiptsForUser(pool, {
    userId,
    receiveSessionId: replacement.snapshot.session.receiveSessionId,
  });
  assert.ok(
    reviewReceipts.some(
      (receipt) =>
        receipt.status === "review_required" &&
        receipt.handling === "review_required" &&
        receipt.reviewContinuation?.version === 1 &&
        receipt.reviewQuotePlan?.version === 1,
    ),
  );
  const webReviewTarget = await fetchFundingReceiveReceiptForReview(pool, {
    userId,
    ownerChannel: "web",
    receiveSessionId: replacement.snapshot.session.receiveSessionId,
    receiptId: reviewReceiptId,
  });
  assert.ok(webReviewTarget);
  assert.equal(
    webReviewTarget.receiptVariantSnapshot,
    null,
    "review targets preserve an explicit null when no frozen variant matches",
  );
  assert.equal(
    await fetchFundingReceiveReceiptForReview(pool, {
      userId,
      ownerChannel: "telegram",
      receiveSessionId: replacement.snapshot.session.receiveSessionId,
      receiptId: reviewReceiptId,
    }),
    null,
    "a channel must never quote or commit another channel's receipt",
  );

  const concurrentStableReceiptClient = await pool.connect();
  let concurrentStableReceiptId = "";
  try {
    await concurrentStableReceiptClient.query("begin");
    const concurrentStableReceipt = await insertFundingReceiveReceipt(
      concurrentStableReceiptClient,
      {
        receiveSessionId: replacement.snapshot.session.receiveSessionId,
        userId,
        variantId: "ingress_variant_concurrent_stable_12345678",
        asset: sessionInput(userId).destinationAsset,
        destinationAddress:
          sessionInput(userId).receiveTargets[0].destinationAddress,
        rawAmount: "4000000",
        observationRevision: "evm_event_concurrent_stable_12345678",
        canonicalEvent: {
          transactionHash: uniqueHash("concurrent-stable-transaction"),
          eventIndex: "4",
          ledgerHeight: "12345682",
          blockHash: uniqueHash("concurrent-stable-block"),
          sourceAddress: "0x0000000000000000000000000000000000000007",
        },
        observedAt: new Date(NOW.getTime() + 5_000),
        status: "observed",
        handling: "automatic_conversion",
        evidence: { canonical: true },
        now: new Date(NOW.getTime() + 5_000),
      },
    );
    concurrentStableReceiptId = concurrentStableReceipt.receipt.receiptId;
    await concurrentStableReceiptClient.query(
      `
        update funding_receive_receipts
        set status = 'routing'
        where id = $1
      `,
      [concurrentStableReceiptId],
    );
    await concurrentStableReceiptClient.query("commit");
  } catch (error) {
    await concurrentStableReceiptClient.query("rollback");
    throw error;
  } finally {
    concurrentStableReceiptClient.release();
  }

  assert.equal(
    await settleFundingReceiveReceiptRouting(pool, {
      receiptId: concurrentStableReceiptId,
      receiveSessionId: replacement.snapshot.session.receiveSessionId,
      userId,
      status: "ready",
      now: new Date(NOW.getTime() + 6_000),
    }),
    true,
  );
  const afterConcurrentStableReceipt = await fetchFundingReceiveSessionForUser(
    pool,
    {
      userId,
      receiveSessionId: replacement.snapshot.session.receiveSessionId,
    },
  );
  assert.equal(
    afterConcurrentStableReceipt?.session.status,
    "review_required",
    "settling a stable receipt must not hide an unresolved volatile-asset review",
  );

  assert.ok(
    (await expireFundingReceiveSessions(pool, {
      now: new Date(NOW.getTime() + 86_402_000),
    })) >= 1,
    "the global expiry sweep must include this test's expired session",
  );
  const expiredProcessing = await fetchFundingReceiveSessionForUser(pool, {
    userId,
    receiveSessionId: replacement.snapshot.session.receiveSessionId,
  });
  assert.equal(expiredProcessing?.session.status, "expired");
  const expiredRecovery = await fetchFundingReceiveSessionForUser(pool, {
    userId,
    receiveSessionId: first.snapshot.session.receiveSessionId,
  });
  assert.equal(expiredRecovery?.session.status, "expired");
  mergeTargetId = await insertUser();
  const [sourceUser, targetUser] = await Promise.all([
    fetchUser(userId),
    fetchUser(mergeTargetId),
  ]);
  assert.ok(sourceUser);
  assert.ok(targetUser);
  await assert.rejects(
    mergeUsers(
      sourceUser,
      targetUser,
      { dryRun: false, keepSource: false },
      pool,
    ),
    (error: unknown) => {
      assert.ok(error instanceof FundingMergeConflictError);
      assert.ok(error.conflicts.receiveEvidence > 0);
      return true;
    },
  );
  const deletion = await AuthService.deleteUser(userId);
  assert.equal(deletion.disposition, "deactivated");
  assert.equal(deletion.activeMovement, true);
  assert.equal(deletion.privyDeletionAllowed, false);
  assert.ok(deletion.protectedReasons.includes("receive_evidence"));
  assert.ok(deletion.protectedReasons.includes("active_receive_session"));
  assert.ok(
    await fetchFundingReceiveSessionForUser(pool, {
      userId,
      receiveSessionId: replacement.snapshot.session.receiveSessionId,
    }),
    "account deletion must preserve receive sessions and receipts",
  );

  console.log(
    "[funding-receive-session-persistence-integration-tests] concurrent open, durable restore, global canonical-event replay, multi-receipt continuation, review-required persistence, policy replacement, late-window account retention, and active-session expiry passed",
  );
} finally {
  const cleanup = await pool.connect();
  try {
    await cleanup.query("begin");
    await cleanup.query("set local session_replication_role = replica");
    await cleanup.query(
      "delete from funding_receive_open_idempotency where user_id = $1",
      [userId],
    );
    await cleanup.query(
      "delete from funding_receive_receipts where user_id = $1",
      [userId],
    );
    await cleanup.query(
      "delete from funding_receive_sessions where user_id = $1",
      [userId],
    );
    await cleanup.query("delete from users where id = $1", [userId]);
    if (genericOptionUserId) {
      await cleanup.query(
        "delete from funding_receive_open_idempotency where user_id = $1",
        [genericOptionUserId],
      );
      await cleanup.query(
        "delete from funding_receive_receipts where user_id = $1",
        [genericOptionUserId],
      );
      await cleanup.query(
        "delete from funding_receive_sessions where user_id = $1",
        [genericOptionUserId],
      );
      await cleanup.query("delete from users where id = $1", [
        genericOptionUserId,
      ]);
    }
    if (retainedSolUserId) {
      await cleanup.query(
        "delete from funding_receive_receipts where user_id = $1",
        [retainedSolUserId],
      );
      await cleanup.query(
        "delete from funding_receive_sessions where user_id = $1",
        [retainedSolUserId],
      );
      await cleanup.query("delete from users where id = $1", [
        retainedSolUserId,
      ]);
    }
    if (historicalSolUserId) {
      await cleanup.query("delete from notifications where user_id = $1", [
        historicalSolUserId,
      ]);
      await cleanup.query(
        "delete from funding_receive_canonical_events where tx_hash = $1",
        [historicalSolTransactionHash],
      );
      await cleanup.query(
        "delete from funding_receive_receipts where user_id = $1",
        [historicalSolUserId],
      );
      await cleanup.query(
        "delete from funding_receive_sessions where user_id = $1",
        [historicalSolUserId],
      );
      await cleanup.query("delete from users where id = $1", [
        historicalSolUserId,
      ]);
    }
    if (crossChannelUserId) {
      await cleanup.query(
        "delete from funding_receive_receipts where user_id = $1",
        [crossChannelUserId],
      );
      await cleanup.query(
        "delete from funding_receive_sessions where user_id = $1",
        [crossChannelUserId],
      );
      await cleanup.query("delete from users where id = $1", [
        crossChannelUserId,
      ]);
    }
    if (reviewReleaseUserId) {
      await cleanup.query(
        "delete from funding_receive_receipts where user_id = $1",
        [reviewReleaseUserId],
      );
      await cleanup.query(
        "delete from funding_receive_sessions where user_id = $1",
        [reviewReleaseUserId],
      );
      await cleanup.query("delete from users where id = $1", [
        reviewReleaseUserId,
      ]);
    }
    if (recoveryReleaseUserId) {
      await cleanup.query(
        "delete from funding_receive_receipts where user_id = $1",
        [recoveryReleaseUserId],
      );
      await cleanup.query(
        "delete from funding_receive_sessions where user_id = $1",
        [recoveryReleaseUserId],
      );
      await cleanup.query("delete from users where id = $1", [
        recoveryReleaseUserId,
      ]);
    }
    if (lateClosedReleaseUserId) {
      await cleanup.query(
        "delete from funding_receive_receipts where user_id = $1",
        [lateClosedReleaseUserId],
      );
      await cleanup.query(
        "delete from funding_receive_sessions where user_id = $1",
        [lateClosedReleaseUserId],
      );
      await cleanup.query("delete from users where id = $1", [
        lateClosedReleaseUserId,
      ]);
    }
    if (pollingFairnessUserId) {
      await cleanup.query(
        "delete from funding_receive_sessions where user_id = $1",
        [pollingFairnessUserId],
      );
      await cleanup.query("delete from users where id = $1", [
        pollingFairnessUserId,
      ]);
    }
    if (sameChannelLeaseUserId) {
      await cleanup.query(
        "delete from funding_receive_receipts where user_id = $1",
        [sameChannelLeaseUserId],
      );
      await cleanup.query(
        "delete from funding_receive_sessions where user_id = $1",
        [sameChannelLeaseUserId],
      );
      await cleanup.query("delete from users where id = $1", [
        sameChannelLeaseUserId,
      ]);
    }
    if (completedLifecycleUserId) {
      await cleanup.query(
        "delete from funding_receive_receipts where user_id = $1",
        [completedLifecycleUserId],
      );
      await cleanup.query(
        "delete from funding_receive_sessions where user_id = $1",
        [completedLifecycleUserId],
      );
      await cleanup.query("delete from users where id = $1", [
        completedLifecycleUserId,
      ]);
    }
    if (expiredReviewSelectionUserId) {
      await cleanup.query(
        "delete from funding_receive_receipts where user_id = $1",
        [expiredReviewSelectionUserId],
      );
      await cleanup.query(
        "delete from funding_receive_sessions where user_id = $1",
        [expiredReviewSelectionUserId],
      );
      await cleanup.query("delete from users where id = $1", [
        expiredReviewSelectionUserId,
      ]);
    }
    if (mergeTargetId) {
      await cleanup.query("delete from users where id = $1", [mergeTargetId]);
    }
    await cleanup.query("commit");
  } catch (error) {
    await cleanup.query("rollback");
    assert.fail(
      `receive-session test cleanup failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  } finally {
    cleanup.release();
  }
}
