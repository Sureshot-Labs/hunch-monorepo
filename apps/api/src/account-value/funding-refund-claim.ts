import { sameAsset } from "../funding/domain/asset-identity.js";
import { HYPERCORE_MAINNET_USDC } from "../funding/domain/hypercore-identity.js";
import {
  fundingRefundReceiptMatchesContract,
  fundingRefundReceiptSetComplete,
  type FundingRefundContract,
  type FundingRefundSettledReceipt,
} from "../funding/domain/refund-settlement.js";
import type { Money } from "../funding/domain/types.js";
import { RELAY_HYPERCORE_EVM_STABLE_SOURCE_ASSETS } from "../funding-providers/relay/mappings.js";

const usdStableAssets = [
  HYPERCORE_MAINNET_USDC,
  ...RELAY_HYPERCORE_EVM_STABLE_SOURCE_ASSETS,
];

export type FundingRefundClaim =
  | { kind: "pending"; raw: string }
  | { kind: "complete" }
  | { kind: "unpriced"; reason: "funding_refund_value_unknown" };

/** Value a claim, not source cash or execution authority. The full source debit
 * remains a separate post-snapshot fact even after this claim reaches zero. */
export function projectFundingRefundClaim(input: {
  source: Money;
  contract: FundingRefundContract;
  /** All canonical finalized refunds, including unknown/malformed identities. */
  receipts: readonly FundingRefundSettledReceipt[];
}): FundingRefundClaim {
  const unknown: FundingRefundClaim = {
    kind: "unpriced",
    reason: "funding_refund_value_unknown",
  };
  if (
    !input.contract.supported ||
    !input.contract.requestBinding ||
    typeof input.source.raw !== "string" ||
    !/^[1-9]\d*$/u.test(input.source.raw) ||
    !usdStableAssets.some((asset) => sameAsset(asset, input.source.asset))
  )
    return unknown;
  const ids = new Set<string>();
  let returnedRaw = 0n;
  for (const receipt of input.receipts) {
    if (
      ids.has(receipt.observationId) ||
      !fundingRefundReceiptMatchesContract(input.contract, receipt) ||
      !usdStableAssets.some((asset) => sameAsset(asset, receipt.money.asset))
    )
      return unknown;
    ids.add(receipt.observationId);
    const numerator =
      BigInt(receipt.money.raw) * 10n ** BigInt(input.source.asset.decimals);
    const denominator = 10n ** BigInt(receipt.money.asset.decimals);
    if (numerator % denominator !== 0n) return unknown;
    returnedRaw += numerator / denominator;
  }
  if (returnedRaw > BigInt(input.source.raw)) return unknown;
  if (fundingRefundReceiptSetComplete(input.contract, input.receipts))
    return { kind: "complete" };
  // An arithmetic zero is still pending without the complete exact receipt set.
  return {
    kind: "pending",
    raw: (BigInt(input.source.raw) - returnedRaw).toString(),
  };
}
