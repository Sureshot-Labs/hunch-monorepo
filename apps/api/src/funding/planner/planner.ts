import { randomUUID } from "node:crypto";

import {
  multiplyRawByUnitPrice,
  rawForUsdCeil,
} from "../../account-value/decimal.js";
import type {
  FundingDiscoveryRequest,
  FundingReasonCode,
  IntentLiquidityProjection,
  MarketContextBinding,
  Money,
  PlacementDecision,
  ResolvedExternalRecipient,
  SourceOption,
  ValidatedExternalRecipient,
} from "../domain/types.js";
import {
  resolveFundingDestinationChoice,
  selectFundingDestination,
  selectVenueBindingForCurrentIntent,
} from "../domain/selections.js";
import {
  withdrawalRecipientLocationPatternId,
  withWithdrawalPlanningContract,
} from "../domain/withdrawal-contract.js";
import type { FundingRuntimePolicy } from "../policies/funding-policy.js";
import {
  toResolvedRouteDestination,
  type ResolvedDestinationCandidate,
  type ResolvedRouteDestination,
} from "./destination-adapters.js";
import {
  FundingPlannerError,
  assertSameAsset,
  rawAmount,
  sameAsset,
  subtractFloor,
} from "./money.js";
import {
  decidePlacement,
  minimumAutomaticTradeRefillUsd,
} from "./placement-policy.js";
import {
  commitPlanRunsWithoutUserWalletAction,
  type FundingPlanningSnapshot,
  type FundingPlanningStore,
  type PlannedSourceOption,
} from "./planning-types.js";
import { POLYMARKET_DEPOSIT_PUSD_FUND_PROFILE_ID } from "../execution/delegated-funding-profile-ids.js";

export type FundingSourcePlanningRequest = Readonly<{
  accountId: string;
  request: FundingDiscoveryRequest;
  marketContext: MarketContextBinding | null;
  destinationFacts: ResolvedDestinationCandidate | null;
  destination: ResolvedRouteDestination;
  placement: PlacementDecision;
  requiredAmount: Money;
  policy: FundingRuntimePolicy;
  policyRevision: string;
  now: Date;
}>;

export type FundingSourcePlanningResult = Readonly<{
  sources: readonly PlannedSourceOption[];
  reasonCodes: readonly FundingReasonCode[];
}>;

export type FundingPlannerDependencies = Readonly<{
  listDestinations(
    input: Readonly<{
      accountId: string;
      request: FundingDiscoveryRequest;
      marketContext: MarketContextBinding | null;
    }>,
  ): Promise<readonly ResolvedDestinationCandidate[]>;
  resolveMarketContext(
    input: Readonly<{
      accountId: string;
      marketContextId: string;
    }>,
  ): Promise<MarketContextBinding | null>;
  resolveWithdrawalRecipient?(
    input: Readonly<{
      accountId: string;
      recipientId: string;
    }>,
  ): Promise<ResolvedExternalRecipient | null>;
  listSources(
    input: FundingSourcePlanningRequest,
  ): Promise<readonly PlannedSourceOption[]>;
  discoverSources?(
    input: FundingSourcePlanningRequest,
  ): Promise<FundingSourcePlanningResult>;
  listSourceBlockers?(
    input: FundingSourcePlanningRequest,
  ): Promise<readonly FundingReasonCode[]>;
  store: FundingPlanningStore;
  now?: () => Date;
}>;

async function discoverFundingSources(
  dependencies: FundingPlannerDependencies,
  input: FundingSourcePlanningRequest,
): Promise<FundingSourcePlanningResult> {
  if (dependencies.discoverSources) {
    return dependencies.discoverSources(input);
  }
  const [sources, reasonCodes] = await Promise.all([
    dependencies.listSources(input),
    dependencies.listSourceBlockers?.(input) ?? Promise.resolve([]),
  ]);
  return { sources, reasonCodes };
}

function preparationPurpose(
  purpose: FundingDiscoveryRequest["purpose"],
): "fund" | "buy" | "withdraw" {
  if (purpose === "trade_shortfall") return "buy";
  if (purpose === "withdrawal") return "withdraw";
  return "fund";
}

function recommendedSource(
  sources: readonly PlannedSourceOption[],
): PlannedSourceOption | null {
  const selectable = sources.filter((source) => source.option.selectable);
  if (selectable.length === 0) return null;
  return (
    [...selectable].sort(
      (left, right) =>
        Number(left.option.source.kind === "external_ingress") -
          Number(right.option.source.kind === "external_ingress") ||
        Number(isSelectableAutomaticSource(right)) -
          Number(isSelectableAutomaticSource(left)) ||
        Number(right.option.recommended) - Number(left.option.recommended) ||
        left.option.sourceOptionId.localeCompare(right.option.sourceOptionId),
    )[0] ?? null
  );
}

function isInternalSource(option: SourceOption): boolean {
  if (
    option.source.kind === "owned_location" ||
    option.source.kind === "venue_preparation"
  ) {
    return true;
  }
  if (option.source.kind !== "composite") return false;
  return (
    option.sourceLegs != null &&
    option.sourceLegs.length > 0 &&
    option.sourceLegs.every(
      (leg) =>
        leg.source.kind === "owned_location" ||
        leg.source.kind === "venue_preparation",
    )
  );
}

