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
  "function getCollectionId(bytes32 parentCollectionId,bytes32 conditionId,uint256 indexSet) view returns (bytes32)",
  "function getPositionId(address collateralToken,bytes32 collectionId) view returns (uint256)",
  "function getConditionId(address oracle,bytes32 questionId,uint256 outcomeSlotCount) view returns (bytes32)",
  "function balanceOf(address account,uint256 id) view returns (uint256)",
  "function payoutDenominator(bytes32 conditionId) view returns (uint256)",
  "function payoutNumerators(bytes32 conditionId,uint256 index) view returns (uint256)",
]);
const collateralAdapterIface = new Interface([
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
const legacyNegRiskIface = new Interface([
  "function wcol() view returns (address)",
]);
type Inputs = {
  rpcUrl: string;
  timeoutMs: number;
  funder: string;
  conditionalTokensAddress: string;
  collateralTokenAddress: string;
  legacyCollateralTokenAddress?: string | null;
  negRiskAdapterAddress: string | null;
  ctfCollateralAdapterAddress?: string | null;
  negRiskCollateralAdapterAddress?: string | null;
  executionKind?: "external_adapter";
  outcome: "YES" | "NO";
  positionTokenId: string;
  conditionId?: string | null;
  questionId?: string | null;
  negRiskParentConditionId?: string | null;
  negRiskRequestId?: string | null;
  isNegRisk: boolean;
};

function bytes32(value: string | null | undefined): `0x${string}` | null {
  const trimmed = value?.trim() ?? "";
  return /^0x[a-fA-F0-9]{64}$/.test(trimmed)
    ? (trimmed as `0x${string}`)
    : null;
}

function address(value: string | null | undefined): `0x${string}` | null {
  try {
    return value ? (ethers.getAddress(value) as `0x${string}`) : null;
  } catch {
    return null;
  }
}

function decodeBigInt(decoded: unknown): bigint {
  const value = Array.isArray(decoded) ? decoded[0] : null;
  if (typeof value !== "bigint") throw new Error("Invalid bigint result");
  return value;
}

function decodeAddress(decoded: unknown): `0x${string}` {
  const value = Array.isArray(decoded) ? decoded[0] : null;
  if (typeof value !== "string") throw new Error("Invalid address result");
  return ethers.getAddress(value) as `0x${string}`;
}

function decodeBytes32(decoded: unknown): `0x${string}` {
  const value = Array.isArray(decoded) ? decoded[0] : null;
  if (typeof value !== "string" || !/^0x[a-fA-F0-9]{64}$/.test(value)) {
    throw new Error("Invalid bytes32 result");
  }
  return value as `0x${string}`;
}

async function read<T>(input: {
  inputs: Inputs;
  target: string;
  iface: Interface;
  functionName: string;
  args?: unknown[];
  decode: (decoded: unknown) => T;
}): Promise<T> {
  return safeEvmReadContract<T>({
    rpcUrl: input.inputs.rpcUrl,
    timeoutMs: input.inputs.timeoutMs,
    target: input.target,
    iface: input.iface,
    functionName: input.functionName,
    args: input.args,
    decode: input.decode,
  });
}

async function validateAdapter(input: {
  inputs: Inputs;
  adapter: string;
  negRisk: boolean;
  wrappedCollateral?: string | null;
}): Promise<boolean> {
  const usdce = address(input.inputs.legacyCollateralTokenAddress);
  if (!usdce) return false;
  const iface = input.negRisk
    ? negRiskCollateralAdapterIface
    : collateralAdapterIface;
  const common = await Promise.all([
    read({
      inputs: input.inputs,
      target: input.adapter,
      iface,
      functionName: "COLLATERAL_TOKEN",
      decode: decodeAddress,
    }),
    read({
      inputs: input.inputs,
      target: input.adapter,
      iface,
      functionName: "USDCE",
      decode: decodeAddress,
    }),
    read({
      inputs: input.inputs,
      target: input.adapter,
      iface,
      functionName: "CONDITIONAL_TOKENS",
      decode: decodeAddress,
    }),
  ]);
  if (
    common[0] !== ethers.getAddress(input.inputs.collateralTokenAddress) ||
    common[1] !== usdce ||
    common[2] !== ethers.getAddress(input.inputs.conditionalTokensAddress)
  )
    return false;
  if (!input.negRisk) return true;
  const [wrapped, legacy] = await Promise.all([
    read({
      inputs: input.inputs,
      target: input.adapter,
      iface,
      functionName: "WRAPPED_COLLATERAL",
      decode: decodeAddress,
    }),
    read({
      inputs: input.inputs,
      target: input.adapter,
      iface,
      functionName: "NEG_RISK_ADAPTER",
      decode: decodeAddress,
    }),
  ]);
  return (
    wrapped === address(input.wrappedCollateral) &&
    legacy === address(input.inputs.negRiskAdapterAddress)
  );
}

async function conditionCandidates(inputs: Inputs): Promise<`0x${string}`[]> {
  if (!inputs.isNegRisk) {
    const condition = bytes32(inputs.conditionId);
    return condition ? [condition] : [];
  }
  const legacyAdapter = address(inputs.negRiskAdapterAddress);
  if (!legacyAdapter) return [];
  const candidates = [
    bytes32(inputs.conditionId),
    bytes32(inputs.negRiskParentConditionId),
  ];
  for (const question of [inputs.questionId, inputs.negRiskRequestId]) {
    const normalized = bytes32(question);
    if (!normalized) continue;
    candidates.push(
      await read({
        inputs,
        target: inputs.conditionalTokensAddress,
        iface: conditionalTokensIface,
        functionName: "getConditionId",
        args: [legacyAdapter, normalized, 2n],
        decode: decodeBytes32,
      }),
    );
  }
  return Array.from(new Set(candidates.filter(Boolean) as `0x${string}`[]));
}

async function inspectCondition(input: {
  inputs: Inputs;
  conditionId: `0x${string}`;
  positionCollateral: string;
}): Promise<{
  conditionId: `0x${string}`;
  denominator: bigint;
  noBalance: bigint;
  noNumerator: bigint;
  noTokenId: bigint;
  yesBalance: bigint;
  yesNumerator: bigint;
  yesTokenId: bigint;
}> {
  const { inputs, conditionId, positionCollateral } = input;
  const [denominator, yesNumerator, noNumerator, yesCollection, noCollection] =
    await Promise.all([
      read({
        inputs,
        target: inputs.conditionalTokensAddress,
        iface: conditionalTokensIface,
        functionName: "payoutDenominator",
        args: [conditionId],
        decode: decodeBigInt,
      }),
      read({
        inputs,
        target: inputs.conditionalTokensAddress,
        iface: conditionalTokensIface,
        functionName: "payoutNumerators",
        args: [conditionId, 0n],
        decode: decodeBigInt,
      }),
      read({
        inputs,
        target: inputs.conditionalTokensAddress,
        iface: conditionalTokensIface,
        functionName: "payoutNumerators",
        args: [conditionId, 1n],
        decode: decodeBigInt,
      }),
      read({
        inputs,
        target: inputs.conditionalTokensAddress,
        iface: conditionalTokensIface,
        functionName: "getCollectionId",
        args: [ZERO_BYTES32, conditionId, 1n],
        decode: decodeBytes32,
      }),
      read({
        inputs,
        target: inputs.conditionalTokensAddress,
        iface: conditionalTokensIface,
        functionName: "getCollectionId",
        args: [ZERO_BYTES32, conditionId, 2n],
        decode: decodeBytes32,
      }),
    ]);
  const [yesTokenId, noTokenId] = await Promise.all([
    read({
      inputs,
      target: inputs.conditionalTokensAddress,
      iface: conditionalTokensIface,
      functionName: "getPositionId",
      args: [positionCollateral, yesCollection],
      decode: decodeBigInt,
    }),
    read({
      inputs,
      target: inputs.conditionalTokensAddress,
      iface: conditionalTokensIface,
      functionName: "getPositionId",
      args: [positionCollateral, noCollection],
      decode: decodeBigInt,
    }),
  ]);
  const [yesBalance, noBalance] = await Promise.all([
    read({
      inputs,
      target: inputs.conditionalTokensAddress,
      iface: conditionalTokensIface,
      functionName: "balanceOf",
      args: [inputs.funder, yesTokenId],
      decode: decodeBigInt,
    }),
    read({
      inputs,
      target: inputs.conditionalTokensAddress,
      iface: conditionalTokensIface,
      functionName: "balanceOf",
      args: [inputs.funder, noTokenId],
      decode: decodeBigInt,
    }),
  ]);
  return {
    conditionId,
    denominator,
    noBalance,
    noNumerator,
    noTokenId,
    yesBalance,
    yesNumerator,
    yesTokenId,
  };
}

export async function buildPolymarketRedemptionPlan(
  inputs: Inputs,
): Promise<RedemptionPlan> {
  try {
    const usdce = address(inputs.legacyCollateralTokenAddress);
    const collateral = address(inputs.collateralTokenAddress);
    const standardAdapter = address(inputs.ctfCollateralAdapterAddress);
    const negRiskAdapter = address(inputs.negRiskCollateralAdapterAddress);
    if (!usdce || !collateral || (!inputs.isNegRisk && !standardAdapter)) {
      return buildUnavailableRedemptionPlan({
        venue: "polymarket",
        chainId: POLY_CHAIN_ID,
        reason: "adapter_unavailable",
        reasonMessage: "Canonical pUSD collateral adapter is unavailable.",
      });
    }
    const wrappedCollateral = inputs.isNegRisk
      ? await read({
          inputs,
          target: inputs.negRiskAdapterAddress ?? "",
          iface: legacyNegRiskIface,
          functionName: "wcol",
          decode: decodeAddress,
        })
      : null;
    const adapter = inputs.isNegRisk ? negRiskAdapter : standardAdapter;
    const positionCollateral = inputs.isNegRisk ? wrappedCollateral : usdce;
    if (
      !adapter ||
      !positionCollateral ||
      !(await validateAdapter({
        inputs,
        adapter,
        negRisk: inputs.isNegRisk,
        wrappedCollateral,
      }))
    ) {
      return buildUnavailableRedemptionPlan({
        venue: "polymarket",
        chainId: POLY_CHAIN_ID,
        reason: "adapter_unavailable",
        reasonMessage: "Canonical pUSD collateral adapter failed validation.",
      });
    }
    const candidates = await conditionCandidates(inputs);
    if (candidates.length === 0) {
      return buildUnavailableRedemptionPlan({
        venue: "polymarket",
        chainId: POLY_CHAIN_ID,
        reason: "missing_condition_id",
        reasonMessage: "Missing condition id.",
      });
    }
    const requestedTokenId = /^\d+$/.test(inputs.positionTokenId.trim())
      ? BigInt(inputs.positionTokenId.trim())
      : null;
    let selected: Awaited<ReturnType<typeof inspectCondition>> | null = null;
    for (const conditionId of candidates) {
      const inspected = await inspectCondition({
        inputs,
        conditionId,
        positionCollateral,
      });
      if (inspected.yesBalance === 0n && inspected.noBalance === 0n) continue;
      selected ??= inspected;
      if (
        requestedTokenId != null &&
        (inspected.yesTokenId === requestedTokenId ||
          inspected.noTokenId === requestedTokenId)
      ) {
        selected = inspected;
        break;
      }
    }
    if (!selected) {
      return buildUnavailableRedemptionPlan({
        venue: "polymarket",
        chainId: POLY_CHAIN_ID,
        reason: "no_redeemable_balance",
        reasonMessage: "No redeemable YES or NO balance was found.",
      });
    }
    if (selected.denominator <= 0n) {
      return buildUnavailableRedemptionPlan({
        venue: "polymarket",
        chainId: POLY_CHAIN_ID,
        reason: "condition_unresolved",
        reasonMessage: "Condition is not resolved on-chain yet.",
        conditionResolved: false,
      });
    }
    const expectedPayout =
      (selected.yesBalance * selected.yesNumerator +
        selected.noBalance * selected.noNumerator) /
      selected.denominator;
    const resolvedOutcome =
      selected.yesNumerator > selected.noNumerator
        ? "YES"
        : selected.noNumerator > selected.yesNumerator
          ? "NO"
          : null;
    const resolvedOutcomePct = Number(
      (selected.yesNumerator * 10_000n) / selected.denominator,
    );
    if (expectedPayout <= 0n) {
      return buildUnavailableRedemptionPlan({
        venue: "polymarket",
        chainId: POLY_CHAIN_ID,
        reason: "resolved_zero_payout",
        reasonMessage: "Resolved position has no payout.",
        conditionResolved: true,
        resolvedOutcome,
        resolvedOutcomePct,
      });
    }
    const executionKind = "external_adapter" as const;
    const targetAddress = adapter;
    if (!targetAddress) {
      return buildUnavailableRedemptionPlan({
        venue: "polymarket",
        chainId: POLY_CHAIN_ID,
        reason: "adapter_unavailable",
        reasonMessage: "Polymarket redemption target is unavailable.",
      });
    }
    const data = collateralAdapterIface.encodeFunctionData("redeemPositions", [
      positionCollateral,
      ZERO_BYTES32,
      selected.conditionId,
      [1n, 2n],
    ]);
    return buildReadyRedemptionPlan({
      venue: "polymarket",
      chainId: POLY_CHAIN_ID,
      targetAddress,
      data,
      collateralTokenAddress: collateral,
      payoutTokenAddress: collateral,
      operatorApprovalAddress: adapter,
      payoutAmountRaw: expectedPayout.toString(),
      expectedPayoutRaw: expectedPayout.toString(),
      yesBalanceRaw: selected.yesBalance.toString(),
      noBalanceRaw: selected.noBalance.toString(),
      executionKind,
      conditionResolved: true,
      resolvedOutcome,
      resolvedOutcomePct,
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
