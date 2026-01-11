import { isRecord } from "../lib/type-guards.js";

type JsonRpcError = {
  code?: number;
  message?: string;
  data?: unknown;
};

type JsonRpcResponse<T> =
  | { jsonrpc: "2.0"; id: number; result: T }
  | { jsonrpc: "2.0"; id: number; error: JsonRpcError };

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

function parseTokenAccount(
  entry: unknown,
): ParsedTokenAccount | null {
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

async function solanaRpcRequest<T>(inputs: {
  rpcUrls: string[];
  timeoutMs: number;
  method: string;
  params: unknown[];
}): Promise<T> {
  let lastError: unknown = null;

  for (const rpcUrl of inputs.rpcUrls) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), inputs.timeoutMs);
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
        if (response.status === 429 && inputs.rpcUrls.length > 1) {
          continue;
        }
        throw error;
      }

      const json = (await response.json()) as unknown;
      if (!isRecord(json)) {
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
        if (/too many requests/i.test(message) && inputs.rpcUrls.length > 1) {
          continue;
        }
        throw error;
      }

      return rpc.result;
    } catch (error) {
      lastError = error;
      if (inputs.rpcUrls.length > 1) {
        const message = error instanceof Error ? error.message : "";
        if (
          /Solana RPC error: 429/i.test(message) ||
          /too many requests/i.test(message)
        ) {
          continue;
        }
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError ?? new Error("Solana RPC request failed");
}

export const SOLANA_SPL_TOKEN_PROGRAM_ID =
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const SOLANA_TOKEN_2022_PROGRAM_ID =
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

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
}): Promise<{ amount: bigint; decimals: number; uiAmountString: string } | null> {
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
}): Promise<{ mint: string; owner: string } | null> {
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

  const data = value.data;
  if (!isRecord(data)) return null;

  const program = data.program;
  if (program !== "spl-token") return null;

  const parsed = data.parsed;
  if (!isRecord(parsed)) return null;

  const info = parsed.info;
  if (!isRecord(info)) return null;

  const mint = info.mint;
  const owner = info.owner;
  if (typeof mint !== "string" || mint.trim().length === 0) return null;
  if (typeof owner !== "string" || owner.trim().length === 0) return null;

  return { mint, owner };
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
    value?: Array<
      | {
          confirmationStatus?: string | null;
          confirmations?: number | null;
          err?: unknown;
        }
      | null
    >;
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
    if (typeof amountRaw !== "string" || amountRaw.trim().length === 0) continue;

    const decimalsRaw = entry.decimals;
    if (typeof decimalsRaw !== "number" || !Number.isFinite(decimalsRaw)) continue;

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
}): Promise<Record<string, string | null>> {
  if (inputs.accounts.length === 0) return {};

  const result = await solanaRpcRequest<{
    value?: Array<{ data?: unknown } | null>;
  }>({
    rpcUrls: inputs.rpcUrls,
    timeoutMs: inputs.timeoutMs,
    method: "getMultipleAccounts",
    params: [inputs.accounts, { encoding: "jsonParsed" }],
  });

  const values = Array.isArray(result?.value) ? result.value : [];
  const owners: Record<string, string | null> = {};

  for (let i = 0; i < inputs.accounts.length; i += 1) {
    const account = inputs.accounts[i];
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

  return owners;
}
