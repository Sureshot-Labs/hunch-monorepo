#!/usr/bin/env tsx
// @requires-db
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { tx } from "@hunch/infra";
import { ethers } from "ethers";
import "../../../integration-test-database-guard.js";
import { pool } from "../../../db.js";
import { deriveSafeProxyAddress } from "../../../services/polymarket-safe-address.js";
import { canonicalJsonHash } from "../../persistence/canonical.js";
import {
  commitFundingOperationInTransaction,
  createFundingQuoteInTransaction,
  type FundingCommitPlan,
} from "../../persistence/funding-operation-repository.js";
import {
  finishFundingStepAttemptForUserInTransaction,
  startFundingStepAttemptForUserInTransaction,
} from "../../persistence/funding-evidence-repository.js";
import {
  admitSafeFundingSubmissionInTransaction,
  closeExpiredSafeFundingPreparationsInTransaction,
  submitSafeFundingAction,
  SafeFundingSubmissionUnknownError,
} from "../../execution/safe-funding-submission.js";
import {
  SAFE_FUNDING_SUBMISSION_METADATA,
  SAFE_FUNDING_TX_TYPES,
} from "../../execution/safe-funding-submission-contract.js";
import { createFundingTransactionReferenceCodec } from "../../execution/transaction-reference-codec.js";
import {
  reduceFundingOperationInTransaction,
  runFundingReconciliationBatch,
} from "../../reconciliation/funding-reducer.js";
import { listFundingStepReceiptTargets } from "../../persistence/funding-step-receipt-repository.js";
import { finishFundingActionReportAndReduce } from "../../execution/operation-action-runtime.js";

const opaque = () => crypto.randomUUID();
const owner = ethers.Wallet.createRandom();
const safe = deriveSafeProxyAddress(owner.address);
const recipient = "0x00000000000000000000000000000000000000a1";
const asset = {
  networkId: "evm:137",
  assetId: "0x2791bca1f2de4661ed88a30c99a7a9449aa84174",
  decimals: 6,
} as const;
const data = new ethers.Interface([
  "function transfer(address,uint256)",
]).encodeFunctionData("transfer", [recipient, 1_000_000n]);
const safeHash = ethers.TypedDataEncoder.hash(
  { chainId: 137, verifyingContract: safe },
  SAFE_FUNDING_TX_TYPES,
  {
    to: asset.assetId,
    value: 0,
    data,
    operation: 0,
    safeTxGas: 0,
    baseGas: 0,
    gasPrice: 0,
    gasToken: ethers.ZeroAddress,
    refundReceiver: ethers.ZeroAddress,
    nonce: "0",
  },
);
const signature = await owner.signMessage(ethers.getBytes(safeHash));
const request = {
  from: owner.address,
  to: ethers.getAddress(asset.assetId),
  proxyWallet: safe,
  data,
  nonce: "0",
  signature:
    signature.slice(0, -2) +
    (parseInt(signature.slice(-2), 16) + 4).toString(16),
  signatureParams: {
    gasPrice: "0",
    operation: "0",
    safeTxnGas: "0",
    baseGas: "0",
    gasToken: ethers.ZeroAddress,
    refundReceiver: ethers.ZeroAddress,
  },
  type: "SAFE",
  metadata: SAFE_FUNDING_SUBMISSION_METADATA,
};
const codec = createFundingTransactionReferenceCodec({
  encryptionKey: crypto.randomBytes(32),
  lookupHmacKey: crypto.randomBytes(32).toString("hex"),
  keyVersion: 1,
});
const credentials = {
  key: "test-key",
  secret: Buffer.from("test-only-secret").toString("base64"),
  passphrase: "test-only-passphrase",
};
const admissionPolicy = async () => undefined;
const user = await pool.query<{ id: string }>(
  "insert into users(email,is_active,is_verified) values($1,true,true) returning id",
  [`safe-cancel-${opaque()}@example.com`],
);
assert.ok(user.rows[0]);
const userId = user.rows[0].id;

