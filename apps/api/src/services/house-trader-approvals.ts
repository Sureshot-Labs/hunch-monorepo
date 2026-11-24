import { getAddress, Interface, MaxUint256 } from "ethers";
import { POLYMARKET_PROTOCOL_CONTRACTS as contracts } from "@hunch/shared";
import type { DepositWalletCall } from "./polymarket-deposit-wallet-relayer.js";

const erc20 = new Interface([
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
]);
const erc1155 = new Interface([
  "function isApprovedForAll(address,address) view returns (bool)",
  "function setApprovalForAll(address,bool)",
]);

// For orders: V1 standard/negative risk use separate CTF exchanges. V2
// binary/negative risk share ExchangeV3 and the PositionManager token ledger.
// CTF negative risk additionally needs the Neg Risk Adapter on BOTH sides.
const orderApprovals = [
  [contracts.conditionalTokens, contracts.exchangeV2],
  [contracts.conditionalTokens, contracts.negRiskExchangeV2],
  [contracts.conditionalTokens, contracts.negRiskAdapter],
  [contracts.positionManager, contracts.exchangeV3],
] as const;

// Previously submitted batches may have finalized with the old, smaller
// allowance set. Continue only after a canonical receipt at the same or
// earlier height as the approvals read; a consumed nonce alone proves nothing.
export function houseApprovalBatchSettled(
  receipt: { status: number | null; blockNumber: number } | null,
  approvalReadBlock: number,
  submittedReference: string | null,
  finalizedNonce: bigint | null,
): boolean {
  const submittedNonce = /^batch:(\d{1,78}):\d{1,78}$/.exec(
    submittedReference ?? "",
  )?.[1];
  return (
    receipt?.status === 0 ||
    (receipt?.status === 1 &&
      receipt.blockNumber <= approvalReadBlock &&
      submittedNonce !== undefined &&
      finalizedNonce !== null &&
      finalizedNonce > BigInt(submittedNonce))
  );
}

export async function missingHouseTraderApprovals(input: {
  funder: string;
  collateral: string;
  ctfRedemptionAdapters: readonly string[];
  blockTag?: number;
  read: (call: {
    to: string;
    data: string;
    blockTag?: number;
  }) => Promise<string>;
}): Promise<DepositWalletCall[]> {
  const { funder, collateral, ctfRedemptionAdapters, blockTag, read } = input;
  const calls: DepositWalletCall[] = [];
  for (const [, operator] of orderApprovals) {
    const raw = await read({
      to: collateral,
      data: erc20.encodeFunctionData("allowance", [funder, operator]),
      blockTag,
    });
    if (erc20.decodeFunctionResult("allowance", raw)[0] < 1_000_000_000_000n)
      calls.push({
        target: collateral,
        value: "0",
        data: erc20.encodeFunctionData("approve", [operator, MaxUint256]),
      });
  }
  // Preserve the existing close/redeem permissions. Do not grant the Router
  // pUSD spending permission: this worker does not split collateral.
  const positionApprovals = [
    ...orderApprovals,
    [contracts.positionManager, contracts.router] as const,
    ...ctfRedemptionAdapters.map(
      (adapter) => [contracts.conditionalTokens, getAddress(adapter)] as const,
    ),
  ];
  const checked = new Set<string>();
  for (const [ledger, operator] of positionApprovals) {
    const key = `${ledger.toLowerCase()}:${operator.toLowerCase()}`;
    if (checked.has(key)) continue;
    checked.add(key);
    const raw = await read({
      to: ledger,
      data: erc1155.encodeFunctionData("isApprovedForAll", [funder, operator]),
      blockTag,
    });
    if (!erc1155.decodeFunctionResult("isApprovedForAll", raw)[0])
      calls.push({
        target: ledger,
        value: "0",
        data: erc1155.encodeFunctionData("setApprovalForAll", [operator, true]),
      });
  }
  return calls;
}
