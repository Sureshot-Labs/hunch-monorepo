import { stableOpaqueId } from "../../account-value/canonical.js";
import type {
  DestinationInput,
  DestinationOptionsInput,
  FundingDestination,
  FundingRequirement,
  PreparationResult,
} from "../domain/contracts.js";
import type {
  AssetRef,
  FundingDestinationOption,
  FundingTarget,
  Money,
  VenueBindingOption,
} from "../domain/types.js";
import { FundingPlannerError, assertSameAsset } from "./money.js";

export type FrozenPreparationDestination = Readonly<{
  venueId: "polymarket" | "limitless";
  destinationLocationPatternId: string;
  collateralValuation: FrozenCollateralValuation | null;
  spendability: FrozenSpendabilityEvidence;
  bindingOption: VenueBindingOption;
  preparation: PreparationResult;
  target: FundingTarget;
  requiredAsset: AssetRef;
  networkLabel: string;
}>;

export type FrozenCollateralValuation = Readonly<{
  unitPriceUsd: string;
  pricePolicyId: string;
  asOf: string;
  expiresAt: string;
}>;

export type FrozenSpendabilityEvidence = Readonly<{
  observedAmount: Money;
  lockedRaw: string;
  reservedRaw: string;
  submittedDebitRaw: string;
  availableAmount: Money;
  revision: string;
  asOf: string;
  expiresAt: string;
}>;

export type FrozenPreparationFactsResolver = (
  input: DestinationOptionsInput,
) => Promise<readonly FrozenPreparationDestination[]>;

function destinationKey(fact: FrozenPreparationDestination): string {
  return [
    fact.venueId,
    fact.destinationLocationPatternId,
    fact.bindingOption.venueBindingOptionId,
    fact.bindingOption.preparationPurpose,
    fact.bindingOption.marketClass ?? "none",
    fact.bindingOption.topology,
    fact.bindingOption.inspectionRevision,
    fact.requiredAsset.networkId,
    fact.requiredAsset.assetId.toLowerCase(),
    fact.requiredAsset.decimals,
  ].join("|");
}

function toOption(
  fact: FrozenPreparationDestination,
  recommended: boolean,
  now: Date,
): FundingDestinationOption {
  const stale =
    Date.parse(fact.preparation.expiresAt) <= now.getTime() ||
    fact.preparation.inspectionRevision !==
      fact.bindingOption.inspectionRevision;
  const reasonCodes = [
    ...fact.bindingOption.reasonCodes,
    ...fact.preparation.reasonCodes,
    ...(stale ? (["preparation_evidence_stale"] as const) : []),
  ];
  return {
    destinationOptionId: stableOpaqueId("destination", destinationKey(fact)),
    venueId: fact.venueId,
    venueBindingOptionId: fact.bindingOption.venueBindingOptionId,
    safeLabel: fact.bindingOption.safeLabel,
    requiredAsset: fact.requiredAsset,
    networkLabel: fact.networkLabel,
    readinessClass: fact.preparation.readinessClass,
    preparationStatus: stale ? "unavailable" : fact.preparation.status,
    preparationPurpose: fact.preparation.purpose,
    executionMode: fact.preparation.executionMode,
    marketClass: fact.preparation.marketClass,
    topology: fact.preparation.topology,
    inspectionRevision: fact.preparation.inspectionRevision,
    recommended,
    selectable:
      !stale &&
      fact.bindingOption.selectable &&
      fact.preparation.status !== "unavailable" &&
      fact.preparation.readinessClass !== "external_source_only" &&
      fact.preparation.readinessClass !== "external_view_only",
    reasonCodes,
  };
}

abstract class FrozenVenueDestinationAdapter implements FundingDestination {
  abstract readonly venueId: FrozenPreparationDestination["venueId"];
  abstract readonly supportedMarketClasses: readonly string[];

