import type { Pool } from "@hunch/infra";
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { ethers } from "ethers";

import {
  fetchEvmBlockHash,
  fetchEvmBlockNumber,
  fetchEvmTransactionByHash,
  fetchEvmTransactionReceipt,
} from "../../services/polygon-rpc.js";
import {
  fetchSolanaReceiptTransaction,
  fetchSolanaSignatureReceiptStatus,
} from "../../services/solana-rpc.js";

import type {
  EvmTransactionAction,
  EvmTransactionBatchAction,
  ExternalHandoffAction,
  JsonValue,
  SvmTransactionAction,
} from "../domain/types.js";
import {
  applyFundingStepReceiptEvidence,
  listFundingStepReceiptTargets,
  type FundingStepReceiptEvidence,
  type FundingStepReceiptObservation,
  type FundingStepReceiptTarget,
} from "../persistence/funding-step-receipt-repository.js";
import { fundingSidecarRuntimeConfig } from "../runtime/sidecar-runtime-config.js";
import { polymarketDepositWalletHandoffExpectation } from "./polymarket-deposit-wallet-handoff.js";
import type { FundingTransactionReferenceCodec } from "./transaction-reference-codec.js";

type JsonRecord = Readonly<Record<string, JsonValue>>;

export const EVM_FUNDING_ACTION_FINALITY_CONFIRMATIONS = 12;
export const FAST_EVM_FUNDING_ACTION_FINALITY_CONFIRMATIONS = 2;

const FAST_FINALITY_EVM_CHAIN_IDS = new Set([137n, 8453n]);

export function evmFundingActionFinalityConfirmations(chainId: bigint): number {
  return FAST_FINALITY_EVM_CHAIN_IDS.has(chainId)
    ? FAST_EVM_FUNDING_ACTION_FINALITY_CONFIRMATIONS
    : EVM_FUNDING_ACTION_FINALITY_CONFIRMATIONS;
}

export type EvmReceiptTransaction = Readonly<{
  chainId: bigint;
  from: string;
  to: string | null;
  data: string;
  value: bigint;
}>;

export type EvmReceiptRecord = Readonly<{
  succeeded: boolean;
  blockNumber: number;
  blockHash: string;
  confirmations: number;
  canonicalBlockHash: string | null;
  logs: readonly Readonly<{
    address: string;
    data: string;
    logIndex?: number;
    topics: readonly string[];
  }>[];
}>;

export type EvmExecutionEnvelope = "direct" | "privy_erc4337";

const ENTRY_POINT_V07_ADDRESS = "0x0000000071727de22e5e9d8baf0edac6f37da032";
const ERC7579_SINGLE_EXECUTION_MODE = `0x${"00".repeat(32)}`;
const ERC7579_BATCH_EXECUTION_MODE = `0x01${"00".repeat(31)}`;
const ENTRY_POINT_V07_INTERFACE = new ethers.Interface([
  "function handleOps((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature)[] ops,address beneficiary)",
  "event UserOperationEvent(bytes32 indexed userOpHash,address indexed sender,address indexed paymaster,uint256 nonce,bool success,uint256 actualGasCost,uint256 actualUserOpFeePerGas)",
]);
const ERC7579_EXECUTE_INTERFACE = new ethers.Interface([
  "function execute(bytes32 execMode,bytes executionCalldata)",
]);
const ERC20_TRANSFER_EVENT_INTERFACE = new ethers.Interface([
  "event Transfer(address indexed from,address indexed to,uint256 value)",
]);

type SponsoredActionMatch = Readonly<{
  actionMatches: boolean;
  singleOperationBundle?: boolean;
  userOperationSucceeded: boolean | null;
  failureCode: string | null;
}>;

