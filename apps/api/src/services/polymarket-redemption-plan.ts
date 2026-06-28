import { Interface, ethers } from "ethers";
import {
  buildPreflightFailurePlan,
  buildReadyRedemptionPlan,
  buildUnavailableRedemptionPlan,
  type RedemptionPlan,
} from "./redemption-plan.js";
import { SafeEvmReadError, safeEvmReadContract } from "./safe-evm-read.js";

const POLY_CHAIN_ID = 137;
const ZERO_BYTES32 = `0x${"00".repeat(32)}` as const;

const conditionalTokensIface = new Interface([
  "function redeemPositions(address collateralToken,bytes32 parentCollectionId,bytes32 conditionId,uint256[] indexSets)",
  "function getCollectionId(bytes32 parentCollectionId,bytes32 conditionId,uint256 indexSet) view returns (bytes32)",
  "function getPositionId(address collateralToken,bytes32 collectionId) view returns (uint256)",
  "function getConditionId(address oracle,bytes32 questionId,uint256 outcomeSlotCount) view returns (bytes32)",
  "function balanceOf(address account,uint256 id) view returns (uint256)",
  "function payoutDenominator(bytes32 conditionId) view returns (uint256)",
  "function payoutNumerators(bytes32 conditionId,uint256 index) view returns (uint256)",
]);

const negRiskAdapterIface = new Interface([
  "function redeemPositions(bytes32 conditionId,uint256[] amounts)",
  "function col() view returns (address)",
  "function wcol() view returns (address)",
]);

const ctfCollateralAdapterIface = new Interface([
  "function redeemPositions(address collateralToken,bytes32 parentCollectionId,bytes32 conditionId,uint256[] indexSets)",
  "function COLLATERAL_TOKEN() view returns (address)",
  "function USDCE() view returns (address)",
  "function CONDITIONAL_TOKENS() view returns (address)",
]);

const negRiskCollateralAdapterIface = new Interface([
  "function redeemPositions(address collateralToken,bytes32 parentCollectionId,bytes32 conditionId,uint256[] indexSets)",
  "function COLLATERAL_TOKEN() view returns (address)",
  "function USDCE() view returns (address)",
  "function WRAPPED_COLLATERAL() view returns (address)",
  "function NEG_RISK_ADAPTER() view returns (address)",
  "function CONDITIONAL_TOKENS() view returns (address)",
]);

type PolymarketRedemptionPlanInputs = {
  rpcUrl: string;
  timeoutMs: number;
  funder: string;
  conditionalTokensAddress: string;
  collateralTokenAddress: string;
  legacyCollateralTokenAddress?: string | null;
  negRiskAdapterAddress: string | null;
  ctfCollateralAdapterAddress?: string | null;
  negRiskCollateralAdapterAddress?: string | null;
  outcome: "YES" | "NO";
  positionTokenId: string;
  conditionId?: string | null;
  questionId?: string | null;
  negRiskParentConditionId?: string | null;
  negRiskRequestId?: string | null;
  isNegRisk: boolean;
};

function normalizeBytes32(
  value: string | null | undefined,
): `0x${string}` | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!/^0x[a-fA-F0-9]{64}$/.test(trimmed)) return null;
  return trimmed as `0x${string}`;
}

function normalizeOptionalAddress(
  value: string | null | undefined,
): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  try {
    return ethers.getAddress(trimmed);
  } catch {
    return null;
  }
}

function decodeBigInt(decoded: unknown): bigint {
  const value = Array.isArray(decoded) ? decoded[0] : null;
  if (typeof value !== "bigint") {
    throw new Error("Invalid bigint result");
  }
  return value;
}

function decodeAddress(decoded: unknown): `0x${string}` {
  const value = Array.isArray(decoded) ? decoded[0] : null;
  if (typeof value !== "string") {
    throw new Error("Invalid address result");
  }
  return ethers.getAddress(value) as `0x${string}`;
}

