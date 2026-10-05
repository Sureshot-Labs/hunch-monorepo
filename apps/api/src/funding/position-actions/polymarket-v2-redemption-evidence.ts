import { ethers } from "ethers";
import {
  parsePolymarketAssetContext,
  polymarketV2PositionIdentity,
  POLYMARKET_PROTOCOL_CONTRACTS as CONTRACTS,
} from "@hunch/shared";
import { isRecord } from "../../lib/type-guards.js";
import type { EvmRpcTransactionReceipt } from "../../services/polygon-rpc.js";
import {
  POLYMARKET_V2_MODULE_ABI as MODULE,
  POLYMARKET_V2_POSITION_ABI as POSITION,
  POLYMARKET_V2_ROUTER_ABI as ROUTER,
} from "../../services/polymarket-v2-redemption-plan.js";
import { sumErc20TransfersTo } from "../execution/evm-erc20-receipt.js";
import type { StoredPositionAction } from "./position-action-repository.js";

const eq = (left: string, right: string) =>
  left.toLowerCase() === right.toLowerCase();
export const POLYMARKET_V2_REDEMPTION_TOPIC = ethers.id(
  "RouterPositionRedeemed(address,uint256,uint256)",
);

export function polymarketV2RedemptionIdentity(
  operation: StoredPositionAction,
) {
  const plan = operation.planSnapshot.plan;
  if (
    operation.venueId !== "polymarket" ||
    operation.action !== "redeem" ||
    !isRecord(plan) ||
    plan.executionKind !== "protocol_router" ||
    plan.redeemable !== true ||
    plan.chainId !== 137 ||
    typeof plan.data !== "string" ||
    typeof plan.targetAddress !== "string" ||
    !eq(plan.targetAddress, CONTRACTS.router) ||
    typeof plan.positionContract !== "string" ||
    !eq(plan.positionContract, CONTRACTS.positionManager) ||
    typeof plan.payoutTokenAddress !== "string" ||
    !eq(plan.payoutTokenAddress, CONTRACTS.collateral) ||
    typeof plan.moduleAddress !== "string" ||
    typeof plan.redeemAmountRaw !== "string" ||
    !/^[1-9][0-9]*$/.test(plan.redeemAmountRaw) ||
    typeof plan.expectedPayoutRaw !== "string" ||
    !/^(0|[1-9][0-9]*)$/.test(plan.expectedPayoutRaw)
  )
    return null;
  const context = parsePolymarketAssetContext(plan.assetContext);
  const snapshotContext = parsePolymarketAssetContext(
    operation.planSnapshot.assetContext,
  );
  if (
    !context ||
    context.protocolVersion !== "v2" ||
    (operation.planSnapshot.assetContext != null &&
      (!snapshotContext ||
        JSON.stringify(snapshotContext) !== JSON.stringify(context))) ||
    (operation.planSnapshot.positionContract != null &&
      (typeof operation.planSnapshot.positionContract !== "string" ||
        !eq(
          operation.planSnapshot.positionContract,
          context.positionContract,
        ))) ||
    context.assetId !== operation.planSnapshot.tokenId ||
    (operation.marketId != null && context.marketId !== operation.marketId) ||
    operation.planSnapshot.outcome !==
      (context.outcomeIndex === 0 ? "YES" : "NO")
  )
    return null;
  try {
    const identity = polymarketV2PositionIdentity(context);
    const amount = BigInt(plan.redeemAmountRaw);
    const payout = BigInt(plan.expectedPayoutRaw);
    const decoded = ROUTER.decodeFunctionData("redeem", plan.data);
    if (
      amount >= 1n << 256n ||
      payout > amount ||
      !eq(identity.moduleAddress, plan.moduleAddress) ||
      !eq(decoded[0], identity.conditionId) ||
      decoded[1] !== BigInt(context.outcomeIndex) ||
      decoded[2] !== amount ||
      !eq(ROUTER.encodeFunctionData("redeem", decoded), plan.data)
    )
      return null;
    return {
      ...identity,
      amount,
      payout,
      owner: ethers.getAddress(operation.ownerAddress),
      context,
    };
  } catch {
    return null;
  }
}

/** The Router transfer, module burn, both redemption events and exact pUSD mint
 * are independent evidence. A generic credit or a whole-wallet zero balance is
 * not proof of this position's consumption. Zero payout still requires burns. */
export function polymarketV2RedemptionPayout(
  operation: StoredPositionAction,
  receipt: Pick<EvmRpcTransactionReceipt, "succeeded" | "logs">,
): bigint | null {
  const expected = polymarketV2RedemptionIdentity(operation);
  if (!expected || !receipt.succeeded) return null;
  let routerEvents = 0;
  let moduleEvents = 0;
  let transferred = 0n;
  let burned = 0n;
  let ownerPayouts = 0n;
  const indices = new Set<number>();
  for (const log of receipt.logs) {
    if (log.logIndex != null) {
      if (indices.has(log.logIndex)) return null;
      indices.add(log.logIndex);
    }
    const isRouter = eq(log.address, CONTRACTS.router);
    const isPosition = eq(log.address, CONTRACTS.positionManager);
    const isModule =
      eq(log.address, CONTRACTS.binaryModule) ||
      eq(log.address, CONTRACTS.negRiskModule);
    if (!isRouter && !isPosition && !isModule) continue;
    let parsed;
    try {
      parsed = (isRouter ? ROUTER : isPosition ? POSITION : MODULE).parseLog(
        log,
      );
    } catch {
      return null;
    }
    if (!parsed) continue;
    const args = parsed.args;
    if (
      isRouter &&
      parsed.name === "RouterPositionRedeemed" &&
      eq(args.initiator, expected.owner) &&
      args.positionId === expected.positionId
    ) {
      if (args.amount !== expected.amount) return null;
      routerEvents++;
    }
    if (
      isModule &&
      parsed.name === "PositionRedeemed" &&
      eq(args.initiator, CONTRACTS.router) &&
      eq(args.recipient, expected.owner)
    ) {
      ownerPayouts += args.payout;
      if (args.positionId === expected.positionId) {
        if (
          !eq(log.address, expected.moduleAddress) ||
          args.amount !== expected.amount ||
          args.payout !== expected.payout
        )
          return null;
        moduleEvents++;
      }
    }
    if (
      isPosition &&
      (parsed.name === "TransferSingle" || parsed.name === "TransferBatch")
    ) {
      const ids: readonly bigint[] =
        parsed.name === "TransferSingle" ? [args.id] : args.ids;
      const values: readonly bigint[] =
        parsed.name === "TransferSingle" ? [args.value] : args[4];
      if (ids.length !== values.length) return null;
      for (let i = 0; i < ids.length; i++) {
        if (ids[i] !== expected.positionId) continue;
        const value = values[i];
        if (value == null) return null;
        if (
          eq(args.operator, CONTRACTS.router) &&
          eq(args.from, expected.owner) &&
          eq(args.to, expected.moduleAddress)
        )
          transferred += value;
        if (
          eq(args.operator, expected.moduleAddress) &&
          eq(args.from, expected.moduleAddress) &&
          eq(args.to, ethers.ZeroAddress)
        )
          burned += value;
      }
    }
  }
  const minted = sumErc20TransfersTo({
    logs: receipt.logs,
    recipient: expected.owner,
    tokenAddress: CONTRACTS.collateral,
    sender: ethers.ZeroAddress,
  });
  return routerEvents === 1 &&
    moduleEvents === 1 &&
    transferred === expected.amount &&
    burned === expected.amount &&
    minted === ownerPayouts
    ? expected.payout
    : null;
}
