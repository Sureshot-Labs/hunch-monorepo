#!/usr/bin/env tsx

// @api-integration

import assert from "node:assert/strict";
import crypto from "node:crypto";

import { ethers } from "ethers";

import { pool } from "../../../db.js";
import type { JsonObject } from "../../domain/types.js";
import type { FundingReportedPolymarketHandoffCandidate } from "../../persistence/funding-evidence-repository.js";
import {
  createOrReuseFundingReceiveSession,
  fetchFundingReceiveSessionForUser,
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
const TRANSACTION_HASH = `0x${"ab".repeat(32)}`;
const ERROR_TRANSACTION_HASH = `0x${"cd".repeat(32)}`;
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

const candidate: FundingReportedPolymarketHandoffCandidate = {
  operationId: opaque("operation"),
  stepId: opaque("step"),
  attemptId: opaque("attempt"),
  receiptRefLookupHmac: LOOKUP_HMAC,
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
    transactionReferenceLookup: {
      keyVersion: 1,
      fingerprint: () => LOOKUP_HMAC,
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
    listReportedPolymarketHandoffs: async (_client, lookup) =>
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

  const errorUserId = await insertUser("retry");
  userIds.push(errorUserId);
  const errorInput = sessionInput(errorUserId, "retry");
  const errorSession = await createOrReuseFundingReceiveSession(
    pool,
    errorInput,
  );
  const failingObserver = new FundingReceiveSessionObserver({
    transactionReferenceLookup: {
      keyVersion: 1,
      fingerprint: () => LOOKUP_HMAC,
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
    listReportedPolymarketHandoffs: async () => {
      throw new Error("simulated internal handoff lookup failure");
    },
  });
  const failed = await failingObserver.pollBatch(pool, {
    limit: 25,
    minimumPollIntervalMs: 0,
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
