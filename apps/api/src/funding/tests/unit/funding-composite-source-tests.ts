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
import { buildCompositeRelaySourceOption } from "../../planner/composite-source-options.js";
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
      venueId: "polymarket",
    },
  },
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
  expectedRaw: string;
  minimumRaw: string;
  feeUsd: string;
  componentId?: string;
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
    maximumSourceRaw: input.sourceRaw,
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
        sponsorship: "none",
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
      venueId: "polymarket",
      marketId: null,
      marketContextSnapshot: null,
      venueBindingSnapshot: {
        venueBindingOptionId: "binding_option_composite_12345678",
      },
      walletExecutionSnapshot: {
        walletId: `wallet_${input.id}_12345678`,
      },
      placementSnapshot: { decision: "route" },
      requestedSourceAmount: sourceAmount,
      requestedDestinationAmount: money(DESTINATION_ASSET, "10000000"),
      supportMetadata: { routeId: `route_${input.id}_12345678` },
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
        payerRequirement: "user",
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

const composite = buildCompositeRelaySourceOption({
  candidates: [excessive, solana, base],
  requiredDestination: money(DESTINATION_ASSET, "10000000"),
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
assert.equal(composite.commitPlan.reservations.length, 2);
assert.equal(composite.commitPlan.steps.length, 2);
assert.equal(composite.commitPlan.steps[0]?.dependsOnOrdinal, null);
assert.equal(composite.commitPlan.steps[1]?.dependsOnOrdinal, 0);
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

assert.equal(
  buildCompositeRelaySourceOption({
    candidates: [base, solana],
    requiredDestination: money(DESTINATION_ASSET, "10000000"),
    maximumFeeUsd: "0.05",
    maximumFeeBps: 2_000,
  }),
  null,
);

const baseReservation = base.commitPlan.reservations[0];
assert.ok(baseReservation);
assert.throws(
  () =>
    buildCompositeRelaySourceOption({
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
      maximumFeeUsd: "1",
      maximumFeeBps: 2_000,
    }),
  /reserves one component twice/,
);

console.log(
  "[funding-composite-source-tests] ok minimal-excess selection, exact aggregate minimum, ordered dependencies, multi-reservations, fee cap, duplicate rejection",
);
