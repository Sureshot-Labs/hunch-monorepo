// @requires-db — dedicated disposable PG16. Unique offline fixtures retained
// for multi-transaction prepare/admission. Never invokes provider transport.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Wallet } from "ethers";
import { createIntegrationTestPool } from "../../../test-database-target.js";
import { hypercorePlanTestFixture } from "../../../funding-providers/relay/hypercore-plan-test-fixture.js";
import { normalizeRelayHypercoreWalletQuote } from "../../../funding-providers/relay/wallet-adapter.js";
import { buildRelayPlanningQuote } from "../../../funding-providers/relay/operation-plan.js";
import {
  createFundingQuoteInTransaction,
  commitFundingOperationInTransaction,
} from "../../persistence/funding-operation-repository.js";
import {
  registerFundingWithdrawalDestinationInTransaction,
  revokeFundingWithdrawalDestinationInTransaction,
  fetchFundingOperationStepForUser,
} from "../../persistence/funding-evidence-repository.js";
import { createWithdrawalDestinationCodec } from "../../execution/withdrawal-destination-codec.js";
import { resolveWithdrawalDestination } from "../../execution/withdrawal-destination-runtime.js";
import { WITHDRAWAL_DESTINATION_CONTRACT_REVISION } from "../../domain/withdrawal-contract.js";
import {
  admitNativeFundingAuthInTransaction,
  admitNativeFundingSendInTransaction,
  finishNativeFundingAuthInTransaction,
  nativeFundingPreparationInTransaction,
  NATIVE_FUNDING_OPERATION_LOCK_SQL,
} from "../../execution/hypercore-auth-attempt.js";
import { createFundingTransactionReferenceCodec } from "../../execution/transaction-reference-codec.js";
import { DEFAULT_FUNDING_RUNTIME_POLICY } from "../../policies/funding-policy.js";
import { DEFAULT_FUNDING_INTENT_POLICY } from "../../policies/funding-policy-v2.js";
import type { AccountValueReadModel } from "../../../account-value/runtime-service.js";

const pool = await createIntegrationTestPool({
  max: 2,
  options: "-c statement_timeout=15000",
});
// API-only imports may load repository .env; bind and verify the disposable
// pool first. All runtime work below is injected with this exact pool.
const { FundingOperationActionRuntime } =
  await import("../../execution/operation-action-runtime.js");
// Isolated process: use fake local encryption material, never read real keys.
process.env.CREDENTIALS_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
process.env.FUNDING_REFERENCE_LOOKUP_HMAC_KEY =
  "offline-native-api-recipient-key-at-least-32";
