import { Interface, ethers } from "ethers";
import {
  parsePolymarketAssetContext,
  polymarketV2PositionIdentity,
  POLYMARKET_PROTOCOL_CONTRACTS as CONTRACTS,
  type PolymarketAssetContext,
} from "@hunch/shared";
import {
  buildPreflightFailurePlan,
  buildReadyRedemptionPlan,
  buildUnavailableRedemptionPlan,
  type RedemptionPlan,
} from "./redemption-plan.js";
import { SafeEvmReadError, safeEvmReadContract } from "./safe-evm-read.js";

export const POLYMARKET_V2_ROUTER_ABI = new Interface([
  "function POSITION_MANAGER() view returns (address)",
  "function COLLATERAL_TOKEN() view returns (address)",
  "function redeem(bytes31 conditionId,uint256 outcome,uint256 amount)",
  "event RouterPositionRedeemed(address indexed initiator,uint256 indexed positionId,uint256 amount)",
]);
export const POLYMARKET_V2_POSITION_ABI = new Interface([
  "function COLLATERAL_TOKEN() view returns (address)",
  "function moduleById(uint256) view returns (address)",
  "function balanceOf(address,uint256) view returns (uint256)",
  "function getPayout(uint256,uint256) view returns (uint256)",
  "event TransferSingle(address indexed operator,address indexed from,address indexed to,uint256 id,uint256 value)",
  "event TransferBatch(address indexed operator,address indexed from,address indexed to,uint256[] ids,uint256[] values)",
]);
export const POLYMARKET_V2_MODULE_ABI = new Interface([
  "function getResult(bytes31) view returns (uint256[])",
  "event PositionRedeemed(address indexed initiator,uint256 indexed positionId,address indexed recipient,uint256 amount,uint256 payout)",
]);

/** Preserve the exact requested amount. Never redeem an enlarged current balance
 * merely because another fill arrived between inspection and submission. */
