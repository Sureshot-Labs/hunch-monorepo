#!/usr/bin/env tsx

import assert from "node:assert/strict";
import bs58 from "bs58";
import { ethers } from "ethers";

import {
  bindPolymarketRelayerTransactionHash,
  EVM_FUNDING_ACTION_FINALITY_CONFIRMATIONS,
  EVM_FUNDING_FAILURE_FINALITY_CONFIRMATIONS,
  FAST_EVM_FUNDING_ACTION_FINALITY_CONFIRMATIONS,
  evmFundingActionFinalityConfirmations,
  evaluateEvmActionReceipt,
  evaluatePolymarketDepositWalletHandoffReceipt,
  evaluateSvmActionReceipt,
  findRecentPolymarketHandoffTransactionHash,
  findRecentPolymarketHandoffTransactionScan,
  FundingStepReceiptReconciliationDriver,
  inspectEvmTarget,
  inspectSvmTarget,
  reconcilePolymarketHandoffTerminalProviderEvidence,
  resolvePolymarketRelayerFundingReference,
} from "../../execution/step-receipt-reconciler.js";
import {
  normalizePolymarketDepositWalletTransactionReference,
  polymarketDepositWalletHandoffExpectation,
  polymarketRelayerTransactionReference,
} from "../../execution/polymarket-deposit-wallet-handoff.js";
import type {
  FundingStepReceiptEvidence,
  FundingStepReceiptObservation,
  FundingStepReceiptTarget,
} from "../../persistence/funding-step-receipt-repository.js";
import {
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
const evmReceiptWithoutCanonicalBlock = evaluateEvmActionReceipt({
  action: evmAction,
  expectedSignerAddress: evmTransaction.from,
  transaction: evmTransaction,
  receipt: { ...evmReceipt, canonicalBlockHash: null },
  previous: null,
});
assert.equal(evmReceiptWithoutCanonicalBlock.status, "pending");
assert.equal(evmReceiptWithoutCanonicalBlock.failureCode, null);
assert.equal(
  evmReceiptWithoutCanonicalBlock.evidence.canonicalBlockObserved,
  false,
);
assert.equal(
  evaluateEvmActionReceipt({
    action: evmAction,
    expectedSignerAddress: evmTransaction.from,
    transaction: evmTransaction,
    receipt: {
      ...evmReceipt,
      canonicalBlockHash: null,
      succeeded: false,
      confirmations: EVM_FUNDING_FAILURE_FINALITY_CONFIRMATIONS,
    },
    previous: null,
  }).status,
  "pending",
  "a receipt without a canonical block lookup cannot finalize success or authorize a retry",
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
      confirmations: EVM_FUNDING_FAILURE_FINALITY_CONFIRMATIONS - 1,
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
    confirmations: EVM_FUNDING_FAILURE_FINALITY_CONFIRMATIONS,
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
assert.throws(
  () =>
    evaluateEvmActionReceipt({
      action: evmAction,
      expectedSignerAddress: evmTransaction.from,
      transaction: evmTransaction,
      receipt: null,
      previous: finalizedFailureObservation,
    }),
  /EVM receipt lookup is unavailable during terminal receipt verification/u,
);
assert.throws(
  () =>
    evaluateEvmActionReceipt({
      action: evmAction,
      expectedSignerAddress: evmTransaction.from,
      transaction: null,
      receipt: null,
      previous: finalizedFailureObservation,
    }),
  /EVM transaction lookup is unavailable during terminal receipt verification/u,
);
assert.throws(
  () =>
    evaluateEvmActionReceipt({
      action: evmAction,
      expectedSignerAddress: evmTransaction.from,
      transaction: evmTransaction,
      receipt: { ...evmReceipt, canonicalBlockHash: null },
      previous: finalizedFailureObservation,
    }),
  /canonical EVM block is unavailable during terminal receipt verification/u,
  "an unavailable canonical block lookup must keep terminal reorg verification open",
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
let receiptTargetParameters: readonly unknown[] = [];
const [batchReceiptTarget] = await listFundingStepReceiptTargets(
  {
    query: async (query: unknown, parameters: readonly unknown[] = []) => {
      receiptTargetQuery = String(query);
      receiptTargetParameters = parameters;
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
);
assert.equal(batchReceiptTarget?.action.kind, "evm_transaction_batch");
assert.equal(batchReceiptTarget?.previousReceipt?.status, "confirmed");
assert.doesNotMatch(
  receiptTargetQuery,
  /operation\.status/u,
  "a materialized operation status must never hide a durable transaction reference",
);
assert.doesNotMatch(
  receiptTargetQuery,
  /step\.state\s*(?:=|in)/u,
  "a materialized step state must never decide receipt eligibility",
);
assert.match(
  receiptTargetQuery,
  /attempt\.broadcast_may_have_occurred/u,
  "receipt polling is selected exclusively from durable attempt facts",
);
assert.deepEqual(
  receiptTargetParameters,
  ["operation_batch_12345678"],
  "the cache-free query has no clock-dependent status-window parameter",
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
      confirmations: EVM_FUNDING_FAILURE_FINALITY_CONFIRMATIONS - 1,
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
assert.deepEqual(
  normalizePolymarketDepositWalletTransactionReference(
    handoffAction,
    handoffValidation,
    uppercaseHandoffHash,
  ),
  {
    kind: "transaction",
    reference: uppercaseHandoffHash.toLowerCase(),
  },
  "a valid Polymarket handoff EVM hash must share the scanner's lowercase form",
);
assert.deepEqual(
  normalizePolymarketDepositWalletTransactionReference(
    handoffAction,
    { ...handoffValidation, amountRaw: "1" },
    uppercaseHandoffHash,
  ),
  { kind: "transaction", reference: uppercaseHandoffHash },
  "an invalid handoff envelope must not change transaction reference semantics",
);
const relayerReference = polymarketRelayerTransactionReference(
  "relayer_tx_12345678",
);
assert.deepEqual(
  normalizePolymarketDepositWalletTransactionReference(
    handoffAction,
    handoffValidation,
    relayerReference,
  ),
  { kind: "external_handoff", reference: relayerReference },
);
assert.deepEqual(
  await resolvePolymarketRelayerFundingReference(
    relayerReference,
    async (_transactionId, signal) => {
      assert.equal(signal.aborted, false);
      return {
        transactionID: "relayer_tx_12345678",
        state: "STATE_EXECUTED",
      };
    },
  ),
  {
    kind: "evidence",
    evidence: {
      status: "pending",
      actionMatch: null,
      ledgerHeight: null,
      blockHash: null,
      canonical: true,
      failureCode: null,
      evidence: {
        providerReferenceMatches: true,
        relayerState: "STATE_EXECUTED",
      },
    },
  },
);
const resolvedRelayerHash = `0x${"cd".repeat(32)}`;
assert.deepEqual(
  await resolvePolymarketRelayerFundingReference(
    relayerReference,
    async () => ({
      transactionID: "relayer_tx_12345678",
      transactionHash: resolvedRelayerHash,
      state: "STATE_MINED",
    }),
  ),
  { kind: "transaction", reference: resolvedRelayerHash },
);
assert.deepEqual(
  await resolvePolymarketRelayerFundingReference(
    relayerReference,
    async () => ({
      transactionID: "relayer_tx_12345678",
      transactionHash: resolvedRelayerHash,
      state: "STATE_FAILED",
    }),
  ),
  { kind: "transaction", reference: resolvedRelayerHash },
  "an exact provider transaction hash must be inspected even when the provider also reports a terminal state",
);
const malformedTerminalHash = await resolvePolymarketRelayerFundingReference(
  relayerReference,
  async () => ({
    transactionID: "relayer_tx_12345678",
    transactionHash: "0x1234",
    state: "STATE_FAILED",
  }),
);
assert.equal(malformedTerminalHash.kind, "evidence");
assert.equal(
  malformedTerminalHash.kind === "evidence"
    ? malformedTerminalHash.evidence.status
    : null,
  "mismatch",
  "a malformed provider hash must fail closed instead of falling through to hashless retry authorization",
);
assert.equal(
  (
    await resolvePolymarketRelayerFundingReference(
      relayerReference,
      async () => ({
        transactionID: "relayer_tx_12345678",
        state: "STATE_FAILED",
      }),
    )
  ).kind,
  "evidence",
);
assert.equal(
  (
    await resolvePolymarketRelayerFundingReference(
      relayerReference,
      async () => ({
        transactionID: "different_tx_12345678",
        state: "STATE_MINED",
      }),
    )
  ).kind,
  "evidence",
);
const handoffAttemptStartedAt = new Date("2026-07-31T10:00:00.500Z");
const recentHandoffHash = `0x${"de".repeat(32)}`;
const exactHandoffTransfer = {
  transactionHash: recentHandoffHash,
  logIndex: 0,
  blockNumber: 1_000n,
  blockHash: `0x${"11".repeat(32)}`,
  fromAddress: handoffFunder,
  toAddress: handoffRecipient,
  rawAmount: handoffAmount,
};
const handoffScanInput = {
  action: handoffAction,
  actionValidationResult: handoffValidation,
  attemptStartedAt: handoffAttemptStartedAt,
  rpcUrl: "https://polygon-rpc.invalid",
  timeoutMs: 1_000,
};
assert.equal(
  await findRecentPolymarketHandoffTransactionHash(handoffScanInput, {
    fetchBlockNumber: async (input) => {
      assert.equal(input.bypassCache, true);
      return 1_000n;
    },
    fetchTransferLogs: async (input) => {
      assert.equal(input.fromBlock, 937n);
      assert.equal(input.toBlock, 1_000n);
      assert.equal(input.maxAttempts, 1);
      return [exactHandoffTransfer];
    },
    fetchBlockTimestamp: async (input) =>
      BigInt(
        Math.floor(handoffAttemptStartedAt.getTime() / 1_000) +
          (input.blockNumber === 1_000n ? 2 : -60),
      ),
  }),
  recentHandoffHash,
  "an exact transfer mined during this attempt is a usable RPC-discovered reference",
);
const timestampGapTransfer = {
  ...exactHandoffTransfer,
  blockNumber: 999n,
};
await assert.rejects(
  findRecentPolymarketHandoffTransactionScan(
    {
      ...handoffScanInput,
      rpcUrl: "https://polygon-timestamp-gap-rpc.invalid",
    },
    {
      fetchBlockNumber: async () => 1_000n,
      fetchTransferLogs: async () => [timestampGapTransfer],
      fetchBlockTimestamp: async (input) => {
        const startedAtSeconds = Math.floor(
          handoffAttemptStartedAt.getTime() / 1_000,
        );
        if (input.blockNumber === 1_000n) {
          return BigInt(startedAtSeconds + 100);
        }
        if (input.blockNumber === 999n) return null;
        return BigInt(startedAtSeconds - 60);
      },
    },
  ),
  /Polymarket handoff transfer block timestamp is unavailable/u,
  "an exact transfer with an unavailable timestamp must not be dropped from a completed scan",
);
const timestampRecoveredScan = await findRecentPolymarketHandoffTransactionScan(
  {
    ...handoffScanInput,
    rpcUrl: "https://polygon-timestamp-recovered-rpc.invalid",
  },
  {
    fetchBlockNumber: async () => 1_000n,
    fetchTransferLogs: async () => [timestampGapTransfer],
    fetchBlockTimestamp: async (input) => {
      const startedAtSeconds = Math.floor(
        handoffAttemptStartedAt.getTime() / 1_000,
      );
      if (input.blockNumber === 1_000n) {
        return BigInt(startedAtSeconds + 100);
      }
      if (input.blockNumber === 999n) {
        return BigInt(startedAtSeconds + 2);
      }
      return BigInt(startedAtSeconds - 60);
    },
  },
);
assert.equal(timestampRecoveredScan?.match?.transactionHash, recentHandoffHash);
assert.notEqual(
  reconcilePolymarketHandoffTerminalProviderEvidence({
    chainScan: timestampRecoveredScan,
    providerEvidence: {
      status: "failed",
      actionMatch: true,
      ledgerHeight: null,
      blockHash: null,
      canonical: true,
      failureCode: "polymarket_relayer_transaction_failed",
      evidence: { failureFinalized: true },
    },
  })?.status,
  "failed",
  "a recovered exact transfer must prevent provider failure from authorizing a duplicate broadcast",
);
assert.equal(
  await findRecentPolymarketHandoffTransactionHash(handoffScanInput, {
    fetchBlockNumber: async () => 1_000n,
    fetchTransferLogs: async () => [exactHandoffTransfer],
    fetchBlockTimestamp: async (input) =>
      BigInt(
        Math.floor(handoffAttemptStartedAt.getTime() / 1_000) +
          (input.blockNumber === 1_000n ? 100 : -60),
      ),
  }),
  null,
  "an old identical transfer must not be rebound to a new attempt",
);
assert.equal(
  await findRecentPolymarketHandoffTransactionHash(handoffScanInput, {
    fetchBlockNumber: async () => 1_000n,
    fetchTransferLogs: async () => [exactHandoffTransfer],
    fetchBlockTimestamp: async () =>
      BigInt(Math.floor(handoffAttemptStartedAt.getTime() / 1_000)),
  }),
  null,
  "a same-second block that can predate the attempt must fail closed",
);
assert.equal(
  await findRecentPolymarketHandoffTransactionHash(handoffScanInput, {
    fetchBlockNumber: async () => 1_000n,
    fetchTransferLogs: async () => [
      exactHandoffTransfer,
      {
        ...exactHandoffTransfer,
        transactionHash: `0x${"ef".repeat(32)}`,
        logIndex: 1,
      },
    ],
    fetchBlockTimestamp: async (input) =>
      BigInt(
        Math.floor(handoffAttemptStartedAt.getTime() / 1_000) +
          (input.blockNumber === 1_000n ? 2 : -60),
      ),
  }),
  null,
  "multiple exact recent transactions are ambiguous and must fail closed",
);
let adaptiveScanCalls = 0;
assert.equal(
  await findRecentPolymarketHandoffTransactionHash(handoffScanInput, {
    fetchBlockNumber: async () => 1_000n,
    fetchTransferLogs: async (input) => {
      adaptiveScanCalls += 1;
      if (adaptiveScanCalls === 1) {
        throw new Error("eth_getLogs supports up to a 10 block range");
      }
      assert.ok(input.toBlock - input.fromBlock < 10n);
      return input.toBlock === 1_000n ? [exactHandoffTransfer] : [];
    },
    fetchBlockTimestamp: async (input) =>
      BigInt(
        Math.floor(handoffAttemptStartedAt.getTime() / 1_000) +
          (input.blockNumber === 1_000n ? 2 : -60),
      ),
  }),
  recentHandoffHash,
  "provider block-range limits must not disable independent RPC recovery",
);
assert.equal(adaptiveScanCalls, 4);
const changingRangeRpcUrl = "https://polygon-changing-range-rpc.invalid";
let initialRangeLearningCalls = 0;
await findRecentPolymarketHandoffTransactionScan(
  { ...handoffScanInput, rpcUrl: changingRangeRpcUrl },
  {
    fetchBlockNumber: async () => 1_000n,
    fetchTransferLogs: async (input) => {
      initialRangeLearningCalls += 1;
      if (initialRangeLearningCalls === 1) {
        throw new Error("eth_getLogs supports up to a 10 block range");
      }
      assert.ok(input.toBlock - input.fromBlock < 10n);
      return [];
    },
    fetchBlockTimestamp: async (input) =>
      BigInt(
        Math.floor(handoffAttemptStartedAt.getTime() / 1_000) +
          (input.blockNumber === 1_000n ? 100 : -60),
      ),
  },
);
assert.equal(initialRangeLearningCalls, 4);
let reducedRangeCalls = 0;
assert.equal(
  (
    await findRecentPolymarketHandoffTransactionScan(
      { ...handoffScanInput, rpcUrl: changingRangeRpcUrl },
      {
        fetchBlockNumber: async () => 1_000n,
        fetchTransferLogs: async (input) => {
          reducedRangeCalls += 1;
          if (input.toBlock - input.fromBlock >= 3n) {
            throw new Error("eth_getLogs supports up to a 3 block range");
          }
          return input.toBlock === 1_000n ? [exactHandoffTransfer] : [];
        },
        fetchBlockTimestamp: async (input) =>
          BigInt(
            Math.floor(handoffAttemptStartedAt.getTime() / 1_000) +
              (input.blockNumber === 1_000n ? 2 : -60),
          ),
      },
    )
  )?.match?.transactionHash,
  recentHandoffHash,
  "a learned provider range cap must shrink when the provider lowers it",
);
assert.equal(
  reducedRangeCalls,
  6,
  "a lower learned cap gets one old-cap wave and one bounded retry wave",
);
let sameCapFailureCalls = 0;
await assert.rejects(
  findRecentPolymarketHandoffTransactionScan(
    { ...handoffScanInput, rpcUrl: changingRangeRpcUrl },
    {
      fetchBlockNumber: async () => 1_000n,
      fetchTransferLogs: async () => {
        sameCapFailureCalls += 1;
        throw new Error("eth_getLogs supports up to a 3 block range");
      },
      fetchBlockTimestamp: async (input) =>
        BigInt(
          Math.floor(handoffAttemptStartedAt.getTime() / 1_000) +
            (input.blockNumber === 1_000n ? 100 : -60),
        ),
    },
  ),
  /up to a 3 block range/u,
  "the same learned cap must not create a retry loop",
);
assert.equal(sameCapFailureCalls, 3);
let ordinaryRangeFailureCalls = 0;
await assert.rejects(
  findRecentPolymarketHandoffTransactionScan(
    { ...handoffScanInput, rpcUrl: changingRangeRpcUrl },
    {
      fetchBlockNumber: async () => 1_000n,
      fetchTransferLogs: async () => {
        ordinaryRangeFailureCalls += 1;
        throw new Error("simulated ordinary getLogs failure");
      },
      fetchBlockTimestamp: async (input) =>
        BigInt(
          Math.floor(handoffAttemptStartedAt.getTime() / 1_000) +
            (input.blockNumber === 1_000n ? 100 : -60),
        ),
    },
  ),
  /simulated ordinary getLogs failure/u,
  "ordinary RPC failures must propagate without a cap retry",
);
assert.equal(ordinaryRangeFailureCalls, 3);
let singleBlockRangeCalls = 0;
let movingTipReads = 0;
const singleBlockScanner = {
  fetchBlockHash: async () => `0x${"91".repeat(32)}`,
  fetchBlockNumber: async () => {
    const blockNumber = 1_000n + BigInt(movingTipReads * 4);
    movingTipReads += 1;
    return blockNumber;
  },
  fetchTransferLogs: async (input: { fromBlock: bigint; toBlock: bigint }) => {
    singleBlockRangeCalls += 1;
    if (singleBlockRangeCalls === 1) {
      throw new Error("eth_getLogs supports up to a 1 block range");
    }
    return input.fromBlock <= 990n && input.toBlock >= 990n
      ? [{ ...exactHandoffTransfer, blockNumber: 990n }]
      : [];
  },
  fetchBlockTimestamp: async (input: { blockNumber: bigint }) => {
    const startedAtSeconds = Math.floor(
      handoffAttemptStartedAt.getTime() / 1_000,
    );
    if (input.blockNumber === 1_000n) return BigInt(startedAtSeconds + 100);
    if (input.blockNumber === 990n) return BigInt(startedAtSeconds + 2);
    if (input.blockNumber <= 989n) return BigInt(startedAtSeconds - 10);
    return BigInt(startedAtSeconds + 10);
  },
};
let previousScanEvidence: Parameters<
  typeof findRecentPolymarketHandoffTransactionScan
>[0]["previousEvidence"] = null;
let cursorMatch: string | null = null;
for (let scanNumber = 0; scanNumber < 4; scanNumber += 1) {
  const scan = await findRecentPolymarketHandoffTransactionScan(
    {
      ...handoffScanInput,
      rpcUrl: "https://polygon-cursor-rpc.invalid",
      previousEvidence: previousScanEvidence,
    },
    singleBlockScanner,
  );
  assert.ok(scan);
  previousScanEvidence = {
    polymarketHandoffAttributionComplete: scan.attributionComplete,
    polymarketHandoffAttributionEndBlock:
      scan.attributionEndBlock?.toString() ?? null,
    polymarketHandoffAttributionEndBlockHash: scan.attributionEndBlockHash,
    polymarketHandoffAttributionFenceChanged: scan.attributionFenceChanged,
    polymarketHandoffAttributionWindowClosed: scan.attributionWindowClosed,
    polymarketHandoffCandidateTransactions: scan.candidateTransactions,
    polymarketHandoffScanCaughtUp: scan.caughtUp,
    polymarketHandoffScanHistoryCovered: scan.historyCovered,
    polymarketHandoffScanNewestBlock: scan.newestScannedBlock.toString(),
    polymarketHandoffScanOldestBlock: scan.oldestScannedBlock.toString(),
    polymarketHandoffScanSweepTargetBlock: scan.sweepTargetBlock.toString(),
  };
  cursorMatch = scan.match?.transactionHash ?? null;
}
assert.equal(
  cursorMatch,
  recentHandoffHash,
  "a one-block provider cap must finish a frozen sweep despite a faster-moving chain tip",
);
assert.equal(singleBlockRangeCalls, 13);
let movingZeroRangeCalls = 0;
let movingZeroTipReads = 0;
const movingZeroScanner = {
  fetchBlockHash: async () => `0x${"92".repeat(32)}`,
  fetchBlockNumber: async () => {
    const blockNumber = 1_000n + BigInt(movingZeroTipReads * 4);
    movingZeroTipReads += 1;
    return blockNumber;
  },
  fetchTransferLogs: async () => {
    movingZeroRangeCalls += 1;
    if (movingZeroRangeCalls === 1) {
      throw new Error("eth_getLogs supports up to a 1 block range");
    }
    return [];
  },
  fetchBlockTimestamp: async (input: { blockNumber: bigint }) => {
    const startedAtSeconds = Math.floor(
      handoffAttemptStartedAt.getTime() / 1_000,
    );
    if (input.blockNumber >= 1_000n) return BigInt(startedAtSeconds + 100);
    if (input.blockNumber <= 989n) return BigInt(startedAtSeconds - 10);
    return BigInt(startedAtSeconds + 10);
  },
};
let movingZeroEvidence: Parameters<
  typeof findRecentPolymarketHandoffTransactionScan
>[0]["previousEvidence"] = null;
let movingZeroFinalScan = null as Awaited<
  ReturnType<typeof findRecentPolymarketHandoffTransactionScan>
>;
for (let scanNumber = 0; scanNumber < 4; scanNumber += 1) {
  movingZeroFinalScan = await findRecentPolymarketHandoffTransactionScan(
    {
      ...handoffScanInput,
      rpcUrl: "https://polygon-moving-zero-rpc.invalid",
      previousEvidence: movingZeroEvidence,
    },
    movingZeroScanner,
  );
  assert.ok(movingZeroFinalScan);
  movingZeroEvidence = {
    polymarketHandoffAttributionComplete:
      movingZeroFinalScan.attributionComplete,
    polymarketHandoffAttributionEndBlock:
      movingZeroFinalScan.attributionEndBlock?.toString() ?? null,
    polymarketHandoffAttributionEndBlockHash:
      movingZeroFinalScan.attributionEndBlockHash,
    polymarketHandoffAttributionFenceChanged:
      movingZeroFinalScan.attributionFenceChanged,
    polymarketHandoffAttributionWindowClosed:
      movingZeroFinalScan.attributionWindowClosed,
    polymarketHandoffCandidateTransactions:
      movingZeroFinalScan.candidateTransactions,
    polymarketHandoffScanCaughtUp: movingZeroFinalScan.caughtUp,
    polymarketHandoffScanHistoryCovered: movingZeroFinalScan.historyCovered,
    polymarketHandoffScanNewestBlock:
      movingZeroFinalScan.newestScannedBlock.toString(),
    polymarketHandoffScanOldestBlock:
      movingZeroFinalScan.oldestScannedBlock.toString(),
    polymarketHandoffScanSweepTargetBlock:
      movingZeroFinalScan.sweepTargetBlock.toString(),
  };
}
assert.ok(movingZeroFinalScan);
assert.equal(movingZeroFinalScan.attributionEndBlock, 1_000n);
assert.equal(
  movingZeroFinalScan.attributionComplete,
  true,
  "a frozen attribution end must let a zero-candidate scan converge while the live chain advances faster than an RPC-capped sweep",
);
let multiChunkCalls = 0;
const olderDuplicateHash = `0x${"ef".repeat(32)}`;
const multiChunkScanner = {
  ...singleBlockScanner,
  fetchBlockNumber: async () => 1_000n,
  fetchTransferLogs: async (input: { fromBlock: bigint; toBlock: bigint }) => {
    multiChunkCalls += 1;
    if (multiChunkCalls === 1) {
      throw new Error("eth_getLogs supports up to a 1 block range");
    }
    const logs = [];
    if (input.fromBlock <= 999n && input.toBlock >= 999n) {
      logs.push({ ...exactHandoffTransfer, blockNumber: 999n });
    }
    if (input.fromBlock <= 990n && input.toBlock >= 990n) {
      logs.push({
        ...exactHandoffTransfer,
        blockNumber: 990n,
        transactionHash: olderDuplicateHash,
      });
    }
    return logs;
  },
};
let multiChunkEvidence: Parameters<
  typeof findRecentPolymarketHandoffTransactionScan
>[0]["previousEvidence"] = null;
let multiChunkFinalScan = null as Awaited<
  ReturnType<typeof findRecentPolymarketHandoffTransactionScan>
>;
for (let scanNumber = 0; scanNumber < 4; scanNumber += 1) {
  multiChunkFinalScan = await findRecentPolymarketHandoffTransactionScan(
    {
      ...handoffScanInput,
      rpcUrl: "https://polygon-multi-candidate-rpc.invalid",
      previousEvidence: multiChunkEvidence,
    },
    multiChunkScanner,
  );
  assert.ok(multiChunkFinalScan);
  multiChunkEvidence = {
    polymarketHandoffAttributionComplete:
      multiChunkFinalScan.attributionComplete,
    polymarketHandoffAttributionEndBlock:
      multiChunkFinalScan.attributionEndBlock?.toString() ?? null,
    polymarketHandoffAttributionEndBlockHash:
      multiChunkFinalScan.attributionEndBlockHash,
    polymarketHandoffAttributionFenceChanged:
      multiChunkFinalScan.attributionFenceChanged,
    polymarketHandoffAttributionWindowClosed:
      multiChunkFinalScan.attributionWindowClosed,
    polymarketHandoffCandidateTransactions:
      multiChunkFinalScan.candidateTransactions,
    polymarketHandoffScanCaughtUp: multiChunkFinalScan.caughtUp,
    polymarketHandoffScanHistoryCovered: multiChunkFinalScan.historyCovered,
    polymarketHandoffScanNewestBlock:
      multiChunkFinalScan.newestScannedBlock.toString(),
    polymarketHandoffScanOldestBlock:
      multiChunkFinalScan.oldestScannedBlock.toString(),
    polymarketHandoffScanSweepTargetBlock:
      multiChunkFinalScan.sweepTargetBlock.toString(),
  };
}
assert.ok(multiChunkFinalScan);
assert.equal(multiChunkFinalScan.caughtUp, true);
assert.equal(Object.keys(multiChunkFinalScan.candidateTransactions).length, 2);
assert.equal(
  multiChunkFinalScan.match,
  null,
  "candidate uniqueness must be decided only after the complete persisted scan, not per chunk",
);
const terminalProviderFailureEvidence: FundingStepReceiptEvidence = {
  status: "failed",
  actionMatch: true,
  ledgerHeight: null,
  blockHash: null,
  canonical: true,
  failureCode: "polymarket_relayer_transaction_failed",
  evidence: {
    failureFinalized: true,
    providerReferenceMatches: true,
    relayerState: "STATE_FAILED",
  },
};
const openWindowZeroCandidateScan =
  await findRecentPolymarketHandoffTransactionScan(
    {
      ...handoffScanInput,
      rpcUrl: "https://polygon-open-zero-scan-rpc.invalid",
    },
    {
      fetchBlockNumber: async () => 1_000n,
      fetchTransferLogs: async () => [],
      fetchBlockTimestamp: async (input) =>
        BigInt(
          Math.floor(handoffAttemptStartedAt.getTime() / 1_000) +
            (input.blockNumber === 1_000n ? 2 : -60),
        ),
    },
  );
assert.ok(openWindowZeroCandidateScan);
assert.equal(openWindowZeroCandidateScan.attributionComplete, false);
assert.equal(openWindowZeroCandidateScan.attributionEndBlock, null);
assert.equal(
  reconcilePolymarketHandoffTerminalProviderEvidence({
    chainScan: openWindowZeroCandidateScan,
    providerEvidence: terminalProviderFailureEvidence,
  })?.status,
  "pending",
  "provider failure cannot authorize a retry while a chain transfer may still land inside the attribution window",
);
const zeroCandidateScan = await findRecentPolymarketHandoffTransactionScan(
  { ...handoffScanInput, rpcUrl: "https://polygon-zero-scan-rpc.invalid" },
  {
    fetchBlockHash: async () => `0x${"93".repeat(32)}`,
    fetchBlockNumber: async () => 1_000n,
    fetchTransferLogs: async () => [],
    fetchBlockTimestamp: async (input) =>
      BigInt(
        Math.floor(handoffAttemptStartedAt.getTime() / 1_000) +
          (input.blockNumber === 1_000n ? 100 : -60),
      ),
  },
);
assert.ok(zeroCandidateScan);
assert.equal(zeroCandidateScan.caughtUp, true);
let reorgedFenceLogScans = 0;
const reorgedZeroCandidateFence =
  await findRecentPolymarketHandoffTransactionScan(
    {
      ...handoffScanInput,
      rpcUrl: "https://polygon-zero-scan-rpc.invalid",
      previousEvidence: {
        polymarketHandoffAttributionComplete:
          zeroCandidateScan.attributionComplete,
        polymarketHandoffAttributionEndBlock:
          zeroCandidateScan.attributionEndBlock?.toString() ?? null,
        polymarketHandoffAttributionEndBlockHash:
          zeroCandidateScan.attributionEndBlockHash,
        polymarketHandoffAttributionFenceChanged:
          zeroCandidateScan.attributionFenceChanged,
        polymarketHandoffAttributionWindowClosed:
          zeroCandidateScan.attributionWindowClosed,
        polymarketHandoffCandidateTransactions:
          zeroCandidateScan.candidateTransactions,
        polymarketHandoffScanCaughtUp: zeroCandidateScan.caughtUp,
        polymarketHandoffScanHistoryCovered: zeroCandidateScan.historyCovered,
        polymarketHandoffScanNewestBlock:
          zeroCandidateScan.newestScannedBlock.toString(),
        polymarketHandoffScanOldestBlock:
          zeroCandidateScan.oldestScannedBlock.toString(),
        polymarketHandoffScanSweepTargetBlock:
          zeroCandidateScan.sweepTargetBlock.toString(),
      },
    },
    {
      fetchBlockHash: async () => `0x${"94".repeat(32)}`,
      fetchBlockNumber: async () => 1_000n,
      fetchTransferLogs: async () => {
        reorgedFenceLogScans += 1;
        return [exactHandoffTransfer];
      },
      fetchBlockTimestamp: async (input) =>
        BigInt(
          Math.floor(handoffAttemptStartedAt.getTime() / 1_000) +
            (input.blockNumber === 1_000n ? 100 : -60),
        ),
    },
  );
assert.ok(reorgedZeroCandidateFence);
assert.equal(reorgedZeroCandidateFence.attributionFenceChanged, true);
assert.equal(reorgedZeroCandidateFence.attributionComplete, false);
assert.equal(reorgedFenceLogScans, 0);
const invalidatedAbsenceProof =
  reconcilePolymarketHandoffTerminalProviderEvidence({
    chainScan: reorgedZeroCandidateFence,
    providerEvidence: terminalProviderFailureEvidence,
  });
assert.equal(invalidatedAbsenceProof?.status, "reorged");
assert.equal(
  invalidatedAbsenceProof?.failureCode,
  "polymarket_handoff_attribution_fence_changed",
);
assert.equal(invalidatedAbsenceProof?.evidence.chainAbsenceProven, false);
assert.deepEqual(
  reconcilePolymarketHandoffTerminalProviderEvidence({
    chainScan: zeroCandidateScan,
    providerEvidence: terminalProviderFailureEvidence,
  }),
  {
    ...terminalProviderFailureEvidence,
    evidence: {
      ...terminalProviderFailureEvidence.evidence,
      polymarketHandoffAttributionComplete: true,
      polymarketHandoffAttributionEndBlock: "1000",
      polymarketHandoffAttributionEndBlockHash: `0x${"93".repeat(32)}`,
      polymarketHandoffAttributionFenceChanged: false,
      polymarketHandoffAttributionWindowClosed: true,
      polymarketHandoffCandidateTransactions: {},
      polymarketHandoffScanCaughtUp: true,
      polymarketHandoffScanHistoryCovered: true,
      polymarketHandoffScanLastFromBlock: "937",
      polymarketHandoffScanLastToBlock: "1000",
      polymarketHandoffScanNewestBlock: "1000",
      polymarketHandoffScanOldestBlock: "937",
      polymarketHandoffScanSweepTargetBlock: "1000",
      chainAbsenceProven: true,
    },
  },
  "provider failure may authorize retry only after an exact completed zero-candidate scan",
);
const incompleteFailureEvidence =
  reconcilePolymarketHandoffTerminalProviderEvidence({
    chainScan: {
      ...zeroCandidateScan,
      attributionComplete: false,
      caughtUp: false,
    },
    providerEvidence: terminalProviderFailureEvidence,
  });
assert.equal(incompleteFailureEvidence?.status, "pending");
assert.equal(
  incompleteFailureEvidence?.evidence.providerTerminalFailurePendingChainScan,
  true,
);
const conflictingFailureEvidence =
  reconcilePolymarketHandoffTerminalProviderEvidence({
    chainScan: multiChunkFinalScan,
    providerEvidence: terminalProviderFailureEvidence,
  });
assert.equal(conflictingFailureEvidence?.status, "mismatch");
assert.equal(
  conflictingFailureEvidence?.failureCode,
  "polymarket_handoff_provider_chain_conflict",
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
      logIndex: 3,
      topics: exactTransferLog.topics,
    },
  ],
};
assert.equal(
  evaluatePolymarketDepositWalletHandoffReceipt({
    action: handoffAction,
    actionValidationResult: handoffValidation,
    transaction: handoffTransaction,
    receipt: { ...handoffReceipt, canonicalBlockHash: null },
    previous: null,
  }).status,
  "pending",
);
assert.equal(
  evaluatePolymarketDepositWalletHandoffReceipt({
    action: handoffAction,
    actionValidationResult: handoffValidation,
    transaction: handoffTransaction,
    receipt: {
      ...handoffReceipt,
      canonicalBlockHash: null,
      succeeded: false,
      confirmations: EVM_FUNDING_FAILURE_FINALITY_CONFIRMATIONS,
    },
    previous: null,
  }).status,
  "pending",
  "a handoff receipt cannot finalize or authorize a retry without canonical block evidence",
);
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
const confirmedHandoffFailure = evaluatePolymarketDepositWalletHandoffReceipt({
  action: handoffAction,
  actionValidationResult: handoffValidation,
  transaction: handoffTransaction,
  receipt: {
    ...handoffReceipt,
    succeeded: false,
    confirmations: EVM_FUNDING_FAILURE_FINALITY_CONFIRMATIONS - 1,
  },
  previous: null,
});
assert.equal(confirmedHandoffFailure.status, "confirmed");
assert.equal(confirmedHandoffFailure.actionMatch, true);
assert.equal(confirmedHandoffFailure.evidence.failureFinalized, false);
const finalizedHandoffFailure = evaluatePolymarketDepositWalletHandoffReceipt({
  action: handoffAction,
  actionValidationResult: handoffValidation,
  transaction: handoffTransaction,
  receipt: {
    ...handoffReceipt,
    succeeded: false,
    confirmations: EVM_FUNDING_FAILURE_FINALITY_CONFIRMATIONS,
  },
  previous: null,
});
assert.equal(finalizedHandoffFailure.status, "failed");
assert.equal(finalizedHandoffFailure.actionMatch, true);
assert.equal(finalizedHandoffFailure.evidence.failureFinalized, true);
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
const hashlessFailedHandoffObservation: FundingStepReceiptObservation = {
  ...finalizedHandoffObservation,
  status: "failed",
  ledgerHeight: "1000",
  blockHash: `0x${"93".repeat(32)}`,
  failureCode: "polymarket_relayer_transaction_failed",
  evidence: {
    failureFinalized: true,
    chainAbsenceProven: true,
    polymarketHandoffAttributionComplete: true,
    polymarketHandoffAttributionEndBlock: "1000",
    polymarketHandoffAttributionEndBlockHash: `0x${"93".repeat(32)}`,
  },
};
const hashlessFailedHandoffTarget: FundingStepReceiptTarget = {
  operationId: hashlessFailedHandoffObservation.operationId,
  stepId: hashlessFailedHandoffObservation.stepId,
  segmentId: null,
  attemptId: hashlessFailedHandoffObservation.attemptId,
  attemptStartedAt: handoffAttemptStartedAt,
  stepKind: "external_handoff",
  payerRequirement: "user",
  networkId: handoffAction.networkId,
  action: handoffAction,
  actionValidationResult: handoffValidation,
  receiptRefCiphertext: "encrypted:hashless-handoff",
  receiptRefLookupHmac: "fingerprint:hashless-handoff",
  lookupKeyVersion: 1,
  previousReceipt: hashlessFailedHandoffObservation,
};
await assert.rejects(
  inspectEvmTarget(hashlessFailedHandoffTarget, relayerReference, undefined, {
    findTransactionScan: async () => {
      throw new Error("Polygon RPC unavailable");
    },
    resolveReference: async () => ({
      kind: "evidence" as const,
      evidence: terminalProviderFailureEvidence,
    }),
  }),
  /chain scan is unavailable during hashless failure verification/u,
  "a Polygon outage must not consume a hashless failed-receipt reorg watch while provider failure remains unchanged",
);
await assert.rejects(
  inspectEvmTarget(hashlessFailedHandoffTarget, relayerReference, undefined, {
    findTransactionScan: async () => zeroCandidateScan,
    resolveReference: async () => {
      throw new Error("Polymarket relayer unavailable");
    },
  }),
  /relayer lookup is unavailable during hashless failure verification/u,
  "a provider outage with an unchanged zero-transfer proof must retry without replacing the stored failure",
);
const multiCandidateDuringProviderOutage = await inspectEvmTarget(
  hashlessFailedHandoffTarget,
  relayerReference,
  undefined,
  {
    findTransactionScan: async () => multiChunkFinalScan,
    resolveReference: async () => {
      throw new Error("Polymarket relayer unavailable");
    },
  },
);
assert.deepEqual(
  {
    status: multiCandidateDuringProviderOutage.status,
    failureCode: multiCandidateDuringProviderOutage.failureCode,
    invalidatingReceiptStatus:
      multiCandidateDuringProviderOutage.evidence.invalidatingReceiptStatus,
    invalidatingReceiptFailureCode:
      multiCandidateDuringProviderOutage.evidence
        .invalidatingReceiptFailureCode,
    candidateCount: Object.keys(
      (multiCandidateDuringProviderOutage.evidence
        .polymarketHandoffCandidateTransactions ?? {}) as object,
    ).length,
  },
  {
    status: "reorged",
    failureCode: "polymarket_handoff_failure_evidence_invalidated",
    invalidatingReceiptStatus: "mismatch",
    invalidatingReceiptFailureCode:
      "polymarket_handoff_chain_candidate_ambiguity",
    candidateCount: 2,
  },
  "multiple exact chain candidates must revoke retry even while the provider is unavailable",
);
const invalidatedHashlessFailure = await inspectEvmTarget(
  hashlessFailedHandoffTarget,
  relayerReference,
  undefined,
  {
    findTransactionScan: async () => {
      throw new Error("Polygon RPC unavailable");
    },
    resolveReference: async () => ({
      kind: "evidence" as const,
      evidence: {
        status: "mismatch" as const,
        actionMatch: false,
        ledgerHeight: null,
        blockHash: null,
        canonical: true,
        failureCode: "polymarket_relayer_reference_mismatch",
        evidence: { providerReferenceMatches: false },
      },
    }),
  },
);
assert.deepEqual(
  {
    status: invalidatedHashlessFailure.status,
    canonical: invalidatedHashlessFailure.canonical,
    failureCode: invalidatedHashlessFailure.failureCode,
  },
  {
    status: "reorged",
    canonical: false,
    failureCode: "polymarket_handoff_failure_evidence_invalidated",
  },
  "a later provider identity conflict must revoke retry authorization from a stored hashless failure",
);
const conflictingProviderHash = `0x${"94".repeat(32)}`;
const chainProviderHashConflict = await inspectEvmTarget(
  hashlessFailedHandoffTarget,
  relayerReference,
  undefined,
  {
    findTransactionScan: async () => timestampRecoveredScan,
    resolveReference: async () => ({
      kind: "transaction" as const,
      reference: conflictingProviderHash,
    }),
  },
);
assert.deepEqual(
  {
    status: chainProviderHashConflict.status,
    failureCode: chainProviderHashConflict.failureCode,
    invalidatingReceiptStatus:
      chainProviderHashConflict.evidence.invalidatingReceiptStatus,
    chainTransactionHash:
      chainProviderHashConflict.evidence.chainTransactionHash,
    providerTransactionHash:
      chainProviderHashConflict.evidence.providerTransactionHash,
  },
  {
    status: "reorged",
    failureCode: "polymarket_handoff_failure_evidence_invalidated",
    invalidatingReceiptStatus: "mismatch",
    chainTransactionHash: recentHandoffHash,
    providerTransactionHash: conflictingProviderHash,
  },
  "conflicting exact chain/provider hashes must revoke a retry authorized by a hashless failure",
);
const providerFailureAfterChainCandidate = await inspectEvmTarget(
  hashlessFailedHandoffTarget,
  relayerReference,
  undefined,
  {
    findTransactionScan: async () => timestampRecoveredScan,
    resolveReference: async () => ({
      kind: "evidence" as const,
      evidence: terminalProviderFailureEvidence,
    }),
  },
);
assert.deepEqual(
  {
    status: providerFailureAfterChainCandidate.status,
    failureCode: providerFailureAfterChainCandidate.failureCode,
    invalidatingReceiptStatus:
      providerFailureAfterChainCandidate.evidence.invalidatingReceiptStatus,
    invalidatingReceiptFailureCode:
      providerFailureAfterChainCandidate.evidence
        .invalidatingReceiptFailureCode,
    unboundChainTransactionHash:
      providerFailureAfterChainCandidate.evidence.unboundChainTransactionHash,
  },
  {
    status: "reorged",
    failureCode: "polymarket_handoff_failure_evidence_invalidated",
    invalidatingReceiptStatus: "mismatch",
    invalidatingReceiptFailureCode:
      "polymarket_handoff_provider_chain_conflict",
    unboundChainTransactionHash: recentHandoffHash,
  },
  "a chain candidate appearing after provider failure must revoke the hashless retry authorization",
);
const replacementHandoffBlockHash = `0x${"bc".repeat(32)}`;
const reorgedIntoFailedHandoff = evaluatePolymarketDepositWalletHandoffReceipt({
  action: handoffAction,
  actionValidationResult: handoffValidation,
  transaction: handoffTransaction,
  receipt: {
    ...handoffReceipt,
    blockHash: replacementHandoffBlockHash,
    canonicalBlockHash: replacementHandoffBlockHash,
    succeeded: false,
    confirmations: EVM_FUNDING_FAILURE_FINALITY_CONFIRMATIONS,
  },
  previous: finalizedHandoffObservation,
});
assert.equal(reorgedIntoFailedHandoff.status, "reorged");
assert.equal(
  reorgedIntoFailedHandoff.failureCode,
  "finalized_receipt_block_changed",
  "a finalized handoff remapped into a reverted canonical block must invalidate the old success before failure handling",
);
assert.throws(
  () =>
    evaluatePolymarketDepositWalletHandoffReceipt({
      action: handoffAction,
      actionValidationResult: handoffValidation,
      transaction: handoffTransaction,
      receipt: { ...handoffReceipt, canonicalBlockHash: null },
      previous: finalizedHandoffObservation,
    }),
  /canonical Polymarket handoff block is unavailable during terminal receipt verification/u,
  "handoff reorg verification must remain open when the canonical block lookup is unavailable",
);
const boundHandoffReceipt = bindPolymarketRelayerTransactionHash({
  evaluated: evaluatePolymarketDepositWalletHandoffReceipt({
    action: handoffAction,
    actionValidationResult: handoffValidation,
    transaction: handoffTransaction,
    receipt: handoffReceipt,
    previous: null,
  }),
  previous: null,
  transactionHash: resolvedRelayerHash.toUpperCase().replace("0X", "0x"),
});
assert.equal(boundHandoffReceipt.evidence.transactionHash, resolvedRelayerHash);
const lateHashAfterProviderFailure = bindPolymarketRelayerTransactionHash({
  evaluated: {
    status: "pending",
    actionMatch: null,
    ledgerHeight: null,
    blockHash: null,
    canonical: true,
    failureCode: null,
    evidence: { transactionObserved: false },
  },
  previous: {
    ...finalizedHandoffObservation,
    status: "failed",
    failureCode: "polymarket_relayer_transaction_failed",
    evidence: {
      failureFinalized: true,
      providerReferenceMatches: true,
    },
  },
  transactionHash: resolvedRelayerHash,
  transactionHashSource: "provider",
});
assert.equal(lateHashAfterProviderFailure.status, "reorged");
assert.equal(lateHashAfterProviderFailure.actionMatch, true);
assert.equal(lateHashAfterProviderFailure.canonical, false);
assert.equal(
  lateHashAfterProviderFailure.failureCode,
  "polymarket_relayer_terminal_failure_invalidated",
  "a late exact provider hash must revoke retry authorization before its transaction can race a duplicate",
);
assert.equal(
  lateHashAfterProviderFailure.evidence.transactionHash,
  resolvedRelayerHash,
);
const mismatchedLateHashAfterProviderFailure =
  bindPolymarketRelayerTransactionHash({
    evaluated: evaluatePolymarketDepositWalletHandoffReceipt({
      action: handoffAction,
      actionValidationResult: handoffValidation,
      transaction: handoffTransaction,
      receipt: { ...handoffReceipt, logs: [] },
      previous: null,
    }),
    previous: {
      ...hashlessFailedHandoffObservation,
      failureCode: "polymarket_relayer_transaction_failed",
    },
    transactionHash: resolvedRelayerHash,
    transactionHashSource: "provider",
  });
assert.deepEqual(
  {
    status: mismatchedLateHashAfterProviderFailure.status,
    canonical: mismatchedLateHashAfterProviderFailure.canonical,
    failureCode: mismatchedLateHashAfterProviderFailure.failureCode,
    evaluatedStatus:
      mismatchedLateHashAfterProviderFailure.evidence.evaluatedStatus,
    evaluatedFailureCode:
      mismatchedLateHashAfterProviderFailure.evidence.evaluatedFailureCode,
  },
  {
    status: "reorged",
    canonical: false,
    failureCode: "polymarket_relayer_terminal_failure_invalidated",
    evaluatedStatus: "mismatch",
    evaluatedFailureCode: "polymarket_handoff_transfer_mismatch",
  },
  "a late exact provider hash with conflicting transfer evidence must revoke the earlier hashless retry authorization",
);
const remappedHandoffReceipt = bindPolymarketRelayerTransactionHash({
  evaluated: boundHandoffReceipt,
  previous: {
    ...finalizedHandoffObservation,
    evidence: { transactionHash: resolvedRelayerHash },
  },
  transactionHash: `0x${"ef".repeat(32)}`,
});
assert.equal(remappedHandoffReceipt.status, "reorged");
assert.equal(remappedHandoffReceipt.actionMatch, true);
assert.equal(
  remappedHandoffReceipt.failureCode,
  "polymarket_relayer_transaction_hash_changed",
);
const repeatedRemapReceipt = bindPolymarketRelayerTransactionHash({
  evaluated: boundHandoffReceipt,
  previous: {
    ...finalizedHandoffObservation,
    status: "mismatch",
    evidence: remappedHandoffReceipt.evidence,
  },
  transactionHash: `0x${"ef".repeat(32)}`,
});
assert.equal(repeatedRemapReceipt.status, "mismatch");
assert.equal(
  repeatedRemapReceipt.failureCode,
  "polymarket_relayer_transaction_hash_changed",
);
assert.throws(
  () =>
    evaluatePolymarketDepositWalletHandoffReceipt({
      action: handoffAction,
      actionValidationResult: handoffValidation,
      transaction: handoffTransaction,
      receipt: null,
      previous: finalizedHandoffObservation,
    }),
  /Polymarket handoff receipt lookup is unavailable during terminal receipt verification/u,
);
assert.throws(
  () =>
    evaluatePolymarketDepositWalletHandoffReceipt({
      action: handoffAction,
      actionValidationResult: handoffValidation,
      transaction: null,
      receipt: null,
      previous: finalizedHandoffObservation,
    }),
  /Polymarket handoff transaction lookup is unavailable during terminal receipt verification/u,
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
const computeBudgetInstruction = {
  programId: "ComputeBudget111111111111111111111111111111",
  accounts: [] as const,
  dataHex: "0200000000",
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
      instructions: [
        computeBudgetInstruction,
        ...svmTransaction.instructions,
        { ...computeBudgetInstruction, dataHex: "030000000000000000" },
      ],
    },
    previous: null,
  }).status,
  "finalized",
  "wallet-injected accountless ComputeBudget instructions must not obscure the exact committed Relay action",
);
assert.equal(
  evaluateSvmActionReceipt({
    action: svmAction,
    expectedSignerAddress: svmSigner,
    transaction: {
      ...svmTransaction,
      instructions: [
        ...svmTransaction.instructions,
        {
          programId: "11111111111111111111111111111111",
          accounts: [] as const,
          dataHex: "02",
        },
      ],
    },
    previous: null,
  }).status,
  "mismatch",
  "an extra non-ComputeBudget instruction remains a hard action mismatch",
);
assert.equal(
  evaluateSvmActionReceipt({
    action: svmAction,
    expectedSignerAddress: svmSigner,
    transaction: {
      ...svmTransaction,
      instructions: [
        ...svmTransaction.instructions,
        {
          ...computeBudgetInstruction,
          accounts: [svmAction.instructions[0].accounts[0].address],
        },
      ],
    },
    previous: null,
  }).status,
  "mismatch",
  "ComputeBudget instructions with accounts are not normalized away",
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
const confirmedSvmFailure = evaluateSvmActionReceipt({
  action: svmAction,
  expectedSignerAddress: svmSigner,
  transaction: {
    ...svmTransaction,
    confirmationStatus: "confirmed",
    failed: true,
  },
  previous: null,
});
assert.equal(confirmedSvmFailure.status, "confirmed");
assert.equal(confirmedSvmFailure.evidence.failureFinalized, false);
const finalizedSvmFailure = evaluateSvmActionReceipt({
  action: svmAction,
  expectedSignerAddress: svmSigner,
  transaction: { ...svmTransaction, failed: true },
  previous: null,
});
assert.equal(finalizedSvmFailure.status, "failed");
assert.equal(finalizedSvmFailure.evidence.failureFinalized, true);
const svmReference = bs58.encode(new Uint8Array(64).fill(7));
const finalizedSvmObservation: FundingStepReceiptObservation = {
  operationId: "00000000-0000-4000-8000-000000000121",
  stepId: "00000000-0000-4000-8000-000000000122",
  attemptId: "00000000-0000-4000-8000-000000000123",
  networkId: svmAction.networkId,
  status: "finalized",
  actionMatch: true,
  ledgerHeight: svmTransaction.slot.toString(),
  blockHash: null,
  canonical: true,
  failureCode: null,
  evidence: { transactionSignature: svmReference },
  firstSeenAt: new Date(0),
  observedAt: new Date(0),
  finalizedAt: new Date(0),
  reorgedAt: null,
};
assert.throws(
  () =>
    evaluateSvmActionReceipt({
      action: svmAction,
      expectedSignerAddress: svmSigner,
      transaction: null,
      previous: finalizedSvmObservation,
    }),
  /Solana receipt lookup is unavailable during terminal receipt verification/u,
);
const svmTarget: FundingStepReceiptTarget = {
  operationId: finalizedSvmObservation.operationId,
  stepId: finalizedSvmObservation.stepId,
  segmentId: "00000000-0000-4000-8000-000000000124",
  attemptId: finalizedSvmObservation.attemptId,
  attemptStartedAt: new Date("2026-07-24T09:59:59.000Z"),
  stepKind: "transaction",
  payerRequirement: "user",
  networkId: svmAction.networkId,
  action: svmAction,
  actionValidationResult: { signerAddress: svmSigner },
  receiptRefCiphertext: `encrypted:${svmReference}`,
  receiptRefLookupHmac: `fingerprint:${svmReference}`,
  lookupKeyVersion: 1,
  previousReceipt: finalizedSvmObservation,
};
let svmTransactionLookupCount = 0;
await assert.rejects(
  inspectSvmTarget(svmTarget, svmReference, {
    fetchSignatureStatus: async () => null,
    fetchTransaction: async () => {
      svmTransactionLookupCount += 1;
      return null;
    },
  }),
  /Solana receipt lookup is unavailable during terminal receipt verification/u,
  "a nullable signature-status read is not positive reorg evidence",
);
assert.equal(svmTransactionLookupCount, 0);
await assert.rejects(
  inspectSvmTarget(svmTarget, svmReference, {
    fetchSignatureStatus: async () => ({
      confirmationStatus: "finalized",
      failed: false,
    }),
    fetchTransaction: async () => {
      svmTransactionLookupCount += 1;
      return null;
    },
  }),
  /Solana receipt lookup is unavailable during terminal receipt verification/u,
  "a nullable transaction-detail read is not positive reorg evidence",
);
assert.equal(svmTransactionLookupCount, 1);

const reference = `0x${"12".repeat(32)}`;
const target: FundingStepReceiptTarget = {
  operationId: "00000000-0000-4000-8000-000000000001",
  stepId: "00000000-0000-4000-8000-000000000002",
  segmentId: "00000000-0000-4000-8000-000000000003",
  attemptId: "00000000-0000-4000-8000-000000000004",
  attemptStartedAt: new Date("2026-07-24T09:59:59.000Z"),
  stepKind: "transaction",
  payerRequirement: "user",
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
  shouldIgnoreFundingStepReceiptUpdate("failed", {
    status: "failed",
    actionMatch: true,
    ledgerHeight: "10",
    blockHash: evmReceipt.blockHash,
    canonical: true,
    failureCode: "transaction_reverted",
    evidence: { failureFinalized: true },
  }),
  true,
  "repeated finalized failure polling must be idempotent",
);
for (const terminalStatus of ["mismatch", "reorged"] as const) {
  assert.equal(
    shouldIgnoreFundingStepReceiptUpdate(terminalStatus, {
      status: terminalStatus,
      actionMatch: false,
      ledgerHeight: "10",
      blockHash: evmReceipt.blockHash,
      canonical: terminalStatus !== "reorged",
      failureCode: `test_${terminalStatus}`,
      evidence: {},
    }),
    true,
    `repeated ${terminalStatus} polling must be an idempotent read`,
  );
}
console.log(
  "[funding-step-receipt-tests] exact EVM/Solana receipt matching, finality, failure, reorg, and persisted polling passed",
);
