import crypto from "node:crypto";

import {
  type AddressLookupTableAccount,
  Connection,
  PublicKey,
  type SimulatedTransactionAccountInfo,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  AccountLayout,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

import { isRecord } from "../lib/type-guards.js";
import { fetchSolanaTokenAccountInfo } from "./solana-rpc.js";

type ResolvedSolanaAccount = {
  address: string;
  isSigner: boolean;
  isWritable: boolean;
};

type TokenAccountInfo = {
  mint: string;
  owner: string;
  closeAuthority: string | null;
  programId: string;
} | null;

export const DEFAULT_SOLANA_USDC_MINT =
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

export const KALSHI_DFLOW_MAX_SOL_DEBIT_LAMPORTS = 30_000_000n;
const DEFAULT_SOLANA_RPC_TIMEOUT_MS = 10_000;

export type KalshiDflowTransactionFacts = {
  amountInRaw: string;
  amountOutRaw: string | null;
  feePayer: string;
  inputMint: string;
  minOutRaw: string | null;
  outputMint: string;
  requiredSigners: string[];
  transactionDigest: string;
};

export type KalshiDflowTransactionContext = {
  amountInRaw: string;
  amountOutRaw?: string | null;
  inputMint: string;
  minOutRaw?: string | null;
  outputMint: string;
};

export type KalshiDflowTransactionSimulation = {
  inputTokenSpendRaw: bigint;
  outputTokenReceiveRaw: bigint;
  solDebitLamports: bigint;
};

export type KalshiDflowTransactionSimulationLoaderInput = {
  inputMint: string;
  inputTokenAccount: string;
  outputMint: string;
  outputTokenAccount: string;
  rpcTimeoutMs?: number;
  rpcUrls: readonly string[];
  transaction: VersionedTransaction;
  walletAddress: string;
};

export class KalshiDflowTransactionValidationError extends Error {
  code = "kalshi_transaction_invalid" as const;
}

function validationError(
  message: string,
): KalshiDflowTransactionValidationError {
  return new KalshiDflowTransactionValidationError(message);
}

function normalizeSolanaAddress(
  value: string | null | undefined,
): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  try {
    return new PublicKey(trimmed).toBase58();
  } catch {
    return null;
  }
}

function decodeSerializedSolanaTransaction(payload: string): Buffer | null {
  const trimmed = payload.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("0x")) {
    const hex = trimmed.slice(2);
    if (!hex.length || hex.length % 2 !== 0) return null;
    return Buffer.from(hex, "hex");
  }
  try {
    return Buffer.from(trimmed, "base64");
  } catch {
    return null;
  }
}

function deserializeTransaction(payload: string): {
  raw: Buffer;
  transaction: VersionedTransaction;
} | null {
  const raw = decodeSerializedSolanaTransaction(payload);
  if (!raw) return null;
  try {
    return { raw, transaction: VersionedTransaction.deserialize(raw) };
  } catch {
    return null;
  }
}

function parsePositiveRawAmount(value: unknown): bigint | null {
  if (typeof value === "bigint") return value > 0n ? value : null;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0 || !Number.isSafeInteger(value)) {
      return null;
    }
    return BigInt(value);
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^[0-9]+$/.test(trimmed)) return null;
  const parsed = BigInt(trimmed);
  return parsed > 0n ? parsed : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function findStringDeep(
  value: unknown,
  keys: readonly string[],
  depth = 0,
): string | null {
  if (depth > 8 || !isRecord(value)) return null;
  for (const key of keys) {
    const found = readString(value[key]);
    if (found) return found;
  }
  for (const nested of Object.values(value)) {
    if (Array.isArray(nested)) {
      for (const entry of nested) {
        const found = findStringDeep(entry, keys, depth + 1);
        if (found) return found;
      }
      continue;
    }
    const found = findStringDeep(nested, keys, depth + 1);
    if (found) return found;
  }
  return null;
}