export async function buildPolymarketV2RedemptionPlan(inputs: {
  rpcUrl: string;
  timeoutMs: number;
  funder: string;
  assetContext: PolymarketAssetContext;
  positionSize: string;
}): Promise<RedemptionPlan> {
  const unavailable = (
    reason:
      | "adapter_unavailable"
      | "missing_token_id"
      | "no_redeemable_balance",
    reasonMessage: string,
  ) =>
    buildUnavailableRedemptionPlan({
      venue: "polymarket",
      chainId: 137,
      reason,
      reasonMessage,
    });
  const context = parsePolymarketAssetContext(inputs.assetContext);
  let identity: ReturnType<typeof polymarketV2PositionIdentity>;
  let amount: bigint;
  let owner: string;
  try {
    if (!context) throw new Error("Invalid V2 position context.");
    identity = polymarketV2PositionIdentity(context);
    owner = ethers.getAddress(inputs.funder);
  } catch {
    return unavailable(
      "missing_token_id",
      "Canonical V2 position identity is unavailable. Refresh the position.",
    );
  }
  try {
    amount = ethers.parseUnits(inputs.positionSize, 6);
    if (amount <= 0n || amount >= 1n << 256n)
      throw new Error("Invalid amount.");
  } catch {
    return unavailable(
      "no_redeemable_balance",
      "An exact positive position amount is required. Refresh the position.",
    );
  }
  const read = <T>(
    target: string,
    iface: Interface,
    functionName: string,
    args: unknown[] = [],
  ) =>
    safeEvmReadContract<T>({
      rpcUrl: inputs.rpcUrl,
      timeoutMs: inputs.timeoutMs,
      target,
      iface,
      functionName,
      args,
    });
  const equals = (left: string, right: string) =>
    left.toLowerCase() === right.toLowerCase();
  try {
    const [manager, collateral, managerCollateral, module, balance] =
      await Promise.all([
        read<string>(
          CONTRACTS.router,
          POLYMARKET_V2_ROUTER_ABI,
          "POSITION_MANAGER",
        ),
        read<string>(
          CONTRACTS.router,
          POLYMARKET_V2_ROUTER_ABI,
          "COLLATERAL_TOKEN",
        ),
        read<string>(
          CONTRACTS.positionManager,
          POLYMARKET_V2_POSITION_ABI,
          "COLLATERAL_TOKEN",
        ),
        read<string>(
          CONTRACTS.positionManager,
          POLYMARKET_V2_POSITION_ABI,
          "moduleById",
          [identity.moduleId],
        ),
        read<bigint>(
          CONTRACTS.positionManager,
          POLYMARKET_V2_POSITION_ABI,
          "balanceOf",
          [owner, identity.positionId],
        ),
      ]);
    if (
      !equals(manager, CONTRACTS.positionManager) ||
      !equals(collateral, CONTRACTS.collateral) ||
      !equals(managerCollateral, CONTRACTS.collateral) ||
      !equals(module, identity.moduleAddress)
    )
      return unavailable(
        "adapter_unavailable",
        "Canonical V2 Router or module failed validation. Retry after refresh.",
      );
    if (balance < amount)
      return unavailable(
        "no_redeemable_balance",
        "The position balance changed. Refresh before redeeming.",
      );
    const result = await read<readonly bigint[]>(
      module,
      POLYMARKET_V2_MODULE_ABI,
      "getResult",
      [identity.conditionId],
    );
    if (result.length === 0)
      return buildUnavailableRedemptionPlan({
        venue: "polymarket",
        chainId: 137,
        reason: "condition_unresolved",
        reasonMessage: "Condition is not resolved on-chain yet.",
        conditionResolved: false,
      });
    const yes = result[0];
    const no = result[1];
    if (
      result.length !== 2 ||
      typeof yes !== "bigint" ||
      typeof no !== "bigint" ||
      yes < 0n ||
      no < 0n ||
      yes + no !== 1_000_000n
    )
      return unavailable(
        "adapter_unavailable",
        "Canonical V2 resolution result failed validation. Retry after refresh.",
      );
    const expected =
      (amount * (context.outcomeIndex === 0 ? yes : no)) / 1_000_000n;
    const preview = await read<bigint>(
      CONTRACTS.positionManager,
      POLYMARKET_V2_POSITION_ABI,
      "getPayout",
      [identity.positionId, amount],
    );
    if (preview !== expected)
      return unavailable(
        "adapter_unavailable",
        "V2 payout preview changed. Refresh before redeeming.",
      );
    return buildReadyRedemptionPlan({
      venue: "polymarket",
      chainId: 137,
      targetAddress: CONTRACTS.router,
      data: POLYMARKET_V2_ROUTER_ABI.encodeFunctionData("redeem", [
        identity.conditionId,
        context.outcomeIndex,
        amount,
      ]),
      collateralTokenAddress: CONTRACTS.collateral,
      payoutTokenAddress: CONTRACTS.collateral,
      operatorApprovalAddress: CONTRACTS.router,
      executionKind: "protocol_router",
      positionContract: CONTRACTS.positionManager,
      assetContext: context,
      redeemAmountRaw: amount.toString(),
      moduleAddress: identity.moduleAddress,
      payoutAmountRaw: expected.toString(),
      expectedPayoutRaw: expected.toString(),
      yesBalanceRaw: context.outcomeIndex === 0 ? amount.toString() : "0",
      noBalanceRaw: context.outcomeIndex === 1 ? amount.toString() : "0",
      conditionResolved: true,
      resolvedOutcome: yes > no ? "YES" : no > yes ? "NO" : null,
      resolvedOutcomePct: Number(yes / 100n),
    });
  } catch (error) {
    if (error instanceof SafeEvmReadError)
      return buildPreflightFailurePlan({
        venue: "polymarket",
        chainId: 137,
        error,
      });
    throw error;
  }
}