async function fixture(versioned = true) {
  return tx(pool, async (client) => {
    const source = {
      kind: "wallet" as const,
      locationId: opaque(),
      accountId: userId,
      asset,
      details: { walletId: opaque(), address: safe },
    };
    const destination = {
      ...source,
      locationId: opaque(),
      details: { walletId: opaque(), address: recipient },
    };
    const action = {
      kind: "external_handoff" as const,
      actionId: opaque(),
      networkId: asset.networkId,
      actorWalletId: source.details.walletId,
      handoffKind: "polymarket_safe_transfer",
      payload: {
        topology: "safe",
        owner: owner.address,
        funder: safe,
        token: asset.assetId,
        amountRaw: "1000000",
        recipient,
        recipientWalletId: destination.details.walletId,
        executionEnvelope: "polymarket_safe_to_owned_wallet_v1",
        calls: [{ target: asset.assetId, value: "0", data }],
      },
    };
    const validation = {
      executionEnvelope: "polymarket_safe_to_owned_wallet_v1",
      funderAddress: safe,
      recipientAddress: recipient,
      recipientWalletId: destination.details.walletId,
      signerAddress: owner.address,
      tokenAddress: asset.assetId,
      amountRaw: "1000000",
      transferData: data,
    };
    const deadline = new Date(Date.now() + 600_000).toISOString();
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
            .update(opaque())
            .digest("hex"),
          depositAddressCiphertext: null,
          depositAddressLookupHmac: null,
          lookupKeyVersion: 1,
          refundLocationSnapshot: source,
          quoteExpiresAt: deadline,
        },
      ],
      steps: [
        {
          ordinal: 0,
          segmentOrdinal: 0,
          stepKind: "external_handoff",
          state: "action_required",
          actionFingerprint: canonicalJsonHash(action),
          executorId: "polymarket_safe_relayer_v1",
          payerRequirement: "provider",
          dependsOnOrdinal: null,
          normalizedAction: action,
          actionValidationResult: validation,
        },
      ],
      reservations: [
        {
          segmentOrdinal: 0,
          componentId: opaque(),
          locationId: source.locationId,
          networkId: asset.networkId,
          assetId: asset.assetId,
          assetDecimals: 6,
          rawAmount: "1000000",
          mode: "subtract_available",
          expiresAt: deadline,
        },
      ],
    };
    const consentToken = opaque();
    assert.ok(plan.operation.sourceSnapshot);
    const quote = await createFundingQuoteInTransaction(client, {
      userId,
      discoveryProjectionId: opaque(),
      selectedSourceOptionSnapshot: plan.operation.sourceSnapshot,
      marketContextSnapshot: null,
      destinationOptionSnapshot: plan.operation.destinationTargetSnapshot,
      venueBindingSnapshot: null,
      planSnapshot: plan,
      policyVersion: 1,
      policyRevision: "safe_submission_test",
      canonicalRequest: {},
      consentToken,
      expiresAt: new Date(deadline),
    });
    const committed = await commitFundingOperationInTransaction(client, {
      userId,
      quoteId: quote.id,
      consentToken,
      idempotencyKey: opaque(),
      plan,
      subjectLookupHmac: crypto
        .createHash("sha256")
        .update(userId)
        .digest("hex"),
      subjectLookupKeyVersion: 1,
    });
    const steps = await client.query<{ id: string }>(
      "select id from funding_operation_steps where operation_id=$1",
      [committed.operation.id],
    );
    assert.ok(steps.rows[0]);
    const stepId = steps.rows[0].id;
    const started = await startFundingStepAttemptForUserInTransaction(client, {
      userId,
      operationId: committed.operation.id,
      stepId,
      canonicalActionFingerprint: canonicalJsonHash(action),
      executorId: "polymarket_safe_relayer_v1",
      ...(versioned ? { safeSubmissionProtocol: true as const } : {}),
    });
    return {
      operationId: committed.operation.id,
      stepId,
      attemptId: started.attempt.id,
      request,
    };
  });
}

async function expire(input: Awaited<ReturnType<typeof fixture>>) {
  return tx(pool, async (client) => {
    await client.query(
      "select id from funding_operations where id=$1 for update",
      [input.operationId],
    );
    const changed = await closeExpiredSafeFundingPreparationsInTransaction(
      client,
      input.operationId,
      new Date(Date.now() + 180_000),
    );
    if (changed)
      await reduceFundingOperationInTransaction(client, {
        operationId: input.operationId,
        now: new Date(Date.now() + 180_000),
      });
    return changed;
  });
}

