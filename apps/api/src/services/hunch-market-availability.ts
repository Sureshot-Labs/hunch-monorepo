import { computeAcceptingOrders } from "../lib/market-availability.js";

/** A Copy link opens the existing market ticket; it never admits an order. */
export function publicHunchAcceptingOrders(
  input: Parameters<typeof computeAcceptingOrders>[0] & {
    eventStatus?: string | null;
    resolvedOutcome?: string | null;
  },
): boolean {
  if (input.status?.toUpperCase() !== "ACTIVE") return false;
  if (input.resolvedOutcome != null) return false;
  if (input.eventStatus != null && input.eventStatus.toUpperCase() !== "ACTIVE")
    return false;
  // Match event-detail availability: a sports start time is not a CLOB closure.
  return computeAcceptingOrders({
    ...input,
    polymarketOrderabilityMode: "trust_accepting_orders",
  });
}
