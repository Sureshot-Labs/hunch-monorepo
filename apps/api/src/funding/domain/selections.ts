import type {
  FundingDestinationOption,
  FundingReasonCode,
  PreparationPurpose,
  VenueBindingOption,
} from "./types.js";

export type VenueBindingSelectionReason =
  | "position_owner"
  | "explicit_current_intent"
  | "internal_default";

export type VenueBindingSelectionResult = Readonly<{
  selected: VenueBindingOption | null;
  reason: VenueBindingSelectionReason | null;
  alternatives: readonly VenueBindingOption[];
  reasonCodes: readonly FundingReasonCode[];
}>;

function isExecutableTradingWalletOption(option: VenueBindingOption): boolean {
  return (
    option.selectable &&
    option.readinessClass !== "external_source_only" &&
    option.readinessClass !== "external_view_only"
  );
}

/**
 * Resolves a Trading Wallet for this intent only. It never looks at balances,
 * never persists a preference, and returns only an opaque binding option.
 */
export function selectVenueBindingForCurrentIntent(
  input: Readonly<{
    purpose: PreparationPurpose;
    options: readonly VenueBindingOption[];
    explicitVenueBindingOptionId: string | null;
    positionOwnerVenueBindingOptionId: string | null;
  }>,
): VenueBindingSelectionResult {
  const compatible = input.options.filter(
    (option) =>
      option.preparationPurpose === input.purpose &&
      isExecutableTradingWalletOption(option),
  );

  if (input.purpose === "sell" || input.purpose === "redeem") {
    const owner = compatible.find(
      (option) =>
        option.venueBindingOptionId === input.positionOwnerVenueBindingOptionId,
    );
    if (!owner) {
      return {
        selected: null,
        reason: null,
        alternatives: compatible,
        reasonCodes: ["binding_owner_mismatch"],
      };
    }
    return {
      selected: owner,
      reason: "position_owner",
      alternatives: compatible.filter(
        (option) => option.venueBindingOptionId !== owner.venueBindingOptionId,
      ),
      reasonCodes: [],
    };
  }

  if (input.explicitVenueBindingOptionId) {
    const explicit = compatible.find(
      (option) =>
        option.venueBindingOptionId === input.explicitVenueBindingOptionId,
    );
    if (!explicit) {
      return {
        selected: null,
        reason: null,
        alternatives: compatible,
        reasonCodes: ["binding_not_ready"],
      };
    }
    return {
      selected: explicit,
      reason: "explicit_current_intent",
      alternatives: compatible.filter(
        (option) =>
          option.venueBindingOptionId !== explicit.venueBindingOptionId,
      ),
      reasonCodes: [],
    };
  }

  const internal = compatible.filter(
    (option) => option.readinessClass === "internal_managed",
  );
  if (internal.length !== 1) {
    return {
      selected: null,
      reason: null,
      alternatives: compatible,
      reasonCodes: ["binding_not_ready"],
    };
  }
  const selected = internal[0];
  return {
    selected,
    reason: "internal_default",
    alternatives: compatible.filter(
      (option) => option.venueBindingOptionId !== selected.venueBindingOptionId,
    ),
    reasonCodes: [],
  };
}

export type FundingDestinationSelectionResult = Readonly<{
  selected: FundingDestinationOption | null;
  reason: "explicit" | "single_valid_option" | null;
  options: readonly FundingDestinationOption[];
  reasonCodes: readonly FundingReasonCode[];
}>;

/**
 * A recommendation is display metadata only. More than one valid destination
 * always requires an opaque explicit selection.
 */
export function selectFundingDestination(
  input: Readonly<{
    options: readonly FundingDestinationOption[];
    explicitDestinationOptionId: string | null;
  }>,
): FundingDestinationSelectionResult {
  const selectable = input.options.filter((option) => option.selectable);
  if (input.explicitDestinationOptionId) {
    const selected = selectable.find(
      (option) =>
        option.destinationOptionId === input.explicitDestinationOptionId,
    );
    return selected
      ? {
          selected,
          reason: "explicit",
          options: selectable,
          reasonCodes: [],
        }
      : {
          selected: null,
          reason: null,
          options: selectable,
          reasonCodes: ["destination_unavailable"],
        };
  }
  if (selectable.length === 1) {
    return {
      selected: selectable[0],
      reason: "single_valid_option",
      options: selectable,
      reasonCodes: [],
    };
  }
  return {
    selected: null,
    reason: null,
    options: selectable,
    reasonCodes:
      selectable.length === 0
        ? ["destination_unavailable"]
        : ["destination_not_selected"],
  };
}
