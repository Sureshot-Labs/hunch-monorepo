import { isRecord } from "../lib/type-guards.js";

type JsonRpcError = {
  code?: number;
  message?: string;
  data?: unknown;
};

type JsonRpcResponse<T> =
  | { jsonrpc: "2.0"; id: number; result: T }
  | { jsonrpc: "2.0"; id: number; error: JsonRpcError };

function formatUiAmount(amount: bigint, decimals: number): string {
  if (decimals <= 0) return amount.toString();

  const negative = amount < 0n;
  const abs = negative ? -amount : amount;
  const raw = abs.toString().padStart(decimals + 1, "0");
  const whole = raw.slice(0, -decimals);
  const fractionRaw = raw.slice(-decimals).replace(/0+$/, "");
  const ui = fractionRaw.length ? `${whole}.${fractionRaw}` : whole;
  return negative ? `-${ui}` : ui;
}

function parseTokenAccount(
  entry: unknown,
): { mint: string; amount: bigint; decimals: number } | null {
  if (!isRecord(entry)) return null;
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

  return { mint, amount, decimals };
}

async function solanaRpcRequest<T>(inputs: {
  rpcUrl: string;
  timeoutMs: number;
  method: string;
  params: unknown[];
}): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), inputs.timeoutMs);

  try {
    const response = await fetch(inputs.rpcUrl, {
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
      throw new Error(
        `Solana RPC error: ${response.status} ${response.statusText}`,
      );
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
      throw new Error(`Solana RPC ${inputs.method} error: ${message}`);
    }

    return rpc.result;
  } finally {
    clearTimeout(timeout);
  }
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

export async function fetchSolanaTokenBalancesByOwner(inputs: {
  rpcUrl: string;
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
      rpcUrl: inputs.rpcUrl,
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