function isSelectableAutomaticSource(source: PlannedSourceOption): boolean {
  return (
    source.option.selectable &&
    isInternalSource(source.option) &&
    commitPlanRunsWithoutUserWalletAction(source.commitPlan)
  );
}

function applicableSourceBlockingReasons(
  sources: readonly PlannedSourceOption[],
  reasons: readonly FundingReasonCode[],
): readonly FundingReasonCode[] {
  const executablePlanExists = sources.some(isSelectableAutomaticSource);
  return executablePlanExists
    ? reasons.filter(
        (reason) =>
          reason !== "insufficient_gas" &&
          reason !== "provider_status_unknown" &&
          reason !== "rpc_unavailable",
      )
    : reasons;
}

function validatePlannedSources(
  sources: readonly PlannedSourceOption[],
  requiredAmount: Money,
  now: Date,
  purpose: FundingDiscoveryRequest["purpose"],
): readonly PlannedSourceOption[] {
  const ids = new Set<string>();
  return sources.map((source) => {
    if (ids.has(source.option.sourceOptionId)) {
      throw new FundingPlannerError(
        "invalid_policy",
        "source option IDs must be unique within a projection",
      );
    }
    ids.add(source.option.sourceOptionId);
    if (
      purpose === "convert_asset" &&
      source.option.amountMode !== "exact_input"
    ) {
      throw new FundingPlannerError(
        "invalid_policy",
        "Convert source options must freeze exact input economics",
      );
    }
    const segmentCount = source.commitPlan.segments.length;
    const planKind = source.commitPlan.operation.planKind;
    const steps = source.commitPlan.steps;
    const isPusdRouterApprovalThenFund =
      steps.length === 2 &&
      steps[0]?.ordinal === 0 &&
      steps[0]?.stepKind === "transaction" &&
      steps[0]?.state === "planned" &&
      steps[0]?.segmentOrdinal === null &&
      steps[0]?.executorId === POLYMARKET_DEPOSIT_PUSD_FUND_PROFILE_ID &&
      steps[0]?.dependsOnOrdinal === null &&
      steps[0]?.actionValidationResult.kind ===
        "controller_pusd_router_approval" &&
      steps[1]?.ordinal === 1 &&
      steps[1]?.stepKind === "venue_preparation" &&
      steps[1]?.state === "planned" &&
      steps[1]?.segmentOrdinal === null &&
      steps[1]?.executorId === POLYMARKET_DEPOSIT_PUSD_FUND_PROFILE_ID &&
      steps[1]?.dependsOnOrdinal === 0;
    const composite =
      source.option.kind === "composite" ||
      source.option.source.kind === "composite" ||
      source.option.sourceLegs != null ||
      planKind === "composite_route";
    if (
      ((planKind === "wallet_route" || planKind === "relay_deposit_address") &&
        (segmentCount !== 1 ||
          source.commitPlan.segments[0]?.providerId !== "relay")) ||
      ((planKind === "already_available" ||
        planKind === "direct_external_handoff" ||
        planKind === "venue_preparation") &&
        segmentCount !== 0) ||
      (planKind === "composite_route" &&
        (segmentCount < 1 ||
          source.commitPlan.segments.some(
            (segment) => segment.providerId !== "relay",
          )))
    ) {
      throw new FundingPlannerError(
        "invalid_policy",
        "funding source plan shape is incompatible with its execution kind",
      );
    }
    if (
      planKind === "venue_preparation" &&
      (source.option.kind !== "venue_preparation" ||
        source.option.source.kind !== "venue_preparation" ||
        !(
          (steps.length === 1 &&
            steps[0]?.stepKind === "venue_preparation" &&
            steps[0]?.segmentOrdinal === null) ||
          isPusdRouterApprovalThenFund
        ) ||
        source.commitPlan.reservations.length !==
          source.option.source.inputCount ||
        source.commitPlan.reservations.some(
          (reservation) =>
            reservation.segmentOrdinal !== null ||
            reservation.mode !== "subtract_available",
        ))
    ) {
      throw new FundingPlannerError(
        "invalid_policy",
        "venue preparation source, action, and exact inputs differ",
      );
    }
    if (
      planKind !== "venue_preparation" &&
      (source.option.kind === "venue_preparation" ||
        source.option.source.kind === "venue_preparation")
    ) {
      throw new FundingPlannerError(
        "invalid_policy",
        "venue preparation source requires the canonical preparation plan",
      );
    }
    if (composite) {
      const legs = source.option.sourceLegs;
      if (
        source.option.kind !== "composite" ||
        source.option.source.kind !== "composite" ||
        !legs ||
        legs.length < 2 ||
        legs.length !== source.option.source.legCount ||
        planKind !== "composite_route"
      ) {
        throw new FundingPlannerError(
          "invalid_policy",
          "composite source option, legs, and committed segments differ",
        );
      }
      const legIds = new Set<string>();
      let expectedRaw = 0n;
      let minimumRaw = 0n;
      let providerSegmentOrdinal = 0;
      let preparationLegCount = 0;
      for (const leg of legs) {
        if (legIds.has(leg.sourceLegId)) {
          throw new FundingPlannerError(
            "invalid_policy",
            "composite source contains duplicate or nested legs",
          );
        }
        legIds.add(leg.sourceLegId);
        assertSameAsset(
          leg.expectedDestination.asset,
          requiredAmount.asset,
          "composite source expected output",
        );
        assertSameAsset(
          leg.minimumDestination.asset,
          requiredAmount.asset,
          "composite source minimum output",
        );
        if (
          rawAmount(leg.sourceAmount.raw) === 0n ||
          rawAmount(leg.expectedDestination.raw) <
            rawAmount(leg.minimumDestination.raw) ||
          rawAmount(leg.minimumDestination.raw) === 0n
        ) {
          throw new FundingPlannerError(
            "invalid_policy",
            "composite source leg lacks positive exact economics",
          );
        }
        if (leg.source.kind === "venue_preparation") {
          preparationLegCount += 1;
          const preparationSteps = source.commitPlan.steps.filter(
            (step) =>
              step.stepKind === "venue_preparation" &&
              step.segmentOrdinal === null &&
              step.actionValidationResult.compositeSourceLegId ===
                leg.sourceLegId,
          );
          const preparationReservations = source.commitPlan.reservations.filter(
            (reservation) => reservation.segmentOrdinal === null,
          );
          if (
            preparationLegCount > 1 ||
            preparationSteps.length === 0 ||
            preparationReservations.length !== leg.source.inputCount ||
            rawAmount(leg.sourceAmount.raw) !==
              rawAmount(leg.expectedDestination.raw)
          ) {
            throw new FundingPlannerError(
              "invalid_policy",
              "composite venue preparation leg differs from its frozen actions and inputs",
            );
          }
        } else {
          const segment = source.commitPlan.segments[providerSegmentOrdinal];
          providerSegmentOrdinal += 1;
          if (
            leg.source.kind !== "owned_location" ||
            !segment ||
            rawAmount(
              (segment.quotedInput as Readonly<{ raw?: string }>).raw ?? "0",
            ) !== rawAmount(leg.sourceAmount.raw) ||
            rawAmount(
              (
                segment.quotedExpectedOutput as Readonly<{
                  raw?: string;
                }>
              ).raw ?? "0",
            ) !== rawAmount(leg.expectedDestination.raw) ||
            rawAmount(
              (segment.quotedMinOutput as Readonly<{ raw?: string }>).raw ??
                "0",
            ) !== rawAmount(leg.minimumDestination.raw)
          ) {
            throw new FundingPlannerError(
              "invalid_policy",
              "composite provider leg differs from its committed segment",
            );
          }
        }
        expectedRaw += rawAmount(leg.expectedDestination.raw);
        minimumRaw += rawAmount(leg.minimumDestination.raw);
      }
      if (
        providerSegmentOrdinal !== segmentCount ||
        !source.option.expectedDestination ||
        !source.option.minimumDestination ||
        expectedRaw !== rawAmount(source.option.expectedDestination.raw) ||
        minimumRaw !== rawAmount(source.option.minimumDestination.raw)
      ) {
        throw new FundingPlannerError(
          "invalid_policy",
          "composite source aggregate economics differ from its legs",
        );
      }
    } else if (segmentCount > 1) {
      throw new FundingPlannerError(
        "invalid_policy",
        "single source option cannot contain composite execution state",
      );
    }
    if (source.option.selectable) {
      const expected = source.option.expectedDestination;
      const minimum = source.option.minimumDestination;
      if (!expected || !minimum) {
        throw new FundingPlannerError(
          "invalid_policy",
          "selectable source lacks exact output economics",
        );
      }
      assertSameAsset(
        expected.asset,
        requiredAmount.asset,
        "source expected output",
      );
      assertSameAsset(
        minimum.asset,
        requiredAmount.asset,
        "source minimum output",
      );
      if (
        rawAmount(expected.raw) < rawAmount(minimum.raw) ||
        rawAmount(minimum.raw) === 0n ||
        (source.option.amountMode !== "exact_input" &&
          rawAmount(minimum.raw) < rawAmount(requiredAmount.raw))
      ) {
        throw new FundingPlannerError(
          "invalid_policy",
          "selectable source does not satisfy exact placement",
        );
      }
    }
    if (Date.parse(source.option.expiresAt) <= now.getTime()) {
      return {
        ...source,
        option: {
          ...source.option,
          experienceMode: "unavailable" as const,
          selectable: false,
          reasonCodes: [...source.option.reasonCodes, "quote_expired" as const],
        },
      };
    }
    return source;
  });
}