function evaluateSponsoredErc4337Action(
  input: Readonly<{
    action: EvmTransactionAction | EvmTransactionBatchAction;
    expectedSignerAddress: string;
    transaction: EvmReceiptTransaction;
    receipt: EvmReceiptRecord | null;
  }>,
): SponsoredActionMatch {
  if (
    input.transaction.to?.toLowerCase() !== ENTRY_POINT_V07_ADDRESS ||
    input.transaction.value !== 0n
  ) {
    return {
      actionMatches: false,
      userOperationSucceeded: null,
      failureCode: "sponsored_entry_point_mismatch",
    };
  }

  let parsedEntryPoint: ethers.TransactionDescription | null = null;
  try {
    parsedEntryPoint = ENTRY_POINT_V07_INTERFACE.parseTransaction({
      data: input.transaction.data,
      value: input.transaction.value,
    });
  } catch {
    // Unknown wrappers fail closed below.
  }
  const operations = parsedEntryPoint?.args[0] as
    | readonly Readonly<{
        sender: string;
        nonce: bigint;
        initCode: string;
        callData: string;
      }>[]
    | undefined;
  if (
    parsedEntryPoint?.name !== "handleOps" ||
    !operations ||
    operations.length === 0
  ) {
    return {
      actionMatches: false,
      userOperationSucceeded: null,
      failureCode: "sponsored_user_operation_mismatch",
    };
  }

  const signerOperations = operations.filter(
    (operation) =>
      operation.sender.toLowerCase() ===
        input.expectedSignerAddress.toLowerCase() &&
      operation.initCode === "0x",
  );
  if (signerOperations.length === 0) {
    return {
      actionMatches: false,
      userOperationSucceeded: null,
      failureCode: "sponsored_user_operation_mismatch",
    };
  }

  const decodedOperations = signerOperations.flatMap((operation) => {
    let parsedExecute: ethers.TransactionDescription | null = null;
    try {
      parsedExecute = ERC7579_EXECUTE_INTERFACE.parseTransaction({
        data: operation.callData,
      });
    } catch {
      return [];
    }
    const executionMode = parsedExecute?.args[0] as string | undefined;
    const executionCalldata = parsedExecute?.args[1] as string | undefined;
    if (parsedExecute?.name !== "execute" || !executionCalldata) {
      return [];
    }

    try {
      if (executionMode?.toLowerCase() === ERC7579_BATCH_EXECUTION_MODE) {
        const [decodedCalls] = ethers.AbiCoder.defaultAbiCoder().decode(
          ["tuple(address target,uint256 value,bytes callData)[]"],
          executionCalldata,
        ) as unknown as [
          readonly Readonly<{
            target: string;
            value: bigint;
            callData: string;
          }>[],
        ];
        return [
          {
            operation,
            calls: decodedCalls.map((call) => ({
              target: ethers.getAddress(call.target),
              value: BigInt(call.value),
              data: call.callData,
            })),
          },
        ];
      }
      const body = executionCalldata.slice(2);
      if (
        executionMode?.toLowerCase() !== ERC7579_SINGLE_EXECUTION_MODE ||
        body.length < 104
      ) {
        return [];
      }
      return [
        {
          operation,
          calls: [
            {
              target: ethers.getAddress(`0x${body.slice(0, 40)}`),
              value: BigInt(`0x${body.slice(40, 104)}`),
              data: `0x${body.slice(104)}`,
            },
          ],
        },
      ];
    } catch {
      return [];
    }
  });
  if (decodedOperations.length === 0) {
    return {
      actionMatches: false,
      userOperationSucceeded: null,
      failureCode: "sponsored_execution_envelope_mismatch",
    };
  }

  const expectedCalls =
    input.action.kind === "evm_transaction_batch"
      ? input.action.calls
      : [input.action];
  const matchingOperations = decodedOperations.filter(
    (candidate) =>
      candidate.calls.length === expectedCalls.length &&
      candidate.calls.every((call, index) => {
        const expected = expectedCalls[index];
        return (
          expected !== undefined &&
          call.target.toLowerCase() === expected.to.toLowerCase() &&
          call.value === BigInt(expected.valueRaw) &&
          normalizedHex(call.data) === normalizedHex(expected.data)
        );
      }),
  );
  const [matchingOperation] = matchingOperations;
  if (matchingOperations.length !== 1 || !matchingOperation) {
    return {
      actionMatches: false,
      userOperationSucceeded: null,
      failureCode:
        matchingOperations.length > 1
          ? "sponsored_inner_action_ambiguous"
          : "sponsored_inner_action_mismatch",
    };
  }
  const operation = matchingOperation.operation;
  if (!input.receipt || !input.receipt.succeeded) {
    return {
      actionMatches: true,
      userOperationSucceeded: null,
      failureCode: null,
    };
  }

  const matchingEvents = input.receipt.logs.flatMap((log) => {
    if (log.address.toLowerCase() !== ENTRY_POINT_V07_ADDRESS) return [];
    try {
      const event = ENTRY_POINT_V07_INTERFACE.parseLog({
        topics: [...log.topics],
        data: log.data,
      });
      if (
        event?.name !== "UserOperationEvent" ||
        String(event.args.sender).toLowerCase() !==
          operation.sender.toLowerCase() ||
        BigInt(event.args.nonce) !== operation.nonce
      ) {
        return [];
      }
      return [Boolean(event.args.success)];
    } catch {
      return [];
    }
  });
  if (matchingEvents.length !== 1) {
    return {
      actionMatches: false,
      userOperationSucceeded: null,
      failureCode: "sponsored_user_operation_event_missing",
    };
  }
  const userOperationSucceeded = matchingEvents[0] ?? false;
  return {
    actionMatches: true,
    singleOperationBundle: operations.length === 1,
    userOperationSucceeded,
    failureCode: userOperationSucceeded
      ? null
      : "sponsored_user_operation_failed",
  };
}

function evidence(
  value: Record<string, JsonValue>,
): FundingStepReceiptEvidence["evidence"] {
  return value;
}

function normalizedHex(value: string): string {
  return value.toLowerCase();
}

function validExpectedSigner(
  validation: JsonRecord,
  network: "evm" | "svm",
): string | null {
  const signer = validation.signerAddress;
  if (typeof signer !== "string") return null;
  try {
    return network === "evm"
      ? ethers.getAddress(signer)
      : new PublicKey(signer).toBase58();
  } catch {
    return null;
  }
}

type ExactDestinationCreditResult =
  | Readonly<{ required: false }>
  | Readonly<{
      required: true;
      valid: boolean;
      attributedRaw: string | null;
      expectedRaw: string | null;
    }>;

function exactErc20DestinationCredit(
  validation: JsonRecord | undefined,
  receipt: EvmReceiptRecord,
): ExactDestinationCreditResult {
  if (
    validation?.postconditionEvidenceKind !==
    "exact_erc20_destination_credit_v1"
  ) {
    return { required: false };
  }
  const assetId = validation.expectedDestinationAssetId;
  const destination = validation.expectedDestinationAddress;
  const expectedRaw = validation.expectedDestinationRaw;
  if (
    typeof assetId !== "string" ||
    typeof destination !== "string" ||
    typeof expectedRaw !== "string" ||
    !/^(0|[1-9][0-9]*)$/u.test(expectedRaw)
  ) {
    return {
      required: true,
      valid: false,
      attributedRaw: null,
      expectedRaw: null,
    };
  }
  let tokenAddress: string;
  let destinationAddress: string;
  try {
    tokenAddress = ethers.getAddress(assetId);
    destinationAddress = ethers.getAddress(destination);
  } catch {
    return {
      required: true,
      valid: false,
      attributedRaw: null,
      expectedRaw,
    };
  }
  let attributed = 0n;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== tokenAddress.toLowerCase()) continue;
    try {
      const parsed = ERC20_TRANSFER_EVENT_INTERFACE.parseLog({
        topics: [...log.topics],
        data: log.data,
      });
      if (
        parsed?.name === "Transfer" &&
        ethers.getAddress(String(parsed.args.to)) === destinationAddress
      ) {
        attributed += BigInt(parsed.args.value);
      }
    } catch {
      // Non-Transfer logs from the same token do not carry destination credit.
    }
  }
  return {
    required: true,
    valid: attributed === BigInt(expectedRaw),
    attributedRaw: attributed.toString(),
    expectedRaw,
  };
}