async function attempt(input: Awaited<ReturnType<typeof fixture>>) {
  const result = await pool.query<{
    outcome: string;
    broadcast_may_have_occurred: boolean;
    actual_costs: { safeSubmission?: { phase: string } };
    receipt_ref_ciphertext: string | null;
  }>(
    "select outcome,broadcast_may_have_occurred,actual_costs,receipt_ref_ciphertext from funding_operation_step_attempts where id=$1",
    [input.attemptId],
  );
  assert.ok(result.rows[0]);
  return result.rows[0];
}

const abandoned = await fixture();
assert.equal(await expire(abandoned), true);
assert.equal((await attempt(abandoned)).outcome, "cancelled");
assert.equal(
  (
    await pool.query(
      "select 1 from balance_reservations where operation_id=$1 and state='active'",
      [abandoned.operationId],
    )
  ).rowCount,
  0,
  "expiry must release the actual source reservation through the reducer",
);
await assert.rejects(
  tx(pool, (client) =>
    admitSafeFundingSubmissionInTransaction(
      client,
      userId,
      abandoned,
      undefined,
      codec,
    ),
  ),
  /closed|executable/,
);

const admitted = await fixture();
const admissions = await Promise.all([
  tx(pool, (client) =>
    admitSafeFundingSubmissionInTransaction(
      client,
      userId,
      admitted,
      undefined,
      codec,
    ),
  ),
  tx(pool, (client) =>
    admitSafeFundingSubmissionInTransaction(
      client,
      userId,
      admitted,
      undefined,
      codec,
    ),
  ),
]);
assert.deepEqual(
  admissions.map((value) => value.admitted).sort(),
  [false, true],
  "concurrent submission admits exactly once",
);
assert.equal(
  await expire(admitted),
  false,
  "expired signing lease cannot release an admitted send",
);
await tx(pool, (client) =>
  finishFundingStepAttemptForUserInTransaction(client, {
    userId,
    ...admitted,
    outcome: "cancelled",
    broadcastMayHaveOccurred: false,
    referenceKind: null,
    receiptRefCiphertext: null,
    receiptRefLookupHmac: null,
    lookupKeyVersion: null,
    actualCosts: { networkFeeRaw: null },
  }),
).catch((error) => {
  assert.match(String(error), /evidence|admitted|finalized|submission/);
});
assert.equal(
  (await attempt(admitted)).broadcast_may_have_occurred,
  true,
  "late cancellation must not erase durable admission",
);

const legacy = await fixture(false);
assert.equal(await expire(legacy), false);
assert.equal(
  (await attempt(legacy)).outcome,
  "started",
  "unversioned legacy uncertainty must not acquire a negative guarantee",
);

const neverAdmitted = await fixture();
await tx(pool, (client) =>
  finishFundingStepAttemptForUserInTransaction(client, {
    userId,
    ...neverAdmitted,
    outcome: "ambiguous",
    broadcastMayHaveOccurred: true,
    referenceKind: null,
    receiptRefCiphertext: null,
    receiptRefLookupHmac: null,
    lookupKeyVersion: null,
    actualCosts: { networkFeeRaw: null, reasonCode: "client_execution_failed" },
  }),
);
assert.equal(
  (await attempt(neverAdmitted)).outcome,
  "started",
  "client write-ahead journal is not server submission evidence",
);
assert.equal(
  await expire(neverAdmitted),
  true,
  "lost POST before admission remains recoverable",
);

const rejectedSignature = await fixture();
const rejectedReport = {
  userId,
  ...rejectedSignature,
  outcome: "cancelled" as const,
  broadcastMayHaveOccurred: false,
  referenceKind: null,
  receiptRefCiphertext: null,
  receiptRefLookupHmac: null,
  lookupKeyVersion: null,
  actualCosts: { networkFeeRaw: null },
};
await finishFundingActionReportAndReduce(pool, rejectedReport);
assert.equal(
  (
    await pool.query(
      "select 1 from balance_reservations where operation_id=$1 and state='active'",
      [rejectedSignature.operationId],
    )
  ).rowCount,
  0,
  "negative report acknowledgement must not race ahead of released balance",
);
const staleJournal = await tx(pool, (client) =>
  finishFundingStepAttemptForUserInTransaction(client, {
    ...rejectedReport,
    outcome: "ambiguous",
    broadcastMayHaveOccurred: true,
  }),
);
assert.equal(
  staleJournal.stepState,
  "cancelled",
  "a late pre-submit journal cannot resurrect cancelled signing in the UI",
);
await assert.rejects(
  tx(pool, (client) =>
    admitSafeFundingSubmissionInTransaction(
      client,
      userId,
      rejectedSignature,
      undefined,
      codec,
    ),
  ),
  /closed/,
);

