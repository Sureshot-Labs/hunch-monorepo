import type {
  FundingDiscoveryRequest,
  FundingExecutionPlan,
  FundingReasonCode,
  FundingSourceRef,
  JsonValue,
  MarketContextBinding,
  Money,
  PlacementDecision,
  SourceOption,
} from "../domain/types.js";
import type { ProviderQuoteCandidate } from "../domain/contracts.js";
import type { FundingRuntimePolicy } from "../policies/funding-policy.js";
import type { PlannedSourceOption } from "./planning-types.js";
import type { ResolvedRouteDestination } from "./destination-adapters.js";
import { stableOpaqueId } from "../../account-value/canonical.js";
import {
  addUnsignedDecimals,
  compareUnsignedDecimals,
  multiplyUnsignedDecimals,
} from "../../account-value/decimal.js";
import { canonicalJsonEqual } from "../persistence/canonical.js";
import {
  FundingPlannerError,
  assertSameAsset,
  rawAmount,
  sameAsset,
} from "./money.js";
import {
  classifyRouteExperience,
  routeAmountBand,
  type RouteExperienceObservation,
} from "./route-experience.js";
import { buildCompositeRelaySourceOption } from "./composite-source-options.js";

export const RELAY_QUOTE_TIMEOUT_MS = 1_500;
export const TOTAL_FUNDING_PLANNER_TIMEOUT_MS = 3_500;
export const MAX_RELAY_SOURCE_QUOTES = 16;

export type RelayFirstCandidate = Readonly<{
  routeId: string;
  providerId: string;
  routeEnabled: boolean;
  sourceOption: SourceOption;
  executionPlan: FundingExecutionPlan;
  commitPlan: PlannedSourceOption["commitPlan"];
}>;

export type RelayFirstSelection = Readonly<{
  sources: readonly PlannedSourceOption[];
  reasonCodes: readonly FundingReasonCode[];
}>;

export type RelayEligibleSourceFact = Readonly<{
  componentId: string;
  sourceLocationPatternId: string;
  safeLabel: string;
  source: FundingSourceRef;
  quoteInputAmount: Money;
  quoteMinimumOutput?: Money;
  maximumSourceRaw: string;
  estimatedUsd: string | null;
  transferable: boolean;
  riskEligible: boolean;
  walletExecutionReady: boolean;
  nativeGasReady: boolean;
  suggestionPreferred?: boolean;
  freshness: "fresh" | "stale";
}>;

export type RelayPlanningQuote = Readonly<{
  candidate: ProviderQuoteCandidate;
  feeUsd: readonly (string | null)[];
  minimumDestinationEstimatedUsd: string | null;
  executionPlan: FundingExecutionPlan;
  commitPlan: PlannedSourceOption["commitPlan"];
}>;

export type RelayFirstSourcePlannerDependencies = Readonly<{
  listEligibleSources(
    input: Readonly<{
      accountId: string;
      request: FundingDiscoveryRequest;
      destination: ResolvedRouteDestination;
      requiredAmount: Money;
      policyRevision: string;
      now: Date;
    }>,
  ): Promise<readonly RelayEligibleSourceFact[]>;
  quoteRelay(
    input: Readonly<{
      route: FundingRuntimePolicy["routes"][number];
      source: RelayEligibleSourceFact;
      destination: ResolvedRouteDestination;
      sourceAmount: Money;
      minimumOutput: Money;
      quoteCorrelationId: string;
      deadline: Date;
      policyRevision: string;
      signal: AbortSignal;
      timeoutMs: number;
    }>,
  ): Promise<RelayPlanningQuote | null>;
  observeRoute(
    input: Readonly<{
      route: FundingRuntimePolicy["routes"][number];
      amountBand: string;
      now: Date;
    }>,
  ): Promise<RouteExperienceObservation | null>;
}>;

export type RelayFirstSourcePlannerTiming = Readonly<{
  relayQuoteTimeoutMs?: number;
  totalPlannerTimeoutMs?: number;
  monotonicNow?: () => number;
}>;

