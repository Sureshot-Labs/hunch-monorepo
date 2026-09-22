import assert from "node:assert/strict";
import {
  Keypair,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import type {
  EvmTransactionAction,
  SvmTransactionAction,
} from "../../domain/types.js";
import {
  assertEmbeddedExecutionScope,
  assertEmbeddedFundingAuthorizationSignatures,
  embeddedFundingExecutionKey,
  parseEmbeddedFundingSubmission,
  validateEmbeddedFundingPayload,
  type EmbeddedFundingPayload,
  type EmbeddedFundingSubmission,
} from "../../execution/embedded-funding-submission-contract.js";
import {
  embeddedEvmExecuteBodySchema,
  embeddedSolanaExecuteBodySchema,
} from "../../../schemas/embedded-wallets.js";
import { fundingOperationActionPrepareRequestSchema } from "../../../schemas/funding.js";

const signer = `0x${"11".repeat(20)}`;
const to = `0x${"22".repeat(20)}`;
const action: EvmTransactionAction = {
  kind: "evm_transaction",
  actionId: "action",
  networkId: "evm:137",
  senderWalletId: "wallet",
  to,
  data: "0x1234",
  valueRaw: "7",
  gasLimitRaw: null,
};
const lease: EmbeddedFundingSubmission = {
  version: 1,
  phase: "prepared",
  expiresAt: "2026-09-22T12:00:00Z",
  signer,
  payer: "privy_sponsor",
};
const payload: Extract<EmbeddedFundingPayload, { kind: "ethereum" }> = {
  kind: "ethereum",
  signer,
  chainId: 137,
  executionMode: "sequential",
  returnOnAccepted: true,
  transactions: [{ to, data: "0x1234", value: "0x7", sponsor: true }],
};
validateEmbeddedFundingPayload(action, lease, payload);
const transaction = payload.transactions[0];
assert.ok(transaction);
validateEmbeddedFundingPayload(action, lease, {
  ...payload,
  transactions: [{ ...transaction, sponsor: undefined }],
}); // EVM defaults to sponsorship.
for (const modified of [
  { ...payload, chainId: 1 },
  { ...payload, signer: to },
  { ...payload, returnOnAccepted: false },
  { ...payload, executionMode: "atomic" as const },
  { ...payload, transactions: [{ ...transaction, value: "8" }] },
  {
    ...payload,
    transactions: [{ ...transaction, data: "0x1235" }],
  },
  { ...payload, transactions: [{ ...transaction, gas: "123" }] },
  {
    ...payload,
    transactions: [{ ...transaction, sponsor: false }],
  },
  {
    ...payload,
    transactions: [...payload.transactions, ...payload.transactions],
  },
])
  assert.throws(
    () => validateEmbeddedFundingPayload(action, lease, modified),
    /committed action/,
  );
assert.throws(() =>
  validateEmbeddedFundingPayload(
    action,
    { ...lease, payer: "user" },
    {
      ...payload,
      transactions: [{ ...transaction, sponsor: undefined }],
    },
  ),
);
validateEmbeddedFundingPayload(
  action,
  { ...lease, payer: "user" },
  {
    ...payload,
    transactions: [{ ...transaction, sponsor: false }],
  },
);
const batch = {
  kind: "evm_transaction_batch" as const,
  actionId: "batch",
  networkId: "evm:137",
  senderWalletId: "wallet",
  calls: [
    { actionId: "one", to, data: "0x1234", valueRaw: "7" },
    { actionId: "two", to: signer, data: "0xab", valueRaw: "0" },
  ],
};
const batchPayload = {
  ...payload,
  executionMode: "atomic" as const,
  transactions: [
    ...payload.transactions,
    { to: signer, data: "0xab", value: "0", sponsor: true },
  ],
};
validateEmbeddedFundingPayload(batch, lease, batchPayload);
assert.throws(() =>
  validateEmbeddedFundingPayload(batch, lease, {
    ...batchPayload,
    executionMode: "sequential",
  }),
);
assert.throws(() =>
  validateEmbeddedFundingPayload(batch, lease, {
    ...batchPayload,
    transactions: [...batchPayload.transactions].reverse(),
  }),
);

const solanaSigner = Keypair.generate().publicKey;
const recipient = Keypair.generate().publicKey;
const ix = SystemProgram.transfer({
  fromPubkey: solanaSigner,
  toPubkey: recipient,
  lamports: 7,
});
const solanaAction: SvmTransactionAction = {
  kind: "svm_transaction",
  actionId: "solana-action",
  networkId: "solana:mainnet",
  signerWalletId: "solana-wallet",
  addressLookupTables: [],
  instructions: [
    {
      programId: ix.programId.toBase58(),
      accounts: ix.keys.map((key) => ({
        address: key.pubkey.toBase58(),
        signer: key.isSigner,
        writable: key.isWritable,
      })),
      data: `0x${ix.data.toString("hex")}`,
      dataEncoding: "hex",
    },
  ],
};
const blockhash = Keypair.generate().publicKey.toBase58();
const makeTransaction = (lamports: number) =>
  Buffer.from(
    new VersionedTransaction(
      new TransactionMessage({
        payerKey: solanaSigner,
        recentBlockhash: blockhash,
        instructions: [
          SystemProgram.transfer({
            fromPubkey: solanaSigner,
            toPubkey: recipient,
            lamports,
          }),
        ],
      }).compileToV0Message(),
    ).serialize(),
  ).toString("base64");
const solanaLease = {
  ...lease,
  signer: solanaSigner.toBase58(),
  payer: "user" as const,
};
const solanaPayload: Extract<EmbeddedFundingPayload, { kind: "solana" }> = {
  kind: "solana",
  signer: solanaSigner.toBase58(),
  lookupTables: [],
  transactions: [{ transaction: makeTransaction(7), sponsor: false }],
};
validateEmbeddedFundingPayload(solanaAction, solanaLease, solanaPayload);
const solanaTransaction = solanaPayload.transactions[0];
assert.ok(solanaTransaction);
assert.throws(() =>
  validateEmbeddedFundingPayload(solanaAction, solanaLease, {
    ...solanaPayload,
    transactions: [{ transaction: makeTransaction(8), sponsor: false }],
  }),
);
assert.throws(() =>
  validateEmbeddedFundingPayload(solanaAction, solanaLease, {
    ...solanaPayload,
    transactions: [{ ...solanaTransaction, sponsor: true }],
  }),
);
assert.throws(() =>
  validateEmbeddedFundingPayload(solanaAction, solanaLease, {
    ...solanaPayload,
    transactions: [{ ...solanaTransaction, caip2: "solana:devnet" }],
  }),
);
assert.throws(() =>
  validateEmbeddedFundingPayload(solanaAction, solanaLease, {
    ...solanaPayload,
    signer: recipient.toBase58(),
  }),
);

const context = {
  operationId: "11111111-1111-4111-8111-111111111111",
  stepId: "22222222-2222-4222-8222-222222222222",
  attemptId: "33333333-3333-4333-8333-333333333333",
};
assert.throws(
  () => assertEmbeddedExecutionScope(embeddedFundingExecutionKey(context)),
  /scoped submission context/,
);
assertEmbeddedExecutionScope(embeddedFundingExecutionKey(context), context);
assertEmbeddedExecutionScope("legacy-embedded-key");
assertEmbeddedFundingAuthorizationSignatures(
  [{ id: "expected" }],
  [{ id: "expected", signature: "authorization" }],
);
for (const signatures of [
  [],
  [{ id: "wrong", signature: "authorization" }],
  [{ id: "expected", signature: " " }],
  [
    { id: "expected", signature: "authorization" },
    { id: "extra", signature: "authorization" },
  ],
])
  assert.throws(() =>
    assertEmbeddedFundingAuthorizationSignatures(
      [{ id: "expected" }],
      signatures,
    ),
  );
assert.equal(
  parseEmbeddedFundingSubmission({ ...lease, phase: "wrong" }),
  null,
);
assert.equal(parseEmbeddedFundingSubmission({ ...lease, version: 0 }), null);
assert.equal(parseEmbeddedFundingSubmission(lease)?.phase, "prepared");
assert.deepEqual(
  fundingOperationActionPrepareRequestSchema.parse(undefined),
  undefined,
);
assert.deepEqual(fundingOperationActionPrepareRequestSchema.parse(null), null); // Fastify bodyless POST.
assert.deepEqual(
  fundingOperationActionPrepareRequestSchema.parse({
    submissionProtocols: { safe: 1, embedded: 1 },
  }),
  { submissionProtocols: { safe: 1, embedded: 1 } },
);
assert.equal(
  fundingOperationActionPrepareRequestSchema.safeParse({
    submissionProtocols: { embedded: 2 },
  }).success,
  false,
);
for (const schema of [
  embeddedEvmExecuteBodySchema,
  embeddedSolanaExecuteBodySchema,
]) {
  assert.equal(
    schema.safeParse({
      fundingContext: { ...context, attemptId: "arbitrary-client-key" },
    }).success,
    false,
  );
}
console.log(
  "embedded funding exact payload/negotiation/scope contract tests passed",
);
