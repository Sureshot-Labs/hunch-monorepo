import { randomUUID } from "node:crypto";

import { multiplyRawByUnitPrice } from "../../account-value/decimal.js";
import type {
  FundingDiscoveryRequest,
  FundingReasonCode,
  IntentLiquidityProjection,
  MarketContextBinding,
  Money,
  PlacementDecision,
} from "../domain/types.js";
import {
  selectFundingDestination,
  selectVenueBindingForCurrentIntent,
} from "../domain/selections.js";
import type { FundingRuntimePolicy } from "../policies/funding-policy.js";
import type { ResolvedDestinationCandidate } from "./destination-adapters.js";
import {
  FundingPlannerError,
  assertSameAsset,
  rawAmount,
  subtractFloor,
} from "./money.js";
import { decidePlacement } from "./placement-policy.js";
import type {
  FundingPlanningSnapshot,
  FundingPlanningStore,
  PlannedSourceOption,
} from "./planning-types.js";

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
  listSources(
    input: Readonly<{
      accountId: string;
      request: FundingDiscoveryRequest;
      marketContext: MarketContextBinding | null;
      destination: ResolvedDestinationCandidate;
      placement: PlacementDecision;
      requiredAmount: Money;
      policy: FundingRuntimePolicy;
      policyRevision: string;
      now: Date;
    }>,
  ): Promise<readonly PlannedSourceOption[]>;
  store: FundingPlanningStore;
  now?: () => Date;
}>;

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
        Number(right.option.recommended) - Number(left.option.recommended) ||
        Number(left.option.source.kind === "external_ingress") -
          Number(right.option.source.kind === "external_ingress") ||
        left.option.sourceOptionId.localeCompare(right.option.sourceOptionId),
    )[0] ?? null
  );
}

function validatePlannedSources(
  sources: readonly PlannedSourceOption[],
  requiredAmount: Money,
  now: Date,
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
    const segmentCount = source.commitPlan.segments.length;
    const planKind = source.commitPlan.operation.planKind;
    if (
      segmentCount > 1 ||
      ((planKind === "wallet_route" || planKind === "relay_deposit_address") &&
        (segmentCount !== 1 ||
          source.commitPlan.segments[0]?.providerId !== "relay")) ||
      ((planKind === "already_available" ||
        planKind === "direct_external_handoff") &&
        segmentCount !== 0)
    ) {
      throw new FundingPlannerError(
        "invalid_policy",
        "funding source contains a staged, second, or non-Relay segment",
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
        rawAmount(minimum.raw) < rawAmount(requiredAmount.raw)
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
    (request.requestedDestinationAmount.asset.networkId !==
      marketContext.collateralAsset.networkId ||
      request.requestedDestinationAmount.asset.assetId.toLowerCase() !==
        marketContext.collateralAsset.assetId.toLowerCase() ||
      request.requestedDestinationAmount.asset.decimals !==
        marketContext.collateralAsset.decimals ||
      request.requestedDestinationAmount.raw !==
        marketContext.requestedCollateralRaw)
  ) {
    throw new FundingPlannerError(
      "invalid_market_context",
      "requested collateral differs from the frozen market context",
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
    const explicit = candidates.find(
      (candidate) =>
        candidate.option.destinationOptionId ===
        input.request.destinationOptionId,
    );
    if (!explicit) return candidates;
    if (
      input.request.venueBindingOptionId &&
      input.request.venueBindingOptionId !==
        explicit.bindingOption.venueBindingOptionId
    ) {
      return [];
    }
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
      ownershipRevision: string;
    }>,
  ): Promise<IntentLiquidityProjection> {
    const now = this.now();
    const marketContext = input.request.marketContextId
      ? await this.dependencies.resolveMarketContext({
          accountId: input.accountId,
          marketContextId: input.request.marketContextId,
        })
      : null;
    validateMarketContext(input.request, marketContext, now);

    const allCandidates = await this.dependencies.listDestinations({
      accountId: input.accountId,
      request: input.request,
      marketContext,
    });
    const candidates = selectedCandidates({
      request: input.request,
      marketContext,
      candidates: allCandidates,
    });
    const destinationSelection = selectFundingDestination({
      options: candidates.map((candidate) => candidate.option),
      explicitDestinationOptionId: input.request.destinationOptionId,
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
        policyVersion: input.policy.version,
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
        placement: null,
        sources: [],
        projection,
        policyRevision: input.policyRevision,
        ownershipRevision: input.ownershipRevision,
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
      selectionReason,
      policy: input.policy,
    });
    const shortfallRaw =
      input.request.purpose === "trade_shortfall"
        ? placement.destinationRequirement.raw
        : input.request.purpose === "add_funds" ||
            input.request.purpose === "convert_asset"
          ? amount.raw
          : subtractFloor(amount.raw, availableNow.raw);
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
    const discoveredSources =
      needsFunding && input.policy.creationMode === "on" && planningFactsUsable
        ? await this.dependencies.listSources({
            accountId: input.accountId,
            request: input.request,
            marketContext,
            destination: selected,
            placement,
            requiredAmount: {
              asset: amount.asset,
              raw: shortfallRaw,
            },
            policy: input.policy,
            policyRevision: input.policyRevision,
            now,
          })
        : [];
    const sources = validatePlannedSources(
      discoveredSources,
      {
        asset: amount.asset,
        raw: shortfallRaw,
      },
      now,
    );
    const recommended = recommendedSource(sources);
    const sourceOptions = sources.map((source) => ({
      ...source.option,
      recommended:
        recommended?.option.sourceOptionId === source.option.sourceOptionId,
    }));
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
      ...(needsFunding && !sourceOptions.some((source) => source.selectable)
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
      convertibleRaw: "0",
      requestedUsd: requestedValuation.estimatedUsd,
      availableNowUsd: availableValuation.estimatedUsd,
      shortfallUsd: shortfallValuation.estimatedUsd,
      convertibleUsd: "0",
      mode,
      eta: recommended?.option.eta ?? null,
      requiredActions,
      sourceOptions,
      asOf: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      policyVersion: input.policy.version,
      completeness:
        destinationFactsUsable && valuationUsable ? "complete" : "partial",
      freshness:
        selected.freshness === "fresh" && valuationUsable ? "fresh" : "stale",
      errors: [
        ...(!destinationFactsUsable
          ? [{ code: "cash_availability_unknown", retryable: true }]
          : []),
        ...valuationReasons.map((code) => ({ code, retryable: true })),
      ],
      reasonCodes,
      destinationOptions: publicDestinations,
    };
    return this.persist({
      accountId: input.accountId,
      request: input.request,
      marketContext,
      destination: selected,
      placement,
      sources,
      projection,
      policyRevision: input.policyRevision,
      ownershipRevision: input.ownershipRevision,
      expiresAt,
    });
  }

  private async persist(
    input: Readonly<{
      accountId: string;
      request: FundingDiscoveryRequest;
      marketContext: MarketContextBinding | null;
      destination: ResolvedDestinationCandidate | null;
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
}
