#!/usr/bin/env tsx

// @requires-db

import assert from "node:assert/strict";
import crypto from "node:crypto";

import { pool } from "../../../db.js";
import {
  fetchFundingOperationStepForUser,
  finishFundingStepAttemptForUserInTransaction,
  startFundingStepAttemptForUserInTransaction,
} from "../../persistence/funding-evidence-repository.js";
import {
  commitFundingOperationInTransaction,
  createFundingQuoteInTransaction,
  FundingPersistenceError,
  type FundingCommitPlan,
} from "../../persistence/funding-operation-repository.js";

const ASSET = {
  networkId: "evm:137",
  assetId: "0x0000000000000000000000000000000000000001",
  decimals: 6,
} as const;

function opaque(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

function hash(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function insertUser(
  client: Readonly<{ query: typeof pool.query }>,
  label: string,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `
      insert into users (email, is_active, is_verified)
      values ($1, true, true)
      returning id
    `,
    [`funding-action-${label}-${crypto.randomUUID()}@example.com`],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error("funding action test user insert failed");
  return id;
}

async function expectFundingError(
  promise: Promise<unknown>,
  code: FundingPersistenceError["code"],
): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof FundingPersistenceError);
    assert.equal(error.code, code);
    return true;
  });
}

const client = await pool.connect();
try {
  await client.query("begin");
  const userId = await insertUser(client, "owner");
  const otherUserId = await insertUser(client, "other");
  const sourceLocation = {
    kind: "wallet",
    locationId: opaque("location"),
    accountId: userId,
    asset: ASSET,
    details: {
      walletId: opaque("wallet"),
      address: "0x00000000000000000000000000000000000000a1",
    },
  } as const;
  const action = {
    kind: "evm_transaction",
    actionId: opaque("action"),
    networkId: ASSET.networkId,
    senderWalletId: sourceLocation.details.walletId,
    to: "0x00000000000000000000000000000000000000b1",
    data: "0x",
    valueRaw: "0",
    gasLimitRaw: "21000",
  } as const;
  const actionFingerprint = hash(JSON.stringify(action));
  const plan: FundingCommitPlan = {
    operation: {
      purpose: "add_funds",
      initialState: { status: "in_progress", stage: "committed" },
      experienceMode: "prepare_first",
      planKind: "wallet_route",
      sourceSnapshot: { kind: "owned_location", location: sourceLocation },
      destinationTargetSnapshot: {
        kind: "owned_location",
        location: {
          ...sourceLocation,
          locationId: opaque("destination"),
        },
      },
      externalRecipientId: null,
      venueId: "polymarket",
      marketId: null,
      marketContextSnapshot: null,
      venueBindingSnapshot: null,
      walletExecutionSnapshot: null,
      placementSnapshot: {},
      requestedSourceAmount: { asset: ASSET, raw: "1000000" },
      requestedDestinationAmount: { asset: ASSET, raw: "990000" },
      supportMetadata: { test: true },
    },
    segments: [
      {
        providerId: "relay",
        adapterId: "relay_quote_v2",
        adapterVersion: 1,
        segmentKind: "same_network_swap",
        status: "planned",
        sourceSnapshot: { kind: "owned_location", location: sourceLocation },
        destinationTargetSnapshot: {
          kind: "owned_location",
          location: {
            ...sourceLocation,
            locationId: opaque("segment-destination"),
          },
        },
        quotedInput: { asset: ASSET, raw: "1000000" },
        quotedExpectedOutput: { asset: ASSET, raw: "995000" },
        quotedMinOutput: { asset: ASSET, raw: "990000" },
        providerQuoteRefCiphertext: "ciphertext:request",
        providerQuoteRefLookupHmac: hash("request"),
        depositAddressCiphertext: null,
        depositAddressLookupHmac: null,
        lookupKeyVersion: 1,
        refundLocationSnapshot: sourceLocation,
        quoteExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    ],
    steps: [
      {
        ordinal: 0,
        segmentOrdinal: 0,
        stepKind: "transaction",
        state: "action_required",
        actionFingerprint,
        executorId: "wallet_profile_evm_v1",
        payerRequirement: "user",
        dependsOnOrdinal: null,
        normalizedAction: action,
        actionValidationResult: { valid: true },
      },
    ],
    reservations: [],
  };
  const consentToken = opaque("consent");
  const quote = await createFundingQuoteInTransaction(client, {
    userId,
    discoveryProjectionId: opaque("projection"),
    selectedSourceOptionSnapshot: plan.operation.sourceSnapshot ?? {},
    marketContextSnapshot: null,
    destinationOptionSnapshot: plan.operation.destinationTargetSnapshot,
    venueBindingSnapshot: null,
    planSnapshot: plan,
    policyVersion: 1,
    policyRevision: "policy_revision_wp6_action",
    canonicalRequest: { source: plan.operation.sourceSnapshot },
    consentToken,
    expiresAt: new Date(Date.now() + 60_000),
  });
  const committed = await commitFundingOperationInTransaction(client, {
    userId,
    quoteId: quote.id,
    consentToken,
    idempotencyKey: opaque("idempotency"),
    plan,
    subjectLookupHmac: hash("user"),
    subjectLookupKeyVersion: 1,
  });
  const stepResult = await client.query<{ id: string }>(
    `
      select id
      from funding_operation_steps
      where operation_id = $1 and ordinal = 0
    `,
    [committed.operation.id],
  );
  const stepId = stepResult.rows[0]?.id;
  assert.ok(stepId);

  await expectFundingError(
    startFundingStepAttemptForUserInTransaction(client, {
      userId: otherUserId,
      operationId: committed.operation.id,
      stepId,
      canonicalActionFingerprint: actionFingerprint,
      executorId: "wallet_profile_evm_v1",
    }),
    "operation_not_found",
  );

  const started = await startFundingStepAttemptForUserInTransaction(client, {
    userId,
    operationId: committed.operation.id,
    stepId,
    canonicalActionFingerprint: actionFingerprint,
    executorId: "wallet_profile_evm_v1",
  });
  assert.equal(started.attempt.attemptNumber, 1);

  await expectFundingError(
    startFundingStepAttemptForUserInTransaction(client, {
      userId,
      operationId: committed.operation.id,
      stepId,
      canonicalActionFingerprint: actionFingerprint,
      executorId: "wallet_profile_evm_v1",
    }),
    "invalid_state_transition",
  );

  const reported = await finishFundingStepAttemptForUserInTransaction(client, {
    userId,
    operationId: committed.operation.id,
    stepId,
    attemptId: started.attempt.id,
    outcome: "ambiguous",
    broadcastMayHaveOccurred: true,
    referenceKind: "transaction",
    receiptRefCiphertext: "ciphertext:transaction",
    receiptRefLookupHmac: hash("transaction"),
    lookupKeyVersion: 1,
    actualCosts: { networkFeeRaw: "21000" },
  });
  assert.equal(reported.stepState, "reconcile_required");
  const storedStep = await fetchFundingOperationStepForUser(client, {
    userId,
    operationId: committed.operation.id,
    stepId,
  });
  assert.equal(storedStep?.state, "reconcile_required");

  await expectFundingError(
    startFundingStepAttemptForUserInTransaction(client, {
      userId,
      operationId: committed.operation.id,
      stepId,
      canonicalActionFingerprint: actionFingerprint,
      executorId: "wallet_profile_evm_v1",
    }),
    "invalid_state_transition",
  );
  console.log(
    "[funding-operation-action-persistence-integration-tests] owner scope, ambiguous report, and no-rebroadcast passed",
  );
} finally {
  await client.query("rollback");
  client.release();
}
