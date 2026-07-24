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
import type {
  FundingCommitReservation,
  FundingCommitStep,
} from "../persistence/funding-operation-repository.js";
import { assertSameAsset, rawAmount } from "./money.js";
import type { PlannedSourceOption } from "./planning-types.js";

const MAX_COMPOSITE_LEGS = 16;

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
    throw new Error("composite Relay segment lacks exact money");
  }
  const record = asset as Readonly<Record<string, JsonValue>>;
  if (
    typeof record.networkId !== "string" ||
    typeof record.assetId !== "string" ||
    typeof record.decimals !== "number"
  ) {
    throw new Error("composite Relay segment asset is invalid");
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

function sourceReservation(
  source: PlannedSourceOption,
): FundingCommitReservation {
  const reservations = source.commitPlan.reservations.filter(
    (reservation) => reservation.mode === "subtract_available",
  );
  if (reservations.length !== 1) {
    throw new Error(
      "each composite Relay leg must reserve exactly one source component",
    );
  }
  const reservation = reservations[0];
  if (!reservation) {
    throw new Error("composite Relay source reservation disappeared");
  }
  return reservation;
}

function candidateLeg(source: PlannedSourceOption): Readonly<{
  source: PlannedSourceOption;
  leg: SourceOptionLeg;
  reservation: FundingCommitReservation;
}> {
  if (
    source.providerId !== "relay" ||
    source.routeId == null ||
    source.option.source.kind === "composite" ||
    source.option.source.kind === "venue_preparation" ||
    source.commitPlan.operation.planKind !== "wallet_route" ||
    source.commitPlan.segments.length !== 1 ||
    source.commitPlan.steps.length === 0 ||
    !source.option.expectedDestination ||
    !source.option.minimumDestination
  ) {
    throw new Error("composite candidate is not one exact Relay wallet leg");
  }
  const segment = source.commitPlan.segments[0];
  if (!segment) {
    throw new Error("composite Relay segment disappeared");
  }
  const sourceAmount = money(segment.quotedInput);
  const expectedDestination = money(segment.quotedExpectedOutput);
  const minimumDestination = money(segment.quotedMinOutput);
  const sourceRef = source.option.source as Extract<
    FundingSourceRef,
    Readonly<{ kind: "owned_location" | "external_ingress" }>
  >;
  return {
    source,
    reservation: sourceReservation(source),
    leg: {
      sourceLegId: stableOpaqueId(
        "source_leg",
        canonicalJsonHash({
          routeId: source.routeId,
          source: sourceRef,
          sourceAmount,
          expectedDestination,
          minimumDestination,
        }),
      ),
      safeLabel: source.option.safeLabel,
      source: sourceRef,
      sourceAmount,
      expectedDestination,
      minimumDestination,
      fees: source.option.fees,
      eta: source.option.eta,
      requiredActions: source.option.requiredActions,
    },
  };
}

function candidateSubsets<T>(values: readonly T[]): readonly (readonly T[])[] {
  if (values.length > MAX_COMPOSITE_LEGS) {
    throw new Error("too many eligible sources for bounded composite search");
  }
  const subsets: T[][] = [];
  const limit = 1 << values.length;
  for (let mask = 0; mask < limit; mask += 1) {
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
  const values = source.option.fees.map((fee) => fee.estimatedUsd);
  return values.some((value) => value == null)
    ? null
    : addUnsignedDecimals(values as string[]);
}

function selectSubset(
  candidates: readonly ReturnType<typeof candidateLeg>[],
  requiredDestination: Money,
  maximumFeeUsd: string,
  maximumFeeBps: number,
): readonly ReturnType<typeof candidateLeg>[] | null {
  const viable = candidateSubsets(candidates)
    .map((legs) => {
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
        unitPriceUsd: "1",
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
        key: legs.map((item) => item.leg.sourceLegId).join("|"),
      };
    })
    .filter(
      (candidate): candidate is NonNullable<typeof candidate> =>
        candidate != null,
    )
    .sort((left, right) => {
      if (left.excessRaw !== right.excessRaw) {
        return left.excessRaw < right.excessRaw ? -1 : 1;
      }
      if (left.legs.length !== right.legs.length) {
        return left.legs.length - right.legs.length;
      }
      if (left.feeUsd == null || right.feeUsd == null) {
        if (left.feeUsd !== right.feeUsd) return left.feeUsd == null ? 1 : -1;
      } else {
        const feeOrder = compareUnsignedDecimals(left.feeUsd, right.feeUsd);
        if (feeOrder !== 0) return feeOrder;
      }
      return left.key.localeCompare(right.key);
    });
  return viable[0]?.legs ?? null;
}

function aggregateEta(legs: readonly SourceOptionLeg[]): SourceOption["eta"] {
  let minSeconds = 0;
  let maxSeconds = 0;
  for (const leg of legs) {
    if (!leg.eta) return null;
    minSeconds += leg.eta.minSeconds;
    maxSeconds += leg.eta.maxSeconds;
  }
  return { minSeconds, maxSeconds };
}

function renumberSteps(
  selected: readonly ReturnType<typeof candidateLeg>[],
): readonly FundingCommitStep[] {
  const output: FundingCommitStep[] = [];
  let priorLegLastOrdinal: number | null = null;
  for (const [segmentOrdinal, item] of selected.entries()) {
    const legSteps = [...item.source.commitPlan.steps].sort(
      (left, right) => left.ordinal - right.ordinal,
    );
    const oldToNew = new Map<number, number>();
    for (const step of legSteps) {
      oldToNew.set(step.ordinal, output.length);
      const dependsOnOrdinal =
        step.dependsOnOrdinal == null
          ? priorLegLastOrdinal
          : oldToNew.get(step.dependsOnOrdinal);
      if (step.dependsOnOrdinal != null && dependsOnOrdinal == null) {
        throw new Error("composite leg contains a forward step dependency");
      }
      output.push({
        ...step,
        ordinal: output.length,
        segmentOrdinal,
        dependsOnOrdinal: dependsOnOrdinal ?? null,
        actionValidationResult: {
          ...step.actionValidationResult,
          compositeSegmentOrdinal: segmentOrdinal,
        },
      });
    }
    priorLegLastOrdinal = output.at(-1)?.ordinal ?? priorLegLastOrdinal;
  }
  return output;
}

function sameFrozenOperation(
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
    canonicalJsonEqual(a.venueBindingSnapshot, b.venueBindingSnapshot) &&
    canonicalJsonEqual(a.placementSnapshot, b.placementSnapshot)
  );
}

