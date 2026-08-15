import type { AssetRef } from "../domain/types.js";
import {
  BASE_USDC,
  POLYGON_PUSD,
  POLYGON_USDC,
  POLYGON_USDCE_LEGACY,
} from "../../funding-providers/relay/rehearsal.js";
import {
  TELEGRAM_RELAY_EVM_FUNDING_PROFILE_ID,
  TELEGRAM_RELAY_POLYGON_PUSD_PROFILE_ID,
  TELEGRAM_RELAY_POLYGON_USDC_PROFILE_ID,
  TELEGRAM_RELAY_POLYGON_USDCE_PROFILE_ID,
} from "./delegated-funding-profile-ids.js";

export type RelayEvmFundingProfileSpec = Readonly<{
  profileId: string;
  sourceAsset: AssetRef;
  routeIds: readonly string[];
  venueIds: readonly ("limitless" | "polymarket")[];
}>;

export const RELAY_EVM_FUNDING_PROFILE_SPECS: Readonly<
  Record<string, RelayEvmFundingProfileSpec>
> = Object.freeze({
  [TELEGRAM_RELAY_EVM_FUNDING_PROFILE_ID]: Object.freeze({
    profileId: TELEGRAM_RELAY_EVM_FUNDING_PROFILE_ID,
    sourceAsset: Object.freeze({
      networkId: "evm:8453",
      assetId: BASE_USDC,
      decimals: 6,
    }),
    routeIds: Object.freeze(["base-usdc-to-polygon-pusd"]),
    venueIds: Object.freeze(["polymarket"] as const),
  }),
  [TELEGRAM_RELAY_POLYGON_PUSD_PROFILE_ID]: Object.freeze({
    profileId: TELEGRAM_RELAY_POLYGON_PUSD_PROFILE_ID,
    sourceAsset: Object.freeze({
      networkId: "evm:137",
      assetId: POLYGON_PUSD,
      decimals: 6,
    }),
    routeIds: Object.freeze(["polygon-pusd-to-base-usdc"]),
    venueIds: Object.freeze(["limitless"] as const),
  }),
  [TELEGRAM_RELAY_POLYGON_USDC_PROFILE_ID]: Object.freeze({
    profileId: TELEGRAM_RELAY_POLYGON_USDC_PROFILE_ID,
    sourceAsset: Object.freeze({
      networkId: "evm:137",
      assetId: POLYGON_USDC,
      decimals: 6,
    }),
    routeIds: Object.freeze([
      "polygon-usdc-to-base-usdc",
      "polygon-usdc-to-polygon-pusd",
    ]),
    venueIds: Object.freeze(["limitless", "polymarket"] as const),
  }),
  [TELEGRAM_RELAY_POLYGON_USDCE_PROFILE_ID]: Object.freeze({
    profileId: TELEGRAM_RELAY_POLYGON_USDCE_PROFILE_ID,
    sourceAsset: Object.freeze({
      networkId: "evm:137",
      assetId: POLYGON_USDCE_LEGACY,
      decimals: 6,
    }),
    routeIds: Object.freeze(["polygon-usdce-to-base-usdc"]),
    venueIds: Object.freeze(["limitless"] as const),
  }),
});

export function relayEvmFundingProfileSpec(
  profileId: string,
): RelayEvmFundingProfileSpec | null {
  return RELAY_EVM_FUNDING_PROFILE_SPECS[profileId] ?? null;
}
