import { createHash, randomUUID } from "node:crypto";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  AddressLookupTableAccount,
  Connection,
  PublicKey,
  SystemInstruction,
  SystemProgram,
  TransactionInstruction,
  VersionedTransaction,
} from "@solana/web3.js";

import { createAuthMiddleware } from "../auth.js";
import { pool } from "../db.js";
import { env } from "../env.js";
import { isRecord } from "../lib/type-guards.js";
import { fetchActiveDebridgeConfig } from "../repos/debridge-config.js";
import { getRedis } from "../redis.js";
import {
  embeddedEvmExecuteBodySchema,
  embeddedEvmPrepareBodySchema,
  embeddedSolanaExecuteBodySchema,
  embeddedSolanaPrepareBodySchema,
  solanaPrefundErrorResponseSchema,
  solanaPrefundExecuteBodySchema,
  solanaPrefundExecuteResponseSchema,
  solanaPrefundPrepareBodySchema,
  solanaPrefundPrepareResponseSchema,
  solanaReadinessBodySchema,
  solanaReadinessResponseSchema,
} from "../schemas/embedded-wallets.js";
import {
  debridgeRequest,
  extractDebridgeErrorMessage,
} from "../services/debridge-client.js";
import {
  executeEmbeddedEthereumTransactionRequests,
  prepareEmbeddedEthereumTransactionRequests,
  resolveEmbeddedEthereumWalletContext,
} from "../services/embedded-ethereum.js";
import {
  buildEmbeddedExecutionSingleFlightKey,
  runEmbeddedExecutionSingleFlight,
} from "../services/embedded-execution-singleflight.js";
import {
  buildEmbeddedSolanaSignAndSendRequest,
  executeEmbeddedSolanaTransactionRequests,
  prepareEmbeddedSolanaTransactionRequests,
  resolveEmbeddedSolanaWalletContext,
  type EmbeddedPrivyAuthorizationRequest,
  type EmbeddedSolanaTransactionSpec,
} from "../services/embedded-solana.js";
import {
  parseKalshiLossCloseTransactionTokenId,
  validateKalshiLossCloseSponsoredTransaction,
} from "../services/kalshi-loss-close.js";
import { resolveAuthAccessPolicy } from "../services/runtime-policies.js";
import {
  fetchSolanaBalanceLamports,
  fetchSolanaTokenBalanceByOwnerAndMint,
  formatUiAmount,
} from "../services/solana-rpc.js";

const EMBEDDED_SOLANA_PREPARED_TTL_SEC = 300;
const SOLANA_PREFUND_PREPARED_TTL_SEC = 300;
const SOLANA_CHAIN_ID = "7565164";
const SOLANA_NATIVE_ADDRESS = "11111111111111111111111111111111";
const SOL_DECIMALS = 9;
const DEFAULT_SOLANA_PREFUND_SLIPPAGE = 0.5;
const COMPUTE_BUDGET_PROGRAM_ID =
  "ComputeBudget111111111111111111111111111111";
const COMPUTE_BUDGET_SET_COMPUTE_UNIT_LIMIT = 2;
const COMPUTE_BUDGET_SET_COMPUTE_UNIT_PRICE = 3;
const SOLANA_PREFUND_MAX_COMPUTE_UNIT_LIMIT = 1_400_000;
const SOLANA_PREFUND_MAX_COMPUTE_UNIT_PRICE_MICRO_LAMPORTS = 100_000n;
const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const SOLANA_WRAPPED_SOL_MINT = "So11111111111111111111111111111111111111112";
const JUPITER_V6_PROGRAM_ID = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const JUPITER_USDC_TO_SOL_PREFUND_LAYOUTS = new Map<
  string,
  {
    tokenProgramPosition: number;
    transferAuthorityPosition: number;
    sourceTokenAccountPosition: number;
    destinationTokenAccountPosition: number;
    sourceMintPosition?: number;
    destinationMintPosition: number;
  }
>([
  [
    "e517cb977ae3ad2a",
    {
      tokenProgramPosition: 0,
      transferAuthorityPosition: 1,
      sourceTokenAccountPosition: 2,
      destinationTokenAccountPosition: 3,
      destinationMintPosition: 5,
    },
  ],
]);
const JUPITER_SHARED_ACCOUNTS_ROUTE_TAIL_LAYOUTS = [
  {
    name: "shared_accounts_route_u16_slippage_platform_fee",
    tailLength: 19,
    amountInOffsetFromTail: 0,
    quotedOutOffsetFromTail: 8,
    slippageOffsetFromTail: 16,
    slippageBytes: 2,
    platformFeeOffsetFromTail: 18,
  },
  {
    name: "shared_accounts_route_u16_slippage",
    tailLength: 18,
    amountInOffsetFromTail: 0,
    quotedOutOffsetFromTail: 8,
    slippageOffsetFromTail: 16,
    slippageBytes: 2,
  },
  {
    name: "shared_accounts_route_u32_slippage_legacy_fixture",
    tailLength: 20,
    amountInOffsetFromTail: 0,
    quotedOutOffsetFromTail: 8,
    slippageOffsetFromTail: 16,
    slippageBytes: 4,
  },
] as const;
const MIN_VARIABLE_JUPITER_ROUTE_DATA_LENGTH = 64;
const ASSOCIATED_TOKEN_CREATE_IDEMPOTENT_INSTRUCTION = 1;
const TOKEN_CLOSE_ACCOUNT_INSTRUCTION = 9;
const SOLANA_PREFUND_ROUTE_ATTEMPTS = 4;
const SOLANA_PREFUND_DAILY_LIMIT = 20;
const SOLANA_PREFUND_LIMIT_TTL_SEC = 24 * 60 * 60;
const SOLANA_PREFUND_RATE_LIMIT_VERSION = "v2";
const SAFE_SOLANA_PREFUND_ROUTE_ERROR =
  "Unable to find a safe SOL prefund route. Retry in a few seconds.";

type EmbeddedSolanaPreparedCacheEntry = {
  expiresAt: number;
  requests: EmbeddedPrivyAuthorizationRequest[];
};

type SolanaPrefundOperation =
  | "dflow_buy"
  | "dflow_sell"
  | "dflow_redeem"
  | "across"
  | "debridge";

type SolanaPrefundPreparedCacheEntry = {
  expiresAt: number;
  createdAt: number;
  userId: string;
  signer: string;
  operation: SolanaPrefundOperation;
  marketId?: string | null;
  amountInRaw: string;
  estimatedOutLamports: string;
  decodedMinOutLamports: string;
  minOutLamports: string;
  maxOutLamports: string;
  transactionDigest: string;
  request: EmbeddedPrivyAuthorizationRequest;
  providerPayload: unknown;
};

type RouteLogger = {
  warn: (obj: object, message?: string) => void;
};

type ResolvedSolanaAccount = {
  address: string;
  isSigner: boolean;
  isWritable: boolean;
};

type SolanaPrefundRouteAttemptDebug = {
  attempt: number;
  validationError?: string;
  tokenInAmountRaw: string | null;
  tokenOutAmountLamports: string | null;
  tokenOutMinAmountLamports: string | null;
  comparedAggregators: string[];
  feePayer: string | null;
  requiredSigners: string[];
  addressLookupTableCount: number;
  instructions: Array<{
    index: number;
    programId: string;
    dataPrefixHex: string;
    dataLength: number;
    accountCount: number;
  }>;
};

class SolanaPrefundRouteSelectionError extends Error {
  routeDebug: { attempts: SolanaPrefundRouteAttemptDebug[] };

  constructor(
    message: string,
    attempts: SolanaPrefundRouteAttemptDebug[],
  ) {
    super(message);
    this.name = "SolanaPrefundRouteSelectionError";
    this.routeDebug = { attempts };
  }
}

const embeddedSolanaPreparedMemory = new Map<
  string,
  EmbeddedSolanaPreparedCacheEntry
>();
const solanaPrefundPreparedMemory = new Map<
  string,
  SolanaPrefundPreparedCacheEntry
>();
const solanaPrefundLimitMemory = new Map<
  string,
  { count: number; expiresAt: number }
>();

function resetMemoryPrefundRateLimits(): void {
  solanaPrefundLimitMemory.clear();
}

const SOLANA_PREFUND_OPERATION_FLOORS: Record<
  SolanaPrefundOperation,
  { minSolLamports: bigint; targetSolLamports: bigint }
> = {
  dflow_buy: { minSolLamports: 5_000_000n, targetSolLamports: 30_000_000n },
  dflow_sell: { minSolLamports: 5_000_000n, targetSolLamports: 10_000_000n },
  dflow_redeem: { minSolLamports: 5_000_000n, targetSolLamports: 10_000_000n },
  across: { minSolLamports: 3_000_000n, targetSolLamports: 10_000_000n },
  debridge: { minSolLamports: 3_000_000n, targetSolLamports: 10_000_000n },
};

function isSolanaPrefundOperation(value: string): value is SolanaPrefundOperation {
  return Object.prototype.hasOwnProperty.call(
    SOLANA_PREFUND_OPERATION_FLOORS,
    value,
  );
}

function pruneExpiredEmbeddedSolanaPreparedMemory(now = Date.now()): void {
  for (const [key, entry] of embeddedSolanaPreparedMemory) {
    if (entry.expiresAt <= now) embeddedSolanaPreparedMemory.delete(key);
  }
}

function pruneExpiredSolanaPrefundPreparedMemory(now = Date.now()): void {
  for (const [key, entry] of solanaPrefundPreparedMemory) {
    if (entry.expiresAt <= now) solanaPrefundPreparedMemory.delete(key);
  }
}

function normalizeEvmAddress(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return /^0x[a-fA-F0-9]{40}$/.test(trimmed) ? trimmed.toLowerCase() : null;
}

function isSolanaAddress(value: string | null | undefined): value is string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return false;
  try {
    new PublicKey(trimmed);
    return true;
  } catch {
    return false;
  }
}

function normalizeSolanaAddress(value: string): string {
  return new PublicKey(value.trim()).toBase58();
}

function parsePositiveBigInt(value: string): bigint | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = BigInt(trimmed);
  return parsed > 0n ? parsed : null;
}

function readRecordString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim().length
    ? value.trim()
    : null;
}

function readBridgeTokenAmountRaw(value: unknown): bigint | null {
  if (!isRecord(value)) return null;
  const raw =
    readRecordString(value, "minAmount") ??
    readRecordString(value, "amount") ??
    readRecordString(value, "amountRaw") ??
    readRecordString(value, "amount_raw");
  if (!raw || !/^\d+$/.test(raw)) return null;
  return BigInt(raw);
}

