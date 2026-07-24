#!/usr/bin/env tsx

import assert from "node:assert/strict";

import {
  EVM_FUNDING_ACTION_FINALITY_CONFIRMATIONS,
  evaluateEvmActionReceipt,
  evaluateSvmActionReceipt,
  FundingStepReceiptReconciliationDriver,
} from "../../execution/step-receipt-reconciler.js";
import type {
  FundingStepReceiptEvidence,
  FundingStepReceiptTarget,
} from "../../persistence/funding-step-receipt-repository.js";

const evmAction = {
  kind: "evm_transaction" as const,
  actionId: "action_evm_12345678",
  networkId: "evm:137",
  senderWalletId: "wallet_evm_12345678",
  to: "0x2222222222222222222222222222222222222222",
  data: "0xabcdef",
  valueRaw: "0",
  gasLimitRaw: "200000",
};
const evmTransaction = {
  chainId: 137n,
  from: "0x1111111111111111111111111111111111111111",
  to: evmAction.to,
  data: evmAction.data,
  value: 0n,
};
const evmReceipt = {
  succeeded: true,
  blockNumber: 10,
  blockHash: `0x${"ab".repeat(32)}`,
  confirmations: EVM_FUNDING_ACTION_FINALITY_CONFIRMATIONS,
  canonicalBlockHash: `0x${"ab".repeat(32)}`,
};

assert.equal(
  evaluateEvmActionReceipt({
    action: evmAction,
    expectedSignerAddress: evmTransaction.from,
    transaction: evmTransaction,
    receipt: evmReceipt,
    previous: null,
  }).status,
  "finalized",
);
assert.equal(
  evaluateEvmActionReceipt({
    action: evmAction,
    expectedSignerAddress: evmTransaction.from,
    transaction: { ...evmTransaction, data: "0xdeadbeef" },
    receipt: evmReceipt,
    previous: null,
  }).status,
  "mismatch",
);
assert.equal(
  evaluateEvmActionReceipt({
    action: evmAction,
    expectedSignerAddress: evmTransaction.from,
    transaction: evmTransaction,
    receipt: { ...evmReceipt, succeeded: false },
    previous: null,
  }).status,
  "failed",
);
assert.equal(
  evaluateEvmActionReceipt({
    action: evmAction,
    expectedSignerAddress: evmTransaction.from,
    transaction: evmTransaction,
    receipt: {
      ...evmReceipt,
      canonicalBlockHash: `0x${"cd".repeat(32)}`,
    },
    previous: null,
  }).status,
  "reorged",
);

const svmAction = {
  kind: "svm_transaction" as const,
  actionId: "action_svm_12345678",
  networkId: "solana:mainnet",
  signerWalletId: "wallet_svm_12345678",
  instructions: [
    {
      programId: "11111111111111111111111111111111",
      accounts: [
        {
          address: "Vote111111111111111111111111111111111111111",
          signer: false,
          writable: true,
        },
      ],
      data: "00",
      dataEncoding: "hex" as const,
    },
  ],
  addressLookupTables: [] as const,
};
const svmSigner = "Stake11111111111111111111111111111111111111";
const svmTransaction = {
  confirmationStatus: "finalized" as const,
  failed: false,
  slot: 123,
  signers: [svmSigner],
  instructions: [
    {
      programId: svmAction.instructions[0].programId,
      accounts: [svmAction.instructions[0].accounts[0].address],
      dataHex: svmAction.instructions[0].data,
    },
  ],
  addressLookupTables: [] as const,
};
assert.equal(
  evaluateSvmActionReceipt({
    action: svmAction,
    expectedSignerAddress: svmSigner,
    transaction: svmTransaction,
    previous: null,
  }).status,
  "finalized",
);
assert.equal(
  evaluateSvmActionReceipt({
    action: svmAction,
    expectedSignerAddress: svmSigner,
    transaction: {
      ...svmTransaction,
      instructions: [{ ...svmTransaction.instructions[0], dataHex: "01" }],
    },
    previous: null,
  }).status,
  "mismatch",
);

const reference = `0x${"12".repeat(32)}`;
const target: FundingStepReceiptTarget = {
  operationId: "00000000-0000-4000-8000-000000000001",
  stepId: "00000000-0000-4000-8000-000000000002",
  segmentId: "00000000-0000-4000-8000-000000000003",
  attemptId: "00000000-0000-4000-8000-000000000004",
  stepKind: "transaction",
  stepState: "submitted",
  networkId: evmAction.networkId,
  action: evmAction,
  actionValidationResult: { signerAddress: evmTransaction.from },
  receiptRefCiphertext: `encrypted:${reference}`,
  receiptRefLookupHmac: `fingerprint:${reference}`,
  lookupKeyVersion: 1,
  previousReceipt: null,
};
const applied: FundingStepReceiptEvidence[] = [];
const driver = new FundingStepReceiptReconciliationDriver(
  {
    keyVersion: 1,
    encrypt: (value) => `encrypted:${value}`,
    decrypt: (value) => value.slice("encrypted:".length),
    fingerprint: (value) => `fingerprint:${value}`,
  },
  {
    listTargets: async () => [target],
    inspectEvm: async () => ({
      status: "finalized",
      actionMatch: true,
      ledgerHeight: "10",
      blockHash: evmReceipt.blockHash,
      canonical: true,
      failureCode: null,
      evidence: {},
    }),
    applyEvidence: async (_pool, input) => {
      applied.push(input.receipt);
      return {
        operationId: input.operationId,
        stepId: input.stepId,
        attemptId: input.attemptId,
        networkId: input.networkId,
        ...input.receipt,
        firstSeenAt: input.now ?? new Date(),
        observedAt: input.now ?? new Date(),
        finalizedAt: input.now ?? new Date(),
        reorgedAt: null,
      };
    },
  },
);
const driverResult = await driver.pollOperation(
  {} as never,
  target.operationId,
  new Date("2026-07-24T10:00:00.000Z"),
);
assert.deepEqual(driverResult, { receiptsPolled: 1, receiptsFinalized: 1 });
assert.equal(applied[0]?.status, "finalized");

console.log(
  "[funding-step-receipt-tests] exact EVM/Solana receipt matching, finality, failure, reorg, and persisted polling passed",
);
