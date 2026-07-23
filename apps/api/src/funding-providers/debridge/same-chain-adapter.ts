import type {
  LegacyBridgeReconciler,
  OptionalFallbackAdapter,
} from "../../funding/legacy/provider-types.js";

export const DEBRIDGE_SAME_CHAIN_LEGACY_RECONCILER: LegacyBridgeReconciler = {
  reconcilerId: "debridge_same_chain_legacy",
  supportedAdapterVersions: [
    "debridge_same_chain_v1",
    "debridge_same_chain_tx_v0",
  ],
  canCreateNewFundingOperation: false,
};

export const DEBRIDGE_SAME_CHAIN_NEW_ROUTE_ALLOWLIST: readonly string[] = [];

export const DEBRIDGE_SAME_CHAIN_OPTIONAL_ADAPTER: OptionalFallbackAdapter = {
  adapterId: "debridge_same_chain_v1",
  capability: "same_network_swap",
  allowlistedRouteIds: DEBRIDGE_SAME_CHAIN_NEW_ROUTE_ALLOWLIST,
};
