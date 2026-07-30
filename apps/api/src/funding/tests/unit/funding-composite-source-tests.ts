#!/usr/bin/env tsx

import assert from "node:assert/strict";

import type {
  AssetLocation,
  AssetRef,
  FundingSourceRef,
  Money,
  SourceOption,
} from "../../domain/types.js";
import type { FundingCommitPlan } from "../../persistence/funding-operation-repository.js";
import { buildCompositeSourceOption } from "../../planner/composite-source-options.js";
import {
  remainingFundingRequirementAfterVenuePreparation,
  restrictResidualSourcesToCompositeContribution,
} from "../../planner/production-source-planner.js";
import type { PlannedSourceOption } from "../../planner/planning-types.js";
import { sourceOptionSchema } from "../../../schemas/funding.js";

const DESTINATION_ASSET: AssetRef = {
  networkId: "evm:137",
  assetId: "0x00000000000000000000000000000000000000a1",
  decimals: 6,
};
const DESTINATION = {
  kind: "owned_location" as const,
  location: {
    kind: "venue_account",
    locationId: "location_destination_composite_12345678",
    accountId: "account_composite_12345678",
    asset: DESTINATION_ASSET,
    details: {
      address: "0x00000000000000000000000000000000000000d1",
      venueId: "venue_fixture",
    },
  },
};
const VENUE_BINDING = {
  bindingId: "binding_account_composite_12345678",
  venueId: "venue_fixture",
  settlementLocation: DESTINATION.location,
};
const VENUE_BINDING_OPTION = {
  venueBindingOptionId: "binding_option_composite_12345678",
};
const DESTINATION_OBSERVATION = {
  observerId: "owned_route_destination_observer_v1",
  locationId: DESTINATION.location.locationId,
  asset: DESTINATION_ASSET,
  baselineRaw: "3569075",
  baselineRevision: "baseline_revision_composite_12345678",
  baselineAsOf: "2026-07-24T11:59:00.000Z",
};

function money(asset: AssetRef, raw: string): Money {
  return { asset, raw };
}

function sourceLocation(
  id: string,
  networkId: string,
  assetId: string,
): AssetLocation {
  return {
    kind: "wallet",
    locationId: `location_${id}_12345678`,
    accountId: "account_composite_12345678",
    asset: { networkId, assetId, decimals: 6 },
    details: {
      address:
        networkId === "solana:mainnet"
          ? "So11111111111111111111111111111111111111112"
          : "0x00000000000000000000000000000000000000e1",
      walletId: `wallet_${id}_12345678`,
    },
  };
}