function decodeBytes32(decoded: unknown): `0x${string}` {
  const value = Array.isArray(decoded) ? decoded[0] : null;
  if (typeof value !== "string" || !/^0x[a-fA-F0-9]{64}$/.test(value)) {
    throw new Error("Invalid bytes32 result");
  }
  return value as `0x${string}`;
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
  payoutDenominator: bigint;
  yesPayoutNumerator: bigint;
  noPayoutNumerator: bigint;
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
      payoutDenominator,
      yesPayoutNumerator: 0n,
      noPayoutNumerator: 0n,
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
    payoutDenominator,
    yesPayoutNumerator: yesRaw,
    noPayoutNumerator: noRaw,
  };
}

async function buildStandardConditionalRedemptionPlan(inputs: {
  rpcUrl: string;
  timeoutMs: number;
  funderAddress: string;
  conditionalTokensAddress: string;
  collateralTokenAddress: string;
  targetAddress?: string | null;
  redeemCollateralTokenAddress?: string | null;
  payoutTokenAddress?: string | null;
  operatorApprovalAddress?: string | null;
  conditionId: `0x${string}`;
  indexSet: bigint;
  payout: Awaited<ReturnType<typeof readConditionPayout>>;
}): Promise<RedemptionPlan> {
  const collectionId = await safeEvmReadContract<`0x${string}`>({
    rpcUrl: inputs.rpcUrl,
    timeoutMs: inputs.timeoutMs,
    target: inputs.conditionalTokensAddress,
    iface: conditionalTokensIface,
    functionName: "getCollectionId",
    args: [ZERO_BYTES32, inputs.conditionId, inputs.indexSet],
    decode: decodeBytes32,
  });
  const positionId = await safeEvmReadContract<bigint>({
    rpcUrl: inputs.rpcUrl,
    timeoutMs: inputs.timeoutMs,
    target: inputs.conditionalTokensAddress,
    iface: conditionalTokensIface,
    functionName: "getPositionId",
    args: [inputs.collateralTokenAddress, collectionId],
    decode: decodeBigInt,
  });
  const balance = await safeEvmReadContract<bigint>({
    rpcUrl: inputs.rpcUrl,
    timeoutMs: inputs.timeoutMs,
    target: inputs.conditionalTokensAddress,
    iface: conditionalTokensIface,
    functionName: "balanceOf",
    args: [inputs.funderAddress, positionId],
    decode: decodeBigInt,
  });
  if (balance <= 0n) {
    return buildUnavailableRedemptionPlan({
      venue: "polymarket",
      chainId: POLY_CHAIN_ID,
      reason: "no_redeemable_balance",
      reasonMessage: "No redeemable balance found for this position.",
      conditionResolved: true,
      resolvedOutcome: inputs.payout.resolvedOutcome,
      resolvedOutcomePct: inputs.payout.resolvedOutcomePct,
    });
  }

  const data = conditionalTokensIface.encodeFunctionData("redeemPositions", [
    inputs.redeemCollateralTokenAddress ?? inputs.collateralTokenAddress,
    ZERO_BYTES32,
    inputs.conditionId,
    [inputs.indexSet],
  ]);
  const payoutTokenAddress =
    inputs.payoutTokenAddress ?? inputs.collateralTokenAddress;
  const payoutNumerator =
    inputs.indexSet === 1n
      ? inputs.payout.yesPayoutNumerator
      : inputs.payout.noPayoutNumerator;
  const payoutAmountRaw =
    inputs.payout.payoutDenominator > 0n && payoutNumerator > 0n
      ? (balance * payoutNumerator) / inputs.payout.payoutDenominator
      : 0n;
  return buildReadyRedemptionPlan({
    venue: "polymarket",
    chainId: POLY_CHAIN_ID,
    targetAddress: inputs.targetAddress ?? inputs.conditionalTokensAddress,
    data,
    collateralTokenAddress: payoutTokenAddress,
    payoutTokenAddress,
    operatorApprovalAddress: inputs.operatorApprovalAddress ?? null,
    payoutAmountRaw: payoutAmountRaw.toString(),
    conditionResolved: true,
    resolvedOutcome: inputs.payout.resolvedOutcome,
    resolvedOutcomePct: inputs.payout.resolvedOutcomePct,
  });
}

