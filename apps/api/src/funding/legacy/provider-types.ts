import type {
  LegacyBridgeAdapterVersion,
  LegacyBridgeReconcilerId,
} from "./bridge-adapter-classifier.js";

export type LegacyBridgeReconciler = Readonly<{
  reconcilerId: LegacyBridgeReconcilerId;
  supportedAdapterVersions: readonly LegacyBridgeAdapterVersion[];
  canCreateNewFundingOperation: false;
}>;

export type OptionalFallbackAdapter = Readonly<{
  adapterId: "across_swap_api_v1" | "debridge_same_chain_v1";
  capability: "cross_network_swap" | "same_network_swap";
  allowlistedRouteIds: readonly string[];
}>;

export function assertOptionalFallbackRouteEnabled(
  adapter: OptionalFallbackAdapter,
  routeId: string,
): void {
  if (!adapter.allowlistedRouteIds.includes(routeId)) {
    throw new Error(
      `${adapter.adapterId} new Funding Operation route is disabled`,
    );
  }
}
