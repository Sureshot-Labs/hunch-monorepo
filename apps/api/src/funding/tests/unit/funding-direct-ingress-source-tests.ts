#!/usr/bin/env tsx

import assert from "node:assert/strict";

import type { AccountValueReadModel } from "../../../account-value/runtime-service.js";
import { sourceOptionSchema } from "../../../schemas/funding.js";
import { PRIVY_USER_AUTHORIZED_EVM_SPONSORSHIP_POLICY_ID } from "../../execution/sponsorship-policy.js";
import { DirectIngressFundingSourceAdapter } from "../../planner/direct-ingress-source-adapter.js";
import type { FundingSourcePlanningInput } from "../../planner/source-adapter.js";
import type { FundingRuntimePolicy } from "../../policies/funding-policy.js";
import { polymarketFundingEvidence } from "../../preparation/polymarket-funding-snapshot.js";

const NOW = new Date("2026-07-24T12:00:00.000Z");
const ASSET = {
  networkId: "evm:137",
  assetId: "0x0000000000000000000000000000000000000001",
  decimals: 6,
} as const;
const ADDRESS = "0x0000000000000000000000000000000000000002";
const SIGNER = "0x0000000000000000000000000000000000000003";
const ROUTER = "0x0000000000000000000000000000000000000004";
const USDCE = {
  networkId: "evm:137",
  assetId: "0x0000000000000000000000000000000000000005",
  decimals: 6,
} as const;
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
    automation: {
      automaticRebalance: false,
      stagedContinuation: true,
    },
    assets: [
      {
        asset: ASSET,
        enabled: true,
        observationEnabled: true,
        valuationEnabled: true,
        pricePolicyId: "usd_stable",
      },
      {
        asset: USDCE,
        enabled: true,
        observationEnabled: true,
        valuationEnabled: true,
        pricePolicyId: "usd_stable",
      },
    ],
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

function input(
  privyEnabled: boolean,
  purpose: FundingSourcePlanningInput["request"]["purpose"] = "add_funds",
  multiAsset = false,
): FundingSourcePlanningInput {
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
      purpose,
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
      option: {
        venueId: "polymarket",
        destinationOptionId: "destination_direct_ingress_12345678",
        requiredAsset: ASSET,
      } as never,
      bindingOption: BINDING_OPTION,
      target,
      availableNow: { asset: ASSET, raw: "1000000" },
      preparationActions: [],
      completeness: "complete",
      freshness: "fresh",
      venueBinding: {
        bindingId: "binding_direct_ingress_12345678",
        venueId: "polymarket",
        controllerWalletId: "wallet_direct_ingress_12345678",
        executionWalletId: "wallet_direct_ingress_12345678",
        accountRef: ADDRESS,
        settlementLocation: target.location,
        signingMode: "privy_authorization",
      },
      sourcePlanningEvidence: multiAsset
        ? polymarketFundingEvidence({
            signerAddress: SIGNER,
            depositWallet: ADDRESS,
            depositPusdRaw: "1000000",
            depositLockedRaw: "0",
            depositUsdceRaw: "500000",
            signerPusdRaw: "0",
            signerUsdceRaw: "0",
            // A generic UI funding snapshot has no delegated bot-policy cap.
            // The committed ingress operation supplies its own exact bound.
            fundingCapRaw: "0",
            routerAddress: ROUTER,
            routerNonceRaw: "7",
            depositRouterUsdceAllowanceRaw: "5000000",
            routerPusdAllowanceRaw: "0",
            routerUsdceAllowanceRaw: "0",
            clobPusdRaw: "1000000",
            observedAt: NOW.toISOString(),
          })
        : null,
    },
    destination: {
      destinationId: "destination_direct_ingress_12345678",
      destinationLocationPatternId: "polymarket-venue-cash-v1",
      target,
      requiredAsset: ASSET,
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

const tradeShortfall = await adapter.list(input(true, "trade_shortfall"));
assert.deepEqual(tradeShortfall, []);

const account = {
  ownership: {
    wallets: [
      {
        walletId: "wallet_direct_ingress_12345678",
        networkId: "evm:137",
        address: SIGNER,
        source: "embedded",
        signingModes: ["web_client", "privy_authorization"],
        serverWalletRef: "privy_direct_ingress_12345678",
        sponsorshipPolicyIds: [PRIVY_USER_AUTHORIZED_EVM_SPONSORSHIP_POLICY_ID],
      },
    ],
  },
} as unknown as AccountValueReadModel;
const multiAssetAdapter = new DirectIngressFundingSourceAdapter(account, {
  canonicalRouterAddress: ROUTER,
  usdceAsset: USDCE,
});
const [multiAsset] = await multiAssetAdapter.list(
  input(false, "add_funds", true),
);
assert.ok(multiAsset);
assert.deepEqual(
  multiAsset.option.ingress?.receiveTargets?.[0]?.acceptedAssets.map(
    (accepted) => ({
      assetId: accepted.asset.assetId,
      handling: accepted.handling,
    }),
  ),
  [
    { assetId: ASSET.assetId, handling: "direct" },
    { assetId: USDCE.assetId, handling: "automatic_conversion" },
  ],
);
assert.equal(multiAsset.commitPlan.steps[0]?.state, "planned");
assert.equal(multiAsset.commitPlan.steps[0]?.stepKind, "venue_preparation");
assert.equal(multiAsset.commitPlan.reservations.length, 2);
assert.equal(
  multiAsset.commitPlan.operation.supportMetadata?.preparationKind,
  "polymarket_funding_router",
);
sourceOptionSchema.parse(multiAsset.option);

console.log(
  "[funding-direct-ingress-source-tests] minimum-target ingress, Polygon pUSD/USDC.e variants, committed follow-up, Privy gating, and trade-shortfall isolation passed",
);
