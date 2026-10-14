import type { AssetLocation, Money } from "../../funding/domain/types.js";
import {
  sameAccountAddress,
  sameAsset,
} from "../../funding/domain/asset-identity.js";
import {
  isHypercoreFundingNetwork,
  isHypercoreMainnetUsdc,
  hypercoreLocationDex,
} from "../../funding/domain/hypercore-identity.js";

/** A native spot outflow can refund into perps. Resolve this physical owned
 * location before quote/commit; provider presentation is never ownership. */
export function relayRefundLocation(input: {
  sourceLocation: AssetLocation;
  sourceAmount: Money;
  nativeRefundLocation?: AssetLocation;
}): AssetLocation {
  const source = input.sourceLocation,
    refund = input.nativeRefundLocation;
  if (!isHypercoreFundingNetwork(input.sourceAmount.asset.networkId)) {
    if (refund)
      throw new Error("Native refund location on non-native Relay route");
    return source;
  }
  if (
    !refund ||
    !isHypercoreMainnetUsdc(input.sourceAmount.asset) ||
    !sameAsset(source.asset, input.sourceAmount.asset) ||
    !sameAsset(refund.asset, input.sourceAmount.asset) ||
    source.kind !== "venue_account" ||
    refund.kind !== "venue_account" ||
    source.accountId !== refund.accountId ||
    source.details.venueId !== "hyperliquid" ||
    refund.details.venueId !== "hyperliquid" ||
    source.details.environment !== "mainnet" ||
    refund.details.environment !== "mainnet" ||
    hypercoreLocationDex(source) === null ||
    hypercoreLocationDex(refund) !== "" ||
    typeof source.details.address !== "string" ||
    typeof refund.details.address !== "string" ||
    !/^0x[\da-fA-F]{40}$/.test(source.details.address) ||
    !/^0x[\da-fA-F]{40}$/.test(refund.details.address) ||
    !sameAccountAddress(
      source.asset.networkId,
      source.details.address,
      refund.details.address,
    ) ||
    typeof source.details.controllerWalletId !== "string" ||
    !source.details.controllerWalletId ||
    source.details.controllerWalletId !== refund.details.controllerWalletId ||
    !refund.locationId ||
    (hypercoreLocationDex(source) === "spot" &&
      source.locationId === refund.locationId)
  )
    throw new Error(
      "Native Relay refund location must be the exact owned perps account",
    );
  return refund;
}
