import type { AssetRef } from "./types.js";

/** Exact registered native executor; no EVM or delegated authority implied. */
export const RELAY_HYPERCORE_EXECUTOR = "relay_hypercore_native_v1";
export const HYPERCORE_SPOT_LOCATION_PATTERN = "hypercore-spot-usdc-v1";
/** Relay's 16-byte zero selector means native perps USDC. It is not a
 * 32-byte protocol-order currency encoding and never a cash asset ID. */
export const RELAY_HYPERCORE_PERPS_CURRENCY = `0x${"0".repeat(32)}`;

/** Keep the native cash namespace already published by P2 Account Value.
 * This is HyperCore, not an EVM chain, and does not authorize execution. */
export const HYPERCORE_FUNDING_NETWORKS = {
  mainnet: "hyperliquid:mainnet",
  testnet: "hyperliquid:testnet",
} as const;

export type HypercoreFundingNetwork =
  (typeof HYPERCORE_FUNDING_NETWORKS)[keyof typeof HYPERCORE_FUNDING_NETWORKS];

export const HYPERCORE_MAINNET_USDC: AssetRef = Object.freeze({
  networkId: HYPERCORE_FUNDING_NETWORKS.mainnet,
  assetId: "0x6d1e7cde53ba9467b783cb7c530ce054",
  decimals: 8,
});

export function isHypercoreFundingNetwork(
  networkId: string,
): networkId is HypercoreFundingNetwork {
  return (
    networkId === HYPERCORE_FUNDING_NETWORKS.mainnet ||
    networkId === HYPERCORE_FUNDING_NETWORKS.testnet
  );
}

/** Native token IDs are 16 bytes, not 20-byte ERC20/account addresses. */
export function isHypercoreTokenId(value: string): boolean {
  return /^0x[0-9a-fA-F]{32}$/.test(value);
}

export function isHypercoreMainnetUsdc(asset: AssetRef): boolean {
  return (
    asset.networkId === HYPERCORE_MAINNET_USDC.networkId &&
    asset.decimals === HYPERCORE_MAINNET_USDC.decimals &&
    isHypercoreTokenId(asset.assetId) &&
    asset.assetId.toLowerCase() === HYPERCORE_MAINNET_USDC.assetId
  );
}

/** DEX labels do not create a second cash identity. Frozen legacy plans use
 * balanceClass; new account projections keep the published P2 component key. */
export function hypercoreLocationDex(
  location: Readonly<{
    kind: unknown;
    asset: AssetRef;
    details: Readonly<Record<string, unknown>>;
  }>,
): "spot" | "" | null {
  if (
    !isHypercoreMainnetUsdc(location.asset) ||
    location.kind !== "venue_account" ||
    location.details.venueId !== "hyperliquid" ||
    location.details.environment !== "mainnet"
  )
    return null;
  const native = location.details.nativeSourceDex;
  const legacy = location.details.balanceClass;
  const legacyDex = legacy === "spot" ? "spot" : legacy === "perp" ? "" : null;
  if (native === undefined) return legacyDex;
  if (native !== "spot" && native !== "") return null;
  return legacy !== undefined && legacyDex !== native ? null : native;
}
