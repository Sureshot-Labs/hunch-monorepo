import { getAddress, ZeroAddress } from "ethers";
import { PublicKey } from "@solana/web3.js";

import { canonicalAssetKey } from "../../funding/domain/asset-identity.js";
import type { AssetRef, NetworkId } from "../../funding/domain/types.js";
import {
  FUNDING_ROUTE_EXPERIENCE,
  type FundingRuntimePolicy,
} from "../../funding/policies/funding-policy.js";
import {
  BASE_USDC,
  POLYGON_PUSD,
  POLYGON_USDC,
  RELAY_SOLANA_CHAIN_ID,
  SOLANA_NATIVE,
  SOLANA_USDC,
  relayRehearsalScenarios,
  type RelayRehearsalScenario,
  type RelayRehearsalScenarioId,
} from "./rehearsal.js";
import { POLYGON_USDCE } from "./solana-rehearsal.js";

export type RelayVm = "evm" | "svm";

export type RelayRouteSpec = Readonly<{
  routeId:
    | RelayRehearsalScenarioId
    | "solana-sol-to-base-usdc"
    | "solana-usdc-to-base-usdc"
    | "polygon-usdc-to-polygon-pusd"
    | "solana-usdc-to-polygon-pusd"
    | "solana-sol-to-polygon-pusd";
  source: AssetRef;
  destination: AssetRef;
  sourceVm: RelayVm;
  destinationVm: RelayVm;
  quoteMode: "exact_input" | "expected_output";
  rehearsalScenario: RelayRehearsalScenario | null;
}>;

export function relayRouteCapability(
  route: Pick<RelayRouteSpec, "source" | "destination">,
): "same_network_swap" | "cross_network_transfer" | "cross_network_swap" {
  if (route.source.networkId === route.destination.networkId) {
    return "same_network_swap";
  }
  return route.source.assetId === route.destination.assetId
    ? "cross_network_transfer"
    : "cross_network_swap";
}

export function relayRuntimeRoute(
  spec: RelayRouteSpec,
  locations: Readonly<{
    sourceLocationPatternId: string;
    destinationLocationPatternId: string;
  }>,
): FundingRuntimePolicy["routes"][number] {
  return {
    routeId: spec.routeId,
    enabled: true,
    providerId: "relay",
    capability: relayRouteCapability(spec),
    adapterId: "relay_quote_v2",
    adapterVersion: 1,
    sourceLocationPatternId: locations.sourceLocationPatternId,
    destinationLocationPatternId: locations.destinationLocationPatternId,
    sourceAsset: spec.source,
    destinationAsset: spec.destination,
    actionValidatorId:
      spec.sourceVm === "svm" ? "relay_svm_action_v1" : "relay_evm_action_v1",
    networkExecutorId:
      spec.sourceVm === "svm"
        ? "wallet_profile_svm_v1"
        : "wallet_profile_evm_v1",
    reconcilerId: "relay_status_v3",
    refundSemanticsId: "relay_owned_refund_observation_v1",
    destinationObserverId: "relay_owned_destination_observation_v1",
    experienceMode: "prepare_first",
    measuredObservationCount: 0,
    minimumInlineObservationCount:
      FUNDING_ROUTE_EXPERIENCE.minimumInlineObservationCount,
    fallbackKind: null,
    depositAddress: null,
  };
}

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
  quoteMode: RelayRouteSpec["quoteMode"] = "exact_input",
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
    quoteMode,
    rehearsalScenario: scenario,
  };
};