async function readValidatedCtfCollateralAdapter(inputs: {
  rpcUrl: string;
  timeoutMs: number;
  adapterAddress: string | null;
  collateralTokenAddress: string;
  legacyCollateralTokenAddress: string | null;
  conditionalTokensAddress: string;
}): Promise<string | null> {
  const adapterAddress = normalizeOptionalAddress(inputs.adapterAddress);
  if (!adapterAddress || !inputs.legacyCollateralTokenAddress) return null;
  try {
    const [adapterCollateral, adapterUsdce, adapterConditionalTokens] =
      await Promise.all([
        safeEvmReadContract<`0x${string}`>({
          rpcUrl: inputs.rpcUrl,
          timeoutMs: inputs.timeoutMs,
          target: adapterAddress,
          iface: ctfCollateralAdapterIface,
          functionName: "COLLATERAL_TOKEN",
          decode: decodeAddress,
        }),
        safeEvmReadContract<`0x${string}`>({
          rpcUrl: inputs.rpcUrl,
          timeoutMs: inputs.timeoutMs,
          target: adapterAddress,
          iface: ctfCollateralAdapterIface,
          functionName: "USDCE",
          decode: decodeAddress,
        }),
        safeEvmReadContract<`0x${string}`>({
          rpcUrl: inputs.rpcUrl,
          timeoutMs: inputs.timeoutMs,
          target: adapterAddress,
          iface: ctfCollateralAdapterIface,
          functionName: "CONDITIONAL_TOKENS",
          decode: decodeAddress,
        }),
      ]);
    if (
      adapterCollateral !== inputs.collateralTokenAddress ||
      adapterUsdce !== inputs.legacyCollateralTokenAddress ||
      adapterConditionalTokens !== inputs.conditionalTokensAddress
    ) {
      return null;
    }
    return adapterAddress;
  } catch (error) {
    if (error instanceof SafeEvmReadError) return null;
    throw error;
  }
}

async function readValidatedNegRiskCollateralAdapter(inputs: {
  rpcUrl: string;
  timeoutMs: number;
  adapterAddress: string | null;
  collateralTokenAddress: string;
  legacyCollateralTokenAddress: string | null;
  wrappedCollateralAddress: string;
  legacyNegRiskAdapterAddress: string;
  conditionalTokensAddress: string;
}): Promise<string | null> {
  const adapterAddress = normalizeOptionalAddress(inputs.adapterAddress);
  if (!adapterAddress || !inputs.legacyCollateralTokenAddress) return null;
  try {
    const [
      adapterCollateral,
      adapterUsdce,
      adapterWrappedCollateral,
      adapterLegacyNegRisk,
      adapterConditionalTokens,
    ] = await Promise.all([
      safeEvmReadContract<`0x${string}`>({
        rpcUrl: inputs.rpcUrl,
        timeoutMs: inputs.timeoutMs,
        target: adapterAddress,
        iface: negRiskCollateralAdapterIface,
        functionName: "COLLATERAL_TOKEN",
        decode: decodeAddress,
      }),
      safeEvmReadContract<`0x${string}`>({
        rpcUrl: inputs.rpcUrl,
        timeoutMs: inputs.timeoutMs,
        target: adapterAddress,
        iface: negRiskCollateralAdapterIface,
        functionName: "USDCE",
        decode: decodeAddress,
      }),
      safeEvmReadContract<`0x${string}`>({
        rpcUrl: inputs.rpcUrl,
        timeoutMs: inputs.timeoutMs,
        target: adapterAddress,
        iface: negRiskCollateralAdapterIface,
        functionName: "WRAPPED_COLLATERAL",
        decode: decodeAddress,
      }),
      safeEvmReadContract<`0x${string}`>({
        rpcUrl: inputs.rpcUrl,
        timeoutMs: inputs.timeoutMs,
        target: adapterAddress,
        iface: negRiskCollateralAdapterIface,
        functionName: "NEG_RISK_ADAPTER",
        decode: decodeAddress,
      }),
      safeEvmReadContract<`0x${string}`>({
        rpcUrl: inputs.rpcUrl,
        timeoutMs: inputs.timeoutMs,
        target: adapterAddress,
        iface: negRiskCollateralAdapterIface,
        functionName: "CONDITIONAL_TOKENS",
        decode: decodeAddress,
      }),
    ]);
    if (
      adapterCollateral !== inputs.collateralTokenAddress ||
      adapterUsdce !== inputs.legacyCollateralTokenAddress ||
      adapterWrappedCollateral !== inputs.wrappedCollateralAddress ||
      adapterLegacyNegRisk !== inputs.legacyNegRiskAdapterAddress ||
      adapterConditionalTokens !== inputs.conditionalTokensAddress
    ) {
      return null;
    }
    return adapterAddress;
  } catch (error) {
    if (error instanceof SafeEvmReadError) return null;
    throw error;
  }
}