function requestAmount(
  request: FundingDiscoveryRequest,
  marketContext: MarketContextBinding | null,
): Money | null {
  if (
    request.purpose === "convert_asset" &&
    request.confirmedSourceAmount &&
    request.requestedDestinationAmount
  ) {
    const source = BigInt(request.confirmedSourceAmount.raw);
    const sourceDecimals = request.confirmedSourceAmount.asset.decimals;
    const destinationDecimals =
      request.requestedDestinationAmount.asset.decimals;
    const raw =
      sourceDecimals === destinationDecimals
        ? source
        : sourceDecimals < destinationDecimals
          ? source * 10n ** BigInt(destinationDecimals - sourceDecimals)
          : (source +
              10n ** BigInt(sourceDecimals - destinationDecimals) -
              1n) /
            10n ** BigInt(sourceDecimals - destinationDecimals);
    return {
      asset: request.requestedDestinationAmount.asset,
      raw: raw.toString(),
    };
  }
  if (request.requestedDestinationAmount) {
    return request.requestedDestinationAmount;
  }
  if (marketContext) {
    return {
      asset: marketContext.collateralAsset,
      raw: marketContext.requestedCollateralRaw,
    };
  }
  return null;
}

function validatedRecipient(
  recipient: ResolvedExternalRecipient,
): ValidatedExternalRecipient {
  const { address: _address, ...validated } = recipient;
  return validated;
}

