import { isAbortError, isRpcRateLimit, sleep } from "@hunch/shared";

import { isRecord } from "../lib/type-guards.js";
import {
  captureRpcDiagnosticSource,
  recordRpcAttempt,
  recordRpcDedupHit,
  recordRpcLogicalCall,
  rpcDiagnosticOutcomeFromError,
  type RpcDiagnosticOutcome,
} from "./rpc-diagnostics.js";
import { rpcReadCoordinator } from "./rpc-read-coordinator.js";
import { walletIntelRetryConfig } from "./wallet-intel-retry.js";

type JsonRpcError = {
  code?: number;
  message?: string;
  data?: unknown;
};

type JsonRpcResponse<T> =
  | { jsonrpc: "2.0"; id: number; result: T }
  | { jsonrpc: "2.0"; id: number; error: JsonRpcError };

function isSolanaMintNotFound(error: unknown): boolean {
  if (!error) return false;
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("could not find mint") ||
    message.includes("Invalid param: could not find mint") ||
    message.includes("Invalid param")
  );
}

export function formatUiAmount(amount: bigint, decimals: number): string {
  if (decimals <= 0) return amount.toString();

  const negative = amount < 0n;
  const abs = negative ? -amount : amount;
  const raw = abs.toString().padStart(decimals + 1, "0");
  const whole = raw.slice(0, -decimals);
  const fractionRaw = raw.slice(-decimals).replace(/0+$/, "");
  const ui = fractionRaw.length ? `${whole}.${fractionRaw}` : whole;
  return negative ? `-${ui}` : ui;
}

type ParsedTokenAccount = {
  pubkey: string;
  mint: string;
  owner: string | null;
  amount: bigint;
  decimals: number;
};

function parseTokenAccount(entry: unknown): ParsedTokenAccount | null {
  if (!isRecord(entry)) return null;
  const pubkey = entry.pubkey;
  if (typeof pubkey !== "string" || pubkey.trim().length === 0) return null;
  const account = entry.account;
  if (!isRecord(account)) return null;
  const data = account.data;
  if (!isRecord(data)) return null;
  const parsed = data.parsed;
  if (!isRecord(parsed)) return null;
  const info = parsed.info;
  if (!isRecord(info)) return null;

  const mint = info.mint;
  if (typeof mint !== "string" || mint.trim().length === 0) return null;
  const owner = info.owner;
  const ownerValue =
    typeof owner === "string" && owner.trim().length > 0 ? owner : null;

  const tokenAmount = info.tokenAmount;
  if (!isRecord(tokenAmount)) return null;

  const amountRaw = tokenAmount.amount;
  if (typeof amountRaw !== "string" || amountRaw.trim().length === 0)
    return null;

  let amount: bigint;
  try {
    amount = BigInt(amountRaw);
  } catch {
    return null;
  }

  const decimalsRaw = tokenAmount.decimals;
  if (typeof decimalsRaw !== "number" || !Number.isFinite(decimalsRaw))
    return null;
  const decimals = Math.max(0, Math.trunc(decimalsRaw));

  return { pubkey, mint, owner: ownerValue, amount, decimals };
}

const SOLANA_FINALIZED_SLOT_CACHE_TTL_MS = 1_000;
const SOLANA_SINGLE_FLIGHT_READ_METHODS = new Set([
  "getAccountInfo",
  "getBalance",
  "getBlock",
  "getLatestBlockhash",
  "getMultipleAccounts",
  "getSignatureStatuses",
  "getSignaturesForAddress",
  "getSlot",
  "getTokenAccountBalance",
  "getTokenAccountsByOwner",
  "getTokenLargestAccounts",
  "getTokenSupply",
  "getTransaction",
]);