function readBridgeTokenAddress(value: unknown): string | null {
  if (!isRecord(value)) return null;
  return (
    readRecordString(value, "address") ??
    readRecordString(value, "tokenAddress") ??
    readRecordString(value, "mint") ??
    readRecordString(value, "token")
  );
}

function normalizeSolanaAddressOrNull(value: string | null): string | null {
  if (!value) return null;
  return isSolanaAddress(value) ? normalizeSolanaAddress(value) : null;
}

function readDebridgeTxData(payload: unknown): string | null {
  if (!isRecord(payload) || !isRecord(payload.tx)) return null;
  return readRecordString(payload.tx, "data");
}

function decodeSerializedSolanaTransaction(payload: string): Buffer | null {
  if (payload.startsWith("0x")) {
    const hex = payload.slice(2);
    if (!hex.length || hex.length % 2 !== 0) return null;
    return Buffer.from(hex, "hex");
  }
  try {
    return Buffer.from(payload, "base64");
  } catch {
    return null;
  }
}

function parseSerializedSolanaTransactionBase64(payload: string): {
  txData: string;
  transaction: VersionedTransaction;
} | null {
  const raw = decodeSerializedSolanaTransaction(payload);
  if (!raw) return null;
  try {
    return {
      txData: raw.toString("base64"),
      transaction: VersionedTransaction.deserialize(raw),
    };
  } catch {
    return null;
  }
}

function digestSolanaTransactionPayload(payload: string): string {
  return createHash("sha256")
    .update(decodeSerializedSolanaTransaction(payload) ?? payload)
    .digest("hex");
}

function getTransactionRequiredSigners(tx: VersionedTransaction): string[] {
  return tx.message.staticAccountKeys
    .slice(0, tx.message.header.numRequiredSignatures)
    .map((key) => key.toBase58());
}

function buildResolvedTransactionInstruction(
  accounts: ResolvedSolanaAccount[],
  instruction: VersionedTransaction["message"]["compiledInstructions"][number],
): TransactionInstruction | null {
  const programIdAddress = getResolvedAccount(
    accounts,
    instruction.programIdIndex,
  )?.address;
  if (!programIdAddress) return null;

  const keys = [];
  for (const accountIndex of instruction.accountKeyIndexes) {
    const account = getResolvedAccount(accounts, accountIndex);
    if (!account) return null;
    keys.push({
      pubkey: new PublicKey(account.address),
      isSigner: account.isSigner,
      isWritable: account.isWritable,
    });
  }

  return new TransactionInstruction({
    programId: new PublicKey(programIdAddress),
    keys,
    data: Buffer.from(instruction.data),
  });
}

function getUsdcAssociatedTokenAccount(owner: string): string {
  return getAssociatedTokenAddressSync(
    new PublicKey(env.solanaUsdcMint),
    new PublicKey(owner),
    false,
    TOKEN_PROGRAM_ID,
  ).toBase58();
}

function getSplAssociatedTokenAccount(owner: string, mint: string): string {
  return getAssociatedTokenAddressSync(
    new PublicKey(mint),
    new PublicKey(owner),
    false,
    TOKEN_PROGRAM_ID,
  ).toBase58();
}

function resolveTransactionAccounts(inputs: {
  tx: VersionedTransaction;
  addressLookupTableAccounts?: AddressLookupTableAccount[];
}): ResolvedSolanaAccount[] {
  const { tx } = inputs;
  const resolved: ResolvedSolanaAccount[] = tx.message.staticAccountKeys.map(
    (key, index) => ({
      address: key.toBase58(),
      isSigner: tx.message.isAccountSigner(index),
      isWritable: tx.message.isAccountWritable(index),
    }),
  );

  const lookupTables = new Map(
    (inputs.addressLookupTableAccounts ?? []).map((account) => [
      account.key.toBase58(),
      account,
    ]),
  );

  for (const lookup of tx.message.addressTableLookups) {
    const table = lookupTables.get(lookup.accountKey.toBase58());
    if (!table) {
      throw new Error("deBridge prefund transaction address lookup table was not resolved.");
    }
    for (const index of lookup.writableIndexes) {
      const address = table.state.addresses[index];
      if (!address) {
        throw new Error("deBridge prefund transaction references missing lookup table account.");
      }
      resolved.push({
        address: address.toBase58(),
        isSigner: false,
        isWritable: true,
      });
    }
    for (const index of lookup.readonlyIndexes) {
      const address = table.state.addresses[index];
      if (!address) {
        throw new Error("deBridge prefund transaction references missing lookup table account.");
      }
      resolved.push({
        address: address.toBase58(),
        isSigner: false,
        isWritable: false,
      });
    }
  }

  return resolved;
}

function getResolvedAccount(
  accounts: ResolvedSolanaAccount[],
  index: number | undefined,
): ResolvedSolanaAccount | null {
  if (index == null) return null;
  return accounts[index] ?? null;
}

async function fetchSolanaAddressLookupTableAccounts(
  tx: VersionedTransaction,
): Promise<AddressLookupTableAccount[]> {
  if (tx.message.addressTableLookups.length === 0) return [];

  const results: AddressLookupTableAccount[] = [];
  for (const lookup of tx.message.addressTableLookups) {
    let lastError: unknown = null;
    for (const rpcUrl of env.solanaRpcUrls) {
      try {
        const connection = new Connection(rpcUrl, "confirmed");
        const response = await connection.getAddressLookupTable(lookup.accountKey);
        if (response.value) {
          results.push(response.value);
          lastError = null;
          break;
        }
        lastError = new Error("Address lookup table was not found.");
      } catch (error) {
        lastError = error;
      }
    }
    if (lastError) {
      throw new Error("Unable to resolve Solana prefund address lookup table.");
    }
  }
  return results;
}

async function fetchDebridgePrefundAddressLookupTables(
  payload: unknown,
): Promise<AddressLookupTableAccount[]> {
  const txData = readDebridgeTxData(payload);
  if (!txData) return [];
  const parsed = parseSerializedSolanaTransactionBase64(txData);
  if (!parsed) return [];
  return fetchSolanaAddressLookupTableAccounts(parsed.transaction);
}

function assertSystemInstructionDoesNotSpendSignerLamports(inputs: {
  tx: VersionedTransaction;
  instruction: VersionedTransaction["message"]["compiledInstructions"][number];
  resolvedAccounts: ResolvedSolanaAccount[];
  signer: string;
}): void {
  const txInstruction = buildResolvedTransactionInstruction(
    inputs.resolvedAccounts,
    inputs.instruction,
  );
  if (!txInstruction) {
    throw new Error("deBridge prefund transaction has malformed System instruction.");
  }

  const feePayer = inputs.tx.message.staticAccountKeys[0]?.toBase58() ?? null;
  const blockedSources = new Set([inputs.signer, feePayer].filter(Boolean));

  try {
    const instructionType =
      SystemInstruction.decodeInstructionType(txInstruction);
    if (instructionType === "Transfer") {
      const decoded = SystemInstruction.decodeTransfer(txInstruction);
      if (blockedSources.has(decoded.fromPubkey.toBase58())) {
        throw new Error("deBridge prefund transaction spends signer SOL.");
      }
      return;
    }
    if (instructionType === "TransferWithSeed") {
      const decoded = SystemInstruction.decodeTransferWithSeed(txInstruction);
      if (blockedSources.has(decoded.fromPubkey.toBase58())) {
        throw new Error("deBridge prefund transaction spends signer SOL.");
      }
      return;
    }
    if (instructionType === "Create") {
      const decoded = SystemInstruction.decodeCreateAccount(txInstruction);
      if (blockedSources.has(decoded.fromPubkey.toBase58())) {
        throw new Error("deBridge prefund transaction creates rent-funded accounts.");
      }
      return;
    }
    if (instructionType === "CreateWithSeed") {
      const decoded = SystemInstruction.decodeCreateWithSeed(txInstruction);
      if (blockedSources.has(decoded.fromPubkey.toBase58())) {
        throw new Error("deBridge prefund transaction creates rent-funded accounts.");
      }
      return;
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("deBridge prefund")) {
      throw error;
    }
    throw new Error("deBridge prefund transaction has unsupported System instruction.");
  }

  throw new Error("deBridge prefund transaction has unsupported System instruction.");
}

function bufferContainsU64LeExactlyOnce(data: Buffer, value: bigint): boolean {
  const needle = Buffer.alloc(8);
  needle.writeBigUInt64LE(value, 0);
  let count = 0;
  for (let index = 8; index <= data.length - needle.length; index += 1) {
    if (data.subarray(index, index + needle.length).equals(needle)) {
      count += 1;
    }
  }
  return count === 1;
}

