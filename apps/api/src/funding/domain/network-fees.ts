import type { Money, NetworkId } from "./types.js";

export const SOLANA_NATIVE_ASSET = Object.freeze({
  networkId: "solana:mainnet",
  assetId: "11111111111111111111111111111111",
  decimals: 9,
});

export const SOLANA_NATIVE_EXECUTION_RESERVE_LAMPORTS = 3_000_000n;

export function senderNativeFeeRequirement(networkId: NetworkId): Money | null {
  return networkId === SOLANA_NATIVE_ASSET.networkId
    ? {
        asset: SOLANA_NATIVE_ASSET,
        raw: SOLANA_NATIVE_EXECUTION_RESERVE_LAMPORTS.toString(),
      }
    : null;
}