function partialSource(input: {
  id: string;
  location: AssetLocation;
  sourceRaw: string;
  maximumSourceRaw?: string;
  expectedRaw: string;
  minimumRaw: string;
  feeUsd: string;
  componentId?: string;
  payerRequirement?: "user" | "privy_sponsor";
}): PlannedSourceOption {
  const source: FundingSourceRef = {
    kind: "owned_location",
    location: input.location,
  };
  const sourceAmount = money(input.location.asset, input.sourceRaw);
  const expected = money(DESTINATION_ASSET, input.expectedRaw);
  const minimum = money(DESTINATION_ASSET, input.minimumRaw);
  const option: SourceOption = {
    sourceOptionId: `source_${input.id}_12345678`,
    kind: "wallet_asset",
    safeLabel: `${input.id} wallet`,
    source,
    amountMode: "exact_input",
    maximumSourceRaw: input.maximumSourceRaw ?? input.sourceRaw,
    expectedDestination: expected,
    minimumDestination: minimum,
    estimatedUsd: input.expectedRaw,
    fees: [
      {
        kind: "relay_fee",
        amount: money(input.location.asset, "1"),
        estimatedUsd: input.feeUsd,
      },
    ],
    eta: { minSeconds: 5, maxSeconds: 15 },
    experienceMode: "inline_funding",
    requiredActions: [
      {
        kind:
          input.location.asset.networkId === "solana:mainnet"
            ? "svm_transaction"
            : "evm_transaction",
        safeLabel: `Move ${input.id} funds`,
        actor: "user",
        valueMoving: true,
        sponsorship: input.payerRequirement === "user" ? "none" : "requested",
      },
    ],
    expiresAt: "2026-07-24T12:00:30.000Z",
    recommended: false,
    selectable: false,
    reasonCodes: ["minimum_output_not_met"],
  };
  const requiredAction = option.requiredActions[0];
  if (!requiredAction) throw new Error("test source action is missing");
  const plan: FundingCommitPlan = {
    operation: {
      purpose: "add_funds",
      initialState: { status: "in_progress", stage: "committed" },
      experienceMode: "inline",
      planKind: "wallet_route",
      sourceSnapshot: option,
      destinationTargetSnapshot: DESTINATION,
      externalRecipientId: null,
      venueId: "venue_fixture",
      marketId: null,
      marketContextSnapshot: null,
      venueBindingSnapshot: VENUE_BINDING_OPTION,
      walletExecutionSnapshot: {
        walletId: `wallet_${input.id}_12345678`,
      },
      placementSnapshot: { decision: "route" },
      requestedSourceAmount: sourceAmount,
      requestedDestinationAmount: money(DESTINATION_ASSET, "10000000"),
      supportMetadata: {
        routeId: `route_${input.id}_12345678`,
        destinationObservation: DESTINATION_OBSERVATION,
      },
    },
    segments: [
      {
        providerId: "relay",
        adapterId: "relay_quote_v2",
        adapterVersion: 1,
        segmentKind: "cross_network_transfer",
        status: "planned",
        sourceSnapshot: source,
        destinationTargetSnapshot: DESTINATION,
        quotedInput: sourceAmount,
        quotedExpectedOutput: expected,
        quotedMinOutput: minimum,
        providerQuoteRefCiphertext: `ciphertext_${input.id}_12345678`,
        providerQuoteRefLookupHmac: `hmac_${input.id}_12345678_abcdefghijklmnopqrstuvwxyz`,
        depositAddressCiphertext: null,
        depositAddressLookupHmac: null,
        lookupKeyVersion: 1,
        refundLocationSnapshot: input.location,
        quoteExpiresAt: option.expiresAt,
      },
    ],
    steps: [
      {
        ordinal: 0,
        segmentOrdinal: 0,
        stepKind: "transaction",
        state: "action_required",
        actionFingerprint: `fingerprint_${input.id}_12345678`,
        executorId:
          input.location.asset.networkId === "solana:mainnet"
            ? "wallet_profile_svm_v1"
            : "wallet_profile_evm_v1",
        payerRequirement: input.payerRequirement ?? "privy_sponsor",
        dependsOnOrdinal: null,
        normalizedAction: { kind: requiredAction.kind },
        actionValidationResult: { validatorId: "exact_test_v1" },
      },
    ],
    reservations: [
      {
        segmentOrdinal: 0,
        componentId: input.componentId ?? `component_${input.id}_12345678`,
        locationId: input.location.locationId,
        networkId: input.location.asset.networkId,
        assetId: input.location.asset.assetId,
        assetDecimals: input.location.asset.decimals,
        rawAmount: input.sourceRaw,
        mode: "subtract_available",
        expiresAt: option.expiresAt,
      },
    ],
  };
  return {
    option,
    commitPlan: plan,
    routeId: `route_${input.id}_12345678`,
    providerId: "relay",
    compositeEligible: true,
  };
}

