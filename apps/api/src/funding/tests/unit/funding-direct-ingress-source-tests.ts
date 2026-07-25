#!/usr/bin/env tsx

import assert from "node:assert/strict";

import { sourceOptionSchema } from "../../../schemas/funding.js";
import { DirectIngressFundingSourceAdapter } from "../../planner/direct-ingress-source-adapter.js";
import type { FundingSourcePlanningInput } from "../../planner/source-adapter.js";
import type { FundingRuntimePolicy } from "../../policies/funding-policy.js";

const NOW = new Date("2026-07-24T12:00:00.000Z");
const ASSET = {
  networkId: "evm:137",
  assetId: "0x0000000000000000000000000000000000000001",
  decimals: 6,
} as const;
const ADDRESS = "0x0000000000000000000000000000000000000002";
const BINDING_OPTION = {
  venueBindingOptionId: "binding_option_direct_ingress_12345678",
  safeLabel: "Polymarket Trading Wallet",
  readinessClass: "external_ready",
  preparationPurpose: "fund",
  marketClass: null,
  topology: "safe",
  inspectionRevision: "inspection_direct_ingress_12345678",
  selectable: true,
  reasonCodes: [],
} as const;

function policy(privyEnabled: boolean): FundingRuntimePolicy {
  return {
    version: 1,
    creationMode: "on",
    ttl: { quoteMs: 30_000, reservationMs: 300_000 },
    locations: [
      {
        locationPatternId: "polymarket-venue-cash-v1",
        locationKind: "venue_account",
        ownership: "owned",
        observable: true,
        capabilities: ["observe", "venue_settlement"],
        asset: ASSET,
        enabled: true,
        policyVersion: 1,
      },
    ],
    privyFundingMethods: privyEnabled
      ? [
          {
            methodId: "privy_polygon_usdc",
            enabled: true,
            locallyConfigured: true,
            destinationLocationPatternId: "polymarket-venue-cash-v1",
            asset: ASSET,
          },
        ]
      : [],
  } as unknown as FundingRuntimePolicy;
}

function input(privyEnabled: boolean): FundingSourcePlanningInput {
  const target = {
    kind: "owned_location" as const,
    location: {
      kind: "venue_account",
      locationId: "location_direct_ingress_12345678",
      accountId: "account_direct_ingress_12345678",
      asset: ASSET,
      details: { address: ADDRESS, venueId: "polymarket" },
    },
  };
  return {
    accountId: "account_direct_ingress_12345678",
    request: {
      purpose: "add_funds",
      requestedDestinationAmount: { asset: ASSET, raw: "3000000" },
      confirmedSourceAmount: null,
      marketContextId: null,
      destinationOptionId: "destination_direct_ingress_12345678",
      withdrawalRecipientId: null,
      venueBindingOptionId: "binding_option_direct_ingress_12345678",
      maxFeeUsd: null,
      maxSlippageBps: null,
      deadline: null,
    },
    marketContext: null,
    destinationFacts: {
      destinationLocationPatternId: "polymarket-venue-cash-v1",
      collateralValuation: null,
      spendability: {
        observedAmount: { asset: ASSET, raw: "1000000" },
        lockedRaw: "0",
        reservedRaw: "0",
        submittedDebitRaw: "0",
        availableAmount: { asset: ASSET, raw: "1000000" },
        revision: "spendability_direct_ingress_12345678",
        asOf: NOW.toISOString(),
        expiresAt: new Date(NOW.getTime() + 30_000).toISOString(),
      },
      option: {} as never,
      bindingOption: BINDING_OPTION,
      target,
      availableNow: { asset: ASSET, raw: "1000000" },
      preparationActions: [],
      completeness: "complete",
      freshness: "fresh",
      venueBinding: {} as never,
      sourcePlanningEvidence: null,
    },
    destination: {
      destinationId: "destination_direct_ingress_12345678",
      destinationLocationPatternId: "polymarket-venue-cash-v1",
      target,
      requiredAsset: ASSET,
      venueId: "polymarket",
      venueBindingOption: BINDING_OPTION,
      externalRecipientId: null,
      recipientAddress: null,
    },
    placement: {
      mode: "confirmed_deposit_amount",
      sourceAmount: { asset: ASSET, raw: "3000000" },
      destinationRequirement: { asset: ASSET, raw: "3000000" },
      targetVenueId: "polymarket",
      target,
      boundedBuffer: null,
      reason: "explicit",
      policyVersion: 1,
    },
    requiredAmount: { asset: ASSET, raw: "3000000" },
    policy: policy(privyEnabled),
    policyRevision: "policy_direct_ingress_12345678",
    now: NOW,
  };
}

const adapter = new DirectIngressFundingSourceAdapter();
const manualOnly = await adapter.list(input(false));
assert.equal(manualOnly.length, 1);
assert.equal(manualOnly[0]?.option.kind, "manual_receive");
assert.equal(manualOnly[0]?.option.amountMode, "exact_output");
assert.equal(manualOnly[0]?.option.ingress?.destinationAddress, ADDRESS);
assert.equal(manualOnly[0]?.option.ingress?.requestedAmount?.raw, "3000000");
assert.equal(manualOnly[0]?.option.ingress?.amountSemantics, "minimum");
assert.equal(manualOnly[0]?.option.safeLabel, "Deposit crypto");
assert.equal(manualOnly[0]?.option.recommended, true);
assert.equal(
  manualOnly[0]?.commitPlan.operation.initialState.status,
  "awaiting_external_funds",
);
assert.equal(manualOnly[0]?.commitPlan.steps.length, 0);
assert.deepEqual(
  manualOnly[0]?.commitPlan.reservations.map((reservation) => ({
    mode: reservation.mode,
    locationId: reservation.locationId,
    rawAmount: reservation.rawAmount,
  })),
  [
    {
      mode: "advisory_destination",
      locationId: "location_direct_ingress_12345678",
      rawAmount: "3000000",
    },
  ],
);
sourceOptionSchema.parse(manualOnly[0]?.option);

const withPrivy = await adapter.list(input(true));
assert.deepEqual(
  withPrivy.map((source) => source.option.kind),
  ["manual_receive", "privy_funding_method"],
);
assert.equal(withPrivy[1]?.option.ingress?.ingressKind, "privy");
assert.equal(withPrivy[1]?.option.recommended, false);
sourceOptionSchema.parse(withPrivy[1]?.option);

console.log(
  "[funding-direct-ingress-source-tests] minimum-target manual Receive and policy-gated Privy handoff passed",
);
