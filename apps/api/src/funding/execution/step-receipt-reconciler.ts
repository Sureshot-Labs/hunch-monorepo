import type { Pool } from "@hunch/infra";
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { ethers } from "ethers";

import {
  fetchEvmBlockHash,
  fetchEvmBlockNumber,
  fetchEvmBlockTimestamp,
  fetchErc20TransferLogs,
  fetchEvmTransactionByHash,
  fetchEvmTransactionReceipt,
  parseEvmGetLogsBlockRangeLimit,
} from "../../services/polygon-rpc.js";
import {
  fetchSolanaReceiptTransaction,
  fetchSolanaSignatureReceiptStatus,
} from "../../services/solana-rpc.js";
import {
  fetchPolymarketRelayerTransaction,
  POLYMARKET_RELAYER_FAILED_STATES,
} from "../../services/polymarket-deposit-wallet-relayer.js";

import type {
  EvmTransactionAction,
  EvmTransactionBatchAction,
  ExternalHandoffAction,
  JsonValue,
  SvmTransactionAction,
} from "../domain/types.js";
import { isPositiveRawAmount } from "../domain/raw-amount.js";
import {
  applyFundingStepReceiptEvidence,
  listFundingStepReceiptTargets,
  type FundingStepReceiptEvidence,
  type FundingStepReceiptObservation,
  type FundingStepReceiptTarget,
} from "../persistence/funding-step-receipt-repository.js";
import { fundingSidecarRuntimeConfig } from "../runtime/sidecar-runtime-config.js";
import {
  parsePolymarketRelayerTransactionReference,
  POLYMARKET_HANDOFF_CHAIN_ATTRIBUTION_WINDOW_MS,
  polymarketDepositWalletHandoffExpectation,
} from "./polymarket-deposit-wallet-handoff.js";
import type { FundingTransactionReferenceCodec } from "./transaction-reference-codec.js";

type JsonRecord = Readonly<Record<string, JsonValue>>;

export const EVM_FUNDING_ACTION_FINALITY_CONFIRMATIONS = 12;
export const EVM_FUNDING_FAILURE_FINALITY_CONFIRMATIONS = 12;
// Base and Polygon funding actions follow the same one-canonical-block
// threshold as the Mini App. Subsequent reconciliation keeps watching the
// block hash, so a later reorg still reopens the durable route rather than
// treating one confirmation as irreversible history.
export const FAST_EVM_FUNDING_ACTION_FINALITY_CONFIRMATIONS = 1;

const FAST_FINALITY_EVM_CHAIN_IDS = new Set([137n, 8453n]);
const POLYMARKET_RELAYER_LOOKUP_TIMEOUT_MS = 2_000;
const POLYMARKET_HANDOFF_DISCOVERY_TIMEOUT_MS = 2_000;
const POLYMARKET_HANDOFF_MAX_LOG_CHUNKS = 3n;
const POLYMARKET_HANDOFF_SCAN_BLOCK_COUNT = 64n;
const FUNDING_RECEIPT_RPC_PHASE_TIMEOUT_MS = 6_000;

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

function evmFundingFailureFinalityConfirmations(chainId: bigint): number {
  return Math.max(
    evmFundingActionFinalityConfirmations(chainId),
    EVM_FUNDING_FAILURE_FINALITY_CONFIRMATIONS,
  );
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
      transfers?: readonly Readonly<{
        fromAddress: string;
        eventIndex: string;
        rawAmount: string;
      }>[];
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
  const matchingTransfers: Array<{
    fromAddress: string;
    eventIndex: string;
    rawAmount: string;
  }> = [];
  let attributed = 0n;
  let matchingTransferCount = 0;
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
        const rawAmount = BigInt(parsed.args.value);
        attributed += rawAmount;
        matchingTransferCount += 1;
        if (Number.isSafeInteger(log.logIndex) && Number(log.logIndex) >= 0) {
          matchingTransfers.push({
            fromAddress: ethers.getAddress(String(parsed.args.from)),
            eventIndex: String(log.logIndex),
            rawAmount: rawAmount.toString(),
          });
        }
      }
    } catch {
      // Non-Transfer logs from the same token do not carry destination credit.
    }
  }
  const requiresEventIdentity =
    validation.requiresDestinationEventIdentity === true;
  return {
    required: true,
    valid:
      matchingTransferCount > 0 &&
      attributed === BigInt(expectedRaw) &&
      (!requiresEventIdentity ||
        matchingTransfers.length === matchingTransferCount),
    attributedRaw: attributed.toString(),
    expectedRaw,
    transfers: matchingTransfers,
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
    !isPositiveRawAmount(expectedRaw)
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
      throw new Error(
        "EVM transaction lookup is unavailable during terminal receipt verification",
      );
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
      throw new Error(
        "EVM receipt lookup is unavailable during terminal receipt verification",
      );
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
  if (input.receipt.canonicalBlockHash === null) {
    if (isReorgWatchReceipt(input.previous)) {
      throw new Error(
        "canonical EVM block is unavailable during terminal receipt verification",
      );
    }
    return {
      status: "pending",
      actionMatch: true,
      ledgerHeight: input.receipt.blockNumber.toString(),
      blockHash: input.receipt.blockHash,
      canonical: true,
      failureCode: null,
      evidence: evidence({
        canonicalBlockObserved: false,
        confirmations: input.receipt.confirmations,
        receiptObserved: true,
      }),
    };
  }
  if (
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
    const confirmationPolicy = evmFundingFailureFinalityConfirmations(
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
    const confirmationPolicy = evmFundingFailureFinalityConfirmations(
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
            destinationCreditTransfers: exactDestinationCredit.transfers ?? [],
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
      throw new Error(
        "Polymarket handoff transaction lookup is unavailable during terminal receipt verification",
      );
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
      throw new Error(
        "Polymarket handoff receipt lookup is unavailable during terminal receipt verification",
      );
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
  if (input.receipt.canonicalBlockHash === null) {
    if (isReorgWatchReceipt(input.previous)) {
      throw new Error(
        "canonical Polymarket handoff block is unavailable during terminal receipt verification",
      );
    }
    return {
      status: "pending",
      actionMatch: true,
      ledgerHeight: input.receipt.blockNumber.toString(),
      blockHash: input.receipt.blockHash,
      canonical: true,
      failureCode: null,
      evidence: evidence({
        canonicalBlockObserved: false,
        confirmations: input.receipt.confirmations,
        receiptObserved: true,
      }),
    };
  }
  if (
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
      evidence: evidence({ confirmations: input.receipt.confirmations }),
    };
  }
  if (
    isReorgWatchReceipt(input.previous) &&
    input.previous.blockHash !== null &&
    input.previous.blockHash.toLowerCase() !==
      input.receipt.blockHash.toLowerCase()
  ) {
    // Once a receipt was terminal, a new canonical inclusion in another block
    // invalidates that old conclusion regardless of whether the replacement
    // inclusion succeeds, reverts, or carries different logs. Record the reorg
    // first so an old finalized success can never be silently retained.
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
  if (!input.receipt.succeeded) {
    const confirmationPolicy = evmFundingFailureFinalityConfirmations(
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
      }),
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
          eventIndex:
            Number.isSafeInteger(log.logIndex) && Number(log.logIndex) >= 0
              ? String(log.logIndex)
              : null,
        },
      ];
    } catch {
      return [];
    }
  });
  const exactTransfer =
    outgoingTransfers.length === 1 &&
    outgoingTransfers[0]?.recipient === expectation.recipientAddress &&
    outgoingTransfers[0]?.amountRaw === expectation.amountRaw &&
    outgoingTransfers[0]?.eventIndex !== null;
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
      handoffEventIndex: outgoingTransfers[0]?.eventIndex ?? "",
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