export function buildCompositeRelaySourceOption(
  input: Readonly<{
    candidates: readonly PlannedSourceOption[];
    requiredDestination: Money;
    maximumFeeUsd: string;
    maximumFeeBps: number;
  }>,
): PlannedSourceOption | null {
  const partial = input.candidates
    .filter(
      (source) =>
        source.compositeEligible === true &&
        source.option.minimumDestination != null &&
        rawAmount(source.option.minimumDestination.raw) <
          rawAmount(input.requiredDestination.raw),
    )
    .sort((left, right) =>
      left.option.sourceOptionId.localeCompare(right.option.sourceOptionId),
    )
    .slice(0, MAX_COMPOSITE_LEGS)
    .map(candidateLeg);
  if (partial.length < 2) return null;
  const selected = selectSubset(
    partial,
    input.requiredDestination,
    input.maximumFeeUsd,
    input.maximumFeeBps,
  );
  if (!selected) return null;
  const firstEntry = selected[0];
  if (!firstEntry) return null;
  const first = firstEntry.source;
  if (
    selected.some(
      (item) =>
        !sameFrozenOperation(first, item.source) ||
        item.leg.source.kind !== "owned_location" ||
        item.leg.source.location.locationId !== item.reservation.locationId,
    )
  ) {
    throw new Error(
      "composite Relay legs differ in destination or source reservation",
    );
  }
  const componentKeys = new Set<string>();
  for (const item of selected) {
    const key = `${item.reservation.componentId}\u0000${item.reservation.mode}`;
    if (componentKeys.has(key)) {
      throw new Error("composite Relay plan reserves one component twice");
    }
    componentKeys.add(key);
  }

  const legs = selected.map((item) => item.leg);
  const expectedRaw = legs.reduce(
    (sum, leg) => sum + rawAmount(leg.expectedDestination.raw),
    0n,
  );
  const minimumRaw = legs.reduce(
    (sum, leg) => sum + rawAmount(leg.minimumDestination.raw),
    0n,
  );
  const expectedDestination = {
    asset: input.requiredDestination.asset,
    raw: expectedRaw.toString(),
  };
  const minimumDestination = {
    asset: input.requiredDestination.asset,
    raw: minimumRaw.toString(),
  };
  const requiredActions = legs.flatMap((leg) => leg.requiredActions);
  const fees = legs.flatMap((leg) => leg.fees);
  const estimatedUsdValues = selected.map(
    (item) => item.source.option.estimatedUsd,
  );
  const expiresAt = new Date(
    Math.min(
      ...selected.map((item) => Date.parse(item.source.option.expiresAt)),
    ),
  ).toISOString();
  const experienceMode = selected.some(
    (item) => item.source.option.experienceMode === "prepare_first",
  )
    ? "prepare_first"
    : "inline_funding";
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
    amountMode: "exact_input",
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
        selected
          .flatMap((item) => item.source.option.reasonCodes)
          .filter((code) => code !== "minimum_output_not_met"),
      ),
    ],
  };
  const walletSnapshots = selected.map(
    (item) => item.source.commitPlan.operation.walletExecutionSnapshot,
  );
  const plan = {
    operation: {
      ...first.commitPlan.operation,
      initialState: {
        status: "in_progress" as const,
        stage: "committed" as const,
      },
      experienceMode:
        experienceMode === "inline_funding"
          ? ("inline" as const)
          : ("prepare_first" as const),
      planKind: "composite_route" as const,
      sourceSnapshot: jsonRecord(option),
      walletExecutionSnapshot: jsonRecord({ profiles: walletSnapshots }),
      requestedSourceAmount: null,
      requestedDestinationAmount: jsonRecord(input.requiredDestination),
      supportMetadata: {
        ...(first.commitPlan.operation.supportMetadata ?? {}),
        composite: true,
        sourceLegIds: legs.map((leg) => leg.sourceLegId),
        routeIds: selected.map((item) => {
          if (!item.source.routeId) {
            throw new Error("composite Relay route ID disappeared");
          }
          return item.source.routeId;
        }),
      },
    },
    segments: selected.flatMap((item) => item.source.commitPlan.segments),
    steps: renumberSteps(selected),
    reservations: selected.map((item, segmentOrdinal) => ({
      ...item.reservation,
      segmentOrdinal,
    })),
  };
  return {
    option,
    commitPlan: plan,
    routeId: null,
    providerId: "relay",
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
