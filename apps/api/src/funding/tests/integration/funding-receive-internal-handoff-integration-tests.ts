#!/usr/bin/env tsx

// @api-integration

import assert from "node:assert/strict";
import crypto from "node:crypto";

import { ethers } from "ethers";

import "../../../integration-test-database-guard.js";
import { pool } from "../../../db.js";
import type { JsonObject } from "../../domain/types.js";
import type { FundingPolymarketHandoffCandidate } from "../../persistence/funding-evidence-repository.js";
import {
  claimObservableFundingReceiveSessions,
  createOrReuseFundingReceiveSession,
  fetchFundingReceiveSessionForUser,
  requestFundingReceiveSessionObservation,
} from "../../persistence/funding-receive-session-repository.js";
import {
  parseDirectIngressObservationVariant,
  type DirectIngressObservationVariant,
} from "../../reconciliation/direct-ingress-observer.js";
import type { FundingReceiveCanonicalEvent } from "../../receive/canonical-receive-event-scanner.js";
import { FundingReceiveSessionObserver } from "../../receive/receive-session-observer.js";

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
  const variantId = opaque(`variant_${label}`);
  const receiveTargetId = opaque(`receive_target_${label}`);
  const destinationOptionId = opaque(`destination_${label}`);
  const venueBindingOptionId = opaque(`binding_${label}`);
  const destinationLocationId = opaque(`location_${label}`);
  const receiveTarget = {
    receiveTargetId,
    networkId: SOURCE_ASSET.networkId,
    destinationAddress: RECIPIENT,
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
          destinationAddress: RECIPIENT,
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
        destinationAddress: RECIPIENT,
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
    destinationAddress: RECIPIENT,
    rawAmount: AMOUNT_RAW,
    observedAt: new Date(NOW.getTime() + 6_000).toISOString(),
  };
}

const userIds: string[] = [];
try {
  const userId = await insertUser("suppressed");
  userIds.push(userId);
  const input = sessionInput(userId, "suppressed");
  const created = await createOrReuseFundingReceiveSession(pool, input);
  const observer = new FundingReceiveSessionObserver({
    transactionReferenceCodec: {
      keyVersion: 1,
      fingerprint: () => LOOKUP_HMAC,
      decrypt: () => TRANSACTION_HASH,
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
      lookup.userId === userId ? [candidate] : [],
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
        ) as canonical_events
    `,
    [created.snapshot.session.receiveSessionId, TRANSACTION_HASH],
  );
  assert.deepEqual(suppressedRows[0], {
    receipts: "0",
    canonical_events: "0",
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
  const ambiguousObserver = new FundingReceiveSessionObserver({
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
      candidate,
      { ...candidate, attemptId: opaque("ambiguous_attempt") },
    ],
  });
  const ambiguousObserved = await ambiguousObserver.pollBatch(pool, {
    limit: 25,
    minimumPollIntervalMs: 10_000,
    now: new Date(NOW.getTime() + 15_000),
  });
  assert.equal(ambiguousObserved.retryableErrors, 0);
  assert.equal(ambiguousObserved.receiptsRecorded, 1);
  assert.equal(ambiguousObserved.recoveriesRequired, 1);
  const { rows: ambiguousRows } = await pool.query<{
    session_status: string;
    receipt_status: string;
    child_funding_operation_id: string | null;
    event_cursor_block: string;
  }>(
    `
      select
        session.status as session_status,
        receipt.status as receipt_status,
        receipt.child_funding_operation_id,
        variant -> 'observation' -> 'payload' ->> 'eventCursorBlock'
          as event_cursor_block
      from funding_receive_sessions session
      join funding_receive_receipts receipt
        on receipt.receive_session_id = session.id
      cross join lateral jsonb_array_elements(session.observation_variants) variant
      where session.id = $1
        and variant ->> 'variantId' = $2
    `,
    [
      ambiguousSession.snapshot.session.receiveSessionId,
      ambiguousInput.variantId,
    ],
  );
  assert.deepEqual(ambiguousRows[0], {
    session_status: "recovery_required",
    receipt_status: "recovery_required",
    child_funding_operation_id: null,
    event_cursor_block: "101",
  });

  const errorUserId = await insertUser("retry");
  userIds.push(errorUserId);
  const errorInput = sessionInput(errorUserId, "retry");
  const errorSession = await createOrReuseFundingReceiveSession(
    pool,
    errorInput,
  );
  const failingObserver = new FundingReceiveSessionObserver({
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

  console.log(
    "[funding-receive-internal-handoff-integration-tests] exact internal handoff suppression, cursor advancement, and DB-failure rollback passed",
  );
} finally {
  const cleanup = await pool.connect();
  try {
    await cleanup.query("begin");
    await cleanup.query("set local session_replication_role = replica");
    await cleanup.query(
      "delete from funding_receive_receipts where user_id = any($1::uuid[])",
      [userIds],
    );
    await cleanup.query(
      "delete from funding_receive_canonical_events where tx_hash = any($1::text[])",
      [[TRANSACTION_HASH, ERROR_TRANSACTION_HASH, AMBIGUOUS_TRANSACTION_HASH]],
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