function validateJupiterDirectUsdcToSolPrefundInstruction(inputs: {
  instruction: VersionedTransaction["message"]["compiledInstructions"][number];
  resolvedAccounts: ResolvedSolanaAccount[];
  signer: string;
  amountInRaw: bigint;
  minOutLamports: bigint;
  envelopeOutLamports: bigint;
  expectedUsdcAta: string;
  expectedWsolAta: string;
}): {
  outputWsolAccount: string;
  quotedOutLamports: bigint;
  minOutLamports: bigint;
  slippageBps: number;
} {
  const data = Buffer.from(inputs.instruction.data);
  const discriminatorHex = data.subarray(0, 8).toString("hex");
  const layout = JUPITER_USDC_TO_SOL_PREFUND_LAYOUTS.get(discriminatorHex);
  if (!layout) {
    throw new Error("deBridge prefund Jupiter instruction is not an allowed route.");
  }

  let decoded:
    | {
        quotedOutLamports: bigint;
        decodedMinOutLamports: bigint;
        slippageBps: number;
      }
    | null = null;
  let sawMatchingAmount = false;
  for (const tailLayout of JUPITER_SHARED_ACCOUNTS_ROUTE_TAIL_LAYOUTS) {
    if (data.length < 8 + tailLayout.tailLength) continue;
    const tailStart = data.length - tailLayout.tailLength;
    const decodedAmountInRaw = data.readBigUInt64LE(
      tailStart + tailLayout.amountInOffsetFromTail,
    );
    if (decodedAmountInRaw !== inputs.amountInRaw) continue;
    sawMatchingAmount = true;

    const platformFeeOffset =
      "platformFeeOffsetFromTail" in tailLayout
        ? tailLayout.platformFeeOffsetFromTail
        : null;
    if (
      platformFeeOffset != null &&
      data[tailStart + platformFeeOffset] !== 0
    ) {
      throw new Error("deBridge prefund Jupiter platform fee is not allowed.");
    }

    const quotedOutLamports = data.readBigUInt64LE(
      tailStart + tailLayout.quotedOutOffsetFromTail,
    );
    const slippageBps =
      tailLayout.slippageBytes === 2
        ? data.readUInt16LE(tailStart + tailLayout.slippageOffsetFromTail)
        : data.readUInt32LE(tailStart + tailLayout.slippageOffsetFromTail);
    if (slippageBps > 10_000) {
      throw new Error("deBridge prefund Jupiter slippage is invalid.");
    }
    const decodedMinOutLamports =
      (quotedOutLamports * BigInt(10_000 - slippageBps)) / 10_000n;
    decoded = { quotedOutLamports, decodedMinOutLamports, slippageBps };
    break;
  }

  if (!decoded) {
    if (
      data.length < MIN_VARIABLE_JUPITER_ROUTE_DATA_LENGTH ||
      !bufferContainsU64LeExactlyOnce(data, inputs.amountInRaw)
    ) {
      throw new Error(
        sawMatchingAmount
          ? "deBridge prefund Jupiter instruction tail is not an allowed route."
          : "deBridge prefund Jupiter instruction amount does not match request.",
      );
    }
    decoded = {
      quotedOutLamports: inputs.envelopeOutLamports,
      decodedMinOutLamports: inputs.envelopeOutLamports,
      slippageBps: 0,
    };
  }
  if (decoded.decodedMinOutLamports < inputs.minOutLamports) {
    throw new Error("deBridge prefund Jupiter minimum output is below the required SOL amount.");
  }

  const account = (position: number): ResolvedSolanaAccount | null => {
    const accountIndex = inputs.instruction.accountKeyIndexes[position];
    return getResolvedAccount(inputs.resolvedAccounts, accountIndex);
  };

  const tokenProgram = account(layout.tokenProgramPosition)?.address ?? null;
  const userTransferAuthority =
    account(layout.transferAuthorityPosition)?.address ?? null;
  const sourceTokenAccount =
    account(layout.sourceTokenAccountPosition)?.address ?? null;
  const destinationTokenAccount =
    account(layout.destinationTokenAccountPosition)?.address ?? null;
  const sourceMint =
    layout.sourceMintPosition == null
      ? null
      : account(layout.sourceMintPosition)?.address ?? null;
  const destinationMint =
    account(layout.destinationMintPosition)?.address ?? null;

  if (tokenProgram !== TOKEN_PROGRAM_ID.toBase58()) {
    throw new Error("deBridge prefund Jupiter route does not use classic SPL Token.");
  }
  if (userTransferAuthority !== inputs.signer) {
    throw new Error("deBridge prefund Jupiter route authority does not match selected wallet.");
  }
  if (sourceTokenAccount !== inputs.expectedUsdcAta) {
    throw new Error("deBridge prefund Jupiter route does not debit the selected wallet USDC account.");
  }
  if (sourceMint && sourceMint !== normalizeSolanaAddress(env.solanaUsdcMint)) {
    throw new Error("deBridge prefund Jupiter route input mint does not match Solana USDC.");
  }
  if (destinationTokenAccount !== inputs.expectedWsolAta) {
    throw new Error("deBridge prefund Jupiter route does not output to the selected wallet WSOL account.");
  }
  if (destinationMint !== SOLANA_WRAPPED_SOL_MINT) {
    throw new Error("deBridge prefund Jupiter route output mint does not match WSOL.");
  }

  return {
    outputWsolAccount: destinationTokenAccount,
    quotedOutLamports: decoded.quotedOutLamports,
    minOutLamports: decoded.decodedMinOutLamports,
    slippageBps: decoded.slippageBps,
  };
}

function validateAssociatedWsolAtaCreateIdempotent(inputs: {
  instruction: VersionedTransaction["message"]["compiledInstructions"][number];
  resolvedAccounts: ResolvedSolanaAccount[];
  signer: string;
  expectedWsolAta: string;
}): string {
  const data = Buffer.from(inputs.instruction.data);
  if (
    data.length !== 1 ||
    data[0] !== ASSOCIATED_TOKEN_CREATE_IDEMPOTENT_INSTRUCTION ||
    inputs.instruction.accountKeyIndexes.length !== 6
  ) {
    throw new Error("deBridge prefund associated token instruction is not allowed.");
  }

  const account = (position: number): ResolvedSolanaAccount | null => {
    const accountIndex = inputs.instruction.accountKeyIndexes[position];
    return getResolvedAccount(inputs.resolvedAccounts, accountIndex);
  };

  const funder = account(0);
  const associatedAccount = account(1);
  const owner = account(2);
  const mint = account(3);
  const systemProgram = account(4);
  const tokenProgram = account(5);

  if (
    funder?.address !== inputs.signer ||
    !funder.isSigner ||
    associatedAccount?.address !== inputs.expectedWsolAta ||
    !associatedAccount.isWritable ||
    owner?.address !== inputs.signer ||
    mint?.address !== SOLANA_WRAPPED_SOL_MINT ||
    systemProgram?.address !== SystemProgram.programId.toBase58() ||
    tokenProgram?.address !== TOKEN_PROGRAM_ID.toBase58()
  ) {
    throw new Error("deBridge prefund associated token instruction does not create the selected wallet WSOL account.");
  }

  return associatedAccount.address;
}

function validateSplTokenCloseAccountToSigner(inputs: {
  instruction: VersionedTransaction["message"]["compiledInstructions"][number];
  resolvedAccounts: ResolvedSolanaAccount[];
  signer: string;
}): string {
  const data = Buffer.from(inputs.instruction.data);
  if (data.length !== 1 || data[0] !== TOKEN_CLOSE_ACCOUNT_INSTRUCTION) {
    throw new Error("deBridge prefund token instruction is not allowed.");
  }

  const closedAccount = getResolvedAccount(
    inputs.resolvedAccounts,
    inputs.instruction.accountKeyIndexes[0],
  )?.address;
  const destination = getResolvedAccount(
    inputs.resolvedAccounts,
    inputs.instruction.accountKeyIndexes[1],
  )?.address;
  const authority = getResolvedAccount(
    inputs.resolvedAccounts,
    inputs.instruction.accountKeyIndexes[2],
  )?.address;

  if (!closedAccount || !destination || !authority) {
    throw new Error("deBridge prefund close account instruction is malformed.");
  }
  if (destination !== inputs.signer || authority !== inputs.signer) {
    throw new Error("deBridge prefund close account does not return SOL to selected wallet.");
  }

  return closedAccount;
}

function validateSolanaPrefundComputeBudgetInstruction(
  instruction: VersionedTransaction["message"]["compiledInstructions"][number],
): void {
  if (instruction.accountKeyIndexes.length > 0) {
    throw new Error("deBridge prefund ComputeBudget instruction cannot reference accounts.");
  }

  const data = Buffer.from(instruction.data);
  if (data.length < 1) {
    throw new Error("deBridge prefund ComputeBudget instruction is malformed.");
  }

  const discriminator = data[0];
  if (discriminator === COMPUTE_BUDGET_SET_COMPUTE_UNIT_LIMIT) {
    if (data.length !== 5) {
      throw new Error("deBridge prefund ComputeBudget limit instruction is malformed.");
    }
    const units = data.readUInt32LE(1);
    if (units > SOLANA_PREFUND_MAX_COMPUTE_UNIT_LIMIT) {
      throw new Error("deBridge prefund compute unit limit exceeds sponsor cap.");
    }
    return;
  }

  if (discriminator === COMPUTE_BUDGET_SET_COMPUTE_UNIT_PRICE) {
    if (data.length !== 9) {
      throw new Error("deBridge prefund ComputeBudget price instruction is malformed.");
    }
    const microLamports = data.readBigUInt64LE(1);
    if (microLamports > SOLANA_PREFUND_MAX_COMPUTE_UNIT_PRICE_MICRO_LAMPORTS) {
      throw new Error("deBridge prefund compute unit price exceeds sponsor cap.");
    }
    return;
  }

  throw new Error("deBridge prefund ComputeBudget instruction is not allowed.");
}

function validateDebridgeSolanaPrefundTransactionShape(inputs: {
  transaction: VersionedTransaction;
  signer: string;
  amountInRaw: bigint;
  minOutLamports: bigint;
  maxOutLamports: bigint;
  envelopeOutLamports: bigint;
  addressLookupTableAccounts?: AddressLookupTableAccount[];
}): {
  quotedOutLamports: bigint;
  decodedMinOutLamports: bigint;
  slippageBps: number;
} {
  const tx = inputs.transaction;
  const resolvedAccounts = resolveTransactionAccounts({
    tx,
    addressLookupTableAccounts: inputs.addressLookupTableAccounts,
  });

  const expectedUsdcAta = getUsdcAssociatedTokenAccount(inputs.signer);
  const expectedWsolAta = getSplAssociatedTokenAccount(
    inputs.signer,
    SOLANA_WRAPPED_SOL_MINT,
  );

  let jupiterOutputWsolAccount: string | null = null;
  let quotedOutLamports: bigint | null = null;
  let decodedMinOutLamports: bigint | null = null;
  let slippageBps: number | null = null;
  let createdWsolAccount: string | null = null;
  let closedWsolAccount: string | null = null;

  for (const instruction of tx.message.compiledInstructions) {
    if (
      instruction.programIdIndex >= resolvedAccounts.length ||
      instruction.accountKeyIndexes.some(
        (accountIndex) => accountIndex >= resolvedAccounts.length,
      )
    ) {
      throw new Error("deBridge prefund transaction references unresolved accounts.");
    }

    const programIdBase58 =
      getResolvedAccount(resolvedAccounts, instruction.programIdIndex)?.address ??
      null;
    if (!programIdBase58) {
      throw new Error("deBridge prefund transaction has malformed instruction program.");
    }

    if (programIdBase58 === COMPUTE_BUDGET_PROGRAM_ID) {
      validateSolanaPrefundComputeBudgetInstruction(instruction);
      continue;
    }

    if (programIdBase58 === TOKEN_2022_PROGRAM_ID) {
      throw new Error("deBridge prefund transaction cannot use Token-2022.");
    }

    if (programIdBase58 === ASSOCIATED_TOKEN_PROGRAM_ID.toBase58()) {
      if (createdWsolAccount) {
        throw new Error("deBridge prefund transaction creates multiple token accounts.");
      }
      createdWsolAccount = validateAssociatedWsolAtaCreateIdempotent({
        instruction,
        resolvedAccounts,
        signer: inputs.signer,
        expectedWsolAta,
      });
      continue;
    }

    if (programIdBase58 === SystemProgram.programId.toBase58()) {
      assertSystemInstructionDoesNotSpendSignerLamports({
        tx,
        instruction,
        resolvedAccounts,
        signer: inputs.signer,
      });
      continue;
    }

    if (programIdBase58 === TOKEN_PROGRAM_ID.toBase58()) {
      if (closedWsolAccount) {
        throw new Error("deBridge prefund transaction has multiple token close instructions.");
      }
      const closedAccount = validateSplTokenCloseAccountToSigner({
        instruction,
        resolvedAccounts,
        signer: inputs.signer,
      });
      if (closedAccount !== expectedWsolAta) {
        throw new Error("deBridge prefund token close does not target the selected wallet WSOL account.");
      }
      closedWsolAccount = closedAccount;
      continue;
    }

    if (programIdBase58 === JUPITER_V6_PROGRAM_ID) {
      if (jupiterOutputWsolAccount) {
        throw new Error("deBridge prefund transaction has multiple Jupiter swap instructions.");
      }
      const decoded = validateJupiterDirectUsdcToSolPrefundInstruction({
          instruction,
          resolvedAccounts,
          signer: inputs.signer,
          amountInRaw: inputs.amountInRaw,
          minOutLamports: inputs.minOutLamports,
          envelopeOutLamports: inputs.envelopeOutLamports,
          expectedUsdcAta,
          expectedWsolAta,
      });
      jupiterOutputWsolAccount = decoded.outputWsolAccount;
      quotedOutLamports = decoded.quotedOutLamports;
      decodedMinOutLamports = decoded.minOutLamports;
      slippageBps = decoded.slippageBps;
      continue;
    }

    throw new Error("deBridge prefund transaction contains an unsupported program instruction.");
  }

  if (!jupiterOutputWsolAccount) {
    throw new Error("deBridge prefund transaction does not contain an allowed Jupiter prefund instruction.");
  }
  if (createdWsolAccount && createdWsolAccount !== jupiterOutputWsolAccount) {
    throw new Error("deBridge prefund transaction creates a different WSOL account than Jupiter outputs to.");
  }
  if (!closedWsolAccount || closedWsolAccount !== jupiterOutputWsolAccount) {
    throw new Error("deBridge prefund transaction does not close WSOL back to selected wallet.");
  }
  if (createdWsolAccount && closedWsolAccount !== createdWsolAccount) {
    throw new Error("deBridge prefund transaction does not close the created WSOL account.");
  }
  if (
    quotedOutLamports == null ||
    decodedMinOutLamports == null ||
    slippageBps == null
  ) {
    throw new Error("deBridge prefund transaction does not include decoded Jupiter output.");
  }
  if (quotedOutLamports > inputs.maxOutLamports) {
    throw new Error("SOL prefund transaction output exceeds the configured top-up cap.");
  }

  return { quotedOutLamports, decodedMinOutLamports, slippageBps };
}