function valueCollateral(
  candidate: ResolvedDestinationCandidate,
  raw: string,
  now: Date,
): Readonly<{
  estimatedUsd: string;
  usable: boolean;
  reasonCode: FundingReasonCode | null;
}> {
  const valuation = candidate.collateralValuation;
  if (!valuation) {
    return {
      estimatedUsd: "0",
      usable: false,
      reasonCode: "trusted_price_unavailable",
    };
  }
  const asOf = Date.parse(valuation.asOf);
  const expiresAt = Date.parse(valuation.expiresAt);
  if (
    valuation.pricePolicyId.trim().length < 3 ||
    !Number.isFinite(asOf) ||
    !Number.isFinite(expiresAt)
  ) {
    return {
      estimatedUsd: "0",
      usable: false,
      reasonCode: "trusted_price_unavailable",
    };
  }
  if (asOf > now.getTime() || expiresAt <= now.getTime() || expiresAt <= asOf) {
    return {
      estimatedUsd: "0",
      usable: false,
      reasonCode: "trusted_price_stale",
    };
  }
  try {
    return {
      estimatedUsd: multiplyRawByUnitPrice({
        raw,
        decimals: candidate.option.requiredAsset.decimals,
        unitPriceUsd: valuation.unitPriceUsd,
      }),
      usable: true,
      reasonCode: null,
    };
  } catch {
    return {
      estimatedUsd: "0",
      usable: false,
      reasonCode: "trusted_price_unavailable",
    };
  }
}

function minimumExecutableDestination(
  candidate: ResolvedDestinationCandidate,
  policy: FundingRuntimePolicy,
): Money | null {
  const valuation = candidate.collateralValuation;
  if (!valuation) return null;
  try {
    return {
      asset: candidate.option.requiredAsset,
      raw: rawForUsdCeil({
        usd: minimumAutomaticTradeRefillUsd(policy),
        decimals: candidate.option.requiredAsset.decimals,
        unitPriceUsd: valuation.unitPriceUsd,
      }),
    };
  } catch {
    return null;
  }
}

function spendabilityUsable(
  candidate: ResolvedDestinationCandidate,
  now: Date,
): boolean {
  const evidence = candidate.spendability;
  const asOf = Date.parse(evidence.asOf);
  const expiresAt = Date.parse(evidence.expiresAt);
  try {
    assertSameAsset(
      evidence.observedAmount.asset,
      candidate.option.requiredAsset,
      "observed destination spendability",
    );
    assertSameAsset(
      evidence.availableAmount.asset,
      candidate.option.requiredAsset,
      "available destination spendability",
    );
    assertSameAsset(
      candidate.availableNow.asset,
      candidate.option.requiredAsset,
      "planner destination spendability",
    );
    const observed = rawAmount(evidence.observedAmount.raw);
    const deductions =
      rawAmount(evidence.lockedRaw) +
      rawAmount(evidence.reservedRaw) +
      rawAmount(evidence.submittedDebitRaw);
    const expectedAvailable =
      observed > deductions ? observed - deductions : 0n;
    return (
      evidence.revision.trim().length >= 8 &&
      Number.isFinite(asOf) &&
      Number.isFinite(expiresAt) &&
      asOf <= now.getTime() &&
      expiresAt > now.getTime() &&
      expiresAt > asOf &&
      evidence.availableAmount.raw === expectedAvailable.toString() &&
      candidate.availableNow.raw === evidence.availableAmount.raw
    );
  } catch {
    return false;
  }
}

function validateMarketContext(
  request: FundingDiscoveryRequest,
  marketContext: MarketContextBinding | null,
  now: Date,
): void {
  if (!request.marketContextId) return;
  if (
    !marketContext ||
    marketContext.marketContextId !== request.marketContextId ||
    Date.parse(marketContext.expiresAt) <= now.getTime()
  ) {
    throw new FundingPlannerError(
      "invalid_market_context",
      "market context is absent, expired, or does not belong to this intent",
    );
  }
  if (
    request.requestedDestinationAmount &&
    !sameAsset(
      request.requestedDestinationAmount.asset,
      marketContext.collateralAsset,
    )
  ) {
    throw new FundingPlannerError(
      "invalid_market_context",
      "funding target asset differs from the frozen market context",
    );
  }
  const consumerSpend =
    request.purpose === "trade_shortfall"
      ? request.consumerIntent?.spend
      : request.requestedDestinationAmount;
  if (
    !consumerSpend ||
    !sameAsset(consumerSpend.asset, marketContext.collateralAsset) ||
    consumerSpend.raw !== marketContext.requestedCollateralRaw ||
    (request.requestedDestinationAmount &&
      BigInt(request.requestedDestinationAmount.raw) <
        BigInt(consumerSpend.raw))
  ) {
    throw new FundingPlannerError(
      "invalid_market_context",
      "exact consumer spend differs from the frozen market context",
    );
  }
}