function exactErc20SourceDebit(
  validation: JsonRecord | undefined,
  receipt: EvmReceiptRecord,
): ExactDestinationCreditResult & Readonly<{ eventIndex?: string | null }> {
  if (validation?.postconditionEvidenceKind !== "exact_erc20_source_debit_v1")
    return { required: false };
  const assetId = validation.expectedSourceAssetId;
  const source = validation.expectedSourceAddress;
  const recipient = validation.expectedSourceRecipient;
  const expectedRaw = validation.expectedSourceRaw;
  if (
    typeof assetId !== "string" ||
    typeof source !== "string" ||
    typeof recipient !== "string" ||
    typeof expectedRaw !== "string" ||
    !/^[1-9][0-9]*$/u.test(expectedRaw)
  )
    return {
      required: true,
      valid: false,
      attributedRaw: null,
      expectedRaw: null,
    };
  let token: string;
  let from: string;
  let to: string;
  try {
    token = ethers.getAddress(assetId);
    from = ethers.getAddress(source);
    to = ethers.getAddress(recipient);
  } catch {
    return { required: true, valid: false, attributedRaw: null, expectedRaw };
  }
  const matches = receipt.logs.flatMap((log) => {
    if (log.address.toLowerCase() !== token.toLowerCase()) return [];
    try {
      const parsed = ERC20_TRANSFER_EVENT_INTERFACE.parseLog({
        topics: [...log.topics],
        data: log.data,
      });
      return parsed?.name === "Transfer" &&
        ethers.getAddress(String(parsed.args.from)) === from &&
        ethers.getAddress(String(parsed.args.to)) === to &&
        Number.isSafeInteger(log.logIndex) &&
        Number(log.logIndex) >= 0
        ? [{ raw: BigInt(parsed.args.value), index: Number(log.logIndex) }]
        : [];
    } catch {
      return [];
    }
  });
  const attributed = matches.reduce((sum, match) => sum + match.raw, 0n);
  const onlyMatch = matches.length === 1 ? matches[0] : undefined;
  return {
    required: true,
    valid: matches.length === 1 && attributed === BigInt(expectedRaw),
    attributedRaw: attributed.toString(),
    expectedRaw,
    eventIndex: onlyMatch ? String(onlyMatch.index) : null,
  };
}

function isReorgWatchReceipt(
  receipt: FundingStepReceiptObservation | null,
): receipt is FundingStepReceiptObservation {
  return (
    receipt?.status === "finalized" ||
    (receipt?.status === "failed" &&
      receipt.canonical &&
      receipt.evidence.failureFinalized === true)
  );
}

