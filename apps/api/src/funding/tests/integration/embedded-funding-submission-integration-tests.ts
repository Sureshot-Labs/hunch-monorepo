#!/usr/bin/env tsx
// @requires-db
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { tx, type Pool } from "@hunch/infra";
import "../../../integration-test-database-guard.js";
import { pool } from "../../../db.js";
import { canonicalJsonHash } from "../../persistence/canonical.js";
import {
  createFundingQuoteInTransaction,
  commitFundingOperationInTransaction,
  allocateFundingObservationInTransaction,
  wakeFundingReconciliationInTransaction,
  finishFundingReconciliationLease as finishFundingLeaseRaw,
  type FundingCommitPlan,
} from "../../persistence/funding-operation-repository.js";
import {
  startFundingStepAttemptForUserInTransaction,
  finishFundingStepAttemptForUserInTransaction,
  finishFundingStepAttemptInTransaction,
} from "../../persistence/funding-evidence-repository.js";
import {
  prepareEmbeddedFundingSubmissionInTransaction,
  admitEmbeddedFundingSubmissionInTransaction,
  recordEmbeddedFundingSubmissionResultInTransaction,
  closeExpiredEmbeddedFundingPreparationsInTransaction,
  submitEmbeddedFundingAction,
} from "../../execution/embedded-funding-submission.js";
import {
  reduceFundingOperationInTransaction,
  runFundingReconciliationBatch,
  recoverStoppedFundingOperations,
} from "../../reconciliation/funding-reducer.js";
import { createFundingTransactionReferenceCodec } from "../../execution/transaction-reference-codec.js";
import {
  listFundingStepReceiptTargets,
  applyFundingStepReceiptEvidenceInTransaction,
  type FundingStepReceiptEvidence,
} from "../../persistence/funding-step-receipt-repository.js";
import { loadFundingLifecycleFactsForOperationInTransaction } from "../../lifecycle/funding-lifecycle-facts-repository.js";
import {
  inspectFundingEvidenceRepair,
  requestFundingEvidenceRepair,
  loadFundingEvidenceRepairSnapshot,
} from "../../persistence/funding-evidence-repair-repository.js";
import { FundingStepReceiptReconciliationDriver } from "../../execution/step-receipt-reconciler.js";

const id = () => crypto.randomUUID();
const signer = "0x00000000000000000000000000000000000000a1";
const target = "0x00000000000000000000000000000000000000b1";
const asset = {
  networkId: "evm:137",
  assetId: "0x0000000000000000000000000000000000000001",
  decimals: 6,
};
const codec = createFundingTransactionReferenceCodec({
  encryptionKey: crypto.randomBytes(32),
  lookupHmacKey: crypto.randomBytes(32).toString("hex"),
  keyVersion: 1,
});
const userRows = await pool.query<{ id: string }>(
  "insert into users(email,is_active,is_verified) values($1,true,true) returning id",
  [`embedded-cancel-${id()}@example.com`],
);
assert.ok(userRows.rows[0]);
const userId = userRows.rows[0].id;

async function fixture(
  versioned = true,
  purpose: "add_funds" | "trade_shortfall" = "add_funds",
  payerRequirement: "user" | "privy_sponsor" = "privy_sponsor",
) {
  return tx(pool, async (client) => {
    const walletId = id();
    const source = {
      kind: "wallet" as const,
      locationId: id(),
      accountId: userId,
      asset,
      details: { walletId, address: signer },
    };
    const destination = {
      ...source,
      locationId: id(),
      details: { walletId: id(), address: target },
    };
    const action = {
      kind: "evm_transaction" as const,
      actionId: id(),
      networkId: asset.networkId,
      senderWalletId: walletId,
      to: target,
      data: "0x",
      valueRaw: "100",
      gasLimitRaw: "21000",
    };
    const expiresAt = new Date(Date.now() + 600_000);
    const plan: FundingCommitPlan = {
      operation: {
        purpose,
        initialState: { status: "in_progress", stage: "committed" },
        experienceMode: "prepare_first",
        planKind: "wallet_route",
        sourceSnapshot: { kind: "owned_location", location: source },
        destinationTargetSnapshot: {
          kind: "owned_location",
          location: destination,
        },
        externalRecipientId: null,
        venueId: "polymarket",
        marketId: null,
        marketContextSnapshot: null,
        venueBindingSnapshot: null,
        walletExecutionSnapshot: null,
        placementSnapshot: {},
        requestedSourceAmount: { asset, raw: "1000000" },
        requestedDestinationAmount: { asset, raw: "990000" },
        supportMetadata: { test: true },
      },
      segments: [
        {
          providerId: "relay",
          adapterId: "relay_quote_v2",
          adapterVersion: 1,
          segmentKind: "same_network_swap",
          status: "planned",
          sourceSnapshot: { kind: "owned_location", location: source },
          destinationTargetSnapshot: {
            kind: "owned_location",
            location: destination,
          },
          quotedInput: { asset, raw: "1000000" },
          quotedExpectedOutput: { asset, raw: "995000" },
          quotedMinOutput: { asset, raw: "990000" },
          providerQuoteRefCiphertext: "ciphertext:test",
          providerQuoteRefLookupHmac: crypto
            .createHash("sha256")
            .update(id())
            .digest("hex"),
          depositAddressCiphertext: null,
          depositAddressLookupHmac: null,
          lookupKeyVersion: 1,
          refundLocationSnapshot: source,
          quoteExpiresAt: expiresAt.toISOString(),
        },
      ],
      steps: [
        {
          ordinal: 0,
          segmentOrdinal: 0,
          stepKind: "transaction",
          state: "action_required",
          actionFingerprint: canonicalJsonHash(action),
          executorId: "wallet_profile_evm_v1",
          payerRequirement,
          dependsOnOrdinal: null,
          normalizedAction: action,
          actionValidationResult: { signerAddress: signer },
        },
      ],
      reservations: [
        {
          segmentOrdinal: 0,
          componentId: id(),
          locationId: source.locationId,
          networkId: asset.networkId,
          assetId: asset.assetId,
          assetDecimals: 6,
          rawAmount: "1000000",
          mode: "subtract_available",
          expiresAt: expiresAt.toISOString(),
        },
      ],
    };
    assert.ok(plan.operation.sourceSnapshot);
    const consentToken = id();
    const quote = await createFundingQuoteInTransaction(client, {
      userId,
      discoveryProjectionId: id(),
      selectedSourceOptionSnapshot: plan.operation.sourceSnapshot,
      marketContextSnapshot: null,
      destinationOptionSnapshot: plan.operation.destinationTargetSnapshot,
      venueBindingSnapshot: null,
      planSnapshot: plan,
      policyVersion: 1,
      policyRevision: "embedded_submission_test",
      canonicalRequest: {},
      consentToken,
      expiresAt,
    });
    const committed = await commitFundingOperationInTransaction(client, {
      userId,
      quoteId: quote.id,
      consentToken,
      idempotencyKey: id(),
      plan,
      subjectLookupHmac: crypto
        .createHash("sha256")
        .update(userId)
        .digest("hex"),
      subjectLookupKeyVersion: 1,
    });
    const stepRows = await client.query<{ id: string }>(
      "select id from funding_operation_steps where operation_id=$1",
      [committed.operation.id],
    );
    assert.ok(stepRows.rows[0]);
    const stepId = stepRows.rows[0].id;
    const started = await startFundingStepAttemptForUserInTransaction(client, {
      userId,
      operationId: committed.operation.id,
      stepId,
      canonicalActionFingerprint: canonicalJsonHash(action),
      executorId: "wallet_profile_evm_v1",
      ...(versioned
        ? {
            embeddedSubmissionProtocol: {
              signer,
              payer: "privy_sponsor" as const,
            },
          }
        : {}),
    });
    return {
      context: {
        operationId: committed.operation.id,
        stepId,
        attemptId: started.attempt.id,
      },
      payload: {
        kind: "ethereum" as const,
        signer,
        chainId: 137,
        executionMode: "sequential" as const,
        returnOnAccepted: true as const,
        transactions: [
          {
            to: target,
            data: "0x",
            value: "0x64",
            gas: "0x5208",
            sponsor: true,
          },
        ],
      },
      requests: [
        {
          id: "funding",
          input: {
            method: "POST",
            body: { to: target },
            headers: {
              "privy-idempotency-key": `funding-v1:${started.attempt.id}`,
            },
          },
        },
      ],
    };
  });
}
async function attempt(f: Awaited<ReturnType<typeof fixture>>) {
  const result = await pool.query<{
    outcome: string;
    broadcast_may_have_occurred: boolean;
    receipt_ref_ciphertext: string | null;
  }>(
    "select outcome,broadcast_may_have_occurred,receipt_ref_ciphertext from funding_operation_step_attempts where id=$1",
    [f.context.attemptId],
  );
  assert.ok(result.rows[0]);
  return result.rows[0];
}
async function expire(f: Awaited<ReturnType<typeof fixture>>) {
  return tx(pool, async (client) => {
    await client.query(
      "select id from funding_operations where id=$1 for update",
      [f.context.operationId],
    );
    const now = new Date(Date.now() + 180_000);
    const closed = await closeExpiredEmbeddedFundingPreparationsInTransaction(
      client,
      f.context.operationId,
      now,
    );
    if (closed)
      await reduceFundingOperationInTransaction(client, {
        operationId: f.context.operationId,
        now,
      });
    return closed;
  });
}
const unsubmitted = await fixture();
await tx(pool, (client) =>
  prepareEmbeddedFundingSubmissionInTransaction(client, userId, unsubmitted),
);
assert.equal(await expire(unsubmitted), true);
assert.equal((await attempt(unsubmitted)).outcome, "cancelled");
assert.equal(
  (
    await pool.query(
      "select 1 from balance_reservations where operation_id=$1 and state='active'",
      [unsubmitted.context.operationId],
    )
  ).rowCount,
  0,
);
await assert.rejects(
  tx(pool, (client) =>
    admitEmbeddedFundingSubmissionInTransaction(client, userId, unsubmitted),
  ),
  /closed|expired|executable|transition/,
);

