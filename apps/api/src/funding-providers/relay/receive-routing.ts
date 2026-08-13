import type {
  AssetRef,
  FundingReceiveQuotePlan,
} from "../../funding/domain/types.js";
import { sameAsset } from "../../funding/domain/asset-identity.js";
import { SOLANA_NATIVE_EXECUTION_RESERVE_LAMPORTS } from "../../funding/domain/network-fees.js";
import { RELAY_PINNED_ASSETS } from "./mappings.js";

export const RELAY_RECEIVE_OPERATION_ADAPTER_KEY =
  "relay_owned_wallet_receipt_v1";

const RELAY_SOLANA_NATIVE_ASSET = Object.freeze({
  networkId: "solana:mainnet",
  assetId: RELAY_PINNED_ASSETS.solanaNative,
  decimals: 9,
} as const satisfies AssetRef);

/** Relay owns exact-input economics, including the SOL transaction reserve. */
export function relayReceiveQuotePlan(
  input: Readonly<{
    receiptAsset: AssetRef;
    destinationAsset: AssetRef;
    rawAmount: string;
  }>,
): FundingReceiveQuotePlan | null {
  if (!/^(0|[1-9][0-9]*)$/u.test(input.rawAmount)) return null;
  const receivedRaw = BigInt(input.rawAmount);
  const sourceRaw = sameAsset(input.receiptAsset, RELAY_SOLANA_NATIVE_ASSET)
    ? receivedRaw > SOLANA_NATIVE_EXECUTION_RESERVE_LAMPORTS
      ? receivedRaw - SOLANA_NATIVE_EXECUTION_RESERVE_LAMPORTS
      : 0n
    : receivedRaw;
  return {
    version: 1,
    confirmedSourceAmount: {
      asset: input.receiptAsset,
      raw: sourceRaw.toString(),
    },
    requestedDestinationAmount: {
      asset: input.destinationAsset,
      // Exact-input discovery needs a non-zero floor. Relay freezes the real
      // provider output in the selected quote; core never interprets this 1:1.
      raw: "1",
    },
    venuePreparation: false,
  };
}
