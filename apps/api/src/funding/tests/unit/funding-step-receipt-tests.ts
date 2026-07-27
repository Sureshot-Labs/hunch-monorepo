#!/usr/bin/env tsx

import assert from "node:assert/strict";
import { ethers } from "ethers";

import {
  EVM_FUNDING_ACTION_FINALITY_CONFIRMATIONS,
  evaluateEvmActionReceipt,
  evaluatePolymarketDepositWalletHandoffReceipt,
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
  logs: [],
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

const entryPointAddress = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";
const entryPoint = new ethers.Interface([
  "function handleOps((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature)[] ops,address beneficiary)",
  "event UserOperationEvent(bytes32 indexed userOpHash,address indexed sender,address indexed paymaster,uint256 nonce,bool success,uint256 actualGasCost,uint256 actualUserOpFeePerGas)",
]);
const smartAccount = new ethers.Interface([
  "function execute(bytes32 execMode,bytes executionCalldata)",
]);
const userOperationNonce = 7n;
const sponsoredSigner = evmTransaction.from;
const sponsoredTransactionBeneficiary =
  "0x4444444444444444444444444444444444444444";
const executionCalldata = ethers.concat([
  evmAction.to,
  ethers.zeroPadValue(ethers.toBeHex(BigInt(evmAction.valueRaw)), 32),
  evmAction.data,
]);
const smartAccountCall = smartAccount.encodeFunctionData("execute", [
  `0x${"00".repeat(32)}`,
  executionCalldata,
]);
const sponsoredTransaction = {
  chainId: 137n,
  from: "0x3333333333333333333333333333333333333333",
  to: entryPointAddress,
  data: entryPoint.encodeFunctionData("handleOps", [
    [
      {
        sender: sponsoredSigner,
        nonce: userOperationNonce,
        initCode: "0x",
        callData: smartAccountCall,
        accountGasLimits: `0x${"00".repeat(32)}`,
        preVerificationGas: 0,
        gasFees: `0x${"00".repeat(32)}`,
        paymasterAndData: "0x",
        signature: "0x",
      },
    ],
    sponsoredTransactionBeneficiary,
  ]),
  value: 0n,
};
const userOperationEvent = entryPoint.getEvent("UserOperationEvent");
if (!userOperationEvent) {
  throw new Error("UserOperationEvent ABI is unavailable");
}
const sponsoredEvent = entryPoint.encodeEventLog(userOperationEvent, [
  `0x${"12".repeat(32)}`,
  sponsoredSigner,
  ethers.ZeroAddress,
  userOperationNonce,
  true,
  0,
  0,
]);
const sponsoredReceipt = {
  ...evmReceipt,
  logs: [
    {
      address: entryPointAddress,
      data: sponsoredEvent.data,
      topics: sponsoredEvent.topics,
    },
  ],
};
assert.equal(
  evaluateEvmActionReceipt({
    action: evmAction,
    expectedSignerAddress: sponsoredSigner,
    transaction: sponsoredTransaction,
    receipt: sponsoredReceipt,
    previous: null,
    executionEnvelope: "privy_erc4337",
  }).status,
  "finalized",
);
assert.equal(
  evaluateEvmActionReceipt({
    action: evmAction,
    expectedSignerAddress: "0x5555555555555555555555555555555555555555",
    transaction: sponsoredTransaction,
    receipt: sponsoredReceipt,
    previous: null,
    executionEnvelope: "privy_erc4337",
  }).status,
  "mismatch",
);
const failedSponsoredEvent = entryPoint.encodeEventLog(userOperationEvent, [
  `0x${"12".repeat(32)}`,
  sponsoredSigner,
  ethers.ZeroAddress,
  userOperationNonce,
  false,
  0,
  0,
]);
assert.equal(
  evaluateEvmActionReceipt({
    action: evmAction,
    expectedSignerAddress: sponsoredSigner,
    transaction: sponsoredTransaction,
    receipt: {
      ...sponsoredReceipt,
      logs: [
        {
          address: entryPointAddress,
          data: failedSponsoredEvent.data,
          topics: failedSponsoredEvent.topics,
        },
      ],
    },
    previous: null,
    executionEnvelope: "privy_erc4337",
  }).status,
  "failed",
);

const transferInterface = new ethers.Interface([
  "function transfer(address recipient,uint256 amount)",
  "event Transfer(address indexed from,address indexed to,uint256 value)",
]);
const handoffToken = "0x6666666666666666666666666666666666666666";
const handoffFunder = "0x7777777777777777777777777777777777777777";
const handoffRecipient = "0x8888888888888888888888888888888888888888";
const handoffAmount = 1_037_960n;
const handoffData = transferInterface.encodeFunctionData("transfer", [
  handoffRecipient,
  handoffAmount,
]);
const handoffAction = {
  kind: "external_handoff" as const,
  actionId: "action_handoff_12345678",
  networkId: "evm:137",
  actorWalletId: "wallet_handoff_12345678",
  handoffKind: "polymarket_deposit_wallet_transfer",
  payload: {
    topology: "deposit_wallet",
    funder: handoffFunder,
    recipient: handoffRecipient,
    token: handoffToken,
    amountRaw: handoffAmount.toString(),
    calls: [{ target: handoffToken, value: "0", data: handoffData }],
  },
};
const handoffValidation = {
  signerAddress: evmTransaction.from,
  executionEnvelope: "polymarket_deposit_wallet_to_controller_v1",
  funderAddress: handoffFunder,
  recipientAddress: handoffRecipient,
  tokenAddress: handoffToken,
  amountRaw: handoffAmount.toString(),
  transferData: handoffData,
};
const transferEvent = transferInterface.getEvent("Transfer");
if (!transferEvent) throw new Error("Transfer event ABI is unavailable");
const exactTransferLog = transferInterface.encodeEventLog(transferEvent, [
  handoffFunder,
  handoffRecipient,
  handoffAmount,
]);
const handoffTransaction = {
  ...evmTransaction,
  from: "0x9999999999999999999999999999999999999999",
  to: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  data: "0x12345678",
};
const handoffReceipt = {
  ...evmReceipt,
  logs: [
    {
      address: handoffToken,
      data: exactTransferLog.data,
      topics: exactTransferLog.topics,
    },
  ],
};
assert.equal(
  evaluatePolymarketDepositWalletHandoffReceipt({
    action: handoffAction,
    actionValidationResult: handoffValidation,
    transaction: handoffTransaction,
    receipt: handoffReceipt,
    previous: null,
  }).status,
  "finalized",
);
const extraTransferLog = transferInterface.encodeEventLog(transferEvent, [
  handoffFunder,
  "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  1n,
]);
assert.equal(
  evaluatePolymarketDepositWalletHandoffReceipt({
    action: handoffAction,
    actionValidationResult: handoffValidation,
    transaction: handoffTransaction,
    receipt: {
      ...handoffReceipt,
      logs: [
        ...handoffReceipt.logs,
        {
          address: handoffToken,
          data: extraTransferLog.data,
          topics: extraTransferLog.topics,
        },
      ],
    },
    previous: null,
  }).status,
  "mismatch",
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
  payerRequirement: "user",
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