function selectedCandidates(
  input: Readonly<{
    request: FundingDiscoveryRequest;
    marketContext: MarketContextBinding | null;
    candidates: readonly ResolvedDestinationCandidate[];
  }>,
): readonly ResolvedDestinationCandidate[] {
  const purpose = preparationPurpose(input.request.purpose);
  let candidates = input.candidates.filter(
    (candidate) =>
      candidate.bindingOption.preparationPurpose === purpose &&
      candidate.option.preparationPurpose === purpose,
  );
  if (input.marketContext) {
    candidates = candidates.filter(
      (candidate) =>
        candidate.option.venueId === input.marketContext?.venueId &&
        input.marketContext?.compatibleVenueBindingOptionIds.includes(
          candidate.bindingOption.venueBindingOptionId,
        ),
    );
  }
  if (input.request.destinationOptionId) {
    const resolved = resolveFundingDestinationChoice({
      options: candidates.map((candidate) => candidate.option),
      destinationOptionId: input.request.destinationOptionId,
      venueBindingOptionId: input.request.venueBindingOptionId,
    });
    const explicit = resolved
      ? (candidates.find(
          (candidate) =>
            candidate.option.destinationOptionId ===
            resolved.destinationOptionId,
        ) ?? null)
      : null;
    if (!explicit) return [];
    return candidates.map((candidate) =>
      candidate === explicit
        ? candidate
        : {
            ...candidate,
            option: { ...candidate.option, selectable: false },
          },
    );
  }

  const bindingSelection = selectVenueBindingForCurrentIntent({
    purpose,
    options: candidates.map((candidate) => candidate.bindingOption),
    explicitVenueBindingOptionId: input.request.venueBindingOptionId,
    positionOwnerVenueBindingOptionId: null,
  });
  if (
    bindingSelection.selected &&
    (input.marketContext || input.request.venueBindingOptionId)
  ) {
    candidates = candidates.filter(
      (candidate) =>
        candidate.bindingOption.venueBindingOptionId ===
        bindingSelection.selected?.venueBindingOptionId,
    );
  }
  return candidates;
}

export class FundingPlanner {
  private readonly now: () => Date;

  constructor(private readonly dependencies: FundingPlannerDependencies) {
    this.now = dependencies.now ?? (() => new Date());
  }