function getAllowedSolanaPrefundInputMints(): Set<string> {
  const configured = env.solanaPrefundAllowedInputMints.length
    ? env.solanaPrefundAllowedInputMints
    : [env.solanaUsdcMint];
  return new Set(configured.map((mint) => mint.trim()).filter(Boolean));
}

function buildDebridgeSolanaPrefundQuery(inputs: {
  walletAddress: string;
  amountInRaw: string;
}) {
  return {
    chainId: SOLANA_CHAIN_ID,
    tokenIn: env.solanaUsdcMint,
    tokenInAmount: inputs.amountInRaw,
    tokenOut: SOLANA_NATIVE_ADDRESS,
    tokenOutRecipient: inputs.walletAddress,
    senderAddress: inputs.walletAddress,
    slippage: DEFAULT_SOLANA_PREFUND_SLIPPAGE,
    onlyDirectRoutes: true,
    useSharedAccounts: false,
    asLegacyTransaction: true,
  };
}

async function getDebridgeDlnBase(): Promise<string> {
  const row = await fetchActiveDebridgeConfig(pool);
  return row?.dln_base?.trim() || env.debridgeDlnBase;
}

async function isKalshiMarketInitialized(
  marketId: string | null | undefined,
): Promise<boolean | null> {
  const id = marketId?.trim();
  if (!id) return null;
  const { rows } = await pool.query<{ is_initialized: boolean | null }>(
    `
      select is_initialized
      from unified_markets
      where venue = 'kalshi'
        and (id = $1 or venue_market_id = $1 or condition_id = $1)
      order by updated_at_db desc nulls last
      limit 1
    `,
    [id],
  );
  return rows[0]?.is_initialized ?? null;
}

async function resolveSolanaPrefundPolicyEnabled(): Promise<boolean> {
  const resolved = await resolveAuthAccessPolicy(pool);
  return resolved.effective.solanaPrefundEnabled;
}

async function getSolanaPrefundReadiness(inputs: {
  walletAddress: string;
  operation: SolanaPrefundOperation;
  marketId?: string | null;
  prefundPolicyEnabled?: boolean;
  log: RouteLogger;
}): Promise<{
  floor: { minSolLamports: bigint; targetSolLamports: bigint };
  solBalanceLamports: bigint;
  usdcAmount: bigint;
  usdcDecimals: number;
  marketInitialized: boolean | null;
  needsPrefund: boolean;
  prefundAvailable: boolean;
  blockingReason:
    | "market_not_initialized"
    | "prefund_disabled"
    | "insufficient_usdc_for_prefund"
    | "prefund_rate_limited"
    | null;
}> {
  const floor = SOLANA_PREFUND_OPERATION_FLOORS[inputs.operation];
  const [
    solBalanceLamports,
    usdc,
    marketInitialized,
    prefundPolicyEnabled,
    rateLimit,
  ] = await Promise.all([
    fetchSolanaBalanceLamports({
      rpcUrls: env.solanaRpcUrls,
      timeoutMs: env.solanaRpcTimeoutMs,
      owner: inputs.walletAddress,
    }),
    fetchSolanaTokenBalanceByOwnerAndMint({
      rpcUrls: env.solanaRpcUrls,
      timeoutMs: env.solanaRpcTimeoutMs,
      owner: inputs.walletAddress,
      mint: env.solanaUsdcMint,
    }),
    inputs.operation === "dflow_buy"
      ? isKalshiMarketInitialized(inputs.marketId)
      : Promise.resolve<boolean | null>(null),
    inputs.prefundPolicyEnabled == null
      ? resolveSolanaPrefundPolicyEnabled()
      : Promise.resolve(inputs.prefundPolicyEnabled),
    getSolanaPrefundRateLimitState({
      signer: inputs.walletAddress,
      log: inputs.log,
    }),
  ]);

  const usdcAmount = usdc?.amount ?? 0n;
  const marketBlocksOperation =
    inputs.operation === "dflow_buy" && marketInitialized !== true;
  const needsPrefund =
    !marketBlocksOperation && solBalanceLamports < floor.minSolLamports;
  const prefundAvailable =
    needsPrefund && prefundPolicyEnabled && usdcAmount > 0n && !rateLimit.limited;
  const blockingReason = marketBlocksOperation
    ? "market_not_initialized"
    : needsPrefund && !prefundPolicyEnabled
      ? "prefund_disabled"
      : needsPrefund && rateLimit.limited
        ? "prefund_rate_limited"
      : needsPrefund && usdcAmount <= 0n
        ? "insufficient_usdc_for_prefund"
        : null;

  return {
    floor,
    solBalanceLamports,
    usdcAmount,
    usdcDecimals: usdc?.decimals ?? 6,
    marketInitialized,
    needsPrefund,
    prefundAvailable,
    blockingReason,
  };
}

function validateDebridgeSolanaPrefundPayload(inputs: {
  payload: unknown;
  signer: string;
  amountInRaw: bigint;
  minOutLamports: bigint;
  maxOutLamports: bigint;
  addressLookupTableAccounts?: AddressLookupTableAccount[];
}): {
  txData: string;
  estimatedOutLamports: bigint;
  decodedMinOutLamports: bigint;
  slippageBps: number;
  transactionDigest: string;
  requiredSigners: string[];
  feePayer: string;
} {
  if (!isRecord(inputs.payload)) {
    throw new Error("deBridge prefund response was not an object.");
  }

  const tokenInAddress = normalizeSolanaAddressOrNull(
    readBridgeTokenAddress(inputs.payload.tokenIn),
  );
  if (tokenInAddress !== normalizeSolanaAddress(env.solanaUsdcMint)) {
    throw new Error("deBridge prefund input token does not match Solana USDC.");
  }

  const tokenInAmount = readBridgeTokenAmountRaw(inputs.payload.tokenIn);
  if (tokenInAmount !== inputs.amountInRaw) {
    throw new Error("deBridge prefund input amount does not match request.");
  }

  const tokenOutAddress = normalizeSolanaAddressOrNull(
    readBridgeTokenAddress(inputs.payload.tokenOut),
  );
  if (tokenOutAddress !== SOLANA_NATIVE_ADDRESS) {
    throw new Error("deBridge prefund output token does not match native SOL.");
  }

  const envelopeOutLamports = readBridgeTokenAmountRaw(inputs.payload.tokenOut);
  if (!envelopeOutLamports || envelopeOutLamports <= 0n) {
    throw new Error("deBridge prefund response did not include a SOL output amount.");
  }
  if (envelopeOutLamports < inputs.minOutLamports) {
    throw new Error("SOL prefund amount is below the required minimum.");
  }
  if (envelopeOutLamports > inputs.maxOutLamports) {
    throw new Error("SOL prefund amount exceeds the configured top-up cap.");
  }

  const upstreamTxData = readDebridgeTxData(inputs.payload);
  if (!upstreamTxData) {
    throw new Error("deBridge prefund response did not include a Solana transaction.");
  }
  const parsed = parseSerializedSolanaTransactionBase64(upstreamTxData);
  if (!parsed) {
    throw new Error("deBridge prefund response did not include a valid serialized Solana transaction.");
  }

  const requiredSigners = getTransactionRequiredSigners(parsed.transaction);
  if (requiredSigners.length !== 1 || requiredSigners[0] !== inputs.signer) {
    throw new Error("deBridge prefund transaction signer does not match selected wallet.");
  }

  const feePayer =
    parsed.transaction.message.staticAccountKeys[0]?.toBase58() ?? null;
  if (feePayer !== inputs.signer) {
    throw new Error("deBridge prefund transaction fee payer does not match selected wallet.");
  }

  const decoded = validateDebridgeSolanaPrefundTransactionShape({
    transaction: parsed.transaction,
    signer: inputs.signer,
    amountInRaw: inputs.amountInRaw,
    minOutLamports: inputs.minOutLamports,
    maxOutLamports: inputs.maxOutLamports,
    envelopeOutLamports,
    addressLookupTableAccounts: inputs.addressLookupTableAccounts,
  });

  return {
    txData: parsed.txData,
    estimatedOutLamports: decoded.quotedOutLamports,
    decodedMinOutLamports: decoded.decodedMinOutLamports,
    slippageBps: decoded.slippageBps,
    transactionDigest: digestSolanaTransactionPayload(parsed.txData),
    requiredSigners,
    feePayer,
  };
}

