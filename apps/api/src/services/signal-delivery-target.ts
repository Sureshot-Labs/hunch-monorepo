import {
  normalizeHunchVenue,
  venueHasLifecycleCapability,
  type HunchVenue,
  type VenueLifecyclePolicy,
} from "@hunch/shared";

export type SignalDestinationPolicy = {
  targetVenues: HunchVenue[];
  selectionMode: "best-executable";
  fallback: "skip";
};

export type SignalDeliveryCandidate = {
  active: boolean;
  eventId: string;
  executablePrice: number;
  matchMethod: string;
  marketId: string;
  mappedSide: "NO" | "YES";
  mappingConfidence: number;
  mappingMethod: string;
  orderable: boolean;
  priceAsOf: string;
  sourceSide: "NO" | "YES";
  venue: string;
};

export type SignalDeliveryTargetResolution =
  | { reason: null; target: SignalDeliveryCandidate }
  | {
      reason:
        | "ambiguous_mapping"
        | "destination_disabled"
        | "no_executable_target"
        | "stale_price";
      target: null;
    };

export function resolveSignalDeliveryTarget(input: {
  candidates: SignalDeliveryCandidate[];
  destinationPolicy: SignalDestinationPolicy;
  lifecycle: VenueLifecyclePolicy;
  maxPriceAgeMs?: number;
  nowMs?: number;
  sourceSide: "NO" | "YES";
}): SignalDeliveryTargetResolution {
  const nowMs = input.nowMs ?? Date.now();
  const maxPriceAgeMs = input.maxPriceAgeMs ?? 2 * 60 * 1000;
  const venueOrder = new Map(
    input.destinationPolicy.targetVenues.map((venue, index) => [venue, index]),
  );
  const enabledVenues = input.destinationPolicy.targetVenues.filter(
    (venue) =>
      venueHasLifecycleCapability(input.lifecycle, venue, "signalDelivery") &&
      venueHasLifecycleCapability(input.lifecycle, venue, "increaseExposure"),
  );
  if (enabledVenues.length === 0) {
    return { reason: "destination_disabled", target: null };
  }
  const enabled = new Set(enabledVenues);
  let sawAmbiguous = false;
  let sawStale = false;
  const executable = input.candidates.filter((candidate) => {
    const venue = normalizeHunchVenue(candidate.venue);
    if (!venue || !enabled.has(venue)) return false;
    if (
      candidate.sourceSide !== input.sourceSide ||
      candidate.mappingConfidence < 0.9 ||
      !candidate.matchMethod.trim() ||
      !candidate.mappingMethod.trim()
    ) {
      sawAmbiguous = true;
      return false;
    }
    if (!candidate.active || !candidate.orderable) return false;
    const priceAt = Date.parse(candidate.priceAsOf);
    if (
      !Number.isFinite(priceAt) ||
      priceAt > nowMs + 5_000 ||
      nowMs - priceAt > maxPriceAgeMs
    ) {
      sawStale = true;
      return false;
    }
    return (
      Number.isFinite(candidate.executablePrice) &&
      candidate.executablePrice > 0 &&
      candidate.executablePrice <= 1 &&
      Boolean(candidate.eventId) &&
      Boolean(candidate.marketId)
    );
  });

  const target = executable.sort((left, right) => {
    if (left.executablePrice !== right.executablePrice) {
      return left.executablePrice - right.executablePrice;
    }
    const leftVenue = normalizeHunchVenue(left.venue) as HunchVenue;
    const rightVenue = normalizeHunchVenue(right.venue) as HunchVenue;
    const venueDiff =
      (venueOrder.get(leftVenue) ?? Number.MAX_SAFE_INTEGER) -
      (venueOrder.get(rightVenue) ?? Number.MAX_SAFE_INTEGER);
    if (venueDiff !== 0) return venueDiff;
    return left.marketId.localeCompare(right.marketId);
  })[0];
  if (target) return { reason: null, target };
  if (sawAmbiguous) return { reason: "ambiguous_mapping", target: null };
  if (sawStale) return { reason: "stale_price", target: null };
  return { reason: "no_executable_target", target: null };
}