export function evaluateEvmActionReceipt(
  input: Readonly<{
    action: EvmTransactionAction | EvmTransactionBatchAction;
    actionValidationResult?: JsonRecord;
    expectedSignerAddress: string;
    transaction: EvmReceiptTransaction | null;
    receipt: EvmReceiptRecord | null;
    previous: FundingStepReceiptObservation | null;
    executionEnvelope?: EvmExecutionEnvelope;
  }>,
): FundingStepReceiptEvidence {
  if (!input.transaction) {
    if (isReorgWatchReceipt(input.previous)) {
      return {
        status: "reorged",
        actionMatch: true,
        ledgerHeight: input.previous.ledgerHeight,
        blockHash: input.previous.blockHash,
        canonical: false,
        failureCode: "finalized_transaction_disappeared",
        evidence: evidence({ receiptObserved: false }),
      };
    }
    return {
      status: "pending",
      actionMatch: null,
      ledgerHeight: null,
      blockHash: null,
      canonical: true,
      failureCode: null,
      evidence: evidence({ transactionObserved: false }),
    };
  }

  const expectedChainId = BigInt(input.action.networkId.slice("evm:".length));
  const executionEnvelope = input.executionEnvelope ?? "direct";
  const sponsoredMatch =
    executionEnvelope === "privy_erc4337"
      ? evaluateSponsoredErc4337Action({
          action: input.action,
          expectedSignerAddress: input.expectedSignerAddress,
          transaction: input.transaction,
          receipt: input.receipt,
        })
      : null;
  const matches =
    input.transaction.chainId === expectedChainId &&
    (sponsoredMatch
      ? sponsoredMatch.actionMatches
      : input.action.kind === "evm_transaction" &&
        input.transaction.from.toLowerCase() ===
          input.expectedSignerAddress.toLowerCase() &&
        input.transaction.to?.toLowerCase() === input.action.to.toLowerCase() &&
        normalizedHex(input.transaction.data) ===
          normalizedHex(input.action.data) &&
        input.transaction.value === BigInt(input.action.valueRaw));
  if (!matches) {
    return {
      status: "mismatch",
      actionMatch: false,
      ledgerHeight: input.receipt?.blockNumber.toString() ?? null,
      blockHash: input.receipt?.blockHash ?? null,
      canonical: true,
      failureCode: sponsoredMatch?.failureCode ?? "transaction_action_mismatch",
      evidence: evidence({
        executionEnvelope,
        transactionObserved: true,
        receiptObserved: input.receipt != null,
      }),
    };
  }
  if (!input.receipt) {
    if (isReorgWatchReceipt(input.previous)) {
      return {
        status: "reorged",
        actionMatch: true,
        ledgerHeight: input.previous.ledgerHeight,
        blockHash: input.previous.blockHash,
        canonical: false,
        failureCode: "finalized_receipt_disappeared",
        evidence: evidence({
          transactionObserved: true,
          receiptObserved: false,
        }),
      };
    }
    return {
      status: "pending",
      actionMatch: true,
      ledgerHeight: null,
      blockHash: null,
      canonical: true,
      failureCode: null,
      evidence: evidence({ transactionObserved: true, receiptObserved: false }),
    };
  }
  if (
    input.receipt.canonicalBlockHash !== null &&
    input.receipt.canonicalBlockHash.toLowerCase() !==
      input.receipt.blockHash.toLowerCase()
  ) {
    return {
      status: "reorged",
      actionMatch: true,
      ledgerHeight: input.receipt.blockNumber.toString(),
      blockHash: input.receipt.blockHash,
      canonical: false,
      failureCode: "receipt_block_not_canonical",
      evidence: evidence({
        confirmations: input.receipt.confirmations,
        receiptObserved: true,
      }),
    };
  }
  if (
    isReorgWatchReceipt(input.previous) &&
    input.previous.blockHash !== null &&
    input.previous.blockHash.toLowerCase() !==
      input.receipt.blockHash.toLowerCase()
  ) {
    return {
      status: "reorged",
      actionMatch: true,
      ledgerHeight: input.receipt.blockNumber.toString(),
      blockHash: input.receipt.blockHash,
      canonical: false,
      failureCode: "finalized_receipt_block_changed",
      evidence: evidence({
        confirmations: input.receipt.confirmations,
        receiptObserved: true,
      }),
    };
  }
  // Canonicality must be established before either an outer transaction
  // revert or an inner ERC-4337 failure can become retry-authorizing evidence.
  if (sponsoredMatch?.userOperationSucceeded === false) {
    const confirmationPolicy = evmFundingActionFinalityConfirmations(
      input.transaction.chainId,
    );
    const failureFinalized = input.receipt.confirmations >= confirmationPolicy;
    return {
      status: failureFinalized ? "failed" : "confirmed",
      actionMatch: true,
      ledgerHeight: input.receipt.blockNumber.toString(),
      blockHash: input.receipt.blockHash,
      canonical: true,
      failureCode: sponsoredMatch.failureCode,
      evidence: evidence({
        confirmationPolicy,
        confirmations: input.receipt.confirmations,
        executionEnvelope,
        failureFinalized,
        receiptObserved: true,
      }),
    };
  }
  if (!input.receipt.succeeded) {
    const confirmationPolicy = evmFundingActionFinalityConfirmations(
      input.transaction.chainId,
    );
    const failureFinalized = input.receipt.confirmations >= confirmationPolicy;
    return {
      status: failureFinalized ? "failed" : "confirmed",
      actionMatch: true,
      ledgerHeight: input.receipt.blockNumber.toString(),
      blockHash: input.receipt.blockHash,
      canonical: true,
      failureCode: "transaction_reverted",
      evidence: evidence({
        confirmationPolicy,
        confirmations: input.receipt.confirmations,
        failureFinalized,
        receiptObserved: true,
      }),
    };
  }
  const exactDestinationCredit = exactErc20DestinationCredit(
    input.actionValidationResult,
    input.receipt,
  );
  const exactSourceDebit = exactErc20SourceDebit(
    input.actionValidationResult,
    input.receipt,
  );
  const requiresSingleOperationBundle =
    input.actionValidationResult?.requiresSingleOperationBundle === true;
  if (
    (requiresSingleOperationBundle ||
      exactDestinationCredit.required ||
      exactSourceDebit.required) &&
    executionEnvelope === "privy_erc4337" &&
    sponsoredMatch?.singleOperationBundle !== true
  ) {
    return {
      status: "mismatch",
      actionMatch: false,
      ledgerHeight: input.receipt.blockNumber.toString(),
      blockHash: input.receipt.blockHash,
      canonical: true,
      failureCode: requiresSingleOperationBundle
        ? "sponsored_operation_scope_ambiguous"
        : "sponsored_exact_credit_scope_ambiguous",
      evidence: evidence({
        receiptObserved: true,
        singleOperationBundle: false,
      }),
    };
  }
  if (exactDestinationCredit.required && !exactDestinationCredit.valid) {
    return {
      status: "mismatch",
      actionMatch: false,
      ledgerHeight: input.receipt.blockNumber.toString(),
      blockHash: input.receipt.blockHash,
      canonical: true,
      failureCode: "destination_credit_amount_mismatch",
      evidence: evidence({
        attributedDestinationRaw: exactDestinationCredit.attributedRaw,
        expectedDestinationRaw: exactDestinationCredit.expectedRaw,
        receiptObserved: true,
      }),
    };
  }
  if (exactSourceDebit.required && !exactSourceDebit.valid) {
    return {
      status: "mismatch",
      actionMatch: false,
      ledgerHeight: input.receipt.blockNumber.toString(),
      blockHash: input.receipt.blockHash,
      canonical: true,
      failureCode: "source_debit_amount_mismatch",
      evidence: evidence({
        attributedSourceRaw: exactSourceDebit.attributedRaw,
        expectedSourceRaw: exactSourceDebit.expectedRaw,
        receiptObserved: true,
      }),
    };
  }
  const confirmationPolicy = evmFundingActionFinalityConfirmations(
    input.transaction.chainId,
  );
  const finalized = input.receipt.confirmations >= confirmationPolicy;
  return {
    status: finalized ? "finalized" : "confirmed",
    actionMatch: true,
    ledgerHeight: input.receipt.blockNumber.toString(),
    blockHash: input.receipt.blockHash,
    canonical: true,
    failureCode: null,
    evidence: evidence({
      ...(exactDestinationCredit.required
        ? {
            attributedDestinationRaw:
              exactDestinationCredit.attributedRaw ?? "0",
          }
        : {}),
      ...(exactSourceDebit.required
        ? {
            attributedSourceRaw: exactSourceDebit.attributedRaw ?? "0",
            sourceDebitEventIndex: exactSourceDebit.eventIndex ?? "",
          }
        : {}),
      confirmationPolicy,
      confirmations: input.receipt.confirmations,
      receiptObserved: true,
      ...(requiresSingleOperationBundle ? { singleOperationBundle: true } : {}),
    }),
  };
}