function partialPreparation(): PlannedSourceOption {
  const expected = money(DESTINATION_ASSET, "3569075");
  const source: FundingSourceRef = {
    kind: "venue_preparation",
    venueId: "venue_fixture",
    venueBindingId: "binding_account_composite_12345678",
    inputCount: 2,
  };
  const option: SourceOption = {
    sourceOptionId: "source_preparation_12345678",
    kind: "venue_preparation",
    safeLabel: "Prepare trading balance",
    source,
    amountMode: "exact_output",
    maximumSourceRaw: expected.raw,
    expectedDestination: expected,
    minimumDestination: expected,
    estimatedUsd: "3.569075",
    fees: [],
    eta: { minSeconds: 5, maxSeconds: 90 },
    experienceMode: "prepare_first",
    requiredActions: [
      {
        kind: "evm_transaction",
        safeLabel: "Prepare trading balance",
        actor: "user",
        valueMoving: true,
        sponsorship: "requested",
      },
    ],
    expiresAt: "2026-07-24T12:00:30.000Z",
    recommended: false,
    selectable: false,
    reasonCodes: ["minimum_output_not_met"],
  };
  return {
    option,
    routeId: null,
    providerId: null,
    compositeEligible: true,
    commitPlan: {
      operation: {
        purpose: "add_funds",
        initialState: { status: "in_progress", stage: "committed" },
        experienceMode: "prepare_first",
        planKind: "venue_preparation",
        sourceSnapshot: option,
        destinationTargetSnapshot: DESTINATION,
        externalRecipientId: null,
        venueId: "venue_fixture",
        marketId: null,
        marketContextSnapshot: null,
        venueBindingSnapshot: VENUE_BINDING,
        walletExecutionSnapshot: {
          walletId: "wallet_preparation_12345678",
        },
        placementSnapshot: { decision: "route" },
        requestedSourceAmount: null,
        requestedDestinationAmount: expected,
        supportMetadata: {
          preparationKind: "fake_venue_preparation",
          venueBindingOptionId: VENUE_BINDING_OPTION.venueBindingOptionId,
        },
      },
      segments: [],
      steps: [
        {
          ordinal: 0,
          segmentOrdinal: null,
          stepKind: "venue_preparation",
          state: "action_required",
          actionFingerprint: "fingerprint_preparation_12345678",
          executorId: "wallet_profile_evm_v1",
          payerRequirement: "privy_sponsor",
          dependsOnOrdinal: null,
          normalizedAction: { kind: "evm_transaction" },
          actionValidationResult: { validatorId: "fake_preparation_v1" },
        },
      ],
      reservations: [
        {
          segmentOrdinal: null,
          componentId: "component_preparation_a_12345678",
          locationId: "location_preparation_a_12345678",
          networkId: DESTINATION_ASSET.networkId,
          assetId: DESTINATION_ASSET.assetId,
          assetDecimals: DESTINATION_ASSET.decimals,
          rawAmount: "2000000",
          mode: "subtract_available",
          expiresAt: option.expiresAt,
        },
        {
          segmentOrdinal: null,
          componentId: "component_preparation_b_12345678",
          locationId: "location_preparation_b_12345678",
          networkId: DESTINATION_ASSET.networkId,
          assetId: DESTINATION_ASSET.assetId,
          assetDecimals: DESTINATION_ASSET.decimals,
          rawAmount: "1569075",
          mode: "subtract_available",
          expiresAt: option.expiresAt,
        },
      ],
    },
  };
}

const base = partialSource({
  id: "base",
  location: sourceLocation(
    "base",
    "evm:8453",
    "0x00000000000000000000000000000000000000b1",
  ),
  sourceRaw: "4000000",
  expectedRaw: "4000000",
  minimumRaw: "3970000",
  feeUsd: "0.03",
});
const solana = partialSource({
  id: "solana",
  location: sourceLocation(
    "solana",
    "solana:mainnet",
    "So11111111111111111111111111111111111111113",
  ),
  sourceRaw: "6100000",
  expectedRaw: "6100000",
  minimumRaw: "6030000",
  feeUsd: "0.07",
});
const excessive = partialSource({
  id: "excessive",
  location: sourceLocation(
    "excessive",
    "evm:137",
    "0x00000000000000000000000000000000000000c1",
  ),
  sourceRaw: "7200000",
  expectedRaw: "7100000",
  minimumRaw: "7000000",
  feeUsd: "0.10",
});

const composite = buildCompositeSourceOption({
  candidates: [excessive, solana, base],
  requiredDestination: money(DESTINATION_ASSET, "10000000"),
  destinationUnitPriceUsd: "1",
  maximumFeeUsd: "1",
  maximumFeeBps: 2_000,
});
assert.ok(composite);
assert.equal(composite.option.kind, "composite");
assert.equal(composite.option.source.kind, "composite");
assert.equal(composite.option.sourceLegs?.length, 2);
assert.deepEqual(
  composite.option.sourceLegs?.map((leg) => leg.safeLabel),
  ["base wallet", "solana wallet"],
);
assert.equal(composite.option.minimumDestination?.raw, "10000000");
assert.equal(composite.commitPlan.operation.planKind, "composite_route");
assert.equal(composite.commitPlan.segments.length, 2);
assert.deepEqual(
  composite.commitPlan.steps.map((step) => step.segmentOrdinal),
  [0, 1],
);
assert.deepEqual(
  composite.commitPlan.reservations.map(
    (reservation) => reservation.segmentOrdinal,
  ),
  [0, 1],
);
assert.equal(composite.commitPlan.reservations.length, 2);
assert.equal(composite.commitPlan.steps.length, 2);
assert.equal(composite.commitPlan.steps[0]?.dependsOnOrdinal, null);
assert.equal(composite.commitPlan.steps[1]?.dependsOnOrdinal, null);
assert.equal(composite.commitPlan.operation.requestedSourceAmount, null);
assert.equal(
  (
    composite.commitPlan.operation.requestedDestinationAmount as {
      raw: string;
    }
  ).raw,
  "10000000",
);
sourceOptionSchema.parse(composite.option);