const legacy = await fixture(false);
assert.equal(await expire(legacy), false);
assert.equal((await attempt(legacy)).outcome, "started");

const accepted = await fixture();
await tx(pool, (client) =>
  prepareEmbeddedFundingSubmissionInTransaction(client, userId, accepted),
);
await assert.rejects(
  tx(pool, (client) =>
    admitEmbeddedFundingSubmissionInTransaction(client, userId, {
      ...accepted,
      payload: {
        ...accepted.payload,
        transactions: [{ ...accepted.payload.transactions[0], to: signer }],
      },
    }),
  ),
);
const admissions = await Promise.all([
  tx(pool, (client) =>
    admitEmbeddedFundingSubmissionInTransaction(client, userId, accepted),
  ),
  tx(pool, (client) =>
    admitEmbeddedFundingSubmissionInTransaction(client, userId, accepted),
  ),
]);
assert.deepEqual(admissions.map((value) => value.admitted).sort(), [
  false,
  true,
]);
assert.equal((await attempt(accepted)).broadcast_may_have_occurred, true);
assert.equal(await expire(accepted), false);
await tx(pool, (client) =>
  finishFundingStepAttemptForUserInTransaction(client, {
    userId,
    ...accepted.context,
    outcome: "cancelled",
    broadcastMayHaveOccurred: false,
    referenceKind: null,
    receiptRefCiphertext: null,
    receiptRefLookupHmac: null,
    lookupKeyVersion: null,
    actualCosts: { networkFeeRaw: null },
  }),
);
assert.equal((await attempt(accepted)).outcome, "ambiguous");
const reference = {
  kind: "transaction" as const,
  value: `0x${"a".repeat(64)}`,
};
await tx(pool, (client) =>
  recordEmbeddedFundingSubmissionResultInTransaction(
    client,
    userId,
    accepted.context,
    reference,
    codec,
  ),
);
const saved = (await attempt(accepted)).receipt_ref_ciphertext;
assert.ok(saved);
assert.equal(codec.decrypt(saved), reference.value);
await tx(pool, (client) =>
  recordEmbeddedFundingSubmissionResultInTransaction(
    client,
    userId,
    accepted.context,
    reference,
    codec,
  ),
);
await assert.rejects(
  tx(pool, (client) =>
    recordEmbeddedFundingSubmissionResultInTransaction(
      client,
      userId,
      accepted.context,
      { ...reference, value: `0x${"b".repeat(64)}` },
      codec,
    ),
  ),
);
const replay = await tx(pool, (client) =>
  admitEmbeddedFundingSubmissionInTransaction(client, userId, accepted),
);
assert.equal(replay.admitted, false);
const providerAccepted = await fixture();
await tx(pool, (client) =>
  admitEmbeddedFundingSubmissionInTransaction(client, userId, providerAccepted),
);
const providerReference = {
  kind: "provider_transaction" as const,
  value: `privy-transaction-v1:${id()}`,
};
await tx(pool, (client) =>
  recordEmbeddedFundingSubmissionResultInTransaction(
    client,
    userId,
    providerAccepted.context,
    providerReference,
    codec,
  ),
);
const providerTargets = await listFundingStepReceiptTargets(
  pool,
  providerAccepted.context.operationId,
);
assert.equal(
  providerTargets.length,
  1,
  "lost browser response still leaves a recoverable provider target",
);
assert.equal(providerTargets[0]?.referenceKind, "provider_receipt");
const unknown = await fixture();
await tx(pool, (client) =>
  admitEmbeddedFundingSubmissionInTransaction(client, userId, unknown),
);
assert.equal(
  await expire(unknown),
  false,
  "lost provider response cannot become an expired signature",
);
assert.equal((await attempt(unknown)).outcome, "ambiguous");
assert.equal(
  (
    await pool.query(
      "select 1 from balance_reservations where operation_id=$1 and state='active'",
      [unknown.context.operationId],
    )
  ).rowCount,
  1,
);
const workerExpired = await fixture();
await pool.query(
  "update funding_reconciliation_jobs set priority=100000,due_at=now() where operation_id=$1",
  [workerExpired.context.operationId],
);
const workerResult = await runFundingReconciliationBatch(pool, {
  workerId: id(),
  limit: 1,
  now: new Date(Date.now() + 180_000),
});
assert.equal(workerResult.failed, 0);
assert.equal(
  (await attempt(workerExpired)).outcome,
  "cancelled",
  "closed Mini App must not be required to release an unsubmitted embedded attempt",
);
assert.equal(
  (
    await pool.query(
      "select 1 from balance_reservations where operation_id=$1 and state='active'",
      [workerExpired.context.operationId],
    )
  ).rowCount,
  0,
);