export function evaluatePolymarketDepositWalletHandoffReceipt(
  input: Readonly<{
    action: ExternalHandoffAction;
    actionValidationResult: JsonRecord;
    transaction: EvmReceiptTransaction | null;
    receipt: EvmReceiptRecord | null;
    previous: FundingStepReceiptObservation | null;
  }>,
): FundingStepReceiptEvidence {
  const expectation = polymarketDepositWalletHandoffExpectation(
    input.action,
    input.actionValidationResult,
  );
  if (!expectation) {
    return {
      status: "mismatch",
      actionMatch: false,
      ledgerHeight: input.receipt?.blockNumber.toString() ?? null,
      blockHash: input.receipt?.blockHash ?? null,
      canonical: true,
      failureCode: "polymarket_handoff_action_invalid",
      evidence: evidence({ handoffEnvelopeValid: false }),
    };
  }
  if (!input.transaction) {
    if (isReorgWatchReceipt(input.previous)) {
      return {
        status: "reorged",
        actionMatch: true,
        ledgerHeight: input.previous.ledgerHeight,
        blockHash: input.previous.blockHash,
        canonical: false,
        failureCode: "finalized_transaction_disappeared",
        evidence: evidence({ transactionObserved: false }),
      };
    }
    return {
      status: "pending",
      actionMatch: null,
      ledgerHeight: null,
      blockHash: null,
      canonical: true,
      failureCode: null,
      evidence: evidence({ transactionObserved: false }),
    };
  }
  if (input.transaction.chainId !== 137n) {
    return {
      status: "mismatch",
      actionMatch: false,
      ledgerHeight: input.receipt?.blockNumber.toString() ?? null,
      blockHash: input.receipt?.blockHash ?? null,
      canonical: true,
      failureCode: "polymarket_handoff_network_mismatch",
      evidence: evidence({ transactionObserved: true }),
    };
  }
  if (!input.receipt) {
    if (isReorgWatchReceipt(input.previous)) {
      return {
        status: "reorged",
        actionMatch: true,
        ledgerHeight: input.previous.ledgerHeight,
        blockHash: input.previous.blockHash,
        canonical: false,
        failureCode: "finalized_receipt_disappeared",
        evidence: evidence({
          transactionObserved: true,
          receiptObserved: false,
        }),
      };
    }
    return {
      status: "pending",
      actionMatch: null,
      ledgerHeight: null,
      blockHash: null,
      canonical: true,
      failureCode: null,
      evidence: evidence({ transactionObserved: true, receiptObserved: false }),
    };
  }
  if (
    input.receipt.canonicalBlockHash !== null &&
    input.receipt.canonicalBlockHash.toLowerCase() !==
      input.receipt.blockHash.toLowerCase()
  ) {
    return {
      status: "reorged",
      actionMatch: null,
      ledgerHeight: input.receipt.blockNumber.toString(),
      blockHash: input.receipt.blockHash,
      canonical: false,
      failureCode: "receipt_block_not_canonical",
      evidence: evidence({ confirmations: input.receipt.confirmations }),
    };
  }
  if (!input.receipt.succeeded) {
    return {
      status: "failed",
      actionMatch: null,
      ledgerHeight: input.receipt.blockNumber.toString(),
      blockHash: input.receipt.blockHash,
      canonical: true,
      failureCode: "transaction_reverted",
      evidence: evidence({ confirmations: input.receipt.confirmations }),
    };
  }
  const outgoingTransfers = input.receipt.logs.flatMap((log) => {
    if (log.address.toLowerCase() !== expectation.tokenAddress.toLowerCase()) {
      return [];
    }
    try {
      const parsed = ERC20_TRANSFER_EVENT_INTERFACE.parseLog({
        topics: [...log.topics],
        data: log.data,
      });
      if (
        parsed?.name !== "Transfer" ||
        ethers.getAddress(String(parsed.args.from)) !==
          expectation.funderAddress
      ) {
        return [];
      }
      return [
        {
          recipient: ethers.getAddress(String(parsed.args.to)),
          amountRaw: BigInt(parsed.args.value),
        },
      ];
    } catch {
      return [];
    }
  });
  const exactTransfer =
    outgoingTransfers.length === 1 &&
    outgoingTransfers[0]?.recipient === expectation.recipientAddress &&
    outgoingTransfers[0]?.amountRaw === expectation.amountRaw;
  if (!exactTransfer) {
    return {
      status: "mismatch",
      actionMatch: false,
      ledgerHeight: input.receipt.blockNumber.toString(),
      blockHash: input.receipt.blockHash,
      canonical: true,
      failureCode: "polymarket_handoff_transfer_mismatch",
      evidence: evidence({
        confirmations: input.receipt.confirmations,
        outgoingTransferCount: outgoingTransfers.length,
      }),
    };
  }
  if (
    isReorgWatchReceipt(input.previous) &&
    input.previous.blockHash !== null &&
    input.previous.blockHash.toLowerCase() !==
      input.receipt.blockHash.toLowerCase()
  ) {
    return {
      status: "reorged",
      actionMatch: true,
      ledgerHeight: input.receipt.blockNumber.toString(),
      blockHash: input.receipt.blockHash,
      canonical: false,
      failureCode: "finalized_receipt_block_changed",
      evidence: evidence({ confirmations: input.receipt.confirmations }),
    };
  }
  const confirmationPolicy = evmFundingActionFinalityConfirmations(
    input.transaction.chainId,
  );
  const finalized = input.receipt.confirmations >= confirmationPolicy;
  return {
    status: finalized ? "finalized" : "confirmed",
    actionMatch: true,
    ledgerHeight: input.receipt.blockNumber.toString(),
    blockHash: input.receipt.blockHash,
    canonical: true,
    failureCode: null,
    evidence: evidence({
      confirmationPolicy,
      confirmations: input.receipt.confirmations,
      exactTransferObserved: true,
    }),
  };
}

