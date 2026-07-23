import type { OptionalFallbackAdapter } from "../../funding/legacy/provider-types.js";

export const ACROSS_SWAP_API_NEW_ROUTE_ALLOWLIST: readonly string[] = [];

export const ACROSS_SWAP_API_OPTIONAL_ADAPTER: OptionalFallbackAdapter = {
  adapterId: "across_swap_api_v1",
  capability: "cross_network_swap",
  allowlistedRouteIds: ACROSS_SWAP_API_NEW_ROUTE_ALLOWLIST,
};
