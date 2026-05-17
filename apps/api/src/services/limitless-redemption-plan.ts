import { Interface, ethers } from "ethers";
import { env } from "../env.js";
import { normalizeLimitlessRawTokenId } from "../lib/limitless-token.js";
import {
  buildPreflightFailurePlan,
  buildReadyRedemptionPlan,
  buildUnavailableRedemptionPlan,
  type RedemptionPlan,
} from "./redemption-plan.js";
import { SafeEvmReadError, safeEvmReadContract } from "./safe-evm-read.js";

const BASE_CHAIN_ID = 8453;
const ZERO_BYTES32 = `0x${"00".repeat(32)}` as const;

const conditionalTokensIface = new Interface([
  "function redeemPositions(address collateralToken,bytes32 parentCollectionId,bytes32 conditionId,uint256[] indexSets)",
  "function balanceOf(address account,uint256 id) view returns (uint256)",
  "function payoutDenominator(bytes32 conditionId) view returns (uint256)",
  "function payoutNumerators(bytes32 conditionId,uint256 index) view returns (uint256)",
]);

const negRiskAdapterIface = new Interface([
  "function redeemPositions(bytes32 conditionId,uint256[] amounts)",
]);

type LimitlessRedemptionPlanInputs = {
  rpcUrl: string;
  timeoutMs: number;
  owner: string;
  conditionId: string;
  tokenId: string;
  outcome: "YES" | "NO";
  isNegRisk: boolean;
  adapterAddress?: string | null;
};

function decodeBigInt(decoded: unknown): bigint {
  const value = Array.isArray(decoded) ? decoded[0] : null;
  if (typeof value !== "bigint") {
    throw new Error("Invalid bigint result");
  }
  return value;
}

async function readConditionPayout(inputs: {
  rpcUrl: string;
  timeoutMs: number;
  conditionalTokensAddress: string;
  conditionId: `0x${string}`;
}): Promise<{
  conditionResolved: boolean;
  resolvedOutcome: "YES" | "NO" | null;
  resolvedOutcomePct: number | null;
}> {
  const payoutDenominator = await safeEvmReadContract<bigint>({
    rpcUrl: inputs.rpcUrl,
    timeoutMs: inputs.timeoutMs,
    target: inputs.conditionalTokensAddress,
    iface: conditionalTokensIface,
    functionName: "payoutDenominator",
    args: [inputs.conditionId],
    decode: decodeBigInt,
  });
  if (payoutDenominator <= 0n) {
    return {
      conditionResolved: false,
      resolvedOutcome: null,
      resolvedOutcomePct: null,
    };
  }

  const [yesRaw, noRaw] = await Promise.all([
    safeEvmReadContract<bigint>({
      rpcUrl: inputs.rpcUrl,
      timeoutMs: inputs.timeoutMs,
      target: inputs.conditionalTokensAddress,
      iface: conditionalTokensIface,
      functionName: "payoutNumerators",
      args: [inputs.conditionId, 0n],
      decode: decodeBigInt,
    }),
    safeEvmReadContract<bigint>({
      rpcUrl: inputs.rpcUrl,
      timeoutMs: inputs.timeoutMs,
      target: inputs.conditionalTokensAddress,
      iface: conditionalTokensIface,
      functionName: "payoutNumerators",
      args: [inputs.conditionId, 1n],
      decode: decodeBigInt,
    }),
  ]);

  const resolvedOutcome = yesRaw > noRaw ? "YES" : noRaw > yesRaw ? "NO" : null;
  const pctBasisPoints = Number((yesRaw * 10_000n) / payoutDenominator);

  return {
    conditionResolved: true,
    resolvedOutcome,
    resolvedOutcomePct: Number.isFinite(pctBasisPoints) ? pctBasisPoints : null,
  };
}