  async discover(
    input: Readonly<{
      accountId: string;
      request: FundingDiscoveryRequest;
      policy: FundingRuntimePolicy;
      policyRevision: string;
      ownershipRevision: string | Promise<string>;
    }>,
  ): Promise<IntentLiquidityProjection> {
    if (input.request.purpose === "withdrawal") {
      return this.discoverWithdrawal(input, this.now());
    }
    let marketContext = input.request.marketContextId
      ? await this.dependencies.resolveMarketContext({
          accountId: input.accountId,
          marketContextId: input.request.marketContextId,
        })
      : null;
    if (input.request.marketContextId && !marketContext) {
      throw new FundingPlannerError(
        "invalid_market_context",
        "market context is absent or does not belong to this intent",
      );
    }

    const allCandidates = await this.dependencies.listDestinations({
      accountId: input.accountId,
      request: input.request,
      marketContext,
    });
    if (
      marketContext &&
      marketContext.compatibleVenueBindingOptionIds.length === 0
    ) {
      const compatibleVenueBindingOptionIds = [
        ...new Set(
          allCandidates
            .filter(
              (candidate) =>
                candidate.option.selectable &&
                candidate.option.venueId === marketContext?.venueId &&
                sameAsset(
                  candidate.option.requiredAsset,
                  marketContext.collateralAsset,
                ),
            )
            .map((candidate) => candidate.bindingOption.venueBindingOptionId),
        ),
      ];
      marketContext =
        compatibleVenueBindingOptionIds.length > 0
          ? { ...marketContext, compatibleVenueBindingOptionIds }
          : null;
    }
    // Destination adapters freeze evidence after their async observations
    // complete. Evaluate that evidence against a clock captured afterwards;
    // otherwise a valid asOf timestamp can appear to be in the future relative
    // to a request-start clock and fail closed as stale.
    const now = this.now();
    validateMarketContext(input.request, marketContext, now);
    const candidates = selectedCandidates({
      request: input.request,
      marketContext,
      candidates: allCandidates,
    });
    const effectiveDestinationOptionId =
      input.request.destinationOptionId != null
        ? (candidates.find((candidate) => candidate.option.selectable)?.option
            .destinationOptionId ?? input.request.destinationOptionId)
        : null;
    const destinationSelection = selectFundingDestination({
      options: candidates.map((candidate) => candidate.option),
      explicitDestinationOptionId: effectiveDestinationOptionId,
    });
    const selected = destinationSelection.selected
      ? (candidates.find(
          (candidate) =>
            candidate.option.destinationOptionId ===
            destinationSelection.selected?.destinationOptionId,
        ) ?? null)
      : null;
    const amount = requestAmount(input.request, marketContext);
    const expiresAt = new Date(now.getTime() + input.policy.ttl.quoteMs);
    const publicDestinations = allCandidates.map(
      (candidate) => candidate.option,
    );
    const baseReasons = [...destinationSelection.reasonCodes];

    if (!selected || !amount) {
      const collateral = amount?.asset ??
        publicDestinations[0]?.requiredAsset ?? {
          networkId: "unknown",
          assetId: "unknown",
          decimals: 0,
        };
      const reasonCodes: FundingReasonCode[] = [
        ...baseReasons,
        ...(!amount ? (["invalid_amount"] as const) : []),
        ...(input.policy.creationMode === "off"
          ? (["creation_mode_off"] as const)
          : []),
      ];
      const projection: IntentLiquidityProjection = {
        liquidityProjectionId: `projection_${randomUUID()}`,
        marketContextId: marketContext?.marketContextId ?? null,
        venueId: null,
        venueBindingOptionId: null,
        destinationOptionId: null,
        collateralAsset: collateral,
        requestedCollateralRaw: amount?.raw ?? "0",
        availableNowRaw: "0",
        shortfallRaw: amount?.raw ?? "0",
        convertibleRaw: "0",
        requestedUsd: "0",
        availableNowUsd: "0",
        shortfallUsd: "0",
        convertibleUsd: "0",
        mode: "unavailable",
        eta: null,
        requiredActions: [],
        sourceOptions: [],
        asOf: now.toISOString(),
        expiresAt: expiresAt.toISOString(),
        policyVersion: input.policy.contractVersion,
        completeness: "partial",
        freshness: "stale",
        errors: [],
        reasonCodes,
        destinationOptions: publicDestinations,
      };
      return this.persist({
        accountId: input.accountId,
        request: input.request,
        marketContext,
        destination: null,
        withdrawalRecipient: null,
        placement: null,
        sources: [],
        projection,
        policyRevision: input.policyRevision,
        ownershipRevision: await input.ownershipRevision,
        expiresAt,
      });
    }

    const selectionReason = marketContext
      ? "current_trade"
      : destinationSelection.reason === "single_valid_option"
        ? "single_valid_option"
        : "explicit";
    const destinationFactsUsable =
      selected.completeness === "complete" &&
      selected.freshness === "fresh" &&
      spendabilityUsable(selected, now);
    const availableNow = destinationFactsUsable
      ? selected.availableNow
      : { asset: selected.availableNow.asset, raw: "0" };
    const placement = decidePlacement({
      intent: input.request,
      target: selected.target,
      targetVenueId: selected.option.venueId,
      targetRequirement: amount,
      availableNow,
      minimumExecutableDestination:
        input.request.purpose === "trade_shortfall"
          ? minimumExecutableDestination(selected, input.policy)
          : null,
      selectionReason,
      policy: input.policy,
    });
    const shortfallRaw =
      input.request.purpose === "add_funds" ||
      input.request.purpose === "convert_asset"
        ? amount.raw
        : subtractFloor(amount.raw, availableNow.raw);
    const fundingRequirement =
      input.request.purpose === "trade_shortfall"
        ? placement.destinationRequirement
        : { asset: amount.asset, raw: shortfallRaw };
    const requestedValuation = valueCollateral(selected, amount.raw, now);
    const availableValuation = valueCollateral(selected, availableNow.raw, now);
    const shortfallValuation = valueCollateral(selected, shortfallRaw, now);
    const valuationUsable =
      requestedValuation.usable &&
      availableValuation.usable &&
      shortfallValuation.usable;
    const planningFactsUsable = destinationFactsUsable && valuationUsable;
    const valuationReasons = [
      requestedValuation.reasonCode,
      availableValuation.reasonCode,
      shortfallValuation.reasonCode,
    ].filter(
      (reason, index, reasons): reason is FundingReasonCode =>
        reason != null && reasons.indexOf(reason) === index,
    );
    const needsFunding = rawAmount(shortfallRaw) > 0n;
    const sourcePlanningRequest: FundingSourcePlanningRequest = {
      accountId: input.accountId,
      request: input.request,
      marketContext,
      destinationFacts: selected,
      destination: toResolvedRouteDestination(selected),
      placement,
      requiredAmount: fundingRequirement,
      policy: input.policy,
      policyRevision: input.policyRevision,
      now,
    };
    const sourceDiscovery =
      needsFunding && input.policy.creationMode === "on" && planningFactsUsable
        ? await discoverFundingSources(this.dependencies, sourcePlanningRequest)
        : { sources: [], reasonCodes: [] };
    const sources = validatePlannedSources(
      sourceDiscovery.sources,
      fundingRequirement,
      now,
      input.request.purpose,
    );
    const recommended = recommendedSource(sources);
    const sourceOptions = sources.map((source) => ({
      ...source.option,
      recommended:
        recommended?.option.sourceOptionId === source.option.sourceOptionId,
    }));
    const applicableSourceBlockers = applicableSourceBlockingReasons(
      sources,
      sourceDiscovery.reasonCodes,
    );
    const sourceEvidenceReasonCodes = applicableSourceBlockers.filter(
      (reason): reason is "rpc_unavailable" | "provider_status_unknown" =>
        reason === "rpc_unavailable" || reason === "provider_status_unknown",
    );
    const sourceEvidenceUnavailable = sourceEvidenceReasonCodes.length > 0;
    const convertibleRaw = sources.some(isSelectableAutomaticSource)
      ? shortfallRaw
      : "0";
    const convertibleUsd =
      convertibleRaw === "0" ? "0" : shortfallValuation.estimatedUsd;
    const preparationNeedsWork = selected.option.preparationStatus !== "ready";
    const mode: IntentLiquidityProjection["mode"] =
      input.policy.creationMode === "off"
        ? "unavailable"
        : !planningFactsUsable
          ? "unavailable"
          : !needsFunding && !preparationNeedsWork
            ? "instant"
            : preparationNeedsWork ||
                recommended?.option.experienceMode === "prepare_first"
              ? "prepare_first"
              : recommended?.option.experienceMode === "inline_funding"
                ? "inline_funding"
                : "unavailable";
    const reasonCodes: FundingReasonCode[] = [
      ...(input.policy.creationMode === "off"
        ? (["creation_mode_off"] as const)
        : []),
      ...(preparationNeedsWork
        ? (["destination_setup_required"] as const)
        : []),
      ...(!destinationFactsUsable
        ? (["cash_availability_unknown"] as const)
        : []),
      ...valuationReasons,
      ...applicableSourceBlockers,
      ...(needsFunding &&
      !sourceEvidenceUnavailable &&
      !sourceOptions.some((source) => source.selectable)
        ? (["insufficient_liquidity"] as const)
        : []),
    ];
    const requiredActions = [
      ...selected.preparationActions,
      ...(recommended?.option.requiredActions ?? []),
    ];
    const projection: IntentLiquidityProjection = {
      liquidityProjectionId: `projection_${randomUUID()}`,
      marketContextId: marketContext?.marketContextId ?? null,
      venueId: selected.option.venueId,
      venueBindingOptionId: selected.option.venueBindingOptionId,
      destinationOptionId: selected.option.destinationOptionId,
      collateralAsset: amount.asset,
      requestedCollateralRaw: amount.raw,
      availableNowRaw: availableNow.raw,
      shortfallRaw,
      convertibleRaw,
      requestedUsd: requestedValuation.estimatedUsd,
      availableNowUsd: availableValuation.estimatedUsd,
      shortfallUsd: shortfallValuation.estimatedUsd,
      convertibleUsd,
      mode,
      eta: recommended?.option.eta ?? null,
      requiredActions,
      sourceOptions,
      asOf: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      policyVersion: input.policy.contractVersion,
      completeness:
        destinationFactsUsable && valuationUsable && !sourceEvidenceUnavailable
          ? "complete"
          : "partial",
      freshness:
        selected.freshness === "fresh" &&
        valuationUsable &&
        !sourceEvidenceUnavailable
          ? "fresh"
          : "stale",
      errors: [
        ...(!destinationFactsUsable
          ? [{ code: "cash_availability_unknown", retryable: true }]
          : []),
        ...valuationReasons.map((code) => ({ code, retryable: true })),
        ...sourceEvidenceReasonCodes.map((code) => ({
          code,
          retryable: true,
        })),
      ],
      reasonCodes,
      destinationOptions: publicDestinations,
    };
    return this.persist({
      accountId: input.accountId,
      request: input.request,
      marketContext,
      destination: selected,
      withdrawalRecipient: null,
      placement,
      sources,
      projection,
      policyRevision: input.policyRevision,
      ownershipRevision: await input.ownershipRevision,
      expiresAt,
    });
  }