const SVM_COMPUTE_BUDGET_PROGRAM_ID =
  "ComputeBudget111111111111111111111111111111";

function isWalletInjectedSvmComputeBudgetInstruction(
  instruction: SvmReceiptInstruction,
): boolean {
  // Wallets such as MetaMask may add ComputeBudget instructions while
  // signing/sending an otherwise immutable v0 transaction. They configure the
  // transaction's execution budget only: accepting precisely this program
  // with no accounts cannot add a token or SOL transfer. Every business
  // instruction still has to match the committed action byte-for-byte below.
  return (
    instruction.programId === SVM_COMPUTE_BUDGET_PROGRAM_ID &&
    instruction.accounts.length === 0
  );
}

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
      throw new Error(
        "Solana receipt lookup is unavailable during terminal receipt verification",
      );
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
  const businessInstructions = input.transaction.instructions.filter(
    (instruction) => !isWalletInjectedSvmComputeBudgetInstruction(instruction),
  );
  const instructionsMatch =
    businessInstructions.length === input.action.instructions.length &&
    businessInstructions.every((actual, index) => {
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
    const failureFinalized =
      input.transaction.confirmationStatus === "finalized";
    return {
      status: failureFinalized
        ? "failed"
        : input.transaction.confirmationStatus === "confirmed"
          ? "confirmed"
          : "pending",
      actionMatch: true,
      ledgerHeight: input.transaction.slot.toString(),
      blockHash: null,
      canonical: true,
      failureCode: "transaction_failed",
      evidence: evidence({
        confirmationStatus: input.transaction.confirmationStatus,
        failureFinalized,
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

function boundedReceiptRpcTimeoutMs(configuredTimeoutMs: number): number {
  return Math.max(
    1,
    Math.min(configuredTimeoutMs, FUNDING_RECEIPT_RPC_PHASE_TIMEOUT_MS),
  );
}

function latestEvmBlockNumber(
  context: EvmReceiptInspectionContext,
  chainId: number,
  rpcUrl: string,
  timeoutMs: number,
): Promise<bigint> {
  const existing = context.latestBlockNumbersByChainId.get(chainId);
  if (existing) return existing;
  const pending = fetchEvmBlockNumber({
    rpcUrl,
    timeoutMs,
    maxAttempts: 1,
  });
  context.latestBlockNumbersByChainId.set(chainId, pending);
  return pending;
}

function canonicalEvmBlockHash(
  context: EvmReceiptInspectionContext,
  chainId: number,
  blockNumber: number,
  rpcUrl: string,
  timeoutMs: number,
): Promise<string | null> {
  const key = `${chainId}:${blockNumber}`;
  const existing = context.canonicalBlockHashesByChainAndHeight.get(key);
  if (existing) return existing;
  const pending = fetchEvmBlockHash({
    rpcUrl,
    timeoutMs,
    maxAttempts: 1,
    blockNumber,
  });
  context.canonicalBlockHashesByChainAndHeight.set(key, pending);
  return pending;
}

export async function resolvePolymarketRelayerFundingReference(
  reference: string,
  fetchTransaction: (
    transactionId: string,
    signal: AbortSignal,
  ) => ReturnType<typeof fetchPolymarketRelayerTransaction> = (
    transactionId,
    signal,
  ) =>
    fetchPolymarketRelayerTransaction(transactionId, (url, init) =>
      fetch(url, { ...init, signal }),
    ),
): Promise<
  | Readonly<{ kind: "transaction"; reference: string }>
  | Readonly<{ evidence: FundingStepReceiptEvidence; kind: "evidence" }>
> {
  const relayerTransactionId =
    parsePolymarketRelayerTransactionReference(reference);
  if (!relayerTransactionId) {
    return { kind: "transaction", reference };
  }
  const relayerTransaction = await fetchTransaction(
    relayerTransactionId,
    AbortSignal.timeout(POLYMARKET_RELAYER_LOOKUP_TIMEOUT_MS),
  );
  const relayerState = relayerTransaction?.state?.trim() || null;
  if (
    relayerTransaction?.transactionID &&
    relayerTransaction.transactionID !== relayerTransactionId
  ) {
    return {
      kind: "evidence",
      evidence: {
        status: "mismatch",
        actionMatch: false,
        ledgerHeight: null,
        blockHash: null,
        canonical: true,
        failureCode: "polymarket_relayer_reference_mismatch",
        evidence: evidence({
          providerReferenceMatches: false,
          relayerState,
        }),
      },
    };
  }
  const transactionHash = relayerTransaction?.transactionHash?.trim();
  if (transactionHash) {
    if (!/^0x[0-9a-fA-F]{64}$/u.test(transactionHash)) {
      return {
        kind: "evidence",
        evidence: {
          status: "mismatch",
          actionMatch: false,
          ledgerHeight: null,
          blockHash: null,
          canonical: true,
          failureCode: "polymarket_relayer_transaction_hash_invalid",
          evidence: evidence({
            providerReferenceMatches: true,
            relayerState,
            transactionHashValid: false,
          }),
        },
      };
    }
    // A provider terminal label does not erase the exact chain transaction it
    // reports. Inspect the hash and its canonical receipt before deciding
    // whether a retry is safe.
    return { kind: "transaction", reference: transactionHash };
  }
  if (POLYMARKET_RELAYER_FAILED_STATES.has(relayerState ?? "")) {
    return {
      kind: "evidence",
      evidence: {
        status: "failed",
        actionMatch: true,
        ledgerHeight: null,
        blockHash: null,
        canonical: true,
        failureCode: "polymarket_relayer_transaction_failed",
        evidence: evidence({
          failureFinalized: true,
          providerReferenceMatches: true,
          relayerState,
        }),
      },
    };
  }
  return {
    kind: "evidence",
    evidence: {
      status: "pending",
      actionMatch: null,
      ledgerHeight: null,
      blockHash: null,
      canonical: true,
      failureCode: null,
      evidence: evidence({
        providerReferenceMatches: true,
        relayerState,
      }),
    },
  };
}

export function bindPolymarketRelayerTransactionHash(input: {
  evaluated: FundingStepReceiptEvidence;
  previous: FundingStepReceiptObservation | null;
  transactionHash: string;
  transactionHashSource?: "chain_scan" | "persisted" | "provider" | "reported";
  chainTransactionBlockTimestampMs?: number | null;
}): FundingStepReceiptEvidence {
  const transactionHash = input.transactionHash.toLowerCase();
  const previousHashRaw =
    input.previous?.evidence.previousTransactionHash ??
    input.previous?.evidence.transactionHash;
  const previousHash =
    typeof previousHashRaw === "string" ? previousHashRaw.toLowerCase() : null;
  if (previousHash && previousHash !== transactionHash) {
    const finalized = isReorgWatchReceipt(input.previous);
    return {
      status: finalized ? "reorged" : "mismatch",
      // Reorg preserves the fact that the previously finalized action matched;
      // the changed provider hash is conflicting evidence, not proof that the
      // already-observed action belonged to someone else.
      actionMatch: finalized ? true : false,
      ledgerHeight: input.previous?.ledgerHeight ?? null,
      blockHash: input.previous?.blockHash ?? null,
      canonical: !finalized,
      failureCode: "polymarket_relayer_transaction_hash_changed",
      evidence: evidence({
        previousTransactionHash: previousHash,
        transactionHash,
      }),
    };
  }
  if (
    input.previous?.status === "failed" &&
    input.previous.canonical &&
    input.previous.evidence.failureFinalized === true &&
    input.previous.failureCode === "polymarket_relayer_transaction_failed" &&
    input.evaluated.status !== "failed" &&
    input.evaluated.status !== "reorged"
  ) {
    // A provider-supplied exact hash invalidates an earlier terminal provider
    // failure even before its receipt is final. Reopen recovery immediately so
    // no retry can race an already-submitted transaction.
    return {
      status: "reorged",
      actionMatch: true,
      ledgerHeight: input.evaluated.ledgerHeight ?? input.previous.ledgerHeight,
      blockHash: input.evaluated.blockHash ?? input.previous.blockHash,
      canonical: false,
      failureCode: "polymarket_relayer_terminal_failure_invalidated",
      evidence: {
        ...input.evaluated.evidence,
        evaluatedStatus: input.evaluated.status,
        evaluatedActionMatch: input.evaluated.actionMatch,
        evaluatedFailureCode: input.evaluated.failureCode,
        previousFailureCode: input.previous.failureCode,
        transactionHash,
        ...(input.transactionHashSource
          ? { transactionHashSource: input.transactionHashSource }
          : {}),
        ...(input.chainTransactionBlockTimestampMs != null
          ? {
              chainTransactionBlockTimestampMs:
                input.chainTransactionBlockTimestampMs,
            }
          : {}),
      },
    };
  }
  return {
    ...input.evaluated,
    evidence: {
      ...input.evaluated.evidence,
      transactionHash,
      ...(input.transactionHashSource
        ? { transactionHashSource: input.transactionHashSource }
        : {}),
      ...(input.chainTransactionBlockTimestampMs != null
        ? {
            chainTransactionBlockTimestampMs:
              input.chainTransactionBlockTimestampMs,
          }
        : {}),
    },
  };
}

type PolymarketHandoffRpcScanner = Readonly<{
  fetchBlockHash?: typeof fetchEvmBlockHash;
  fetchBlockNumber: typeof fetchEvmBlockNumber;
  fetchBlockTimestamp: typeof fetchEvmBlockTimestamp;
  fetchTransferLogs: typeof fetchErc20TransferLogs;
}>;

const defaultPolymarketHandoffRpcScanner: PolymarketHandoffRpcScanner = {
  fetchBlockHash: fetchEvmBlockHash,
  fetchBlockNumber: fetchEvmBlockNumber,
  fetchBlockTimestamp: fetchEvmBlockTimestamp,
  fetchTransferLogs: fetchErc20TransferLogs,
};
const polymarketHandoffBlockRangeByRpcUrl = new Map<string, bigint>();

async function fetchPolymarketHandoffTransferLogs(
  scanner: PolymarketHandoffRpcScanner,
  input: Parameters<typeof fetchErc20TransferLogs>[0] &
    Readonly<{ direction: "backward" | "forward" }>,
): Promise<
  Readonly<{
    logs: Awaited<ReturnType<typeof fetchErc20TransferLogs>>;
    scannedFromBlock: bigint;
    scannedToBlock: bigint;
  }>
> {
  const { direction, ...rpcInput } = input;
  const deadlineMs = Date.now() + Math.max(1, rpcInput.timeoutMs);
  const remainingTimeoutMs = () => Math.max(1, deadlineMs - Date.now());
  const fetchChunked = async (providerRangeLimit: bigint) => {
    const boundedRangeLimit = providerRangeLimit > 0n ? providerRangeLimit : 1n;
    const maximumCoveredBlocks =
      boundedRangeLimit * POLYMARKET_HANDOFF_MAX_LOG_CHUNKS;
    const requestedBlockCount = rpcInput.toBlock - rpcInput.fromBlock + 1n;
    const boundedFromBlock =
      direction === "backward" && requestedBlockCount > maximumCoveredBlocks
        ? rpcInput.toBlock - maximumCoveredBlocks + 1n
        : rpcInput.fromBlock;
    const boundedToBlock =
      direction === "forward" && requestedBlockCount > maximumCoveredBlocks
        ? rpcInput.fromBlock + maximumCoveredBlocks - 1n
        : rpcInput.toBlock;
    const chunks: Parameters<typeof fetchErc20TransferLogs>[0][] = [];
    for (
      let fromBlock = boundedFromBlock;
      fromBlock <= boundedToBlock;
      fromBlock += boundedRangeLimit
    ) {
      const candidateToBlock = fromBlock + boundedRangeLimit - 1n;
      chunks.push({
        ...rpcInput,
        fromBlock,
        maxAttempts: 1,
        timeoutMs: remainingTimeoutMs(),
        toBlock:
          candidateToBlock < boundedToBlock ? candidateToBlock : boundedToBlock,
      });
    }
    return {
      logs: (
        await Promise.all(
          chunks.map((chunk) => scanner.fetchTransferLogs(chunk)),
        )
      ).flat(),
      scannedFromBlock: boundedFromBlock,
      scannedToBlock: boundedToBlock,
    };
  };
  const learnedRangeLimit = polymarketHandoffBlockRangeByRpcUrl.get(
    rpcInput.rpcUrl,
  );
  if (learnedRangeLimit) {
    try {
      return await fetchChunked(learnedRangeLimit);
    } catch (error) {
      const reducedRangeLimit = parseEvmGetLogsBlockRangeLimit(error);
      if (
        reducedRangeLimit === null ||
        reducedRangeLimit >= learnedRangeLimit
      ) {
        throw error;
      }
      // Provider caps can change at runtime. Relearn only a strictly smaller
      // cap and retry the read once; same/larger caps and ordinary failures are
      // propagated so this path cannot become an unbounded retry loop.
      polymarketHandoffBlockRangeByRpcUrl.set(
        rpcInput.rpcUrl,
        reducedRangeLimit,
      );
      return fetchChunked(reducedRangeLimit);
    }
  }
  try {
    return {
      logs: await scanner.fetchTransferLogs({
        ...rpcInput,
        maxAttempts: 1,
        timeoutMs: remainingTimeoutMs(),
      }),
      scannedFromBlock: rpcInput.fromBlock,
      scannedToBlock: rpcInput.toBlock,
    };
  } catch (error) {
    const providerRangeLimit = parseEvmGetLogsBlockRangeLimit(error);
    if (providerRangeLimit === null) throw error;
    polymarketHandoffBlockRangeByRpcUrl.set(
      rpcInput.rpcUrl,
      providerRangeLimit,
    );
    return fetchChunked(providerRangeLimit);
  }
}

type PolymarketHandoffTransactionMatch = Readonly<{
  blockTimestampMs: number;
  transactionHash: string;
}>;

type PolymarketHandoffTransactionScan = Readonly<{
  attributionComplete: boolean;
  attributionEndBlock: bigint | null;
  attributionEndBlockHash: string | null;
  attributionFenceChanged: boolean;
  attributionWindowClosed: boolean;
  candidateTransactions: Readonly<Record<string, number>>;
  caughtUp: boolean;
  historyCovered: boolean;
  lastScannedFromBlock: bigint | null;
  lastScannedToBlock: bigint | null;
  match: PolymarketHandoffTransactionMatch | null;
  newestScannedBlock: bigint;
  oldestScannedBlock: bigint;
  sweepTargetBlock: bigint;
}>;

function persistedBlockCursor(value: JsonValue | undefined): bigint | null {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    return null;
  }
  return BigInt(value);
}

function persistedEvmBlockHash(value: JsonValue | undefined): string | null {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/u.test(value)
    ? value.toLowerCase()
    : null;
}

function persistedHandoffCandidates(
  value: JsonValue | undefined,
): Map<string, number> {
  const candidates = new Map<string, number>();
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return candidates;
  }
  for (const [transactionHash, blockTimestampMs] of Object.entries(value)) {
    if (
      /^0x[0-9a-fA-F]{64}$/u.test(transactionHash) &&
      typeof blockTimestampMs === "number" &&
      Number.isSafeInteger(blockTimestampMs)
    ) {
      candidates.set(transactionHash.toLowerCase(), blockTimestampMs);
    }
  }
  return candidates;
}

function handoffScanStateEvidence(
  scan: PolymarketHandoffTransactionScan,
): JsonRecord {
  return {
    polymarketHandoffAttributionComplete: scan.attributionComplete,
    polymarketHandoffAttributionEndBlock:
      scan.attributionEndBlock?.toString() ?? null,
    polymarketHandoffAttributionEndBlockHash: scan.attributionEndBlockHash,
    polymarketHandoffAttributionFenceChanged: scan.attributionFenceChanged,
    polymarketHandoffAttributionWindowClosed: scan.attributionWindowClosed,
    polymarketHandoffCandidateTransactions: scan.candidateTransactions,
    polymarketHandoffScanCaughtUp: scan.caughtUp,
    polymarketHandoffScanHistoryCovered: scan.historyCovered,
    polymarketHandoffScanLastFromBlock:
      scan.lastScannedFromBlock?.toString() ?? null,
    polymarketHandoffScanLastToBlock:
      scan.lastScannedToBlock?.toString() ?? null,
    polymarketHandoffScanNewestBlock: scan.newestScannedBlock.toString(),
    polymarketHandoffScanOldestBlock: scan.oldestScannedBlock.toString(),
    polymarketHandoffScanSweepTargetBlock: scan.sweepTargetBlock.toString(),
  };
}

export function reconcilePolymarketHandoffTerminalProviderEvidence(input: {
  chainScan: PolymarketHandoffTransactionScan | null;
  providerEvidence: FundingStepReceiptEvidence;
}): FundingStepReceiptEvidence | null {
  const chainScanEvidence: JsonRecord = input.chainScan
    ? handoffScanStateEvidence(input.chainScan)
    : {};
  const chainTransactionHash = input.chainScan?.match?.transactionHash ?? null;
  if (input.chainScan?.attributionFenceChanged) {
    return {
      status: "reorged",
      actionMatch: true,
      ledgerHeight: input.chainScan.attributionEndBlock?.toString() ?? null,
      blockHash: input.chainScan.attributionEndBlockHash,
      canonical: false,
      failureCode: "polymarket_handoff_attribution_fence_changed",
      evidence: {
        ...input.providerEvidence.evidence,
        ...chainScanEvidence,
        chainAbsenceProven: false,
      },
    };
  }
  if (input.providerEvidence.status === "mismatch") {
    return {
      ...input.providerEvidence,
      evidence: {
        ...input.providerEvidence.evidence,
        ...chainScanEvidence,
        ...(chainTransactionHash
          ? { unboundChainTransactionHash: chainTransactionHash }
          : {}),
      },
    };
  }
  if (input.providerEvidence.status !== "failed") return null;
  const chainCandidateCount = input.chainScan
    ? Object.keys(input.chainScan.candidateTransactions).length
    : 0;
  if (input.chainScan?.attributionComplete && chainCandidateCount === 0) {
    // A terminal provider state is retry-authorizing only after the RPC scan
    // has covered attempt start through its frozen canonical tip and proved
    // that no matching Transfer exists.
    return {
      ...input.providerEvidence,
      evidence: {
        ...input.providerEvidence.evidence,
        ...chainScanEvidence,
        chainAbsenceProven: true,
      },
    };
  }
  if (input.chainScan?.caughtUp && chainCandidateCount > 0) {
    return {
      status: "mismatch",
      actionMatch: false,
      ledgerHeight: null,
      blockHash: null,
      canonical: true,
      failureCode: "polymarket_handoff_provider_chain_conflict",
      evidence: {
        ...input.providerEvidence.evidence,
        ...chainScanEvidence,
        chainAbsenceProven: false,
        ...(chainTransactionHash
          ? { unboundChainTransactionHash: chainTransactionHash }
          : {}),
      },
    };
  }
  return {
    status: "pending",
    actionMatch: null,
    ledgerHeight: null,
    blockHash: null,
    canonical: true,
    failureCode: null,
    evidence: {
      ...input.providerEvidence.evidence,
      ...chainScanEvidence,
      chainAbsenceProven: false,
      providerTerminalFailurePendingChainScan: true,
    },
  };
}

export async function findRecentPolymarketHandoffTransactionScan(
  input: Readonly<{
    action: ExternalHandoffAction;
    actionValidationResult: JsonRecord;
    attemptStartedAt: Date;
    previousEvidence?: JsonRecord | null;
    rpcUrl: string;
    timeoutMs: number;
  }>,
  scanner: PolymarketHandoffRpcScanner = defaultPolymarketHandoffRpcScanner,
): Promise<PolymarketHandoffTransactionScan | null> {
  const expectation = polymarketDepositWalletHandoffExpectation(
    input.action,
    input.actionValidationResult,
  );
  if (!expectation) return null;
  const discoveryDeadlineMs =
    Date.now() +
    Math.min(input.timeoutMs, POLYMARKET_HANDOFF_DISCOVERY_TIMEOUT_MS);
  const remainingDiscoveryTimeoutMs = () =>
    Math.max(1, discoveryDeadlineMs - Date.now());

  const latestBlock = await scanner.fetchBlockNumber({
    rpcUrl: input.rpcUrl,
    timeoutMs: remainingDiscoveryTimeoutMs(),
    maxAttempts: 1,
    bypassCache: true,
  });
  const timestampsByBlock = new Map<bigint, Promise<bigint | null>>();
  const timestampForBlock = (blockNumber: bigint) => {
    const existing = timestampsByBlock.get(blockNumber);
    if (existing) return existing;
    const pending = scanner.fetchBlockTimestamp({
      rpcUrl: input.rpcUrl,
      timeoutMs: remainingDiscoveryTimeoutMs(),
      maxAttempts: 1,
      blockNumber,
    });
    timestampsByBlock.set(blockNumber, pending);
    return pending;
  };
  // EVM block timestamps have second precision. Round the attempt boundary
  // forward so a same-amount transfer mined before this attempt can never be
  // rebound as its receipt. A legitimate same-second transfer may wait for the
  // relayer reference instead, which is safer than a false success.
  const lowerBoundMs =
    (Math.floor(input.attemptStartedAt.getTime() / 1_000) + 1) * 1_000;
  const upperBoundMs =
    input.attemptStartedAt.getTime() +
    POLYMARKET_HANDOFF_CHAIN_ATTRIBUTION_WINDOW_MS;
  const latestBlockTimestamp = await timestampForBlock(latestBlock);
  const latestBlockTimestampMs =
    latestBlockTimestamp === null
      ? null
      : Number(latestBlockTimestamp * 1_000n);
  const previousOldest = persistedBlockCursor(
    input.previousEvidence?.polymarketHandoffScanOldestBlock,
  );
  const previousNewest = persistedBlockCursor(
    input.previousEvidence?.polymarketHandoffScanNewestBlock,
  );
  const previousSweepTarget = persistedBlockCursor(
    input.previousEvidence?.polymarketHandoffScanSweepTargetBlock,
  );
  const previousAttributionEndBlock = persistedBlockCursor(
    input.previousEvidence?.polymarketHandoffAttributionEndBlock,
  );
  const previousAttributionEndBlockHash = persistedEvmBlockHash(
    input.previousEvidence?.polymarketHandoffAttributionEndBlockHash,
  );
  const previousScanStructurallyValid =
    previousOldest !== null &&
    previousNewest !== null &&
    previousOldest <= previousNewest &&
    previousNewest <= latestBlock;
  const previousAttributionCompleteClaimed =
    input.previousEvidence?.polymarketHandoffAttributionComplete === true;
  // Freeze the first observed canonical tip strictly after the time window.
  // Completion then converges even when an RPC provider forces one-block log
  // ranges while the live chain advances faster than each polling pass.
  const attributionEndBlock =
    previousAttributionEndBlock !== null &&
    previousAttributionEndBlock <= latestBlock
      ? previousAttributionEndBlock
      : latestBlockTimestampMs !== null &&
          Number.isSafeInteger(latestBlockTimestampMs) &&
          latestBlockTimestampMs > upperBoundMs
        ? latestBlock
        : null;
  const readAttributionEndBlockHash = async (): Promise<string | null> => {
    if (attributionEndBlock === null || !scanner.fetchBlockHash) return null;
    if (attributionEndBlock > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("Polymarket handoff attribution block is invalid");
    }
    const blockHash = await scanner.fetchBlockHash({
      rpcUrl: input.rpcUrl,
      timeoutMs: remainingDiscoveryTimeoutMs(),
      maxAttempts: 1,
      blockNumber: Number(attributionEndBlock),
    });
    if (blockHash === null) {
      throw new Error("Polymarket handoff attribution block is unavailable");
    }
    const canonicalBlockHash = persistedEvmBlockHash(blockHash);
    if (canonicalBlockHash === null) {
      throw new Error("Polymarket handoff attribution block hash is invalid");
    }
    return canonicalBlockHash;
  };
  let attributionEndBlockHash = await readAttributionEndBlockHash();
  const emptyFenceScan = (
    fenceChanged: boolean,
  ): PolymarketHandoffTransactionScan => ({
    attributionComplete: false,
    attributionEndBlock,
    attributionEndBlockHash,
    attributionFenceChanged: fenceChanged,
    attributionWindowClosed: attributionEndBlock !== null,
    candidateTransactions: {},
    caughtUp: false,
    historyCovered: false,
    lastScannedFromBlock: null,
    lastScannedToBlock: null,
    match: null,
    newestScannedBlock: attributionEndBlock ?? latestBlock,
    oldestScannedBlock: attributionEndBlock ?? latestBlock,
    sweepTargetBlock: attributionEndBlock ?? latestBlock,
  });
  const previousFenceMismatch =
    previousAttributionEndBlock !== null &&
    (attributionEndBlock === null ||
      previousAttributionEndBlock !== attributionEndBlock ||
      previousAttributionEndBlockHash === null ||
      attributionEndBlockHash === null ||
      previousAttributionEndBlockHash !== attributionEndBlockHash);
  const attributionFenceChanged =
    previousAttributionCompleteClaimed &&
    (previousAttributionEndBlock === null || previousFenceMismatch);
  if (attributionFenceChanged) {
    return emptyFenceScan(true);
  }
  // A first frozen fence or a changed partial-scan fence invalidates every
  // earlier empty range. Restart from the fixed canonical tip; only ranges
  // scanned under this exact ancestry may contribute to an absence proof.
  const previousStateValid =
    previousScanStructurallyValid &&
    !previousFenceMismatch &&
    !(previousAttributionEndBlock === null && attributionEndBlock !== null);
  let oldestScannedBlock = previousStateValid ? previousOldest : latestBlock;
  let newestScannedBlock = previousStateValid ? previousNewest : latestBlock;
  let historyCovered =
    previousStateValid &&
    input.previousEvidence?.polymarketHandoffScanHistoryCovered === true;
  const candidateTransactions = previousStateValid
    ? persistedHandoffCandidates(
        input.previousEvidence?.polymarketHandoffCandidateTransactions,
      )
    : new Map<string, number>();
  const previousSweepCaughtUp =
    previousStateValid &&
    input.previousEvidence?.polymarketHandoffScanCaughtUp === true;
  const previousAttributionComplete =
    previousStateValid &&
    previousAttributionEndBlock !== null &&
    previousAttributionEndBlockHash !== null &&
    previousAttributionEndBlockHash === attributionEndBlockHash &&
    previousAttributionEndBlock <= latestBlock &&
    previousAttributionCompleteClaimed;
  const attributionWindowClosed = attributionEndBlock !== null;
  const continuingPreviousSweep =
    previousStateValid &&
    previousSweepTarget !== null &&
    previousSweepTarget <= latestBlock &&
    !previousSweepCaughtUp;
  const sweepTargetBlock = continuingPreviousSweep
    ? previousSweepTarget
    : previousAttributionComplete ||
        (previousSweepCaughtUp && candidateTransactions.size > 0)
      ? (previousSweepTarget ?? previousNewest)
      : (attributionEndBlock ?? latestBlock);
  let direction: "backward" | "forward" | null = null;
  let requestedFromBlock: bigint | null = null;
  let requestedToBlock: bigint | null = null;
  if (!previousStateValid) {
    direction = "backward";
    requestedToBlock = sweepTargetBlock;
    requestedFromBlock =
      sweepTargetBlock >= POLYMARKET_HANDOFF_SCAN_BLOCK_COUNT - 1n
        ? sweepTargetBlock - POLYMARKET_HANDOFF_SCAN_BLOCK_COUNT + 1n
        : 0n;
  } else if (!historyCovered && oldestScannedBlock > 0n) {
    direction = "backward";
    requestedToBlock = oldestScannedBlock - 1n;
    requestedFromBlock =
      requestedToBlock >= POLYMARKET_HANDOFF_SCAN_BLOCK_COUNT - 1n
        ? requestedToBlock - POLYMARKET_HANDOFF_SCAN_BLOCK_COUNT + 1n
        : 0n;
  } else if (newestScannedBlock < sweepTargetBlock) {
    direction = "forward";
    requestedFromBlock = newestScannedBlock + 1n;
    requestedToBlock = sweepTargetBlock;
  }
  let lastScannedFromBlock: bigint | null = null;
  let lastScannedToBlock: bigint | null = null;
  if (
    direction !== null &&
    requestedFromBlock !== null &&
    requestedToBlock !== null
  ) {
    const transferScan = await fetchPolymarketHandoffTransferLogs(scanner, {
      rpcUrl: input.rpcUrl,
      timeoutMs: remainingDiscoveryTimeoutMs(),
      maxAttempts: 1,
      contractAddress: expectation.tokenAddress,
      recipientAddress: expectation.recipientAddress,
      direction,
      fromBlock: requestedFromBlock,
      toBlock: requestedToBlock,
    });
    lastScannedFromBlock = transferScan.scannedFromBlock;
    lastScannedToBlock = transferScan.scannedToBlock;
    if (!previousStateValid) {
      oldestScannedBlock = transferScan.scannedFromBlock;
      newestScannedBlock = transferScan.scannedToBlock;
    } else if (direction === "backward") {
      oldestScannedBlock = transferScan.scannedFromBlock;
    } else {
      newestScannedBlock = transferScan.scannedToBlock;
    }
    const exactTransfers = transferScan.logs.filter(
      (transfer) =>
        transfer.fromAddress === expectation.funderAddress &&
        transfer.toAddress === expectation.recipientAddress &&
        transfer.rawAmount === expectation.amountRaw,
    );
    await Promise.all(
      exactTransfers.map(async (transfer) => {
        const blockTimestamp = await timestampForBlock(transfer.blockNumber);
        if (blockTimestamp === null) {
          throw new Error(
            "Polymarket handoff transfer block timestamp is unavailable",
          );
        }
        const blockTimestampMs = Number(blockTimestamp * 1_000n);
        if (!Number.isSafeInteger(blockTimestampMs)) {
          throw new Error(
            "Polymarket handoff transfer block timestamp is invalid",
          );
        }
        if (
          blockTimestampMs < lowerBoundMs ||
          blockTimestampMs > upperBoundMs
        ) {
          return;
        }
        candidateTransactions.set(
          transfer.transactionHash.toLowerCase(),
          blockTimestampMs,
        );
      }),
    );
  }
  if (!historyCovered) {
    const oldestScannedBlockTimestamp =
      await timestampForBlock(oldestScannedBlock);
    const oldestScannedBlockTimestampMs =
      oldestScannedBlockTimestamp === null
        ? null
        : Number(oldestScannedBlockTimestamp * 1_000n);
    historyCovered =
      oldestScannedBlock === 0n ||
      (oldestScannedBlockTimestampMs !== null &&
        Number.isSafeInteger(oldestScannedBlockTimestampMs) &&
        oldestScannedBlockTimestampMs <= lowerBoundMs);
  }
  if (attributionEndBlockHash !== null) {
    const verifiedEndBlockHash = await readAttributionEndBlockHash();
    if (verifiedEndBlockHash !== attributionEndBlockHash) {
      attributionEndBlockHash = verifiedEndBlockHash;
      return emptyFenceScan(previousAttributionCompleteClaimed);
    }
  }
  const caughtUp = historyCovered && newestScannedBlock >= sweepTargetBlock;
  const attributionComplete =
    previousAttributionComplete ||
    (attributionEndBlock !== null &&
      attributionEndBlockHash !== null &&
      historyCovered &&
      newestScannedBlock >= attributionEndBlock);
  const onlyMatch =
    caughtUp && candidateTransactions.size === 1
      ? [...candidateTransactions.entries()][0]
      : null;
  return {
    attributionComplete,
    attributionEndBlock,
    attributionEndBlockHash,
    attributionFenceChanged: false,
    attributionWindowClosed,
    candidateTransactions: Object.fromEntries(candidateTransactions),
    caughtUp,
    historyCovered,
    lastScannedFromBlock,
    lastScannedToBlock,
    match: onlyMatch
      ? { transactionHash: onlyMatch[0], blockTimestampMs: onlyMatch[1] }
      : null,
    newestScannedBlock,
    oldestScannedBlock,
    sweepTargetBlock,
  };
}

export async function findRecentPolymarketHandoffTransactionHash(
  input: Parameters<typeof findRecentPolymarketHandoffTransactionScan>[0],
  scanner: PolymarketHandoffRpcScanner = defaultPolymarketHandoffRpcScanner,
): Promise<string | null> {
  return (
    (await findRecentPolymarketHandoffTransactionScan(input, scanner))?.match
      ?.transactionHash ?? null
  );
}

type PolymarketHandoffLookupDependencies = Readonly<{
  findTransactionScan: typeof findRecentPolymarketHandoffTransactionScan;
  resolveReference: typeof resolvePolymarketRelayerFundingReference;
}>;

const defaultPolymarketHandoffLookupDependencies: PolymarketHandoffLookupDependencies =
  {
    findTransactionScan: findRecentPolymarketHandoffTransactionScan,
    resolveReference: resolvePolymarketRelayerFundingReference,
  };

async function inspectEvmTargetEvidence(
  target: FundingStepReceiptTarget,
  reference: string,
  context = createEvmReceiptInspectionContext(),
  handoffLookup = defaultPolymarketHandoffLookupDependencies,
): Promise<FundingStepReceiptEvidence> {
  if (
    target.action.kind !== "evm_transaction" &&
    target.action.kind !== "evm_transaction_batch" &&
    target.action.kind !== "external_handoff"
  ) {
    throw new Error("EVM receipt inspector received a non-EVM action");
  }
  const chainId = Number(target.action.networkId.slice("evm:".length));
  const rpcUrl = Number.isSafeInteger(chainId) ? evmRpcUrl(chainId) : null;
  if (!rpcUrl) {
    throw new Error("committed EVM receipt inspection context is incomplete");
  }
  const timeoutMs = boundedReceiptRpcTimeoutMs(evmReceiptTimeoutMs(chainId));
  let transactionReference = reference;
  let transactionHashSource:
    | "chain_scan"
    | "persisted"
    | "provider"
    | "reported" = "reported";
  let chainTransactionBlockTimestampMs: number | null = null;
  if (target.action.kind === "external_handoff") {
    const relayerTransactionId =
      parsePolymarketRelayerTransactionReference(reference);
    const previouslyBoundHash =
      target.previousReceipt?.evidence.transactionHash;
    const boundTransactionHash =
      typeof previouslyBoundHash === "string" &&
      /^0x[0-9a-fA-F]{64}$/u.test(previouslyBoundHash)
        ? previouslyBoundHash.toLowerCase()
        : null;
    if (boundTransactionHash) {
      // Keep watching the durable identity during provider outages, but also
      // refresh the original relayer request best-effort. A replacement hash
      // is never swapped silently: binding it below emits mismatch/reorg and
      // puts the operation into recovery before any retry can be authorized.
      let providerTransactionHash: string | null = null;
      if (relayerTransactionId) {
        try {
          const providerResolution =
            await handoffLookup.resolveReference(reference);
          providerTransactionHash =
            providerResolution.kind === "transaction"
              ? providerResolution.reference.toLowerCase()
              : null;
        } catch {
          // Receipt polling remains independent of provider availability.
        }
      }
      const providerReboundHash =
        providerTransactionHash !== null &&
        providerTransactionHash !== boundTransactionHash
          ? providerTransactionHash
          : null;
      const providerRebound = providerReboundHash !== null;
      transactionReference = providerReboundHash ?? boundTransactionHash;
      const previousSource =
        target.previousReceipt?.evidence.transactionHashSource;
      transactionHashSource = providerRebound
        ? "provider"
        : previousSource === "chain_scan" ||
            previousSource === "provider" ||
            previousSource === "reported"
          ? previousSource
          : "persisted";
      const previousBlockTimestampMs =
        target.previousReceipt?.evidence.chainTransactionBlockTimestampMs;
      chainTransactionBlockTimestampMs =
        !providerRebound &&
        typeof previousBlockTimestampMs === "number" &&
        Number.isSafeInteger(previousBlockTimestampMs)
          ? previousBlockTimestampMs
          : null;
    } else if (!relayerTransactionId) {
      transactionReference = reference;
    } else {
      const [chainLookup, providerLookup] = await Promise.allSettled([
        handoffLookup.findTransactionScan({
          action: target.action,
          actionValidationResult: target.actionValidationResult,
          attemptStartedAt: target.attemptStartedAt,
          previousEvidence: target.previousReceipt?.evidence ?? null,
          rpcUrl,
          timeoutMs,
        }),
        handoffLookup.resolveReference(reference),
      ]);
      const chainTransactionScan =
        chainLookup.status === "fulfilled" ? chainLookup.value : null;
      const chainTransactionMatch = chainTransactionScan?.match ?? null;
      const chainTransactionHash =
        chainTransactionMatch?.transactionHash ?? null;
      const providerResolution =
        providerLookup.status === "fulfilled" ? providerLookup.value : null;
      const providerTransactionHash =
        providerResolution?.kind === "transaction"
          ? providerResolution.reference.toLowerCase()
          : null;
      const previousHashlessFailureUnderWatch =
        target.previousReceipt?.status === "failed" &&
        target.previousReceipt.canonical &&
        target.previousReceipt.evidence.failureFinalized === true;
      if (
        previousHashlessFailureUnderWatch &&
        providerResolution?.kind === "evidence" &&
        providerResolution.evidence.status === "mismatch"
      ) {
        // The previous terminal failure already authorized a retry. A later
        // provider identity/integrity conflict invalidates that authorization;
        // failed -> mismatch is intentionally immutable in persistence, while
        // failed -> reorged durably stops the step and operation.
        return {
          status: "reorged",
          actionMatch: true,
          ledgerHeight: target.previousReceipt?.ledgerHeight ?? null,
          blockHash: target.previousReceipt?.blockHash ?? null,
          canonical: false,
          failureCode: "polymarket_handoff_failure_evidence_invalidated",
          evidence: {
            ...providerResolution.evidence.evidence,
            previousFailureCode: target.previousReceipt?.failureCode ?? null,
            providerFailureCode: providerResolution.evidence.failureCode,
          },
        };
      }
      if (
        previousHashlessFailureUnderWatch &&
        chainTransactionScan === null &&
        providerTransactionHash === null &&
        !(
          providerResolution?.kind === "evidence" &&
          providerResolution.evidence.status === "reorged"
        )
      ) {
        // The stored failure authorized retry only after an exact zero-transfer
        // scan under a frozen canonical block. During its bounded reorg watch,
        // provider status alone cannot revalidate that absence proof. Surface
        // Polygon scan unavailability so reconciliation keeps retrying (and
        // ultimately dead-letters) instead of silently consuming the watch.
        throw new Error(
          "Polymarket handoff chain scan is unavailable during hashless failure verification",
          {
            cause:
              chainLookup.status === "rejected"
                ? chainLookup.reason
                : undefined,
          },
        );
      }
      if (chainTransactionScan?.attributionFenceChanged) {
        return {
          status: "reorged",
          actionMatch: true,
          ledgerHeight:
            chainTransactionScan.attributionEndBlock?.toString() ?? null,
          blockHash: chainTransactionScan.attributionEndBlockHash,
          canonical: false,
          failureCode: "polymarket_handoff_attribution_fence_changed",
          evidence: handoffScanStateEvidence(chainTransactionScan),
        };
      }
      if (
        chainTransactionHash &&
        providerTransactionHash &&
        chainTransactionHash !== providerTransactionHash
      ) {
        return {
          status: "mismatch",
          actionMatch: false,
          ledgerHeight: null,
          blockHash: null,
          canonical: true,
          failureCode: "polymarket_handoff_transaction_reference_conflict",
          evidence: evidence({
            chainTransactionHash,
            providerTransactionHash,
          }),
        };
      }
      const chainScanEvidence: JsonRecord = chainTransactionScan
        ? handoffScanStateEvidence(chainTransactionScan)
        : {};
      if (providerResolution?.kind === "evidence") {
        const terminalProviderEvidence =
          reconcilePolymarketHandoffTerminalProviderEvidence({
            chainScan: chainTransactionScan,
            providerEvidence: providerResolution.evidence,
          });
        if (terminalProviderEvidence) return terminalProviderEvidence;
      }
      const discoveredTransactionHash =
        providerTransactionHash ?? chainTransactionHash;
      if (discoveredTransactionHash) {
        transactionReference = discoveredTransactionHash;
        transactionHashSource = providerTransactionHash
          ? "provider"
          : "chain_scan";
        chainTransactionBlockTimestampMs =
          chainTransactionMatch?.blockTimestampMs ?? null;
      } else if (providerResolution?.kind === "evidence") {
        return {
          ...providerResolution.evidence,
          evidence: {
            ...providerResolution.evidence.evidence,
            chainLookupAvailable: chainLookup.status === "fulfilled",
            ...chainScanEvidence,
          },
        };
      } else {
        const chainCandidateCount = chainTransactionScan
          ? Object.keys(chainTransactionScan.candidateTransactions).length
          : 0;
        if (
          previousHashlessFailureUnderWatch &&
          providerLookup.status === "rejected" &&
          chainCandidateCount > 0
        ) {
          return {
            status: "mismatch",
            actionMatch: false,
            ledgerHeight:
              chainTransactionScan?.attributionEndBlock?.toString() ?? null,
            blockHash: chainTransactionScan?.attributionEndBlockHash ?? null,
            canonical: true,
            failureCode: "polymarket_handoff_chain_candidate_ambiguity",
            evidence: {
              ...chainScanEvidence,
              chainAbsenceProven: false,
              providerLookupAvailable: false,
            },
          };
        }
        if (
          previousHashlessFailureUnderWatch &&
          providerLookup.status === "rejected"
        ) {
          // An unchanged zero-candidate chain scan plus missing provider data is
          // not new evidence. Keep the durable failed receipt untouched and let
          // reconciliation retry instead of turning transient unavailability
          // into an immutable reorg/recovery state.
          throw new Error(
            "Polymarket relayer lookup is unavailable during hashless failure verification",
            { cause: providerLookup.reason },
          );
        }
        return {
          status: "pending",
          actionMatch: null,
          ledgerHeight: null,
          blockHash: null,
          canonical: true,
          failureCode: null,
          evidence: evidence({
            chainLookupAvailable: chainLookup.status === "fulfilled",
            providerLookupAvailable: providerLookup.status === "fulfilled",
            ...chainScanEvidence,
          }),
        };
      }
    }
  }
  if (!/^0x[0-9a-fA-F]{64}$/u.test(transactionReference)) {
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
  const expectedSignerAddress =
    target.action.kind === "evm_transaction" ||
    target.action.kind === "evm_transaction_batch"
      ? validExpectedSigner(target.actionValidationResult, "evm")
      : null;
  if (
    (target.action.kind === "evm_transaction" ||
      target.action.kind === "evm_transaction_batch") &&
    !expectedSignerAddress
  ) {
    throw new Error("committed EVM receipt inspection context is incomplete");
  }
  const [transaction, receipt] = await Promise.all([
    fetchEvmTransactionByHash({
      rpcUrl,
      timeoutMs,
      maxAttempts: 1,
      transactionHash: transactionReference,
    }),
    fetchEvmTransactionReceipt({
      rpcUrl,
      timeoutMs,
      maxAttempts: 1,
      transactionHash: transactionReference,
    }),
  ]);
  let receiptRecord: EvmReceiptRecord | null = null;
  if (receipt) {
    const [latestBlockNumber, canonicalBlock] = await Promise.all([
      latestEvmBlockNumber(context, chainId, rpcUrl, timeoutMs),
      canonicalEvmBlockHash(
        context,
        chainId,
        receipt.blockNumber,
        rpcUrl,
        timeoutMs,
      ),
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
    return bindPolymarketRelayerTransactionHash({
      evaluated: evaluatePolymarketDepositWalletHandoffReceipt({
        action: target.action,
        actionValidationResult: target.actionValidationResult,
        transaction: transactionRecord,
        receipt: receiptRecord,
        previous: target.previousReceipt,
      }),
      previous: target.previousReceipt,
      transactionHash: transactionReference,
      transactionHashSource,
      chainTransactionBlockTimestampMs,
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

function revokeHashlessHandoffRetryOnConflictingEvidence(
  target: FundingStepReceiptTarget,
  inspected: FundingStepReceiptEvidence,
): FundingStepReceiptEvidence {
  const previous = target.previousReceipt;
  const previousHasTransactionHash = [
    previous?.evidence.previousTransactionHash,
    previous?.evidence.transactionHash,
  ].some((value) => typeof value === "string" && value.length > 0);
  const retryWasAuthorizedByHashlessFailure =
    target.action.kind === "external_handoff" &&
    previous?.status === "failed" &&
    previous.canonical &&
    previous.evidence.failureFinalized === true &&
    !previousHasTransactionHash;
  if (
    !retryWasAuthorizedByHashlessFailure ||
    inspected.status === "failed" ||
    inspected.status === "reorged"
  ) {
    return inspected;
  }
  // A hashless terminal failure can authorize another attempt only while its
  // canonical zero-transfer proof remains uncontested. Any different provider
  // or chain evidence revokes that authorization before persistence can absorb
  // it as failed -> mismatch/pending and accidentally permit a duplicate send.
  return {
    status: "reorged",
    actionMatch: true,
    ledgerHeight: inspected.ledgerHeight ?? previous.ledgerHeight,
    blockHash: inspected.blockHash ?? previous.blockHash,
    canonical: false,
    failureCode: "polymarket_handoff_failure_evidence_invalidated",
    evidence: {
      ...inspected.evidence,
      invalidatingReceiptStatus: inspected.status,
      invalidatingReceiptActionMatch: inspected.actionMatch,
      invalidatingReceiptFailureCode: inspected.failureCode,
      previousFailureCode: previous.failureCode,
    },
  };
}

export async function inspectEvmTarget(
  target: FundingStepReceiptTarget,
  reference: string,
  context = createEvmReceiptInspectionContext(),
  handoffLookup = defaultPolymarketHandoffLookupDependencies,
): Promise<FundingStepReceiptEvidence> {
  return revokeHashlessHandoffRetryOnConflictingEvidence(
    target,
    await inspectEvmTargetEvidence(target, reference, context, handoffLookup),
  );
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

export type SvmReceiptRpcReader = Readonly<{
  fetchSignatureStatus: typeof fetchSolanaSignatureReceiptStatus;
  fetchTransaction: typeof fetchSolanaReceiptTransaction;
}>;

const defaultSvmReceiptRpcReader: SvmReceiptRpcReader = {
  fetchSignatureStatus: fetchSolanaSignatureReceiptStatus,
  fetchTransaction: fetchSolanaReceiptTransaction,
};

export async function inspectSvmTarget(
  target: FundingStepReceiptTarget,
  reference: string,
  rpc: SvmReceiptRpcReader = defaultSvmReceiptRpcReader,
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
  const receiptRpcTimeoutMs = boundedReceiptRpcTimeoutMs(
    fundingSidecarRuntimeConfig.solanaRpcTimeoutMs,
  );
  const status = await rpc.fetchSignatureStatus({
    rpcUrls: [...fundingSidecarRuntimeConfig.solanaRpcUrls],
    signature: reference,
    timeoutMs: receiptRpcTimeoutMs,
    maxAttempts: 1,
    totalTimeoutMs: receiptRpcTimeoutMs,
  });
  const withTransactionSignature = (
    result: FundingStepReceiptEvidence,
  ): FundingStepReceiptEvidence => ({
    ...result,
    evidence: {
      ...result.evidence,
      transactionSignature: reference,
    },
  });
  if (!status) {
    return withTransactionSignature(
      evaluateSvmActionReceipt({
        action: target.action,
        expectedSignerAddress,
        transaction: null,
        previous: target.previousReceipt,
      }),
    );
  }
  const commitment =
    status.confirmationStatus === "finalized" ? "finalized" : "confirmed";
  const transaction = await rpc.fetchTransaction({
    rpcUrls: [...fundingSidecarRuntimeConfig.solanaRpcUrls],
    signature: reference,
    timeoutMs: receiptRpcTimeoutMs,
    maxAttempts: 1,
    totalTimeoutMs: receiptRpcTimeoutMs,
    commitment,
  });
  if (!transaction) {
    return withTransactionSignature(
      evaluateSvmActionReceipt({
        action: target.action,
        expectedSignerAddress,
        transaction: null,
        previous: target.previousReceipt,
      }),
    );
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
  return withTransactionSignature(
    evaluateSvmActionReceipt({
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
    }),
  );
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
    )(pool, operationId);
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