let calls = 0;
const lost = await fixture();
const unknownFetch: typeof fetch = async () => {
  calls++;
  throw new Error("synthetic lost response");
};
await assert.rejects(
  submitSafeFundingAction(pool, userId, lost, credentials, {
    fetchImpl: unknownFetch,
    codec,
    admissionPolicy,
  }),
  SafeFundingSubmissionUnknownError,
);
const recoveredIdentity = await submitSafeFundingAction(
  pool,
  userId,
  lost,
  credentials,
  {
    fetchImpl: unknownFetch,
    codec,
    admissionPolicy,
  },
);
assert.match(
  recoveredIdentity.transactionReference,
  /^polymarket-safe:v1:/,
  "repeat reads the durable identity without another POST",
);
assert.equal(calls, 1, "a lost response must never resend the Safe transfer");
assert.equal(await expire(lost), false);
assert.equal(
  (await listFundingStepReceiptTargets(pool, lost.operationId)).length,
  1,
  "lost provider response still has a receipt-polling identity",
);

const accepted = await fixture();
calls = 0;
const successFetch: typeof fetch = async () => {
  calls++;
  return Response.json({ transactionID: "test-safe-submission-12345678" });
};
const first = await submitSafeFundingAction(
  pool,
  userId,
  accepted,
  credentials,
  { fetchImpl: successFetch, codec, admissionPolicy },
);
const replay = await submitSafeFundingAction(
  pool,
  userId,
  accepted,
  credentials,
  { fetchImpl: successFetch, codec, admissionPolicy },
);
assert.deepEqual(first, replay);
assert.equal(calls, 1);
assert.equal(
  (await attempt(accepted)).outcome,
  "ambiguous",
  "provider acceptance is not chain confirmation",
);
const acceptedCiphertext = (await attempt(accepted)).receipt_ref_ciphertext;
assert.ok(acceptedCiphertext);
assert.equal(
  codec.decrypt(acceptedCiphertext),
  first.transactionReference,
  "receipt persists independently of browser report",
);
const acceptedTargets = await listFundingStepReceiptTargets(
  pool,
  accepted.operationId,
);
assert.equal(acceptedTargets.length, 1);
assert.ok(acceptedTargets[0]?.safeSubmissionProviderResult);
assert.equal(
  codec.decrypt(
    acceptedTargets[0].safeSubmissionProviderResult.referenceCiphertext,
  ),
  "polymarket-relayer:v1:test-safe-submission-12345678",
  "server persists provider identity without changing original signed identity",
);

// Force expiry to own the operation lock while a valid signed submit waits.
const expiryWins = await fixture();
const blocker = await pool.connect();
try {
  await blocker.query("begin");
  await blocker.query(
    "select id from funding_operations where id=$1 for update",
    [expiryWins.operationId],
  );
  const waitingAdmission = tx(pool, (client) =>
    admitSafeFundingSubmissionInTransaction(
      client,
      userId,
      expiryWins,
      undefined,
      codec,
    ),
  );
  const rejection = assert.rejects(waitingAdmission, /closed|executable/);
  assert.equal(
    await closeExpiredSafeFundingPreparationsInTransaction(
      blocker,
      expiryWins.operationId,
      new Date(Date.now() + 180_000),
    ),
    true,
  );
  await blocker.query("commit");
  await rejection;
} finally {
  await blocker.query("rollback");
  blocker.release();
}

const workerExpired = await fixture();
await pool.query(
  "update funding_reconciliation_jobs set priority=100000,due_at=now() where operation_id=$1",
  [workerExpired.operationId],
);
const workerResult = await runFundingReconciliationBatch(pool, {
  workerId: opaque(),
  limit: 1,
  now: new Date(Date.now() + 180_000),
});
assert.equal(workerResult.failed, 0);
assert.equal(
  (await attempt(workerExpired)).outcome,
  "cancelled",
  "background worker closes abandoned signing without a returning browser",
);
assert.equal(
  (
    await pool.query(
      "select 1 from balance_reservations where operation_id=$1 and state='active'",
      [workerExpired.operationId],
    )
  ).rowCount,
  0,
);

console.log(
  "[safe-funding-submission-integration-tests] expiry, reservations, admission race, lost response, durable receipt and legacy safety passed",
);