export async function buildPolymarketRedemptionPlan(
  inputs: PolymarketRedemptionPlanInputs,
): Promise<RedemptionPlan> {
  const conditionalTokensAddress = ethers.getAddress(
    inputs.conditionalTokensAddress,
  );
  const collateralTokenAddress = ethers.getAddress(
    inputs.collateralTokenAddress,
  );
  const legacyCollateralTokenAddress = normalizeOptionalAddress(
    inputs.legacyCollateralTokenAddress,
  );
  const funderAddress = ethers.getAddress(inputs.funder);
  const indexSet = inputs.outcome === "YES" ? 1n : 2n;

  if (!inputs.isNegRisk) {
    const conditionId = normalizeBytes32(inputs.conditionId);
    if (!conditionId) {
      return buildUnavailableRedemptionPlan({
        venue: "polymarket",
        chainId: POLY_CHAIN_ID,
        reason: "missing_condition_id",
        reasonMessage: "Missing condition id.",
      });
    }

    try {
      const payout = await readConditionPayout({
        rpcUrl: inputs.rpcUrl,
        timeoutMs: inputs.timeoutMs,
        conditionalTokensAddress,
        conditionId,
      });
      if (!payout.conditionResolved) {
        return buildUnavailableRedemptionPlan({
          venue: "polymarket",
          chainId: POLY_CHAIN_ID,
          reason: "condition_unresolved",
          reasonMessage: "Condition not resolved on-chain yet.",
          conditionResolved: false,
        });
      }

      const includeLegacyCollateral =
        legacyCollateralTokenAddress != null &&
        legacyCollateralTokenAddress !== collateralTokenAddress;
      const collateralCandidates = [
        collateralTokenAddress,
        ...(includeLegacyCollateral ? [legacyCollateralTokenAddress] : []),
      ];
      let noBalancePlan: RedemptionPlan | null = null;
      const ctfCollateralAdapterAddress =
        await readValidatedCtfCollateralAdapter({
          rpcUrl: inputs.rpcUrl,
          timeoutMs: inputs.timeoutMs,
          adapterAddress: inputs.ctfCollateralAdapterAddress ?? null,
          collateralTokenAddress,
          legacyCollateralTokenAddress,
          conditionalTokensAddress,
        });
      for (const candidateCollateral of collateralCandidates) {
        const useCollateralAdapter =
          candidateCollateral === legacyCollateralTokenAddress &&
          ctfCollateralAdapterAddress != null;
        const plan = await buildStandardConditionalRedemptionPlan({
          rpcUrl: inputs.rpcUrl,
          timeoutMs: inputs.timeoutMs,
          funderAddress,
          conditionalTokensAddress,
          collateralTokenAddress: candidateCollateral,
          targetAddress: useCollateralAdapter
            ? ctfCollateralAdapterAddress
            : null,
          payoutTokenAddress: useCollateralAdapter
            ? collateralTokenAddress
            : candidateCollateral,
          operatorApprovalAddress: useCollateralAdapter
            ? ctfCollateralAdapterAddress
            : null,
          conditionId,
          indexSet,
          payout,
        });
        if (plan.redeemable) return plan;
        noBalancePlan ??= plan;
      }

      return (
        noBalancePlan ??
        buildUnavailableRedemptionPlan({
          venue: "polymarket",
          chainId: POLY_CHAIN_ID,
          reason: "no_redeemable_balance",
          reasonMessage: "No redeemable balance found for this position.",
          conditionResolved: true,
          resolvedOutcome: payout.resolvedOutcome,
          resolvedOutcomePct: payout.resolvedOutcomePct,
        })
      );
    } catch (error) {
      if (error instanceof SafeEvmReadError) {
        return buildPreflightFailurePlan({
          venue: "polymarket",
          chainId: POLY_CHAIN_ID,
          error,
        });
      }
      throw error;
    }
  }

  let positionTokenId: bigint | null = null;
  if (inputs.positionTokenId.trim().length > 0) {
    try {
      positionTokenId = BigInt(inputs.positionTokenId);
    } catch {
      positionTokenId = null;
    }
  }

  const negRiskAdapterAddress = inputs.negRiskAdapterAddress
    ? ethers.getAddress(inputs.negRiskAdapterAddress)
    : null;
  if (!negRiskAdapterAddress) {
    return buildUnavailableRedemptionPlan({
      venue: "polymarket",
      chainId: POLY_CHAIN_ID,
      reason: "adapter_unavailable",
      reasonMessage: "Neg-risk adapter address unavailable.",
    });
  }

  try {
    const getConditionId = async (
      questionId: `0x${string}` | null,
    ): Promise<`0x${string}` | null> => {
      if (!questionId) return null;
      return safeEvmReadContract<`0x${string}`>({
        rpcUrl: inputs.rpcUrl,
        timeoutMs: inputs.timeoutMs,
        target: conditionalTokensAddress,
        iface: conditionalTokensIface,
        functionName: "getConditionId",
        args: [negRiskAdapterAddress, questionId, 2n],
        decode: decodeBytes32,
      });
    };

    const baseConditionId = normalizeBytes32(inputs.conditionId);
    const questionConditionId = await getConditionId(
      normalizeBytes32(inputs.questionId),
    );
    const parentConditionId = normalizeBytes32(inputs.negRiskParentConditionId);
    const parentQuestionConditionId = await getConditionId(
      normalizeBytes32(inputs.negRiskRequestId),
    );
    const candidateConditionIds = Array.from(
      new Set(
        [
          baseConditionId,
          questionConditionId,
          parentConditionId,
          parentQuestionConditionId,
        ].filter(Boolean) as `0x${string}`[],
      ),
    );
    if (candidateConditionIds.length === 0) {
      return buildUnavailableRedemptionPlan({
        venue: "polymarket",
        chainId: POLY_CHAIN_ID,
        reason: "missing_condition_id",
        reasonMessage: "Missing neg-risk condition id.",
      });
    }

    const wrappedCollateralAddress = await safeEvmReadContract<`0x${string}`>({
      rpcUrl: inputs.rpcUrl,
      timeoutMs: inputs.timeoutMs,
      target: negRiskAdapterAddress,
      iface: negRiskAdapterIface,
      functionName: "wcol",
      decode: decodeAddress,
    });

    const negRiskCollateralAdapterAddress =
      await readValidatedNegRiskCollateralAdapter({
        rpcUrl: inputs.rpcUrl,
        timeoutMs: inputs.timeoutMs,
        adapterAddress: inputs.negRiskCollateralAdapterAddress ?? null,
        collateralTokenAddress,
        legacyCollateralTokenAddress,
        wrappedCollateralAddress,
        legacyNegRiskAdapterAddress: negRiskAdapterAddress,
        conditionalTokensAddress,
      });

    let selectedConditionId: `0x${string}` | null = null;
    let selectedBalance: bigint | null = null;
    for (const candidateConditionId of candidateConditionIds) {
      const collectionId = await safeEvmReadContract<`0x${string}`>({
        rpcUrl: inputs.rpcUrl,
        timeoutMs: inputs.timeoutMs,
        target: conditionalTokensAddress,
        iface: conditionalTokensIface,
        functionName: "getCollectionId",
        args: [ZERO_BYTES32, candidateConditionId, indexSet],
        decode: decodeBytes32,
      });
      const candidatePositionId = await safeEvmReadContract<bigint>({
        rpcUrl: inputs.rpcUrl,
        timeoutMs: inputs.timeoutMs,
        target: conditionalTokensAddress,
        iface: conditionalTokensIface,
        functionName: "getPositionId",
        args: [wrappedCollateralAddress, collectionId],
        decode: decodeBigInt,
      });
      const candidateBalance = await safeEvmReadContract<bigint>({
        rpcUrl: inputs.rpcUrl,
        timeoutMs: inputs.timeoutMs,
        target: conditionalTokensAddress,
        iface: conditionalTokensIface,
        functionName: "balanceOf",
        args: [funderAddress, candidatePositionId],
        decode: decodeBigInt,
      });
      if (candidateBalance <= 0n) continue;
      const matchesPosition =
        positionTokenId != null && candidatePositionId === positionTokenId;
      if (!selectedConditionId || matchesPosition) {
        selectedConditionId = candidateConditionId;
        selectedBalance = candidateBalance;
      }
      if (matchesPosition) break;
    }

    if (!selectedConditionId || selectedBalance == null) {
      return buildUnavailableRedemptionPlan({
        venue: "polymarket",
        chainId: POLY_CHAIN_ID,
        reason: "no_redeemable_balance",
        reasonMessage: "No redeemable balance found for this position.",
      });
    }

    const payout = await readConditionPayout({
      rpcUrl: inputs.rpcUrl,
      timeoutMs: inputs.timeoutMs,
      conditionalTokensAddress,
      conditionId: selectedConditionId,
    });
    if (!payout.conditionResolved) {
      return buildUnavailableRedemptionPlan({
        venue: "polymarket",
        chainId: POLY_CHAIN_ID,
        reason: "condition_unresolved",
        reasonMessage: "Condition not resolved on-chain yet.",
        conditionResolved: false,
      });
    }

    const amounts =
      inputs.outcome === "YES" ? [selectedBalance, 0n] : [0n, selectedBalance];
    const payoutNumerator =
      inputs.outcome === "YES"
        ? payout.yesPayoutNumerator
        : payout.noPayoutNumerator;
    const payoutAmountRaw =
      payout.payoutDenominator > 0n && payoutNumerator > 0n
        ? (selectedBalance * payoutNumerator) / payout.payoutDenominator
        : 0n;
    const usesCollateralAdapter = negRiskCollateralAdapterAddress != null;
    let payoutTokenAddress = collateralTokenAddress;
    if (!usesCollateralAdapter) {
      payoutTokenAddress = await safeEvmReadContract<`0x${string}`>({
        rpcUrl: inputs.rpcUrl,
        timeoutMs: inputs.timeoutMs,
        target: negRiskAdapterAddress,
        iface: negRiskAdapterIface,
        functionName: "col",
        decode: decodeAddress,
      });
    }
    const data = usesCollateralAdapter
      ? conditionalTokensIface.encodeFunctionData("redeemPositions", [
          wrappedCollateralAddress,
          ZERO_BYTES32,
          selectedConditionId,
          [indexSet],
        ])
      : negRiskAdapterIface.encodeFunctionData("redeemPositions", [
          selectedConditionId,
          amounts,
        ]);
    const targetAddress = usesCollateralAdapter
      ? negRiskCollateralAdapterAddress
      : negRiskAdapterAddress;
    return buildReadyRedemptionPlan({
      venue: "polymarket",
      chainId: POLY_CHAIN_ID,
      targetAddress,
      data,
      collateralTokenAddress: payoutTokenAddress,
      payoutTokenAddress,
      operatorApprovalAddress: usesCollateralAdapter
        ? negRiskCollateralAdapterAddress
        : negRiskAdapterAddress,
      payoutAmountRaw: payoutAmountRaw.toString(),
      conditionResolved: true,
      resolvedOutcome: payout.resolvedOutcome,
      resolvedOutcomePct: payout.resolvedOutcomePct,
    });
  } catch (error) {
    if (error instanceof SafeEvmReadError) {
      return buildPreflightFailurePlan({
        venue: "polymarket",
        chainId: POLY_CHAIN_ID,
        error,
      });
    }
    throw error;
  }
}