process.env.FUNDING_REFERENCE_LOOKUP_KEY_VERSION = "1";
const codecConfig = {
  encryptionKey: Buffer.alloc(32, 7),
  lookupHmacKey: process.env.FUNDING_REFERENCE_LOOKUP_HMAC_KEY,
  keyVersion: 1,
};
const codec = createWithdrawalDestinationCodec(codecConfig);
const policyOff = {
  policy: DEFAULT_FUNDING_INTENT_POLICY,
  runtime: { ...DEFAULT_FUNDING_RUNTIME_POLICY, creationMode: "off" as const },
  revision: "changed-policy",
  invalidStoredPolicy: true,
};
const client = await pool.connect();
let inTransaction = false;
try {
  assert.equal(
    (
      await client.query("show server_version_num")
    ).rows[0].server_version_num.slice(0, 2),
    "16",
  );
  await client.query("begin");
  inTransaction = true;
  const userId = (
    await client.query(
      "insert into users(email,is_active,is_verified) values($1,true,true) returning id",
      [`native-api-${randomUUID()}@example.com`],
    )
  ).rows[0].id as string;
  const wallet = Wallet.createRandom();
  const fixture = hypercorePlanTestFixture(new Date(), userId, wallet.address);
  const profile = fixture.input.profile;
  await client.query(
    "insert into user_wallets(id,user_id,wallet_address,wallet_type,is_verified,is_internal_wallet,wallet_source,privy_wallet_id,privy_profile_updated_at) values($1,$2,$3,'ethereum',true,true,'embedded',$4,clock_timestamp())",
    [profile.walletId, userId, profile.address, profile.serverWalletRef],
  );
  const address = fixture.input.destination.recipientAddress;
  assert.ok(address);
  const asset = fixture.input.destination.requiredAsset;
  const now = new Date();
  const registered = await registerFundingWithdrawalDestinationInTransaction(
    client,
    {
      userId,
      networkId: asset.networkId,
      assetId: asset.assetId,
      assetDecimals: asset.decimals,
      addressCiphertext: codec.encrypt(address),
      addressLookupHmac: codec.fingerprint(address),
      lookupKeyVersion: 1,
      validationEvidence: {
        policyRevision: WITHDRAWAL_DESTINATION_CONTRACT_REVISION,
        validatedAt: now.toISOString(),
      },
      policyVersion: 1,
      expiresAt: new Date(now.getTime() + 10000),
      now,
    },
  );
  const resolved = await resolveWithdrawalDestination(client, {
    userId,
    recipientId: registered.destination.id,
  });
  const { address: _address, ...recipient } = resolved;
  const destination = {
    ...fixture.input.destination,
    target: { kind: "external_recipient" as const, recipient },
    externalRecipientId: recipient.recipientId,
  };
  const normalized = normalizeRelayHypercoreWalletQuote({
    ...fixture.quoteInput,
    destination,
  });
  const plan = (
    await buildRelayPlanningQuote({
      ...fixture.input,
      destination,
      quote: normalized,
    })
  ).commitPlan;
  assert.equal(plan.operation.purpose, "withdrawal");
  assert.ok(plan.operation.sourceSnapshot);
  const consentToken = randomUUID();
  const quote = await createFundingQuoteInTransaction(client, {
    userId,
    discoveryProjectionId: randomUUID(),
    selectedSourceOptionSnapshot: plan.operation.sourceSnapshot,
    marketContextSnapshot: null,
    destinationOptionSnapshot: plan.operation.destinationTargetSnapshot,
    venueBindingSnapshot: null,
    planSnapshot: plan,
    policyVersion: 1,
    policyRevision: fixture.input.policyRevision,
    canonicalRequest: { test: "native-api" },
    consentToken,
    expiresAt: new Date(normalized.candidate.expiresAt),
  });
  const committed = await commitFundingOperationInTransaction(client, {
    userId,
    quoteId: quote.id,
    consentToken,
    idempotencyKey: randomUUID(),
    plan,
    subjectLookupHmac: "c".repeat(64),
    subjectLookupKeyVersion: 1,
  });
  const operationId = committed.operation.id;
  const steps = (
    await client.query(
      "select id from funding_operation_steps where operation_id=$1 order by ordinal",
      [operationId],
    )
  ).rows;
  const authId = steps[0].id as string,
    sendId = steps[1].id as string;
  await client.query("commit");
  inTransaction = false;
  const runtime = new FundingOperationActionRuntime(pool, {
    readAccount: async () =>
      ({
        ownership: { wallets: [profile] },
      }) as unknown as AccountValueReadModel,
  });
  await assert.rejects(
    runtime.prepare(userId, { operationId, stepId: authId }),
    /sign-only submission protocol/,
  );
  await assert.rejects(
    runtime.prepare(userId, {
      operationId,
      stepId: sendId,
      submissionProtocols: { native: 1 },
    }),
    /not currently actionable/,
  );
  const auth = await runtime.prepare(userId, {
    operationId,
    stepId: authId,
    submissionProtocols: { native: 1 },
  });
  assert.equal(auth.payerRequirement, "none");
  assert.equal(auth.nativeSubmission?.stage, "nonce_mapping");
  console.log(
    "PASS actual common prepare negotiates native lease; dependency and legacy-client guard",
  );
  const { pair } = await nativeFundingPreparationInTransaction(
    pool,
    operationId,
    sendId,
  );
  const typed = pair.validated.authorization.typedData;
  assert.deepEqual(auth.nativeSubmission?.typedData, typed);
  assert.equal(
    auth.nativeSubmission?.digest,
    pair.validated.authorization.digest,
  );
  assert.equal(auth.nativeSubmission?.signer, wallet.address.toLowerCase());
  const authInput = {
    userId,
    operationId,
    stepId: authId,
    attemptId: auth.attemptId,
    signature: await wallet.signTypedData(
      typed.domain,
      typed.types,
      typed.message,
    ),
  };
  await client.query("begin");
  inTransaction = true;
  const admitted = await admitNativeFundingAuthInTransaction(
    client,
    authInput,
    policyOff,
  );
  assert.equal(admitted.admitted, true);
  assert.ok(admitted.requestFingerprint);
  await finishNativeFundingAuthInTransaction(client, {
    ...authInput,
    requestFingerprint: admitted.requestFingerprint,
    authorized: true,
  });
  await client.query("commit");
  inTransaction = false;
  const authReport = await runtime.report(userId, {
    operationId,
    stepId: authId,
    attemptId: auth.attemptId,
    outcome: "ambiguous",
    transactionReference: null,
    failureCode: "client_execution_failed",
    actualCosts: { networkFeeRaw: null },
  });
  assert.equal(authReport.accepted, true);
  const send = await runtime.prepare(userId, {
    operationId,
    stepId: sendId,
    submissionProtocols: { native: 1 },
  });
  assert.equal(send.nativeSubmission?.stage, "send_asset");
  assert.equal(
    (
      await fetchFundingOperationStepForUser(pool, {
        userId,
        operationId,
        stepId: authId,
      })
    )?.nonMoneyAuthorization,
    true,
  );
  assert.equal(
    (
      await fetchFundingOperationStepForUser(pool, {
        userId,
        operationId,
        stepId: sendId,
      })
    )?.nonMoneyAuthorization,
    undefined,
  );
  const sendTyped = pair.validated.transfer.typedData;
  assert.deepEqual(send.nativeSubmission?.typedData, sendTyped);
  assert.equal(send.nativeSubmission?.digest, pair.validated.transfer.digest);
  const sendInput = {
    userId,
    operationId,
    stepId: sendId,
    attemptId: send.attemptId,
    signature: await wallet.signTypedData(
      sendTyped.domain,
      sendTyped.types,
      sendTyped.message,
    ),
  };
  const capacity = async () => ({
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  });
  const sendCodec = createFundingTransactionReferenceCodec(codecConfig);
  await client.query("begin");
  inTransaction = true;
  await revokeFundingWithdrawalDestinationInTransaction(client, {
    userId,
    destinationId: recipient.recipientId,
    reason: "user_revoked",
    cryptoShred: true,
  });
  await assert.rejects(
    admitNativeFundingSendInTransaction(
      client,
      sendInput,
      policyOff,
      capacity,
      sendCodec,
    ),
    /revoked or expired/,
  );
  await client.query("rollback");
  inTransaction = false;
  console.log(
    "PASS final send admission rejects recipient revoked after prepare",
  );
  await client.query("begin");
  inTransaction = true;
  const sent = await admitNativeFundingSendInTransaction(
    client,
    sendInput,
    policyOff,
    capacity,
    sendCodec,
  );
  assert.equal(sent.admitted, true);
  await revokeFundingWithdrawalDestinationInTransaction(client, {
    userId,
    destinationId: recipient.recipientId,
    reason: "user_revoked",
    cryptoShred: true,
  });
  const replay = await admitNativeFundingSendInTransaction(
    client,
    sendInput,
    policyOff,
    async () => {
      throw new Error("must not recheck capacity");
    },
    sendCodec,
  );
  assert.equal(replay.admitted, false);
  await client.query("rollback");
  inTransaction = false;
  console.log(
    "PASS funding pause does not block user withdrawal; admitted replay survives revocation without resend",
  );
  await client.query("begin");
  inTransaction = true;
  // A blocked capacity check can outlive the immutable recipient. Final DB
  // clock must reject before durable money ambiguity, after initial resolution.
  await assert.rejects(
    admitNativeFundingSendInTransaction(
      client,
      sendInput,
      policyOff,
      async () => {
        await client.query(
          "select pg_sleep(greatest(0,extract(epoch from ($1::timestamptz-clock_timestamp())))+0.05)",
          [recipient.expiresAt],
        );
        return capacity();
      },
      sendCodec,
    ),
    /expired before admission/,
  );
  await client.query("rollback");
  inTransaction = false;
  console.log(
    "PASS recipient expiry during admission wait is checked with final DB clock",
  );
  await assert.rejects(
    runtime.prepare(randomUUID(), {
      operationId,
      stepId: authId,
      submissionProtocols: { native: 1 },
    }),
    /not found/,
  );
  console.log(
    "PASS cross-user prepare cannot access committed native operation",
  );
  const rejectedSigning = await runtime.report(userId, {
    operationId,
    stepId: sendId,
    attemptId: send.attemptId,
    outcome: "failed",
    transactionReference: null,
    failureCode: null,
    actualCosts: { networkFeeRaw: null },
  });
  assert.equal(rejectedSigning.accepted, true);
  assert.equal(rejectedSigning.stepState, "failed");
  console.log(
    "PASS actual common report accepts native auth ACK and pre-submit signing failure",
  );
  // Real PG16 parses both admission and prepare's shared query at representative
  // cardinality. Temporary shadow table only; no bulk data in financial tables.
  await client.query("begin");
  inTransaction = true;
  await client.query(`create temporary table funding_operations (
    id uuid primary key, user_id uuid not null, policy_revision text, policy_version integer,
    wallet_execution_snapshot jsonb, source_snapshot jsonb, purpose text,
    external_recipient_id uuid, destination_target_snapshot jsonb) on commit drop`);
  await client.query(
    `insert into funding_operations
    select gen_random_uuid(), $1::uuid, 'revision', 1, '{}'::jsonb, '{}'::jsonb,
    'withdrawal', null::uuid, '{}'::jsonb from generate_series(1,100000)`,
    [userId],
  );
  await client.query("analyze funding_operations");
  await client.query("set local plan_cache_mode=force_generic_plan");
  await client.query(
    `prepare native_operation_lock(uuid,uuid) as ${NATIVE_FUNDING_OPERATION_LOCK_SQL}`,
  );
  const existingId = (
    await client.query("select id from funding_operations limit 1")
  ).rows[0].id;
  for (const [probeId, probeUser, expected] of [
    [existingId, userId, 1],
    [randomUUID(), userId, 0],
    [existingId, randomUUID(), 0],
  ] as const) {
    assert.match(probeId, /^[a-f0-9-]{36}$/);
    assert.match(probeUser, /^[a-f0-9-]{36}$/);
    const planRow = (
      await client.query(
        `explain(analyze,buffers,format json) execute native_operation_lock('${probeId}','${probeUser}')`,
      )
    ).rows[0]["QUERY PLAN"][0];
    assert.equal(planRow.Plan["Actual Rows"], expected);
    assert.equal(
      JSON.stringify(planRow).includes('"Node Type":"Seq Scan"'),
      false,
    );
    console.log("PASS native operation generic plan", {
      rows: expected,
      executionMs: planRow["Execution Time"],
      localBlocks:
        planRow.Plan["Local Hit Blocks"] + planRow.Plan["Local Read Blocks"],
    });
  }
  await client.query("rollback");
  inTransaction = false;
} finally {
  if (inTransaction) await client.query("rollback");
  client.release();
  await pool.end();
}