const preparation = partialPreparation();
assert.equal(
  remainingFundingRequirementAfterVenuePreparation(
    [preparation],
    money(DESTINATION_ASSET, "4227649"),
  )?.raw,
  "658574",
);
const smallerPreparation = {
  ...preparation,
  option: {
    ...preparation.option,
    sourceOptionId: "source_smaller_preparation_12345678",
    expectedDestination: money(DESTINATION_ASSET, "1000000"),
    minimumDestination: money(DESTINATION_ASSET, "1000000"),
  },
};
assert.equal(
  remainingFundingRequirementAfterVenuePreparation(
    [smallerPreparation, preparation],
    money(DESTINATION_ASSET, "4227649"),
  )?.raw,
  "658574",
);
const fullAutomaticPreparationOption = {
  ...preparation.option,
  selectable: true,
  expectedDestination: money(DESTINATION_ASSET, "4227649"),
  minimumDestination: money(DESTINATION_ASSET, "4227649"),
};
const fullAutomaticPreparation = {
  ...preparation,
  compositeEligible: false,
  option: fullAutomaticPreparationOption,
  commitPlan: {
    ...preparation.commitPlan,
    operation: {
      ...preparation.commitPlan.operation,
      sourceSnapshot: fullAutomaticPreparationOption,
      requestedDestinationAmount: money(DESTINATION_ASSET, "4227649"),
    },
    reservations: preparation.commitPlan.reservations.map(
      (reservation, index) =>
        index === 1 ? { ...reservation, rawAmount: "2227649" } : reservation,
    ),
  },
};
assert.equal(
  remainingFundingRequirementAfterVenuePreparation(
    [fullAutomaticPreparation],
    money(DESTINATION_ASSET, "4227649"),
  ),
  null,
);
const fullUserPaidPreparation = {
  ...fullAutomaticPreparation,
  commitPlan: {
    ...fullAutomaticPreparation.commitPlan,
    steps: fullAutomaticPreparation.commitPlan.steps.map((step) => ({
      ...step,
      payerRequirement: "user" as const,
    })),
  },
};
assert.equal(
  remainingFundingRequirementAfterVenuePreparation(
    [fullUserPaidPreparation],
    money(DESTINATION_ASSET, "4227649"),
  )?.raw,
  "4227649",
);
const partialUserPaidPreparation = {
  ...preparation,
  commitPlan: {
    ...preparation.commitPlan,
    steps: preparation.commitPlan.steps.map((step) => ({
      ...step,
      payerRequirement: "user" as const,
    })),
  },
};
assert.equal(
  remainingFundingRequirementAfterVenuePreparation(
    [partialUserPaidPreparation],
    money(DESTINATION_ASSET, "4227649"),
  )?.raw,
  "4227649",
);
const residualRelay = partialSource({
  id: "residual",
  location: sourceLocation(
    "residual",
    "evm:8453",
    "0x00000000000000000000000000000000000000b1",
  ),
  sourceRaw: "658574",
  maximumSourceRaw: "2802562",
  expectedRaw: "658574",
  minimumRaw: "658574",
  feeUsd: "0.01",
});
const productionResidualRelay = {
  ...residualRelay,
  option: {
    ...residualRelay.option,
    experienceMode: "inline_funding" as const,
    recommended: true,
    selectable: true,
    reasonCodes: [],
  },
};
const [compositeOnlyResidualRelay] =
  restrictResidualSourcesToCompositeContribution([productionResidualRelay], {
    plannedRequirement: money(DESTINATION_ASSET, "658574"),
    fullRequirement: money(DESTINATION_ASSET, "4227649"),
  });
