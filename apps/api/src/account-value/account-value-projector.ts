import type {
  AccountValueProjection,
  HeadlineValueMode,
  ValuedAssetComponent,
  ValuedPositionComponent,
} from "../funding/domain/types.js";
import { addUnsignedDecimals } from "./decimal.js";

export type CollectorError = Readonly<{
  collectorId: string;
  code: string;
  retryable: boolean;
}>;

function includedValue(
  component: ValuedAssetComponent | ValuedPositionComponent,
): string | null {
  if (component.valuationEligibility !== "included") return null;
  return component.estimatedUsd?.value ?? null;
}

function movementStage(component: ValuedAssetComponent): number {
  const stage = component.location.details.representationStage;
  if (stage === "destination" || stage === "refund") return 3;
  if (stage === "in_transit") return 2;
  if (stage === "source") return 1;
  return 0;
}

export function suppressReplacedMovementRepresentations(
  components: readonly ValuedAssetComponent[],
): readonly ValuedAssetComponent[] {
  const selectedByMovement = new Map<string, ValuedAssetComponent>();
  for (const component of components) {
    const movementId = component.location.details.movementId;
    if (typeof movementId !== "string" || movementId.length === 0) continue;
    const selected = selectedByMovement.get(movementId);
    if (
      !selected ||
      movementStage(component) > movementStage(selected) ||
      (movementStage(component) === movementStage(selected) &&
        Date.parse(component.observedAt) > Date.parse(selected.observedAt))
    ) {
      selectedByMovement.set(movementId, component);
    }
  }
  return components.map((component) => {
    const movementId = component.location.details.movementId;
    if (typeof movementId !== "string" || movementId.length === 0) {
      return component;
    }
    if (selectedByMovement.get(movementId) === component) return component;
    return {
      ...component,
      valuationEligibility: "excluded",
      executionEligibility: "ineligible",
      reasonCodes: [
        ...component.reasonCodes,
        "movement_representation_replaced",
      ],
    };
  });
}

export function projectAccountValue(inputs: {
  accountId: string;
  headlineMode: HeadlineValueMode;
  components: readonly ValuedAssetComponent[];
  positionComponents: readonly ValuedPositionComponent[];
  collectorErrors?: readonly CollectorError[];
  asOf: string;
}): AccountValueProjection {
  const canonicalComponents = suppressReplacedMovementRepresentations(
    inputs.components,
  );
  const liquidValues = canonicalComponents
    .map(includedValue)
    .filter((value): value is string => value != null);
  const positionValues = inputs.positionComponents
    .map(includedValue)
    .filter((value): value is string => value != null);
  const liquidAssetsEstimatedUsd = addUnsignedDecimals(liquidValues);
  const positionsEstimatedUsd = addUnsignedDecimals(positionValues);
  const errors = inputs.collectorErrors ?? [];
  const assetIncomplete = canonicalComponents.some(
    (component) =>
      component.valuationEligibility !== "included" &&
      component.valuationEligibility !== "excluded",
  );
  const positionIncomplete = inputs.positionComponents.some(
    (component) => component.valuationEligibility !== "included",
  );
  const assetStale = canonicalComponents.some(
    (component) =>
      component.observationFreshness !== "fresh" ||
      component.valuationEligibility === "stale",
  );
  const positionStale = inputs.positionComponents.some(
    (component) =>
      component.observationFreshness !== "fresh" ||
      component.valuationEligibility === "stale",
  );

  return {
    accountId: inputs.accountId,
    liquidAssetsEstimatedUsd,
    positionsEstimatedUsd,
    totalPortfolioEstimatedUsd: addUnsignedDecimals([
      liquidAssetsEstimatedUsd,
      positionsEstimatedUsd,
    ]),
    headlineMode: inputs.headlineMode,
    positionValuationCompleteness:
      positionIncomplete ||
      errors.some((error) => error.collectorId.includes("position"))
        ? "partial"
        : "complete",
    positionValuationFreshness: positionStale ? "stale" : "fresh",
    cashEstimatedUsd: addUnsignedDecimals(
      canonicalComponents
        .filter((component) => component.category === "cash")
        .map(includedValue)
        .filter((value): value is string => value != null),
    ),
    tokenEstimatedUsd: addUnsignedDecimals(
      canonicalComponents
        .filter((component) => component.category === "token")
        .map(includedValue)
        .filter((value): value is string => value != null),
    ),
    inTransitEstimatedUsd: addUnsignedDecimals(
      canonicalComponents
        .filter((component) => component.category === "in_transit")
        .map(includedValue)
        .filter((value): value is string => value != null),
    ),
    valuationCompleteness:
      assetIncomplete || errors.length > 0 ? "partial" : "complete",
    valuationFreshness: assetStale ? "stale" : "fresh",
    collectorErrors: errors,
    unpricedAssetCount: canonicalComponents.filter(
      (component) => component.valuationEligibility === "unpriced",
    ).length,
    asOf: inputs.asOf,
    components: canonicalComponents,
    positionComponents: inputs.positionComponents,
  };
}

export function resolveEffectiveHeadline(
  projection: AccountValueProjection,
): Readonly<{
  label: "Estimated assets" | "Portfolio value";
  estimatedUsd: string;
  mode: HeadlineValueMode;
  completeness: "complete" | "partial";
  freshness: "fresh" | "stale";
}> {
  if (projection.headlineMode === "liquid_plus_positions") {
    return {
      label: "Portfolio value",
      estimatedUsd: projection.totalPortfolioEstimatedUsd,
      mode: projection.headlineMode,
      completeness:
        projection.valuationCompleteness === "partial" ||
        projection.positionValuationCompleteness === "partial"
          ? "partial"
          : "complete",
      freshness:
        projection.valuationFreshness === "stale" ||
        projection.positionValuationFreshness === "stale"
          ? "stale"
          : "fresh",
    };
  }
  return {
    label: "Estimated assets",
    estimatedUsd: projection.liquidAssetsEstimatedUsd,
    mode: projection.headlineMode,
    completeness: projection.valuationCompleteness,
    freshness: projection.valuationFreshness,
  };
}
