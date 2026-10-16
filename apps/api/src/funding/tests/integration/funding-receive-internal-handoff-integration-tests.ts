#!/usr/bin/env tsx

// @api-integration

import assert from "node:assert/strict";
import { tx } from "@hunch/infra";
import crypto from "node:crypto";

import { ethers } from "ethers";

import "../../../integration-test-database-guard.js";
import { pool } from "../../../db.js";
import type { JsonObject } from "../../domain/types.js";
import {
  FundingPolymarketHandoffLookupOverflowError,
  type FundingPolymarketHandoffCandidate,
} from "../../persistence/funding-evidence-repository.js";
import {
  bindFundingReceiveCanonicalEventSession,
  claimFundingReceiveCanonicalEventAllocation,
  claimObservableFundingReceiveSessions,
  createOrReuseFundingReceiveSession,
  fetchFundingReceiveSessionForUser,
  requestFundingReceiveSessionObservation,
  quarantineFundingReceiveCanonicalInternalEvent,
} from "../../persistence/funding-receive-session-repository.js";
import {
  parseDirectIngressObservationVariant,
  type DirectIngressObservationVariant,
} from "../../reconciliation/direct-ingress-observer.js";
import type { FundingReceiveCanonicalEvent } from "../../receive/canonical-receive-event-scanner.js";
import { recordedRoleObserverFixture } from "../recorded-role-observer-fixture.js";
import { refundCanonicalEventKey } from "../../reconciliation/relay-exact-refund-classification.js";

const NOW = new Date("2026-07-31T15:15:00.000Z");
const SOURCE_ASSET = {
  networkId: "evm:137",
  assetId: "0x1111111111111111111111111111111111111111",
  decimals: 6,
} as const;
const DESTINATION_ASSET = {
  networkId: "evm:8453",
  assetId: "0x2222222222222222222222222222222222222222",
  decimals: 6,
} as const;
const FUNDER = "0x3333333333333333333333333333333333333333";
const RECIPIENT = "0x4444444444444444444444444444444444444444";
const AMOUNT_RAW = "8736244";
const TRANSACTION_HASH = `0x${crypto.randomBytes(32).toString("hex")}`;
const ERROR_TRANSACTION_HASH = `0x${crypto.randomBytes(32).toString("hex")}`;
const AMBIGUOUS_TRANSACTION_HASH = `0x${crypto.randomBytes(32).toString("hex")}`;
const HISTORICAL_INTERNAL_TRANSACTION_HASHES = Array.from(
  { length: 25 },
  () => `0x${crypto.randomBytes(32).toString("hex")}`,
);
const HISTORICAL_EXTERNAL_TRANSACTION_HASH = `0x${crypto.randomBytes(32).toString("hex")}`;
const LOOKUP_HMAC = crypto
  .createHash("sha256")
  .update("internal-handoff-reference")
  .digest("hex");
const TRANSFER_DATA = new ethers.Interface([
  "function transfer(address recipient,uint256 amount)",
]).encodeFunctionData("transfer", [RECIPIENT, BigInt(AMOUNT_RAW)]);

function opaque(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

async function insertUser(label: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `
      insert into users (email, is_active, is_verified)
      values ($1, true, true)
      returning id
    `,
    [`receive-handoff-${label}-${crypto.randomUUID()}@example.com`],
  );
  const userId = rows[0]?.id;
  if (!userId) throw new Error("receive handoff test user insert failed");
  return userId;
}

