import { ACROSS_LEGACY_RECONCILER } from "../../funding-providers/across/legacy-reconciler.js";
import {
  ACROSS_SWAP_API_NEW_ROUTE_ALLOWLIST,
  ACROSS_SWAP_API_OPTIONAL_ADAPTER,
} from "../../funding-providers/across/swap-api-adapter.js";
import { BUNGEE_LEGACY_RECONCILER } from "../../funding-providers/bungee/legacy-reconciler.js";
import { DEBRIDGE_DLN_LEGACY_RECONCILER } from "../../funding-providers/debridge/dln-legacy-reconciler.js";
import {
  DEBRIDGE_SAME_CHAIN_LEGACY_RECONCILER,
  DEBRIDGE_SAME_CHAIN_NEW_ROUTE_ALLOWLIST,
  DEBRIDGE_SAME_CHAIN_OPTIONAL_ADAPTER,
} from "../../funding-providers/debridge/same-chain-adapter.js";
import type { LegacyBridgeAdapterVersion } from "./bridge-adapter-classifier.js";
import {
  assertOptionalFallbackRouteEnabled,
  type LegacyBridgeReconciler,
} from "./provider-types.js";

export {
  ACROSS_LEGACY_RECONCILER,
  ACROSS_SWAP_API_NEW_ROUTE_ALLOWLIST,
  ACROSS_SWAP_API_OPTIONAL_ADAPTER,
  BUNGEE_LEGACY_RECONCILER,
  DEBRIDGE_DLN_LEGACY_RECONCILER,
  DEBRIDGE_SAME_CHAIN_LEGACY_RECONCILER,
  DEBRIDGE_SAME_CHAIN_NEW_ROUTE_ALLOWLIST,
  DEBRIDGE_SAME_CHAIN_OPTIONAL_ADAPTER,
  assertOptionalFallbackRouteEnabled,
};
export type {
  LegacyBridgeReconciler,
  OptionalFallbackAdapter,
} from "./provider-types.js";

export const LEGACY_BRIDGE_RECONCILERS = [
  ACROSS_LEGACY_RECONCILER,
  BUNGEE_LEGACY_RECONCILER,
  DEBRIDGE_DLN_LEGACY_RECONCILER,
  DEBRIDGE_SAME_CHAIN_LEGACY_RECONCILER,
] as const;

export function legacyBridgeReconcilerForVersion(
  adapterVersion: LegacyBridgeAdapterVersion,
): LegacyBridgeReconciler {
  const matches = LEGACY_BRIDGE_RECONCILERS.filter((reconciler) =>
    reconciler.supportedAdapterVersions.includes(adapterVersion),
  );
  if (matches.length !== 1 || !matches[0]) {
    throw new Error(
      `legacy bridge adapter ${adapterVersion} has no unique reconciler`,
    );
  }
  return matches[0];
}

export function assertNoLegacyCreationAdapter(
  provider: "bungee" | "across_suggested_fees" | "debridge_dln",
): never {
  throw new Error(`${provider} is reconciliation-only for Funding Operations`);
}
