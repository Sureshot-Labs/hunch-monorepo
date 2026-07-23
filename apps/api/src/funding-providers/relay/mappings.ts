import { getAddress, ZeroAddress } from "ethers";
import { PublicKey } from "@solana/web3.js";

import type { AssetRef, NetworkId } from "../../funding/domain/types.js";
import {
  BASE_USDC,
  POLYGON_PUSD,
  RELAY_SOLANA_CHAIN_ID,
  SOLANA_NATIVE,
  SOLANA_USDC,
  relayRehearsalScenarios,
  type RelayRehearsalScenario,
  type RelayRehearsalScenarioId,
} from "./rehearsal.js";
import { POLYGON_USDCE } from "./solana-rehearsal.js";

export type RelayVm = "evm" | "svm";

export type RelayRouteSpec =
  | Readonly<{
      routeId: RelayRehearsalScenarioId;
      source: AssetRef;
      destination: AssetRef;
      sourceVm: "evm";
      destinationVm: RelayVm;
      rehearsalScenario: RelayRehearsalScenario;
    }>
  | Readonly<{
      routeId: "solana-usdc-to-polygon-pusd";
      source: AssetRef;
      destination: AssetRef;
      sourceVm: "svm";
      destinationVm: "evm";
      rehearsalScenario: null;
    }>;

const NETWORK_BY_RELAY_CHAIN_ID: Readonly<Record<number, NetworkId>> = {
  137: "evm:137",
  8453: "evm:8453",
  [RELAY_SOLANA_CHAIN_ID]: "solana:mainnet",
};

const RELAY_CHAIN_ID_BY_NETWORK: Readonly<Record<NetworkId, number>> = {
  "evm:137": 137,
  "evm:8453": 8453,
  "solana:mainnet": RELAY_SOLANA_CHAIN_ID,
};

export function relayChainIdForNetwork(networkId: NetworkId): number {
  const chainId = RELAY_CHAIN_ID_BY_NETWORK[networkId];
  if (!chainId)
    throw new Error(`Relay network ${networkId} is not allowlisted`);
  return chainId;
}

export function networkForRelayChainId(chainId: number): NetworkId {
  const networkId = NETWORK_BY_RELAY_CHAIN_ID[chainId];
  if (!networkId) throw new Error(`Relay chain ${chainId} is not allowlisted`);
  return networkId;
}

export function normalizeRelayAssetId(
  networkId: NetworkId,
  assetId: string,
): string {
  if (networkId.startsWith("evm:")) {
    return getAddress(assetId).toLowerCase();
  }
  if (networkId === "solana:mainnet") {
    return new PublicKey(assetId).toBase58();
  }
  throw new Error(`Relay asset network ${networkId} is not allowlisted`);
}

export function relayCurrencyForAsset(asset: AssetRef): string {
  relayChainIdForNetwork(asset.networkId);
  return normalizeRelayAssetId(asset.networkId, asset.assetId);
}

const route = (
  routeId: RelayRehearsalScenarioId,
  sourceDecimals: number,
  destinationDecimals: number,
): RelayRouteSpec => {
  const scenario = relayRehearsalScenarios[routeId];
  return {
    routeId,
    source: {
      networkId: networkForRelayChainId(scenario.originChainId),
      assetId: normalizeRelayAssetId(
        networkForRelayChainId(scenario.originChainId),
        scenario.originCurrency,
      ),
      decimals: sourceDecimals,
    },
    destination: {
      networkId: networkForRelayChainId(scenario.destinationChainId),
      assetId: normalizeRelayAssetId(
        networkForRelayChainId(scenario.destinationChainId),
        scenario.destinationCurrency,
      ),
      decimals: destinationDecimals,
    },
    sourceVm: "evm",
    destinationVm: scenario.destinationVm,
    rehearsalScenario: scenario,
  };
};

export const RELAY_ROUTE_SPECS: Readonly<Record<string, RelayRouteSpec>> = {
  "polygon-pol-to-base-eth": route("polygon-pol-to-base-eth", 18, 18),
  "polygon-pusd-to-base-usdc": route("polygon-pusd-to-base-usdc", 6, 6),
  "base-usdc-to-polygon-pusd": route("base-usdc-to-polygon-pusd", 6, 6),
  "polygon-pol-to-solana-sol": route("polygon-pol-to-solana-sol", 18, 9),
  "polygon-pusd-to-solana-usdc": route("polygon-pusd-to-solana-usdc", 6, 6),
  "solana-usdc-to-polygon-pusd": {
    routeId: "solana-usdc-to-polygon-pusd",
    source: {
      networkId: "solana:mainnet",
      assetId: SOLANA_USDC,
      decimals: 6,
    },
    destination: {
      networkId: "evm:137",
      assetId: POLYGON_PUSD,
      decimals: 6,
    },
    sourceVm: "svm",
    destinationVm: "evm",
    rehearsalScenario: null,
  },
};

// Exported as contract evidence for fixture and registry tests.
export const RELAY_PINNED_ASSETS = {
  baseUsdc: BASE_USDC.toLowerCase(),
  polygonNative: ZeroAddress,
  polygonPusd: POLYGON_PUSD.toLowerCase(),
  polygonUsdc: "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359",
  polygonUsdce: POLYGON_USDCE.toLowerCase(),
  solanaNative: SOLANA_NATIVE,
  solanaUsdc: SOLANA_USDC,
} as const;

const RELAY_PINNED_ASSET_IDS_BY_NETWORK: Readonly<
  Record<NetworkId, ReadonlySet<string>>
> = {
  "evm:137": new Set([
    RELAY_PINNED_ASSETS.polygonNative,
    RELAY_PINNED_ASSETS.polygonPusd,
    RELAY_PINNED_ASSETS.polygonUsdc,
    RELAY_PINNED_ASSETS.polygonUsdce,
  ]),
  "evm:8453": new Set([ZeroAddress, RELAY_PINNED_ASSETS.baseUsdc]),
  "solana:mainnet": new Set([
    RELAY_PINNED_ASSETS.solanaNative,
    RELAY_PINNED_ASSETS.solanaUsdc,
  ]),
};

export function assertRelayPinnedAsset(asset: AssetRef): void {
  const normalized = normalizeRelayAssetId(asset.networkId, asset.assetId);
  if (!RELAY_PINNED_ASSET_IDS_BY_NETWORK[asset.networkId]?.has(normalized)) {
    throw new Error("Relay asset is outside the pinned Hunch asset registry");
  }
}

export function assertRelayRouteAssets(
  spec: RelayRouteSpec,
  source: AssetRef,
  destination: AssetRef,
): void {
  const exact = (left: AssetRef, right: AssetRef): boolean =>
    left.networkId === right.networkId &&
    left.decimals === right.decimals &&
    normalizeRelayAssetId(left.networkId, left.assetId) ===
      normalizeRelayAssetId(right.networkId, right.assetId);
  if (!exact(spec.source, source) || !exact(spec.destination, destination)) {
    throw new Error("Relay route assets do not match the pinned route");
  }
  assertRelayPinnedAsset(source);
  assertRelayPinnedAsset(destination);
}
