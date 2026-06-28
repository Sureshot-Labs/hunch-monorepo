import { Interface, ethers } from "ethers";
import { env } from "../env.js";
import { fetchEvmMulticall } from "./polygon-rpc.js";

const erc20Iface = new Interface([
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner,address spender) view returns (uint256)",
]);

const erc1155Iface = new Interface([
  "function isApprovedForAll(address owner,address operator) view returns (bool)",
]);

const feeCollectorIface = new Interface([
  "function nonces(address signer) view returns (uint256)",
]);

const POLYGON_MULTICALL_ADDRESS =
  env.polygonMulticallAddress?.trim() ||
  "0xca11bde05977b3631167028862be2a173976ca11";
export const POLYGON_NATIVE_USDC_ADDRESS =
  "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359";

type Snapshot = {
  pusdBalance: bigint;
  usdcBalance: bigint;
  usdceBalance: bigint;
  nativeUsdcBalance: bigint;
  oldUsdcBalance: bigint;
  signerPusdBalance: bigint | null;
  signerUsdcBalance: bigint | null;
  signerUsdceBalance: bigint | null;
  signerNativeUsdcBalance: bigint | null;
  signerOldUsdcBalance: bigint | null;
  allowanceExchange: bigint;
  allowanceNegRisk: bigint;
  allowanceNegRiskAdapter: bigint | null;
  allowanceFeeCollector: bigint | null;
  okExchange: boolean;
  okNegRisk: boolean;
  okNegRiskAdapter: boolean | null;
  okCtfCollateralAdapter: boolean | null;
  okNegRiskCollateralAdapter: boolean | null;
  operatorApprovals: Record<string, boolean>;
  feeCollectorNonce: bigint | null;
};

type MulticallEntry<T> = {
  target: string;
  callData: string;
  allowFailure?: boolean;
  decode: (data: string) => T;
  fallback: T;
};

function decodeBigInt(iface: Interface, fn: string, data: string): bigint {
  const decoded = iface.decodeFunctionResult(fn, data) as unknown;
  const value = Array.isArray(decoded) ? decoded[0] : null;
  if (typeof value !== "bigint") {
    throw new Error(`Invalid ${fn} result`);
  }
  return value;
}

function decodeBool(iface: Interface, fn: string, data: string): boolean {
  const decoded = iface.decodeFunctionResult(fn, data) as unknown;
  const value = Array.isArray(decoded) ? decoded[0] : null;
  if (typeof value !== "boolean") {
    throw new Error(`Invalid ${fn} result`);
  }
  return value;
}

