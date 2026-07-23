import type { LegacyBridgeReconciler } from "../../funding/legacy/provider-types.js";

export const ACROSS_LEGACY_RECONCILER: LegacyBridgeReconciler = {
  reconcilerId: "across_legacy",
  supportedAdapterVersions: ["across_swap_api_v1", "across_suggested_fees_v1"],
  canCreateNewFundingOperation: false,
};