async function executeSolanaRpcRequest<T>(inputs: {
  rpcUrls: string[];
  timeoutMs: number;
  maxAttempts?: number;
  totalTimeoutMs?: number;
  method: string;
  params: unknown[];
  source: string;
}): Promise<T> {
  let lastError: unknown = null;
  const maxAttempts = Math.max(
    1,
    inputs.maxAttempts ?? walletIntelRetryConfig.maxAttempts,
  );
  const requestDeadline =
    inputs.totalTimeoutMs === undefined
      ? null
      : performance.now() + Math.max(1, inputs.totalTimeoutMs);

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    for (const [rpcIndex, rpcUrl] of inputs.rpcUrls.entries()) {
      const remainingTotalTimeoutMs =
        requestDeadline === null
          ? null
          : Math.ceil(requestDeadline - performance.now());
      if (remainingTotalTimeoutMs !== null && remainingTotalTimeoutMs <= 0) {
        throw lastError ?? new Error("Solana RPC request deadline exceeded");
      }
      const attemptTimeoutMs =
        remainingTotalTimeoutMs === null
          ? inputs.timeoutMs
          : Math.min(
              inputs.timeoutMs,
              Math.max(
                1,
                Math.floor(
                  remainingTotalTimeoutMs /
                    Math.max(1, inputs.rpcUrls.length - rpcIndex),
                ),
              ),
            );
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), attemptTimeoutMs);
      const startedAt = performance.now();
      let attemptRecorded = false;
      const recordAttempt = (outcome: RpcDiagnosticOutcome) => {
        if (attemptRecorded) return;
        attemptRecorded = true;
        recordRpcAttempt({
          protocol: "solana",
          rpcUrl,
          method: inputs.method,
          source: inputs.source,
          outcome,
          durationMs: performance.now() - startedAt,
        });
      };
      try {
        const response = await fetch(rpcUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: inputs.method,
            params: inputs.params,
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          const error = new Error(
            `Solana RPC error: ${response.status} ${response.statusText}`,
          );
          lastError = error;
          recordAttempt(response.status === 429 ? "http_429" : "http_error");
          if (response.status === 429 && inputs.rpcUrls.length > 1) {
            continue;
          }
          throw error;
        }

        const json = (await response.json()) as unknown;
        if (!isRecord(json)) {
          recordAttempt("rpc_error");
          throw new Error("Solana RPC: invalid JSON response");
        }

        const rpc = json as JsonRpcResponse<T>;
        if ("error" in rpc) {
          const message =
            typeof rpc.error.message === "string"
              ? rpc.error.message
              : "Unknown Solana RPC error";
          const error = new Error(
            `Solana RPC ${inputs.method} error: ${message}`,
          );
          lastError = error;
          recordAttempt(isRpcRateLimit(error) ? "rpc_429" : "rpc_error");
          if (/too many requests/i.test(message) && inputs.rpcUrls.length > 1) {
            continue;
          }
          throw error;
        }

        recordAttempt("ok");
        return rpc.result;
      } catch (error) {
        lastError = error;
        recordAttempt(rpcDiagnosticOutcomeFromError(error));
        const retryable = isRpcRateLimit(error) || isAbortError(error);
        if (inputs.rpcUrls.length > 1) {
          // A transport failure, non-2xx response, malformed payload, or
          // provider-specific JSON-RPC error does not prove the canonical
          // request itself is invalid. Try the next independently configured
          // endpoint before failing the read.
          continue;
        }
        if (retryable) {
          break;
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    }

    const retryable = isRpcRateLimit(lastError) || isAbortError(lastError);
    if (
      retryable &&
      attempt < maxAttempts - 1 &&
      (requestDeadline === null || performance.now() < requestDeadline)
    ) {
      const backoffMs = Math.min(
        walletIntelRetryConfig.baseBackoffMs * Math.max(1, 2 ** attempt),
        walletIntelRetryConfig.maxBackoffMs,
        requestDeadline === null
          ? walletIntelRetryConfig.maxBackoffMs
          : Math.max(0, requestDeadline - performance.now()),
      );
      await sleep(backoffMs);
      continue;
    }
    break;
  }

  throw lastError ?? new Error("Solana RPC request failed");
}

async function solanaRpcRequest<T>(inputs: {
  rpcUrls: string[];
  timeoutMs: number;
  maxAttempts?: number;
  totalTimeoutMs?: number;
  method: string;
  params: unknown[];
}): Promise<T> {
  const source = captureRpcDiagnosticSource();
  const rpcUrl = inputs.rpcUrls[0] ?? "";
  recordRpcLogicalCall({
    protocol: "solana",
    rpcUrl,
    method: inputs.method,
    source,
  });
  if (!SOLANA_SINGLE_FLIGHT_READ_METHODS.has(inputs.method)) {
    return executeSolanaRpcRequest<T>({
      rpcUrls: inputs.rpcUrls,
      timeoutMs: inputs.timeoutMs,
      maxAttempts: inputs.maxAttempts,
      totalTimeoutMs: inputs.totalTimeoutMs,
      method: inputs.method,
      params: inputs.params,
      source,
    });
  }
  const key = JSON.stringify([
    inputs.rpcUrls,
    inputs.timeoutMs,
    inputs.maxAttempts ?? null,
    inputs.totalTimeoutMs ?? null,
    inputs.method,
    inputs.params,
  ]);
  return rpcReadCoordinator.singleFlight(
    `solana:request:${key}`,
    () => executeSolanaRpcRequest<T>({ ...inputs, source }),
    () =>
      recordRpcDedupHit({
        protocol: "solana",
        rpcUrl,
        method: inputs.method,
        source,
      }),
  );
}

export const SOLANA_SPL_TOKEN_PROGRAM_ID =
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const SOLANA_TOKEN_2022_PROGRAM_ID =
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

export type SolanaRawAccountInfo = Readonly<{
  owner: string;
  data: Buffer;
  space: number;
  slot: bigint;
}>;

/**
 * Reads a finalized raw Solana account through the shared RPC path, retaining
 * its timeout, failover, diagnostics, and request single-flight behavior.
 */
export async function fetchSolanaRawAccountInfo(inputs: {
  rpcUrls: readonly string[];
  timeoutMs: number;
  address: string;
}): Promise<SolanaRawAccountInfo | null> {
  const result = await solanaRpcRequest<unknown>({
    rpcUrls: [...inputs.rpcUrls],
    timeoutMs: inputs.timeoutMs,
    method: "getAccountInfo",
    params: [inputs.address, { commitment: "finalized", encoding: "base64" }],
  });
  if (!isRecord(result)) {
    throw new Error("Solana RPC: invalid raw account response");
  }
  const context = result.context;
  const value = result.value;
  if (value === null) return null;
  if (!isRecord(context) || !isRecord(value)) {
    throw new Error("Solana RPC: invalid raw account fields");
  }
  const slot = context.slot;
  const owner = value.owner;
  const space = value.space;
  const data = value.data;
  if (
    typeof slot !== "number" ||
    !Number.isSafeInteger(slot) ||
    slot < 0 ||
    typeof owner !== "string" ||
    owner.length === 0 ||
    typeof space !== "number" ||
    !Number.isSafeInteger(space) ||
    space < 0 ||
    !Array.isArray(data) ||
    data.length !== 2 ||
    typeof data[0] !== "string" ||
    data[1] !== "base64"
  ) {
    throw new Error("Solana RPC: invalid raw account value");
  }
  const decoded = Buffer.from(data[0], "base64");
  if (decoded.byteLength !== space) {
    throw new Error("Solana RPC: raw account size mismatch");
  }
  return { owner, data: decoded, space, slot: BigInt(slot) };
}

