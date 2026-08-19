#!/usr/bin/env tsx

import assert from "node:assert/strict";
import { ethers } from "ethers";

import {
  EVM_FUNDING_ACTION_FINALITY_CONFIRMATIONS,
  FAST_EVM_FUNDING_ACTION_FINALITY_CONFIRMATIONS,
  evmFundingActionFinalityConfirmations,
  evaluateEvmActionReceipt,
  evaluatePolymarketDepositWalletHandoffReceipt,
  evaluateSvmActionReceipt,
  FundingStepReceiptReconciliationDriver,
} from "../../execution/step-receipt-reconciler.js";
import {
  normalizePolymarketDepositWalletTransactionReference,
  polymarketDepositWalletHandoffExpectation,
} from "../../execution/polymarket-deposit-wallet-handoff.js";
import type {
  FundingStepReceiptEvidence,
  FundingStepReceiptObservation,
  FundingStepReceiptTarget,
} from "../../persistence/funding-step-receipt-repository.js";
import {
  fundingStepStateForReceipt,
  listFundingStepReceiptTargets,
  shouldIgnoreFundingStepReceiptUpdate,
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

assert.equal(evmFundingActionFinalityConfirmations(137n), 1);
assert.equal(evmFundingActionFinalityConfirmations(8453n), 1);
assert.equal(
  evmFundingActionFinalityConfirmations(1n),
  EVM_FUNDING_ACTION_FINALITY_CONFIRMATIONS,
);
assert.equal(
  evaluateEvmActionReceipt({
    action: evmAction,
    expectedSignerAddress: evmTransaction.from,
    transaction: evmTransaction,
    receipt: {
      ...evmReceipt,
      confirmations: FAST_EVM_FUNDING_ACTION_FINALITY_CONFIRMATIONS - 1,
    },
    previous: null,
  }).status,
  "confirmed",
);
assert.equal(
  evaluateEvmActionReceipt({
    action: evmAction,
    expectedSignerAddress: evmTransaction.from,
    transaction: evmTransaction,
    receipt: {
      ...evmReceipt,
      confirmations: FAST_EVM_FUNDING_ACTION_FINALITY_CONFIRMATIONS,
    },
    previous: null,
  }).status,
  "finalized",
);

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

const destinationToken = "0x7777777777777777777777777777777777777777";
const destinationWallet = "0x8888888888888888888888888888888888888888";
const exactCreditInterface = new ethers.Interface([
  "event Transfer(address indexed from,address indexed to,uint256 value)",
]);
const exactCreditEvent = exactCreditInterface.getEvent("Transfer");
if (!exactCreditEvent) throw new Error("Transfer event ABI is unavailable");
const exactDestinationCreditLog = exactCreditInterface.encodeEventLog(
  exactCreditEvent,
  [ethers.ZeroAddress, destinationWallet, 4_000_000n],
);
const exactCreditValidation = {
  postconditionEvidenceKind: "exact_erc20_destination_credit_v1",
  expectedDestinationAssetId: destinationToken,
  expectedDestinationAddress: destinationWallet,
  expectedDestinationRaw: "4000000",
};
const exactCreditReceipt = evaluateEvmActionReceipt({
  action: evmAction,
  actionValidationResult: exactCreditValidation,
  expectedSignerAddress: evmTransaction.from,
  transaction: evmTransaction,
  receipt: {
    ...evmReceipt,
    logs: [
      {
        address: destinationToken,
        data: exactDestinationCreditLog.data,
        topics: exactDestinationCreditLog.topics,
      },
    ],
  },
  previous: null,
});
assert.equal(exactCreditReceipt.status, "finalized");
assert.equal(exactCreditReceipt.actionMatch, true);
assert.equal(exactCreditReceipt.evidence.attributedDestinationRaw, "4000000");

const sourceToken = "0x9999999999999999999999999999999999999999";
const sourceRecipient = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const exactSourceDebitLog = exactCreditInterface.encodeEventLog(
  exactCreditEvent,
  [evmTransaction.from, sourceRecipient, 4_000_000n],
);
const exactSourceDebitReceipt = evaluateEvmActionReceipt({
  action: evmAction,
  actionValidationResult: {
    postconditionEvidenceKind: "exact_erc20_source_debit_v1",
    expectedSourceAssetId: sourceToken,
    expectedSourceAddress: evmTransaction.from,
    expectedSourceRecipient: sourceRecipient,
    expectedSourceRaw: "4000000",
  },
  expectedSignerAddress: evmTransaction.from,
  transaction: evmTransaction,
  receipt: {
    ...evmReceipt,
    logs: [
      {
        address: sourceToken,
        data: exactSourceDebitLog.data,
        logIndex: 17,
        topics: exactSourceDebitLog.topics,
      },
    ],
  },
  previous: null,
});
assert.equal(exactSourceDebitReceipt.status, "finalized");
assert.equal(exactSourceDebitReceipt.actionMatch, true);
assert.equal(exactSourceDebitReceipt.evidence.attributedSourceRaw, "4000000");
assert.equal(exactSourceDebitReceipt.evidence.sourceDebitEventIndex, "17");

const excessiveDestinationCreditLog = exactCreditInterface.encodeEventLog(
  exactCreditEvent,
  [ethers.ZeroAddress, destinationWallet, 4_000_001n],
);
const excessiveCreditReceipt = evaluateEvmActionReceipt({
  action: evmAction,
  actionValidationResult: exactCreditValidation,
  expectedSignerAddress: evmTransaction.from,
  transaction: evmTransaction,
  receipt: {
    ...evmReceipt,
    logs: [
      {
        address: destinationToken,
        data: excessiveDestinationCreditLog.data,
        topics: excessiveDestinationCreditLog.topics,
      },
    ],
  },
  previous: null,
});
assert.equal(excessiveCreditReceipt.status, "mismatch");
assert.equal(excessiveCreditReceipt.actionMatch, false);
assert.equal(
  excessiveCreditReceipt.failureCode,
  "destination_credit_amount_mismatch",
);
assert.equal(
  excessiveCreditReceipt.evidence.attributedDestinationRaw,
  "4000001",
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
    receipt: {
      ...evmReceipt,
      succeeded: false,
      confirmations: FAST_EVM_FUNDING_ACTION_FINALITY_CONFIRMATIONS - 1,
    },
    previous: null,
  }).status,
  "confirmed",
);
const finalizedFailure = evaluateEvmActionReceipt({
  action: evmAction,
  expectedSignerAddress: evmTransaction.from,
  transaction: evmTransaction,
  receipt: {
    ...evmReceipt,
    succeeded: false,
    confirmations: FAST_EVM_FUNDING_ACTION_FINALITY_CONFIRMATIONS,
  },
  previous: null,
});
assert.equal(finalizedFailure.status, "failed");
assert.equal(finalizedFailure.failureCode, "transaction_reverted");
assert.equal(finalizedFailure.evidence.failureFinalized, true);
const finalizedFailureObservation: FundingStepReceiptObservation = {
  operationId: "00000000-0000-4000-8000-000000000111",
  stepId: "00000000-0000-4000-8000-000000000112",
  attemptId: "00000000-0000-4000-8000-000000000113",
  networkId: evmAction.networkId,
  status: "failed",
  actionMatch: true,
  ledgerHeight: evmReceipt.blockNumber.toString(),
  blockHash: evmReceipt.blockHash,
  canonical: true,
  failureCode: finalizedFailure.failureCode,
  evidence: finalizedFailure.evidence,
  firstSeenAt: new Date(0),
  observedAt: new Date(0),
  finalizedAt: new Date(0),
  reorgedAt: null,
};
const reorgedFinalizedFailure = evaluateEvmActionReceipt({
  action: evmAction,
  expectedSignerAddress: evmTransaction.from,
  transaction: evmTransaction,
  receipt: null,
  previous: finalizedFailureObservation,
});
assert.equal(reorgedFinalizedFailure.status, "reorged");
assert.equal(
  shouldIgnoreFundingStepReceiptUpdate("failed", reorgedFinalizedFailure),
  false,
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
const sponsoredUserOperation = {
  sender: sponsoredSigner,
  nonce: userOperationNonce,
  initCode: "0x",
  callData: smartAccountCall,
  accountGasLimits: `0x${"00".repeat(32)}`,
  preVerificationGas: 0,
  gasFees: `0x${"00".repeat(32)}`,
  paymasterAndData: "0x",
  signature: "0x",
};
const sponsoredTransaction = {
  chainId: 137n,
  from: "0x3333333333333333333333333333333333333333",
  to: entryPointAddress,
  data: entryPoint.encodeFunctionData("handleOps", [
    [sponsoredUserOperation],
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
const sponsoredExactCreditReceipt = {
  ...sponsoredReceipt,
  logs: [
    ...sponsoredReceipt.logs,
    {
      address: destinationToken,
      data: exactDestinationCreditLog.data,
      topics: exactDestinationCreditLog.topics,
    },
  ],
};
assert.equal(
  evaluateEvmActionReceipt({
    action: evmAction,
    actionValidationResult: exactCreditValidation,
    expectedSignerAddress: sponsoredSigner,
    transaction: sponsoredTransaction,
    receipt: sponsoredExactCreditReceipt,
    previous: null,
    executionEnvelope: "privy_erc4337",
  }).status,
  "finalized",
);
const batchAction = {
  kind: "evm_transaction_batch" as const,
  actionId: "action_batch_12345678",
  networkId: evmAction.networkId,
  senderWalletId: evmAction.senderWalletId,
  calls: [
    {
      actionId: "action_approve_12345678",
      to: "0x2222222222222222222222222222222222222222",
      data: "0xabcdef",
      valueRaw: "0",
    },
    {
      actionId: "action_relay_12345678",
      to: "0x5555555555555555555555555555555555555555",
      data: "0x1234",
      valueRaw: "7",
    },
  ],
};
let receiptTargetQuery = "";
const [batchReceiptTarget] = await listFundingStepReceiptTargets(
  {
    query: async (query: unknown) => {
      receiptTargetQuery = String(query);
      return {
        rows: [
          {
            operation_id: "operation_batch_12345678",
            step_id: "step_batch_12345678",
            segment_id: null,
            attempt_id: "attempt_batch_12345678",
            step_kind: "transaction",
            payer_requirement: "privy_sponsor",
            step_state: "succeeded",
            normalized_action: batchAction,
            action_validation_result: {},
            receipt_ref_ciphertext: "ciphertext",
            receipt_ref_lookup_hmac: "lookup-hmac",
            lookup_key_version: 1,
            receipt_operation_id: "operation_batch_12345678",
            receipt_step_id: "step_batch_12345678",
            receipt_attempt_id: "attempt_batch_12345678",
            receipt_network_id: evmAction.networkId,
            receipt_status: "confirmed",
            receipt_action_match: true,
            receipt_ledger_height: "10",
            receipt_block_hash: `0x${"ab".repeat(32)}`,
            receipt_canonical: true,
            receipt_failure_code: null,
            receipt_evidence: {},
            receipt_first_seen_at: new Date("2026-07-30T09:39:46.013Z"),
            receipt_observed_at: new Date("2026-07-30T09:39:46.013Z"),
            receipt_finalized_at: null,
            receipt_reorged_at: null,
          },
        ],
      };
    },
  } as unknown as Parameters<typeof listFundingStepReceiptTargets>[0],
  "operation_batch_12345678",
  new Date("2026-07-30T09:54:46.013Z"),
);
assert.equal(batchReceiptTarget?.action.kind, "evm_transaction_batch");
assert.equal(batchReceiptTarget?.stepState, "succeeded");
assert.equal(batchReceiptTarget?.previousReceipt?.status, "confirmed");
assert.match(receiptTargetQuery, /or step\.state = 'succeeded'/u);
assert.match(
  receiptTargetQuery,
  /receipt\.finalized_at >= \$2::timestamptz - interval '15 minutes'/u,
);
const batchExecutionCalldata = ethers.AbiCoder.defaultAbiCoder().encode(
  ["tuple(address target,uint256 value,bytes callData)[]"],
  [
    batchAction.calls.map((call) => ({
      target: call.to,
      value: BigInt(call.valueRaw),
      callData: call.data,
    })),
  ],
);
const batchUserOperation = {
  ...sponsoredUserOperation,
  callData: smartAccount.encodeFunctionData("execute", [
    `0x01${"00".repeat(31)}`,
    batchExecutionCalldata,
  ]),
};
const batchSponsoredTransaction = {
  ...sponsoredTransaction,
  data: entryPoint.encodeFunctionData("handleOps", [
    [batchUserOperation],
    sponsoredTransactionBeneficiary,
  ]),
};
assert.equal(
  evaluateEvmActionReceipt({
    action: batchAction,
    expectedSignerAddress: sponsoredSigner,
    transaction: batchSponsoredTransaction,
    receipt: sponsoredReceipt,
    previous: null,
    executionEnvelope: "privy_erc4337",
  }).status,
  "finalized",
);
assert.equal(
  evaluateEvmActionReceipt({
    action: {
      ...batchAction,
      calls: [...batchAction.calls].reverse(),
    },
    expectedSignerAddress: sponsoredSigner,
    transaction: batchSponsoredTransaction,
    receipt: sponsoredReceipt,
    previous: null,
    executionEnvelope: "privy_erc4337",
  }).status,
  "mismatch",
);
const bundledSponsoredTransaction = {
  ...sponsoredTransaction,
  data: entryPoint.encodeFunctionData("handleOps", [
    [
      {
        ...sponsoredUserOperation,
        sender: "0x5555555555555555555555555555555555555555",
        nonce: 1n,
      },
      sponsoredUserOperation,
    ],
    sponsoredTransactionBeneficiary,
  ]),
};
assert.equal(
  evaluateEvmActionReceipt({
    action: evmAction,
    expectedSignerAddress: sponsoredSigner,
    transaction: bundledSponsoredTransaction,
    receipt: sponsoredReceipt,
    previous: null,
    executionEnvelope: "privy_erc4337",
  }).status,
  "finalized",
);
const exclusiveBundleReceipt = evaluateEvmActionReceipt({
  action: evmAction,
  actionValidationResult: { requiresSingleOperationBundle: true },
  expectedSignerAddress: sponsoredSigner,
  transaction: bundledSponsoredTransaction,
  receipt: sponsoredReceipt,
  previous: null,
  executionEnvelope: "privy_erc4337",
});
assert.equal(exclusiveBundleReceipt.status, "mismatch");
assert.equal(
  exclusiveBundleReceipt.failureCode,
  "sponsored_operation_scope_ambiguous",
  "approval and cleanup ownership cannot be attributed across multiple UserOperations",
);
const ambiguousBundleCredit = evaluateEvmActionReceipt({
  action: evmAction,
  actionValidationResult: exactCreditValidation,
  expectedSignerAddress: sponsoredSigner,
  transaction: bundledSponsoredTransaction,
  receipt: sponsoredExactCreditReceipt,
  previous: null,
  executionEnvelope: "privy_erc4337",
});
assert.equal(ambiguousBundleCredit.status, "mismatch");
assert.equal(
  ambiguousBundleCredit.failureCode,
  "sponsored_exact_credit_scope_ambiguous",
  "transaction-wide transfer logs cannot prove exact credit for one UserOp in a bundle",
);
const ambiguousSponsoredTransaction = {
  ...sponsoredTransaction,
  data: entryPoint.encodeFunctionData("handleOps", [
    [
      sponsoredUserOperation,
      { ...sponsoredUserOperation, nonce: userOperationNonce + 1n },
    ],
    sponsoredTransactionBeneficiary,
  ]),
};
const ambiguousSponsoredEvidence = evaluateEvmActionReceipt({
  action: evmAction,
  expectedSignerAddress: sponsoredSigner,
  transaction: ambiguousSponsoredTransaction,
  receipt: sponsoredReceipt,
  previous: null,
  executionEnvelope: "privy_erc4337",
});
assert.equal(ambiguousSponsoredEvidence.status, "mismatch");
assert.equal(
  ambiguousSponsoredEvidence.failureCode,
  "sponsored_inner_action_ambiguous",
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
const failedSponsoredReceipt = {
  ...sponsoredReceipt,
  logs: [
    {
      address: entryPointAddress,
      data: failedSponsoredEvent.data,
      topics: failedSponsoredEvent.topics,
    },
  ],
};
assert.equal(
  evaluateEvmActionReceipt({
    action: evmAction,
    expectedSignerAddress: sponsoredSigner,
    transaction: sponsoredTransaction,
    receipt: failedSponsoredReceipt,
    previous: null,
    executionEnvelope: "privy_erc4337",
  }).status,
  "failed",
);
assert.equal(
  evaluateEvmActionReceipt({
    action: evmAction,
    expectedSignerAddress: sponsoredSigner,
    transaction: sponsoredTransaction,
    receipt: {
      ...failedSponsoredReceipt,
      confirmations: FAST_EVM_FUNDING_ACTION_FINALITY_CONFIRMATIONS - 1,
    },
    previous: null,
    executionEnvelope: "privy_erc4337",
  }).status,
  "confirmed",
);
assert.equal(
  evaluateEvmActionReceipt({
    action: evmAction,
    expectedSignerAddress: sponsoredSigner,
    transaction: sponsoredTransaction,
    receipt: {
      ...failedSponsoredReceipt,
      canonicalBlockHash: `0x${"cd".repeat(32)}`,
    },
    previous: null,
    executionEnvelope: "privy_erc4337",
  }).status,
  "reorged",
);
assert.equal(
  evaluateEvmActionReceipt({
    action: evmAction,
    expectedSignerAddress: sponsoredSigner,
    transaction: sponsoredTransaction,
    receipt: failedSponsoredReceipt,
    previous: {
      operationId: "operation",
      stepId: "step",
      attemptId: "attempt",
      networkId: "evm:8453",
      status: "finalized",
      actionMatch: true,
      ledgerHeight: "9",
      blockHash: `0x${"cd".repeat(32)}`,
      canonical: true,
      failureCode: null,
      evidence: {},
      firstSeenAt: new Date(0),
      observedAt: new Date(0),
      finalizedAt: new Date(0),
      reorgedAt: null,
    },
    executionEnvelope: "privy_erc4337",
  }).status,
  "reorged",
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
const uppercaseHandoffHash = `0x${"AB".repeat(32)}`;
assert.ok(
  polymarketDepositWalletHandoffExpectation(handoffAction, handoffValidation),
);
assert.equal(
  normalizePolymarketDepositWalletTransactionReference(
    handoffAction,
    handoffValidation,
    uppercaseHandoffHash,
  ),
  uppercaseHandoffHash.toLowerCase(),
  "a valid Polymarket handoff EVM hash must share the scanner's lowercase form",
);
assert.equal(
  normalizePolymarketDepositWalletTransactionReference(
    handoffAction,
    { ...handoffValidation, amountRaw: "1" },
    uppercaseHandoffHash,
  ),
  uppercaseHandoffHash,
  "an invalid handoff envelope must not change transaction reference semantics",
);
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
assert.equal(
  evaluatePolymarketDepositWalletHandoffReceipt({
    action: handoffAction,
    actionValidationResult: handoffValidation,
    transaction: handoffTransaction,
    receipt: {
      ...handoffReceipt,
      confirmations: FAST_EVM_FUNDING_ACTION_FINALITY_CONFIRMATIONS - 1,
    },
    previous: null,
  }).status,
  "confirmed",
);
const finalizedHandoffObservation: FundingStepReceiptObservation = {
  operationId: "00000000-0000-4000-8000-000000000101",
  stepId: "00000000-0000-4000-8000-000000000102",
  attemptId: "00000000-0000-4000-8000-000000000103",
  networkId: handoffAction.networkId,
  status: "finalized",
  actionMatch: true,
  ledgerHeight: handoffReceipt.blockNumber.toString(),
  blockHash: handoffReceipt.blockHash,
  canonical: true,
  failureCode: null,
  evidence: {},
  firstSeenAt: new Date("2026-07-31T10:00:00.000Z"),
  observedAt: new Date("2026-07-31T10:00:01.000Z"),
  finalizedAt: new Date("2026-07-31T10:00:01.000Z"),
  reorgedAt: null,
};
assert.deepEqual(
  evaluatePolymarketDepositWalletHandoffReceipt({
    action: handoffAction,
    actionValidationResult: handoffValidation,
    transaction: handoffTransaction,
    receipt: null,
    previous: finalizedHandoffObservation,
  }),
  {
    status: "reorged",
    actionMatch: true,
    ledgerHeight: handoffReceipt.blockNumber.toString(),
    blockHash: handoffReceipt.blockHash,
    canonical: false,
    failureCode: "finalized_receipt_disappeared",
    evidence: {
      transactionObserved: true,
      receiptObserved: false,
    },
  },
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

const correctedFinalizedReceipt: FundingStepReceiptEvidence = {
  status: "finalized",
  actionMatch: true,
  ledgerHeight: "10",
  blockHash: evmReceipt.blockHash,
  canonical: true,
  failureCode: null,
  evidence: {},
};
const secondReference = `0x${"34".repeat(32)}`;
const secondTarget: FundingStepReceiptTarget = {
  ...target,
  stepId: "00000000-0000-4000-8000-000000000005",
  segmentId: "00000000-0000-4000-8000-000000000006",
  attemptId: "00000000-0000-4000-8000-000000000007",
  receiptRefCiphertext: `encrypted:${secondReference}`,
  receiptRefLookupHmac: `fingerprint:${secondReference}`,
};
let concurrentInspections = 0;
let peakConcurrentInspections = 0;
let releaseInspections: (() => void) | null = null;
const inspectionsReleased = new Promise<void>((resolve) => {
  releaseInspections = resolve;
});
const parallelDriver = new FundingStepReceiptReconciliationDriver(
  {
    keyVersion: 1,
    encrypt: (value) => `encrypted:${value}`,
    decrypt: (value) => value.slice("encrypted:".length),
    fingerprint: (value) => `fingerprint:${value}`,
  },
  {
    listTargets: async () => [target, secondTarget],
    inspectEvm: async () => {
      concurrentInspections += 1;
      peakConcurrentInspections = Math.max(
        peakConcurrentInspections,
        concurrentInspections,
      );
      if (concurrentInspections === 2) releaseInspections?.();
      await inspectionsReleased;
      concurrentInspections -= 1;
      return correctedFinalizedReceipt;
    },
    applyEvidence: async (_pool, input) => ({
      operationId: input.operationId,
      stepId: input.stepId,
      attemptId: input.attemptId,
      networkId: input.networkId,
      ...input.receipt,
      firstSeenAt: input.now ?? new Date(),
      observedAt: input.now ?? new Date(),
      finalizedAt: input.now ?? new Date(),
      reorgedAt: null,
    }),
  },
);
await parallelDriver.pollOperation({} as never, target.operationId);
assert.equal(peakConcurrentInspections, 2);

const mixedAppliedStepIds: string[] = [];
const mixedDriver = new FundingStepReceiptReconciliationDriver(
  {
    keyVersion: 1,
    encrypt: (value) => `encrypted:${value}`,
    decrypt: (value) => value.slice("encrypted:".length),
    fingerprint: (value) => `fingerprint:${value}`,
  },
  {
    listTargets: async () => [target, secondTarget],
    inspectEvm: async (receiptTarget) => {
      if (receiptTarget.stepId === secondTarget.stepId) {
        throw new Error("simulated provider failure");
      }
      return correctedFinalizedReceipt;
    },
    applyEvidence: async (_pool, input) => {
      mixedAppliedStepIds.push(input.stepId);
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
await assert.rejects(
  mixedDriver.pollOperation({} as never, target.operationId),
  (error: unknown) =>
    error instanceof AggregateError &&
    error.errors.some(
      (nested) =>
        nested instanceof Error &&
        nested.message === "simulated provider failure",
    ),
);
assert.deepEqual(mixedAppliedStepIds, [target.stepId]);

assert.equal(
  shouldIgnoreFundingStepReceiptUpdate("mismatch", correctedFinalizedReceipt),
  false,
);
assert.equal(
  shouldIgnoreFundingStepReceiptUpdate("mismatch", {
    ...correctedFinalizedReceipt,
    actionMatch: false,
  }),
  true,
);
assert.equal(
  shouldIgnoreFundingStepReceiptUpdate("mismatch", {
    ...correctedFinalizedReceipt,
    canonical: false,
  }),
  true,
);
assert.equal(
  shouldIgnoreFundingStepReceiptUpdate("failed", correctedFinalizedReceipt),
  true,
);
assert.equal(
  fundingStepStateForReceipt("finalized", "succeeded", "venue_preparation"),
  "succeeded",
);
assert.equal(
  fundingStepStateForReceipt(
    "finalized",
    "recovery_required",
    "venue_preparation",
  ),
  "recovery_required",
);
assert.equal(
  fundingStepStateForReceipt("finalized", "submitted", "venue_preparation"),
  "submitted",
);
assert.equal(
  fundingStepStateForReceipt(
    "finalized",
    "reconcile_required",
    "venue_preparation",
  ),
  "submitted",
);
assert.equal(
  fundingStepStateForReceipt("finalized", "submitted", "transaction"),
  "succeeded",
);

console.log(
  "[funding-step-receipt-tests] exact EVM/Solana receipt matching, finality, failure, reorg, and persisted polling passed",
);