export function deriveKalshiDflowTransactionContext(input: {
  amountInRaw?: unknown;
  amountOutRaw?: unknown;
  inputMint?: unknown;
  minOutRaw?: unknown;
  outputMint?: unknown;
  quoteResponse?: unknown;
}): KalshiDflowTransactionContext | null {
  const inputMint =
    readString(input.inputMint) ??
    findStringDeep(input.quoteResponse, ["inputMint", "input_mint", "inMint"]);
  const outputMint =
    readString(input.outputMint) ??
    findStringDeep(input.quoteResponse, [
      "outputMint",
      "output_mint",
      "outMint",
    ]);
  const amountInRaw =
    readString(input.amountInRaw) ??
    findStringDeep(input.quoteResponse, [
      "inAmount",
      "inputAmount",
      "amount",
      "amountIn",
      "amount_in",
    ]);
  const amountOutRaw =
    readString(input.amountOutRaw) ??
    findStringDeep(input.quoteResponse, [
      "outAmount",
      "outputAmount",
      "amountOut",
      "amount_out",
    ]);
  const minOutRaw =
    readString(input.minOutRaw) ??
    findStringDeep(input.quoteResponse, [
      "minOutAmount",
      "minOutputAmount",
      "otherAmountThreshold",
      "minAmountOut",
      "min_out",
    ]);

  if (!inputMint || !outputMint || !amountInRaw) return null;
  const amountIn = parsePositiveRawAmount(amountInRaw);
  const minReceive = parsePositiveRawAmount(minOutRaw ?? amountOutRaw);
  if (!amountIn || !minReceive) return null;
  return {
    amountInRaw: amountIn.toString(),
    amountOutRaw: parsePositiveRawAmount(amountOutRaw)?.toString() ?? null,
    inputMint,
    minOutRaw: parsePositiveRawAmount(minOutRaw)?.toString() ?? null,
    outputMint,
  };
}

async function fetchAddressLookupTableAccounts(input: {
  rpcTimeoutMs: number;
  rpcUrls: readonly string[];
  tx: VersionedTransaction;
}): Promise<AddressLookupTableAccount[]> {
  if (input.tx.message.addressTableLookups.length === 0) return [];
  const out: AddressLookupTableAccount[] = [];
  for (const lookup of input.tx.message.addressTableLookups) {
    let resolved: AddressLookupTableAccount | null = null;
    let lastError: unknown = null;
    for (const rpcUrl of input.rpcUrls) {
      try {
        const response = await createTimedSolanaConnection(
          rpcUrl,
          input.rpcTimeoutMs,
        ).getAddressLookupTable(lookup.accountKey);
        if (response.value) {
          resolved = response.value;
          break;
        }
        lastError = new Error("Address lookup table was not found.");
      } catch (error) {
        lastError = error;
      }
    }
    if (!resolved) {
      throw validationError(
        lastError instanceof Error
          ? lastError.message
          : "Unable to resolve Solana address lookup table.",
      );
    }
    out.push(resolved);
  }
  return out;
}