function readComparedAggregatorNames(payload: unknown): string[] {
  if (!isRecord(payload) || !Array.isArray(payload.comparedAggregators)) {
    return [];
  }
  return payload.comparedAggregators
    .map((value) =>
      isRecord(value) && typeof value.name === "string"
        ? value.name.trim()
        : "",
    )
    .filter((value) => value.length > 0);
}

function summarizeDebridgeSolanaPrefundRouteAttempt(inputs: {
  attempt: number;
  payload: unknown;
  validationError?: unknown;
}): SolanaPrefundRouteAttemptDebug {
  const validationError =
    inputs.validationError instanceof Error
      ? inputs.validationError.message
      : inputs.validationError == null
        ? undefined
        : String(inputs.validationError);
  const base: SolanaPrefundRouteAttemptDebug = {
    attempt: inputs.attempt,
    validationError,
    tokenInAmountRaw: isRecord(inputs.payload)
      ? (readBridgeTokenAmountRaw(inputs.payload.tokenIn)?.toString() ?? null)
      : null,
    tokenOutAmountLamports: isRecord(inputs.payload)
      ? (readBridgeTokenAmountRaw(inputs.payload.tokenOut)?.toString() ?? null)
      : null,
    tokenOutMinAmountLamports:
      isRecord(inputs.payload) && isRecord(inputs.payload.tokenOut)
        ? (readBridgeTokenAmountRaw({
            amount: inputs.payload.tokenOut.minAmount,
          })?.toString() ?? null)
        : null,
    comparedAggregators: readComparedAggregatorNames(inputs.payload),
    feePayer: null,
    requiredSigners: [],
    addressLookupTableCount: 0,
    instructions: [],
  };

  const txData = readDebridgeTxData(inputs.payload);
  if (!txData) return base;
  const parsed = parseSerializedSolanaTransactionBase64(txData);
  if (!parsed) return base;

  const { transaction } = parsed;
  base.feePayer = transaction.message.staticAccountKeys[0]?.toBase58() ?? null;
  base.requiredSigners = getTransactionRequiredSigners(transaction);
  base.addressLookupTableCount = transaction.message.addressTableLookups.length;
  base.instructions = transaction.message.compiledInstructions.map(
    (instruction, index) => {
      const programId =
        transaction.message.staticAccountKeys[
          instruction.programIdIndex
        ]?.toBase58() ?? `lookup:${instruction.programIdIndex}`;
      return {
        index,
        programId,
        dataPrefixHex: Buffer.from(instruction.data).toString("hex").slice(0, 16),
        dataLength: instruction.data.length,
        accountCount: instruction.accountKeyIndexes.length,
      };
    },
  );

  return base;
}

function isRetryableSolanaPrefundRouteError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.message.startsWith("deBridge prefund transaction") ||
    error.message.startsWith("deBridge prefund Jupiter") ||
    error.message.startsWith("deBridge prefund token instruction") ||
    error.message.startsWith("deBridge prefund close account") ||
    error.message.startsWith("deBridge prefund associated token instruction") ||
    error.message.includes("serialized Solana transaction")
  );
}

function getSolanaPrefundRouteDebug(error: unknown):
  | { attempts: SolanaPrefundRouteAttemptDebug[] }
  | undefined {
  return error instanceof SolanaPrefundRouteSelectionError
    ? error.routeDebug
    : undefined;
}

function resolveSolanaPrefundTopUpBounds(inputs: {
  currentSolLamports: bigint;
  minSolLamports: bigint;
  targetSolLamports: bigint;
  maxTopUpLamports: bigint;
}): { minOutLamports: bigint; maxOutLamports: bigint } | null {
  if (inputs.currentSolLamports >= inputs.minSolLamports) return null;

  const minOutLamports = inputs.minSolLamports - inputs.currentSolLamports;
  const maxOutLamports =
    inputs.maxTopUpLamports > 0n
      ? inputs.maxTopUpLamports
      : inputs.targetSolLamports;
  if (maxOutLamports < minOutLamports) {
    throw new Error("Solana prefund maximum is below this operation's minimum.");
  }

  return { minOutLamports, maxOutLamports };
}

export const solanaPrefundRouteTestExports = {
  getMemoryPrefundRateLimitState,
  recordMemoryPrefundAttempt,
  resolveSolanaPrefundTopUpBounds,
  resetMemoryPrefundRateLimits,
  validateDebridgeSolanaPrefundPayload,
};

function buildEmbeddedSolanaPreparedCacheKey(inputs: {
  signer: string;
  executionKey: string;
}): string {
  const digest = createHash("sha256")
    .update(
      `embedded-solana:prepared:${inputs.signer.trim()}:${inputs.executionKey.trim()}`,
    )
    .digest("hex");
  return `embedded-solana:prepared:${digest}`;
}

function buildSolanaPrefundPreparedCacheKey(inputs: {
  signer: string;
  executionKey: string;
}): string {
  const digest = createHash("sha256")
    .update(
      `solana-prefund:prepared:${inputs.signer.trim()}:${inputs.executionKey.trim()}`,
    )
    .digest("hex");
  return `solana-prefund:prepared:${digest}`;
}

function buildSolanaPrefundLimitKey(signer: string): string {
  const digest = createHash("sha256")
    .update(
      `solana-prefund:${SOLANA_PREFUND_RATE_LIMIT_VERSION}:limit:${signer.trim()}`,
    )
    .digest("hex");
  return `solana-prefund:${SOLANA_PREFUND_RATE_LIMIT_VERSION}:limit:${digest}`;
}

function getMemoryPrefundRateLimitState(
  signer: string,
): { limited: boolean; retryAfterSec: number | null } {
  const now = Date.now();
  const limitKey = buildSolanaPrefundLimitKey(signer);
  const limit = solanaPrefundLimitMemory.get(limitKey);
  if (limit && limit.expiresAt > now && limit.count >= SOLANA_PREFUND_DAILY_LIMIT) {
    return {
      limited: true,
      retryAfterSec: Math.ceil((limit.expiresAt - now) / 1000),
    };
  }
  if (limit && limit.expiresAt <= now) solanaPrefundLimitMemory.delete(limitKey);
  return { limited: false, retryAfterSec: null };
}

function recordMemoryPrefundAttempt(signer: string): void {
  const now = Date.now();
  const limitKey = buildSolanaPrefundLimitKey(signer);
  const current = solanaPrefundLimitMemory.get(limitKey);
  solanaPrefundLimitMemory.set(limitKey, {
    count:
      current && current.expiresAt > now
        ? current.count + 1
        : 1,
    expiresAt:
      current && current.expiresAt > now
        ? current.expiresAt
        : now + SOLANA_PREFUND_LIMIT_TTL_SEC * 1000,
  });
}

async function getSolanaPrefundRateLimitState(inputs: {
  signer: string;
  log: RouteLogger;
}): Promise<{ limited: boolean; retryAfterSec: number | null }> {
  const limitKey = buildSolanaPrefundLimitKey(inputs.signer);
  try {
    const redis = await getRedis();
    if (!redis) return getMemoryPrefundRateLimitState(inputs.signer);
    const [countRaw, limitTtl] = await Promise.all([
      redis.get(limitKey),
      redis.ttl(limitKey),
    ]);
    const count = Number(countRaw ?? "0");
    if (
      Number.isFinite(count) &&
      count >= SOLANA_PREFUND_DAILY_LIMIT &&
      limitTtl > 0
    ) {
      return { limited: true, retryAfterSec: limitTtl };
    }
    return { limited: false, retryAfterSec: null };
  } catch (error) {
    inputs.log.warn(
      { error, signer: inputs.signer },
      "Failed to read Solana prefund rate limit",
    );
    return getMemoryPrefundRateLimitState(inputs.signer);
  }
}

async function recordSolanaPrefundAttempt(inputs: {
  signer: string;
  log: RouteLogger;
}): Promise<void> {
  const limitKey = buildSolanaPrefundLimitKey(inputs.signer);
  try {
    const redis = await getRedis();
    if (!redis) {
      recordMemoryPrefundAttempt(inputs.signer);
      return;
    }
    const count = await redis.incr(limitKey);
    if (count === 1) await redis.expire(limitKey, SOLANA_PREFUND_LIMIT_TTL_SEC);
  } catch (error) {
    inputs.log.warn(
      { error, signer: inputs.signer },
      "Failed to record Solana prefund rate limit",
    );
    recordMemoryPrefundAttempt(inputs.signer);
  }
}

function parseEmbeddedSolanaPreparedRequests(
  raw: string | null,
): EmbeddedPrivyAuthorizationRequest[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !Array.isArray((parsed as { requests?: unknown }).requests)
    ) {
      return null;
    }
    return (parsed as { requests: EmbeddedPrivyAuthorizationRequest[] })
      .requests;
  } catch {
    return null;
  }
}

function parseSolanaPrefundPreparedEntry(
  raw: string | null,
): SolanaPrefundPreparedCacheEntry | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || !isRecord(parsed.request)) return null;
    if (
      typeof parsed.userId !== "string" ||
      typeof parsed.signer !== "string" ||
      typeof parsed.operation !== "string" ||
      !isSolanaPrefundOperation(parsed.operation) ||
      typeof parsed.amountInRaw !== "string" ||
      typeof parsed.estimatedOutLamports !== "string" ||
      typeof parsed.decodedMinOutLamports !== "string" ||
      typeof parsed.minOutLamports !== "string" ||
      typeof parsed.maxOutLamports !== "string" ||
      typeof parsed.transactionDigest !== "string"
    ) {
      return null;
    }
    return parsed as SolanaPrefundPreparedCacheEntry;
  } catch {
    return null;
  }
}

async function cacheEmbeddedSolanaPreparedRequests(inputs: {
  signer: string;
  executionKey: string | null | undefined;
  requests: EmbeddedPrivyAuthorizationRequest[];
  log: RouteLogger;
}): Promise<void> {
  const executionKey = inputs.executionKey?.trim() ?? "";
  if (!executionKey) return;

  pruneExpiredEmbeddedSolanaPreparedMemory();

  const key = buildEmbeddedSolanaPreparedCacheKey({
    signer: inputs.signer,
    executionKey,
  });
  embeddedSolanaPreparedMemory.set(key, {
    expiresAt: Date.now() + EMBEDDED_SOLANA_PREPARED_TTL_SEC * 1000,
    requests: inputs.requests,
  });

  try {
    const redis = await getRedis();
    if (!redis) return;
    await redis.set(key, JSON.stringify({ requests: inputs.requests }), {
      EX: EMBEDDED_SOLANA_PREPARED_TTL_SEC,
    });
  } catch (error) {
    inputs.log.warn(
      { error, signer: inputs.signer },
      "Failed to cache prepared embedded Solana requests in Redis",
    );
  }
}