  constructor(
    private readonly resolveFacts: FrozenPreparationFactsResolver,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  private async facts(
    input: DestinationOptionsInput,
  ): Promise<readonly FrozenPreparationDestination[]> {
    const facts = (await this.resolveFacts(input)).filter(
      (fact) => fact.venueId === this.venueId,
    );
    return facts.filter((fact) => {
      assertFrozenDestinationFact(fact, input);
      if (
        fact.bindingOption.preparationPurpose !== input.purpose ||
        fact.preparation.purpose !== input.purpose
      ) {
        return false;
      }
      if (input.compatibleVenueBindingOptionIds) {
        if (
          !input.compatibleVenueBindingOptionIds.includes(
            fact.bindingOption.venueBindingOptionId,
          )
        ) {
          return false;
        }
      }
      if (input.marketClass == null) return true;
      return (
        this.supportedMarketClasses.includes(input.marketClass) &&
        fact.bindingOption.marketClass === input.marketClass &&
        fact.preparation.marketClass === input.marketClass
      );
    });
  }

  async listOptions(
    input: DestinationOptionsInput,
  ): Promise<readonly FundingDestinationOption[]> {
    const facts = await this.facts(input);
    return facts
      .map((fact) => toOption(fact, false, this.clock()))
      .sort(
        (left, right) =>
          Number(right.recommended) - Number(left.recommended) ||
          left.safeLabel.localeCompare(right.safeLabel) ||
          left.destinationOptionId.localeCompare(right.destinationOptionId),
      );
  }

  async resolve(input: DestinationInput): Promise<FundingRequirement> {
    const facts = await this.facts({
      accountId: input.accountId,
      purpose: input.purpose,
      marketContextId: input.marketContextId,
      marketClass: input.marketClass,
      compatibleVenueBindingOptionIds: null,
    });
    for (const fact of facts) {
      const option = toOption(fact, false, this.clock());
      if (option.destinationOptionId !== input.destinationOptionId) continue;
      if (!option.selectable) {
        throw new FundingPlannerError(
          "destination_unavailable",
          "funding destination is not selectable",
        );
      }
      assertSameAsset(
        input.requestedAmount.asset,
        fact.requiredAsset,
        "destination requirement",
      );
      return {
        option,
        target: fact.target,
        requiredAmount: input.requestedAmount,
      };
    }
    throw new FundingPlannerError(
      "destination_unavailable",
      "funding destination is not owned or no longer valid",
    );
  }
}

export class PolymarketDestinationAdapter extends FrozenVenueDestinationAdapter {
  readonly venueId = "polymarket" as const;
  readonly supportedMarketClasses = ["standard", "neg_risk"] as const;
}

export class LimitlessDestinationAdapter extends FrozenVenueDestinationAdapter {
  readonly venueId = "limitless" as const;
  readonly supportedMarketClasses = [
    "clob",
    "clob_neg_risk",
    "amm",
    "amm_neg_risk",
  ] as const;
}

export class CombinedFundingDestinationResolver implements FundingDestination {
  constructor(
    private readonly adapters: readonly FundingDestination[],
    private readonly recommendationOrder: readonly string[],
  ) {}

  async listOptions(
    input: DestinationOptionsInput,
  ): Promise<readonly FundingDestinationOption[]> {
    const options = (
      await Promise.all(
        this.adapters.map((adapter) => adapter.listOptions(input)),
      )
    ).flat();
    return recommendFundingDestinations(options, this.recommendationOrder);
  }

  async resolve(input: DestinationInput): Promise<FundingRequirement> {
    for (const adapter of this.adapters) {
      try {
        return await adapter.resolve(input);
      } catch (error) {
        if (
          !(error instanceof FundingPlannerError) ||
          error.code !== "destination_unavailable"
        ) {
          throw error;
        }
      }
    }
    throw new FundingPlannerError(
      "destination_unavailable",
      "funding destination is not owned or no longer valid",
    );
  }
}

export type ResolvedDestinationCandidate = Readonly<{
  destinationLocationPatternId: string;
  collateralValuation: FrozenCollateralValuation | null;
  spendability: FrozenSpendabilityEvidence;
  option: FundingDestinationOption;
  bindingOption: VenueBindingOption;
  target: FundingTarget;
  availableNow: Money;
  preparationActions: PreparationResult["requiredActions"];
  completeness: "complete" | "partial";
  freshness: "fresh" | "stale";
}>;

function assertFrozenDestinationFact(
  fact: FrozenPreparationDestination,
  input: DestinationOptionsInput,
): void {
  // The target/account checks deliberately avoid accepting an external
  // recipient as a venue funding destination.
  if (
    fact.target.kind !== "owned_location" ||
    fact.target.location.accountId !== input.accountId ||
    fact.preparation.binding.settlementLocation.accountId !== input.accountId ||
    fact.preparation.binding.settlementLocation.locationId !==
      fact.target.location.locationId ||
    fact.preparation.binding.venueId !== fact.venueId ||
    fact.bindingOption.topology !== fact.preparation.topology ||
    fact.bindingOption.inspectionRevision !==
      fact.preparation.inspectionRevision
  ) {
    throw new FundingPlannerError(
      "destination_unavailable",
      "frozen venue preparation fact failed ownership or revision validation",
    );
  }
  assertSameAsset(
    fact.requiredAsset,
    fact.target.location.asset,
    "frozen venue destination",
  );
  assertSameAsset(
    fact.requiredAsset,
    fact.preparation.binding.settlementLocation.asset,
    "frozen venue binding settlement",
  );
  assertSameAsset(
    fact.requiredAsset,
    fact.spendability.observedAmount.asset,
    "frozen venue observed spendability",
  );
  assertSameAsset(
    fact.requiredAsset,
    fact.spendability.availableAmount.asset,
    "frozen venue available spendability",
  );
}

export function recommendFundingDestinations(
  options: readonly FundingDestinationOption[],
  venueOrder: readonly string[],
): FundingDestinationOption[] {
  const selected = [...options]
    .filter((option) => option.selectable)
    .sort((left, right) => {
      const leftIndex = venueOrder.indexOf(left.venueId);
      const rightIndex = venueOrder.indexOf(right.venueId);
      const leftRank = leftIndex < 0 ? Number.MAX_SAFE_INTEGER : leftIndex;
      const rightRank = rightIndex < 0 ? Number.MAX_SAFE_INTEGER : rightIndex;
      return (
        leftRank - rightRank ||
        left.destinationOptionId.localeCompare(right.destinationOptionId)
      );
    })[0];
  return options.map((option) => ({
    ...option,
    recommended: option.destinationOptionId === selected?.destinationOptionId,
  }));
}