export function buildRelayWalletSourceOption(
  input: Readonly<{
    sourceOptionId: string;
    safeLabel: string;
    maximumSourceRaw: string;
    estimatedUsd: string | null;
    quote: ProviderQuoteCandidate;
    feeUsd: readonly (string | null)[];
    route: FundingRuntimePolicy["routes"][number];
    routeObservation: RouteExperienceObservation | null;
    routeExperiencePolicy: FundingRuntimePolicy["routeExperience"];
    maximumFeeUsd: string;
    maximumFeeBps: number;
    warningFeeUsd: string;
    warningFeeBps: number;
    minimumDestinationUsd: string;
    maximumSlippageBps: number;
    minimumDestinationEstimatedUsd: string | null;
    recommended?: boolean;
  }>,
): SourceOption {
  if (input.quote.providerId !== "relay") {
    throw new Error("Relay-first source builder received another provider");
  }
  if (
    input.feeUsd.length !== input.quote.fees.length ||
    rawAmount(input.maximumSourceRaw) === 0n
  ) {
    throw new Error("Relay source economics are incomplete");
  }
  if (
    input.route.providerId !== "relay" ||
    input.quote.adapterVersion !== input.route.adapterVersion ||
    input.quote.capability !== input.route.capability
  ) {
    throw new Error("Relay quote differs from the exact route policy");
  }
  if (
    input.quote.source.kind === "composite" ||
    input.quote.source.kind === "venue_preparation"
  ) {
    throw new Error("Relay quote cannot contain a nested composite source");
  }
  const sourceAsset =
    input.quote.source.kind === "owned_location"
      ? input.quote.source.location.asset
      : input.quote.source.asset;
  if (
    !sourceAsset ||
    !sameAsset(sourceAsset, input.route.sourceAsset) ||
    !sameAsset(
      input.quote.expectedOutput.asset,
      input.route.destinationAsset,
    ) ||
    !sameAsset(input.quote.minimumOutput.asset, input.route.destinationAsset)
  ) {
    throw new Error("Relay quote assets differ from the exact route policy");
  }
  const experience = classifyRouteExperience({
    route: input.route,
    global: input.routeExperiencePolicy,
    observation: input.routeObservation,
  });
  const feeUnknown = input.feeUsd.some((fee) => fee == null);
  const feeTotalUsd = addUnsignedDecimals(
    input.feeUsd.filter((fee): fee is string => fee != null),
  );
  const expectedRaw = rawAmount(input.quote.expectedOutput.raw);
  const minimumRaw = rawAmount(input.quote.minimumOutput.raw);
  if (expectedRaw === 0n || minimumRaw > expectedRaw) {
    throw new Error("Relay quote output economics are invalid");
  }
  const slippageBps = Number(
    ((expectedRaw - minimumRaw) * 10_000n + expectedRaw - 1n) / expectedRaw,
  );
  const destinationPriceUnknown = input.minimumDestinationEstimatedUsd == null;
  const feeBpsExceeded =
    input.minimumDestinationEstimatedUsd != null &&
    exceedsDecimalBps(
      feeTotalUsd,
      input.minimumDestinationEstimatedUsd,
      input.maximumFeeBps,
    );
  const feeWarning =
    !feeUnknown &&
    input.minimumDestinationEstimatedUsd != null &&
    (compareUnsignedDecimals(feeTotalUsd, input.warningFeeUsd) > 0 ||
      exceedsDecimalBps(
        feeTotalUsd,
        input.minimumDestinationEstimatedUsd,
        input.warningFeeBps,
      ));
  const destinationBelowMinimum =
    input.minimumDestinationEstimatedUsd != null &&
    compareUnsignedDecimals(
      input.minimumDestinationEstimatedUsd,
      input.minimumDestinationUsd,
    ) < 0;
  const feeLimitExceeded =
    compareUnsignedDecimals(feeTotalUsd, input.maximumFeeUsd) > 0 ||
    feeBpsExceeded;
  const reasonCodes: FundingReasonCode[] = [
    ...new Set<FundingReasonCode>([
      ...experience.reasonCodes,
      ...(feeUnknown || destinationPriceUnknown
        ? (["trusted_price_unavailable"] as const)
        : []),
      ...(feeLimitExceeded ? (["fee_limit_exceeded"] as const) : []),
      ...(feeWarning && !feeLimitExceeded
        ? (["funding_cost_warning"] as const)
        : []),
      ...(destinationBelowMinimum ? (["minimum_output_not_met"] as const) : []),
      ...(slippageBps > input.maximumSlippageBps
        ? (["minimum_output_not_met"] as const)
        : []),
    ]),
  ];
  const economicsAllowed =
    !feeUnknown &&
    !destinationPriceUnknown &&
    !feeLimitExceeded &&
    !destinationBelowMinimum &&
    slippageBps <= input.maximumSlippageBps;
  return {
    sourceOptionId: input.sourceOptionId,
    kind: "wallet_asset",
    safeLabel: input.safeLabel,
    source: input.quote.source,
    amountMode: input.quote.amountMode,
    maximumSourceRaw: input.maximumSourceRaw,
    expectedDestination: input.quote.expectedOutput,
    minimumDestination: input.quote.minimumOutput,
    estimatedUsd: input.estimatedUsd,
    fees: input.quote.fees.map((fee, index) => ({
      kind: fee.kind,
      amount: fee.amount,
      estimatedUsd: input.feeUsd[index] ?? null,
    })),
    eta: input.quote.eta,
    experienceMode: economicsAllowed ? experience.mode : "unavailable",
    requiredActions: input.quote.actionKinds.map((kind) => ({
      kind,
      safeLabel:
        kind === "signature"
          ? "Confirm wallet signature"
          : "Confirm wallet transaction",
      actor: "user",
      valueMoving: kind !== "signature",
      sponsorship: "none",
    })),
    expiresAt: input.quote.expiresAt,
    recommended: input.recommended === true,
    selectable: economicsAllowed && experience.mode !== "unavailable",
    reasonCodes,
  };
}

