import { Interface, ethers } from "ethers";
import PQueue from "p-queue";

const ammIface = new Interface([
  "function calcBuyAmount(uint256 investmentAmount,uint256 outcomeIndex) view returns (uint256 outcomeTokens)",
]);

const DEFAULT_INVESTMENT_AMOUNT_RAW = 1_000_000n; // 1 USDC with 6 decimals
const rpcQueues = new Map<string, PQueue>();
const inFlightQuotes = new Map<
  string,
  Promise<{ yesPrice: number | null; noPrice: number | null }>
>();

type JsonRpcResponse<T> =
  | { jsonrpc: "2.0"; id: number; result: T }
  | { jsonrpc: "2.0"; id: number; error: { code?: number; message?: string } };

function rpcQueue(rpcUrl: string, minDelayMs: number): PQueue {
  const key = `${rpcUrl}:${minDelayMs}`;
  const existing = rpcQueues.get(key);
  if (existing) return existing;

  const queue = new PQueue({
    concurrency: 1,
    interval: minDelayMs,
    intervalCap: 1,
  });
  rpcQueues.set(key, queue);
  return queue;
}

async function ethCall(inputs: {
  rpcUrl: string;
  timeoutMs: number;
  minDelayMs: number;
  to: string;
  data: string;
}): Promise<string> {
  const result = await rpcQueue(inputs.rpcUrl, inputs.minDelayMs).add(
    async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), inputs.timeoutMs);

      try {
        const response = await fetch(inputs.rpcUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "eth_call",
            params: [
              { to: ethers.getAddress(inputs.to), data: inputs.data },
              "latest",
            ],
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(
            `Base RPC error: ${response.status} ${response.statusText}`,
          );
        }

        const json = (await response.json()) as JsonRpcResponse<string>;
        if ("error" in json) {
          throw new Error(json.error.message || "Base RPC returned an error");
        }

        if (typeof json.result !== "string" || json.result.length === 0) {
          throw new Error("Base RPC returned an empty result");
        }

        return json.result;
      } finally {
        clearTimeout(timeout);
      }
    },
  );
  if (typeof result !== "string") {
    throw new Error("Base RPC scheduler stopped before execution");
  }
  return result;
}

async function calcBuyAmount(inputs: {
  rpcUrl: string;
  timeoutMs: number;
  minDelayMs: number;
  marketAddress: string;
  investmentAmountRaw: bigint;
  outcomeIndex: number;
}): Promise<bigint | null> {
  const data = ammIface.encodeFunctionData("calcBuyAmount", [
    inputs.investmentAmountRaw,
    BigInt(inputs.outcomeIndex),
  ]);
  const result = await ethCall({
    rpcUrl: inputs.rpcUrl,
    timeoutMs: inputs.timeoutMs,
    minDelayMs: inputs.minDelayMs,
    to: inputs.marketAddress,
    data,
  });
  const decoded = ammIface.decodeFunctionResult(
    "calcBuyAmount",
    result,
  ) as unknown;
  const raw = Array.isArray(decoded) ? decoded[0] : null;
  return typeof raw === "bigint" && raw > 0n ? raw : null;
}

function priceFromShares(
  investmentAmountRaw: bigint,
  sharesRaw: bigint | null,
): number | null {
  if (sharesRaw == null || sharesRaw <= 0n) return null;
  const price = Number(investmentAmountRaw) / Number(sharesRaw);
  if (!Number.isFinite(price) || price <= 0) return null;
  return Math.min(1, Math.max(0, price));
}

export async function fetchLimitlessAmmQuotePair(inputs: {
  rpcUrl: string;
  timeoutMs: number;
  minDelayMs: number;
  marketAddress: string;
  investmentAmountRaw?: bigint;
}): Promise<{ yesPrice: number | null; noPrice: number | null }> {
  const investmentAmountRaw =
    inputs.investmentAmountRaw ?? DEFAULT_INVESTMENT_AMOUNT_RAW;
  const inFlightKey = [
    inputs.rpcUrl,
    inputs.marketAddress.toLowerCase(),
    investmentAmountRaw.toString(),
  ].join(":");
  const existing = inFlightQuotes.get(inFlightKey);
  if (existing) return existing;

  const request = Promise.all([
    calcBuyAmount({
      rpcUrl: inputs.rpcUrl,
      timeoutMs: inputs.timeoutMs,
      minDelayMs: inputs.minDelayMs,
      marketAddress: inputs.marketAddress,
      investmentAmountRaw,
      outcomeIndex: 0,
    }),
    calcBuyAmount({
      rpcUrl: inputs.rpcUrl,
      timeoutMs: inputs.timeoutMs,
      minDelayMs: inputs.minDelayMs,
      marketAddress: inputs.marketAddress,
      investmentAmountRaw,
      outcomeIndex: 1,
    }),
  ])
    .then(([yesShares, noShares]) => ({
      yesPrice: priceFromShares(investmentAmountRaw, yesShares),
      noPrice: priceFromShares(investmentAmountRaw, noShares),
    }))
    .finally(() => {
      if (inFlightQuotes.get(inFlightKey) === request) {
        inFlightQuotes.delete(inFlightKey);
      }
    });
  inFlightQuotes.set(inFlightKey, request);
  return request;
}
