import type {
  FundingReasonCode,
  ValuedAssetComponent,
  VenueBindingId,
  VenueId,
} from "../funding/domain/types.js";
import type { CollectorError } from "./account-value-projector.js";
import { suppressReplacedMovementRepresentations } from "./account-value-projector.js";
import {
  addUnsignedDecimals,
  scaleUnsignedDecimalByRawRatio,
  subtractRawFloor,
} from "./decimal.js";

export type CashAvailabilityAdjustment = Readonly<{
  componentId: string;
  venueId: VenueId | null;
  venueBindingId: VenueBindingId | null;
  lockedRaw: string;
  reservedRaw: string;
  submittedDebitRaw: string;
  availabilityKnown?: boolean;
}>;

export type CashAvailabilityComponent = Readonly<{
  componentId: string;
  venueId: VenueId | null;
  venueBindingId: VenueBindingId | null;
  amount: ValuedAssetComponent["amount"];
  lockedRaw: string;
  reservedRaw: string;
  submittedDebitRaw: string;
  availableRaw: string;
  availableEstimatedUsd: string | null;
  asOf: string;
  freshness: "fresh" | "stale";
  reasonCodes: readonly FundingReasonCode[];
}>;

export type CashAvailabilityProjection = Readonly<{
  cashAvailableEstimatedUsd: string;
  byVenueEstimatedUsd: Readonly<Record<string, string>>;
  completeness: "complete" | "partial";
  freshness: "fresh" | "stale";
  collectorErrors: readonly CollectorError[];
  components: readonly CashAvailabilityComponent[];
  asOf: string;
}>;

export function projectCashAvailability(inputs: {
  components: readonly ValuedAssetComponent[];
  adjustments: readonly CashAvailabilityAdjustment[];
  collectorErrors?: readonly CollectorError[];
  asOf: string;
}): CashAvailabilityProjection {
  const collectorErrors = inputs.collectorErrors ?? [];
  const adjustmentByComponent = new Map(
    inputs.adjustments.map((adjustment) => [
      adjustment.componentId,
      adjustment,
    ]),
  );
  const components = suppressReplacedMovementRepresentations(inputs.components)
    .filter((component) => component.valuationEligibility !== "excluded")
    .filter((component) => component.category === "cash")
    .map((component): CashAvailabilityComponent => {
      const adjustment = adjustmentByComponent.get(component.componentId);
      const lockedRaw = adjustment?.lockedRaw ?? "0";
      const reservedRaw = adjustment?.reservedRaw ?? "0";
      const submittedDebitRaw = adjustment?.submittedDebitRaw ?? "0";
      const availabilityKnown = adjustment?.availabilityKnown !== false;
      const availableRaw = availabilityKnown
        ? subtractRawFloor(component.amount.raw, [
            lockedRaw,
            reservedRaw,
            submittedDebitRaw,
          ])
        : "0";
      const estimate = component.estimatedUsd;
      const availableEstimatedUsd =
        availabilityKnown &&
        component.valuationEligibility === "included" &&
        estimate
          ? component.amount.raw === "0"
            ? "0"
            : scaleUnsignedDecimalByRawRatio({
                value: estimate.value,
                numeratorRaw: availableRaw,
                denominatorRaw: component.amount.raw,
              })
          : null;
      return {
        componentId: component.componentId,
        venueId: adjustment?.venueId ?? null,
        venueBindingId: adjustment?.venueBindingId ?? null,
        amount: component.amount,
        lockedRaw,
        reservedRaw,
        submittedDebitRaw,
        availableRaw,
        availableEstimatedUsd,
        asOf: component.observedAt,
        freshness:
          availabilityKnown &&
          component.observationFreshness === "fresh" &&
          component.valuationEligibility === "included"
            ? "fresh"
            : "stale",
        reasonCodes: availabilityKnown
          ? component.reasonCodes
          : [...component.reasonCodes, "cash_availability_unknown"],
      };
    });

  const byVenue = new Map<string, string[]>();
  for (const component of components) {
    if (!component.venueId || component.availableEstimatedUsd == null) continue;
    const entries = byVenue.get(component.venueId) ?? [];
    entries.push(component.availableEstimatedUsd);
    byVenue.set(component.venueId, entries);
  }

  return {
    cashAvailableEstimatedUsd: addUnsignedDecimals(
      components
        .map((component) => component.availableEstimatedUsd)
        .filter((value): value is string => value != null),
    ),
    byVenueEstimatedUsd: Object.fromEntries(
      [...byVenue.entries()].map(([venueId, values]) => [
        venueId,
        addUnsignedDecimals(values),
      ]),
    ),
    completeness:
      collectorErrors.length > 0 ||
      components.some((component) => component.availableEstimatedUsd == null)
        ? "partial"
        : "complete",
    freshness:
      collectorErrors.length > 0 ||
      components.some((component) => component.freshness === "stale")
        ? "stale"
        : "fresh",
    collectorErrors,
    components,
    asOf: inputs.asOf,
  };
}