function exceedsDecimalBps(
  numerator: string,
  denominator: string,
  basisPoints: number,
): boolean {
  return (
    compareUnsignedDecimals(
      multiplyUnsignedDecimals(numerator, "10000"),
      multiplyUnsignedDecimals(denominator, basisPoints.toString()),
    ) > 0
  );
}

export function effectiveFundingEconomicsLimits(
  policy: FundingRuntimePolicy,
  user: Readonly<{
    maximumFeeUsd: string | null;
    maximumSlippageBps: number | null;
  }>,
): Readonly<{
  maximumFeeUsd: string;
  maximumFeeBps: number;
  warningFeeUsd: string;
  warningFeeBps: number;
  minimumDestinationUsd: string;
  maximumSlippageBps: number;
}> {
  return {
    maximumFeeUsd:
      user.maximumFeeUsd != null &&
      compareUnsignedDecimals(
        user.maximumFeeUsd,
        policy.placement.maximumFeeUsd,
      ) < 0
        ? user.maximumFeeUsd
        : policy.placement.maximumFeeUsd,
    maximumSlippageBps: Math.min(
      user.maximumSlippageBps ?? policy.placement.maximumSlippageBps,
      policy.placement.maximumSlippageBps,
    ),
    maximumFeeBps: policy.placement.maximumFeeBps,
    warningFeeUsd: policy.placement.warningFeeUsd,
    warningFeeBps: policy.placement.warningFeeBps,
    minimumDestinationUsd: policy.placement.minimumDestinationUsd,
  };
}

function jsonRecord(value: unknown): Readonly<Record<string, JsonValue>> {
  return value as Readonly<Record<string, JsonValue>>;
}

function exactJson(left: unknown, right: unknown): boolean {
  return canonicalJsonEqual(left as JsonValue, right as JsonValue);
}

function quoteDeadline(
  request: FundingDiscoveryRequest,
  policy: FundingRuntimePolicy,
  now: Date,
): Date {
  const policyDeadline = new Date(now.getTime() + policy.ttl.quoteMs);
  if (!request.deadline) return policyDeadline;
  const requestedDeadline = new Date(request.deadline);
  if (
    !Number.isFinite(requestedDeadline.getTime()) ||
    requestedDeadline.getTime() <= now.getTime()
  ) {
    throw new FundingPlannerError(
      "invalid_amount",
      "funding quote deadline is invalid or expired",
    );
  }
  return requestedDeadline < policyDeadline
    ? requestedDeadline
    : policyDeadline;
}

