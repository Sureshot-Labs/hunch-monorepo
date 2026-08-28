import {
  addUnsignedDecimals,
  compareUnsignedDecimals,
  multiplyRawByUnitPrice,
  multiplyUnsignedDecimals,
} from "../../account-value/decimal.js";
import { stableOpaqueId } from "../../account-value/canonical.js";
import type {
  ActionSummary,
  FundingSourceRef,
  JsonValue,
  Money,
  SourceOption,
  SourceOptionLeg,
} from "../domain/types.js";
import {
  canonicalJsonEqual,
  canonicalJsonHash,
} from "../persistence/canonical.js";
import {
  fundingEconomicSourceReservations,
  type FundingCommitReservation,
  type FundingCommitStep,
} from "../persistence/funding-operation-repository.js";
import { assertSameAsset, rawAmount } from "./money.js";
import {
  commitPlanRunsWithoutUserWalletAction,
  plannedSourceRunsWithClientWalletActions,
  type PlannedSourceOption,
} from "./planning-types.js";
import { fundingOwnedSourceIncludesLocation } from "./source-adapter.js";

/**
 * The subset search is exhaustive within an explicit operational bound so
 * selection remains deterministic and minimizes excess output. Discovery
 * fails closed above the bound instead of silently discarding contributors
 * and claiming an optimum over an incomplete candidate set.
 */
const MAX_COMPOSITE_CANDIDATES = 16;

type CompositeCandidateKind = "provider_segment" | "venue_preparation";

type CompositeCandidate = Readonly<{
  kind: CompositeCandidateKind;
  source: PlannedSourceOption;
  leg: SourceOptionLeg;
  reservations: readonly FundingCommitReservation[];
}>;

type RebasedCandidate = Readonly<{
  candidate: CompositeCandidate;
  providerSegmentOrdinal: number | null;
}>;

function jsonRecord(value: unknown): Readonly<Record<string, JsonValue>> {
  return value as Readonly<Record<string, JsonValue>>;
}

function money(value: Readonly<Record<string, JsonValue>>): Money {
  const raw = value.raw;
  const asset = value.asset;
  if (
    typeof raw !== "string" ||
    !asset ||
    typeof asset !== "object" ||
    Array.isArray(asset)
  ) {
    throw new Error("composite candidate lacks exact money");
  }
  const record = asset as Readonly<Record<string, JsonValue>>;
  if (
    typeof record.networkId !== "string" ||
    typeof record.assetId !== "string" ||
    typeof record.decimals !== "number"
  ) {
    throw new Error("composite candidate asset is invalid");
  }
  return {
    asset: {
      networkId: record.networkId,
      assetId: record.assetId,
      decimals: record.decimals,
    },
    raw,
  };
}

function positiveEconomics(source: PlannedSourceOption): Readonly<{
  expectedDestination: Money;
  minimumDestination: Money;
}> {
  const expectedDestination = source.option.expectedDestination;
  const minimumDestination = source.option.minimumDestination;
  if (
    !expectedDestination ||
    !minimumDestination ||
    rawAmount(expectedDestination.raw) < rawAmount(minimumDestination.raw) ||
    rawAmount(minimumDestination.raw) === 0n
  ) {
    throw new Error("composite candidate lacks positive exact economics");
  }
  return { expectedDestination, minimumDestination };
}

function sourceLegId(
  source: PlannedSourceOption,
  sourceAmount: Money,
  expectedDestination: Money,
  minimumDestination: Money,
): string {
  return stableOpaqueId(
    "source_leg",
    canonicalJsonHash({
      sourceOptionId: source.option.sourceOptionId,
      source: source.option.source,
      sourceAmount,
      expectedDestination,
      minimumDestination,
    }),
  );
}