export type SvmReceiptInstruction = Readonly<{
  programId: string;
  accounts: readonly string[];
  dataHex: string;
}>;

export type SvmReceiptRecord = Readonly<{
  confirmationStatus: "processed" | "confirmed" | "finalized";
  failed: boolean;
  slot: number;
  signers: readonly string[];
  instructions: readonly SvmReceiptInstruction[];
  addressLookupTables: readonly string[];
}>;

export function evaluateSvmActionReceipt(
  input: Readonly<{
    action: SvmTransactionAction;
    expectedSignerAddress: string;
    transaction: SvmReceiptRecord | null;
    previous: FundingStepReceiptObservation | null;
  }>,
): FundingStepReceiptEvidence {
  if (!input.transaction) {
    if (isReorgWatchReceipt(input.previous)) {
      return {
        status: "reorged",
        actionMatch: true,
        ledgerHeight: input.previous.ledgerHeight,
        blockHash: input.previous.blockHash,
        canonical: false,
        failureCode: "finalized_signature_disappeared",
        evidence: evidence({ transactionObserved: false }),
      };
    }
    return {
      status: "pending",
      actionMatch: null,
      ledgerHeight: null,
      blockHash: null,
      canonical: true,
      failureCode: null,
      evidence: evidence({ transactionObserved: false }),
    };
  }
  const instructionsMatch =
    input.transaction.instructions.length ===
      input.action.instructions.length &&
    input.transaction.instructions.every((actual, index) => {
      const expected = input.action.instructions[index];
      return (
        expected != null &&
        actual.programId === expected.programId &&
        actual.dataHex.toLowerCase() === expected.data.toLowerCase() &&
        actual.accounts.length === expected.accounts.length &&
        actual.accounts.every(
          (account, accountIndex) =>
            account === expected.accounts[accountIndex]?.address,
        )
      );
    });
  const lookupTablesMatch =
    input.transaction.addressLookupTables.length ===
      input.action.addressLookupTables.length &&
    input.transaction.addressLookupTables.every(
      (table, index) => table === input.action.addressLookupTables[index],
    );
  const matches =
    input.transaction.signers.includes(input.expectedSignerAddress) &&
    instructionsMatch &&
    lookupTablesMatch;
  if (!matches) {
    return {
      status: "mismatch",
      actionMatch: false,
      ledgerHeight: input.transaction.slot.toString(),
      blockHash: null,
      canonical: true,
      failureCode: "transaction_action_mismatch",
      evidence: evidence({
        confirmationStatus: input.transaction.confirmationStatus,
        transactionObserved: true,
      }),
    };
  }
  if (input.transaction.failed) {
    return {
      status: "failed",
      actionMatch: true,
      ledgerHeight: input.transaction.slot.toString(),
      blockHash: null,
      canonical: true,
      failureCode: "transaction_failed",
      evidence: evidence({
        confirmationStatus: input.transaction.confirmationStatus,
        transactionObserved: true,
      }),
    };
  }
  return {
    status:
      input.transaction.confirmationStatus === "finalized"
        ? "finalized"
        : input.transaction.confirmationStatus === "confirmed"
          ? "confirmed"
          : "pending",
    actionMatch: true,
    ledgerHeight: input.transaction.slot.toString(),
    blockHash: null,
    canonical: true,
    failureCode: null,
    evidence: evidence({
      confirmationStatus: input.transaction.confirmationStatus,
      transactionObserved: true,
    }),
  };
}

function evmRpcUrl(chainId: number): string | null {
  const override =
    fundingSidecarRuntimeConfig.evmRpcUrlsByChain[String(chainId)];
  if (override?.trim()) return override.trim();
  if (chainId === 137) return fundingSidecarRuntimeConfig.polygonRpcUrl;
  if (chainId === 8453) return fundingSidecarRuntimeConfig.baseRpcUrl;
  if (chainId === 1) return fundingSidecarRuntimeConfig.ethereumRpcUrl;
  if (chainId === 10) return fundingSidecarRuntimeConfig.optimismRpcUrl;
  if (chainId === 56) return fundingSidecarRuntimeConfig.bscRpcUrl;
  if (chainId === 42161) return fundingSidecarRuntimeConfig.arbitrumRpcUrl;
  if (chainId === 43114) return fundingSidecarRuntimeConfig.avalancheRpcUrl;
  if (chainId === 59144) return fundingSidecarRuntimeConfig.lineaRpcUrl;
  return null;
}

type EvmReceiptInspectionContext = Readonly<{
  latestBlockNumbersByChainId: Map<number, Promise<bigint>>;
  canonicalBlockHashesByChainAndHeight: Map<string, Promise<string | null>>;
}>;

function createEvmReceiptInspectionContext(): EvmReceiptInspectionContext {
  return {
    latestBlockNumbersByChainId: new Map(),
    canonicalBlockHashesByChainAndHeight: new Map(),
  };
}

function evmReceiptTimeoutMs(chainId: number): number {
  return chainId === 8453
    ? fundingSidecarRuntimeConfig.baseRpcTimeoutMs
    : fundingSidecarRuntimeConfig.polygonRpcTimeoutMs;
}

