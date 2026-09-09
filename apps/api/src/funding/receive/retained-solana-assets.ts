import type { AssetRef } from "../domain/types.js";
import { sameAsset } from "../domain/asset-identity.js";
import { SOLANA_NATIVE_ASSET } from "../domain/network-fees.js";
import {
  POLYGON_USDCE_LEGACY,
  SOLANA_USDC,
} from "../../funding-providers/relay/rehearsal.js";

export const SOLANA_RETAINED_USDC_ASSET: AssetRef = Object.freeze({
  networkId: "solana:mainnet",
  assetId: SOLANA_USDC,
  decimals: 6,
});

export function isRetainedSolanaAsset(asset: AssetRef): boolean {
  return (
    sameAsset(asset, SOLANA_NATIVE_ASSET) ||
    sameAsset(asset, SOLANA_RETAINED_USDC_ASSET)
  );
}

export const POLYGON_RETAINED_USDCE_ASSET: AssetRef = Object.freeze({
  networkId: "evm:137",
  assetId: POLYGON_USDCE_LEGACY.toLowerCase(),
  decimals: 6,
});

/** Explicit receive-only assets; this does not authorize a conversion. */
export function isRetainedOwnedSourceAsset(asset: AssetRef): boolean {
  return (
    isRetainedSolanaAsset(asset) ||
    sameAsset(asset, POLYGON_RETAINED_USDCE_ASSET)
  );
}
