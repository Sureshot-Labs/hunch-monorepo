import type { LegacyBridgeReconciler } from "../../funding/legacy/provider-types.js";

export const BUNGEE_LEGACY_RECONCILER: LegacyBridgeReconciler = {
  reconcilerId: "bungee_legacy",
  supportedAdapterVersions: ["bungee_legacy_v1"],
  canCreateNewFundingOperation: false,
};