export const RELAY_ROUTE_SPECS: Readonly<Record<string, RelayRouteSpec>> = {
  "polygon-pol-to-base-eth": route("polygon-pol-to-base-eth", 18, 18),
  "polygon-pusd-to-base-usdc": route(
    "polygon-pusd-to-base-usdc",
    6,
    6,
    "expected_output",
  ),
  "base-usdc-to-polygon-pusd": route(
    "base-usdc-to-polygon-pusd",
    6,
    6,
    "expected_output",
  ),
  "polygon-usdc-to-polygon-pusd": {
    routeId: "polygon-usdc-to-polygon-pusd",
    source: {
      networkId: "evm:137",
      assetId: normalizeRelayAssetId("evm:137", POLYGON_USDC),
      decimals: 6,
    },
    destination: {
      networkId: "evm:137",
      assetId: normalizeRelayAssetId("evm:137", POLYGON_PUSD),
      decimals: 6,
    },
    sourceVm: "evm",
    destinationVm: "evm",
    quoteMode: "expected_output",
    rehearsalScenario: null,
  },
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
    quoteMode: "exact_input",
    rehearsalScenario: null,
  },
  "solana-usdc-to-base-usdc": {
    routeId: "solana-usdc-to-base-usdc",
    source: {
      networkId: "solana:mainnet",
      assetId: SOLANA_USDC,
      decimals: 6,
    },
    destination: {
      networkId: "evm:8453",
      assetId: BASE_USDC,
      decimals: 6,
    },
    sourceVm: "svm",
    destinationVm: "evm",
    quoteMode: "expected_output",
    rehearsalScenario: null,
  },
  "solana-sol-to-polygon-pusd": {
    routeId: "solana-sol-to-polygon-pusd",
    source: {
      networkId: "solana:mainnet",
      assetId: SOLANA_NATIVE,
      decimals: 9,
    },
    destination: {
      networkId: "evm:137",
      assetId: POLYGON_PUSD,
      decimals: 6,
    },
    sourceVm: "svm",
    destinationVm: "evm",
    quoteMode: "expected_output",
    rehearsalScenario: null,
  },
  "solana-sol-to-base-usdc": {
    routeId: "solana-sol-to-base-usdc",
    source: {
      networkId: "solana:mainnet",
      assetId: SOLANA_NATIVE,
      decimals: 9,
    },
    destination: {
      networkId: "evm:8453",
      assetId: BASE_USDC,
      decimals: 6,
    },
    sourceVm: "svm",
    destinationVm: "evm",
    quoteMode: "expected_output",
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

function relayWalletLocation(
  networkId: NetworkId,
  assetId: string,
  decimals: number,
  locationPatternId: string,
): readonly [string, string] {
  return [
    canonicalAssetKey({ networkId, assetId, decimals }),
    locationPatternId,
  ];
}

const RELAY_WALLET_LOCATION_PATTERN_BY_ASSET = new Map<string, string>([
  relayWalletLocation(
    "evm:137",
    RELAY_PINNED_ASSETS.polygonPusd,
    6,
    "wallet-polygon-pusd-v1",
  ),
  relayWalletLocation(
    "evm:137",
    RELAY_PINNED_ASSETS.polygonUsdc,
    6,
    "wallet-polygon-usdc-v1",
  ),
  relayWalletLocation(
    "evm:137",
    RELAY_PINNED_ASSETS.polygonUsdce,
    6,
    "wallet-polygon-usdce-v1",
  ),
  relayWalletLocation(
    "evm:8453",
    RELAY_PINNED_ASSETS.baseUsdc,
    6,
    "wallet-base-usdc-v1",
  ),
  relayWalletLocation(
    "solana:mainnet",
    RELAY_PINNED_ASSETS.solanaUsdc,
    6,
    "wallet-solana-usdc-v1",
  ),
  relayWalletLocation(
    "solana:mainnet",
    RELAY_PINNED_ASSETS.solanaNative,
    9,
    "wallet-solana-native-v1",
  ),
]);

export function relayWalletLocationPatternId(asset: AssetRef): string | null {
  return (
    RELAY_WALLET_LOCATION_PATTERN_BY_ASSET.get(canonicalAssetKey(asset)) ?? null
  );
}

/**
 * Economic classification for the currently pinned Relay collateral set.
 * Route planning and quote consent both consume this single registry helper so
 * adding a network cannot silently make one layer treat a volatile asset as
 * equivalent stable collateral.
 */
export function isRelayPinnedStableAsset(asset: AssetRef): boolean {
  if (asset.decimals !== 6) return false;
  const normalized = asset.assetId.toLowerCase();
  return (
    (asset.networkId === "evm:8453" &&
      normalized === RELAY_PINNED_ASSETS.baseUsdc) ||
    (asset.networkId === "evm:137" &&
      (normalized === RELAY_PINNED_ASSETS.polygonPusd ||
        normalized === RELAY_PINNED_ASSETS.polygonUsdc ||
        normalized === RELAY_PINNED_ASSETS.polygonUsdce)) ||
    (asset.networkId === "solana:mainnet" &&
      asset.assetId === RELAY_PINNED_ASSETS.solanaUsdc)
  );
}

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