function assertRelayPlanningQuote(
  input: Readonly<{
    quote: RelayPlanningQuote;
    route: FundingRuntimePolicy["routes"][number];
    source: RelayEligibleSourceFact;
    destination: ResolvedRouteDestination;
    deadline: Date;
    now: Date;
  }>,
): void {
  const candidate = input.quote.candidate;
  const publicSegment = input.quote.executionPlan.segments[0];
  const committedSegment = input.quote.commitPlan.segments[0];
  const expiresAt = Date.parse(candidate.expiresAt);
  if (
    candidate.providerId !== "relay" ||
    candidate.amountMode !== "exact_input" ||
    candidate.capability !== input.route.capability ||
    candidate.adapterVersion !== input.route.adapterVersion ||
    !exactJson(candidate.source, input.source.source) ||
    !exactJson(candidate.destination, input.destination.target) ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= input.now.getTime() ||
    expiresAt > input.deadline.getTime()
  ) {
    throw new FundingPlannerError(
      "invalid_policy",
      "Relay quote differs from the frozen route, source, destination, or deadline",
    );
  }
  assertSingleSegmentExecutionPlan(input.quote.executionPlan);
  if (
    input.quote.executionPlan.kind !== "wallet_route" ||
    input.quote.commitPlan.operation.planKind !== "wallet_route" ||
    input.quote.commitPlan.segments.length !== 1 ||
    !publicSegment ||
    !committedSegment ||
    publicSegment.providerId !== "relay" ||
    publicSegment.adapterId !== input.route.adapterId ||
    publicSegment.adapterVersion !== input.route.adapterVersion ||
    publicSegment.amountMode !== candidate.amountMode ||
    !exactJson(publicSegment.source, input.source.source) ||
    !exactJson(publicSegment.destination, input.destination.target) ||
    committedSegment.providerId !== "relay" ||
    committedSegment.adapterId !== input.route.adapterId ||
    committedSegment.adapterVersion !== input.route.adapterVersion ||
    committedSegment.segmentKind !== input.route.capability ||
    committedSegment.providerQuoteRefCiphertext == null ||
    committedSegment.providerQuoteRefLookupHmac == null ||
    committedSegment.lookupKeyVersion <= 0
  ) {
    throw new FundingPlannerError(
      "invalid_policy",
      "Relay planning result lacks one exact encrypted wallet-route segment",
    );
  }
}

/**
 * WP5 orchestration boundary for step 10 of Intent Liquidity. It receives
 * already-inspected owned source facts, calls only the injected Relay quote
 * boundary, and freezes the resulting public and committed one-segment plans.
 * Production source and preparation inspection remain WP6 wiring.
 */
export class RelayFirstSourcePlanner {
  private readonly relayQuoteTimeoutMs: number;
  private readonly totalPlannerTimeoutMs: number;
  private readonly monotonicNow: () => number;

  constructor(
    private readonly dependencies: RelayFirstSourcePlannerDependencies,
    timing: RelayFirstSourcePlannerTiming = {},
  ) {
    this.relayQuoteTimeoutMs = boundedTestTimeout(
      timing.relayQuoteTimeoutMs,
      RELAY_QUOTE_TIMEOUT_MS,
    );
    this.totalPlannerTimeoutMs = boundedTestTimeout(
      timing.totalPlannerTimeoutMs,
      TOTAL_FUNDING_PLANNER_TIMEOUT_MS,
    );
    this.monotonicNow = timing.monotonicNow ?? (() => performance.now());
  }