const lostResponse = await fixture();
let submitCalls = 0;
const options = { codec, admissionPolicy: async () => undefined };
const unavailableProvider = async () => {
  submitCalls += 1;
  throw new Error("simulated lost provider response");
};
await assert.rejects(
  submitEmbeddedFundingAction(
    pool,
    userId,
    lostResponse,
    unavailableProvider,
    options,
  ),
);
await assert.rejects(
  submitEmbeddedFundingAction(
    pool,
    userId,
    lostResponse,
    unavailableProvider,
    options,
  ),
);
assert.equal(
  submitCalls,
  1,
  "lost provider response never grants a second provider POST",
);
assert.equal(await expire(lostResponse), false);

const delivered = await fixture();
let deliveredCalls = 0;
const provider = async () => {
  deliveredCalls += 1;
  return providerReference;
};
const deliveredResult = await submitEmbeddedFundingAction(
  pool,
  userId,
  delivered,
  provider,
  options,
);
const replayedResult = await submitEmbeddedFundingAction(
  pool,
  userId,
  delivered,
  provider,
  options,
);
assert.deepEqual(replayedResult, deliveredResult);
assert.equal(
  deliveredCalls,
  1,
  "browser response loss recovers the durable result without resubmitting",
);
console.log(
  "[embedded-funding-submission-integration-tests] prepare lease, exact binding, expiry, reservation release, admission race, durable result and legacy safety passed",
);

// Historical started cache, but a durable negative result was already known.
// The evidence-only sweep must materialize completion without any executor.
// A late exact receipt must replace the earlier owned-route estimate and
// release an expired, unused Buy reservation in the same transaction.
const estimated = await fixture(false, "trade_shortfall");
await tx(pool, async (client) => {
  const operationId = estimated.context.operationId;
  const segmentId = (
    await client.query(
      "select segment_id from funding_operation_steps where id=$1",
      [estimated.context.stepId],
    )
  ).rows[0].segment_id;
  const reference = `0x${crypto.randomBytes(32).toString("hex")}`;
  await finishFundingStepAttemptInTransaction(client, {
    attemptId: estimated.context.attemptId,
    outcome: "submitted",
    broadcastMayHaveOccurred: true,
    referenceKind: "transaction",
    receiptRefCiphertext: codec.encrypt(reference),
    receiptRefLookupHmac: codec.fingerprint(reference),
    lookupKeyVersion: 1,
    actualCosts: {},
  });
  const now = new Date();
  const observation = {
    operationId,
    segmentId,
    kind: "destination_credit" as const,
    networkId: asset.networkId,
    assetId: asset.assetId,
    assetDecimals: asset.decimals,
    txHash: `owned-route:${operationId}:revision`,
    eventIndex: "0",
    fromAddress: null,
    toAddress: target,
    rawAmount: "990000",
    observedAt: now,
    ledgerHeight: "1",
    blockHash: `0x${"a".repeat(64)}`,
    finalityStatus: "finalized" as const,
    finalizedAt: now,
    metadata: { observerId: "relay_owned_destination_observation_v1" },
  };
  await allocateFundingObservationInTransaction(client, observation);
  const receipt = {
    status: "finalized" as const,
    actionMatch: true,
    ledgerHeight: "1",
    blockHash: observation.blockHash,
    canonical: true,
    failureCode: null,
    evidence: { transactionHash: reference },
  };
  await applyFundingStepReceiptEvidenceInTransaction(client, {
    ...estimated.context,
    networkId: asset.networkId,
    receipt,
    now,
  });
  assert.equal(
    (
      await client.query("select status from funding_operations where id=$1", [
        operationId,
      ])
    ).rows[0].status,
    "ready",
  );
  await allocateFundingObservationInTransaction(client, {
    ...observation,
    txHash: `0x${crypto.randomBytes(32).toString("hex")}`,
    rawAmount: "995051",
    metadata: {
      ...observation.metadata,
      relayTransactionReferenceMatched: true,
    },
  });
  const later = new Date(now.getTime() + 8 * 86400_000);
  await client.query("SAVEPOINT invalid_actual_fixture");
  await client.query(
    "update funding_operations set version=version+1, actual_destination_amount=jsonb_set(actual_destination_amount,'{raw}','\"990001\"'::jsonb) where id=$1",
    [operationId],
  );
  await client.query("SAVEPOINT rejected_repair");
  await assert.rejects(
    applyFundingStepReceiptEvidenceInTransaction(client, {
      ...estimated.context,
      networkId: asset.networkId,
      receipt,
      now: later,
    }),
    { code: "actual_amount_conflict" },
  );
  await client.query("ROLLBACK TO SAVEPOINT rejected_repair");
  assert.equal(
    (
      await client.query(
        "select count(*)::int as total from balance_reservations where operation_id=$1 and mode='settled_for_consumer' and state='active'",
        [operationId],
      )
    ).rows[0].total,
    1,
    "rejected correction must roll back reservation release",
  );
  await client.query("ROLLBACK TO SAVEPOINT invalid_actual_fixture");
  await applyFundingStepReceiptEvidenceInTransaction(client, {
    ...estimated.context,
    networkId: asset.networkId,
    receipt,
    now: later,
  });
  const corrected = (
    await client.query(
      "select status,actual_destination_amount,support_metadata from funding_operations where id=$1",
      [operationId],
    )
  ).rows[0];
  assert.equal(corrected.status, "completed");
  assert.equal(corrected.actual_destination_amount.raw, "995051");
  assert.equal(
    corrected.support_metadata.destinationAmountCorrection.previous.raw,
    "990000",
  );
  assert.equal(
    (
      await client.query(
        "select count(*)::int as total from balance_reservations where operation_id=$1 and mode='settled_for_consumer' and state='active'",
        [operationId],
      )
    ).rows[0].total,
    0,
  );
  await reduceFundingOperationInTransaction(client, {
    operationId,
    now: later,
  });
  assert.equal(
    (
      await client.query(
        "select actual_destination_amount from funding_operations where id=$1",
        [operationId],
      )
    ).rows[0].actual_destination_amount.raw,
    "995051",
  );
});