export async function fetchPolymarketOnchainSnapshot(inputs: {
  rpcUrl: string;
  timeoutMs: number;
  signer: string;
  funder: string;
  includeSignerUsdc?: boolean;
  includeFeeCollectorNonce?: boolean;
  negRiskAdapterAddress?: string | null;
  ctfCollateralAdapterAddress?: string | null;
  negRiskCollateralAdapterAddress?: string | null;
  feeCollectorAddress?: string | null;
}): Promise<Snapshot> {
  const signer = ethers.getAddress(inputs.signer);
  const funder = ethers.getAddress(inputs.funder);
  const negRiskAdapterAddress = inputs.negRiskAdapterAddress?.trim() || "";
  const ctfCollateralAdapterAddress =
    inputs.ctfCollateralAdapterAddress?.trim() || "";
  const negRiskCollateralAdapterAddress =
    inputs.negRiskCollateralAdapterAddress?.trim() || "";
  const feeCollectorAddress = inputs.feeCollectorAddress?.trim() || "";

  const entries: Array<MulticallEntry<unknown>> = [];

  entries.push({
    target: env.polymarketUsdcAddress,
    callData: erc20Iface.encodeFunctionData("balanceOf", [funder]),
    decode: (data) => decodeBigInt(erc20Iface, "balanceOf", data),
    fallback: 0n,
  });
  entries.push({
    target: env.polymarketUsdceAddress,
    callData: erc20Iface.encodeFunctionData("balanceOf", [funder]),
    decode: (data) => decodeBigInt(erc20Iface, "balanceOf", data),
    fallback: 0n,
  });
  entries.push({
    target: POLYGON_NATIVE_USDC_ADDRESS,
    callData: erc20Iface.encodeFunctionData("balanceOf", [funder]),
    decode: (data) => decodeBigInt(erc20Iface, "balanceOf", data),
    fallback: 0n,
  });

  if (inputs.includeSignerUsdc) {
    entries.push({
      target: env.polymarketUsdcAddress,
      callData: erc20Iface.encodeFunctionData("balanceOf", [signer]),
      decode: (data) => decodeBigInt(erc20Iface, "balanceOf", data),
      fallback: 0n,
    });
    entries.push({
      target: env.polymarketUsdceAddress,
      callData: erc20Iface.encodeFunctionData("balanceOf", [signer]),
      decode: (data) => decodeBigInt(erc20Iface, "balanceOf", data),
      fallback: 0n,
    });
    entries.push({
      target: POLYGON_NATIVE_USDC_ADDRESS,
      callData: erc20Iface.encodeFunctionData("balanceOf", [signer]),
      decode: (data) => decodeBigInt(erc20Iface, "balanceOf", data),
      fallback: 0n,
    });
  }

  entries.push(
    {
      target: env.polymarketUsdcAddress,
      callData: erc20Iface.encodeFunctionData("allowance", [
        funder,
        env.polymarketExchangeAddress,
      ]),
      decode: (data) => decodeBigInt(erc20Iface, "allowance", data),
      fallback: 0n,
    },
    {
      target: env.polymarketUsdcAddress,
      callData: erc20Iface.encodeFunctionData("allowance", [
        funder,
        env.polymarketNegRiskExchangeAddress,
      ]),
      decode: (data) => decodeBigInt(erc20Iface, "allowance", data),
      fallback: 0n,
    },
    {
      target: env.polymarketConditionalTokensAddress,
      callData: erc1155Iface.encodeFunctionData("isApprovedForAll", [
        funder,
        env.polymarketExchangeAddress,
      ]),
      decode: (data) => decodeBool(erc1155Iface, "isApprovedForAll", data),
      fallback: false,
    },
    {
      target: env.polymarketConditionalTokensAddress,
      callData: erc1155Iface.encodeFunctionData("isApprovedForAll", [
        funder,
        env.polymarketNegRiskExchangeAddress,
      ]),
      decode: (data) => decodeBool(erc1155Iface, "isApprovedForAll", data),
      fallback: false,
    },
  );

  if (negRiskAdapterAddress) {
    entries.push(
      {
        target: env.polymarketConditionalTokensAddress,
        callData: erc1155Iface.encodeFunctionData("isApprovedForAll", [
          funder,
          negRiskAdapterAddress,
        ]),
        decode: (data) => decodeBool(erc1155Iface, "isApprovedForAll", data),
        fallback: false,
      },
      {
        target: env.polymarketUsdcAddress,
        callData: erc20Iface.encodeFunctionData("allowance", [
          funder,
          negRiskAdapterAddress,
        ]),
        decode: (data) => decodeBigInt(erc20Iface, "allowance", data),
        fallback: 0n,
      },
    );
  }

  const extraConditionalOperators = [
    ctfCollateralAdapterAddress,
    negRiskCollateralAdapterAddress,
  ]
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  for (const operator of extraConditionalOperators) {
    entries.push({
      target: env.polymarketConditionalTokensAddress,
      callData: erc1155Iface.encodeFunctionData("isApprovedForAll", [
        funder,
        operator,
      ]),
      decode: (data) => decodeBool(erc1155Iface, "isApprovedForAll", data),
      fallback: false,
    });
  }

  if (feeCollectorAddress) {
    entries.push({
      target: env.polymarketUsdcAddress,
      callData: erc20Iface.encodeFunctionData("allowance", [
        funder,
        feeCollectorAddress,
      ]),
      decode: (data) => decodeBigInt(erc20Iface, "allowance", data),
      fallback: 0n,
    });
  }

  if (inputs.includeFeeCollectorNonce && feeCollectorAddress) {
    entries.push({
      target: feeCollectorAddress,
      callData: feeCollectorIface.encodeFunctionData("nonces", [signer]),
      decode: (data) => decodeBigInt(feeCollectorIface, "nonces", data),
      fallback: 0n,
    });
  }

  const results = await fetchEvmMulticall({
    rpcUrl: inputs.rpcUrl,
    timeoutMs: inputs.timeoutMs,
    multicallAddress: POLYGON_MULTICALL_ADDRESS,
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
  const pusdBalance = decoded[cursor++] as bigint;
  const usdceBalance = decoded[cursor++] as bigint;
  const nativeUsdcBalance = decoded[cursor++] as bigint;
  const signerPusdBalance = inputs.includeSignerUsdc
    ? (decoded[cursor++] as bigint)
    : null;
  const signerUsdceBalance = inputs.includeSignerUsdc
    ? (decoded[cursor++] as bigint)
    : null;
  const signerNativeUsdcBalance = inputs.includeSignerUsdc
    ? (decoded[cursor++] as bigint)
    : null;
  const allowanceExchange = decoded[cursor++] as bigint;
  const allowanceNegRisk = decoded[cursor++] as bigint;
  const okExchange = decoded[cursor++] as boolean;
  const okNegRisk = decoded[cursor++] as boolean;
  const okNegRiskAdapter = negRiskAdapterAddress
    ? (decoded[cursor++] as boolean)
    : null;
  const allowanceNegRiskAdapter = negRiskAdapterAddress
    ? (decoded[cursor++] as bigint)
    : null;
  const extraOperatorApprovals = new Map<string, boolean>();
  for (const operator of extraConditionalOperators) {
    const normalized = ethers.getAddress(operator);
    extraOperatorApprovals.set(
      normalized.toLowerCase(),
      decoded[cursor++] as boolean,
    );
  }
  const allowanceFeeCollector = feeCollectorAddress
    ? (decoded[cursor++] as bigint)
    : null;
  const feeCollectorNonce =
    inputs.includeFeeCollectorNonce && feeCollectorAddress
      ? (decoded[cursor++] as bigint)
      : null;

  return {
    pusdBalance,
    usdcBalance: pusdBalance,
    usdceBalance,
    nativeUsdcBalance,
    oldUsdcBalance: nativeUsdcBalance,
    signerPusdBalance,
    signerUsdcBalance: signerPusdBalance,
    signerUsdceBalance,
    signerNativeUsdcBalance,
    signerOldUsdcBalance: signerNativeUsdcBalance,
    allowanceExchange,
    allowanceNegRisk,
    allowanceNegRiskAdapter,
    allowanceFeeCollector,
    okExchange,
    okNegRisk,
    okNegRiskAdapter,
    okCtfCollateralAdapter: ctfCollateralAdapterAddress
      ? (extraOperatorApprovals.get(
          ethers.getAddress(ctfCollateralAdapterAddress).toLowerCase(),
        ) ?? false)
      : null,
    okNegRiskCollateralAdapter: negRiskCollateralAdapterAddress
      ? (extraOperatorApprovals.get(
          ethers.getAddress(negRiskCollateralAdapterAddress).toLowerCase(),
        ) ?? false)
      : null,
    operatorApprovals: {
      [ethers.getAddress(env.polymarketExchangeAddress).toLowerCase()]:
        okExchange,
      [ethers.getAddress(env.polymarketNegRiskExchangeAddress).toLowerCase()]:
        okNegRisk,
      ...(negRiskAdapterAddress
        ? {
            [ethers.getAddress(negRiskAdapterAddress).toLowerCase()]:
              okNegRiskAdapter ?? false,
          }
        : {}),
      ...Object.fromEntries(extraOperatorApprovals),
    },
    feeCollectorNonce,
  };
}