  async list(
    input: Readonly<{
      accountId: string;
      request: FundingDiscoveryRequest;
      marketContext: MarketContextBinding | null;
      destination: ResolvedRouteDestination;
      placement: PlacementDecision;
      requiredAmount: Money;
      policy: FundingRuntimePolicy;
      policyRevision: string;
      now: Date;
    }>,
  ): Promise<readonly PlannedSourceOption[]> {
    const planningStartedAt = this.monotonicNow();
    const relayProvider = input.policy.providers.find(
      (provider) => provider.providerId === "relay",
    );
    if (!relayProvider) return [];
    const deadline = quoteDeadline(input.request, input.policy, input.now);
    const limits = effectiveFundingEconomicsLimits(input.policy, {
      maximumFeeUsd: input.request.maxFeeUsd,
      maximumSlippageBps: input.request.maxSlippageBps,
    });
    const enabledRoutes = input.policy.routes
      .filter(
        (route) =>
          route.enabled &&
          route.providerId === "relay" &&
          route.capability !== "deposit_address" &&
          relayProvider.enabledCapabilities.includes(route.capability) &&
          route.destinationLocationPatternId ===
            input.destination.destinationLocationPatternId &&
          sameAsset(route.destinationAsset, input.requiredAmount.asset),
      )
      .sort((left, right) => left.routeId.localeCompare(right.routeId));
    if (enabledRoutes.length === 0) return [];
    const sourceFacts = [
      ...(await this.dependencies.listEligibleSources({
        accountId: input.accountId,
        request: input.request,
        destination: input.destination,
        requiredAmount: input.requiredAmount,
        policyRevision: input.policyRevision,
        now: input.now,
      })),
    ].sort(
      (left, right) =>
        left.componentId.localeCompare(right.componentId) ||
        left.sourceLocationPatternId.localeCompare(
          right.sourceLocationPatternId,
        ),
    );
    const plannedCandidates = await Promise.all(
      sourceFacts
        .slice(0, MAX_RELAY_SOURCE_QUOTES)
        .map(async (source): Promise<RelayFirstCandidate | null> => {
          if (
            source.source.kind !== "owned_location" ||
            source.source.location.accountId !== input.accountId ||
            !source.transferable ||
            !source.riskEligible ||
            !source.walletExecutionReady ||
            !source.nativeGasReady ||
            source.freshness !== "fresh" ||
            !sameAsset(
              source.source.location.asset,
              source.quoteInputAmount.asset,
            ) ||
            rawAmount(source.quoteInputAmount.raw) === 0n ||
            rawAmount(source.maximumSourceRaw) <
              rawAmount(source.quoteInputAmount.raw)
          ) {
            return null;
          }
          const routes = enabledRoutes.filter(
            (route) =>
              route.sourceLocationPatternId ===
                source.sourceLocationPatternId &&
              sameAsset(route.sourceAsset, source.quoteInputAmount.asset),
          );
          if (routes.length > 1) {
            throw new FundingPlannerError(
              "invalid_policy",
              "multiple enabled Relay routes match one exact source and destination",
            );
          }
          const route = routes[0];
          if (!route) return null;
          const quoteCorrelationId = stableOpaqueId(
            "funding_quote",
            [
              input.accountId,
              input.policyRevision,
              input.destination.destinationId,
              source.componentId,
              route.routeId,
              source.quoteInputAmount.raw,
              input.requiredAmount.raw,
              input.now.toISOString(),
            ].join("|"),
          );
          const remainingPlannerMs =
            this.totalPlannerTimeoutMs -
            (this.monotonicNow() - planningStartedAt);
          if (remainingPlannerMs <= 0) return null;
          const plannedQuote = await this.quoteRelayWithinBudget(
            {
              route,
              source,
              destination: input.destination,
              sourceAmount: source.quoteInputAmount,
              minimumOutput: source.quoteMinimumOutput ?? input.requiredAmount,
              quoteCorrelationId,
              deadline,
              policyRevision: input.policyRevision,
            },
            Math.min(this.relayQuoteTimeoutMs, remainingPlannerMs),
          );
          if (!plannedQuote) return null;
          assertRelayPlanningQuote({
            quote: plannedQuote,
            route,
            source,
            destination: input.destination,
            deadline,
            now: input.now,
          });
          const observation = await this.dependencies.observeRoute({
            route,
            amountBand: routeAmountBand(source.estimatedUsd),
            now: input.now,
          });
          let option = buildRelayWalletSourceOption({
            sourceOptionId: stableOpaqueId(
              "source",
              [
                quoteCorrelationId,
                plannedQuote.candidate.opaqueQuoteRef,
                plannedQuote.candidate.expiresAt,
              ].join("|"),
            ),
            safeLabel: source.safeLabel,
            maximumSourceRaw: source.maximumSourceRaw,
            estimatedUsd: source.estimatedUsd,
            quote: plannedQuote.candidate,
            feeUsd: plannedQuote.feeUsd,
            route,
            routeObservation: observation,
            routeExperiencePolicy: input.policy.routeExperience,
            maximumFeeUsd: limits.maximumFeeUsd,
            maximumFeeBps: limits.maximumFeeBps,
            warningFeeUsd: limits.warningFeeUsd,
            warningFeeBps: limits.warningFeeBps,
            minimumDestinationUsd: limits.minimumDestinationUsd,
            maximumSlippageBps: limits.maximumSlippageBps,
            minimumDestinationEstimatedUsd:
              plannedQuote.minimumDestinationEstimatedUsd,
            recommended: source.suggestionPreferred,
          });
          if (
            plannedQuote.commitPlan.steps.some(
              (step) => step.payerRequirement === "privy_sponsor",
            )
          ) {
            option = {
              ...option,
              requiredActions: option.requiredActions.map((action) => ({
                ...action,
                sponsorship:
                  action.kind === "evm_transaction" ? "requested" : "none",
              })),
            };
          }
          const experienceMode =
            option.experienceMode === "inline_funding"
              ? "inline"
              : option.experienceMode === "prepare_first"
                ? "prepare_first"
                : plannedQuote.commitPlan.operation.experienceMode;
          const commitPlan = {
            ...plannedQuote.commitPlan,
            operation: {
              ...plannedQuote.commitPlan.operation,
              purpose: input.request.purpose,
              experienceMode,
              sourceSnapshot: jsonRecord(option),
              destinationTargetSnapshot: jsonRecord(input.destination.target),
              externalRecipientId: input.destination.externalRecipientId,
              venueId: input.destination.venueId,
              marketId: input.marketContext?.marketId ?? null,
              marketContextSnapshot: input.marketContext
                ? jsonRecord(input.marketContext)
                : null,
              venueBindingSnapshot: input.destination.venueBindingOption
                ? jsonRecord(input.destination.venueBindingOption)
                : null,
              placementSnapshot: jsonRecord(input.placement),
              requestedSourceAmount: jsonRecord(source.quoteInputAmount),
              requestedDestinationAmount: jsonRecord(input.requiredAmount),
            },
            segments: plannedQuote.commitPlan.segments.map((segment) => ({
              ...segment,
              sourceSnapshot: jsonRecord(source.source),
              destinationTargetSnapshot: jsonRecord(input.destination.target),
              quotedInput: jsonRecord(source.quoteInputAmount),
              quotedExpectedOutput: jsonRecord(
                plannedQuote.candidate.expectedOutput,
              ),
              quotedMinOutput: jsonRecord(plannedQuote.candidate.minimumOutput),
              quoteExpiresAt: plannedQuote.candidate.expiresAt,
            })),
          };
          return {
            routeId: route.routeId,
            providerId: "relay",
            routeEnabled: true,
            sourceOption: option,
            executionPlan: plannedQuote.executionPlan,
            commitPlan,
          };
        }),
    );
    const candidates = plannedCandidates.filter(
      (candidate): candidate is RelayFirstCandidate => candidate !== null,
    );
    const selected = selectRelayFirstSourceOptions({
      candidates,
      requiredDestination: input.requiredAmount,
      policy: input.policy,
    }).sources;
    if (selected.some((source) => source.option.selectable)) return selected;
    const composite = buildCompositeRelaySourceOption({
      candidates: selected,
      requiredDestination: input.requiredAmount,
      maximumFeeUsd: limits.maximumFeeUsd,
      maximumFeeBps: limits.maximumFeeBps,
    });
    return composite ? [...selected, composite] : selected;
  }