async function cacheSolanaPrefundPreparedRequest(inputs: {
  signer: string;
  executionKey: string;
  entry: SolanaPrefundPreparedCacheEntry;
  log: RouteLogger;
}): Promise<void> {
  pruneExpiredSolanaPrefundPreparedMemory();
  const key = buildSolanaPrefundPreparedCacheKey({
    signer: inputs.signer,
    executionKey: inputs.executionKey,
  });
  solanaPrefundPreparedMemory.set(key, inputs.entry);

  try {
    const redis = await getRedis();
    if (!redis) return;
    await redis.set(key, JSON.stringify(inputs.entry), {
      EX: SOLANA_PREFUND_PREPARED_TTL_SEC,
    });
  } catch (error) {
    inputs.log.warn(
      { error, signer: inputs.signer },
      "Failed to cache prepared Solana prefund request in Redis",
    );
  }
}

async function readCachedEmbeddedSolanaPreparedRequests(inputs: {
  signer: string;
  executionKey: string;
  log: RouteLogger;
}): Promise<EmbeddedPrivyAuthorizationRequest[] | null> {
  const key = buildEmbeddedSolanaPreparedCacheKey({
    signer: inputs.signer,
    executionKey: inputs.executionKey,
  });

  try {
    const redis = await getRedis();
    if (redis) {
      const cached = parseEmbeddedSolanaPreparedRequests(await redis.get(key));
      if (cached) return cached;
    }
  } catch (error) {
    inputs.log.warn(
      { error, signer: inputs.signer },
      "Failed to read prepared embedded Solana requests from Redis",
    );
  }

  const memoryEntry = embeddedSolanaPreparedMemory.get(key);
  if (!memoryEntry) return null;
  if (memoryEntry.expiresAt <= Date.now()) {
    embeddedSolanaPreparedMemory.delete(key);
    return null;
  }
  return memoryEntry.requests;
}

async function deleteCachedEmbeddedSolanaPreparedRequests(inputs: {
  signer: string;
  executionKey: string;
  log: RouteLogger;
}): Promise<void> {
  const key = buildEmbeddedSolanaPreparedCacheKey({
    signer: inputs.signer,
    executionKey: inputs.executionKey,
  });
  embeddedSolanaPreparedMemory.delete(key);
  try {
    const redis = await getRedis();
    if (redis) await redis.del(key);
  } catch (error) {
    inputs.log.warn(
      { error, signer: inputs.signer },
      "Failed to delete prepared embedded Solana requests from Redis",
    );
  }
}

async function readCachedSolanaPrefundPreparedRequest(inputs: {
  signer: string;
  executionKey: string;
  log: RouteLogger;
}): Promise<SolanaPrefundPreparedCacheEntry | null> {
  const key = buildSolanaPrefundPreparedCacheKey({
    signer: inputs.signer,
    executionKey: inputs.executionKey,
  });

  try {
    const redis = await getRedis();
    if (redis) {
      const cached = parseSolanaPrefundPreparedEntry(await redis.get(key));
      if (cached) return cached;
    }
  } catch (error) {
    inputs.log.warn(
      { error, signer: inputs.signer },
      "Failed to read prepared Solana prefund request from Redis",
    );
  }

  const memoryEntry = solanaPrefundPreparedMemory.get(key);
  if (!memoryEntry) return null;
  if (memoryEntry.expiresAt <= Date.now()) {
    solanaPrefundPreparedMemory.delete(key);
    return null;
  }
  return memoryEntry;
}

async function deleteCachedSolanaPrefundPreparedRequest(inputs: {
  signer: string;
  executionKey: string;
  log: RouteLogger;
}): Promise<void> {
  const key = buildSolanaPrefundPreparedCacheKey({
    signer: inputs.signer,
    executionKey: inputs.executionKey,
  });
  solanaPrefundPreparedMemory.delete(key);
  try {
    const redis = await getRedis();
    if (redis) await redis.del(key);
  } catch (error) {
    inputs.log.warn(
      { error, signer: inputs.signer },
      "Failed to delete prepared Solana prefund request from Redis",
    );
  }
}

async function applyEmbeddedSolanaBackendSponsorshipPolicy(inputs: {
  user: NonNullable<FastifyRequest["user"]>;
  signer: string;
  transactions: EmbeddedSolanaTransactionSpec[];
}): Promise<{
  transactions: EmbeddedSolanaTransactionSpec[];
  embeddedSolanaSponsorshipEnabled: boolean;
}> {
  let sponsoredCount = 0;
  const transactions: EmbeddedSolanaTransactionSpec[] = [];
  const authAccessPolicy = await resolveAuthAccessPolicy(pool);
  const lossCloseSponsorshipEnabled =
    authAccessPolicy.effective.solanaLossCloseSponsorshipEnabled === true;

  for (const transaction of inputs.transactions) {
    const lossCloseTokenId = parseKalshiLossCloseTransactionTokenId(
      transaction.id,
    );
    if (!lossCloseTokenId) {
      transactions.push({
        ...transaction,
        sponsor: false,
      });
      continue;
    }

    await validateKalshiLossCloseSponsoredTransaction({
      pool,
      userId: inputs.user.id,
      walletAddress: inputs.signer,
      requestId: transaction.id,
      transaction: transaction.transaction,
      rpcUrls: env.solanaRpcUrls,
      timeoutMs: env.solanaRpcTimeoutMs,
    });

    if (!lossCloseSponsorshipEnabled) {
      transactions.push({
        ...transaction,
        sponsor: false,
      });
      continue;
    }

    sponsoredCount += 1;
    transactions.push({
      ...transaction,
      sponsor: true,
    });
  }

  if (sponsoredCount > 0 && sponsoredCount !== transactions.length) {
    throw new Error(
      "Sponsored Kalshi loss close transactions cannot be mixed with other Solana transactions.",
    );
  }

  return {
    transactions,
    embeddedSolanaSponsorshipEnabled: sponsoredCount > 0,
  };
}

function readEmbeddedSolanaPreparedTransaction(
  request: EmbeddedPrivyAuthorizationRequest,
): string | null {
  const body = isRecord(request.input.body) ? request.input.body : null;
  const params = body && isRecord(body.params) ? body.params : null;
  const transaction = params?.transaction;
  return typeof transaction === "string" && transaction.trim()
    ? transaction.trim()
    : null;
}

function isEmbeddedSolanaPreparedRequestSponsored(
  request: EmbeddedPrivyAuthorizationRequest,
): boolean {
  const body = isRecord(request.input.body) ? request.input.body : null;
  return body?.sponsor === true;
}

async function validateEmbeddedSolanaSponsoredLossCloseAtExecute(inputs: {
  user: NonNullable<FastifyRequest["user"]>;
  signer: string;
  requests: EmbeddedPrivyAuthorizationRequest[];
}): Promise<void> {
  const sponsoredRequests = inputs.requests.filter((request) =>
    isEmbeddedSolanaPreparedRequestSponsored(request),
  );
  if (!sponsoredRequests.length) return;
  const authAccessPolicy = await resolveAuthAccessPolicy(pool);
  if (authAccessPolicy.effective.solanaLossCloseSponsorshipEnabled !== true) {
    throw new Error("Kalshi loss close sponsorship is disabled.");
  }
  if (sponsoredRequests.length !== inputs.requests.length) {
    throw new Error(
      "Sponsored Kalshi loss close transactions cannot be mixed with other Solana transactions.",
    );
  }

  for (const request of sponsoredRequests) {
    const lossCloseTokenId = parseKalshiLossCloseTransactionTokenId(request.id);
    if (!lossCloseTokenId) {
      throw new Error("Only Kalshi loss close transactions can be sponsored.");
    }
    const transaction = readEmbeddedSolanaPreparedTransaction(request);
    if (!transaction) {
      throw new Error("Kalshi loss close transaction is missing serialized transaction data.");
    }
    await validateKalshiLossCloseSponsoredTransaction({
      pool,
      userId: inputs.user.id,
      walletAddress: inputs.signer,
      requestId: request.id,
      transaction,
      rpcUrls: env.solanaRpcUrls,
      timeoutMs: env.solanaRpcTimeoutMs,
    });
  }
}

