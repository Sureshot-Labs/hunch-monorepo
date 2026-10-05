import { Interface } from "ethers";
import {
  POLYMARKET_PROTOCOL_CONTRACTS as CONTRACTS,
  resolvePolymarketMarketAssets,
} from "@hunch/shared";

const approvals = new Interface([
  "function approve(address spender,uint256 amount)",
  "function setApprovalForAll(address operator,bool approved)",
]);
const router = new Interface([
  "function redeem(bytes31 conditionId,uint256 outcome,uint256 amount)",
]);
const equals = (left: string, right: string) =>
  left.toLowerCase() === right.toLowerCase();

/** Closed protocol operations only. This does not grant relayer/Privy policy
 * permission or permit direct calls to DepositWallet.execute. */
export function isPolymarketV2ApprovalCall(
  target: string,
  data: string,
  purpose: "setup" | "redeem" = "setup",
): boolean {
  try {
    const call = approvals.parseTransaction({ data });
    if (
      !call ||
      approvals.encodeFunctionData(call.fragment, call.args).toLowerCase() !==
        data.toLowerCase()
    )
      return false;
    if (call?.name === "approve") {
      return (
        purpose === "setup" &&
        equals(target, CONTRACTS.collateral) &&
        equals(String(call.args[0]), CONTRACTS.exchangeV3) &&
        BigInt(call.args[1]) > 0n
      );
    }
    if (call?.name === "setApprovalForAll") {
      return (
        equals(target, CONTRACTS.positionManager) &&
        (purpose === "redeem"
          ? [CONTRACTS.router]
          : [CONTRACTS.exchangeV3, CONTRACTS.router]
        ).some((operator) => equals(String(call.args[0]), operator)) &&
        call.args[1] === true
      );
    }
  } catch {
    /* Malformed calldata is not an authorized protocol call. */
  }
  return false;
}

export function isPolymarketV2RedemptionCall(
  target: string,
  data: string,
): boolean {
  if (!equals(target, CONTRACTS.router)) return false;
  try {
    const call = router.parseTransaction({ data });
    if (call?.name !== "redeem" || BigInt(call.args[2]) <= 0n) return false;
    if (
      router.encodeFunctionData(call.fragment, call.args).toLowerCase() !==
      data.toLowerCase()
    )
      return false;
    const outcome = BigInt(call.args[1]);
    if (outcome !== 0n && outcome !== 1n) return false;
    const conditionId = `${String(call.args[0])}00`;
    const condition = BigInt(conditionId);
    // Reuse the canonical packed-ID decoder: reject combo, reserved bits,
    // foreign resolution chains and invalid binary/neg-risk structure.
    resolvePolymarketMarketAssets({
      version: "v2",
      conditionId,
      positionIds: [condition.toString(), (condition | 1n).toString()],
      outcomes: ["Yes", "No"],
      negRisk: condition >> 248n === 2n,
    });
    return true;
  } catch {
    return false;
  }
}
