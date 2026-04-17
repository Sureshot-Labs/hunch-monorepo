import { Interface, ethers } from "ethers";
import { env } from "../env.js";
import { fetchEvmMulticall } from "./polygon-rpc.js";

const erc20Iface = new Interface([
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner,address spender) view returns (uint256)",
]);

const limitlessAmmIface = new Interface([
  "function calcBuyAmount(uint256 investmentAmount,uint256 outcomeIndex) view returns (uint256)",
  "function calcSellAmount(uint256 returnAmount,uint256 outcomeIndex) view returns (uint256)",
]);

type MulticallEntry<T> = {
  target: string;
  callData: string;
  decode: (data: string) => T;
  fallback: T;
};

function decodeBigInt(
  iface: Interface,
  fn: string,
  data: string,
): bigint {
  const decoded = iface.decodeFunctionResult(fn, data) as unknown;
  const value = Array.isArray(decoded) ? decoded[0] : null;
  if (typeof value !== "bigint") {
    throw new Error(`Invalid ${fn} result`);
  }
  return value;
}

async function limitlessEthCall(inputs: {
  rpcUrl: string;
  timeoutMs: number;
  to: string;
  data: string;
}): Promise<string> {
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
        params: [{ to: inputs.to, data: inputs.data }, "latest"],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(
        `Limitless RPC error: ${response.status} ${response.statusText}`,
      );
    }

    const json = (await response.json()) as unknown;
    if (
      !json ||
      typeof json !== "object" ||
      !("result" in json) ||
      typeof (json as { result?: unknown }).result !== "string"
    ) {
      const message =
        json &&
        typeof json === "object" &&
        "error" in json &&
        typeof (json as { error?: { message?: unknown } }).error?.message ===
          "string"
          ? (json as { error: { message: string } }).error.message
          : "Invalid Limitless RPC response";
      throw new Error(message);
    }

    return (json as { result: string }).result;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchLimitlessAmmBuyAmount(inputs: {
  rpcUrl: string;
  timeoutMs: number;
  marketAddress: string;
  investmentAmount: bigint;
  outcomeIndex: number;
}): Promise<bigint> {
  const data = limitlessAmmIface.encodeFunctionData("calcBuyAmount", [
    inputs.investmentAmount,
    BigInt(inputs.outcomeIndex),
  ]);
  const result = await limitlessEthCall({
    rpcUrl: inputs.rpcUrl,
    timeoutMs: inputs.timeoutMs,
    to: inputs.marketAddress,
    data,
  });
  return decodeBigInt(limitlessAmmIface, "calcBuyAmount", result);
}

async function fetchLimitlessAmmSellAmount(inputs: {
  rpcUrl: string;
  timeoutMs: number;
  marketAddress: string;
  returnAmount: bigint;
  outcomeIndex: number;
}): Promise<bigint> {
  const data = limitlessAmmIface.encodeFunctionData("calcSellAmount", [
    inputs.returnAmount,
    BigInt(inputs.outcomeIndex),
  ]);
  const result = await limitlessEthCall({
    rpcUrl: inputs.rpcUrl,
    timeoutMs: inputs.timeoutMs,
    to: inputs.marketAddress,
    data,
  });
  return decodeBigInt(limitlessAmmIface, "calcSellAmount", result);
}

function isLimitlessAmmRevertError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes("execution reverted") ||
    message.includes("reverted during") ||
    message.includes("subtraction overflow")
  );
}

async function findLimitlessAmmReturnAmount(inputs: {
  rpcUrl: string;
  timeoutMs: number;
  marketAddress: string;
  outcomeIndex: number;
  maxOutcomeTokens: bigint;
}): Promise<bigint> {
  let low = 0n;
  let high = inputs.maxOutcomeTokens;
  let best = 0n;

  for (let i = 0; i < 40 && low <= high; i += 1) {
    const mid = (low + high) / 2n;
    let required: bigint;
    try {
      required = await fetchLimitlessAmmSellAmount({
        rpcUrl: inputs.rpcUrl,
        timeoutMs: inputs.timeoutMs,
        marketAddress: inputs.marketAddress,
        returnAmount: mid,
        outcomeIndex: inputs.outcomeIndex,
      });
    } catch (error) {
      if (isLimitlessAmmRevertError(error)) {
        high = mid - 1n;
        continue;
      }
      throw error;
    }
    if (required <= inputs.maxOutcomeTokens) {
      best = mid;
      low = mid + 1n;
    } else {
      high = mid - 1n;
    }
  }

  return best;
}