const stopped = await fixture(false);
await tx(pool, (client) =>
  finishFundingStepAttemptInTransaction(client, {
    attemptId: stopped.context.attemptId,
    outcome: "cancelled",
    broadcastMayHaveOccurred: false,
    referenceKind: null,
    receiptRefCiphertext: null,
    receiptRefLookupHmac: null,
    lookupKeyVersion: null,
    actualCosts: {},
  }),
);
await pool.query(
  `update funding_reconciliation_jobs set status='completed',completed_at=now(),
  lease_owner=null,lease_token=null,lease_until=null where operation_id=$1`,
  [stopped.context.operationId],
);
const previousUuid = (value: string) => {
  const hex = (BigInt(`0x${value.replaceAll("-", "")}`) - 1n)
    .toString(16)
    .padStart(32, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
await pool.query(
  "update funding_recovery_scan_cursor set last_operation_id=$1 where cursor_name='stopped_evidence_v1'",
  [previousUuid(stopped.context.operationId)],
);
const repairNow = new Date(Date.now() + 8 * 86400_000);
assert.equal(
  await recoverStoppedFundingOperations(pool, {
    workerId: "missing-verifier-test",
    now: repairNow,
  }),
  0,
  "missing canonical verifier must not claim stopped jobs",
);
let receipts = 0;
assert.equal(
  await recoverStoppedFundingOperations(pool, {
    workerId: "stopped-recovery-test",
    now: repairNow,
    receiptPoll: async () => {
      receipts++;
      return { receiptsPolled: 0 };
    },
  }),
  1,
);
assert.equal(receipts, 1);
assert.equal(
  (
    await pool.query(
      "select status from funding_reconciliation_jobs where operation_id=$1",
      [stopped.context.operationId],
    )
  ).rows[0].status,
  "scheduled",
  "terminal repairs must return to ordinary receipt/refund reorg watch",
);
assert.equal(
  (
    await pool.query(
      "select last_operation_id from funding_recovery_scan_cursor where cursor_name='stopped_evidence_v1'",
    )
  ).rows[0].last_operation_id,
  stopped.context.operationId,
);
const repairedFacts = await loadFundingLifecycleFactsForOperationInTransaction(
  pool,
  { operationId: stopped.context.operationId, now: new Date() },
);
assert.equal(
  repairedFacts?.actions[0]?.authorization,
  "blocked",
  "evidence-only recovery fences future execution even before the original deadline",
);
assert.equal(
  (
    await pool.query("select status from funding_operations where id=$1", [
      stopped.context.operationId,
    ])
  ).rows[0].status,
  "cancelled",
);
assert.equal(
  (
    await pool.query(
      "select count(*)::int as total from balance_reservations where operation_id=$1 and state='active'",
      [stopped.context.operationId],
    )
  ).rows[0].total,
  0,
);

const rpcFailure = await fixture(false);
await tx(pool, (client) =>
  finishFundingStepAttemptInTransaction(client, {
    attemptId: rpcFailure.context.attemptId,
    outcome: "cancelled",
    broadcastMayHaveOccurred: false,
    referenceKind: null,
    receiptRefCiphertext: null,
    receiptRefLookupHmac: null,
    lookupKeyVersion: null,
    actualCosts: {},
  }),
);
await pool.query(
  `update funding_reconciliation_jobs set status='dead_letter',completed_at=now(),
  lease_owner=null,lease_token=null,lease_until=null where operation_id=$1`,
  [rpcFailure.context.operationId],
);
await pool.query(
  "update funding_recovery_scan_cursor set last_operation_id=$1 where cursor_name='stopped_evidence_v1'",
  [previousUuid(rpcFailure.context.operationId)],
);
await recoverStoppedFundingOperations(pool, {
  workerId: "stopped-rpc-test",
  now: repairNow,
  receiptPoll: async () => {
    throw new Error("RPC unavailable");
  },
});
assert.equal(
  (
    await pool.query(
      "select count(*)::int as total from balance_reservations where operation_id=$1 and state='active'",
      [rpcFailure.context.operationId],
    )
  ).rows[0].total,
  1,
  "failed receipt verification must not release a reservation from stale evidence",
);
assert.equal(
  (
    await pool.query(
      "select status from funding_reconciliation_jobs where operation_id=$1",
      [rpcFailure.context.operationId],
    )
  ).rows[0].status,
  "dead_letter",
);

for (const failingPoll of ["destinationPoll", "postconditionPoll"] as const) {
  await pool.query(
    "update funding_recovery_scan_cursor set last_operation_id=$1 where cursor_name='stopped_evidence_v1'",
    [previousUuid(rpcFailure.context.operationId)],
  );
  await recoverStoppedFundingOperations(pool, {
    workerId: `stopped-${failingPoll}-test`,
    now: new Date(
      repairNow.getTime() +
        (failingPoll === "destinationPoll" ? 600_000 : 1200_000),
    ),
    receiptPoll: async () => ({ receiptsPolled: 0 }),
    [failingPoll]: async () => {
      throw new Error("canonical verification unavailable");
    },
  });
  assert.equal(
    (
      await pool.query(
        "select count(*)::int as total from balance_reservations where operation_id=$1 and state='active'",
        [rpcFailure.context.operationId],
      )
    ).rows[0].total,
    1,
    `${failingPoll} failure must preserve the reservation`,
  );
}

// The operational waiter never changes immutable mismatches or revives an old
// trade. All observations below are injected fixtures: no RPC/provider calls.
const waiter = await fixture(false, "trade_shortfall", "user");
const waiterReference = `0x${"93".repeat(32)}`;
await tx(pool, async (client) => {
  await finishFundingStepAttemptInTransaction(client, {
    attemptId: waiter.context.attemptId,
    outcome: "submitted",
    broadcastMayHaveOccurred: true,
    referenceKind: "transaction",
    receiptRefCiphertext: codec.encrypt(waiterReference),
    receiptRefLookupHmac: codec.fingerprint(waiterReference),
    lookupKeyVersion: 1,
    actualCosts: {},
  });
  await applyFundingStepReceiptEvidenceInTransaction(client, {
    ...waiter.context,
    networkId: asset.networkId,
    receipt: {
      status: "mismatch",
      actionMatch: false,
      canonical: true,
      ledgerHeight: "10",
      blockHash: `0x${"81".repeat(32)}`,
      failureCode: "transaction_action_mismatch",
      evidence: {
        transactionObserved: true,
        receiptObserved: true,
        executionEnvelope: "direct",
      },
    },
  });
});
await assert.rejects(
  requestFundingEvidenceRepair(pool, {
    operationId: waiter.context.operationId,
    idempotencyKey: "live-request",
  }),
  (error: unknown) =>
    error instanceof Error &&
    "code" in error &&
    error.code === "operation_not_stopped",
);
const firstRequest = await requestFundingEvidenceRepair(pool, {
  operationId: waiter.context.operationId,
  idempotencyKey: "request-one",
  now: repairNow,
});
assert.equal(firstRequest.generation, 1);
assert.equal(firstRequest.inspection.stopped, true);
const repairReplay = await requestFundingEvidenceRepair(pool, {
  operationId: waiter.context.operationId,
  idempotencyKey: "request-one",
  now: repairNow,
});
assert.equal(repairReplay.replayed, true);
assert.equal(repairReplay.generation, 1);
await pool.query(
  "update funding_reconciliation_jobs set priority=10000 where operation_id=$1",
  [waiter.context.operationId],
);
let sourceReads = 0;
let sourceFinalized = false;
let duringInspect: (() => Promise<void>) | null = null;
const matchingMask = {
  chain: true,
  from: false,
  to: false,
  calldata: false,
  value: true,
};
const waiterDriver = new FundingStepReceiptReconciliationDriver(codec, {
  inspectEvm: async (): Promise<FundingStepReceiptEvidence> => {
    sourceReads++;
    await duringInspect?.();
    if (sourceFinalized)
      return {
        status: "finalized",
        actionMatch: true,
        canonical: true,
        ledgerHeight: "10",
        blockHash: `0x${"81".repeat(32)}`,
        failureCode: null,
        evidence: { transactionObserved: true },
      };
    return {
      status: "mismatch",
      actionMatch: false,
      canonical: true,
      ledgerHeight: "10",
      blockHash: `0x${"81".repeat(32)}`,
      failureCode: "transaction_action_mismatch",
      evidence: {
        transactionObserved: true,
        intrinsicMismatch: true,
        matchingMask,
      },
    };
  },
});
const waiterPoll = (
  operationId: string,
  now: Date,
  options?: Parameters<typeof waiterDriver.pollOperation>[3],
) =>
  operationId === waiter.context.operationId
    ? waiterDriver.pollOperation(pool, operationId, now, options)
    : Promise.resolve({ receiptsPolled: 0 });
const runWaiter = (at: Date, receiptPoll = waiterPoll) =>
  runFundingReconciliationBatch(pool, {
    workerId: "evidence-waiter-test",
    now: at,
    limit: 1,
    concurrency: 1,
    receiptPoll,
  });
await runWaiter(repairNow);
assert.equal(sourceReads, 1);
const waitingBefore = await loadFundingEvidenceRepairSnapshot(
  pool,
  waiter.context.operationId,
  repairNow,
);
assert.equal(waitingBefore?.repair?.state, "waiting_evidence");
assert.deepEqual(waitingBefore?.repair?.lastProbe?.matchingMask, matchingMask);
assert.equal(waitingBefore?.operationStatus, "recovery_required");
const waiterVersion = async () =>
  (
    await pool.query(
      "select version,support_metadata->>'evidenceOnlyRecoveryAt' as marker from funding_operations where id=$1",
      [waiter.context.operationId],
    )
  ).rows[0];
const waiterAttempts = async () =>
  Number(
    (
      await pool.query(
        "select attempt_count from funding_reconciliation_jobs where operation_id=$1",
        [waiter.context.operationId],
      )
    ).rows[0].attempt_count,
  );
const beforeUnchanged = await waiterVersion();
const beforeAttempts = await waiterAttempts();
const wakeAt = new Date(repairNow.getTime() + 1_000);
await tx(pool, (client) =>
  wakeFundingReconciliationInTransaction(client, {
    operationId: waiter.context.operationId,
    dueAt: wakeAt,
  }),
);
await runWaiter(wakeAt);
assert.equal(
  sourceReads,
  1,
  "unchanged intrinsic source content must not be fetched again",
);
assert.deepEqual(
  await waiterVersion(),
  beforeUnchanged,
  "unchanged acquisition must not churn financial version or consent marker",
);
assert.equal(
  await waiterAttempts(),
  beforeAttempts,
  "unchanged acquisition is not a full repair attempt",
);
assert.equal(
  (await inspectFundingEvidenceRepair(pool, waiter.context.operationId))
    ?.lastProbe?.status,
  "mismatch",
);
assert.equal(
  (
    await loadFundingLifecycleFactsForOperationInTransaction(pool, {
      operationId: waiter.context.operationId,
      now: wakeAt,
    })
  )?.actions[0]?.authorization,
  "blocked",
);

const manualAt = new Date(wakeAt.getTime() + 1_000);
await requestFundingEvidenceRepair(pool, {
  operationId: waiter.context.operationId,
  idempotencyKey: "request-two",
  now: manualAt,
});
await runWaiter(manualAt);
assert.equal(
  sourceReads,
  2,
  "explicit repair bypasses stale waiting schedules and source suppression",
);
assert.equal(
  (
    await requestFundingEvidenceRepair(pool, {
      operationId: waiter.context.operationId,
      idempotencyKey: "request-one",
      now: manualAt,
    })
  ).generation,
  1,
  "an older idempotency key must stay a replay after a newer request",
);
assert.equal(
  (await inspectFundingEvidenceRepair(pool, waiter.context.operationId))
    ?.generation,
  2,
);

const raceAt = new Date(manualAt.getTime() + 1_000);
await requestFundingEvidenceRepair(pool, {
  operationId: waiter.context.operationId,
  idempotencyKey: "race-before",
  now: raceAt,
});
sourceFinalized = true;
duringInspect = async () => {
  await requestFundingEvidenceRepair(pool, {
    operationId: waiter.context.operationId,
    idempotencyKey: "race-during",
    now: raceAt,
  });
};
await runWaiter(raceAt);
duringInspect = null;
sourceFinalized = false;
assert.equal(
  (
    await pool.query(
      "select status from funding_step_receipt_observations where attempt_id=$1",
      [waiter.context.attemptId],
    )
  ).rows[0].status,
  "mismatch",
  "a generation change during RPC must fence receipt correction BEFORE apply/reduction",
);
const afterRace = await inspectFundingEvidenceRepair(
  pool,
  waiter.context.operationId,
);
assert.ok(afterRace);
assert.equal(
  afterRace?.jobStatus,
  "scheduled",
  "a wake during repair must survive dead-letter finishing",
);
assert.equal(afterRace?.generation, 4);
assert.ok(
  afterRace.processedGeneration < afterRace.generation,
  "stale generation cannot acknowledge a new request",
);
await runWaiter(raceAt);
assert.equal(
  (await inspectFundingEvidenceRepair(pool, waiter.context.operationId))
    ?.processedGeneration,
  4,
);
const expiredLeaseAt = new Date(raceAt.getTime() + 1_000);
await requestFundingEvidenceRepair(pool, {
  operationId: waiter.context.operationId,
  idempotencyKey: "expired-lease",
  now: expiredLeaseAt,
});
await runWaiter(expiredLeaseAt, async (operationId, at, pollOptions) => {
  const result = await waiterPoll(operationId, at, pollOptions);
  if (operationId === waiter.context.operationId)
    await pool.query(
      "update funding_reconciliation_jobs set lease_until=$2 where operation_id=$1",
      [operationId, new Date(at.getTime() - 1)],
    );
  return result;
});
assert.equal(
  (await inspectFundingEvidenceRepair(pool, waiter.context.operationId))
    ?.processedGeneration,
  4,
  "an expired lease cannot publish its wait-state",
);
await runWaiter(expiredLeaseAt);
assert.equal(
  (await inspectFundingEvidenceRepair(pool, waiter.context.operationId))
    ?.processedGeneration,
  5,
  "a replacement lease must recover an interrupted request",
);
assert.equal(
  Number(
    (
      await pool.query(
        "select count(*)::int as count_value from funding_operation_step_attempts where step_id=$1",
        [waiter.context.stepId],
      )
    ).rows[0].count_value,
  ),
  1,
  "evidence repair must never create another financial execution attempt",
);
console.log(
  "[embedded-funding-submission-integration-tests] evidence-only waiter, immutable mismatch suppression, idempotent immediate repair, generation/wake/expiry fencing passed",
);

// A changed evaluator generation must re-acquire the old source rather than
// treating its historic mismatch as an eternal rejection. The existing narrow
// mismatch -> canonical matching finalized correction remains unchanged.
const revisedAt = new Date(expiredLeaseAt.getTime() + 1_000);
await pool.query(
  `update funding_operations set support_metadata=jsonb_set(support_metadata,
     '{evidenceRepairV1,evaluatorRevision}','"funding_evidence_repair_v0"'::jsonb),version=version+1 where id=$1`,
  [waiter.context.operationId],
);
sourceFinalized = true;
const beforeRevisionReads = sourceReads;
await tx(pool, (client) =>
  wakeFundingReconciliationInTransaction(client, {
    operationId: waiter.context.operationId,
    dueAt: revisedAt,
  }),
);
let dynamicDestinations = 0;
await runFundingReconciliationBatch(pool, {
  workerId: "evidence-revision-test",
  now: revisedAt,
  limit: 1,
  concurrency: 1,
  receiptPoll: waiterPoll,
  destinationPoll: async () => {
    dynamicDestinations++;
    return { destinationsPolled: 1, destinationSatisfied: false };
  },
});
assert.equal(
  sourceReads,
  beforeRevisionReads + 1,
  "an evaluator revision must invalidate intrinsic source suppression",
);
assert.equal(
  dynamicDestinations,
  1,
  "late destination/refund acquisition must remain enabled after a source correction",
);
assert.equal(
  (
    await pool.query(
      "select status from funding_step_receipt_observations where attempt_id=$1",
      [waiter.context.attemptId],
    )
  ).rows[0].status,
  "finalized",
);
assert.equal(
  (
    await loadFundingLifecycleFactsForOperationInTransaction(pool, {
      operationId: waiter.context.operationId,
      now: revisedAt,
    })
  )?.actions[0]?.authorization,
  "blocked",
);
await pool.query(
  `update funding_operations set support_metadata=jsonb_set(support_metadata,
    '{evidenceRepairV1,formatVersion}','2'::jsonb),version=version+1 where id=$1`,
  [waiter.context.operationId],
);
const incompatibleBefore = await waiterVersion();
assert.equal(
  (await inspectFundingEvidenceRepair(pool, waiter.context.operationId))
    ?.compatible,
  false,
);
await assert.rejects(
  requestFundingEvidenceRepair(pool, {
    operationId: waiter.context.operationId,
    idempotencyKey: "future-format",
    now: revisedAt,
  }),
  (error: unknown) =>
    error instanceof Error &&
    "code" in error &&
    error.code === "incompatible_repair_state",
);
await tx(pool, (client) =>
  wakeFundingReconciliationInTransaction(client, {
    operationId: waiter.context.operationId,
    dueAt: revisedAt,
  }),
);
await runWaiter(revisedAt);
assert.deepEqual(
  await waiterVersion(),
  incompatibleBefore,
  "an unsupported format must remain untouched by requests and claims",
);
assert.equal(sourceReads, beforeRevisionReads + 1);
console.log(
  "[embedded-funding-submission-integration-tests] evaluator revision, late canonical correction, dynamic destination acquisition, and incompatible-format preservation passed",
);

const wallClock = await fixture(false, "trade_shortfall", "user");
await requestFundingEvidenceRepair(pool, {
  operationId: wallClock.context.operationId,
  idempotencyKey: "wall-clock",
  now: repairNow,
});
await pool.query(
  "update funding_reconciliation_jobs set priority=20000 where operation_id=$1",
  [wallClock.context.operationId],
);
await tx(pool, (client) =>
  wakeFundingReconciliationInTransaction(client, {
    operationId: wallClock.context.operationId,
    dueAt: new Date(),
  }),
);
await runFundingReconciliationBatch(pool, {
  workerId: "wall-clock-expiry",
  limit: 1,
  concurrency: 1,
  receiptPoll: async (operationId) => {
    assert.equal(operationId, wallClock.context.operationId);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await pool.query(
      "update funding_reconciliation_jobs set lease_until=$2 where operation_id=$1",
      [operationId, new Date(Date.now() - 1)],
    );
    return { receiptsPolled: 0 };
  },
});
assert.equal(
  (await inspectFundingEvidenceRepair(pool, wallClock.context.operationId))
    ?.processedGeneration,
  0,
  "production dispatch must use a fresh completion clock after acquisition, not the frozen batch time",
);
const expiredJob = (
  await pool.query(
    "select id,lease_owner,lease_token from funding_reconciliation_jobs where operation_id=$1",
    [wallClock.context.operationId],
  )
).rows[0];
await assert.rejects(
  finishFundingLeaseRaw(pool, {
    jobId: expiredJob.id,
    leaseOwner: expiredJob.lease_owner,
    leaseToken: expiredJob.lease_token,
    result: {
      kind: "error",
      dueAt: new Date(),
      deadLetter: true,
      errorCode: "test_expiry",
      errorSummary: "test",
    },
  }),
  (error: unknown) =>
    error instanceof Error && "code" in error && error.code === "lease_lost",
);
console.log(
  "[embedded-funding-submission-integration-tests] real-wall completion and raw-finisher lease expiry fences passed",
);
await pool.query(
  `update funding_reconciliation_jobs set status='dead_letter',completed_at=now(),
  due_at='infinity'::timestamptz,priority=0,lease_owner=null,lease_token=null,lease_until=null where id=$1`,
  [expiredJob.id],
);

// A concrete wake must migrate a stopped legacy waiter immediately, even when
// both housekeeping timestamps are brand new and no repair envelope exists.
for (const stickyMarker of [false, true]) {
  const legacyWake = await fixture(false, "trade_shortfall", "user");
  const at = stickyMarker ? new Date() : new Date(repairNow.getTime() + 10_000);
  await tx(pool, async (client) => {
    await finishFundingStepAttemptInTransaction(client, {
      attemptId: legacyWake.context.attemptId,
      outcome: "submitted",
      broadcastMayHaveOccurred: true,
      referenceKind: "transaction",
      receiptRefCiphertext: codec.encrypt(`0x${"94".repeat(32)}`),
      receiptRefLookupHmac: codec.fingerprint(`0x${"94".repeat(32)}`),
      lookupKeyVersion: 1,
      actualCosts: {},
    });
    await applyFundingStepReceiptEvidenceInTransaction(client, {
      ...legacyWake.context,
      networkId: asset.networkId,
      now: at,
      receipt: {
        status: "mismatch",
        actionMatch: false,
        canonical: true,
        ledgerHeight: "10",
        blockHash: `0x${"82".repeat(32)}`,
        failureCode: "transaction_action_mismatch",
        evidence: { transactionObserved: true },
      },
    });
    await reduceFundingOperationInTransaction(client, {
      operationId: legacyWake.context.operationId,
      now: at,
    });
    await client.query(
      `update funding_operations set updated_at=$2,version=version+1,
      support_metadata=(support_metadata-'evidenceRepairV1') || $3::jsonb where id=$1`,
      [
        legacyWake.context.operationId,
        at,
        JSON.stringify(
          stickyMarker ? { evidenceOnlyRecoveryAt: at.toISOString() } : {},
        ),
      ],
    );
    await client.query(
      `update funding_reconciliation_jobs set status='dead_letter', due_at='infinity',completed_at=$2,
      updated_at=$2,priority=50000,lease_owner=null,lease_token=null,lease_until=null where operation_id=$1`,
      [legacyWake.context.operationId, at],
    );
    await wakeFundingReconciliationInTransaction(client, {
      operationId: legacyWake.context.operationId,
      dueAt: at,
      priority: 50000,
    });
  });
  let acquired = 0;
  await runFundingReconciliationBatch(pool, {
    workerId: "legacy-addressed-wake",
    limit: 1,
    concurrency: 1,
    now: at,
    receiptPoll: async (operationId) => {
      assert.equal(operationId, legacyWake.context.operationId);
      acquired++;
      assert.ok(
        (await inspectFundingEvidenceRepair(pool, operationId))?.evidenceOnly,
      );
      return { receiptsPolled: 0 };
    },
  });
  assert.equal(
    acquired,
    1,
    "a fresh addressed legacy wake bypasses manual review and the five-minute gate",
  );
  const inspected = await inspectFundingEvidenceRepair(
    pool,
    legacyWake.context.operationId,
  );
  assert.equal(inspected?.processedGeneration, 1);
  assert.equal(inspected?.operationStatus, "recovery_required");
  assert.equal(
    (
      await pool.query(
        "select count(*)::int as total from funding_operation_step_attempts where step_id=$1",
        [legacyWake.context.stepId],
      )
    ).rows[0].total,
    1,
  );
  await pool.query(
    `update funding_reconciliation_jobs set status='dead_letter',due_at='infinity',
    priority=0,completed_at=$2,lease_owner=null,lease_token=null,lease_until=null where operation_id=$1`,
    [legacyWake.context.operationId, at],
  );
}

// Both an ordinary terminal watch and an ordinary no-envelope observation must
// lose apply authority when a new repair request arrives during the RPC.
for (const terminalRepair of [false, true]) {
  const watched = await fixture(false, "trade_shortfall", "user");
  const at = terminalRepair
    ? new Date(repairNow.getTime() + 20_000)
    : new Date();
  const reference = `0x${"95".repeat(32)}`;
  await tx(pool, async (client) => {
    await finishFundingStepAttemptInTransaction(client, {
      attemptId: watched.context.attemptId,
      outcome: "submitted",
      broadcastMayHaveOccurred: true,
      referenceKind: "transaction",
      receiptRefCiphertext: codec.encrypt(reference),
      receiptRefLookupHmac: codec.fingerprint(reference),
      lookupKeyVersion: 1,
      actualCosts: {},
    });
    if (terminalRepair) {
      await applyFundingStepReceiptEvidenceInTransaction(client, {
        ...watched.context,
        networkId: asset.networkId,
        now: at,
        receipt: {
          status: "failed",
          actionMatch: true,
          canonical: true,
          ledgerHeight: "10",
          blockHash: `0x${"83".repeat(32)}`,
          failureCode: "transaction_reverted",
          evidence: { transactionObserved: true, failureFinalized: true },
        },
      });
      const reduced = await reduceFundingOperationInTransaction(client, {
        operationId: watched.context.operationId,
        now: at,
      });
      assert.equal(reduced.terminal, true);
    }
    await client.query(
      "update funding_reconciliation_jobs set priority=60000 where operation_id=$1",
      [watched.context.operationId],
    );
  });
  if (terminalRepair) {
    await requestFundingEvidenceRepair(pool, {
      operationId: watched.context.operationId,
      idempotencyKey: "initialize-terminal-watch",
      now: at,
    });
    await runFundingReconciliationBatch(pool, {
      workerId: "initialize-terminal-watch",
      now: at,
      limit: 1,
      concurrency: 1,
      receiptPoll: async () => ({ receiptsPolled: 0 }),
    });
    const initialized = await inspectFundingEvidenceRepair(
      pool,
      watched.context.operationId,
    );
    assert.equal(initialized?.processedGeneration, initialized?.generation);
  }
  const observedAt = new Date(at.getTime() + 1);
  await tx(pool, (client) =>
    wakeFundingReconciliationInTransaction(client, {
      operationId: watched.context.operationId,
      dueAt: observedAt,
      priority: 60000,
    }),
  );
  let requestedVersion: number | null = null;
  let observations = 0;
  const racingDriver = new FundingStepReceiptReconciliationDriver(codec, {
    inspectEvm: async (): Promise<FundingStepReceiptEvidence> => {
      observations++;
      if (!terminalRepair)
        await pool.query(
          "update funding_operation_steps set action_expires_at=$2 where id=$1",
          [watched.context.stepId, at],
        );
      await requestFundingEvidenceRepair(pool, {
        operationId: watched.context.operationId,
        idempotencyKey: "new-generation-during-ordinary-watch",
        now: observedAt,
      });
      requestedVersion = Number(
        (
          await pool.query(
            "select version from funding_operations where id=$1",
            [watched.context.operationId],
          )
        ).rows[0].version,
      );
      return {
        status: terminalRepair ? "reorged" : "finalized",
        actionMatch: true,
        canonical: !terminalRepair,
        ledgerHeight: "10",
        blockHash: `0x${"83".repeat(32)}`,
        failureCode: null,
        evidence: {
          transactionObserved: true,
          failureFinalized: terminalRepair,
        },
      };
    },
  });
  await runFundingReconciliationBatch(pool, {
    workerId: "ordinary-acquisition-race",
    now: observedAt,
    limit: 1,
    concurrency: 1,
    receiptPoll: (operationId, now, options) =>
      racingDriver.pollOperation(pool, operationId, now, options),
  });
  assert.equal(observations, 1);
  const storedReceipt = (
    await pool.query(
      "select status from funding_step_receipt_observations where attempt_id=$1",
      [watched.context.attemptId],
    )
  ).rows[0];
  assert.equal(
    storedReceipt?.status ?? null,
    terminalRepair ? "failed" : null,
    "an ordinary observation cannot apply across the first or next repair generation",
  );
  const after = await inspectFundingEvidenceRepair(
    pool,
    watched.context.operationId,
  );
  assert.ok(after && after.processedGeneration < after.generation);
  assert.equal(after.jobStatus, "scheduled");
  assert.equal(
    Number(
      (
        await pool.query("select version from funding_operations where id=$1", [
          watched.context.operationId,
        ])
      ).rows[0].version,
    ),
    requestedVersion,
    "stale ordinary error/reduction paths must not publish after the newer request",
  );
  await pool.query(
    `update funding_reconciliation_jobs set status='dead_letter',due_at='infinity',
    priority=0,completed_at=$2,lease_owner=null,lease_token=null,lease_until=null where operation_id=$1`,
    [watched.context.operationId, observedAt],
  );
}
console.log(
  "[embedded-funding-submission-integration-tests] addressed legacy wake and ordinary generation/absence apply fences passed",
);

const headerFailure = await fixture(false, "trade_shortfall", "user");
const headerAt = new Date(repairNow.getTime() + 30_000);
await pool.query(
  `update funding_operations set version=version+1,
  support_metadata=support_metadata || jsonb_build_object(
    'reconciliationActiveSince',$2::text,'reconciliationActiveAttemptBaseline',0,
    'reconciliationEvidenceDeadline',$2::text) where id=$1`,
  [headerFailure.context.operationId, headerAt.toISOString()],
);
await pool.query(
  "update funding_reconciliation_jobs set priority=80000 where operation_id=$1",
  [headerFailure.context.operationId],
);
let failedHeader = false;
let versionAfterHeaderRequest: number | null = null;
const failingHeaderPool = {
  connect: () => pool.connect(),
  query: async (sql: string, values: unknown[] = []) => {
    if (
      !failedHeader &&
      sql
        .trim()
        .startsWith(
          "select operation_row.status, operation_row.recovery_mode, operation_row.support_metadata,",
        ) &&
      values[0] === headerFailure.context.operationId
    ) {
      failedHeader = true;
      await requestFundingEvidenceRepair(pool, {
        operationId: headerFailure.context.operationId,
        idempotencyKey: "request-during-header-failure",
        now: headerAt,
      });
      versionAfterHeaderRequest = Number(
        (
          await pool.query(
            "select version from funding_operations where id=$1",
            [headerFailure.context.operationId],
          )
        ).rows[0].version,
      );
      throw new Error("simulated dispatch-header failure");
    }
    return pool.query(sql, values);
  },
} as unknown as Pool;
await runFundingReconciliationBatch(failingHeaderPool, {
  workerId: "header-authority-race",
  now: headerAt,
  limit: 1,
  concurrency: 1,
  retryDelayMs: 1200,
  receiptPoll: async () => {
    throw new Error("no acquisition without dispatch authority");
  },
});
assert.equal(failedHeader, true);
const afterHeaderFailure = (
  await pool.query(
    `select version,
  support_metadata->>'reconciliationActiveSince' as active_since from funding_operations where id=$1`,
    [headerFailure.context.operationId],
  )
).rows[0];
assert.equal(
  Number(afterHeaderFailure.version),
  versionAfterHeaderRequest,
  "header failure must not run unfenced support-fact/lifecycle recovery after a new generation",
);
assert.equal(afterHeaderFailure.active_since, headerAt.toISOString());
const headerJob = (
  await pool.query(
    "select status,due_at,last_error_code from funding_reconciliation_jobs where operation_id=$1",
    [headerFailure.context.operationId],
  )
).rows[0];
assert.equal(headerJob.status, "scheduled");
assert.equal(
  headerJob.due_at.getTime(),
  headerAt.getTime(),
  "the newer addressed wake remains earlier than technical retry",
);
assert.equal(
  headerJob.last_error_code,
  "funding_observation_authority_unavailable",
);
await pool.query(
  `update funding_reconciliation_jobs set status='dead_letter',due_at='infinity',priority=0,completed_at=$2
  where operation_id=$1`,
  [headerFailure.context.operationId, headerAt],
);
console.log(
  "[embedded-funding-submission-integration-tests] failed-header/new-generation race performs job-only recovery passed",
);
