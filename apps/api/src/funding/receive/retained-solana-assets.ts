import type { AssetRef } from "../domain/types.js";
import { sameAsset } from "../domain/asset-identity.js";
import { SOLANA_NATIVE_ASSET } from "../domain/network-fees.js";
import { SOLANA_USDC } from "../../funding-providers/relay/rehearsal.js";

export const SOLANA_RETAINED_USDC_ASSET: AssetRef = Object.freeze({
  networkId: "solana:mainnet",
  assetId: SOLANA_USDC,
  decimals: 6,
});

export function isRetainedSolanaAsset(asset: AssetRef): boolean {
  return sameAsset(asset, SOLANA_NATIVE_ASSET) || sameAsset(asset, SOLANA_RETAINED_USDC_ASSET);
}