export async function fetchLimitlessOnchainSnapshot(inputs: {
  rpcUrl: string;
  timeoutMs: number;
  owner: string;
  clobAddress?: string | null;
  negRiskAddress?: string | null;
  ammAddress?: string | null;
}): Promise<{
  usdcBalance: bigint;
  allowanceClob: bigint | null;
  allowanceNegRisk: bigint | null;
  allowanceAmm: bigint | null;
}> {
  const owner = ethers.getAddress(inputs.owner);
  const clobAddress = inputs.clobAddress?.trim() || "";
  const negRiskAddress = inputs.negRiskAddress?.trim() || "";
  const ammAddress = inputs.ammAddress?.trim() || "";

  const entries: Array<MulticallEntry<unknown>> = [
    {
      target: env.limitlessUsdcAddress,
      callData: erc20Iface.encodeFunctionData("balanceOf", [owner]),
      decode: (data) => decodeBigInt(erc20Iface, "balanceOf", data),
      fallback: 0n,
    },
  ];

  if (clobAddress) {
    entries.push({
      target: env.limitlessUsdcAddress,
      callData: erc20Iface.encodeFunctionData("allowance", [
        owner,
        clobAddress,
      ]),
      decode: (data) => decodeBigInt(erc20Iface, "allowance", data),
      fallback: 0n,
    });
  }

  if (negRiskAddress) {
    entries.push({
      target: env.limitlessUsdcAddress,
      callData: erc20Iface.encodeFunctionData("allowance", [
        owner,
        negRiskAddress,
      ]),
      decode: (data) => decodeBigInt(erc20Iface, "allowance", data),
      fallback: 0n,
    });
  }

  if (ammAddress) {
    entries.push({
      target: env.limitlessUsdcAddress,
      callData: erc20Iface.encodeFunctionData("allowance", [
        owner,
        ammAddress,
      ]),
      decode: (data) => decodeBigInt(erc20Iface, "allowance", data),
      fallback: 0n,
    });
  }

  const results = await fetchEvmMulticall({
    rpcUrl: inputs.rpcUrl,
    timeoutMs: inputs.timeoutMs,
    multicallAddress: env.baseMulticallAddress,
    calls: entries.map((entry) => ({
      target: entry.target,
      callData: entry.callData,
      allowFailure: true,
    })),
  });

  const decoded = entries.map((entry, index) => {
    const result = results[index];
    if (!result?.success) return entry.fallback;
    try {
      return entry.decode(result.returnData);
    } catch {
      return entry.fallback;
    }
  });

  let cursor = 0;
  const usdcBalance = decoded[cursor++] as bigint;
  const allowanceClob = clobAddress ? (decoded[cursor++] as bigint) : null;
  const allowanceNegRisk = negRiskAddress ? (decoded[cursor++] as bigint) : null;
  const allowanceAmm = ammAddress ? (decoded[cursor++] as bigint) : null;

  return {
    usdcBalance,
    allowanceClob,
    allowanceNegRisk,
    allowanceAmm,
  };
}

export async function fetchLimitlessAmmQuote(inputs: {
  rpcUrl: string;
  timeoutMs: number;
  marketAddress: string;
  outcomeIndex: number;
  side: "BUY" | "SELL";
  amountUsdRaw?: bigint | null;
  amountSharesRaw?: bigint | null;
}): Promise<{
  sharesRaw: bigint | null;
  returnAmountRaw: bigint | null;
}> {
  const marketAddress = ethers.getAddress(inputs.marketAddress);
  if (inputs.side === "BUY") {
    if (inputs.amountUsdRaw == null || inputs.amountUsdRaw <= 0n) {
      throw new Error("amountUsdRaw is required for BUY AMM quotes");
    }
    const sharesRaw = await fetchLimitlessAmmBuyAmount({
      rpcUrl: inputs.rpcUrl,
      timeoutMs: inputs.timeoutMs,
      marketAddress,
      investmentAmount: inputs.amountUsdRaw,
      outcomeIndex: inputs.outcomeIndex,
    });
    return {
      sharesRaw,
      returnAmountRaw: null,
    };
  }

  if (inputs.amountSharesRaw == null || inputs.amountSharesRaw <= 0n) {
    throw new Error("amountSharesRaw is required for SELL AMM quotes");
  }
  const returnAmountRaw = await findLimitlessAmmReturnAmount({
    rpcUrl: inputs.rpcUrl,
    timeoutMs: inputs.timeoutMs,
    marketAddress,
    outcomeIndex: inputs.outcomeIndex,
    maxOutcomeTokens: inputs.amountSharesRaw,
  });
  return {
    sharesRaw: inputs.amountSharesRaw,
    returnAmountRaw,
  };
}