  private async quoteRelayWithinBudget(
    input: Omit<
      Parameters<RelayFirstSourcePlannerDependencies["quoteRelay"]>[0],
      "signal" | "timeoutMs"
    >,
    timeoutMs: number,
  ): Promise<RelayPlanningQuote | null> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(
        () => {
          controller.abort();
          resolve(null);
        },
        Math.max(1, Math.floor(timeoutMs)),
      );
    });
    try {
      return await Promise.race([
        this.dependencies.quoteRelay({
          ...input,
          signal: controller.signal,
          timeoutMs: Math.max(1, Math.floor(timeoutMs)),
        }),
        timeout,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

function boundedTestTimeout(
  requested: number | undefined,
  productionMaximum: number,
): number {
  if (requested == null) return productionMaximum;
  if (!Number.isFinite(requested) || requested <= 0) {
    throw new Error("funding planner timeout must be positive");
  }
  return Math.min(Math.floor(requested), productionMaximum);
}

export function assertSingleSegmentExecutionPlan(
  plan: FundingExecutionPlan,
): void {
  if (plan.segments.length > 1) {
    throw new Error("funding planner forbids staged or second-segment routes");
  }
  if (
    plan.kind === "wallet_route" &&
    (plan.segments.length !== 1 || plan.segments[0]?.providerId !== "relay")
  ) {
    throw new Error(
      "wallet funding route must contain exactly one Relay segment",
    );
  }
  if (
    (plan.kind === "direct_external_handoff" ||
      plan.kind === "already_available") &&
    plan.segments.length !== 0
  ) {
    throw new Error("zero-provider funding plan contains a provider segment");
  }
}

/**
 * Keeps provider choice internal: only exact enabled Relay candidates survive,
 * every plan is one segment at most, and source ranking never changes placement.
 * Economically unavailable exact Relay quotes remain visible as typed,
 * unselectable source options instead of disappearing from discovery.
 */
export function selectRelayFirstSourceOptions(
  input: Readonly<{
    candidates: readonly RelayFirstCandidate[];
    requiredDestination: Money;
    policy: FundingRuntimePolicy;
  }>,
): RelayFirstSelection {
  const relayProvider = input.policy.providers.find(
    (provider) => provider.providerId === "relay",
  );
  if (!relayProvider) {
    return { sources: [], reasonCodes: ["provider_capability_disabled"] };
  }
  const allowedRoutes = new Map(
    input.policy.routes
      .filter(
        (route) =>
          route.enabled &&
          route.providerId === "relay" &&
          relayProvider.enabledCapabilities.includes(route.capability),
      )
      .map((route) => [route.routeId, route] as const),
  );
  const sources = [...input.candidates]
    .filter(
      (candidate) =>
        candidate.providerId === "relay" &&
        candidate.routeEnabled &&
        allowedRoutes.has(candidate.routeId),
    )
    .sort(
      (left, right) =>
        left.routeId.localeCompare(right.routeId) ||
        left.sourceOption.sourceOptionId.localeCompare(
          right.sourceOption.sourceOptionId,
        ),
    )
    .map((candidate): PlannedSourceOption => {
      const route = allowedRoutes.get(candidate.routeId);
      if (!route) {
        throw new Error("Relay source route disappeared during selection");
      }
      assertSingleSegmentExecutionPlan(candidate.executionPlan);
      if (
        candidate.executionPlan.kind !==
          candidate.commitPlan.operation.planKind ||
        candidate.executionPlan.segments.length !==
          candidate.commitPlan.segments.length
      ) {
        throw new Error("public and committed funding plan shapes differ");
      }
      const publicSegment = candidate.executionPlan.segments[0];
      const committedSegment = candidate.commitPlan.segments[0];
      if (
        publicSegment &&
        committedSegment &&
        (publicSegment.providerId !== committedSegment.providerId ||
          publicSegment.adapterId !== committedSegment.adapterId ||
          publicSegment.adapterVersion !== committedSegment.adapterVersion ||
          publicSegment.adapterId !== route.adapterId ||
          publicSegment.adapterVersion !== route.adapterVersion ||
          committedSegment.segmentKind !== route.capability)
      ) {
        throw new Error("public and committed provider segments differ");
      }
      if (
        candidate.sourceOption.source.kind === "composite" ||
        candidate.sourceOption.source.kind === "venue_preparation"
      ) {
        throw new Error(
          "single Relay candidate cannot contain a composite source",
        );
      }
      const sourceAsset =
        candidate.sourceOption.source.kind === "owned_location"
          ? candidate.sourceOption.source.location.asset
          : candidate.sourceOption.source.asset;
      if (
        !sourceAsset ||
        !sameAsset(sourceAsset, route.sourceAsset) ||
        !sameAsset(input.requiredDestination.asset, route.destinationAsset)
      ) {
        throw new Error("source option assets differ from route policy");
      }
      let option = candidate.sourceOption;
      const compositeEligible = option.selectable;
      const expected = option.expectedDestination;
      const minimum = option.minimumDestination;
      if (!expected || !minimum) {
        throw new Error("executable source option lacks exact route economics");
      }
      assertSameAsset(
        expected.asset,
        input.requiredDestination.asset,
        "source expected destination",
      );
      assertSameAsset(
        minimum.asset,
        input.requiredDestination.asset,
        "source minimum destination",
      );
      if (rawAmount(expected.raw) < rawAmount(minimum.raw)) {
        throw new Error("source option output economics are inconsistent");
      }
      if (rawAmount(minimum.raw) < rawAmount(input.requiredDestination.raw)) {
        option = {
          ...option,
          experienceMode: "unavailable",
          selectable: false,
          reasonCodes: [
            ...new Set<FundingReasonCode>([
              ...option.reasonCodes,
              "minimum_output_not_met",
            ]),
          ],
        };
      }
      return {
        option,
        commitPlan: candidate.commitPlan,
        routeId: candidate.routeId,
        providerId: "relay",
        compositeEligible,
      };
    });
  return {
    sources,
    reasonCodes: sources.some((source) => source.option.selectable)
      ? []
      : ["insufficient_liquidity"],
  };
}