export type SolanaAddressSignature = Readonly<{
  signature: string;
  slot: bigint;
  blockTime: number | null;
  failed: boolean;
}>;

export async function fetchSolanaFinalizedSlot(inputs: {
  rpcUrls: string[];
  timeoutMs: number;
  bypassCache?: boolean;
}): Promise<bigint> {
  return rpcReadCoordinator.memo(
    `solana:finalized-slot:${JSON.stringify(inputs.rpcUrls)}`,
    {
      ttlMs: SOLANA_FINALIZED_SLOT_CACHE_TTL_MS,
      bypass: inputs.bypassCache,
    },
    async () => {
      const result = await solanaRpcRequest<number>({
        rpcUrls: inputs.rpcUrls,
        timeoutMs: inputs.timeoutMs,
        method: "getSlot",
        params: [{ commitment: "finalized" }],
      });
      if (
        typeof result !== "number" ||
        !Number.isSafeInteger(result) ||
        result < 0
      ) {
        throw new Error("Solana RPC: invalid finalized slot");
      }
      return BigInt(result);
    },
  );
}

export async function fetchSolanaAddressSignatures(inputs: {
  rpcUrls: string[];
  timeoutMs: number;
  address: string;
  before?: string | null;
  until?: string | null;
  limit?: number;
}): Promise<readonly SolanaAddressSignature[]> {
  const limit = Math.max(1, Math.min(1_000, Math.trunc(inputs.limit ?? 1_000)));
  const config: Record<string, unknown> = {
    commitment: "finalized",
    limit,
  };
  if (inputs.before) config.before = inputs.before;
  if (inputs.until) config.until = inputs.until;
  const result = await solanaRpcRequest<unknown[]>({
    rpcUrls: inputs.rpcUrls,
    timeoutMs: inputs.timeoutMs,
    method: "getSignaturesForAddress",
    params: [inputs.address, config],
  });
  if (!Array.isArray(result)) {
    throw new Error("Solana RPC: invalid address signatures response");
  }
  return result.map((entry) => {
    if (!isRecord(entry)) {
      throw new Error("Solana RPC: invalid address signature");
    }
    const signature = entry.signature;
    const slot = entry.slot;
    const blockTime = entry.blockTime;
    if (
      typeof signature !== "string" ||
      signature.trim().length === 0 ||
      typeof slot !== "number" ||
      !Number.isSafeInteger(slot) ||
      slot < 0 ||
      (blockTime !== null &&
        blockTime !== undefined &&
        (typeof blockTime !== "number" || !Number.isFinite(blockTime)))
    ) {
      throw new Error("Solana RPC: invalid address signature");
    }
    return {
      signature,
      slot: BigInt(slot),
      blockTime: typeof blockTime === "number" ? Math.trunc(blockTime) : null,
      failed: entry.err != null,
    };
  });
}

export async function fetchSolanaParsedTransaction(inputs: {
  rpcUrls: string[];
  timeoutMs: number;
  signature: string;
}): Promise<unknown | null> {
  return solanaRpcRequest<unknown | null>({
    rpcUrls: inputs.rpcUrls,
    timeoutMs: inputs.timeoutMs,
    method: "getTransaction",
    params: [
      inputs.signature,
      {
        encoding: "jsonParsed",
        commitment: "finalized",
        maxSupportedTransactionVersion: 0,
      },
    ],
  });
}

export type SolanaSignatureReceiptStatus = Readonly<{
  confirmationStatus: "processed" | "confirmed" | "finalized";
  failed: boolean;
}>;

export type SolanaReceiptTransaction = Readonly<{
  slot: number;
  failed: boolean;
  numRequiredSignatures: number;
  accountKeys: readonly string[];
  instructions: readonly Readonly<{
    programIdIndex: number;
    accountIndexes: readonly number[];
    data: string;
  }>[];
  addressLookupTables: readonly string[];
}>;

export async function fetchSolanaSignatureReceiptStatus(inputs: {
  rpcUrls: string[];
  signature: string;
  timeoutMs: number;
  maxAttempts?: number;
  totalTimeoutMs?: number;
}): Promise<SolanaSignatureReceiptStatus | null> {
  const result = await solanaRpcRequest<{
    value?: Array<{
      confirmationStatus?: string | null;
      err?: unknown;
    } | null>;
  }>({
    rpcUrls: inputs.rpcUrls,
    timeoutMs: inputs.timeoutMs,
    maxAttempts: inputs.maxAttempts,
    totalTimeoutMs: inputs.totalTimeoutMs,
    method: "getSignatureStatuses",
    params: [[inputs.signature], { searchTransactionHistory: true }],
  });
  const entry = Array.isArray(result.value) ? result.value[0] : null;
  if (!entry) return null;
  const confirmationStatus = entry.confirmationStatus ?? "processed";
  if (
    confirmationStatus !== "processed" &&
    confirmationStatus !== "confirmed" &&
    confirmationStatus !== "finalized"
  ) {
    throw new Error("Solana RPC signature confirmation status is invalid");
  }
  return { confirmationStatus, failed: entry.err != null };
}