function venuePreparationCandidate(
  source: PlannedSourceOption,
): CompositeCandidate {
  const economics = positiveEconomics(source);
  const economicReservations = fundingEconomicSourceReservations(
    source.commitPlan.reservations,
  );
  const preparationInputs =
    source.option.source.kind === "venue_preparation"
      ? source.option.source.inputs
      : undefined;
  if (
    source.option.kind !== "venue_preparation" ||
    source.option.source.kind !== "venue_preparation" ||
    source.commitPlan.operation.planKind !== "venue_preparation" ||
    source.commitPlan.segments.length !== 0 ||
    source.commitPlan.steps.length === 0 ||
    source.commitPlan.steps.some(
      (step) =>
        step.stepKind !== "venue_preparation" || step.segmentOrdinal !== null,
    ) ||
    economicReservations.length !== source.option.source.inputCount ||
    source.commitPlan.reservations.some(
      (reservation) =>
        reservation.segmentOrdinal !== null ||
        reservation.mode !== "subtract_available",
    ) ||
    (preparationInputs != null &&
      (preparationInputs.length !== economicReservations.length ||
        preparationInputs.some((input) => {
          const matches = economicReservations.filter(
            ({ reservation, rawAmount }) =>
              reservation.locationId === input.locationId &&
              reservation.networkId === input.asset.networkId &&
              reservation.assetId.toLowerCase() ===
                input.asset.assetId.toLowerCase() &&
              reservation.assetDecimals === input.asset.decimals &&
              rawAmount === input.rawAmount,
          );
          return matches.length !== 1;
        })))
  ) {
    throw new Error(
      "composite venue preparation candidate has an invalid frozen plan",
    );
  }
  const sourceAmount = economics.expectedDestination;
  return {
    kind: "venue_preparation",
    source,
    reservations: source.commitPlan.reservations,
    leg: {
      sourceLegId: sourceLegId(
        source,
        sourceAmount,
        economics.expectedDestination,
        economics.minimumDestination,
      ),
      safeLabel: source.option.safeLabel,
      source: source.option.source,
      sourceAmount,
      expectedDestination: economics.expectedDestination,
      minimumDestination: economics.minimumDestination,
      fees: source.option.fees,
      eta: source.option.eta,
      requiredActions: source.option.requiredActions,
    },
  };
}

function reservationLocationMatchesSource(
  source: Extract<FundingSourceRef, Readonly<{ kind: "owned_location" }>>,
  reservation: FundingCommitReservation,
): boolean {
  return fundingOwnedSourceIncludesLocation(source, reservation.locationId);
}

function providerCandidate(source: PlannedSourceOption): CompositeCandidate {
  const economics = positiveEconomics(source);
  if (
    source.providerId !== "relay" ||
    source.routeId == null ||
    source.option.source.kind !== "owned_location" ||
    source.commitPlan.operation.planKind !== "wallet_route" ||
    source.commitPlan.segments.length !== 1 ||
    source.commitPlan.steps.length === 0
  ) {
    throw new Error(
      "composite provider candidate is not one exact Relay wallet leg",
    );
  }
  const segment = source.commitPlan.segments[0];
  if (!segment || segment.providerId !== "relay") {
    throw new Error("composite Relay segment disappeared");
  }
  const reservations = source.commitPlan.reservations.filter(
    (reservation) => reservation.mode === "subtract_available",
  );
  const reservation = reservations[0];
  if (
    reservations.length !== 1 ||
    !reservation ||
    !reservationLocationMatchesSource(source.option.source, reservation)
  ) {
    throw new Error(
      "each composite Relay leg must reserve its one owned source component",
    );
  }
  const sourceAmount = money(segment.quotedInput);
  const expectedDestination = money(segment.quotedExpectedOutput);
  const minimumDestination = money(segment.quotedMinOutput);
  if (
    !canonicalJsonEqual(expectedDestination, economics.expectedDestination) ||
    !canonicalJsonEqual(minimumDestination, economics.minimumDestination)
  ) {
    throw new Error(
      "composite Relay public economics differ from its committed segment",
    );
  }
  return {
    kind: "provider_segment",
    source,
    reservations,
    leg: {
      sourceLegId: sourceLegId(
        source,
        sourceAmount,
        expectedDestination,
        minimumDestination,
      ),
      safeLabel: source.option.safeLabel,
      source: source.option.source,
      sourceAmount,
      expectedDestination,
      minimumDestination,
      fees: source.option.fees,
      eta: source.option.eta,
      requiredActions: source.option.requiredActions,
    },
  };
}

function candidate(source: PlannedSourceOption): CompositeCandidate {
  return source.option.source.kind === "venue_preparation"
    ? venuePreparationCandidate(source)
    : providerCandidate(source);
}