assert.ok(compositeOnlyResidualRelay);
assert.equal(compositeOnlyResidualRelay.option.selectable, false);
assert.equal(compositeOnlyResidualRelay.option.recommended, false);
assert.equal(
  compositeOnlyResidualRelay.option.reasonCodes.includes(
    "minimum_output_not_met",
  ),
  true,
);
assert.equal(compositeOnlyResidualRelay.compositeEligible, true);
assert.equal(
  restrictResidualSourcesToCompositeContribution([productionResidualRelay], {
    plannedRequirement: money(DESTINATION_ASSET, "4227649"),
    fullRequirement: money(DESTINATION_ASSET, "4227649"),
  })[0],
  productionResidualRelay,
);
const gasBlockedSolanaCandidate = partialSource({
  id: "gas_blocked_solana",
  location: sourceLocation(
    "gas_blocked_solana",
    "solana:mainnet",
    "So11111111111111111111111111111111111111116",
  ),
  sourceRaw: "3000000",
  expectedRaw: "3000000",
  minimumRaw: "3000000",
  feeUsd: "0.01",
});
const gasBlockedSolana = {
  ...gasBlockedSolanaCandidate,
  compositeEligible: false,
  option: {
    ...gasBlockedSolanaCandidate.option,
    selectable: false,
    reasonCodes: ["insufficient_gas" as const],
  },
};
const exactRequiredRaw = 8_335_681n;
const exactDestinationRaw = 4_108_032n;
const exactShortfallRaw = exactRequiredRaw - exactDestinationRaw;
assert.equal(exactShortfallRaw.toString(), "4227649");
const preparationAndRelay = buildCompositeSourceOption({
  candidates: [preparation, compositeOnlyResidualRelay, gasBlockedSolana],
  requiredDestination: money(DESTINATION_ASSET, exactShortfallRaw.toString()),
  destinationUnitPriceUsd: "1",
  maximumFeeUsd: "1",
  maximumFeeBps: 2_000,
});
assert.ok(preparationAndRelay);
assert.deepEqual(
  preparationAndRelay.option.sourceLegs?.map((leg) => leg.source.kind),
  ["venue_preparation", "owned_location"],
);
assert.equal(preparationAndRelay.option.minimumDestination?.raw, "4227649");
assert.equal(residualRelay.option.maximumSourceRaw, "2802562");
assert.equal(
  preparationAndRelay.option.reasonCodes.includes("insufficient_gas"),
  false,
);
assert.equal(preparationAndRelay.commitPlan.segments.length, 1);
assert.equal(preparationAndRelay.commitPlan.steps.length, 2);
assert.equal(
  preparationAndRelay.commitPlan.steps.find(
    (step) => step.stepKind === "venue_preparation",
  )?.segmentOrdinal,
  null,
);
assert.ok(
  preparationAndRelay.commitPlan.steps.every(
    (step) => step.dependsOnOrdinal === null,
  ),
);
assert.deepEqual(
  preparationAndRelay.commitPlan.reservations.map(
    (reservation) => reservation.segmentOrdinal,
  ),
  [null, null, 0],
);
assert.deepEqual(
  preparationAndRelay.commitPlan.operation.supportMetadata
    ?.venuePreparationMinimumDestination,
  money(DESTINATION_ASSET, "3569075"),
);
assert.deepEqual(
  preparationAndRelay.commitPlan.operation.supportMetadata
    ?.destinationObservation,
  DESTINATION_OBSERVATION,
);
sourceOptionSchema.parse(preparationAndRelay.option);

const insufficientResidualRelay = partialSource({
  id: "insufficient_residual",
  location: sourceLocation(
    "insufficient_residual",
    "evm:8453",
    "0x00000000000000000000000000000000000000b5",
  ),
  sourceRaw: "658573",
  maximumSourceRaw: "2802562",
  expectedRaw: "658573",
  minimumRaw: "658573",
  feeUsd: "0.01",
});
assert.equal(
  buildCompositeSourceOption({
    candidates: [preparation, insufficientResidualRelay],
    requiredDestination: money(DESTINATION_ASSET, "4227649"),
    destinationUnitPriceUsd: "1",
    maximumFeeUsd: "1",
    maximumFeeBps: 2_000,
  }),
  null,
);