function latestEvmBlockNumber(
  context: EvmReceiptInspectionContext,
  chainId: number,
  rpcUrl: string,
): Promise<bigint> {
  const existing = context.latestBlockNumbersByChainId.get(chainId);
  if (existing) return existing;
  const pending = fetchEvmBlockNumber({
    rpcUrl,
    timeoutMs: evmReceiptTimeoutMs(chainId),
  });
  context.latestBlockNumbersByChainId.set(chainId, pending);
  return pending;
}

function canonicalEvmBlockHash(
  context: EvmReceiptInspectionContext,
  chainId: number,
  blockNumber: number,
  rpcUrl: string,
): Promise<string | null> {
  const key = `${chainId}:${blockNumber}`;
  const existing = context.canonicalBlockHashesByChainAndHeight.get(key);
  if (existing) return existing;
  const pending = fetchEvmBlockHash({
    rpcUrl,
    timeoutMs: evmReceiptTimeoutMs(chainId),
    blockNumber,
  });
  context.canonicalBlockHashesByChainAndHeight.set(key, pending);
  return pending;
}

async function inspectEvmTarget(
  target: FundingStepReceiptTarget,
  reference: string,
  context = createEvmReceiptInspectionContext(),
): Promise<FundingStepReceiptEvidence> {
  if (
    target.action.kind !== "evm_transaction" &&
    target.action.kind !== "evm_transaction_batch" &&
    target.action.kind !== "external_handoff"
  ) {
    throw new Error("EVM receipt inspector received a non-EVM action");
  }
  if (!/^0x[0-9a-fA-F]{64}$/u.test(reference)) {
    return {
      status: "mismatch",
      actionMatch: false,
      ledgerHeight: null,
      blockHash: null,
      canonical: true,
      failureCode: "invalid_transaction_hash",
      evidence: evidence({ referenceShapeValid: false }),
    };
  }
  const chainId = Number(target.action.networkId.slice("evm:".length));
  const rpcUrl = Number.isSafeInteger(chainId) ? evmRpcUrl(chainId) : null;
  const expectedSignerAddress =
    target.action.kind === "evm_transaction" ||
    target.action.kind === "evm_transaction_batch"
      ? validExpectedSigner(target.actionValidationResult, "evm")
      : null;
  if (
    !rpcUrl ||
    ((target.action.kind === "evm_transaction" ||
      target.action.kind === "evm_transaction_batch") &&
      !expectedSignerAddress)
  ) {
    throw new Error("committed EVM receipt inspection context is incomplete");
  }
  const timeoutMs = evmReceiptTimeoutMs(chainId);
  const [transaction, receipt] = await Promise.all([
    fetchEvmTransactionByHash({
      rpcUrl,
      timeoutMs,
      transactionHash: reference,
    }),
    fetchEvmTransactionReceipt({
      rpcUrl,
      timeoutMs,
      transactionHash: reference,
    }),
  ]);
  let receiptRecord: EvmReceiptRecord | null = null;
  if (receipt) {
    const [latestBlockNumber, canonicalBlock] = await Promise.all([
      latestEvmBlockNumber(context, chainId, rpcUrl),
      canonicalEvmBlockHash(context, chainId, receipt.blockNumber, rpcUrl),
    ]);
    const confirmationsRaw =
      latestBlockNumber - BigInt(receipt.blockNumber) + 1n;
    const confirmations = Number(
      confirmationsRaw > 0n
        ? confirmationsRaw > BigInt(Number.MAX_SAFE_INTEGER)
          ? BigInt(Number.MAX_SAFE_INTEGER)
          : confirmationsRaw
        : 0n,
    );
    receiptRecord = {
      succeeded: receipt.succeeded,
      blockNumber: receipt.blockNumber,
      blockHash: receipt.blockHash,
      confirmations,
      canonicalBlockHash: canonicalBlock,
      logs: receipt.logs.map((log) => ({
        address: log.address,
        data: log.data,
        logIndex: log.logIndex,
        topics: log.topics,
      })),
    };
  }
  const transactionRecord = transaction
    ? {
        chainId: transaction.chainId,
        from: transaction.from,
        to: transaction.to,
        data: transaction.data,
        value: transaction.value,
      }
    : null;
  if (target.action.kind === "external_handoff") {
    return evaluatePolymarketDepositWalletHandoffReceipt({
      action: target.action,
      actionValidationResult: target.actionValidationResult,
      transaction: transactionRecord,
      receipt: receiptRecord,
      previous: target.previousReceipt,
    });
  }
  if (!expectedSignerAddress) {
    throw new Error("committed EVM signer is unavailable");
  }
  const evaluated = evaluateEvmActionReceipt({
    action: target.action,
    actionValidationResult: target.actionValidationResult,
    expectedSignerAddress,
    transaction: transactionRecord,
    receipt: receiptRecord,
    previous: target.previousReceipt,
    executionEnvelope:
      target.payerRequirement === "privy_sponsor" ? "privy_erc4337" : "direct",
  });
  return {
    ...evaluated,
    evidence: {
      ...evaluated.evidence,
      transactionHash: reference.toLowerCase(),
    },
  };
}

function instructionDataHex(data: unknown): string | null {
  if (data instanceof Uint8Array) return Buffer.from(data).toString("hex");
  if (typeof data !== "string") return null;
  try {
    return Buffer.from(bs58.decode(data)).toString("hex");
  } catch {
    return null;
  }
}