function sessionInput(userId: string, label: string) {
  const recipient = recipientForUser(userId);
  const variantId = opaque(`variant_${label}`);
  const receiveTargetId = opaque(`receive_target_${label}`);
  const destinationOptionId = opaque(`destination_${label}`);
  const venueBindingOptionId = opaque(`binding_${label}`);
  const destinationLocationId = opaque(`location_${label}`);
  const receiveTarget = {
    receiveTargetId,
    networkId: SOURCE_ASSET.networkId,
    destinationAddress: recipient,
    acceptedAssets: [
      {
        asset: SOURCE_ASSET,
        handling: "automatic_conversion" as const,
      },
    ],
    safeInstructions: ["Send only the displayed asset."],
  } as const;
  return {
    userId,
    venueId: "limitless",
    destinationOptionId,
    venueBindingOptionId,
    destinationAsset: DESTINATION_ASSET,
    destinationTargetSnapshot: { locationId: destinationLocationId },
    venueBindingSnapshot: { bindingId: venueBindingOptionId },
    methods: [
      {
        methodId: opaque(`method_${label}`),
        kind: "manual" as const,
        safeLabel: "Send crypto",
        ingress: {
          ingressKind: "manual" as const,
          sourceNetworkId: null,
          sourceAsset: null,
          receiveTargets: [receiveTarget],
          recommendedReceiveTargetId: receiveTargetId,
          destinationOptionId,
          destinationAddress: recipient,
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
        variantId,
        networkId: SOURCE_ASSET.networkId,
        asset: SOURCE_ASSET,
        destinationAddress: recipient,
        destinationLocationId,
        baselineRaw: "0",
        baselineRevision: opaque(`baseline_${label}`),
        observation: {
          adapterId: "owned_wallet_liquid_balances_v1",
          payload: {
            eventCursorBlock: "100",
            eventConfirmations: 2,
            eventIdentity: "evm_erc20_transfer_v1",
          },
        },
        completion: { kind: "child_funding_operation" as const },
      },
    ],
    selectedReceiveTargetId: receiveTargetId,
    automationPolicy: {
      stableConversion: "automatic_within_caps" as const,
      volatileConversion: "review_required" as const,
      maximumFeeUsd: "1",
      maximumFeeBps: 500,
      maximumSlippageBps: 100,
    },
    policyVersion: 1,
    policyRevision: opaque(`policy_${label}`),
    ownershipRevision: opaque(`ownership_${label}`),
    expiresAt: new Date(NOW.getTime() + 86_400_000),
    observeUntil: new Date(NOW.getTime() + 8 * 86_400_000),
    now: NOW,
    variantId,
  } as const;
}

const candidate: FundingPolymarketHandoffCandidate = {
  operationId: opaque("operation"),
  stepId: opaque("step"),
  attemptId: opaque("attempt"),
  attemptOutcome: "submitted",
  referenceKind: "transaction",
  resolvedTransactionHash: null,
  resolvedEventIndex: "2",
  receiptRefCiphertext: "encrypted_internal_handoff_reference",
  receiptRefLookupHmac: LOOKUP_HMAC,
  lookupKeyVersion: 1,
  normalizedAction: {
    kind: "external_handoff",
    actionId: opaque("action"),
    networkId: SOURCE_ASSET.networkId,
    actorWalletId: opaque("wallet"),
    handoffKind: "polymarket_deposit_wallet_transfer",
    payload: {
      topology: "deposit_wallet",
      funder: FUNDER,
      recipient: RECIPIENT,
      token: SOURCE_ASSET.assetId,
      amountRaw: AMOUNT_RAW,
      calls: [
        {
          target: SOURCE_ASSET.assetId,
          value: "0",
          data: TRANSFER_DATA,
        },
      ],
    },
  },
  actionValidationResult: {
    executionEnvelope: "polymarket_deposit_wallet_to_controller_v1",
    funderAddress: FUNDER,
    recipientAddress: RECIPIENT,
    tokenAddress: SOURCE_ASSET.assetId,
    amountRaw: AMOUNT_RAW,
    transferData: TRANSFER_DATA,
  },
};

function recipientForUser(userId: string): string {
  return `0x${crypto.createHash("sha256").update(userId).digest("hex").slice(0, 40)}`;
}

function candidateForUser(userId: string): FundingPolymarketHandoffCandidate {
  const recipient = recipientForUser(userId);
  const data = new ethers.Interface([
    "function transfer(address recipient,uint256 amount)",
  ]).encodeFunctionData("transfer", [recipient, BigInt(AMOUNT_RAW)]);
  return {
    ...candidate,
    normalizedAction: {
      ...candidate.normalizedAction,
      payload: {
        ...(candidate.normalizedAction.payload as JsonObject),
        recipient,
        calls: [{ target: SOURCE_ASSET.assetId, value: "0", data }],
      },
    },
    actionValidationResult: {
      ...candidate.actionValidationResult,
      recipientAddress: recipient,
      transferData: data,
    },
  };
}

function cursorVariant(
  variant: DirectIngressObservationVariant,
  eventCursorBlock: string,
): DirectIngressObservationVariant {
  return {
    ...variant,
    observation: {
      ...variant.observation,
      payload: {
        ...variant.observation.payload,
        eventCursorBlock,
      } as JsonObject,
    },
  };
}

function canonicalEvent(
  variant: DirectIngressObservationVariant,
  transactionHash: string,
): FundingReceiveCanonicalEvent {
  return {
    variant,
    transactionHash,
    eventIndex: "2",
    blockNumber: "101",
    blockHash: `0x${"ef".repeat(32)}`,
    sourceAddress: FUNDER,
    destinationAddress: variant.destinationAddress,
    rawAmount: AMOUNT_RAW,
    observedAt: new Date(NOW.getTime() + 6_000).toISOString(),
  };
}

const userIds: string[] = [];
const pendingHashes: string[] = [];
try {
  const userId = await insertUser("suppressed");
  userIds.push(userId);
  const input = sessionInput(userId, "suppressed");
  const created = await createOrReuseFundingReceiveSession(pool, input);
  const observer = recordedRoleObserverFixture({
    transactionReferenceCodec: {
      keyVersion: 1,
      fingerprint: () => LOOKUP_HMAC,
      decrypt: () => TRANSACTION_HASH,
    },
    relayReferenceCodec: {
      fingerprint: (reference) => `relay:${reference}`,
    },
    scanCanonicalEvents: async (variants) => {
      const variant = variants.find(
        (entry) => entry.variantId === input.variantId,
      );
      if (!variant) return null;
      return {
        events: [canonicalEvent(variant, TRANSACTION_HASH)],
        variants: variants.map((entry) =>
          entry.variantId === input.variantId
            ? cursorVariant(entry, "101")
            : entry,
        ),
        cursorAdvanced: true,
      };
    },
    listPotentialPolymarketHandoffs: async (_client, lookup) =>
      lookup.userId === userId ? [candidateForUser(userId)] : [],
  });
  const observed = await observer.pollBatch(pool, {
    limit: 25,
    minimumPollIntervalMs: 0,
    now: new Date(NOW.getTime() + 10_000),
  });
  assert.equal(observed.retryableErrors, 0);
  assert.equal(observed.receiptsRecorded, 0);
  const restored = await fetchFundingReceiveSessionForUser(pool, {
    userId,
    receiveSessionId: created.snapshot.session.receiveSessionId,
  });
  const restoredVariant = parseDirectIngressObservationVariant(
    restored?.observationVariants[0],
  );
  assert.equal(
    restoredVariant.observation.payload.eventCursorBlock,
    "101",
    "a suppressed internal event must still advance the durable cursor",
  );
  const { rows: suppressedRows } = await pool.query<{
    receipts: string;
    canonical_events: string;
    allocation_error_code: string | null;
  }>(
    `
      select
        (
          select count(*)::text
          from funding_receive_receipts
          where receive_session_id = $1
        ) as receipts,
        (
          select count(*)::text
          from funding_receive_canonical_events
          where tx_hash = $2
        ) as canonical_events,
        (
          select allocation_error_code
          from funding_receive_canonical_events
          where tx_hash = $2
          limit 1
        ) as allocation_error_code
    `,
    [created.snapshot.session.receiveSessionId, TRANSACTION_HASH],
  );
  assert.deepEqual(suppressedRows[0], {
    receipts: "0",
    canonical_events: "1",
    allocation_error_code: "internal_handoff_suppressed",
  });
  await pool.query(
    `
      update funding_receive_sessions
      set expires_at = $2,
          observe_until = $3
      where id = $1
    `,
    [
      created.snapshot.session.receiveSessionId,
      new Date(NOW.getTime() + 11_000),
      new Date(NOW.getTime() + 12_000),
    ],
  );

  const ambiguousUserId = await insertUser("ambiguous");
  userIds.push(ambiguousUserId);
  const ambiguousInput = sessionInput(ambiguousUserId, "ambiguous");
  const ambiguousSession = await createOrReuseFundingReceiveSession(
    pool,
    ambiguousInput,
  );
  const ambiguousObserver = recordedRoleObserverFixture({
    transactionReferenceCodec: {
      keyVersion: 1,
      fingerprint: () => LOOKUP_HMAC,
      decrypt: () => AMBIGUOUS_TRANSACTION_HASH,
    },
    scanCanonicalEvents: async (variants) => {
      const variant = variants.find(
        (entry) => entry.variantId === ambiguousInput.variantId,
      );
      if (!variant) return null;
      return {
        events: [canonicalEvent(variant, AMBIGUOUS_TRANSACTION_HASH)],
        variants: variants.map((entry) =>
          entry.variantId === ambiguousInput.variantId
            ? cursorVariant(entry, "101")
            : entry,
        ),
        cursorAdvanced: true,
      };
    },
    listPotentialPolymarketHandoffs: async () => [
      candidateForUser(ambiguousUserId),
      {
        ...candidateForUser(ambiguousUserId),
        attemptId: opaque("ambiguous_attempt"),
      },
    ],
  });
  const ambiguousObserved = await ambiguousObserver.pollBatch(pool, {
    limit: 25,
    minimumPollIntervalMs: 10_000,
    now: new Date(NOW.getTime() + 15_000),
  });
  assert.equal(ambiguousObserved.retryableErrors, 0);
  assert.equal(ambiguousObserved.receiptsRecorded, 0);
  assert.equal(ambiguousObserved.recoveriesRequired, 0);
  const { rows: ambiguousRows } = await pool.query<{
    session_status: string;
    receipt_count: string;
    allocation_error_code: string | null;
    event_cursor_block: string;
  }>(
    `
      select
        session.status as session_status,
        (
          select count(*)::text
          from funding_receive_receipts receipt
          where receipt.receive_session_id = session.id
        ) as receipt_count,
        (
          select allocation_error_code
          from funding_receive_canonical_events
          where tx_hash = $3
          limit 1
        ) as allocation_error_code,
        variant -> 'observation' -> 'payload' ->> 'eventCursorBlock'
          as event_cursor_block
      from funding_receive_sessions session
      cross join lateral jsonb_array_elements(session.observation_variants) variant
      where session.id = $1
        and variant ->> 'variantId' = $2
    `,
    [
      ambiguousSession.snapshot.session.receiveSessionId,
      ambiguousInput.variantId,
      AMBIGUOUS_TRANSACTION_HASH,
    ],
  );
  assert.deepEqual(ambiguousRows[0], {
    session_status: "open",
    receipt_count: "0",
    allocation_error_code: "handoff_candidate_ambiguity",
    event_cursor_block: "101",
  });

  const errorUserId = await insertUser("retry");
  userIds.push(errorUserId);
  const errorInput = sessionInput(errorUserId, "retry");
  const errorSession = await createOrReuseFundingReceiveSession(
    pool,
    errorInput,
  );
  const failingObserver = recordedRoleObserverFixture({
    transactionReferenceCodec: {
      keyVersion: 1,
      fingerprint: () => LOOKUP_HMAC,
      decrypt: () => ERROR_TRANSACTION_HASH,
    },
    scanCanonicalEvents: async (variants) => {
      const variant = variants.find(
        (entry) => entry.variantId === errorInput.variantId,
      );
      if (!variant) return null;
      return {
        events: [canonicalEvent(variant, ERROR_TRANSACTION_HASH)],
        variants: variants.map((entry) =>
          entry.variantId === errorInput.variantId
            ? cursorVariant(entry, "101")
            : entry,
        ),
        cursorAdvanced: true,
      };
    },
    listPotentialPolymarketHandoffs: async () => {
      throw new Error("simulated internal handoff lookup failure");
    },
  });
  const failed = await failingObserver.pollBatch(pool, {
    limit: 25,
    minimumPollIntervalMs: 10_000,
    now: new Date(NOW.getTime() + 20_000),
  });
  assert.ok(failed.retryableErrors >= 1);
  const afterFailure = await fetchFundingReceiveSessionForUser(pool, {
    userId: errorUserId,
    receiveSessionId: errorSession.snapshot.session.receiveSessionId,
  });
  const failedVariant = parseDirectIngressObservationVariant(
    afterFailure?.observationVariants[0],
  );
  assert.equal(
    failedVariant.observation.payload.eventCursorBlock,
    "100",
    "a DB classification failure must roll back the cursor update",
  );
  // Initial staging is now durable even when publication fails. Remove only
  // this synthetic lookup-failure case before the separate global backlog test;
  // otherwise its pending retry legitimately joins that test's first 25 rows.
  const failureEvent = (
    await pool.query(
      "select id from funding_receive_canonical_events where tx_hash=$1",
      [ERROR_TRANSACTION_HASH],
    )
  ).rows[0];
  assert.ok(failureEvent);
  await tx(pool, async (db) => {
    await db.query("set local session_replication_role=replica");
    await db.query(
      "delete from funding_receive_refund_candidates where event_id=$1",
      [failureEvent.id],
    );
    await db.query(
      "delete from funding_receive_refund_scans where event_id=$1",
      [failureEvent.id],
    );
    await db.query("delete from funding_receive_canonical_events where id=$1", [
      failureEvent.id,
    ]);
  });

  // Historical canonical events can be quarantined before an eligible
  // receive session exists. Prove that a full page of later-recognized Hunch
  // handoffs is retired from that retry page, allowing the external deposit
  // immediately behind it to progress on the next bounded poll.
  await pool.query(
    `update funding_receive_sessions
        set observe_until = $2,
            expires_at = least(
              expires_at,
              $2::timestamptz - interval '1 millisecond'
            ),
            updated_at = $2
      where user_id = any($1::uuid[])`,
    [userIds, new Date(NOW.getTime() + 29_000)],
  );
  const historicalBacklogUserId = await insertUser("historical-backlog");
  userIds.push(historicalBacklogUserId);
  const historicalBacklogInput = sessionInput(
    historicalBacklogUserId,
    "historical-backlog",
  );
  const historicalBacklogVariant = parseDirectIngressObservationVariant(
    historicalBacklogInput.observationVariants[0],
  );
  const historicalHashes = [
    ...HISTORICAL_INTERNAL_TRANSACTION_HASHES,
    HISTORICAL_EXTERNAL_TRANSACTION_HASH,
  ];
  const quarantineClient = await pool.connect();
  try {
    await quarantineClient.query("begin");
    for (const [eventIndex, transactionHash] of historicalHashes.entries()) {
      const quarantined = await claimFundingReceiveCanonicalEventAllocation(
        quarantineClient,
        {
          networkId: historicalBacklogVariant.networkId,
          asset: historicalBacklogVariant.asset,
          destinationAddress: historicalBacklogVariant.destinationAddress,
          sourceAddress: FUNDER,
          rawAmount: AMOUNT_RAW,
          transactionHash,
          eventIndex: "2",
          ledgerHeight: String(101 + eventIndex),
          blockHash: `0x${crypto.randomBytes(32).toString("hex")}`,
          observedAt: new Date(NOW.getTime() + 30_000 + eventIndex),
          now: new Date(NOW.getTime() + 30_000 + eventIndex),
        },
      );
      assert.equal(quarantined.status, "recovery_required");
      assert.equal(
        quarantined.errorCode,
        "receive_session_allocation_unavailable",
      );
    }
    await quarantineClient.query("commit");
  } catch (error) {
    await quarantineClient.query("rollback");
    throw error;
  } finally {
    quarantineClient.release();
  }
  const historicalBacklogSession = await createOrReuseFundingReceiveSession(
    pool,
    {
      ...historicalBacklogInput,
      now: new Date(NOW.getTime() + 31_000),
      expiresAt: new Date(NOW.getTime() + 86_431_000),
      observeUntil: new Date(NOW.getTime() + 8 * 86_400_000 + 31_000),
    },
  );
  const historicalHandoffCandidates =
    HISTORICAL_INTERNAL_TRANSACTION_HASHES.map(
      (transactionHash, candidateIndex): FundingPolymarketHandoffCandidate => ({
        ...candidateForUser(historicalBacklogUserId),
        attemptId: opaque(`historical_attempt_${candidateIndex}`),
        resolvedTransactionHash: transactionHash,
      }),
    );
  const historicalObserver = recordedRoleObserverFixture({
    transactionReferenceCodec: {
      keyVersion: 1,
      fingerprint: () => LOOKUP_HMAC,
      decrypt: () => HISTORICAL_EXTERNAL_TRANSACTION_HASH,
    },
    scanCanonicalEvents: async (variants) => ({
      events: [],
      variants,
      cursorAdvanced: false,
    }),
    listPotentialPolymarketHandoffs: async (_client, lookup) =>
      lookup.userId === historicalBacklogUserId
        ? historicalHandoffCandidates
        : [],
  });
  const historicalInternalPoll =
    await historicalObserver.pollKnownCanonicalRetryBatch(pool, {
      limit: 25,
      retryDelayMs: 1_000,
      now: new Date(NOW.getTime() + 32_000),
    });
  assert.equal(historicalInternalPoll.receiptsRecorded, 0);
  const { rows: historicalInternalRows } = await pool.query<{
    allocation_error_code: string;
    total: string;
  }>(
    `select allocation_error_code, count(*)::text as total
       from funding_receive_canonical_events
      where tx_hash = any($1::text[])
      group by allocation_error_code`,
    [HISTORICAL_INTERNAL_TRANSACTION_HASHES],
  );
  assert.deepEqual(historicalInternalRows, [
    { allocation_error_code: "internal_handoff_suppressed", total: "25" },
  ]);
  const historicalExternalPoll =
    await historicalObserver.pollKnownCanonicalRetryBatch(pool, {
      limit: 1,
      retryDelayMs: 1_000,
      now: new Date(NOW.getTime() + 34_000),
    });
  assert.equal(
    historicalExternalPoll.receiptsRecorded,
    1,
    "internal handoffs must not permanently hide the next external deposit behind the bounded recovery page",
  );
  const { rows: historicalExternalRows } = await pool.query<{
    allocated_receive_session_id: string | null;
    allocation_status: string;
  }>(
    `select allocation_status, allocated_receive_session_id
       from funding_receive_canonical_events
      where network_id = $1
        and tx_hash = $2
        and event_index = '2'`,
    [historicalBacklogVariant.networkId, HISTORICAL_EXTERNAL_TRANSACTION_HASH],
  );
  assert.deepEqual(historicalExternalRows[0], {
    allocated_receive_session_id:
      historicalBacklogSession.snapshot.session.receiveSessionId,
    allocation_status: "allocated",
  });

  const wakeUserId = await insertUser("interactive-wake");
  userIds.push(wakeUserId);
  const wakeInput = sessionInput(wakeUserId, "interactive-wake");
  const wakeSession = await createOrReuseFundingReceiveSession(pool, wakeInput);
  const createdWake = await pool.query<{
    observation_requested_at: Date | null;
    opened_at: Date;
  }>(
    `select opened_at, observation_requested_at
       from funding_receive_sessions
      where id = $1`,
    [wakeSession.snapshot.session.receiveSessionId],
  );
  assert.equal(
    createdWake.rows[0]?.observation_requested_at?.toISOString(),
    createdWake.rows[0]?.opened_at.toISOString(),
    "a new receive session requests its first observation at opened_at",
  );
  const wakeNow = new Date(NOW.getTime() + 2 * 60 * 60_000);
  await pool.query(
    `update funding_receive_sessions
        set observation_requested_at = null,
            last_observed_at = $2,
            updated_at = $2
      where id = $1`,
    [
      wakeSession.snapshot.session.receiveSessionId,
      new Date(wakeNow.getTime() - 30_000),
    ],
  );
  const coldBeforeWake = await claimObservableFundingReceiveSessions(pool, {
    limit: 100,
    minimumPollIntervalMs: 10_000,
    inactivePollIntervalMs: 60_000,
    activeWindowMs: 15 * 60_000,
    now: wakeNow,
  });
  assert.equal(
    coldBeforeWake.some(
      (entry) =>
        entry.session.receiveSessionId ===
        wakeSession.snapshot.session.receiveSessionId,
    ),
    false,
    "an old session stays on the inactive cadence before interaction",
  );
  assert.equal(
    await requestFundingReceiveSessionObservation(pool, {
      now: wakeNow,
      receiveSessionId: wakeSession.snapshot.session.receiveSessionId,
      userId: wakeUserId,
    }),
    true,
  );
  const claimedAfterWake = await claimObservableFundingReceiveSessions(pool, {
    limit: 1,
    minimumPollIntervalMs: 10_000,
    inactivePollIntervalMs: 60_000,
    activeWindowMs: 15 * 60_000,
    now: wakeNow,
  });
  assert.equal(
    claimedAfterWake.some(
      (entry) =>
        entry.session.receiveSessionId ===
        wakeSession.snapshot.session.receiveSessionId,
    ),
    true,
    "an interactive request is immediately eligible and prioritized within the batch limit",
  );
  assert.equal(
    await requestFundingReceiveSessionObservation(pool, {
      now: new Date(wakeNow.getTime() - 1_000),
      receiveSessionId: wakeSession.snapshot.session.receiveSessionId,
      userId: wakeUserId,
    }),
    true,
  );
  const monotonicWake = await pool.query<{
    observation_requested_at: Date | null;
  }>(
    `select observation_requested_at
       from funding_receive_sessions
      where id = $1`,
    [wakeSession.snapshot.session.receiveSessionId],
  );
  assert.equal(
    monotonicWake.rows[0]?.observation_requested_at?.toISOString(),
    wakeNow.toISOString(),
    "an older replay cannot move the observation request backward",
  );
  const claimedWhileHot = await claimObservableFundingReceiveSessions(pool, {
    limit: 100,
    minimumPollIntervalMs: 10_000,
    inactivePollIntervalMs: 60_000,
    activeWindowMs: 15 * 60_000,
    now: new Date(wakeNow.getTime() + 10_000),
  });
  assert.equal(
    claimedWhileHot.some(
      (entry) =>
        entry.session.receiveSessionId ===
        wakeSession.snapshot.session.receiveSessionId,
    ),
    true,
    "an interactively woken session stays on the hot cadence",
  );
  const coldAgainAt = new Date(wakeNow.getTime() + 15 * 60_000 + 1);
  await pool.query(
    `update funding_receive_sessions
        set last_observed_at = $2,
            updated_at = $2
      where id = $1`,
    [
      wakeSession.snapshot.session.receiveSessionId,
      new Date(coldAgainAt.getTime() - 30_000),
    ],
  );
  const coldAgain = await claimObservableFundingReceiveSessions(pool, {
    limit: 100,
    minimumPollIntervalMs: 10_000,
    inactivePollIntervalMs: 60_000,
    activeWindowMs: 15 * 60_000,
    now: coldAgainAt,
  });
  assert.equal(
    coldAgain.some(
      (entry) =>
        entry.session.receiveSessionId ===
        wakeSession.snapshot.session.receiveSessionId,
    ),
    false,
    "the session returns to the inactive cadence after the hot window",
  );
  await pool.query(
    `update funding_receive_sessions
        set status = 'cancelled',
            closed_at = $2,
            updated_at = $2
      where id = $1`,
    [wakeSession.snapshot.session.receiveSessionId, coldAgainAt],
  );
  assert.equal(
    await requestFundingReceiveSessionObservation(pool, {
      now: new Date(coldAgainAt.getTime() + 1),
      receiveSessionId: wakeSession.snapshot.session.receiveSessionId,
      userId: wakeUserId,
    }),
    false,
    "explicit observation requests never reopen a cancelled session",
  );

  // Known-event repair must survive the scan window and distinguish an exact
  // handoff from an independent same-envelope transfer. No second scan.
  const lateNow = new Date(NOW.getTime() + 10 * 86_400_000);
  for (const scenario of [
    "started-exact",
    "relayer-different",
    "decoder-recovery",
    "multiple-pending",
    "lookup-overflow",
    "handoff-route-pending",
    "both-internal",
    "route-handoff-pending",
    "conflict-external-recovery",
    "refund-handoff-conflict",
    "refund-destination-conflict",
    "refund-nonfinal",
    "refund-invalid",
    "refund-already-suppressed",
    "refund-correlation-internal",
    "refund-correlation-external",
  ] as const) {
    const pendingUserId = await insertUser(scenario);
    userIds.push(pendingUserId);
    const pendingInput = sessionInput(pendingUserId, scenario);
    const pendingSession = await createOrReuseFundingReceiveSession(
      pool,
      pendingInput,
    );
    const pendingHash = `0x${crypto.randomBytes(32).toString("hex")}`;
    pendingHashes.push(pendingHash);
    let scans = 0;
    let resolved = false;
    const roleConflict = [
      "handoff-route-pending",
      "both-internal",
      "route-handoff-pending",
      "conflict-external-recovery",
      "refund-handoff-conflict",
      "refund-destination-conflict",
    ].includes(scenario);
    const refundScenario = scenario.startsWith("refund-");
    const seededCorrelation = scenario.startsWith("refund-correlation-");
    const resolvesExternal =
      scenario === "relayer-different" ||
      scenario === "conflict-external-recovery" ||
      scenario === "refund-correlation-external";
    const pendingObserver = recordedRoleObserverFixture({
      relayReferenceCodec: { fingerprint: (value) => value },
      classifyRecordedRefunds: async (_client, lookup) => {
        if (
          !refundScenario ||
          lookup.userId !== pendingUserId ||
          (resolved && resolvesExternal)
        )
          return new Map();
        return new Map(
          lookup.events.map((event) => [
            refundCanonicalEventKey(event),
            !resolved && !roleConflict
              ? {
                  kind: "recovery_required" as const,
                  reason:
                    scenario === "refund-invalid"
                      ? ("exact_refund_receipt_conflict" as const)
                      : ("exact_refund_receipt_not_final" as const),
                }
              : {
                  kind: "internal" as const,
                  operationId: crypto.randomUUID(),
                  segmentId: crypto.randomUUID(),
                },
          ]),
        );
      },
      classifyOwnedRouteDestinations: async (_client, lookup) => {
        if (
          !roleConflict ||
          resolved ||
          lookup.userId !== pendingUserId ||
          scenario === "refund-handoff-conflict"
        )
          return new Map();
        return new Map(
          lookup.events.map((event) => [
            [event.networkId, event.transactionHash, event.eventIndex].join(
              ":",
            ),
            scenario === "both-internal" ||
            scenario === "route-handoff-pending" ||
            scenario === "refund-destination-conflict"
              ? {
                  kind: "internal" as const,
                  operationId: crypto.randomUUID(),
                  segmentId: crypto.randomUUID(),
                  transactionReferenceFingerprint: "fixture-role-conflict",
                }
              : {
                  kind: "recovery_required" as const,
                  reason:
                    "owned_route_destination_correlation_pending" as const,
                },
          ]),
        );
      },
      transactionReferenceCodec: {
        keyVersion: 1,
        fingerprint: () => "different-lookup-version",
        decrypt: () => {
          throw new Error("decoder temporarily unavailable");
        },
      },
      scanCanonicalEvents: async (variants) => {
        const variant = variants.find(
          (entry) => entry.variantId === pendingInput.variantId,
        );
        if (!variant) return null;
        scans++;
        return {
          events: [
            canonicalEvent(variant, pendingHash),
            ...(scenario === "multiple-pending"
              ? [{ ...canonicalEvent(variant, pendingHash), eventIndex: "3" }]
              : []),
          ],
          variants: variants.map((entry) =>
            entry.variantId === pendingInput.variantId
              ? cursorVariant(entry, "101")
              : entry,
          ),
          cursorAdvanced: true,
        };
      },
      listPotentialPolymarketHandoffs: async (_client, lookup) => {
        if (lookup.userId !== pendingUserId) return [];
        if (
          refundScenario &&
          (resolved || scenario !== "refund-handoff-conflict")
        )
          return [];
        if (scenario === "lookup-overflow" && !resolved)
          throw new FundingPolymarketHandoffLookupOverflowError();
        return [
          {
            ...candidateForUser(pendingUserId),
            attemptOutcome:
              scenario === "started-exact" || scenario === "multiple-pending"
                ? "started"
                : "submitted",
            referenceKind:
              scenario === "relayer-different"
                ? "external_handoff"
                : "transaction",
            receiptRefLookupHmac: null,
            receiptRefCiphertext:
              scenario === "decoder-recovery" ? "unavailable" : null,
            resolvedTransactionHash:
              resolved || (roleConflict && scenario !== "route-handoff-pending")
                ? resolved && resolvesExternal
                  ? `0x${"12".repeat(32)}`
                  : pendingHash
                : null,
            resolvedEventIndex:
              resolved || (roleConflict && scenario !== "route-handoff-pending")
                ? "2"
                : null,
          },
        ];
      },
    });
    // Exclude previous fixture sessions from the live observation selector.
    await pool.query(
      `update funding_receive_sessions
      set observe_until=$2,expires_at=least(expires_at,$2::timestamptz-interval '1 millisecond')
      where user_id=any($1::uuid[]) and id<>$3`,
      [
        userIds,
        new Date(NOW.getTime() + 50_000),
        pendingSession.snapshot.session.receiveSessionId,
      ],
    );
    if (scenario === "refund-already-suppressed" || seededCorrelation) {
      const variant = parseDirectIngressObservationVariant(
        pendingInput.observationVariants[0],
      );
      const event = canonicalEvent(variant, pendingHash);
      const canonicalInput = {
        ...event,
        networkId: variant.networkId,
        asset: variant.asset,
        ledgerHeight: event.blockNumber,
        observedAt: new Date(event.observedAt),
        now: new Date(NOW.getTime() + 60_000),
      };
      assert.equal(
        await quarantineFundingReceiveCanonicalInternalEvent(pool, {
          ...canonicalInput,
          reason: seededCorrelation
            ? "exact_refund_correlation_pending"
            : "internal_exact_refund_suppressed",
        }),
        true,
      );
      if (seededCorrelation) {
        // Exercise persistence/recovery without pretending the pending-source
        // runtime classifier is connected. A later worker supplies the resolved
        // role; the existing retry path must keep the original session binding.
        await bindFundingReceiveCanonicalEventSession(pool, canonicalInput);
      }
    }
    if (!seededCorrelation) {
      const pendingResult = await pendingObserver.pollBatch(pool, {
        limit: 100,
        minimumPollIntervalMs: 0,
        now: new Date(NOW.getTime() + 60_000),
      });
      assert.equal(pendingResult.retryableErrors, 0);
      assert.equal(pendingResult.receiptsRecorded, 0);
      assert.equal(scans, 1);
    }
    const before = (
      await pool.query(
        `select event_index,allocation_error_code,
      classification_receive_session_id,classification_variant_id
      from funding_receive_canonical_events where tx_hash=$1 order by event_index`,
        [pendingHash],
      )
    ).rows;
    const expectedPending = {
      allocation_error_code: seededCorrelation
        ? "exact_refund_correlation_pending"
        : roleConflict
          ? "internal_event_classification_conflict"
          : refundScenario
            ? scenario === "refund-invalid"
              ? "exact_refund_receipt_conflict"
              : "exact_refund_receipt_not_final"
            : scenario === "decoder-recovery"
              ? "handoff_reference_unavailable"
              : "handoff_correlation_pending",
      classification_receive_session_id:
        pendingSession.snapshot.session.receiveSessionId,
      classification_variant_id: pendingInput.variantId,
    };
    assert.deepEqual(before, [
      { event_index: "2", ...expectedPending },
      ...(scenario === "multiple-pending"
        ? [{ event_index: "3", ...expectedPending }]
        : []),
    ]);
    const beforeRetry = await fetchFundingReceiveSessionForUser(pool, {
      userId: pendingUserId,
      receiveSessionId: pendingSession.snapshot.session.receiveSessionId,
    });
    if (roleConflict || (refundScenario && !seededCorrelation)) {
      const stillConflicting =
        await pendingObserver.pollKnownCanonicalRetryBatch(pool, {
          limit: 100,
          retryDelayMs: 1000,
          now: lateNow,
        });
      assert.equal(stillConflicting.retryableErrors, 0);
      assert.equal(stillConflicting.receiptsRecorded, 0);
      const retained = (
        await pool.query(
          `select allocation_error_code,classification_receive_session_id,classification_retry_at
        from funding_receive_canonical_events where tx_hash=$1`,
          [pendingHash],
        )
      ).rows[0];
      assert.equal(
        retained.allocation_error_code,
        expectedPending.allocation_error_code,
      );
      assert.equal(
        retained.classification_receive_session_id,
        pendingSession.snapshot.session.receiveSessionId,
      );
      assert.ok(retained.classification_retry_at > lateNow);
    }
    resolved = true;
    const repaired = await pendingObserver.pollKnownCanonicalRetryBatch(pool, {
      limit: 100,
      retryDelayMs: 1000,
      now: new Date(lateNow.getTime() + 2000),
    });
    assert.equal(repaired.retryableErrors, 0);
    assert.equal(
      scans,
      seededCorrelation ? 0 : 1,
      "known-event retry cannot scan new history after expiry",
    );
    const after = (
      await pool.query(
        `select event_index,allocation_error_code,allocation_status,
      classification_lease_token,classification_retry_at from funding_receive_canonical_events where tx_hash=$1 order by event_index`,
        [pendingHash],
      )
    ).rows;
    const expectedAfter = {
      event_index: "2",
      allocation_error_code: resolvesExternal
        ? null
        : refundScenario
          ? "internal_exact_refund_suppressed"
          : "internal_handoff_suppressed",
      allocation_status: resolvesExternal ? "allocated" : "recovery_required",
      classification_lease_token: null,
      classification_retry_at: null,
    };
    assert.deepEqual(after, [
      expectedAfter,
      ...(scenario === "multiple-pending"
        ? [
            {
              event_index: "3",
              allocation_error_code: null,
              allocation_status: "allocated",
              classification_lease_token: null,
              classification_retry_at: null,
            },
          ]
        : []),
    ]);
    const afterRetry = await fetchFundingReceiveSessionForUser(pool, {
      userId: pendingUserId,
      receiveSessionId: pendingSession.snapshot.session.receiveSessionId,
    });
    assert.deepEqual(
      afterRetry?.observationVariants,
      beforeRetry?.observationVariants,
    );
    assert.equal(afterRetry?.session.status, beforeRetry?.session.status);
    assert.deepEqual(
      afterRetry?.session.observeUntil,
      beforeRetry?.session.observeUntil,
    );
    const receipts = (
      await pool.query(
        `select status,child_funding_operation_id,evidence->>'lateReceipt' as late_receipt,raw_amount::text
      from funding_receive_receipts where receive_session_id=$1`,
        [pendingSession.snapshot.session.receiveSessionId],
      )
    ).rows;
    assert.deepEqual(
      receipts,
      resolvesExternal || scenario === "multiple-pending"
        ? [
            {
              status: "recovery_required",
              child_funding_operation_id: null,
              late_receipt: "true",
              raw_amount: AMOUNT_RAW,
            },
          ]
        : [],
    );
  }

  console.log(
    "[funding-receive-internal-handoff-integration-tests] exact internal handoff suppression, cursor advancement, and DB-failure rollback passed",
  );
} finally {
  const cleanup = await pool.connect();
  try {
    await cleanup.query("begin");
    await cleanup.query("set local session_replication_role = replica");
    await cleanup.query(
      `delete from funding_receive_refund_candidates candidate_row
       using funding_receive_refund_scans scan_row
       where candidate_row.event_id=scan_row.event_id and scan_row.user_id=any($1::uuid[])`,
      [userIds],
    );
    await cleanup.query(
      "delete from funding_receive_refund_scans where user_id=any($1::uuid[])",
      [userIds],
    );
    await cleanup.query(
      "delete from funding_receive_receipts where user_id = any($1::uuid[])",
      [userIds],
    );
    await cleanup.query(
      "delete from funding_receive_canonical_events where tx_hash = any($1::text[])",
      [
        [
          TRANSACTION_HASH,
          ERROR_TRANSACTION_HASH,
          AMBIGUOUS_TRANSACTION_HASH,
          ...HISTORICAL_INTERNAL_TRANSACTION_HASHES,
          HISTORICAL_EXTERNAL_TRANSACTION_HASH,
          ...pendingHashes,
        ],
      ],
    );
    await cleanup.query(
      "delete from notifications where user_id = any($1::uuid[])",
      [userIds],
    );
    await cleanup.query(
      "delete from funding_receive_sessions where user_id = any($1::uuid[])",
      [userIds],
    );
    await cleanup.query("delete from users where id = any($1::uuid[])", [
      userIds,
    ]);
    await cleanup.query("commit");
  } catch (error) {
    await cleanup.query("rollback");
    assert.fail(
      `internal-handoff test cleanup failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  } finally {
    cleanup.release();
  }
}
