import type { LegacyBridgeReconciler } from "../../funding/legacy/provider-types.js";

export const DEBRIDGE_DLN_LEGACY_RECONCILER: LegacyBridgeReconciler = {
  reconcilerId: "debridge_dln_legacy",
  supportedAdapterVersions: ["debridge_dln_create_tx_v1"],
  canCreateNewFundingOperation: false,
};