function resolveTransactionAccounts(input: {
  addressLookupTableAccounts: readonly AddressLookupTableAccount[];
  tx: VersionedTransaction;
}): ResolvedSolanaAccount[] {
  const { tx } = input;
  const resolved: ResolvedSolanaAccount[] = tx.message.staticAccountKeys.map(
    (key, index) => ({
      address: key.toBase58(),
      isSigner: tx.message.isAccountSigner(index),
      isWritable: tx.message.isAccountWritable(index),
    }),
  );
  const lookupTables = new Map(
    input.addressLookupTableAccounts.map((account) => [
      account.key.toBase58(),
      account,
    ]),
  );
  for (const lookup of tx.message.addressTableLookups) {
    const table = lookupTables.get(lookup.accountKey.toBase58());
    if (!table) {
      throw validationError(
        "Transaction address lookup table was not resolved.",
      );
    }
    for (const index of lookup.writableIndexes) {
      const address = table.state.addresses[index];
      if (!address) {
        throw validationError(
          "Transaction references a missing lookup account.",
        );
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
        throw validationError(
          "Transaction references a missing lookup account.",
        );
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

function associatedTokenAddress(owner: string, mint: string): string {
  return getAssociatedTokenAddressSync(
    new PublicKey(mint),
    new PublicKey(owner),
    false,
    TOKEN_PROGRAM_ID,
  ).toBase58();
}

function createTimedSolanaConnection(
  rpcUrl: string,
  timeoutMs: number,
): Connection {
  return new Connection(rpcUrl, {
    commitment: "confirmed",
    fetch: async (url, init) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        return await fetch(url, { ...init, signal: controller.signal });
      } finally {
        clearTimeout(timeout);
      }
    },
  });
}

function isMissingSolanaTokenAccountError(error: unknown): boolean {
  const message = (
    error instanceof Error ? error.message : String(error)
  ).toLowerCase();
  return message.includes("could not find account");
}

async function fetchTokenBalanceRaw(input: {
  account: string;
  connection: Connection;
  missingAccountAsZero: boolean;
}): Promise<bigint> {
  try {
    const response = await input.connection.getTokenAccountBalance(
      new PublicKey(input.account),
      "confirmed",
    );
    return parsePositiveRawAmount(response.value.amount) ?? 0n;
  } catch (error) {
    if (
      input.missingAccountAsZero &&
      isMissingSolanaTokenAccountError(error)
    ) {
      return 0n;
    }
    throw error;
  }
}

export const kalshiDflowTransactionSafetyTestHooks = {
  fetchTokenBalanceRaw,
};

function parseSimulatedTokenAmount(input: {
  account: SimulatedTransactionAccountInfo | null | undefined;
  expectedMint: string;
  expectedOwner: string;
}): bigint {
  const encoded = input.account?.data?.[0];
  if (!encoded) {
    throw validationError("Simulated token account state was not returned.");
  }
  try {
    const decoded = AccountLayout.decode(Buffer.from(encoded, "base64"));
    if (
      decoded.mint.toBase58() !== input.expectedMint ||
      decoded.owner.toBase58() !== input.expectedOwner
    ) {
      throw validationError(
        "Simulated token account does not match expected wallet and mint.",
      );
    }
    return decoded.amount;
  } catch (error) {
    if (error instanceof KalshiDflowTransactionValidationError) throw error;
    throw validationError("Simulated token account state could not be parsed.");
  }
}

async function simulateKalshiDflowTransactionWithConnection(input: {
  connection: Connection;
  inputMint: string;
  inputTokenAccount: string;
  outputMint: string;
  outputTokenAccount: string;
  transaction: VersionedTransaction;
  walletAddress: string;
}): Promise<KalshiDflowTransactionSimulation> {
  const walletPublicKey = new PublicKey(input.walletAddress);
  const walletLamportsBefore = BigInt(
    await input.connection.getBalance(walletPublicKey, "confirmed"),
  );
  const inputTokenBalanceBefore = await fetchTokenBalanceRaw({
    account: input.inputTokenAccount,
    connection: input.connection,
    missingAccountAsZero: false,
  });
  const outputTokenBalanceBefore = await fetchTokenBalanceRaw({
    account: input.outputTokenAccount,
    connection: input.connection,
    missingAccountAsZero: true,
  });

  const addresses = [
    input.walletAddress,
    input.inputTokenAccount,
    input.outputTokenAccount,
  ];
  const response = await input.connection.simulateTransaction(
    input.transaction,
    {
      accounts: { addresses, encoding: "base64" },
      commitment: "confirmed",
      replaceRecentBlockhash: true,
      sigVerify: false,
    },
  );
  if (response.value.err) {
    throw validationError("Kalshi transaction simulation failed.");
  }
  const accounts = response.value.accounts;
  const walletAccount = accounts?.[0];
  const postWalletLamports =
    walletAccount?.lamports == null ? null : BigInt(walletAccount.lamports);
  if (postWalletLamports == null) {
    throw validationError("Simulated wallet account state was not returned.");
  }
  const inputTokenBalanceAfter = parseSimulatedTokenAmount({
    account: accounts?.[1],
    expectedMint: input.inputMint,
    expectedOwner: input.walletAddress,
  });
  const outputTokenBalanceAfter = parseSimulatedTokenAmount({
    account: accounts?.[2],
    expectedMint: input.outputMint,
    expectedOwner: input.walletAddress,
  });

  return {
    inputTokenSpendRaw:
      inputTokenBalanceBefore > inputTokenBalanceAfter
        ? inputTokenBalanceBefore - inputTokenBalanceAfter
        : 0n,
    outputTokenReceiveRaw:
      outputTokenBalanceAfter > outputTokenBalanceBefore
        ? outputTokenBalanceAfter - outputTokenBalanceBefore
        : 0n,
    solDebitLamports:
      walletLamportsBefore > postWalletLamports
        ? walletLamportsBefore - postWalletLamports
        : 0n,
  };
}

async function loadKalshiDflowTransactionSimulation(
  input: KalshiDflowTransactionSimulationLoaderInput,
): Promise<KalshiDflowTransactionSimulation> {
  if (input.rpcUrls.length === 0) {
    throw validationError("Solana RPC is required to validate transaction.");
  }
  let lastError: unknown = null;
  for (const rpcUrl of input.rpcUrls) {
    try {
      return await simulateKalshiDflowTransactionWithConnection({
        connection: createTimedSolanaConnection(
          rpcUrl,
          input.rpcTimeoutMs ?? DEFAULT_SOLANA_RPC_TIMEOUT_MS,
        ),
        inputMint: input.inputMint,
        inputTokenAccount: input.inputTokenAccount,
        outputMint: input.outputMint,
        outputTokenAccount: input.outputTokenAccount,
        transaction: input.transaction,
        walletAddress: input.walletAddress,
      });
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError instanceof KalshiDflowTransactionValidationError) {
    throw lastError;
  }
  throw validationError("Unable to simulate Kalshi transaction.");
}

export async function validateKalshiDflowTransaction(input: {
  amountInRaw: string | bigint;
  amountOutRaw?: string | bigint | null;
  expectedInputMint?: string | null;
  inputMint: string;
  minOutRaw?: string | bigint | null;
  outputMint: string;
  rpcTimeoutMs?: number;
  rpcUrls?: readonly string[];
  transactionSimulationLoader?:
    | ((
        input: KalshiDflowTransactionSimulationLoaderInput,
      ) => Promise<KalshiDflowTransactionSimulation>)
    | null;
  tokenAccountInfoLoader?:
    | ((account: string) => Promise<TokenAccountInfo>)
    | null;
  transaction: string;
  walletAddress: string;
}): Promise<KalshiDflowTransactionFacts> {
  const walletAddress = normalizeSolanaAddress(input.walletAddress);
  const inputMint = normalizeSolanaAddress(input.inputMint);
  const outputMint = normalizeSolanaAddress(input.outputMint);
  const amountInRaw = parsePositiveRawAmount(input.amountInRaw);
  const amountOutRaw = parsePositiveRawAmount(input.amountOutRaw ?? null);
  const minOutRaw = parsePositiveRawAmount(input.minOutRaw ?? null);
  const minReceiveRaw = minOutRaw ?? amountOutRaw;
  if (!walletAddress || !inputMint || !outputMint) {
    throw validationError(
      "Kalshi transaction context contains invalid addresses.",
    );
  }
  const expectedInputMint = normalizeSolanaAddress(
    input.expectedInputMint ?? DEFAULT_SOLANA_USDC_MINT,
  );
  if (!expectedInputMint || inputMint !== expectedInputMint) {
    throw validationError("Kalshi transaction input mint must be Solana USDC.");
  }
  if (!amountInRaw || !minReceiveRaw) {
    throw validationError("Kalshi transaction context is missing raw amounts.");
  }

  const parsed = deserializeTransaction(input.transaction);
  if (!parsed)
    throw validationError("Kalshi transaction could not be decoded.");
  const transactionDigest = crypto
    .createHash("sha256")
    .update(parsed.raw)
    .digest("hex");
  const tx = parsed.transaction;
  const requiredSigners = tx.message.staticAccountKeys
    .slice(0, tx.message.header.numRequiredSignatures)
    .map((key) => key.toBase58());
  if (requiredSigners.length !== 1 || requiredSigners[0] !== walletAddress) {
    throw validationError("Kalshi transaction signer does not match wallet.");
  }
  const feePayer = tx.message.staticAccountKeys[0]?.toBase58() ?? null;
  if (feePayer !== walletAddress) {
    throw validationError(
      "Kalshi transaction fee payer does not match wallet.",
    );
  }

  const rpcUrls = input.rpcUrls ?? [];
  const lookupAccounts = await fetchAddressLookupTableAccounts({
    rpcTimeoutMs: input.rpcTimeoutMs ?? DEFAULT_SOLANA_RPC_TIMEOUT_MS,
    rpcUrls,
    tx,
  });
  const accounts = resolveTransactionAccounts({
    addressLookupTableAccounts: lookupAccounts,
    tx,
  });
  const addresses = new Set(accounts.map((account) => account.address));
  const inputTokenAccount = associatedTokenAddress(walletAddress, inputMint);
  const outputTokenAccount = associatedTokenAddress(walletAddress, outputMint);
  if (!addresses.has(inputTokenAccount) || !addresses.has(outputTokenAccount)) {
    throw validationError(
      "Kalshi transaction does not reference expected token accounts.",
    );
  }
  if (!addresses.has(inputMint) || !addresses.has(outputMint)) {
    throw validationError(
      "Kalshi transaction does not reference expected mints.",
    );
  }

  const expectedWalletTokenAccounts = new Set([
    inputTokenAccount,
    outputTokenAccount,
  ]);
  const loadTokenAccount =
    input.tokenAccountInfoLoader ??
    ((account: string) =>
      fetchSolanaTokenAccountInfo({
        account,
        rpcUrls: [...rpcUrls],
        timeoutMs: input.rpcTimeoutMs ?? DEFAULT_SOLANA_RPC_TIMEOUT_MS,
      }));
  const writableAccounts = accounts
    .filter((account) => account.isWritable)
    .map((account) => account.address);
  for (const account of writableAccounts) {
    if (expectedWalletTokenAccounts.has(account)) continue;
    let tokenInfo: TokenAccountInfo;
    try {
      tokenInfo = await loadTokenAccount(account);
    } catch {
      throw validationError(
        "Unable to validate writable Solana token account.",
      );
    }
    if (tokenInfo?.owner === walletAddress) {
      throw validationError(
        "Kalshi transaction writes an unexpected wallet-owned token account.",
      );
    }
  }

  const loadSimulation =
    input.transactionSimulationLoader ?? loadKalshiDflowTransactionSimulation;
  let simulation: KalshiDflowTransactionSimulation;
  try {
    simulation = await loadSimulation({
      inputMint,
      inputTokenAccount,
      outputMint,
      outputTokenAccount,
      rpcTimeoutMs: input.rpcTimeoutMs,
      rpcUrls,
      transaction: tx,
      walletAddress,
    });
  } catch (error) {
    if (error instanceof KalshiDflowTransactionValidationError) throw error;
    throw validationError("Unable to validate simulated transaction effects.");
  }
  if (simulation.inputTokenSpendRaw !== amountInRaw) {
    throw validationError("Kalshi transaction input amount does not match.");
  }
  if (simulation.outputTokenReceiveRaw < minReceiveRaw) {
    throw validationError("Kalshi transaction output amount is too low.");
  }
  if (simulation.solDebitLamports > KALSHI_DFLOW_MAX_SOL_DEBIT_LAMPORTS) {
    throw validationError("Kalshi transaction SOL debit is too high.");
  }

  return {
    amountInRaw: amountInRaw.toString(),
    amountOutRaw: amountOutRaw?.toString() ?? null,
    feePayer,
    inputMint,
    minOutRaw: minOutRaw?.toString() ?? null,
    outputMint,
    requiredSigners,
    transactionDigest,
  };
}
