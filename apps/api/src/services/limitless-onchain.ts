import { Interface, ethers } from "ethers";
import { env } from "../env.js";
import { fetchEvmMulticall } from "./polygon-rpc.js";

const erc20Iface = new Interface([
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner,address spender) view returns (uint256)",
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
