import type { AssetRef } from "../funding/domain/types.js";
import { canonicalAssetKey } from "../funding/domain/asset-identity.js";
import { fundingSidecarRuntimeConfig } from "../funding/runtime/sidecar-runtime-config.js";

export const POLYGON_NATIVE_USDC_ADDRESS =
  "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359";

export type KnownAccountAsset = Readonly<{
  asset: AssetRef;
  category: "cash" | "token";
  exactStable: boolean;
  symbol: "pUSD" | "SOL" | "USDC" | "USDC.e";
  venueId: "kalshi" | "limitless" | "polymarket" | null;
}>;

const KNOWN_ACCOUNT_ASSETS: readonly KnownAccountAsset[] = [
  {
    asset: {
      assetId: fundingSidecarRuntimeConfig.polymarketPusdAddress,
      decimals: 6,
      networkId: "evm:137",
    },
    category: "cash",
    exactStable: true,
    symbol: "pUSD",
    venueId: "polymarket",
  },
  {
    asset: {
      assetId: fundingSidecarRuntimeConfig.polymarketUsdceAddress,
      decimals: 6,
      networkId: "evm:137",
    },
    category: "cash",
    exactStable: true,
    symbol: "USDC.e",
    venueId: "polymarket",
  },
  {
    asset: {
      assetId: POLYGON_NATIVE_USDC_ADDRESS,
      decimals: 6,
      networkId: "evm:137",
    },
    category: "cash",
    exactStable: true,
    symbol: "USDC",
    venueId: "polymarket",
  },
  {
    asset: {
      assetId: fundingSidecarRuntimeConfig.limitlessUsdcAddress,
      decimals: 6,
      networkId: "evm:8453",
    },
    category: "cash",
    exactStable: true,
    symbol: "USDC",
    venueId: "limitless",
  },
  {
    asset: {
      assetId: fundingSidecarRuntimeConfig.solanaUsdcMint,
      decimals: 6,
      networkId: "solana:mainnet",
    },
    category: "cash",
    exactStable: true,
    symbol: "USDC",
    venueId: "kalshi",
  },
  {
    asset: {
      assetId: "11111111111111111111111111111111",
      decimals: 9,
      networkId: "solana:mainnet",
    },
    category: "cash",
    exactStable: false,
    symbol: "SOL",
    venueId: null,
  },
];

const KNOWN_ACCOUNT_ASSET_BY_KEY = new Map(
  KNOWN_ACCOUNT_ASSETS.map((entry) => [canonicalAssetKey(entry.asset), entry]),
);

export function knownAccountAssets(): readonly KnownAccountAsset[] {
  return KNOWN_ACCOUNT_ASSETS;
}

export function resolveKnownAccountAsset(
  asset: AssetRef,
): KnownAccountAsset | null {
  return KNOWN_ACCOUNT_ASSET_BY_KEY.get(canonicalAssetKey(asset)) ?? null;
}

export function resolveKnownAccountAssetSymbol(
  asset: AssetRef,
): KnownAccountAsset["symbol"] | null {
  return resolveKnownAccountAsset(asset)?.symbol ?? null;
}