const firstResidualRelay = partialSource({
  id: "first_residual",
  location: sourceLocation(
    "first_residual",
    "evm:8453",
    "0x00000000000000000000000000000000000000b3",
  ),
  sourceRaw: "400000",
  expectedRaw: "400000",
  minimumRaw: "400000",
  feeUsd: "0.01",
});
const secondResidualRelay = partialSource({
  id: "second_residual",
  location: sourceLocation(
    "second_residual",
    "solana:mainnet",
    "So11111111111111111111111111111111111111115",
  ),
  sourceRaw: "258574",
  expectedRaw: "258574",
  minimumRaw: "258574",
  feeUsd: "0.01",
});
const preparationAndTwoRelaySources = buildCompositeSourceOption({
  candidates: [preparation, firstResidualRelay, secondResidualRelay],
  requiredDestination: money(DESTINATION_ASSET, "4227649"),
  destinationUnitPriceUsd: "1",
  maximumFeeUsd: "1",
  maximumFeeBps: 2_000,
});
assert.ok(preparationAndTwoRelaySources);
assert.deepEqual(
  preparationAndTwoRelaySources.option.sourceLegs?.map(
    (leg) => leg.source.kind,
  ),
  ["venue_preparation", "owned_location", "owned_location"],
);
assert.equal(
  preparationAndTwoRelaySources.option.minimumDestination?.raw,
  "4227649",
);
assert.equal(preparationAndTwoRelaySources.commitPlan.segments.length, 2);
assert.equal(preparationAndTwoRelaySources.commitPlan.steps.length, 3);
assert.deepEqual(
  preparationAndTwoRelaySources.commitPlan.reservations.map(
    (reservation) => reservation.segmentOrdinal,
  ),
  [null, null, 0, 1],
);
assert.ok(
  preparationAndTwoRelaySources.commitPlan.steps.every(
    (step) => step.dependsOnOrdinal === null,
  ),
);
sourceOptionSchema.parse(preparationAndTwoRelaySources.option);

const walletConfirmationSource = partialSource({
  id: "wallet_confirmation",
  location: sourceLocation(
    "wallet_confirmation",
    "evm:8453",
    "0x00000000000000000000000000000000000000b2",
  ),
  sourceRaw: "658574",
  expectedRaw: "658574",
  minimumRaw: "658574",
  feeUsd: "0.01",
  payerRequirement: "user",
});
assert.equal(
  buildCompositeSourceOption({
    candidates: [preparation, walletConfirmationSource],
    requiredDestination: money(DESTINATION_ASSET, "4227649"),
    destinationUnitPriceUsd: "1",
    maximumFeeUsd: "1",
    maximumFeeBps: 2_000,
  }),
  null,
);

assert.equal(
  buildCompositeSourceOption({
    candidates: [base, solana],
    requiredDestination: money(DESTINATION_ASSET, "10000000"),
    destinationUnitPriceUsd: "1",
    maximumFeeUsd: "0.05",
    maximumFeeBps: 2_000,
  }),
  null,
);
assert.equal(
  buildCompositeSourceOption({
    candidates: [base, solana],
    requiredDestination: money(DESTINATION_ASSET, "10000000"),
    destinationUnitPriceUsd: null,
    maximumFeeUsd: "1",
    maximumFeeBps: 2_000,
  }),
  null,
);

const baseReservation = base.commitPlan.reservations[0];
assert.ok(baseReservation);
assert.equal(
  buildCompositeSourceOption({
    candidates: [
      base,
      partialSource({
        id: "duplicate",
        location: sourceLocation(
          "duplicate",
          "solana:mainnet",
          "So11111111111111111111111111111111111111114",
        ),
        sourceRaw: "6100000",
        expectedRaw: "6100000",
        minimumRaw: "6030000",
        feeUsd: "0.07",
        componentId: baseReservation.componentId,
      }),
    ],
    requiredDestination: money(DESTINATION_ASSET, "10000000"),
    destinationUnitPriceUsd: "1",
    maximumFeeUsd: "1",
    maximumFeeBps: 2_000,
  }),
  null,
);

const overBoundCandidates = Array.from({ length: 17 }, (_, index) =>
  partialSource({
    id: `bounded_${index}`,
    location: sourceLocation(
      `bounded_${index}`,
      "evm:8453",
      "0x00000000000000000000000000000000000000b4",
    ),
    sourceRaw: "1000000",
    expectedRaw: "1000000",
    minimumRaw: "1000000",
    feeUsd: "0.01",
  }),
);
assert.equal(
  buildCompositeSourceOption({
    candidates: overBoundCandidates,
    requiredDestination: money(DESTINATION_ASSET, "10000000"),
    destinationUnitPriceUsd: "1",
    maximumFeeUsd: "1",
    maximumFeeBps: 2_000,
  }),
  null,
);

console.log(
  "[funding-composite-source-tests] ok exact destination/required fixture, minimal-excess selection, insufficient aggregate rejection, bounded fail-closed search, automatic venue preparation plus one or two Relay sources, irrelevant gas blocker exclusion, user-wallet exclusion, exact aggregate minimum, independent dependencies, atomic multi-reservations, fee cap, duplicate rejection",
);
