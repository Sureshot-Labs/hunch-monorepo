import { Connection, PublicKey } from "@solana/web3.js";
import type { Pool } from "@hunch/infra";
import bs58 from "bs58";
import { ethers } from "ethers";

import { env } from "../../env.js";
import type {
  EvmTransactionAction,
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
import type { FundingTransactionReferenceCodec } from "./transaction-reference-codec.js";

type JsonRecord = Readonly<Record<string, JsonValue>>;

export const EVM_FUNDING_ACTION_FINALITY_CONFIRMATIONS = 12;

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
}>;

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

export function evaluateEvmActionReceipt(
  input: Readonly<{
    action: EvmTransactionAction;
    expectedSignerAddress: string;
    transaction: EvmReceiptTransaction | null;
    receipt: EvmReceiptRecord | null;
    previous: FundingStepReceiptObservation | null;
  }>,
): FundingStepReceiptEvidence {
  if (!input.transaction) {
    if (input.previous?.status === "finalized") {
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
  const matches =
    input.transaction.chainId === expectedChainId &&
    input.transaction.from.toLowerCase() ===
      input.expectedSignerAddress.toLowerCase() &&
    input.transaction.to?.toLowerCase() === input.action.to.toLowerCase() &&
    normalizedHex(input.transaction.data) ===
      normalizedHex(input.action.data) &&
    input.transaction.value === BigInt(input.action.valueRaw);
  if (!matches) {
    return {
      status: "mismatch",
      actionMatch: false,
      ledgerHeight: input.receipt?.blockNumber.toString() ?? null,
      blockHash: input.receipt?.blockHash ?? null,
      canonical: true,
      failureCode: "transaction_action_mismatch",
      evidence: evidence({
        transactionObserved: true,
        receiptObserved: input.receipt != null,
      }),
    };
  }
  if (!input.receipt) {
    if (input.previous?.status === "finalized") {
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
    input.previous?.status === "finalized" &&
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
  if (!input.receipt.succeeded) {
    return {
      status: "failed",
      actionMatch: true,
      ledgerHeight: input.receipt.blockNumber.toString(),
      blockHash: input.receipt.blockHash,
      canonical: true,
      failureCode: "transaction_reverted",
      evidence: evidence({
        confirmations: input.receipt.confirmations,
        receiptObserved: true,
      }),
    };
  }
  const finalized =
    input.receipt.confirmations >= EVM_FUNDING_ACTION_FINALITY_CONFIRMATIONS;
  return {
    status: finalized ? "finalized" : "confirmed",
    actionMatch: true,
    ledgerHeight: input.receipt.blockNumber.toString(),
    blockHash: input.receipt.blockHash,
    canonical: true,
    failureCode: null,
    evidence: evidence({
      confirmationPolicy: EVM_FUNDING_ACTION_FINALITY_CONFIRMATIONS,
      confirmations: input.receipt.confirmations,
      receiptObserved: true,
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
    if (input.previous?.status === "finalized") {
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
  const override = env.evmRpcUrlsByChain[String(chainId)];
  if (override?.trim()) return override.trim();
  if (chainId === 137) return env.polygonRpcUrl;
  if (chainId === 8453) return env.baseRpcUrl;
  if (chainId === 1) return env.ethereumRpcUrl;
  if (chainId === 10) return env.optimismRpcUrl;
  if (chainId === 56) return env.bscRpcUrl;
  if (chainId === 42161) return env.arbitrumRpcUrl;
  if (chainId === 43114) return env.avalancheRpcUrl;
  if (chainId === 59144) return env.lineaRpcUrl;
  return null;
}

async function inspectEvmTarget(
  target: FundingStepReceiptTarget,
  reference: string,
): Promise<FundingStepReceiptEvidence> {
  if (target.action.kind !== "evm_transaction") {
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
  const expectedSignerAddress = validExpectedSigner(
    target.actionValidationResult,
    "evm",
  );
  if (!rpcUrl || !expectedSignerAddress) {
    throw new Error("committed EVM receipt inspection context is incomplete");
  }
  const provider = new ethers.JsonRpcProvider(rpcUrl, chainId, {
    staticNetwork: true,
  });
  const [transaction, receipt] = await Promise.all([
    provider.getTransaction(reference),
    provider.getTransactionReceipt(reference),
  ]);
  let receiptRecord: EvmReceiptRecord | null = null;
  if (receipt) {
    const [confirmations, canonicalBlock] = await Promise.all([
      receipt.confirmations(),
      provider.getBlock(receipt.blockNumber),
    ]);
    receiptRecord = {
      succeeded: receipt.status === 1,
      blockNumber: receipt.blockNumber,
      blockHash: receipt.blockHash,
      confirmations,
      canonicalBlockHash: canonicalBlock?.hash ?? null,
    };
  }
  return evaluateEvmActionReceipt({
    action: target.action,
    expectedSignerAddress,
    transaction: transaction
      ? {
          chainId: transaction.chainId,
          from: transaction.from,
          to: transaction.to,
          data: transaction.data,
          value: transaction.value,
        }
      : null,
    receipt: receiptRecord,
    previous: target.previousReceipt,
  });
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
  const connection = new Connection(env.solanaRpcUrl, "confirmed");
  const statusResponse = await connection.getSignatureStatuses([reference], {
    searchTransactionHistory: true,
  });
  const status = statusResponse.value[0];
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
  const transaction = await connection.getTransaction(reference, {
    commitment,
    maxSupportedTransactionVersion: 0,
  });
  if (!transaction) {
    return evaluateSvmActionReceipt({
      action: target.action,
      expectedSignerAddress,
      transaction: null,
      previous: target.previousReceipt,
    });
  }
  const message = transaction.transaction.message as unknown as {
    header: { numRequiredSignatures: number };
    staticAccountKeys?: readonly PublicKey[];
    accountKeys?: readonly PublicKey[];
    compiledInstructions: readonly Readonly<{
      programIdIndex: number;
      accountKeyIndexes?: readonly number[];
      accounts?: readonly number[];
      data: unknown;
    }>[];
    addressTableLookups?: readonly Readonly<{ accountKey: PublicKey }>[];
    getAccountKeys?: (input?: {
      accountKeysFromLookups?: Readonly<{
        writable: readonly PublicKey[];
        readonly: readonly PublicKey[];
      }>;
    }) => Readonly<{ get(index: number): PublicKey | undefined }>;
  };
  const staticKeys = message.staticAccountKeys ?? message.accountKeys ?? [];
  const loaded = transaction.meta?.loadedAddresses;
  const resolvedKeys = message.getAccountKeys?.(
    loaded ? { accountKeysFromLookups: loaded } : undefined,
  );
  const keyAt = (index: number): PublicKey | undefined =>
    resolvedKeys?.get(index) ?? staticKeys[index];
  const instructions: SvmReceiptInstruction[] = [];
  for (const instruction of message.compiledInstructions) {
    const programId = keyAt(instruction.programIdIndex)?.toBase58();
    const accountIndexes =
      instruction.accountKeyIndexes ?? instruction.accounts ?? [];
    const accounts = accountIndexes.map((index) => keyAt(index)?.toBase58());
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
  const signers = staticKeys
    .slice(0, message.header.numRequiredSignatures)
    .map((key) => key.toBase58());
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
      failed: status.err != null || transaction.meta?.err != null,
      slot: transaction.slot,
      signers,
      instructions,
      addressLookupTables:
        message.addressTableLookups?.map((lookup) =>
          lookup.accountKey.toBase58(),
        ) ?? [],
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
    )(pool, operationId);
    let receiptsFinalized = 0;
    for (const target of targets) {
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
        throw new Error("funding transaction reference integrity check failed");
      }
      const inspected =
        target.action.kind === "evm_transaction"
          ? await (this.dependencies.inspectEvm ?? inspectEvmTarget)(
              target,
              reference,
            )
          : await (this.dependencies.inspectSvm ?? inspectSvmTarget)(
              target,
              reference,
            );
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
    }
    return { receiptsPolled: targets.length, receiptsFinalized };
  }
}
