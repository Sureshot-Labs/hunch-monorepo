import { isRpcRateLimit } from "@hunch/shared";
import { Interface, ethers } from "ethers";
import { env } from "../env.js";
import { fetchEvmCall, fetchEvmMulticall } from "./polygon-rpc.js";

const erc20Iface = new Interface([
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner,address spender) view returns (uint256)",
]);
const erc1155Iface = new Interface([
  "function isApprovedForAll(address owner,address operator) view returns (bool)",
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

const limitlessEthCallInflight = new Map<string, Promise<string>>();
const limitlessEthCallCache = new Map<
  string,
  Readonly<{ value: string; storedAt: number }>
>();
const LIMITLESS_ETH_CALL_FRESH_MS = 3_000;
const LIMITLESS_ETH_CALL_STALE_IF_RATE_LIMITED_MS = 30_000;
const limitlessSnapshotInflight = new Map<
  string,
  Promise<{
    usdcBalance: bigint;
    allowanceClob: bigint | null;
    allowanceNegRisk: bigint | null;
    allowanceAmm: bigint | null;
    approvedClob: boolean | null;
    approvedNegRisk: boolean | null;
    approvedAdapter: boolean | null;
    approvedAmm: boolean | null;
  }>
>();

function decodeBigInt(iface: Interface, fn: string, data: string): bigint {
  const decoded = iface.decodeFunctionResult(fn, data) as unknown;
  const value = Array.isArray(decoded) ? decoded[0] : null;
  if (typeof value !== "bigint") {
    throw new Error(`Invalid ${fn} result`);
  }
  return value;
}

function decodeBoolean(iface: Interface, fn: string, data: string): boolean {
  const decoded = iface.decodeFunctionResult(fn, data) as unknown;
  const value = Array.isArray(decoded) ? decoded[0] : null;
  if (typeof value !== "boolean") {
    throw new Error(`Invalid ${fn} result`);
  }
  return value;
}

async function performLimitlessEthCall(inputs: {
  rpcUrl: string;
  timeoutMs: number;
  to: string;
  data: string;
}): Promise<string> {
  return fetchEvmCall(inputs);
}

async function limitlessEthCall(inputs: {
  rpcUrl: string;
  timeoutMs: number;
  to: string;
  data: string;
}): Promise<string> {
  const key = `${inputs.rpcUrl}|${inputs.to.toLowerCase()}|${inputs.data}`;
  const cached = limitlessEthCallCache.get(key);
  if (cached && Date.now() - cached.storedAt <= LIMITLESS_ETH_CALL_FRESH_MS) {
    return cached.value;
  }
  const pending = limitlessEthCallInflight.get(key);
  if (pending) return pending;

  const promise = performLimitlessEthCall(inputs)
    .then((value) => {
      limitlessEthCallCache.set(key, { value, storedAt: Date.now() });
      return value;
    })
    .catch((error) => {
      if (
        cached &&
        Date.now() - cached.storedAt <=
          LIMITLESS_ETH_CALL_STALE_IF_RATE_LIMITED_MS &&
        isRpcRateLimit(error)
      ) {
        return cached.value;
      }
      throw error;
    })
    .finally(() => {
      limitlessEthCallInflight.delete(key);
    });
  limitlessEthCallInflight.set(key, promise);
  return promise;
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
  adapterAddress?: string | null;
  conditionalTokensAddress?: string | null;
}): Promise<{
  usdcBalance: bigint;
  allowanceClob: bigint | null;
  allowanceNegRisk: bigint | null;
  allowanceAmm: bigint | null;
  approvedClob: boolean | null;
  approvedNegRisk: boolean | null;
  approvedAdapter: boolean | null;
  approvedAmm: boolean | null;
}> {
  const owner = ethers.getAddress(inputs.owner);
  const clobAddress = inputs.clobAddress?.trim() || "";
  const negRiskAddress = inputs.negRiskAddress?.trim() || "";
  const ammAddress = inputs.ammAddress?.trim() || "";
  const adapterAddress = inputs.adapterAddress?.trim() || "";
  const conditionalTokensAddress =
    inputs.conditionalTokensAddress?.trim() || "";
  const key = [
    inputs.rpcUrl,
    owner.toLowerCase(),
    clobAddress.toLowerCase(),
    negRiskAddress.toLowerCase(),
    ammAddress.toLowerCase(),
    adapterAddress.toLowerCase(),
    conditionalTokensAddress.toLowerCase(),
  ].join("|");
  const pending = limitlessSnapshotInflight.get(key);
  if (pending) return pending;

  const promise = (async () => {
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

    const addConditionalApproval = (operator: string) => {
      entries.push({
        target: conditionalTokensAddress,
        callData: erc1155Iface.encodeFunctionData("isApprovedForAll", [
          owner,
          operator,
        ]),
        decode: (data) => decodeBoolean(erc1155Iface, "isApprovedForAll", data),
        fallback: false,
      });
    };
    if (conditionalTokensAddress && clobAddress) {
      addConditionalApproval(clobAddress);
    }
    if (conditionalTokensAddress && negRiskAddress) {
      addConditionalApproval(negRiskAddress);
    }
    if (conditionalTokensAddress && adapterAddress) {
      addConditionalApproval(adapterAddress);
    }
    if (conditionalTokensAddress && ammAddress) {
      addConditionalApproval(ammAddress);
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
    const allowanceNegRisk = negRiskAddress
      ? (decoded[cursor++] as bigint)
      : null;
    const allowanceAmm = ammAddress ? (decoded[cursor++] as bigint) : null;
    const approvedClob =
      conditionalTokensAddress && clobAddress
        ? (decoded[cursor++] as boolean)
        : null;
    const approvedNegRisk =
      conditionalTokensAddress && negRiskAddress
        ? (decoded[cursor++] as boolean)
        : null;
    const approvedAdapter =
      conditionalTokensAddress && adapterAddress
        ? (decoded[cursor++] as boolean)
        : null;
    const approvedAmm =
      conditionalTokensAddress && ammAddress
        ? (decoded[cursor++] as boolean)
        : null;

    return {
      usdcBalance,
      allowanceClob,
      allowanceNegRisk,
      allowanceAmm,
      approvedClob,
      approvedNegRisk,
      approvedAdapter,
      approvedAmm,
    };
  })().finally(() => {
    limitlessSnapshotInflight.delete(key);
  });
  limitlessSnapshotInflight.set(key, promise);
  return promise;
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