  private async persist(
    input: Readonly<{
      accountId: string;
      request: FundingDiscoveryRequest;
      marketContext: MarketContextBinding | null;
      destination: ResolvedDestinationCandidate | null;
      withdrawalRecipient: ValidatedExternalRecipient | null;
      placement: FundingPlanningSnapshot["placement"];
      sources: readonly PlannedSourceOption[];
      projection: IntentLiquidityProjection;
      policyRevision: string;
      ownershipRevision: string;
      expiresAt: Date;
    }>,
  ): Promise<IntentLiquidityProjection> {
    const plannerSnapshot: FundingPlanningSnapshot = {
      request: input.request,
      marketContext: input.marketContext,
      destination: input.destination,
      withdrawalRecipient: input.withdrawalRecipient,
      placement: input.placement,
      sources: input.sources,
      projection: input.projection,
      policyRevision: input.policyRevision,
      ownershipRevision: input.ownershipRevision,
    };
    const stored = await this.dependencies.store.create({
      userId: input.accountId,
      request: input.request,
      projection: input.projection,
      plannerSnapshot,
      policyVersion: input.projection.policyVersion,
      policyRevision: input.policyRevision,
      ownershipRevision: input.ownershipRevision,
      expiresAt: input.expiresAt,
    });
    return {
      ...input.projection,
      liquidityProjectionId: stored.id,
    };
  }

