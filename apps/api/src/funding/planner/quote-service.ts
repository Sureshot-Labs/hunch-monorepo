import { randomBytes } from "node:crypto";
import type { Pool } from "@hunch/infra";

import type {
  FundingQuoteRequest,
  FundingQuoteSummary,
  JsonValue,
  Money,
  SourceOption,
} from "../domain/types.js";
import {
  FUNDING_TTL,
  type FundingRuntimePolicy,
} from "../policies/funding-policy.js";
import {
  isWithdrawalPurpose,
  withdrawalBindingMatches,
} from "../domain/withdrawal-binding.js";
import {
  FundingPersistenceError,
  createFundingQuote,
  fundingEconomicSourceReservations,
  type FundingCommitPlan,
  type FundingQuoteCommitScope,
} from "../persistence/funding-operation-repository.js";
import {
  canonicalJsonEqual,
  canonicalJsonHash,
} from "../persistence/canonical.js";
import type { FundingPlanningStore } from "./planning-types.js";
import { FundingPlannerError, assertSameAsset } from "./money.js";
import { fundingQuoteAmountBindingForCommitPlan } from "./quote-amount-binding.js";

function jsonRecord(value: unknown): Readonly<Record<string, JsonValue>> {
  return value as Readonly<Record<string, JsonValue>>;
}

function sameMoney(left: Money | null, right: Money | null): boolean {
  if (!left || !right) return left === right;
  try {
    assertSameAsset(left.asset, right.asset, "quoted amount");
    return left.raw === right.raw;
  } catch {
    return false;
  }
}

function usesVenuePreparation(
  planKind: string,
  source: Readonly<{
    kind: string;
    sourceLegs?: readonly Readonly<{
      source: Readonly<{ kind: string }>;
    }>[];
  }>,
): boolean {
  return (
    planKind === "venue_preparation" ||
    source.kind === "venue_preparation" ||
    source.sourceLegs?.some(
      (leg) => leg.source.kind === "venue_preparation",
    ) === true
  );
}

type QuoteSourceAmount = FundingQuoteSummary["sourceAmounts"][number];

function reservationAmount(
  input: ReturnType<typeof fundingEconomicSourceReservations>[number],
): Money {
  const { reservation } = input;
  return {
    asset: {
      networkId: reservation.networkId,
      assetId: reservation.assetId,
      decimals: reservation.assetDecimals,
    },
    raw: input.rawAmount,
  };
}

function venuePreparationSourceAmounts(
  plan: FundingCommitPlan,
  safeLabel: string,
  expectedInputCount: number,
): readonly QuoteSourceAmount[] {
  const reservations = fundingEconomicSourceReservations(
    plan.reservations.filter(
      (reservation) =>
        reservation.segmentOrdinal === null &&
        reservation.mode === "subtract_available",
    ),
  );
  if (reservations.length === 0 || reservations.length !== expectedInputCount) {
    throw new FundingPersistenceError(
      "quote_mismatch",
      "venue preparation quote lacks its exact frozen source inputs",
    );
  }
  return reservations.map((reservation) => ({
    safeLabel,
    amount: reservationAmount(reservation),
  }));
}

function fundingQuoteSourceAmounts(
  input: Readonly<{
    option: SourceOption;
    plan: FundingCommitPlan;
    plannedSource: Money | null;
  }>,
): readonly QuoteSourceAmount[] {
  if (
    input.option.kind === "venue_preparation" &&
    input.option.source.kind === "venue_preparation"
  ) {
    return venuePreparationSourceAmounts(
      input.plan,
      input.option.safeLabel,
      input.option.source.inputCount,
    );
  }
  if (input.option.kind === "composite") {
    return (input.option.sourceLegs ?? []).flatMap((leg) =>
      leg.source.kind === "venue_preparation"
        ? venuePreparationSourceAmounts(
            input.plan,
            leg.safeLabel,
            leg.source.inputCount,
          )
        : [{ safeLabel: leg.safeLabel, amount: leg.sourceAmount }],
    );
  }
  return input.plannedSource
    ? [{ safeLabel: input.option.safeLabel, amount: input.plannedSource }]
    : [];
}

export function classifyFundingQuoteConsent(
  input: Readonly<{
    purpose: string;
    ingress: boolean;
    sourceAmounts: readonly Readonly<{ amount: Money }>[];
    expectedDestination: Money;
    minimumDestination: Money;
  }>,
): FundingQuoteSummary["consentMode"] {
  if (input.ingress) return "external_action";
  // A fresh trade quote already is the user's economic confirmation. Any
  // conversion contained in that exact quote must not add a second prompt.
  if (input.purpose === "trade_shortfall") return "trade_intent";
  return "explicit_economic_review";
}

export class FundingQuoteService {
  constructor(
    private readonly dependencies: Readonly<{
      db: Pool;
      planningStore: FundingPlanningStore;
      createQuote?: typeof createFundingQuote;
      revalidateWithdrawalRecipient?: (
        userId: string,
        recipientId: string,
      ) => Promise<void>;
      now?: () => Date;
    }>,
  ) {}