function candidateSubsets<T>(values: readonly T[]): readonly (readonly T[])[] {
  if (values.length > MAX_COMPOSITE_CANDIDATES) {
    throw new Error("too many eligible sources for bounded composite search");
  }
  const subsets: T[][] = [];
  const maskLimit = 1 << values.length;
  for (let mask = 0; mask < maskLimit; mask += 1) {
    // Composite means at least two independently executable contributors.
    if ((mask & (mask - 1)) === 0) continue;
    const subset: T[] = [];
    for (let index = 0; index < values.length; index += 1) {
      if ((mask & (1 << index)) === 0) continue;
      const value = values[index];
      if (value !== undefined) subset.push(value);
    }
    subsets.push(subset);
  }
  return subsets;
}

function estimatedFeeUsd(source: PlannedSourceOption): string | null {
  if (source.option.fees.length === 0) return "0";
  const values = source.option.fees.map((fee) => fee.estimatedUsd);
  return values.some((value) => value == null)
    ? null
    : addUnsignedDecimals(values as string[]);
}

function selectSubset(
  candidates: readonly CompositeCandidate[],
  requiredDestination: Money,
  destinationUnitPriceUsd: string,
  maximumFeeUsd: string,
  maximumFeeBps: number,
): readonly CompositeCandidate[] | null {
  const viable = candidateSubsets(candidates)
    .map((legs) => {
      if (selectedCandidateCompatibilityIssue(legs)) return null;
      let minimumRaw = 0n;
      for (const item of legs) {
        assertSameAsset(
          item.leg.minimumDestination.asset,
          requiredDestination.asset,
          "composite minimum destination",
        );
        minimumRaw += rawAmount(item.leg.minimumDestination.raw);
      }
      if (minimumRaw < rawAmount(requiredDestination.raw)) return null;
      const feeValues = legs.map((item) => estimatedFeeUsd(item.source));
      const feeUsd = feeValues.some((value) => value == null)
        ? null
        : addUnsignedDecimals(feeValues as string[]);
      const minimumUsd = multiplyRawByUnitPrice({
        raw: minimumRaw.toString(),
        decimals: requiredDestination.asset.decimals,
        unitPriceUsd: destinationUnitPriceUsd,
      });
      if (
        feeUsd == null ||
        compareUnsignedDecimals(feeUsd, maximumFeeUsd) > 0 ||
        compareUnsignedDecimals(
          multiplyUnsignedDecimals(feeUsd, "10000"),
          multiplyUnsignedDecimals(minimumUsd, maximumFeeBps.toString()),
        ) > 0
      ) {
        return null;
      }
      return {
        legs,
        excessRaw: minimumRaw - rawAmount(requiredDestination.raw),
        feeUsd,
        key: legs
          .map((item) => item.leg.sourceLegId)
          .sort()
          .join("|"),
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry != null)
    .sort((left, right) => {
      if (left.excessRaw !== right.excessRaw) {
        return left.excessRaw < right.excessRaw ? -1 : 1;
      }
      if (left.legs.length !== right.legs.length) {
        return left.legs.length - right.legs.length;
      }
      const feeOrder = compareUnsignedDecimals(left.feeUsd, right.feeUsd);
      return feeOrder !== 0 ? feeOrder : left.key.localeCompare(right.key);
    });
  return viable[0]?.legs ?? null;
}

function candidateFeeWithinLimits(input: {
  legs: readonly CompositeCandidate[];
  destinationAsset: Money["asset"];
  destinationUnitPriceUsd: string;
  maximumFeeUsd: string;
  maximumFeeBps: number;
  maximumSlippageBps: number;
}): Readonly<{ feeUsd: string; minimumRaw: bigint }> | null {
  let minimumRaw = 0n;
  for (const item of input.legs) {
    assertSameAsset(
      item.leg.minimumDestination.asset,
      input.destinationAsset,
      "account funding capacity destination",
    );
    const legMinimumRaw = rawAmount(item.leg.minimumDestination.raw);
    const legExpectedRaw = rawAmount(item.leg.expectedDestination.raw);
    if (
      legExpectedRaw < legMinimumRaw ||
      legMinimumRaw * 10_000n <
        legExpectedRaw * BigInt(10_000 - input.maximumSlippageBps)
    ) {
      return null;
    }
    minimumRaw += legMinimumRaw;
  }
  if (minimumRaw <= 0n) return null;
  const feeValues = input.legs.map((item) => estimatedFeeUsd(item.source));
  const feeUsd = feeValues.some((value) => value == null)
    ? null
    : addUnsignedDecimals(feeValues as string[]);
  if (feeUsd == null) return null;
  const minimumUsd = multiplyRawByUnitPrice({
    raw: minimumRaw.toString(),
    decimals: input.destinationAsset.decimals,
    unitPriceUsd: input.destinationUnitPriceUsd,
  });
  if (
    compareUnsignedDecimals(feeUsd, input.maximumFeeUsd) > 0 ||
    compareUnsignedDecimals(
      multiplyUnsignedDecimals(feeUsd, "10000"),
      multiplyUnsignedDecimals(minimumUsd, input.maximumFeeBps.toString()),
    ) > 0
  ) {
    return null;
  }
  return { feeUsd, minimumRaw };
}

/**
 * Returns the largest destination minimum that the already-validated owned
 * source quotes can produce without external ingress. Capacity discovery
 * quotes every owned source at exact input; this bounded subset search then
 * applies the same compatibility and aggregate fee rules as a real composite
 * plan. A null result is fail-closed (including candidate overflow).
 */
export function maximumInternalFundingDestinationRaw(
  input: Readonly<{
    candidates: readonly PlannedSourceOption[];
    destinationAsset: Money["asset"];
    destinationUnitPriceUsd: string;
    maximumFeeUsd: string;
    maximumFeeBps: number;
    maximumSlippageBps: number;
    executionBoundary?: "automatic" | "client_handoff";
    excludedSourceLocationIds?: readonly string[];
  }>,
): bigint | null {
  const executionBoundary = input.executionBoundary ?? "automatic";
  const excludedSourceLocationIds = new Set(
    input.excludedSourceLocationIds ?? [],
  );
  const eligible = input.candidates.filter((source) => {
    const sourceKind = source.option.source.kind;
    const minimum = source.option.minimumDestination;
    const spendsExcludedLocation = fundingEconomicSourceReservations(
      source.commitPlan.reservations,
    ).some(({ reservation }) =>
      excludedSourceLocationIds.has(reservation.locationId),
    );
    return (
      (sourceKind === "owned_location" || sourceKind === "venue_preparation") &&
      !spendsExcludedLocation &&
      (executionBoundary === "client_handoff"
        ? plannedSourceRunsWithClientWalletActions(source)
        : source.compositeEligible === true &&
          commitPlanRunsWithoutUserWalletAction(source.commitPlan)) &&
      minimum != null &&
      rawAmount(minimum.raw) > 0n
    );
  });
  if (eligible.length === 0) return 0n;
  if (eligible.length > MAX_COMPOSITE_CANDIDATES) return null;

  const candidates = eligible.map(candidate);
  const selections = [
    ...candidates.map((entry) => [entry] as const),
    ...candidateSubsets(candidates),
  ];
  let maximumRaw = 0n;
  for (const legs of selections) {
    if (legs.length > 1 && selectedCandidateCompatibilityIssue(legs)) {
      continue;
    }
    const economics = candidateFeeWithinLimits({
      legs,
      destinationAsset: input.destinationAsset,
      destinationUnitPriceUsd: input.destinationUnitPriceUsd,
      maximumFeeUsd: input.maximumFeeUsd,
      maximumFeeBps: input.maximumFeeBps,
      maximumSlippageBps: input.maximumSlippageBps,
    });
    if (economics && economics.minimumRaw > maximumRaw) {
      maximumRaw = economics.minimumRaw;
    }
  }
  return maximumRaw;
}

function candidateOrder(
  left: CompositeCandidate,
  right: CompositeCandidate,
): number {
  return (
    Number(left.kind === "provider_segment") -
      Number(right.kind === "provider_segment") ||
    left.source.option.sourceOptionId.localeCompare(
      right.source.option.sourceOptionId,
    )
  );
}

function aggregateEta(legs: readonly SourceOptionLeg[]): SourceOption["eta"] {
  if (legs.some((leg) => leg.eta == null)) return null;
  const eta = legs.map((leg) => {
    if (!leg.eta) throw new Error("composite ETA disappeared");
    return leg.eta;
  });
  return {
    minSeconds: Math.max(...eta.map((entry) => entry.minSeconds)),
    maxSeconds: Math.max(...eta.map((entry) => entry.maxSeconds)),
  };
}

function rebaseCandidates(
  selected: readonly CompositeCandidate[],
): readonly RebasedCandidate[] {
  let providerSegmentOrdinal = 0;
  return selected.map((entry) => {
    if (entry.kind === "venue_preparation") {
      return { candidate: entry, providerSegmentOrdinal: null };
    }
    const rebased = { candidate: entry, providerSegmentOrdinal };
    providerSegmentOrdinal += 1;
    return rebased;
  });
}

function rebaseSteps(
  selected: readonly RebasedCandidate[],
): readonly FundingCommitStep[] {
  const output: FundingCommitStep[] = [];
  for (const entry of selected) {
    const oldToNew = new Map<number, number>();
    const steps = [...entry.candidate.source.commitPlan.steps].sort(
      (left, right) => left.ordinal - right.ordinal,
    );
    for (const step of steps) {
      const ordinal = output.length;
      let dependsOnOrdinal: number | null = null;
      if (step.dependsOnOrdinal != null) {
        const mappedDependency = oldToNew.get(step.dependsOnOrdinal);
        if (mappedDependency == null) {
          throw new Error(
            "composite contributor contains a forward step dependency",
          );
        }
        dependsOnOrdinal = mappedDependency;
      }
      oldToNew.set(step.ordinal, ordinal);
      output.push({
        ...step,
        ordinal,
        segmentOrdinal:
          step.segmentOrdinal == null ? null : entry.providerSegmentOrdinal,
        dependsOnOrdinal,
        actionValidationResult: {
          ...step.actionValidationResult,
          compositeSourceLegId: entry.candidate.leg.sourceLegId,
          compositeSegmentOrdinal: entry.providerSegmentOrdinal,
        },
      });
    }
  }
  return output;
}

function rebaseReservations(
  selected: readonly RebasedCandidate[],
): readonly FundingCommitReservation[] {
  return selected.flatMap((entry) =>
    entry.candidate.reservations.map((reservation) => ({
      ...reservation,
      segmentOrdinal:
        reservation.segmentOrdinal == null
          ? null
          : entry.providerSegmentOrdinal,
    })),
  );
}

function sameFrozenOperationFacts(
  left: PlannedSourceOption,
  right: PlannedSourceOption,
): boolean {
  const a = left.commitPlan.operation;
  const b = right.commitPlan.operation;
  return (
    a.purpose === b.purpose &&
    a.externalRecipientId === b.externalRecipientId &&
    a.venueId === b.venueId &&
    a.marketId === b.marketId &&
    canonicalJsonEqual(
      a.destinationTargetSnapshot,
      b.destinationTargetSnapshot,
    ) &&
    canonicalJsonEqual(a.marketContextSnapshot, b.marketContextSnapshot) &&
    canonicalJsonEqual(a.placementSnapshot, b.placementSnapshot)
  );
}

function venueBindingOptionId(source: PlannedSourceOption): string | null {
  const metadata =
    source.commitPlan.operation.supportMetadata?.venueBindingOptionId;
  if (typeof metadata === "string" && metadata.trim()) return metadata;
  const snapshot = source.commitPlan.operation.venueBindingSnapshot;
  const snapshotId = snapshot?.venueBindingOptionId;
  return typeof snapshotId === "string" && snapshotId.trim()
    ? snapshotId
    : null;
}

function destinationObservation(source: PlannedSourceOption): JsonValue | null {
  return (
    source.commitPlan.operation.supportMetadata?.destinationObservation ?? null
  );
}

function sharedProviderDestinationObservation(
  selected: readonly CompositeCandidate[],
): JsonValue {
  const providerCandidates = selected.filter(
    (entry) => entry.kind === "provider_segment",
  );
  const first = providerCandidates[0];
  const observation = first ? destinationObservation(first.source) : null;
  if (
    observation == null ||
    providerCandidates.some(
      (entry) =>
        !canonicalJsonEqual(destinationObservation(entry.source), observation),
    )
  ) {
    throw new Error(
      "composite Relay contributors lack one immutable destination baseline",
    );
  }
  return observation;
}

function selectedCandidateCompatibilityIssue(
  selected: readonly CompositeCandidate[],
): string | null {
  const first = selected[0];
  if (
    !first ||
    selected.some(
      (entry) => !sameFrozenOperationFacts(first.source, entry.source),
    )
  ) {
    return "composite contributors differ in destination or frozen intent facts";
  }
  const preparations = selected.filter(
    (entry) => entry.kind === "venue_preparation",
  );
  if (preparations.length > 1) {
    return "one destination cannot contain multiple venue preparation plans";
  }
  const bindingOptionIds = new Set(
    selected
      .map((entry) => venueBindingOptionId(entry.source))
      .filter((value): value is string => value != null),
  );
  if (bindingOptionIds.size > 1) {
    return "composite Relay contributors use different destination bindings";
  }
  const providerObservations = selected
    .filter((entry) => entry.kind === "provider_segment")
    .map((entry) => destinationObservation(entry.source));
  const firstProviderObservation = providerObservations[0];
  if (
    firstProviderObservation == null ||
    providerObservations.some(
      (observation) =>
        !canonicalJsonEqual(observation, firstProviderObservation),
    )
  ) {
    return "composite Relay contributors lack one immutable destination baseline";
  }
  const reservationKeys = new Set<string>();
  for (const entry of selected) {
    for (const reservation of entry.reservations) {
      const key = `${reservation.componentId}\u0000${reservation.mode}`;
      if (reservationKeys.has(key)) {
        return "composite plan reserves one component twice";
      }
      reservationKeys.add(key);
    }
  }
  return null;
}

function assertCompatibleSelectedCandidates(
  selected: readonly CompositeCandidate[],
): void {
  const issue = selectedCandidateCompatibilityIssue(selected);
  if (issue) throw new Error(issue);
}

function aggregateDestination(
  legs: readonly SourceOptionLeg[],
  requiredDestination: Money,
  field: "expectedDestination" | "minimumDestination",
): Money {
  return {
    asset: requiredDestination.asset,
    raw: legs
      .reduce((sum, leg) => sum + rawAmount(leg[field].raw), 0n)
      .toString(),
  };
}

export function buildCompositeSourceOption(
  input: Readonly<{
    candidates: readonly PlannedSourceOption[];
    requiredDestination: Money;
    destinationUnitPriceUsd: string | null;
    maximumFeeUsd: string;
    maximumFeeBps: number;
    executionBoundary?: "automatic" | "client_handoff";
  }>,
): PlannedSourceOption | null {
  if (input.destinationUnitPriceUsd == null) return null;
  const executionBoundary = input.executionBoundary ?? "automatic";
  const eligible = input.candidates
    .filter(
      (source) =>
        (executionBoundary === "client_handoff"
          ? plannedSourceRunsWithClientWalletActions(source)
          : source.compositeEligible === true &&
            commitPlanRunsWithoutUserWalletAction(source.commitPlan)) &&
        source.option.minimumDestination != null &&
        rawAmount(source.option.minimumDestination.raw) > 0n &&
        rawAmount(source.option.minimumDestination.raw) <
          rawAmount(input.requiredDestination.raw),
    )
    .sort((left, right) => {
      const leftRaw = rawAmount(left.option.minimumDestination?.raw ?? "0");
      const rightRaw = rawAmount(right.option.minimumDestination?.raw ?? "0");
      return leftRaw === rightRaw
        ? left.option.sourceOptionId.localeCompare(right.option.sourceOptionId)
        : leftRaw > rightRaw
          ? -1
          : 1;
    });
  if (eligible.length > MAX_COMPOSITE_CANDIDATES) return null;
  const partial = eligible.map(candidate);
  if (partial.length < 2) return null;
  const selected = selectSubset(
    partial,
    input.requiredDestination,
    input.destinationUnitPriceUsd,
    input.maximumFeeUsd,
    input.maximumFeeBps,
  );
  if (!selected) return null;
  const ordered = [...selected].sort(candidateOrder);
  assertCompatibleSelectedCandidates(ordered);
  const rebased = rebaseCandidates(ordered);
  const legs = ordered.map((entry) => entry.leg);
  const expectedDestination = aggregateDestination(
    legs,
    input.requiredDestination,
    "expectedDestination",
  );
  const minimumDestination = aggregateDestination(
    legs,
    input.requiredDestination,
    "minimumDestination",
  );
  const requiredActions = legs.flatMap((leg) => leg.requiredActions);
  const fees = legs.flatMap((leg) => leg.fees);
  const estimatedUsdValues = ordered.map(
    (entry) => entry.source.option.estimatedUsd,
  );
  const expiresAt = new Date(
    Math.min(
      ...ordered.map((entry) => Date.parse(entry.source.option.expiresAt)),
    ),
  ).toISOString();
  const containsPreparation = ordered.some(
    (entry) => entry.kind === "venue_preparation",
  );
  const experienceMode = containsPreparation
    ? "prepare_first"
    : "inline_funding";
  const amountMode = ordered.every(
    (entry) => entry.source.option.amountMode === "exact_input",
  )
    ? "exact_input"
    : "exact_output";
  const option: SourceOption = {
    sourceOptionId: stableOpaqueId(
      "source",
      canonicalJsonHash({
        kind: "composite",
        legs,
        requiredDestination: input.requiredDestination,
      }),
    ),
    kind: "composite",
    safeLabel: `Use ${legs.length} balances`,
    source: { kind: "composite", legCount: legs.length },
    sourceLegs: legs,
    amountMode,
    maximumSourceRaw: null,
    expectedDestination,
    minimumDestination,
    estimatedUsd: estimatedUsdValues.every(
      (value): value is string => value != null,
    )
      ? addUnsignedDecimals(estimatedUsdValues)
      : null,
    fees,
    eta: aggregateEta(legs),
    experienceMode,
    requiredActions,
    expiresAt,
    recommended: true,
    selectable: true,
    reasonCodes: [
      ...new Set(
        ordered
          .flatMap((entry) => entry.source.option.reasonCodes)
          .filter((code) => code !== "minimum_output_not_met"),
      ),
    ],
  };
  const preparation = ordered.find(
    (entry) => entry.kind === "venue_preparation",
  );
  const providerDestinationObservation =
    sharedProviderDestinationObservation(ordered);
  const operationSource = preparation?.source ?? ordered[0]?.source;
  if (!operationSource) return null;
  const bindingOptionId = ordered
    .map((entry) => venueBindingOptionId(entry.source))
    .find((value): value is string => value != null);
  const routeIds = ordered.flatMap((entry) =>
    entry.source.routeId ? [entry.source.routeId] : [],
  );
  const supportMetadata = {
    ...(operationSource.commitPlan.operation.supportMetadata ?? {}),
    composite: true,
    containsVenuePreparation: containsPreparation,
    destinationObservation: providerDestinationObservation,
    ...(preparation
      ? {
          venuePreparationMinimumDestination: jsonRecord(
            preparation.leg.minimumDestination,
          ),
        }
      : {}),
    sourceLegIds: legs.map((leg) => leg.sourceLegId),
    routeIds,
    ...(bindingOptionId ? { venueBindingOptionId: bindingOptionId } : {}),
  };
  const plan = {
    operation: {
      ...operationSource.commitPlan.operation,
      initialState: {
        status: "in_progress" as const,
        stage: "committed" as const,
      },
      experienceMode: containsPreparation
        ? ("prepare_first" as const)
        : ("inline" as const),
      planKind: "composite_route" as const,
      sourceSnapshot: jsonRecord(option),
      walletExecutionSnapshot: jsonRecord({
        profiles: ordered.map(
          (entry) => entry.source.commitPlan.operation.walletExecutionSnapshot,
        ),
      }),
      requestedSourceAmount: null,
      requestedDestinationAmount: jsonRecord(input.requiredDestination),
      supportMetadata,
    },
    segments: ordered.flatMap((entry) => entry.source.commitPlan.segments),
    steps: rebaseSteps(rebased),
    reservations: rebaseReservations(rebased),
  };
  return {
    option,
    commitPlan: plan,
    routeId: null,
    providerId: null,
    compositeEligible: false,
  };
}

export function compositeRequiredActions(
  option: SourceOption,
): readonly ActionSummary[] {
  return option.kind === "composite"
    ? (option.sourceLegs?.flatMap((leg) => leg.requiredActions) ?? [])
    : option.requiredActions;
}
