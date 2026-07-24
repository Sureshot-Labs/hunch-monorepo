import { multiplyRawByUnitPrice } from "../../account-value/decimal.js";
import { stableOpaqueId } from "../../account-value/canonical.js";
import type {
  ExternalIngressInstruction,
  JsonValue,
  SourceOption,
} from "../domain/types.js";
import { canonicalJsonHash } from "../persistence/canonical.js";
import type {
  FundingSourceAdapter,
  FundingSourcePlanningInput,
} from "./source-adapter.js";
import type { PlannedSourceOption } from "./planning-types.js";

function jsonRecord(value: unknown): Readonly<Record<string, JsonValue>> {
  return value as Readonly<Record<string, JsonValue>>;
}

function detail(input: FundingSourcePlanningInput, key: string): string | null {
  if (input.destination.target.kind !== "owned_location") return null;
  const value = input.destination.target.location.details[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function exactDestinationPolicy(input: FundingSourcePlanningInput) {
  return input.policy.locations.find(
    (location) =>
      location.enabled &&
      location.observable &&
      location.ownership === "owned" &&
      location.capabilities.includes("venue_settlement") &&
      location.locationPatternId ===
        input.destination.destinationLocationPatternId &&
      location.asset.networkId === input.requiredAmount.asset.networkId &&
      location.asset.assetId.toLowerCase() ===
        input.requiredAmount.asset.assetId.toLowerCase() &&
      location.asset.decimals === input.requiredAmount.asset.decimals,
  );
}

function instruction(input: {
  destinationAddress: string;
  destinationOptionId: string;
  expiresAt: string;
  ingressKind: "manual" | "privy";
  planning: FundingSourcePlanningInput;
}): ExternalIngressInstruction {
  const amount = input.planning.requiredAmount;
  return {
    ingressKind: input.ingressKind,
    sourceNetworkId: amount.asset.networkId,
    sourceAsset: amount.asset,
    destinationOptionId: input.destinationOptionId,
    destinationAddress: input.destinationAddress,
    exactAmount: amount,
    expiresAt: input.expiresAt,
    safeInstructions: [
      `Send only asset ${amount.asset.assetId} on ${amount.asset.networkId}.`,
      `Send exactly ${amount.raw} base units to the displayed destination.`,
      "Funding completes only after backend observation and reconciliation.",
    ],
  };
}

function sourceOption(input: {
  planning: FundingSourcePlanningInput;
  kind: "manual_receive" | "privy_funding_method";
  ingressKind: "manual" | "privy";
  safeLabel: string;
  expiresAt: string;
  destinationAddress: string;
}): SourceOption {
  const ingress = instruction({
    planning: input.planning,
    ingressKind: input.ingressKind,
    destinationAddress: input.destinationAddress,
    destinationOptionId: input.planning.destination.destinationId,
    expiresAt: input.expiresAt,
  });
  const source = {
    kind: "external_ingress" as const,
    ingressKind: input.ingressKind,
    networkId: input.planning.requiredAmount.asset.networkId,
    asset: input.planning.requiredAmount.asset,
    controlledSender: false,
  };
  return {
    sourceOptionId: stableOpaqueId(
      "source",
      canonicalJsonHash({
        destinationOptionId: input.planning.destination.destinationId,
        ingressKind: input.ingressKind,
        requiredAmount: input.planning.requiredAmount,
        policyRevision: input.planning.policyRevision,
      }),
    ),
    kind: input.kind,
    safeLabel: input.safeLabel,
    source,
    ingress,
    amountMode: "exact_output",
    maximumSourceRaw: input.planning.requiredAmount.raw,
    expectedDestination: input.planning.requiredAmount,
    minimumDestination: input.planning.requiredAmount,
    estimatedUsd: multiplyRawByUnitPrice({
      raw: input.planning.requiredAmount.raw,
      decimals: input.planning.requiredAmount.asset.decimals,
      unitPriceUsd: "1",
    }),
    fees: [],
    eta: null,
    experienceMode: "prepare_first",
    requiredActions: [
      {
        kind: "external_handoff",
        safeLabel:
          input.ingressKind === "privy"
            ? "Explicitly confirm funding in Privy"
            : "Explicitly send from your external wallet",
        actor: "user",
        valueMoving: true,
        sponsorship: "none",
      },
    ],
    expiresAt: input.expiresAt,
    recommended: false,
    selectable: true,
    reasonCodes: [],
  };
}

function plannedSource(
  input: FundingSourcePlanningInput,
  option: SourceOption,
): PlannedSourceOption {
  const destinationFacts = input.destinationFacts;
  if (input.destination.target.kind !== "owned_location") {
    throw new Error("direct ingress requires an owned destination");
  }
  if (!input.destination.venueBindingOption) {
    throw new Error("direct ingress requires a frozen venue binding option");
  }
  const destinationLocation = input.destination.target.location;
  const reservationExpiresAt = new Date(
    input.now.getTime() + input.policy.ttl.reservationMs,
  ).toISOString();
  return {
    option,
    routeId: null,
    providerId: null,
    compositeEligible: false,
    commitPlan: {
      operation: {
        purpose: input.request.purpose,
        initialState: {
          status: "awaiting_external_funds",
          stage: "source_action",
        },
        experienceMode: "prepare_first",
        planKind: "direct_external_handoff",
        sourceSnapshot: jsonRecord(option),
        destinationTargetSnapshot: jsonRecord(input.destination.target),
        externalRecipientId: null,
        venueId: input.destination.venueId,
        marketId: input.marketContext?.marketId ?? null,
        marketContextSnapshot: input.marketContext
          ? jsonRecord(input.marketContext)
          : null,
        venueBindingSnapshot: jsonRecord(input.destination.venueBindingOption),
        walletExecutionSnapshot: null,
        placementSnapshot: jsonRecord(input.placement),
        requestedSourceAmount: jsonRecord(input.requiredAmount),
        requestedDestinationAmount: jsonRecord(input.requiredAmount),
        supportMetadata: {
          adapterId: "direct_owned_receive_v1",
          destinationObserverId: "owned_destination_balance_delta_v1",
          destinationBaselineRaw:
            destinationFacts?.spendability.observedAmount.raw ?? null,
          destinationBaselineRevision:
            destinationFacts?.spendability.revision ?? null,
        },
      },
      segments: [],
      steps: [],
      reservations: [
        {
          segmentOrdinal: null,
          componentId: stableOpaqueId(
            "direct_ingress",
            `${destinationLocation.locationId}:${input.requiredAmount.asset.networkId}:${input.requiredAmount.asset.assetId.toLowerCase()}`,
          ),
          locationId: destinationLocation.locationId,
          networkId: input.requiredAmount.asset.networkId,
          assetId: input.requiredAmount.asset.assetId,
          assetDecimals: input.requiredAmount.asset.decimals,
          rawAmount: input.requiredAmount.raw,
          mode: "advisory_destination",
          expiresAt: reservationExpiresAt,
        },
      ],
    },
  };
}

export class DirectIngressFundingSourceAdapter implements FundingSourceAdapter {
  readonly adapterId = "direct_owned_receive_v1";

  async list(
    input: FundingSourcePlanningInput,
  ): Promise<readonly PlannedSourceOption[]> {
    if (
      input.request.purpose !== "add_funds" &&
      input.request.purpose !== "trade_shortfall" &&
      input.request.purpose !== "manual_rebalance"
    ) {
      return [];
    }
    const destinationPolicy = exactDestinationPolicy(input);
    const destinationAddress = detail(input, "address");
    if (
      !destinationPolicy ||
      !destinationAddress ||
      !input.destinationFacts ||
      !input.destination.venueBindingOption ||
      input.destination.target.kind !== "owned_location"
    ) {
      return [];
    }
    const expiresAt = new Date(
      input.now.getTime() + input.policy.ttl.quoteMs,
    ).toISOString();
    const manual = sourceOption({
      planning: input,
      kind: "manual_receive",
      ingressKind: "manual",
      safeLabel: "Receive exact transfer",
      expiresAt,
      destinationAddress,
    });
    const sources: PlannedSourceOption[] = [plannedSource(input, manual)];
    const privyEnabled = input.policy.privyFundingMethods.some(
      (method) =>
        method.enabled &&
        method.locallyConfigured &&
        method.destinationLocationPatternId ===
          input.destination.destinationLocationPatternId &&
        method.asset.networkId === input.requiredAmount.asset.networkId &&
        method.asset.assetId.toLowerCase() ===
          input.requiredAmount.asset.assetId.toLowerCase() &&
        method.asset.decimals === input.requiredAmount.asset.decimals,
    );
    if (privyEnabled) {
      const privy = sourceOption({
        planning: input,
        kind: "privy_funding_method",
        ingressKind: "privy",
        safeLabel: "Fund with Privy",
        expiresAt,
        destinationAddress,
      });
      sources.push(plannedSource(input, privy));
    }
    return sources;
  }
}
