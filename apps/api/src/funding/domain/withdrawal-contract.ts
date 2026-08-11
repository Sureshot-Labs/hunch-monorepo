import {
  isRelayPinnedStableAsset,
  RELAY_PINNED_ASSETS,
  RELAY_ROUTE_SPECS,
  relayRuntimeRoute,
  relayWalletLocationPatternId,
} from "../../funding-providers/relay/mappings.js";
import {
  DEFAULT_FUNDING_RUNTIME_POLICY,
  FUNDING_ROUTE_EXPERIENCE,
  FUNDING_TTL,
  type FundingRuntimePolicy,
} from "../policies/funding-policy.js";
import { sameAsset } from "./asset-identity.js";
import type { AssetRef } from "./types.js";

export const WITHDRAWAL_DESTINATION_CONTRACT_VERSION = 1;
export const WITHDRAWAL_DESTINATION_CONTRACT_REVISION =
  "withdrawal_destination_contract_v1";

function isSupportedWithdrawalSource(asset: AssetRef): boolean {
  return (
    isRelayPinnedStableAsset(asset) ||
    (asset.networkId === "solana:mainnet" &&
      asset.assetId === RELAY_PINNED_ASSETS.solanaNative &&
      asset.decimals === 9)
  );
}

export function supportsWithdrawalDestinationAsset(asset: AssetRef): boolean {
  return (
    isRelayPinnedStableAsset(asset) &&
    Object.values(RELAY_ROUTE_SPECS).some(
      (spec) =>
        sameAsset(spec.destination, asset) &&
        isSupportedWithdrawalSource(spec.source),
    )
  );
}

export function withdrawalRecipientLocationPatternId(
  asset: AssetRef,
): string | null {
  if (!supportsWithdrawalDestinationAsset(asset)) return null;
  if (asset.networkId === "evm:137") {
    const id = asset.assetId.toLowerCase();
    if (id === RELAY_PINNED_ASSETS.polygonPusd)
      return "withdrawal-polygon-pusd-v1";
  }
  if (
    asset.networkId === "evm:8453" &&
    asset.assetId.toLowerCase() === RELAY_PINNED_ASSETS.baseUsdc
  ) {
    return "withdrawal-base-usdc-v1";
  }
  if (
    asset.networkId === "solana:mainnet" &&
    asset.assetId === RELAY_PINNED_ASSETS.solanaUsdc
  ) {
    return "withdrawal-solana-usdc-v1";
  }
  return null;
}

/**
 * Derives the Relay withdrawal view from already observed general-balance
 * assets. Funding venue selection, receive aliases and funding pause do not
 * authorize or disable this user-owned withdrawal path.
 */
export function withWithdrawalPlanningContract(
  policy: FundingRuntimePolicy,
  destinationAsset: AssetRef,
): FundingRuntimePolicy {
  const destinationLocationPatternId =
    withdrawalRecipientLocationPatternId(destinationAsset);
  if (!destinationLocationPatternId) return policy;

  const sourceLocations = new Map<
    string,
    FundingRuntimePolicy["locations"][number]
  >();
  for (const spec of Object.values(RELAY_ROUTE_SPECS)) {
    if (
      !sameAsset(spec.destination, destinationAsset) ||
      !isSupportedWithdrawalSource(spec.source)
    ) {
      continue;
    }
    const sourceLocationPatternId = relayWalletLocationPatternId(spec.source);
    if (!sourceLocationPatternId) continue;
    sourceLocations.set(spec.routeId, {
      locationPatternId: sourceLocationPatternId,
      locationKind: "wallet",
      asset: spec.source,
      ownership: "owned",
      observable: true,
      capabilities: [
        "observe",
        "value",
        "execution_source",
        "withdrawal_source",
      ],
      enabled: true,
    });
  }

  const withdrawalRoutes = Object.values(RELAY_ROUTE_SPECS).flatMap((spec) => {
    const sourceLocation = sourceLocations.get(spec.routeId);
    if (!sourceLocation || !sameAsset(spec.destination, destinationAsset)) {
      return [];
    }
    return [
      relayRuntimeRoute(spec, {
        sourceLocationPatternId: sourceLocation.locationPatternId,
        destinationLocationPatternId,
      }),
    ];
  });

  const locations = new Map(
    policy.locations.map((location) => [location.locationPatternId, location]),
  );
  for (const location of sourceLocations.values()) {
    locations.set(location.locationPatternId, location);
  }
  locations.set(destinationLocationPatternId, {
    locationPatternId: destinationLocationPatternId,
    locationKind: "wallet",
    asset: destinationAsset,
    ownership: "external_recipient",
    observable: false,
    capabilities: [],
    enabled: true,
  });

  const withdrawalRouteIds = new Set(
    withdrawalRoutes.map((route) => route.routeId),
  );
  const relayProvider = policy.providers.find(
    (provider) => provider.providerId === "relay",
  );
  const relayCapabilities = [
    ...new Set([
      ...(relayProvider?.enabledCapabilities ?? []),
      ...withdrawalRoutes.map((route) => route.capability),
    ]),
  ];
  const providers =
    withdrawalRoutes.length === 0
      ? policy.providers
      : [
          ...policy.providers.filter(
            (provider) => provider.providerId !== "relay",
          ),
          {
            providerId: "relay" as const,
            enabledCapabilities: relayCapabilities,
          },
        ];

  return {
    ...policy,
    placement: DEFAULT_FUNDING_RUNTIME_POLICY.placement,
    routeExperience: FUNDING_ROUTE_EXPERIENCE,
    ttl: FUNDING_TTL,
    locations: [...locations.values()],
    providers,
    routes: [
      ...policy.routes.filter(
        (route) => !withdrawalRouteIds.has(route.routeId),
      ),
      ...withdrawalRoutes,
    ],
  };
}