async function prepareSolanaPrefundRequest(inputs: {
  user: NonNullable<FastifyRequest["user"]>;
  signer: string;
  operation: SolanaPrefundOperation;
  marketId?: string | null;
  amountInRaw: string;
  executionKey: string;
  log: RouteLogger;
}): Promise<{
  request: EmbeddedPrivyAuthorizationRequest;
  providerPayload: unknown;
  estimatedOutLamports: bigint;
  decodedMinOutLamports: bigint;
  minOutLamports: bigint;
  maxOutLamports: bigint;
  transactionDigest: string;
}> {
  const prefundPolicyEnabled = await resolveSolanaPrefundPolicyEnabled();
  if (!prefundPolicyEnabled) {
    throw new Error("Solana prefund is disabled.");
  }

  const allowedInputMints = getAllowedSolanaPrefundInputMints();
  if (!allowedInputMints.has(env.solanaUsdcMint)) {
    throw new Error("Solana prefund is not configured for USDC input.");
  }

  const amountInRaw = parsePositiveBigInt(inputs.amountInRaw);
  if (!amountInRaw) {
    throw new Error("Prefund amount must be greater than zero.");
  }
  if (inputs.operation === "dflow_buy" && !inputs.marketId?.trim()) {
    throw new Error("This Kalshi market needs preparation before trading.");
  }

  const readiness = await getSolanaPrefundReadiness({
    walletAddress: inputs.signer,
    operation: inputs.operation,
    marketId: inputs.marketId,
    prefundPolicyEnabled,
    log: inputs.log,
  });
  if (readiness.blockingReason) {
    throw new Error(
      readiness.blockingReason === "prefund_disabled"
        ? "Solana prefund is disabled."
        : readiness.blockingReason === "prefund_rate_limited"
          ? "SOL prefund is temporarily rate limited. Try again later."
        : readiness.blockingReason === "insufficient_usdc_for_prefund"
          ? "Insufficient Solana USDC for SOL prefund."
          : "Solana prefund is not available for this operation.",
    );
  }
  if (!readiness.needsPrefund) {
    throw new Error("Solana wallet already has enough SOL for this operation.");
  }
  if (readiness.usdcAmount < amountInRaw) {
    throw new Error("Insufficient Solana USDC for SOL prefund.");
  }

  const topUpBounds = resolveSolanaPrefundTopUpBounds({
    currentSolLamports: readiness.solBalanceLamports,
    minSolLamports: readiness.floor.minSolLamports,
    targetSolLamports: readiness.floor.targetSolLamports,
    maxTopUpLamports: env.solanaPrefundMaxTopUpLamports,
  });
  if (!topUpBounds) {
    throw new Error("Solana wallet already has enough SOL for this operation.");
  }

  const baseUrl = await getDebridgeDlnBase();
  let lastRouteError: Error | null = null;
  const routeDebugAttempts: SolanaPrefundRouteAttemptDebug[] = [];

  for (let attempt = 1; attempt <= SOLANA_PREFUND_ROUTE_ATTEMPTS; attempt += 1) {
    const upstream = await debridgeRequest({
      baseUrl,
      timeoutMs: 20_000,
      method: "GET",
      requestPath: "/chain/transaction",
      query: buildDebridgeSolanaPrefundQuery({
        walletAddress: inputs.signer,
        amountInRaw: inputs.amountInRaw,
      }),
    });
    if (!upstream.ok) {
      throw new Error(
        extractDebridgeErrorMessage(upstream.payload) ||
          "deBridge prefund order failed",
      );
    }

    const routeDebug = summarizeDebridgeSolanaPrefundRouteAttempt({
      attempt,
      payload: upstream.payload,
    });

    try {
      const addressLookupTableAccounts =
        await fetchDebridgePrefundAddressLookupTables(upstream.payload);
      const validated = validateDebridgeSolanaPrefundPayload({
        payload: upstream.payload,
        signer: inputs.signer,
        amountInRaw,
        minOutLamports: topUpBounds.minOutLamports,
        maxOutLamports: topUpBounds.maxOutLamports,
        addressLookupTableAccounts,
      });

      const context = await resolveEmbeddedSolanaWalletContext({
        user: inputs.user,
        signer: inputs.signer,
      });
      const request = buildEmbeddedSolanaSignAndSendRequest({
        context,
        executionKey: inputs.executionKey,
        transaction: {
          id: "solana-prefund",
          label: "Add SOL for Solana operations",
          transaction: validated.txData,
          encoding: "base64",
          sponsor: true,
        },
        embeddedSolanaSponsorshipEnabled: true,
      });

      return {
        request,
        providerPayload: upstream.payload,
        estimatedOutLamports: validated.estimatedOutLamports,
        decodedMinOutLamports: validated.decodedMinOutLamports,
        minOutLamports: topUpBounds.minOutLamports,
        maxOutLamports: topUpBounds.maxOutLamports,
        transactionDigest: validated.transactionDigest,
      };
    } catch (error) {
      routeDebug.validationError =
        error instanceof Error ? error.message : String(error);
      routeDebugAttempts.push(routeDebug);
      if (
        isRetryableSolanaPrefundRouteError(error) &&
        attempt < SOLANA_PREFUND_ROUTE_ATTEMPTS
      ) {
        lastRouteError = error instanceof Error ? error : null;
        continue;
      }
      if (isRetryableSolanaPrefundRouteError(error)) {
        throw new SolanaPrefundRouteSelectionError(
          SAFE_SOLANA_PREFUND_ROUTE_ERROR,
          routeDebugAttempts,
        );
      }
      throw error;
    }
  }

  throw lastRouteError
    ? new SolanaPrefundRouteSelectionError(
        SAFE_SOLANA_PREFUND_ROUTE_ERROR,
        routeDebugAttempts,
      )
    : new Error("deBridge prefund order failed");
}

function parsePreparedPrefundLamports(value: string, label: string): bigint {
  if (!/^\d+$/.test(value)) {
    throw new Error(`Prepared Solana prefund ${label} is invalid.`);
  }
  return BigInt(value);
}

function getPreparedSolanaTransactionDigest(
  request: EmbeddedPrivyAuthorizationRequest,
): string | null {
  const body = request.input.body;
  if (!isRecord(body) || !isRecord(body.params)) return null;
  const transaction = body.params.transaction;
  return typeof transaction === "string"
    ? digestSolanaTransactionPayload(transaction)
    : null;
}

async function validateSolanaPrefundPreparedEntryForExecute(inputs: {
  user: NonNullable<FastifyRequest["user"]>;
  signer: string;
  entry: SolanaPrefundPreparedCacheEntry;
  signedRequestIds: string[];
  log: RouteLogger;
}): Promise<void> {
  if (inputs.entry.expiresAt <= Date.now()) {
    throw new Error("Prepared Solana prefund expired. Refresh and try again.");
  }
  if (inputs.entry.userId !== inputs.user.id) {
    throw new Error("Prepared Solana prefund does not match the authenticated user.");
  }
  if (inputs.entry.signer !== inputs.signer) {
    throw new Error("Prepared Solana prefund does not match the selected wallet.");
  }
  if (!inputs.signedRequestIds.includes(inputs.entry.request.id)) {
    throw new Error("Solana prefund signature does not match the prepared request.");
  }
  const requestDigest = getPreparedSolanaTransactionDigest(inputs.entry.request);
  if (!requestDigest || requestDigest !== inputs.entry.transactionDigest) {
    throw new Error("Prepared Solana prefund transaction digest changed.");
  }

  const estimatedOutLamports = parsePreparedPrefundLamports(
    inputs.entry.estimatedOutLamports,
    "output",
  );
  const decodedMinOutLamports = parsePreparedPrefundLamports(
    inputs.entry.decodedMinOutLamports,
    "minimum output",
  );

  const prefundPolicyEnabled = await resolveSolanaPrefundPolicyEnabled();
  if (!prefundPolicyEnabled) {
    throw new Error("Solana prefund is disabled.");
  }
  const readiness = await getSolanaPrefundReadiness({
    walletAddress: inputs.signer,
    operation: inputs.entry.operation,
    marketId: inputs.entry.marketId,
    prefundPolicyEnabled,
    log: inputs.log,
  });
  if (readiness.blockingReason) {
    throw new Error(
      readiness.blockingReason === "prefund_disabled"
        ? "Solana prefund is disabled."
        : readiness.blockingReason === "prefund_rate_limited"
          ? "SOL prefund is temporarily rate limited. Try again later."
          : readiness.blockingReason === "insufficient_usdc_for_prefund"
            ? "Insufficient Solana USDC for SOL prefund."
            : "Solana prefund is not available for this operation.",
    );
  }
  if (!readiness.needsPrefund) {
    throw new Error("Solana wallet already has enough SOL for this operation.");
  }
  if (
    readiness.usdcAmount <
    parsePreparedPrefundLamports(inputs.entry.amountInRaw, "input")
  ) {
    throw new Error("Insufficient Solana USDC for SOL prefund.");
  }
  if (
    readiness.solBalanceLamports + decodedMinOutLamports <
    readiness.floor.minSolLamports
  ) {
    throw new Error("Prepared Solana prefund no longer reaches the required SOL minimum.");
  }

  const topUpBounds = resolveSolanaPrefundTopUpBounds({
    currentSolLamports: readiness.solBalanceLamports,
    minSolLamports: readiness.floor.minSolLamports,
    targetSolLamports: readiness.floor.targetSolLamports,
    maxTopUpLamports: env.solanaPrefundMaxTopUpLamports,
  });
  if (!topUpBounds) {
    throw new Error("Solana wallet already has enough SOL for this operation.");
  }
  if (decodedMinOutLamports < topUpBounds.minOutLamports) {
    throw new Error("Prepared Solana prefund no longer reaches the required SOL minimum.");
  }
  if (estimatedOutLamports > topUpBounds.maxOutLamports) {
    throw new Error("Prepared Solana prefund amount exceeds the required top-up.");
  }
}

