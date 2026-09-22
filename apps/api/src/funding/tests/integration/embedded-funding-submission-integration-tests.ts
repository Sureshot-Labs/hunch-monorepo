#!/usr/bin/env tsx
// @requires-db
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { tx } from "@hunch/infra";
import "../../../integration-test-database-guard.js";
import { pool } from "../../../db.js";
import { canonicalJsonHash } from "../../persistence/canonical.js";
import {
  createFundingQuoteInTransaction,
  commitFundingOperationInTransaction,
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
import { listFundingStepReceiptTargets } from "../../persistence/funding-step-receipt-repository.js";
import { loadFundingLifecycleFactsForOperationInTransaction } from "../../lifecycle/funding-lifecycle-facts-repository.js";

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

async function fixture(versioned = true) {
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
        purpose: "add_funds",
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
          payerRequirement: "privy_sponsor",
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