async function inspectSvmTarget(
  target: FundingStepReceiptTarget,
  reference: string,
): Promise<FundingStepReceiptEvidence> {
  if (target.action.kind !== "svm_transaction") {
    throw new Error("SVM receipt inspector received a non-SVM action");
  }
  let decodedSignature: Uint8Array;
  try {
    decodedSignature = bs58.decode(reference);
  } catch {
    decodedSignature = new Uint8Array();
  }
  if (decodedSignature.length !== 64) {
    return {
      status: "mismatch",
      actionMatch: false,
      ledgerHeight: null,
      blockHash: null,
      canonical: true,
      failureCode: "invalid_transaction_signature",
      evidence: evidence({ referenceShapeValid: false }),
    };
  }
  const expectedSignerAddress = validExpectedSigner(
    target.actionValidationResult,
    "svm",
  );
  if (!expectedSignerAddress) {
    throw new Error(
      "committed Solana receipt inspection context is incomplete",
    );
  }
  const status = await fetchSolanaSignatureReceiptStatus({
    rpcUrls: [...fundingSidecarRuntimeConfig.solanaRpcUrls],
    signature: reference,
    timeoutMs: fundingSidecarRuntimeConfig.solanaRpcTimeoutMs,
  });
  if (!status) {
    return evaluateSvmActionReceipt({
      action: target.action,
      expectedSignerAddress,
      transaction: null,
      previous: target.previousReceipt,
    });
  }
  const commitment =
    status.confirmationStatus === "finalized" ? "finalized" : "confirmed";
  const transaction = await fetchSolanaReceiptTransaction({
    rpcUrls: [...fundingSidecarRuntimeConfig.solanaRpcUrls],
    signature: reference,
    timeoutMs: fundingSidecarRuntimeConfig.solanaRpcTimeoutMs,
    commitment,
  });
  if (!transaction) {
    return evaluateSvmActionReceipt({
      action: target.action,
      expectedSignerAddress,
      transaction: null,
      previous: target.previousReceipt,
    });
  }
  const keyAt = (index: number): string | undefined =>
    transaction.accountKeys[index];
  const instructions: SvmReceiptInstruction[] = [];
  for (const instruction of transaction.instructions) {
    const programId = keyAt(instruction.programIdIndex);
    const accounts = instruction.accountIndexes.map((index) => keyAt(index));
    const dataHex = instructionDataHex(instruction.data);
    if (
      !programId ||
      accounts.some((account) => !account) ||
      dataHex === null
    ) {
      return {
        status: "mismatch",
        actionMatch: false,
        ledgerHeight: transaction.slot.toString(),
        blockHash: null,
        canonical: true,
        failureCode: "transaction_instruction_decode_failed",
        evidence: evidence({ transactionObserved: true }),
      };
    }
    instructions.push({
      programId,
      accounts: accounts as string[],
      dataHex,
    });
  }
  const signers = transaction.accountKeys.slice(
    0,
    transaction.numRequiredSignatures,
  );
  return evaluateSvmActionReceipt({
    action: target.action,
    expectedSignerAddress,
    transaction: {
      confirmationStatus:
        status.confirmationStatus === "finalized"
          ? "finalized"
          : status.confirmationStatus === "confirmed"
            ? "confirmed"
            : "processed",
      failed: status.failed || transaction.failed,
      slot: transaction.slot,
      signers,
      instructions,
      addressLookupTables: transaction.addressLookupTables,
    },
    previous: target.previousReceipt,
  });
}

export type FundingStepReceiptInspector = (
  target: FundingStepReceiptTarget,
  reference: string,
) => Promise<FundingStepReceiptEvidence>;

export class FundingStepReceiptReconciliationDriver {
  constructor(
    readonly referenceCodec: FundingTransactionReferenceCodec,
    readonly dependencies: Readonly<{
      inspectEvm?: FundingStepReceiptInspector;
      inspectSvm?: FundingStepReceiptInspector;
      listTargets?: typeof listFundingStepReceiptTargets;
      applyEvidence?: typeof applyFundingStepReceiptEvidence;
    }> = {},
  ) {}

  async pollOperation(
    pool: Pool,
    operationId: string,
    now = new Date(),
  ): Promise<Readonly<{ receiptsPolled: number; receiptsFinalized: number }>> {
    const targets = await (
      this.dependencies.listTargets ?? listFundingStepReceiptTargets
    )(pool, operationId, now);
    const inspectionContext = createEvmReceiptInspectionContext();
    const inspectionResults: ReadonlyArray<
      PromiseSettledResult<
        Readonly<{
          target: FundingStepReceiptTarget;
          inspected: FundingStepReceiptEvidence;
        }>
      >
    > = await Promise.allSettled(
      targets.map(async (target) => {
        if (target.lookupKeyVersion !== this.referenceCodec.keyVersion) {
          throw new Error(
            "funding transaction reference key version is unavailable",
          );
        }
        const reference = this.referenceCodec.decrypt(
          target.receiptRefCiphertext,
        );
        if (
          this.referenceCodec.fingerprint(reference) !==
          target.receiptRefLookupHmac
        ) {
          throw new Error(
            "funding transaction reference integrity check failed",
          );
        }
        const inspected =
          target.action.kind === "evm_transaction" ||
          target.action.kind === "evm_transaction_batch" ||
          target.action.kind === "external_handoff"
            ? await (this.dependencies.inspectEvm
                ? this.dependencies.inspectEvm(target, reference)
                : inspectEvmTarget(target, reference, inspectionContext))
            : await (this.dependencies.inspectSvm ?? inspectSvmTarget)(
                target,
                reference,
              );
        return { target, inspected };
      }),
    );

    let receiptsFinalized = 0;
    const failures: unknown[] = [];
    for (const result of inspectionResults) {
      if (result.status === "rejected") {
        failures.push(result.reason);
        continue;
      }
      const { target, inspected } = result.value;
      try {
        await (
          this.dependencies.applyEvidence ?? applyFundingStepReceiptEvidence
        )(pool, {
          operationId: target.operationId,
          stepId: target.stepId,
          attemptId: target.attemptId,
          networkId: target.networkId,
          receipt: inspected,
          now,
        });
        if (inspected.status === "finalized") receiptsFinalized += 1;
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "one or more funding receipt inspections failed",
      );
    }
    return { receiptsPolled: targets.length, receiptsFinalized };
  }
}