export const embeddedWalletRoutes: FastifyPluginAsync = async (app) => {
  const z = app.withTypeProvider<ZodTypeProvider>();

  z.post(
    "/wallets/solana/readiness",
    {
      preHandler: createAuthMiddleware(),
      schema: {
        body: solanaReadinessBodySchema,
        response: {
          200: solanaReadinessResponseSchema,
          400: solanaPrefundErrorResponseSchema,
          401: solanaPrefundErrorResponseSchema,
          502: solanaPrefundErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const user = request.user;
      const signerRaw = request.walletAddress;
      if (!user || !signerRaw) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      try {
        const requestedWallet = request.body.walletAddress?.trim() || signerRaw;
        if (!isSolanaAddress(requestedWallet) || !isSolanaAddress(signerRaw)) {
          reply.code(400);
          return reply.send({
            error: "Solana readiness requires a Solana wallet address",
          });
        }
        const signer = normalizeSolanaAddress(signerRaw);
        const walletAddress = normalizeSolanaAddress(requestedWallet);
        if (walletAddress !== signer) {
          reply.code(400);
          return reply.send({
            error: "walletAddress must match the selected wallet",
          });
        }

        const operation = request.body.operation;
        const readiness = await getSolanaPrefundReadiness({
          walletAddress,
          operation,
          marketId: request.body.marketId,
          log: app.log,
        });

        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({
          ok: true,
          walletAddress,
          operation,
          solBalanceLamports: readiness.solBalanceLamports.toString(),
          solBalance: formatUiAmount(readiness.solBalanceLamports, SOL_DECIMALS),
          usdcBalanceRaw: readiness.usdcAmount.toString(),
          usdcBalance: formatUiAmount(
            readiness.usdcAmount,
            readiness.usdcDecimals,
          ),
          minSolLamports: readiness.floor.minSolLamports.toString(),
          targetSolLamports: readiness.floor.targetSolLamports.toString(),
          maxTopUpLamports: env.solanaPrefundMaxTopUpLamports.toString(),
          needsPrefund: readiness.needsPrefund,
          prefundAvailable: readiness.prefundAvailable,
          blockingReason: readiness.blockingReason,
        });
      } catch (error) {
        app.log.error(
          { error, userId: user.id, signer: signerRaw },
          "Failed to compute Solana readiness",
        );
        reply.code(502);
        return reply.send({
          error: "Failed to compute Solana readiness",
        });
      }
    },
  );

  z.post(
    "/wallets/solana/prefund/prepare",
    {
      preHandler: createAuthMiddleware(),
      schema: {
        body: solanaPrefundPrepareBodySchema,
        response: {
          200: solanaPrefundPrepareResponseSchema,
          400: solanaPrefundErrorResponseSchema,
          401: solanaPrefundErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const user = request.user;
      const signerRaw = request.walletAddress;
      if (!user || !signerRaw) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      try {
        const requestedWallet = request.body.walletAddress?.trim() || signerRaw;
        if (!isSolanaAddress(requestedWallet) || !isSolanaAddress(signerRaw)) {
          reply.code(400);
          return reply.send({
            error: "Solana prefund requires a Solana wallet address",
          });
        }
        const signer = normalizeSolanaAddress(signerRaw);
        const walletAddress = normalizeSolanaAddress(requestedWallet);
        if (walletAddress !== signer) {
          reply.code(400);
          return reply.send({
            error: "walletAddress must match the selected wallet",
          });
        }

        const executionKey = `solana-prefund:${randomUUID()}`;
        const prepared = await prepareSolanaPrefundRequest({
          user,
          signer,
          operation: request.body.operation,
          marketId: request.body.marketId,
          amountInRaw: request.body.amountInRaw,
          executionKey,
          log: app.log,
        });
        const entry: SolanaPrefundPreparedCacheEntry = {
          expiresAt: Date.now() + SOLANA_PREFUND_PREPARED_TTL_SEC * 1000,
          createdAt: Date.now(),
          userId: user.id,
          signer,
          operation: request.body.operation,
          marketId: request.body.marketId ?? null,
          amountInRaw: request.body.amountInRaw,
          estimatedOutLamports: prepared.estimatedOutLamports.toString(),
          decodedMinOutLamports: prepared.decodedMinOutLamports.toString(),
          minOutLamports: prepared.minOutLamports.toString(),
          maxOutLamports: prepared.maxOutLamports.toString(),
          transactionDigest: prepared.transactionDigest,
          request: prepared.request,
          providerPayload: prepared.providerPayload,
        };
        await cacheSolanaPrefundPreparedRequest({
          signer,
          executionKey,
          entry,
          log: app.log,
        });

        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({
          ok: true,
          signer,
          executionKey,
          operation: request.body.operation,
          amountInRaw: request.body.amountInRaw,
          estimatedOutLamports: prepared.estimatedOutLamports.toString(),
          transactionDigest: prepared.transactionDigest,
          quote: prepared.providerPayload,
          requests: [prepared.request],
        });
      } catch (error) {
        const debug = getSolanaPrefundRouteDebug(error);
        app.log.error(
          { error, debug, userId: user.id, signer: signerRaw },
          "Failed to prepare Solana prefund",
        );
        reply.code(400);
        return reply.send({
          error:
            error instanceof Error
              ? error.message
              : "Failed to prepare Solana prefund",
        });
      }
    },
  );

  z.post(
    "/wallets/solana/prefund/execute",
    {
      preHandler: createAuthMiddleware(),
      schema: {
        body: solanaPrefundExecuteBodySchema,
        response: {
          200: solanaPrefundExecuteResponseSchema,
          400: solanaPrefundErrorResponseSchema,
          401: solanaPrefundErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const user = request.user;
      const signerRaw = request.walletAddress;
      if (!user || !signerRaw) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      try {
        const requestedWallet = request.body.walletAddress?.trim() || signerRaw;
        if (!isSolanaAddress(requestedWallet) || !isSolanaAddress(signerRaw)) {
          reply.code(400);
          return reply.send({
            error: "Solana prefund requires a Solana wallet address",
          });
        }
        const signer = normalizeSolanaAddress(signerRaw);
        const walletAddress = normalizeSolanaAddress(requestedWallet);
        if (walletAddress !== signer) {
          reply.code(400);
          return reply.send({
            error: "walletAddress must match the selected wallet",
          });
        }

        const result = await runEmbeddedExecutionSingleFlight({
          key: buildEmbeddedExecutionSingleFlightKey(
            "solana-prefund",
            "solana",
            signer,
            SOLANA_CHAIN_ID,
            request.body.executionKey,
          ),
          run: async () => {
            const entry = await readCachedSolanaPrefundPreparedRequest({
              signer,
              executionKey: request.body.executionKey,
              log: app.log,
            });
            if (!entry) {
              throw new Error(
                "Prepared Solana prefund expired. Refresh and try again.",
              );
            }
            await validateSolanaPrefundPreparedEntryForExecute({
              user,
              signer,
              entry,
              signedRequestIds: request.body.signedRequests.map(
                (signedRequest) => signedRequest.id,
              ),
              log: app.log,
            });
            await recordSolanaPrefundAttempt({
              signer,
              log: app.log,
            });
            const signatures = await executeEmbeddedSolanaTransactionRequests({
              requests: [entry.request],
              signatures: request.body.signedRequests,
            });
            if (!signatures[0]?.trim()) {
              throw new Error("Solana prefund did not return a transaction hash.");
            }
            await deleteCachedSolanaPrefundPreparedRequest({
              signer,
              executionKey: request.body.executionKey,
              log: app.log,
            });
            return {
              ok: true,
              signer,
              operation: entry.operation,
              amountInRaw: entry.amountInRaw,
              estimatedOutLamports: entry.estimatedOutLamports,
              signatures,
            };
          },
        });

        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send(result);
      } catch (error) {
        app.log.error(
          {
            error,
            userId: user.id,
            executionKey: request.body.executionKey,
            signer: signerRaw,
          },
          "Failed to execute Solana prefund",
        );
        reply.code(400);
        return reply.send({
          error:
            error instanceof Error
              ? error.message
              : "Failed to execute Solana prefund",
        });
      }
    },
  );

  z.post(
    "/wallets/embedded/ethereum/prepare",
    {
      preHandler: createAuthMiddleware(),
      schema: { body: embeddedEvmPrepareBodySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      try {
        const context = await resolveEmbeddedEthereumWalletContext({
          user,
          signer,
        });
        const requests = prepareEmbeddedEthereumTransactionRequests({
          context,
          chainId: request.body.chainId,
          transactions: request.body.transactions,
        });
        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({
          ok: true,
          signer: context.signer,
          chainId: request.body.chainId,
          requests,
        });
      } catch (error) {
        app.log.error(
          {
            error,
            userId: user.id,
            signer: normalizeEvmAddress(signer),
          },
          "Failed to prepare embedded EVM transactions",
        );
        reply.code(400);
        return reply.send({
          error:
            error instanceof Error
              ? error.message
              : "Failed to prepare embedded EVM transactions",
        });
      }
    },
  );

  z.post(
    "/wallets/embedded/ethereum/execute",
    {
      preHandler: createAuthMiddleware(),
      schema: { body: embeddedEvmExecuteBodySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      try {
        const context = await resolveEmbeddedEthereumWalletContext({
          user,
          signer,
        });
        const result = await runEmbeddedExecutionSingleFlight({
          key: buildEmbeddedExecutionSingleFlightKey(
            "embedded-wallets",
            "ethereum",
            context.signer,
            request.body.chainId,
            request.body.executionKey,
          ),
          run: async () => {
            const requests = prepareEmbeddedEthereumTransactionRequests({
              context,
              chainId: request.body.chainId,
              transactions: request.body.transactions,
            });
            const transactionHashes =
              await executeEmbeddedEthereumTransactionRequests({
                chainId: request.body.chainId,
                requests,
                signatures: request.body.signedRequests,
              });
            return {
              ok: true,
              signer: context.signer,
              chainId: request.body.chainId,
              transactionHashes,
            };
          },
        });
        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send(result);
      } catch (error) {
        app.log.error(
          {
            error,
            userId: user.id,
            signer: normalizeEvmAddress(signer),
          },
          "Failed to execute embedded EVM transactions",
        );
        reply.code(400);
        return reply.send({
          error:
            error instanceof Error
              ? error.message
              : "Failed to execute embedded EVM transactions",
        });
      }
    },
  );

  z.post(
    "/wallets/embedded/solana/prepare",
    {
      preHandler: createAuthMiddleware(),
      schema: { body: embeddedSolanaPrepareBodySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      try {
        const context = await resolveEmbeddedSolanaWalletContext({
          user,
          signer,
        });
        const executionKey = request.body.executionKey ?? null;
        const sponsorshipPolicy =
          await applyEmbeddedSolanaBackendSponsorshipPolicy({
            user,
            signer: context.signer,
            transactions: request.body.transactions,
          });
        const requests = await prepareEmbeddedSolanaTransactionRequests({
          context,
          executionKey,
          transactions: sponsorshipPolicy.transactions,
          embeddedSolanaSponsorshipEnabled:
            sponsorshipPolicy.embeddedSolanaSponsorshipEnabled,
          onSponsorBalanceFetchError: (error) => {
            app.log.warn(
              { error, userId: user.id, signer: context.signer },
              "Embedded Solana balance fetch failed",
            );
          },
        });
        await cacheEmbeddedSolanaPreparedRequests({
          signer: context.signer,
          executionKey,
          requests,
          log: app.log,
        });
        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({
          ok: true,
          signer: context.signer,
          requests,
        });
      } catch (error) {
        app.log.error(
          {
            error,
            userId: user.id,
            signer,
          },
          "Failed to prepare embedded Solana transactions",
        );
        reply.code(400);
        return reply.send({
          error:
            error instanceof Error
              ? error.message
              : "Failed to prepare embedded Solana transactions",
        });
      }
    },
  );

  z.post(
    "/wallets/embedded/solana/execute",
    {
      preHandler: createAuthMiddleware(),
      schema: { body: embeddedSolanaExecuteBodySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      try {
        const context = await resolveEmbeddedSolanaWalletContext({
          user,
          signer,
        });
        const result = await runEmbeddedExecutionSingleFlight({
          key: buildEmbeddedExecutionSingleFlightKey(
            "embedded-wallets",
            "solana",
            context.signer,
            request.body.executionKey,
          ),
          run: async () => {
            const requests = await readCachedEmbeddedSolanaPreparedRequests({
              signer: context.signer,
              executionKey: request.body.executionKey,
              log: app.log,
            });
            if (!requests) {
              throw new Error(
                "Prepared Solana authorization expired. Refresh quote and try again.",
              );
            }
            await validateEmbeddedSolanaSponsoredLossCloseAtExecute({
              user,
              signer: context.signer,
              requests,
            });
            const signatures = await executeEmbeddedSolanaTransactionRequests({
              requests,
              signatures: request.body.signedRequests,
            });
            await deleteCachedEmbeddedSolanaPreparedRequests({
              signer: context.signer,
              executionKey: request.body.executionKey,
              log: app.log,
            });
            return {
              ok: true,
              signer: context.signer,
              signatures,
            };
          },
        });
        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send(result);
      } catch (error) {
        app.log.error(
          {
            error,
            userId: user.id,
            executionKey: request.body.executionKey,
            signer,
          },
          "Failed to execute embedded Solana transactions",
        );
        reply.code(400);
        return reply.send({
          error:
            error instanceof Error
              ? error.message
              : "Failed to execute embedded Solana transactions",
        });
      }
    },
  );
};
