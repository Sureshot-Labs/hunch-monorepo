import type { CommittedFundingIdentity } from "../funding/domain/committed-economic-identity.js";
import type { AssetLocation } from "../funding/domain/types.js";
import {
  isEvmAddress,
  isEvmNetworkId,
} from "../funding/domain/asset-identity.js";
import { hypercoreLocationDex } from "../funding/domain/hypercore-identity.js";
import {
  canonicalLocationKey,
  hypercorePerpsRefundLocation,
  hypercoreSpotAccountLocation,
  stableOpaqueId,
  stableWalletAssetLocationIdentity,
  stableVenueAssetLocationId,
} from "./canonical.js";
import { RELAY_PINNED_ASSETS } from "../funding-providers/relay/mappings.js";

export type FundingReadLocationAlias = Readonly<{
  originalLocation: AssetLocation;
  originalComponentId: string;
  currentLocation: AssetLocation;
  currentComponentId: string;
}>;

/** Read-view rebasing only, AFTER committed original-subject/current-owner
 * validation. Never update frozen plans/reservations, authorize execution or
 * interpret balanceLocationId as a physical alias. Only known canonical wallet
 * and native spot/perps namespaces can be regenerated for the current owner.
 * An arbitrary legacy/synthetic ID remains unmapped, not address-only authority.
 */
export function committedFundingReadLocationAlias(
  location: AssetLocation,
  identity: CommittedFundingIdentity,
): FundingReadLocationAlias | null {
  if (
    location.accountId !== identity.originalEconomicAccountId ||
    identity.currentOwnerUserId.length === 0 ||
    typeof location.details.address !== "string"
  )
    return null;
  const address = location.details.address;
  let originalLocationId: string;
  let currentLocationId: string;
  if (location.kind === "wallet") {
    if (
      !isEvmNetworkId(location.asset.networkId) ||
      !isEvmAddress(address) ||
      location.details.balanceLocationId !== undefined ||
      (location.details.balanceClass !== undefined &&
        typeof location.details.balanceClass !== "string")
    )
      return null;
    const walletIdentity = (accountId: string) =>
      stableWalletAssetLocationIdentity({
        accountId,
        address,
        asset: location.asset,
        balanceClass:
          typeof location.details.balanceClass === "string"
            ? location.details.balanceClass
            : "",
      });
    originalLocationId = walletIdentity(location.accountId).locationId;
    currentLocationId = walletIdentity(identity.currentOwnerUserId).locationId;
  } else if (
    location.kind === "venue_account" &&
    location.asset.networkId === "evm:137" &&
    location.asset.decimals === 6 &&
    [
      RELAY_PINNED_ASSETS.polygonPusd,
      RELAY_PINNED_ASSETS.polygonUsdce,
      RELAY_PINNED_ASSETS.polygonUsdc,
    ].includes(location.asset.assetId.toLowerCase()) &&
    location.details.venueId === "polymarket" &&
    location.details.balanceClass === "polymarket" &&
    location.details.balanceLocationId === undefined &&
    isEvmAddress(address)
  ) {
    originalLocationId = stableVenueAssetLocationId({
      accountId: location.accountId,
      address,
      asset: location.asset,
    });
    currentLocationId = stableVenueAssetLocationId({
      accountId: identity.currentOwnerUserId,
      address,
      asset: location.asset,
    });
  } else {
    const dex = hypercoreLocationDex(location);
    if (dex === null || !isEvmAddress(address)) return null;
    const nativeIdentity = (accountId: string) => {
      const input = {
        accountId,
        address,
        controllerWalletId: "read-view-only",
      };
      return dex === "spot"
        ? hypercoreSpotAccountLocation(input).location
        : hypercorePerpsRefundLocation(input);
    };
    originalLocationId = nativeIdentity(location.accountId).locationId;
    currentLocationId = nativeIdentity(identity.currentOwnerUserId).locationId;
  }
  if (location.locationId !== originalLocationId) return null;
  const currentLocation = {
    ...location,
    accountId: identity.currentOwnerUserId,
    locationId: currentLocationId,
  };
  return {
    originalLocation: location,
    originalComponentId: stableOpaqueId(
      "asset",
      canonicalLocationKey(location),
    ),
    currentLocation,
    currentComponentId: stableOpaqueId(
      "asset",
      canonicalLocationKey(currentLocation),
    ),
  };
}