  private async discoverWithdrawal(
    input: Readonly<{
      accountId: string;
      request: FundingDiscoveryRequest;
      policy: FundingRuntimePolicy;
      policyRevision: string;
      ownershipRevision: string | Promise<string>;
    }>,
    now: Date,
  ): Promise<IntentLiquidityProjection> {
    const amount = input.request.requestedDestinationAmount;
    const recipientId = input.request.withdrawalRecipientId;
    if (
      !amount ||
      rawAmount(amount.raw) === 0n ||
      !recipientId ||
      !this.dependencies.resolveWithdrawalRecipient
    ) {
      throw new FundingPlannerError(
        "invalid_amount",
        "withdrawal requires an exact amount and validated recipient",
      );
    }
    const recipient = await this.dependencies.resolveWithdrawalRecipient({
      accountId: input.accountId,
      recipientId,
    });
    if (
      !recipient ||
      recipient.accountId !== input.accountId ||
      recipient.recipientId !== recipientId ||
      Date.parse(recipient.expiresAt) <= now.getTime()
    ) {
      throw new FundingPlannerError(
        "destination_unavailable",
        "withdrawal recipient is absent, expired, or not owned",
      );
    }
    assertSameAsset(
      recipient.asset,
      amount.asset,
      "withdrawal recipient and amount",
    );
    const recipientLocationPatternId = withdrawalRecipientLocationPatternId(
      amount.asset,
    );
    if (!recipientLocationPatternId) {
      throw new FundingPlannerError(
        "destination_unavailable",
        "withdrawal asset is outside the code-owned destination contract",
      );
    }
    const withdrawalPolicy = withWithdrawalPlanningContract(
      input.policy,
      amount.asset,
    );
    const recipientSnapshot = validatedRecipient(recipient);
    const target = {
      kind: "external_recipient" as const,
      recipient: recipientSnapshot,
    };
    const placement = decidePlacement({
      intent: input.request,
      target,
      targetVenueId: null,
      targetRequirement: amount,
      availableNow: { asset: amount.asset, raw: "0" },
      selectionReason: "explicit",
      policy: withdrawalPolicy,
    });
    const routeDestination: ResolvedRouteDestination = {
      destinationId: recipient.recipientId,
      destinationLocationPatternId: recipientLocationPatternId,
      target,
      requiredAsset: amount.asset,
      spendability: null,
      venueId: null,
      venueBindingOption: null,
      externalRecipientId: recipient.recipientId,
      recipientAddress: recipient.address,
    };
    const sources = validatePlannedSources(
      await this.dependencies.listSources({
        accountId: input.accountId,
        request: input.request,
        marketContext: null,
        destinationFacts: null,
        destination: routeDestination,
        placement,
        requiredAmount: amount,
        policy: withdrawalPolicy,
        policyRevision: input.policyRevision,
        now,
      }),
      amount,
      now,
      input.request.purpose,
    );
    const recommended = recommendedSource(sources);
    const sourceOptions = sources.map((source) => ({
      ...source.option,
      recommended:
        source.option.sourceOptionId === recommended?.option.sourceOptionId,
    }));
    const expiresAt = new Date(
      Math.min(
        now.getTime() + withdrawalPolicy.ttl.quoteMs,
        Date.parse(recipient.expiresAt),
      ),
    );
    if (expiresAt.getTime() <= now.getTime()) {
      throw new FundingPlannerError(
        "destination_unavailable",
        "withdrawal recipient expired while planning",
      );
    }
    const mode: IntentLiquidityProjection["mode"] =
      recommended?.option.experienceMode === "inline_funding"
        ? "inline_funding"
        : recommended?.option.experienceMode === "prepare_first"
          ? "prepare_first"
          : "unavailable";
    const projection: IntentLiquidityProjection = {
      liquidityProjectionId: `projection_${randomUUID()}`,
      marketContextId: null,
      venueId: null,
      venueBindingOptionId: null,
      destinationOptionId: null,
      collateralAsset: amount.asset,
      requestedCollateralRaw: amount.raw,
      availableNowRaw: "0",
      shortfallRaw: amount.raw,
      convertibleRaw: "0",
      requestedUsd: "0",
      availableNowUsd: "0",
      shortfallUsd: "0",
      convertibleUsd: "0",
      mode,
      eta: recommended?.option.eta ?? null,
      requiredActions: recommended?.option.requiredActions ?? [],
      sourceOptions,
      asOf: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      policyVersion: input.policy.contractVersion,
      completeness: "partial",
      freshness: "fresh",
      errors: [{ code: "trusted_price_unavailable", retryable: true }],
      reasonCodes: [
        "trusted_price_unavailable",
        ...(sourceOptions.some((source) => source.selectable)
          ? []
          : (["insufficient_liquidity"] as const)),
      ],
      destinationOptions: [],
    };
    return this.persist({
      accountId: input.accountId,
      request: input.request,
      marketContext: null,
      destination: null,
      withdrawalRecipient: recipientSnapshot,
      placement,
      sources,
      projection,
      policyRevision: input.policyRevision,
      ownershipRevision: await input.ownershipRevision,
      expiresAt,
    });
  }
}
