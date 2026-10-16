import { stableWalletAssetLocationIdentity } from "../../account-value/canonical.js";
import { RELAY_PINNED_ASSETS } from "../../funding-providers/relay/mappings.js";
import {
  canonicalAccountAddress,
  sameAccountAddress,
} from "./asset-identity.js";
import type { AssetLocation, WalletExecutionProfile } from "./types.js";

/** Immutable planning identities only. A Deposit Wallet handoff links TWO
 * physical balances; it is never a balanceLocationId alias. This constructor
 * is not proof that the handoff executed and cannot authorize a debit/refund. */
export function polymarketHandoffSourceIntent(input: {
  economicLocation: AssetLocation;
  controllerProfile: Pick<
    WalletExecutionProfile,
    "walletId" | "networkId" | "address" | "source"
  >;
}): {
  economicSource: { kind: "owned_location"; location: AssetLocation };
  executionSource: { kind: "owned_location"; location: AssetLocation };
  controllerComponentId: string;
} | null {
  const { economicLocation, controllerProfile } = input;
  const sourceAddress = economicLocation.details.address;
  if (
    economicLocation.kind !== "venue_account" ||
    economicLocation.asset.networkId !== "evm:137" ||
    economicLocation.asset.decimals !== 6 ||
    ![
      RELAY_PINNED_ASSETS.polygonPusd,
      RELAY_PINNED_ASSETS.polygonUsdce,
      RELAY_PINNED_ASSETS.polygonUsdc,
    ].includes(economicLocation.asset.assetId.toLowerCase()) ||
    (economicLocation.details.venueId !== "polymarket" &&
      economicLocation.details.balanceClass !== "polymarket") ||
    typeof sourceAddress !== "string" ||
    !/^0x[\da-fA-F]{40}$/.test(sourceAddress) ||
    controllerProfile.networkId !== "evm:137" ||
    !/^0x[\da-fA-F]{40}$/.test(controllerProfile.address) ||
    controllerProfile.walletId.length === 0 ||
    controllerProfile.source === "smart" ||
    sameAccountAddress("evm:137", sourceAddress, controllerProfile.address)
  )
    return null;
  const address = canonicalAccountAddress("evm:137", controllerProfile.address);
  const identity = stableWalletAssetLocationIdentity({
    accountId: economicLocation.accountId,
    address,
    asset: economicLocation.asset,
    balanceClass: "polymarket",
  });
  return {
    economicSource: { kind: "owned_location", location: economicLocation },
    executionSource: {
      kind: "owned_location",
      location: {
        kind: "wallet",
        accountId: economicLocation.accountId,
        locationId: identity.locationId,
        asset: economicLocation.asset,
        details: {
          address,
          walletId: controllerProfile.walletId,
          balanceClass: "polymarket",
        },
      },
    },
    controllerComponentId: identity.componentId,
  };
}
