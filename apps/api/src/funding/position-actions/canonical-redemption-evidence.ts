import { ethers } from "ethers";
import { isRecord } from "../../lib/type-guards.js";
import { sumErc20TransfersTo } from "../execution/evm-erc20-receipt.js";
import type { EvmRpcTransactionReceipt } from "../../services/polygon-rpc.js";
import type { StoredPositionAction } from "./position-action-repository.js";

// Standard CTF ABI, also verified against the historical finalized Base receipt.
export const CANONICAL_CTF_ABI = new ethers.Interface([
  "function redeemPositions(address collateralToken,bytes32 parentCollectionId,bytes32 conditionId,uint256[] indexSets)",
  "event PayoutRedemption(address indexed redeemer,address indexed collateralToken,bytes32 indexed parentCollectionId,bytes32 conditionId,uint256[] indexSets,uint256 payout)",
  "event TransferSingle(address indexed operator,address indexed from,address indexed to,uint256 id,uint256 value)",
  "event TransferBatch(address indexed operator,address indexed from,address indexed to,uint256[] ids,uint256[] values)",
]);
export const CANONICAL_CTF_PAYOUT_TOPIC = ethers.id(
  "PayoutRedemption(address,address,bytes32,bytes32,uint256[],uint256)",
);
const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

type RecoveryIdentity = {
  owner: string;
  ctf: string;
  tokenId: bigint;
  burnRaw: bigint;
  payoutToken: string;
  conditionId: string;
  parentId: string;
  collateral: string;
  indexSets: readonly bigint[];
  payoutRaw: bigint;
};

export function canonicalRedemptionIdentity(
  operation: StoredPositionAction,
  ctfAddress: string,
): RecoveryIdentity | null {
  const plan = operation.planSnapshot.plan;
  const outcome = operation.planSnapshot.outcome;
  const storedTokenId = operation.planSnapshot.tokenId;
  // Limitless positions persist a venue-scoped ID. Accept only the exact
  // storage format, not a permissive leading-digits extraction.
  const tokenId =
    typeof storedTokenId === "string" && operation.venueId === "limitless"
      ? storedTokenId.match(/^(?:limitless:)?([0-9]+)$/)?.[1]
      : storedTokenId;
  if (
    operation.action !== "redeem" ||
    !isRecord(plan) ||
    !plan.redeemable ||
    typeof plan.data !== "string" ||
    typeof plan.targetAddress !== "string" ||
    !eq(plan.targetAddress, ctfAddress) ||
    typeof tokenId !== "string" ||
    !/^\d+$/.test(tokenId)
  )
    return null;
  const burnRaw =
    outcome === "YES"
      ? plan.yesBalanceRaw
      : outcome === "NO"
        ? plan.noBalanceRaw
        : null;
  const payoutRaw = plan.expectedPayoutRaw;
  if (
    typeof burnRaw !== "string" ||
    !/^[1-9][0-9]*$/.test(burnRaw) ||
    typeof payoutRaw !== "string" ||
    !/^[1-9][0-9]*$/.test(payoutRaw) ||
    typeof plan.payoutTokenAddress !== "string"
  )
    return null;
  try {
    const decoded = CANONICAL_CTF_ABI.decodeFunctionData(
      "redeemPositions",
      plan.data,
    );
    if (
      !eq(decoded[0], plan.payoutTokenAddress) ||
      CANONICAL_CTF_ABI.encodeFunctionData(
        "redeemPositions",
        decoded,
      ).toLowerCase() !== plan.data.toLowerCase()
    )
      return null;
    return {
      owner: operation.ownerAddress,
      ctf: ctfAddress,
      tokenId: BigInt(tokenId),
      burnRaw: BigInt(burnRaw),
      payoutToken: plan.payoutTokenAddress,
      collateral: decoded[0],
      parentId: decoded[1],
      conditionId: decoded[2],
      indexSets: [...decoded[3]],
      payoutRaw: BigInt(payoutRaw),
    };
  } catch {
    return null;
  }
}

/** Event identity proves the nested CTF invocation, not the EntryPoint/bundler sender. */
export function canonicalRedemptionPayout(
  operation: StoredPositionAction,
  ctfAddress: string,
  receipt: Pick<EvmRpcTransactionReceipt, "succeeded" | "logs">,
): bigint | null {
  const expected = canonicalRedemptionIdentity(operation, ctfAddress);
  if (!expected || !receipt.succeeded) return null;
  let payoutEvents = 0;
  let actualPayout = 0n;
  let burned = 0n;
  let ownerPayoutTotal = 0n;
  for (const log of receipt.logs) {
    if (!eq(log.address, ctfAddress)) continue;
    let parsed;
    try {
      parsed = CANONICAL_CTF_ABI.parseLog(log);
    } catch {
      return null;
    }
    if (!parsed) continue;
    const args = parsed.args;
    if (
      parsed.name === "PayoutRedemption" &&
      eq(args.redeemer, expected.owner) &&
      eq(args.collateralToken, expected.payoutToken)
    )
      ownerPayoutTotal += args.payout;
    if (
      parsed.name === "PayoutRedemption" &&
      eq(args.redeemer, expected.owner) &&
      eq(args.collateralToken, expected.collateral) &&
      eq(args.parentCollectionId, expected.parentId) &&
      eq(args.conditionId, expected.conditionId) &&
      args.indexSets.length === expected.indexSets.length &&
      args.indexSets.every(
        (value: bigint, index: number) => value === expected.indexSets[index],
      )
    ) {
      payoutEvents++;
      actualPayout = args.payout;
    }
    if (
      (parsed.name === "TransferSingle" || parsed.name === "TransferBatch") &&
      eq(args.from, expected.owner) &&
      eq(args.to, ethers.ZeroAddress)
    ) {
      const ids: readonly bigint[] =
        parsed.name === "TransferSingle" ? [args.id] : args.ids;
      const amounts: readonly bigint[] =
        parsed.name === "TransferSingle" ? [args.value] : args[4];
      ids.forEach((id, index) => {
        if (id === expected.tokenId) burned += amounts[index] ?? 0n;
      });
    }
  }
  const verified =
    payoutEvents === 1 &&
    // Standard CTF calldata redeems the entire current balance. Additional
    // incoming shares do not change the authorized condition/index sets.
    burned >= expected.burnRaw &&
    actualPayout >= expected.payoutRaw &&
    sumErc20TransfersTo({
      logs: receipt.logs,
      recipient: expected.owner,
      tokenAddress: expected.payoutToken,
      sender: ctfAddress,
    }) === ownerPayoutTotal;
  return verified ? actualPayout : null;
}

export function matchesCanonicalRedemption(
  operation: StoredPositionAction,
  ctfAddress: string,
  receipt: Pick<EvmRpcTransactionReceipt, "succeeded" | "logs">,
): boolean {
  return canonicalRedemptionPayout(operation, ctfAddress, receipt) !== null;
}