export async function buildLimitlessRedemptionPlan(
  inputs: LimitlessRedemptionPlanInputs,
): Promise<RedemptionPlan> {
  const ownerAddress = ethers.getAddress(inputs.owner);
  const conditionId = inputs.conditionId as `0x${string}`;
  const conditionalTokensAddress = ethers.getAddress(
    env.limitlessConditionalTokensAddress,
  );
  const indexSet = inputs.outcome === "YES" ? 1n : 2n;
  const rawTokenId = normalizeLimitlessRawTokenId(inputs.tokenId);

  let tokenId: bigint;
  try {
    tokenId = BigInt(rawTokenId ?? "");
  } catch {
    return buildUnavailableRedemptionPlan({
      venue: "limitless",
      chainId: BASE_CHAIN_ID,
      reason: "missing_token_id",
      reasonMessage: "Unsupported position token id.",
    });
  }

  try {
    const condition = await readConditionPayout({
      rpcUrl: inputs.rpcUrl,
      timeoutMs: inputs.timeoutMs,
      conditionalTokensAddress,
      conditionId,
    });
    if (!condition.conditionResolved) {
      return buildUnavailableRedemptionPlan({
        venue: "limitless",
        chainId: BASE_CHAIN_ID,
        reason: "condition_unresolved",
        reasonMessage: "Condition not resolved on-chain yet.",
        conditionResolved: false,
      });
    }

    const balance = await safeEvmReadContract<bigint>({
      rpcUrl: inputs.rpcUrl,
      timeoutMs: inputs.timeoutMs,
      target: conditionalTokensAddress,
      iface: conditionalTokensIface,
      functionName: "balanceOf",
      args: [ownerAddress, tokenId],
      decode: decodeBigInt,
    });

    if (balance <= 0n) {
      return buildUnavailableRedemptionPlan({
        venue: "limitless",
        chainId: BASE_CHAIN_ID,
        reason: "no_redeemable_balance",
        reasonMessage: "No redeemable balance found for this position.",
        conditionResolved: true,
        resolvedOutcome: condition.resolvedOutcome,
        resolvedOutcomePct: condition.resolvedOutcomePct,
      });
    }

    if (inputs.isNegRisk) {
      if (!inputs.adapterAddress) {
        return buildUnavailableRedemptionPlan({
          venue: "limitless",
          chainId: BASE_CHAIN_ID,
          reason: "adapter_unavailable",
          reasonMessage: "Neg-risk adapter address unavailable.",
          conditionResolved: true,
          resolvedOutcome: condition.resolvedOutcome,
          resolvedOutcomePct: condition.resolvedOutcomePct,
        });
      }
      const adapterAddress = ethers.getAddress(inputs.adapterAddress);
      const amounts = inputs.outcome === "YES" ? [balance, 0n] : [0n, balance];
      const data = negRiskAdapterIface.encodeFunctionData("redeemPositions", [
        conditionId,
        amounts,
      ]);
      return buildReadyRedemptionPlan({
        venue: "limitless",
        chainId: BASE_CHAIN_ID,
        targetAddress: adapterAddress,
        data,
        conditionResolved: true,
        resolvedOutcome: condition.resolvedOutcome,
        resolvedOutcomePct: condition.resolvedOutcomePct,
      });
    }

    const data = conditionalTokensIface.encodeFunctionData("redeemPositions", [
      env.limitlessUsdcAddress,
      ZERO_BYTES32,
      conditionId,
      [indexSet],
    ]);
    return buildReadyRedemptionPlan({
      venue: "limitless",
      chainId: BASE_CHAIN_ID,
      targetAddress: conditionalTokensAddress,
      data,
      conditionResolved: true,
      resolvedOutcome: condition.resolvedOutcome,
      resolvedOutcomePct: condition.resolvedOutcomePct,
    });
  } catch (error) {
    if (error instanceof SafeEvmReadError) {
      return buildPreflightFailurePlan({
        venue: "limitless",
        chainId: BASE_CHAIN_ID,
        error,
      });
    }
    throw error;
  }
}