function parseSolanaReceiptIndex(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Solana RPC ${field} is invalid`);
  }
  return value;
}

export async function fetchSolanaReceiptTransaction(inputs: {
  rpcUrls: string[];
  signature: string;
  timeoutMs: number;
  maxAttempts?: number;
  totalTimeoutMs?: number;
  commitment: "confirmed" | "finalized";
}): Promise<SolanaReceiptTransaction | null> {
  const result = await solanaRpcRequest<unknown | null>({
    rpcUrls: inputs.rpcUrls,
    timeoutMs: inputs.timeoutMs,
    maxAttempts: inputs.maxAttempts,
    totalTimeoutMs: inputs.totalTimeoutMs,
    method: "getTransaction",
    params: [
      inputs.signature,
      {
        encoding: "json",
        commitment: inputs.commitment,
        maxSupportedTransactionVersion: 0,
      },
    ],
  });
  if (result == null) return null;
  if (!isRecord(result)) {
    throw new Error("Solana RPC receipt transaction is invalid");
  }
  const slot = parseSolanaReceiptIndex(result.slot, "transaction slot");
  const transaction = result.transaction;
  const meta = result.meta;
  if (!isRecord(transaction) || !isRecord(meta)) {
    throw new Error("Solana RPC receipt transaction fields are invalid");
  }
  const message = transaction.message;
  if (!isRecord(message)) {
    throw new Error("Solana RPC receipt transaction message is invalid");
  }
  const header = message.header;
  const staticAccountKeys = message.accountKeys;
  const instructions = message.instructions;
  if (
    !isRecord(header) ||
    !Array.isArray(staticAccountKeys) ||
    staticAccountKeys.some((key) => typeof key !== "string") ||
    !Array.isArray(instructions)
  ) {
    throw new Error(
      "Solana RPC receipt transaction message fields are invalid",
    );
  }
  const numRequiredSignatures = parseSolanaReceiptIndex(
    header.numRequiredSignatures,
    "required signature count",
  );
  const loadedAddresses = isRecord(meta.loadedAddresses)
    ? meta.loadedAddresses
    : null;
  const writable = loadedAddresses?.writable;
  const readonly = loadedAddresses?.readonly;
  if (
    (writable !== undefined &&
      (!Array.isArray(writable) ||
        writable.some((key) => typeof key !== "string"))) ||
    (readonly !== undefined &&
      (!Array.isArray(readonly) ||
        readonly.some((key) => typeof key !== "string")))
  ) {
    throw new Error("Solana RPC loaded addresses are invalid");
  }
  const accountKeys = [
    ...(staticAccountKeys as string[]),
    ...((writable as string[] | undefined) ?? []),
    ...((readonly as string[] | undefined) ?? []),
  ];
  const parsedInstructions = instructions.map((instruction) => {
    if (!isRecord(instruction)) {
      throw new Error("Solana RPC compiled instruction is invalid");
    }
    const programIdIndex = parseSolanaReceiptIndex(
      instruction.programIdIndex,
      "instruction program index",
    );
    const accounts = instruction.accounts;
    const data = instruction.data;
    if (
      !Array.isArray(accounts) ||
      typeof data !== "string" ||
      accounts.some(
        (account) =>
          typeof account !== "number" ||
          !Number.isSafeInteger(account) ||
          account < 0,
      )
    ) {
      throw new Error("Solana RPC compiled instruction fields are invalid");
    }
    return {
      programIdIndex,
      accountIndexes: accounts as number[],
      data,
    };
  });
  const addressTableLookups = message.addressTableLookups;
  if (
    addressTableLookups !== undefined &&
    (!Array.isArray(addressTableLookups) ||
      addressTableLookups.some(
        (lookup) => !isRecord(lookup) || typeof lookup.accountKey !== "string",
      ))
  ) {
    throw new Error("Solana RPC address table lookups are invalid");
  }
  return {
    slot,
    failed: meta.err != null,
    numRequiredSignatures,
    accountKeys,
    instructions: parsedInstructions,
    addressLookupTables:
      (addressTableLookups as Array<{ accountKey: string }> | undefined)?.map(
        (lookup) => lookup.accountKey,
      ) ?? [],
  };
}

export async function fetchSolanaBlockhash(inputs: {
  rpcUrls: string[];
  timeoutMs: number;
  slot: bigint;
}): Promise<string | null> {
  if (inputs.slot < 0n || inputs.slot > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Solana RPC: slot is outside the safe integer range");
  }
  const result = await solanaRpcRequest<unknown | null>({
    rpcUrls: inputs.rpcUrls,
    timeoutMs: inputs.timeoutMs,
    method: "getBlock",
    params: [
      Number(inputs.slot),
      {
        commitment: "finalized",
        transactionDetails: "none",
        rewards: false,
        maxSupportedTransactionVersion: 0,
      },
    ],
  });
  if (result == null) return null;
  if (!isRecord(result)) {
    throw new Error("Solana RPC: invalid block response");
  }
  const blockhash = result.blockhash;
  return typeof blockhash === "string" && blockhash.trim().length > 0
    ? blockhash
    : null;
}

export type SolanaTokenBalance = {
  mint: string;
  amount: string;
  decimals: number;
  uiAmountString: string;
};

export async function fetchSolanaBalanceLamports(inputs: {
  rpcUrls: string[];
  owner: string;
  timeoutMs: number;
}): Promise<bigint> {
  const result = await solanaRpcRequest<{ value: number }>({
    rpcUrls: inputs.rpcUrls,
    timeoutMs: inputs.timeoutMs,
    method: "getBalance",
    params: [inputs.owner],
  });

  const value = result?.value;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("Solana RPC: invalid getBalance response");
  }
  return BigInt(Math.trunc(value));
}

export async function fetchSolanaTokenBalanceByOwnerAndMint(inputs: {
  rpcUrls: string[];
  owner: string;
  mint: string;
  timeoutMs: number;
}): Promise<{
  amount: bigint;
  decimals: number;
  uiAmountString: string;
} | null> {
  const result = await solanaRpcRequest<{ value: unknown[] }>({
    rpcUrls: inputs.rpcUrls,
    timeoutMs: inputs.timeoutMs,
    method: "getTokenAccountsByOwner",
    params: [
      inputs.owner,
      { mint: inputs.mint },
      {
        encoding: "jsonParsed",
      },
    ],
  });

  const entries = Array.isArray(result.value) ? result.value : [];
  let total = 0n;
  let decimals: number | null = null;

  for (const entry of entries) {
    const parsed = parseTokenAccount(entry);
    if (!parsed) continue;
    if (parsed.amount <= 0n) continue;
    total += parsed.amount;
    decimals = parsed.decimals;
  }

  if (decimals == null) return null;

  return {
    amount: total,
    decimals,
    uiAmountString: formatUiAmount(total, decimals),
  };
}

export async function fetchSolanaLatestBlockhash(inputs: {
  rpcUrls: string[];
  timeoutMs: number;
}): Promise<{ blockhash: string; lastValidBlockHeight: number } | null> {
  const result = await solanaRpcRequest<{
    value?: { blockhash?: string; lastValidBlockHeight?: number } | null;
  }>({
    rpcUrls: inputs.rpcUrls,
    timeoutMs: inputs.timeoutMs,
    method: "getLatestBlockhash",
    params: [],
  });

  const value = result?.value ?? null;
  if (!value) return null;
  if (typeof value.blockhash !== "string") return null;
  if (typeof value.lastValidBlockHeight !== "number") return null;

  return {
    blockhash: value.blockhash,
    lastValidBlockHeight: Math.trunc(value.lastValidBlockHeight),
  };
}

export async function fetchSolanaMintDecimals(inputs: {
  rpcUrls: string[];
  mint: string;
  timeoutMs: number;
}): Promise<number> {
  const result = await solanaRpcRequest<{ value?: { decimals?: number } }>({
    rpcUrls: inputs.rpcUrls,
    timeoutMs: inputs.timeoutMs,
    method: "getTokenSupply",
    params: [inputs.mint],
  });

  const decimalsRaw = result?.value?.decimals;
  if (typeof decimalsRaw !== "number" || !Number.isFinite(decimalsRaw)) {
    throw new Error("Solana RPC: invalid getTokenSupply response");
  }

  return Math.max(0, Math.trunc(decimalsRaw));
}

export async function sendSolanaRawTransaction(inputs: {
  rpcUrls: string[];
  timeoutMs: number;
  signedTransaction: string;
  skipPreflight?: boolean;
  maxRetries?: number;
}): Promise<string> {
  const params: Record<string, unknown> = { encoding: "base64" };
  if (inputs.skipPreflight !== undefined) {
    params.skipPreflight = inputs.skipPreflight;
  }
  if (inputs.maxRetries !== undefined) {
    params.maxRetries = inputs.maxRetries;
  }

  const result = await solanaRpcRequest<string>({
    rpcUrls: inputs.rpcUrls,
    timeoutMs: inputs.timeoutMs,
    method: "sendTransaction",
    params: [inputs.signedTransaction, params],
  });

  if (typeof result !== "string" || result.trim().length === 0) {
    throw new Error("Solana RPC: invalid sendTransaction response");
  }
  return result;
}

export async function fetchSolanaTokenBalancesByOwner(inputs: {
  rpcUrls: string[];
  owner: string;
  timeoutMs: number;
  includeToken2022?: boolean;
}): Promise<SolanaTokenBalance[]> {
  const programIds: string[] = [SOLANA_SPL_TOKEN_PROGRAM_ID];
  if (inputs.includeToken2022) programIds.push(SOLANA_TOKEN_2022_PROGRAM_ID);

  const balancesByMint = new Map<
    string,
    { amount: bigint; decimals: number }
  >();

  for (const programId of programIds) {
    const result = await solanaRpcRequest<{ value: unknown[] }>({
      rpcUrls: inputs.rpcUrls,
      timeoutMs: inputs.timeoutMs,
      method: "getTokenAccountsByOwner",
      params: [
        inputs.owner,
        { programId },
        {
          encoding: "jsonParsed",
        },
      ],
    });

    const entries = Array.isArray(result.value) ? result.value : [];
    for (const entry of entries) {
      const parsed = parseTokenAccount(entry);
      if (!parsed) continue;
      if (parsed.amount <= 0n) continue;

      const existing = balancesByMint.get(parsed.mint);
      if (existing) {
        balancesByMint.set(parsed.mint, {
          amount: existing.amount + parsed.amount,
          decimals: existing.decimals,
        });
        continue;
      }

      balancesByMint.set(parsed.mint, {
        amount: parsed.amount,
        decimals: parsed.decimals,
      });
    }
  }

  return Array.from(balancesByMint.entries()).map(([mint, value]) => ({
    mint,
    amount: value.amount.toString(),
    decimals: value.decimals,
    uiAmountString: formatUiAmount(value.amount, value.decimals),
  }));
}

export async function fetchSolanaTokenAccountByOwnerAndMint(inputs: {
  rpcUrls: string[];
  owner: string;
  mint: string;
  timeoutMs: number;
}): Promise<string | null> {
  const result = await solanaRpcRequest<{ value: unknown[] }>({
    rpcUrls: inputs.rpcUrls,
    timeoutMs: inputs.timeoutMs,
    method: "getTokenAccountsByOwner",
    params: [
      inputs.owner,
      { mint: inputs.mint },
      {
        encoding: "jsonParsed",
      },
    ],
  });

  const entries = Array.isArray(result.value) ? result.value : [];
  let first: string | null = null;
  let best: { pubkey: string; amount: bigint } | null = null;

  for (const entry of entries) {
    const parsed = parseTokenAccount(entry);
    if (!parsed) continue;
    if (!first) first = parsed.pubkey;
    if (!best || parsed.amount > best.amount) {
      best = { pubkey: parsed.pubkey, amount: parsed.amount };
    }
  }

  return best?.pubkey ?? first;
}

export async function fetchSolanaTokenAccountInfo(inputs: {
  rpcUrls: string[];
  account: string;
  timeoutMs: number;
}): Promise<{
  mint: string;
  owner: string;
  closeAuthority: string | null;
  programId: string;
} | null> {
  const result = await solanaRpcRequest<{ value: unknown }>({
    rpcUrls: inputs.rpcUrls,
    timeoutMs: inputs.timeoutMs,
    method: "getAccountInfo",
    params: [
      inputs.account,
      {
        encoding: "jsonParsed",
      },
    ],
  });

  const value = (result as { value?: unknown }).value;
  if (!isRecord(value)) return null;

  const programId = value.owner;
  if (typeof programId !== "string" || programId.trim().length === 0) {
    return null;
  }

  const data = value.data;
  if (!isRecord(data)) return null;

  const program = data.program;
  if (program !== "spl-token" && program !== "spl-token-2022") return null;

  const parsed = data.parsed;
  if (!isRecord(parsed)) return null;

  const info = parsed.info;
  if (!isRecord(info)) return null;

  const mint = info.mint;
  const owner = info.owner;
  const closeAuthorityRaw = info.closeAuthority;
  if (typeof mint !== "string" || mint.trim().length === 0) return null;
  if (typeof owner !== "string" || owner.trim().length === 0) return null;
  const closeAuthority =
    typeof closeAuthorityRaw === "string" && closeAuthorityRaw.trim().length > 0
      ? closeAuthorityRaw
      : null;

  return { mint, owner, closeAuthority, programId };
}

export async function fetchSolanaTokenAccountBalance(inputs: {
  rpcUrls: string[];
  account: string;
  timeoutMs: number;
}): Promise<{ amount: bigint; decimals: number } | null> {
  const result = await solanaRpcRequest<{ value?: unknown }>({
    rpcUrls: inputs.rpcUrls,
    timeoutMs: inputs.timeoutMs,
    method: "getTokenAccountBalance",
    params: [inputs.account],
  });

  const value = (result as { value?: unknown }).value;
  if (!isRecord(value)) return null;
  const amountRaw = value.amount;
  const decimalsRaw = value.decimals;
  if (typeof amountRaw !== "string" || amountRaw.trim().length === 0)
    return null;
  if (typeof decimalsRaw !== "number" || !Number.isFinite(decimalsRaw))
    return null;

  try {
    const amount = BigInt(amountRaw);
    const decimals = Math.max(0, Math.trunc(decimalsRaw));
    return { amount, decimals };
  } catch {
    return null;
  }
}

export async function fetchSolanaSignatureStatus(inputs: {
  rpcUrls: string[];
  signature: string;
  timeoutMs: number;
}): Promise<{ status: "submitted" | "fulfilled" | "failed" } | null> {
  const result = await solanaRpcRequest<{
    value?: Array<{
      confirmationStatus?: string | null;
      confirmations?: number | null;
      err?: unknown;
    } | null>;
  }>({
    rpcUrls: inputs.rpcUrls,
    timeoutMs: inputs.timeoutMs,
    method: "getSignatureStatuses",
    params: [[inputs.signature], { searchTransactionHistory: true }],
  });

  const entry = Array.isArray(result?.value) ? result.value[0] : null;
  if (!entry) return null;
  if (entry.err) return { status: "failed" };
  if (entry.confirmationStatus === "finalized") {
    return { status: "fulfilled" };
  }
  return { status: "submitted" };
}

export async function waitForSolanaSignatureConfirmation(inputs: {
  rpcUrls: string[];
  signature: string;
  timeoutMs: number;
  pollIntervalMs?: number;
  commitment?: "confirmed" | "finalized";
}): Promise<{ status: "fulfilled" | "failed" | "submitted" }> {
  const deadline = Date.now() + Math.max(1_000, inputs.timeoutMs);
  const pollIntervalMs = Math.max(250, inputs.pollIntervalMs ?? 1_000);
  const commitment = inputs.commitment ?? "finalized";
  let lastStatus: "fulfilled" | "failed" | "submitted" = "submitted";

  while (Date.now() < deadline) {
    const result = await solanaRpcRequest<{
      value?: Array<{
        confirmationStatus?: string | null;
        confirmations?: number | null;
        err?: unknown;
      } | null>;
    }>({
      rpcUrls: inputs.rpcUrls,
      timeoutMs: inputs.timeoutMs,
      method: "getSignatureStatuses",
      params: [[inputs.signature], { searchTransactionHistory: true }],
    });

    const entry = Array.isArray(result?.value) ? result.value[0] : null;
    if (entry?.err) {
      return { status: "failed" };
    }

    const confirmationStatus = entry?.confirmationStatus ?? null;
    const isConfirmed =
      confirmationStatus === "confirmed" || confirmationStatus === "finalized";
    const isFinalized = confirmationStatus === "finalized";
    if (
      (commitment === "confirmed" && isConfirmed) ||
      (commitment === "finalized" && isFinalized)
    ) {
      return { status: "fulfilled" };
    }

    if (entry) {
      lastStatus = "submitted";
    }

    await sleep(pollIntervalMs);
  }

  return { status: lastStatus };
}

type ParsedTransactionAccountKey = {
  pubkey: string;
};

type ParsedTransactionTokenBalance = {
  accountIndex: number;
  mint: string;
  amount: bigint;
  decimals: number;
};

function parseTransactionAccountKey(
  value: unknown,
): ParsedTransactionAccountKey | null {
  if (typeof value === "string" && value.trim().length > 0) {
    return { pubkey: value };
  }
  if (!isRecord(value)) return null;
  const pubkey = value.pubkey;
  if (typeof pubkey !== "string" || pubkey.trim().length === 0) return null;
  return { pubkey };
}

function parseTransactionTokenBalance(
  value: unknown,
): ParsedTransactionTokenBalance | null {
  if (!isRecord(value)) return null;
  const accountIndexRaw = value.accountIndex;
  if (
    typeof accountIndexRaw !== "number" ||
    !Number.isFinite(accountIndexRaw) ||
    accountIndexRaw < 0
  ) {
    return null;
  }

  const mint = value.mint;
  if (typeof mint !== "string" || mint.trim().length === 0) return null;

  const uiTokenAmount = value.uiTokenAmount;
  if (!isRecord(uiTokenAmount)) return null;
  const amountRaw = uiTokenAmount.amount;
  const decimalsRaw = uiTokenAmount.decimals;
  if (typeof amountRaw !== "string" || amountRaw.trim().length === 0)
    return null;
  if (typeof decimalsRaw !== "number" || !Number.isFinite(decimalsRaw))
    return null;

  try {
    return {
      accountIndex: Math.trunc(accountIndexRaw),
      mint,
      amount: BigInt(amountRaw),
      decimals: Math.max(0, Math.trunc(decimalsRaw)),
    };
  } catch {
    return null;
  }
}

function findTokenBalanceForAccount(inputs: {
  entries: unknown;
  accountKeys: Array<ParsedTransactionAccountKey | null>;
  tokenAccount: string;
}): ParsedTransactionTokenBalance | null {
  if (!Array.isArray(inputs.entries)) return null;
  for (const entry of inputs.entries) {
    const parsed = parseTransactionTokenBalance(entry);
    if (!parsed) continue;
    const accountKey = inputs.accountKeys[parsed.accountIndex];
    if (!accountKey) continue;
    if (accountKey.pubkey !== inputs.tokenAccount) continue;
    return parsed;
  }
  return null;
}

export type SolanaTokenAccountNetDeltaResult =
  | {
      status: "verified";
      mint: string;
      decimals: number;
      deltaRaw: bigint;
    }
  | {
      status: "not_found" | "missing_account" | "mint_mismatch";
      mint?: string | null;
      decimals?: number | null;
      deltaRaw?: bigint | null;
    };

export async function fetchSolanaTokenAccountNetDelta(inputs: {
  rpcUrls: string[];
  signature: string;
  tokenAccount: string;
  expectedMint?: string | null;
  timeoutMs: number;
}): Promise<SolanaTokenAccountNetDeltaResult> {
  const result = await solanaRpcRequest<{
    meta?: unknown;
    transaction?: unknown;
  } | null>({
    rpcUrls: inputs.rpcUrls,
    timeoutMs: inputs.timeoutMs,
    method: "getTransaction",
    params: [
      inputs.signature,
      {
        encoding: "jsonParsed",
        commitment: "finalized",
        maxSupportedTransactionVersion: 0,
      },
    ],
  });

  if (!result || !isRecord(result)) {
    return { status: "not_found" };
  }

  const transaction = result.transaction;
  const meta = result.meta;
  if (!isRecord(transaction) || !isRecord(meta)) {
    return { status: "not_found" };
  }

  const message = transaction.message;
  if (!isRecord(message)) {
    return { status: "not_found" };
  }

  const accountKeysRaw = message.accountKeys;
  if (!Array.isArray(accountKeysRaw)) {
    return { status: "not_found" };
  }

  const accountKeys = accountKeysRaw.map((entry) =>
    parseTransactionAccountKey(entry),
  );

  const pre = findTokenBalanceForAccount({
    entries: meta.preTokenBalances,
    accountKeys,
    tokenAccount: inputs.tokenAccount,
  });
  const post = findTokenBalanceForAccount({
    entries: meta.postTokenBalances,
    accountKeys,
    tokenAccount: inputs.tokenAccount,
  });

  if (!pre && !post) {
    return { status: "missing_account" };
  }

  const mint = post?.mint ?? pre?.mint ?? null;
  if (
    inputs.expectedMint &&
    mint &&
    inputs.expectedMint.trim().length > 0 &&
    mint !== inputs.expectedMint
  ) {
    return {
      status: "mint_mismatch",
      mint,
      decimals: post?.decimals ?? pre?.decimals ?? null,
      deltaRaw: null,
    };
  }

  const decimals = post?.decimals ?? pre?.decimals ?? 0;
  const preAmount = pre?.amount ?? 0n;
  const postAmount = post?.amount ?? 0n;

  return {
    status: "verified",
    mint: mint ?? inputs.expectedMint ?? "",
    decimals,
    deltaRaw: postAmount - preAmount,
  };
}

type LargestTokenAccount = {
  address: string;
  amount: bigint;
  decimals: number;
  uiAmountString: string;
};

export async function fetchSolanaTokenLargestAccounts(inputs: {
  rpcUrls: string[];
  mint: string;
  timeoutMs: number;
}): Promise<LargestTokenAccount[]> {
  const result = await solanaRpcRequest<{ value?: unknown[] }>({
    rpcUrls: inputs.rpcUrls,
    timeoutMs: inputs.timeoutMs,
    method: "getTokenLargestAccounts",
    params: [inputs.mint],
  });

  const entries = Array.isArray(result?.value) ? result.value : [];
  const parsed: LargestTokenAccount[] = [];

  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const address = entry.address;
    if (typeof address !== "string" || address.trim().length === 0) continue;

    const amountRaw = entry.amount;
    if (typeof amountRaw !== "string" || amountRaw.trim().length === 0)
      continue;

    const decimalsRaw = entry.decimals;
    if (typeof decimalsRaw !== "number" || !Number.isFinite(decimalsRaw))
      continue;

    let amount: bigint;
    try {
      amount = BigInt(amountRaw);
    } catch {
      continue;
    }

    const decimals = Math.max(0, Math.trunc(decimalsRaw));
    const uiAmountString =
      typeof entry.uiAmountString === "string"
        ? entry.uiAmountString
        : formatUiAmount(amount, decimals);

    parsed.push({ address, amount, decimals, uiAmountString });
  }

  return parsed;
}

export async function fetchSolanaTokenAccountOwners(inputs: {
  rpcUrls: string[];
  accounts: string[];
  timeoutMs: number;
  onRpcCall?: (() => void) | null;
}): Promise<Record<string, string | null>> {
  if (inputs.accounts.length === 0) return {};

  const owners: Record<string, string | null> = {};
  const chunkSize = 100;

  for (let offset = 0; offset < inputs.accounts.length; offset += chunkSize) {
    const accounts = inputs.accounts.slice(offset, offset + chunkSize);
    inputs.onRpcCall?.();
    const result = await solanaRpcRequest<{
      value?: Array<{ data?: unknown } | null>;
    }>({
      rpcUrls: inputs.rpcUrls,
      timeoutMs: inputs.timeoutMs,
      method: "getMultipleAccounts",
      params: [accounts, { encoding: "jsonParsed" }],
    });

    const values = Array.isArray(result?.value) ? result.value : [];

    for (let i = 0; i < accounts.length; i += 1) {
      const account = accounts[i];
      const entry = values[i];
      if (!entry || !isRecord(entry)) {
        owners[account] = null;
        continue;
      }
      const data = entry.data;
      if (!isRecord(data)) {
        owners[account] = null;
        continue;
      }
      const parsed = data.parsed;
      if (!isRecord(parsed)) {
        owners[account] = null;
        continue;
      }
      const info = parsed.info;
      if (!isRecord(info)) {
        owners[account] = null;
        continue;
      }
      const owner = info.owner;
      if (typeof owner === "string" && owner.trim().length > 0) {
        owners[account] = owner;
      } else {
        owners[account] = null;
      }
    }
  }

  return owners;
}

export async function fetchSolanaTokenBalancesByOwnerMints(inputs: {
  rpcUrls: string[];
  timeoutMs: number;
  owner: string;
  mints: string[];
}): Promise<Map<string, number>> {
  const balances = new Map<string, number>();
  const owner = inputs.owner.trim();
  if (!owner || inputs.mints.length === 0) return balances;

  for (const mint of inputs.mints) {
    const mintValue = mint.trim();
    if (!mintValue) continue;
    let result: { value?: unknown[] };
    try {
      result = await solanaRpcRequest<{ value?: unknown[] }>({
        rpcUrls: inputs.rpcUrls,
        timeoutMs: inputs.timeoutMs,
        method: "getTokenAccountsByOwner",
        params: [owner, { mint: mintValue }, { encoding: "jsonParsed" }],
      });
    } catch (error) {
      if (isSolanaMintNotFound(error)) {
        continue;
      }
      throw error;
    }

    const entries = Array.isArray(result?.value) ? result.value : [];
    let total = 0;

    for (const entry of entries) {
      const parsed = parseTokenAccount(entry);
      if (!parsed) continue;
      if (parsed.mint !== mintValue) continue;
      const uiAmount = Number(formatUiAmount(parsed.amount, parsed.decimals));
      if (!Number.isFinite(uiAmount) || uiAmount <= 0) continue;
      total += uiAmount;
    }

    if (total > 0) {
      balances.set(mintValue, total);
    }
  }

  return balances;
}