  async quote(
    input: Readonly<{
      userId: string;
      request: FundingQuoteRequest;
      policy: FundingRuntimePolicy;
      policyRevision: string;
      ownershipRevision: string;
      commitScope?: FundingQuoteCommitScope;
    }>,
  ): Promise<FundingQuoteSummary> {
    const now = this.dependencies.now?.() ?? new Date();
    const planning = await this.dependencies.planningStore.fetchOwnedCurrent({
      userId: input.userId,
      projectionId: input.request.liquidityProjectionId,
      now,
    });
    if (!planning) {
      throw new FundingPlannerError(
        "stale_projection",
        "funding discovery projection is absent or expired",
      );
    }
    const withdrawalIntent = isWithdrawalPurpose(planning.request.purpose);
    if (
      !withdrawalIntent &&
      (input.policy.creationMode !== "on" || !input.policy.gates.quoteCreation)
    ) {
      throw new FundingPlannerError(
        "invalid_policy",
        "funding quote creation is disabled",
      );
    }
    if (
      (!withdrawalIntent &&
        (planning.policyVersion !== input.policy.contractVersion ||
          planning.policyRevision !== input.policyRevision)) ||
      planning.ownershipRevision !== input.ownershipRevision
    ) {
      throw new FundingPlannerError(
        "stale_projection",
        "funding discovery facts changed before quote creation",
      );
    }
    const selected = planning.plannerSnapshot.sources.find(
      (source) =>
        source.option.sourceOptionId === input.request.selectedSourceOptionId,
    );
    if (!selected || !selected.option.selectable) {
      throw new FundingPlannerError(
        "source_not_selected",
        "exactly one owned selectable source option is required",
      );
    }
    if (
      planning.request.purpose === "convert_asset" &&
      selected.option.amountMode !== "exact_input"
    ) {
      throw new FundingPersistenceError(
        "quote_mismatch",
        "Convert quote must use the frozen exact input amount",
      );
    }
    const storedPlan = selected.commitPlan;
    const externalRecipientId = storedPlan.operation.externalRecipientId;
    if (
      !withdrawalBindingMatches(
        planning.request.purpose,
        externalRecipientId,
      ) ||
      externalRecipientId !== planning.request.withdrawalRecipientId
    ) {
      throw new FundingPersistenceError(
        "quote_mismatch",
        "withdrawal source plan differs from the frozen recipient",
      );
    }
    if (withdrawalIntent && !this.dependencies.revalidateWithdrawalRecipient) {
      throw new FundingPlannerError(
        "destination_unavailable",
        "withdrawal recipient revalidation is unavailable",
      );
    }
    if (withdrawalIntent && externalRecipientId) {
      await this.dependencies.revalidateWithdrawalRecipient?.(
        input.userId,
        externalRecipientId,
      );
    }
    const plannedBinding = fundingQuoteAmountBindingForCommitPlan(storedPlan);
    const plannedSource = plannedBinding.confirmedSourceAmount;
    const plannedDestination = plannedBinding.requestedDestinationAmount;
    const sourceMatches = sameMoney(
      input.request.confirmedSourceAmount,
      plannedSource,
    );
    const destinationMatches = sameMoney(
      input.request.requestedDestinationAmount,
      plannedDestination,
    );
    if (
      (selected.option.amountMode === "exact_input" && !sourceMatches) ||
      (selected.option.amountMode !== "exact_input" && !destinationMatches) ||
      (input.request.confirmedSourceAmount != null && !sourceMatches) ||
      (input.request.requestedDestinationAmount != null && !destinationMatches)
    ) {
      throw new FundingPersistenceError(
        "quote_mismatch",
        "quote request raw amounts differ from the selected source plan",
      );
    }
    if (
      storedPlan.segments.length > 1 &&
      storedPlan.operation.planKind !== "composite_route"
    ) {
      throw new FundingPersistenceError(
        "quote_mismatch",
        "staged or second-segment funding plans are forbidden",
      );
    }
    const destination = planning.plannerSnapshot.destination;
    const withdrawalRecipient = planning.plannerSnapshot.withdrawalRecipient;
    if (
      !planning.plannerSnapshot.placement ||
      (withdrawalIntent ? !withdrawalRecipient : !destination)
    ) {
      throw new FundingPlannerError(
        "destination_unavailable",
        "funding projection has no exact destination and placement",
      );
    }
    let frozenTarget;
    let frozenBinding;
    if (withdrawalIntent) {
      if (!withdrawalRecipient) {
        throw new FundingPlannerError(
          "destination_unavailable",
          "withdrawal projection has no frozen recipient",
        );
      }
      frozenTarget = {
        kind: "external_recipient" as const,
        recipient: withdrawalRecipient,
      };
      frozenBinding = null;
    } else {
      if (!destination) {
        throw new FundingPlannerError(
          "destination_unavailable",
          "funding projection has no frozen venue destination",
        );
      }
      frozenTarget = destination.target;
      frozenBinding = usesVenuePreparation(
        storedPlan.operation.planKind,
        selected.option,
      )
        ? destination.venueBinding
        : destination.bindingOption;
    }
    const frozenFactMismatches = [
      !canonicalJsonEqual(storedPlan.operation.sourceSnapshot, selected.option)
        ? "source"
        : null,
      !canonicalJsonEqual(
        storedPlan.operation.destinationTargetSnapshot,
        frozenTarget,
      )
        ? "destination"
        : null,
      !canonicalJsonEqual(
        storedPlan.operation.venueBindingSnapshot,
        frozenBinding,
      )
        ? "binding"
        : null,
      !canonicalJsonEqual(
        storedPlan.operation.marketContextSnapshot,
        planning.plannerSnapshot.marketContext,
      )
        ? "market_context"
        : null,
      !canonicalJsonEqual(
        storedPlan.operation.placementSnapshot,
        planning.plannerSnapshot.placement,
      )
        ? "placement"
        : null,
    ].filter((value): value is string => value != null);
    if (frozenFactMismatches.length > 0) {
      throw new FundingPersistenceError(
        "quote_mismatch",
        `selected source plan differs from frozen facts: ${frozenFactMismatches.join(",")}`,
      );
    }
    const plan = {
      ...storedPlan,
      operation: {
        ...storedPlan.operation,
        supportMetadata: {
          ...(storedPlan.operation.supportMetadata ?? {}),
          discoveryProjectionId: planning.id,
          ownershipRevision: planning.ownershipRevision,
        },
      },
    };

    const consentToken = `consent_${randomBytes(32).toString("base64url")}`;
    const directExternalHandoff =
      plan.operation.planKind === "direct_external_handoff" &&
      selected.option.source.kind === "external_ingress";
    const quoteTtlMs = withdrawalIntent
      ? FUNDING_TTL.quoteMs
      : input.policy.ttl.quoteMs;
    const expiresAt = new Date(
      directExternalHandoff
        ? now.getTime() + quoteTtlMs
        : Math.min(
            planning.expiresAt.getTime(),
            Date.parse(selected.option.expiresAt),
            now.getTime() + quoteTtlMs,
          ),
    );
    if (expiresAt.getTime() <= now.getTime()) {
      throw new FundingPlannerError(
        "stale_projection",
        "selected source option expired before quote creation",
      );
    }
    const stored = await (this.dependencies.createQuote ?? createFundingQuote)(
      this.dependencies.db,
      {
        userId: input.userId,
        discoveryProjectionId: planning.id,
        selectedSourceOptionSnapshot:
          plan.operation.sourceSnapshot ?? jsonRecord(selected.option),
        marketContextSnapshot: planning.plannerSnapshot.marketContext
          ? jsonRecord(planning.plannerSnapshot.marketContext)
          : null,
        destinationOptionSnapshot: plan.operation.destinationTargetSnapshot,
        venueBindingSnapshot: plan.operation.venueBindingSnapshot,
        planSnapshot: plan,
        policyVersion: input.policy.contractVersion,
        policyRevision: input.policyRevision,
        canonicalRequest: input.request as unknown as JsonValue,
        consentToken,
        commitScope: input.commitScope ?? null,
        expiresAt,
      },
    );
    const expected = selected.option.expectedDestination;
    const minimum = selected.option.minimumDestination;
    if (!expected || !minimum) {
      throw new FundingPersistenceError(
        "quote_mismatch",
        "stored plan lacks exact destination economics",
      );
    }
    const sourceAmounts = fundingQuoteSourceAmounts({
      option: selected.option,
      plan,
      plannedSource,
    });
    return {
      quoteId: stored.id,
      liquidityProjectionId: planning.id,
      selectedSourceOptionId: selected.option.sourceOptionId,
      destinationOptionId: destination?.option.destinationOptionId ?? null,
      venueBindingOptionId:
        destination?.bindingOption.venueBindingOptionId ?? null,
      planKind: plan.operation.planKind,
      experienceMode:
        plan.operation.experienceMode === "inline"
          ? "inline_funding"
          : plan.operation.experienceMode,
      consentMode: classifyFundingQuoteConsent({
        purpose: planning.request.purpose,
        ingress: Boolean(selected.option.ingress),
        sourceAmounts,
        expectedDestination: expected,
        minimumDestination: minimum,
      }),
      sourceAmounts,
      expectedDestination: expected,
      minimumDestination: minimum,
      fees: selected.option.fees,
      eta: selected.option.eta,
      requiredActions: selected.option.requiredActions,
      ingress: selected.option.ingress ?? null,
      planHash: canonicalJsonHash(plan),
      consentToken,
      expiresAt: stored.expiresAt.toISOString(),
      policyVersion: stored.policyVersion,
    };
  }
}
