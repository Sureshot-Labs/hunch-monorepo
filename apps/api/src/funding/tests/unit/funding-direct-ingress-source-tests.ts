#!/usr/bin/env tsx

import assert from "node:assert/strict";

import type { AccountValueReadModel } from "../../../account-value/runtime-service.js";
import { RELAY_PINNED_ASSETS } from "../../../funding-providers/relay/mappings.js";
import { sourceOptionSchema } from "../../../schemas/funding.js";
import { PRIVY_USER_AUTHORIZED_EVM_SPONSORSHIP_POLICY_ID } from "../../execution/sponsorship-policy.js";
import { DirectIngressFundingSourceAdapter } from "../../planner/direct-ingress-source-adapter.js";
import type { FundingSourcePlanningInput } from "../../planner/source-adapter.js";
import type { FundingRuntimePolicy } from "../../policies/funding-policy.js";
import { compileFundingIntentPolicy } from "../../policies/funding-policy-v2.js";
import { polymarketFundingEvidence } from "../../preparation/polymarket-funding-snapshot.js";

const NOW = new Date("2026-07-24T12:00:00.000Z");
const ASSET = {
  networkId: "evm:137",
  assetId: RELAY_PINNED_ASSETS.polygonPusd,
  decimals: 6,
} as const;
const ADDRESS = "0x0000000000000000000000000000000000000002";
const SIGNER = "0x0000000000000000000000000000000000000003";
const ROUTER = "0x0000000000000000000000000000000000000004";
const USDCE = {
  networkId: "evm:137",
  assetId: RELAY_PINNED_ASSETS.polygonUsdce,
  decimals: 6,
} as const;
const POLYGON_USDC = {
  networkId: "evm:137",
  assetId: RELAY_PINNED_ASSETS.polygonUsdc,
  decimals: 6,
} as const;
const BASE_USDC = {
  networkId: "evm:8453",
  assetId: RELAY_PINNED_ASSETS.baseUsdc,
  decimals: 6,
} as const;
const SOLANA_USDC = {
  networkId: "solana:mainnet",
  assetId: RELAY_PINNED_ASSETS.solanaUsdc,
  decimals: 6,
} as const;
const SOLANA_NATIVE = {
  networkId: "solana:mainnet",
  assetId: RELAY_PINNED_ASSETS.solanaNative,
  decimals: 9,
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
        locationPatternId: "wallet_polygon_pusd",
        locationKind: "wallet",
        ownership: "owned",
        observable: true,
        capabilities: ["observe", "execution_source"],
        asset: ASSET,
        enabled: true,
        policyVersion: 1,
      },
      {
        locationPatternId: "wallet_polygon_usdce",
        locationKind: "wallet",
        ownership: "owned",
        observable: true,
        capabilities: ["observe", "execution_source"],
        asset: USDCE,
        enabled: true,
        policyVersion: 1,
      },
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

const v2Input = input(false, "add_funds", true);
const [nativePolygonOnly] = await multiAssetAdapter.list({
  ...v2Input,
  policy: compileFundingIntentPolicy({
    version: 2,
    venues: ["polymarket"],
    receive: { assets: ["polygon:usdc"], privy: false },
    paused: false,
  }),
});
assert.ok(nativePolygonOnly);
assert.deepEqual(
  nativePolygonOnly.option.ingress?.receiveTargets?.flatMap((target) =>
    target.acceptedAssets.map((accepted) => accepted.asset),
  ),
  [POLYGON_USDC],
  "compact receive aliases must be an exact allowlist",
);

assert.deepEqual(
  await multiAssetAdapter.list({
    ...v2Input,
    policy: compileFundingIntentPolicy({
      version: 2,
      venues: ["polymarket"],
      receive: { assets: [], privy: false },
      paused: false,
    }),
  }),
  [],
  "a venue alone must not create an unselected receive target",
);

const privyOnly = await multiAssetAdapter.list({
  ...v2Input,
  policy: compileFundingIntentPolicy({
    version: 2,
    venues: ["polymarket"],
    receive: { assets: [], privy: true },
    paused: false,
  }),
});
assert.deepEqual(
  privyOnly.map((source) => source.option.kind),
  ["privy_funding_method"],
);
assert.deepEqual(
  privyOnly[0]?.option.ingress?.receiveTargets?.flatMap((target) =>
    target.acceptedAssets.map((accepted) => accepted.asset),
  ),
  [ASSET],
);

const baseAddress = "0x0000000000000000000000000000000000000006";
const unprovenCrossNetworkInput = input(false, "add_funds", true);
const unprovenCrossNetworkAccount = {
  ownership: {
    wallets: [
      ...(account.ownership?.wallets ?? []),
      {
        walletId: "wallet_base_receive_12345678",
        networkId: "evm:8453",
        address: baseAddress,
        source: "embedded",
        signingModes: ["web_client", "privy_authorization"],
        serverWalletRef: "privy_base_receive_12345678",
        sponsorshipPolicyIds: [PRIVY_USER_AUTHORIZED_EVM_SPONSORSHIP_POLICY_ID],
      },
    ],
  },
  projection: {
    asOf: NOW.toISOString(),
    components: [
      {
        componentId: "component_base_receive_12345678",
        amount: { asset: BASE_USDC, raw: "0" },
        location: {
          kind: "wallet",
          locationId: "location_base_receive_12345678",
          accountId: "account_direct_ingress_12345678",
          asset: BASE_USDC,
          details: {
            address: baseAddress,
            walletId: "wallet_base_receive_12345678",
          },
        },
        observedAt: NOW.toISOString(),
        observationFreshness: "fresh",
        observationError: null,
        category: "cash",
      },
    ],
  },
} as unknown as AccountValueReadModel;
const inputWithUnprovenBaseRoute = {
  ...unprovenCrossNetworkInput,
  policy: {
    ...unprovenCrossNetworkInput.policy,
    routes: [
      {
        routeId: "base-usdc-to-polygon-pusd",
        enabled: true,
        providerId: "relay",
        capability: "cross_network_swap",
        adapterId: "relay_quote_v2",
        adapterVersion: 1,
        sourceLocationPatternId: "wallet_base_usdc",
        sourceAsset: BASE_USDC,
        destinationAsset: ASSET,
        destinationLocationPatternId: "polymarket-venue-cash-v1",
        fixtureIds: ["relay_wallet_evm_roundtrip_live"],
        actionValidatorId: "relay_evm_action_v1",
        networkExecutorId: "wallet_profile_evm_v1",
        reconcilerId: "relay_status_v3",
        refundSemanticsId: "relay_owned_refund_observation_v1",
        destinationObserverId: "relay_owned_destination_observation_v1",
        experienceMode: "prepare_first",
        measuredObservationCount: 0,
        minimumInlineObservationCount: 20,
        fallbackKind: null,
        depositAddress: null,
      },
    ],
  },
} as FundingSourcePlanningInput;
const [failClosedIngress] = await new DirectIngressFundingSourceAdapter(
  unprovenCrossNetworkAccount,
  {
    canonicalRouterAddress: ROUTER,
    usdceAsset: USDCE,
  },
).list(inputWithUnprovenBaseRoute);
assert.ok(failClosedIngress);
assert.deepEqual(
  failClosedIngress.option.ingress?.receiveTargets?.map(
    (target) => target.networkId,
  ),
  ["evm:137"],
  "a Relay route and aggregate wallet balance must not activate cross-network receive without one exact owned source-location policy",
);

const provenBaseRouteInput = {
  ...inputWithUnprovenBaseRoute,
  policy: {
    ...inputWithUnprovenBaseRoute.policy,
    locations: [
      ...inputWithUnprovenBaseRoute.policy.locations,
      {
        locationPatternId: "wallet_base_usdc",
        locationKind: "wallet",
        ownership: "owned",
        observable: true,
        capabilities: ["observe", "execution_source"],
        asset: BASE_USDC,
        enabled: true,
        policyVersion: 1,
      },
    ],
  },
} as FundingSourcePlanningInput;
const [provenBaseIngress] = await new DirectIngressFundingSourceAdapter(
  unprovenCrossNetworkAccount,
  {
    canonicalRouterAddress: ROUTER,
    usdceAsset: USDCE,
  },
).list(provenBaseRouteInput);
assert.ok(provenBaseIngress);
assert.deepEqual(
  provenBaseIngress.option.ingress?.receiveTargets?.map((target) => ({
    networkId: target.networkId,
    assets: target.acceptedAssets.map((accepted) => ({
      assetId: accepted.asset.assetId,
      handling: accepted.handling,
    })),
  })),
  [
    {
      networkId: "evm:137",
      assets: [
        { assetId: ASSET.assetId, handling: "direct" },
        { assetId: USDCE.assetId, handling: "automatic_conversion" },
      ],
    },
    {
      networkId: "evm:8453",
      assets: [
        {
          assetId: BASE_USDC.assetId,
          handling: "automatic_conversion",
        },
      ],
    },
  ],
);
assert.deepEqual(
  (
    provenBaseIngress.commitPlan.operation.supportMetadata
      ?.ingressVariants as readonly Readonly<{ networkId: string }>[]
  ).map((variant) => variant.networkId),
  ["evm:137", "evm:137"],
  "the exact legacy funding operation must not absorb amount-free child-operation variants",
);
assert.deepEqual(
  (
    provenBaseIngress.commitPlan.operation.supportMetadata
      ?.receiveSessionVariants as readonly Readonly<{ networkId: string }>[]
  ).map((variant) => variant.networkId),
  ["evm:137", "evm:137", "evm:8453"],
);

const solanaAddress = "9xQeWvG816bUx9EPfB1G6QxgXLKWMuD5YpLQwJwN6JY";
const provenSolanaAccount = {
  ...unprovenCrossNetworkAccount,
  ownership: {
    wallets: [
      ...(unprovenCrossNetworkAccount.ownership?.wallets ?? []),
      {
        walletId: "wallet_solana_receive_12345678",
        networkId: "solana:mainnet",
        address: solanaAddress,
        source: "embedded",
        signingModes: ["web_client", "privy_authorization"],
        serverWalletRef: "privy_solana_receive_12345678",
        sponsorshipPolicyIds: [],
      },
    ],
  },
  projection: {
    ...unprovenCrossNetworkAccount.projection,
    components: [
      ...(unprovenCrossNetworkAccount.projection?.components ?? []),
      {
        componentId: "component_solana_usdc_receive_12345678",
        amount: { asset: SOLANA_USDC, raw: "1849838" },
        location: {
          kind: "wallet",
          locationId: "location_solana_usdc_receive_12345678",
          accountId: "account_direct_ingress_12345678",
          asset: SOLANA_USDC,
          details: {
            address: solanaAddress,
            walletId: "wallet_solana_receive_12345678",
          },
        },
        observedAt: NOW.toISOString(),
        observationFreshness: "fresh",
        observationError: null,
        category: "cash",
      },
      {
        componentId: "component_solana_native_receive_12345678",
        amount: { asset: SOLANA_NATIVE, raw: "32392013" },
        location: {
          kind: "wallet",
          locationId: "location_solana_native_receive_12345678",
          accountId: "account_direct_ingress_12345678",
          asset: SOLANA_NATIVE,
          details: {
            address: solanaAddress,
            walletId: "wallet_solana_receive_12345678",
          },
        },
        observedAt: NOW.toISOString(),
        observationFreshness: "fresh",
        observationError: null,
        category: "cash",
      },
    ],
  },
} as unknown as AccountValueReadModel;
const provenSolanaRouteInput = {
  ...provenBaseRouteInput,
  policy: {
    ...provenBaseRouteInput.policy,
    locations: [
      ...provenBaseRouteInput.policy.locations,
      {
        locationPatternId: "wallet_solana_usdc",
        locationKind: "wallet",
        ownership: "owned",
        observable: true,
        capabilities: ["observe", "execution_source"],
        asset: SOLANA_USDC,
        enabled: true,
        policyVersion: 1,
      },
      {
        locationPatternId: "wallet_solana_native",
        locationKind: "wallet",
        ownership: "owned",
        observable: true,
        capabilities: ["observe", "execution_source"],
        asset: SOLANA_NATIVE,
        enabled: true,
        policyVersion: 1,
      },
    ],
    routes: [
      ...provenBaseRouteInput.policy.routes,
      {
        routeId: "solana-usdc-to-polygon-pusd",
        enabled: true,
        providerId: "relay",
        capability: "cross_network_swap",
        adapterId: "relay_quote_v2",
        adapterVersion: 1,
        sourceLocationPatternId: "wallet_solana_usdc",
        sourceAsset: SOLANA_USDC,
        destinationAsset: ASSET,
        destinationLocationPatternId: "polymarket-venue-cash-v1",
        fixtureIds: ["relay_solana_usdc_roundtrip_live"],
        actionValidatorId: "relay_solana_action_v1",
        networkExecutorId: "wallet_profile_solana_v1",
        reconcilerId: "relay_status_v3",
        refundSemanticsId: "relay_owned_refund_observation_v1",
        destinationObserverId: "relay_owned_destination_observation_v1",
        experienceMode: "prepare_first",
        measuredObservationCount: 0,
        minimumInlineObservationCount: 20,
        fallbackKind: null,
        depositAddress: null,
      },
      {
        routeId: "solana-sol-to-polygon-pusd",
        enabled: true,
        providerId: "relay",
        capability: "cross_network_swap",
        adapterId: "relay_quote_v2",
        adapterVersion: 1,
        sourceLocationPatternId: "wallet_solana_native",
        sourceAsset: SOLANA_NATIVE,
        destinationAsset: ASSET,
        destinationLocationPatternId: "polymarket-venue-cash-v1",
        fixtureIds: ["relay_wallet_solana_native_to_pusd_quote_live"],
        actionValidatorId: "relay_solana_action_v1",
        networkExecutorId: "wallet_profile_solana_v1",
        reconcilerId: "relay_status_v3",
        refundSemanticsId: "relay_owned_refund_observation_v1",
        destinationObserverId: "relay_owned_destination_observation_v1",
        experienceMode: "prepare_first",
        measuredObservationCount: 0,
        minimumInlineObservationCount: 20,
        fallbackKind: null,
        depositAddress: null,
      },
    ],
  },
} as FundingSourcePlanningInput;
const [stableOnlySolanaIngress] = await new DirectIngressFundingSourceAdapter(
  provenSolanaAccount,
  {
    canonicalRouterAddress: ROUTER,
    usdceAsset: USDCE,
  },
).list({
  ...provenSolanaRouteInput,
  policy: {
    ...provenSolanaRouteInput.policy,
    routes: provenSolanaRouteInput.policy.routes.filter(
      (route) => route.sourceAsset.assetId !== SOLANA_NATIVE.assetId,
    ),
  },
});
assert.deepEqual(
  stableOnlySolanaIngress?.option.ingress?.receiveTargets
    ?.find((target) => target.networkId === "solana:mainnet")
    ?.acceptedAssets.map((accepted) => accepted.asset.assetId),
  [SOLANA_USDC.assetId],
  "native SOL must remain hidden unless its exact owned route is enabled",
);
const [provenSolanaIngress] = await new DirectIngressFundingSourceAdapter(
  provenSolanaAccount,
  {
    canonicalRouterAddress: ROUTER,
    usdceAsset: USDCE,
  },
).list(provenSolanaRouteInput);
assert.ok(provenSolanaIngress);
assert.deepEqual(
  (
    provenSolanaIngress.commitPlan.operation.supportMetadata
      ?.receiveSessionVariants as readonly Readonly<{
      networkId: string;
      asset: { assetId: string };
      observation: {
        adapterId: string;
        payload: Readonly<Record<string, unknown>>;
      };
    }>[]
  )
    .filter((variant) => variant.networkId === "solana:mainnet")
    .map((variant) => ({
      assetId: variant.asset.assetId,
      adapterId: variant.observation.adapterId,
      balanceKey: variant.observation.payload.balanceKey,
    })),
  [
    {
      assetId: SOLANA_USDC.assetId,
      adapterId: "owned_wallet_liquid_balances_v1",
      balanceKey: `solana:mainnet:${SOLANA_USDC.assetId}:6`,
    },
    {
      assetId: SOLANA_NATIVE.assetId,
      adapterId: "owned_wallet_liquid_balances_v1",
      balanceKey: `solana:mainnet:${SOLANA_NATIVE.assetId}:9`,
    },
  ],
  "positive routed inventory must be re-read from its owned source wallet instead of destination spendability",
);
assert.deepEqual(
  provenSolanaIngress.option.ingress?.receiveTargets
    ?.find((target) => target.networkId === "solana:mainnet")
    ?.acceptedAssets.map((accepted) => ({
      assetId: accepted.asset.assetId,
      handling: accepted.handling,
    })),
  [
    {
      assetId: SOLANA_USDC.assetId,
      handling: "automatic_conversion",
    },
    {
      assetId: SOLANA_NATIVE.assetId,
      handling: "review_required",
    },
  ],
);

const baseTarget = {
  kind: "owned_location" as const,
  location: {
    kind: "venue_account",
    locationId: "location_limitless_receive_12345678",
    accountId: "account_direct_ingress_12345678",
    asset: BASE_USDC,
    details: { address: baseAddress, venueId: "limitless" },
  },
};
const baseTemplate = input(false);
const baseSpendability = {
  ...baseTemplate.destination.spendability,
  observedAmount: { asset: BASE_USDC, raw: "0" },
  availableAmount: { asset: BASE_USDC, raw: "0" },
  revision: "spendability_limitless_receive_12345678",
};
const baseReceiveInput = {
  ...baseTemplate,
  request: {
    ...baseTemplate.request,
    requestedDestinationAmount: { asset: BASE_USDC, raw: "3000000" },
    destinationOptionId: "destination_limitless_receive_12345678",
    venueBindingOptionId: "binding_option_limitless_receive_12345678",
  },
  destinationFacts: {
    ...baseTemplate.destinationFacts,
    destinationLocationPatternId: "limitless-venue-cash-v1",
    spendability: baseSpendability,
    option: {
      venueId: "limitless",
      destinationOptionId: "destination_limitless_receive_12345678",
      requiredAsset: BASE_USDC,
    },
    target: baseTarget,
    availableNow: { asset: BASE_USDC, raw: "0" },
    venueBinding: {
      ...baseTemplate.destinationFacts?.venueBinding,
      bindingId: "binding_limitless_receive_12345678",
      venueId: "limitless",
      executionWalletId: "wallet_base_receive_12345678",
      controllerWalletId: "wallet_base_receive_12345678",
      accountRef: baseAddress,
      settlementLocation: baseTarget.location,
    },
    sourcePlanningEvidence: null,
  },
  destination: {
    ...baseTemplate.destination,
    destinationId: "destination_limitless_receive_12345678",
    destinationLocationPatternId: "limitless-venue-cash-v1",
    target: baseTarget,
    requiredAsset: BASE_USDC,
    spendability: baseSpendability,
    venueId: "limitless",
    venueBindingOption: {
      ...BINDING_OPTION,
      venueBindingOptionId: "binding_option_limitless_receive_12345678",
      safeLabel: "Limitless Trading Wallet",
    },
  },
  placement: {
    ...baseTemplate.placement,
    sourceAmount: { asset: BASE_USDC, raw: "3000000" },
    destinationRequirement: { asset: BASE_USDC, raw: "3000000" },
    targetVenueId: "limitless",
    target: baseTarget,
  },
  requiredAmount: { asset: BASE_USDC, raw: "3000000" },
  policy: {
    ...baseTemplate.policy,
    assets: [
      ...baseTemplate.policy.assets,
      {
        asset: BASE_USDC,
        enabled: true,
        observationEnabled: true,
        valuationEnabled: true,
        pricePolicyId: "usd_stable",
      },
    ],
    locations: [
      ...baseTemplate.policy.locations,
      {
        locationPatternId: "wallet_base_usdc",
        locationKind: "wallet",
        ownership: "owned",
        observable: true,
        capabilities: ["observe", "execution_source"],
        asset: BASE_USDC,
        enabled: true,
        policyVersion: 1,
      },
      {
        locationPatternId: "limitless-venue-cash-v1",
        locationKind: "venue_account",
        ownership: "owned",
        observable: true,
        capabilities: ["observe", "venue_settlement"],
        asset: BASE_USDC,
        enabled: true,
        policyVersion: 1,
      },
    ],
  },
} as unknown as FundingSourcePlanningInput;
const [baseReceive] = await adapter.list(baseReceiveInput);
assert.ok(baseReceive);
assert.deepEqual(baseReceive.option.ingress?.receiveTargets, [
  {
    receiveTargetId:
      baseReceive.option.ingress?.receiveTargets?.[0]?.receiveTargetId,
    networkId: "evm:8453",
    destinationAddress: baseAddress,
    acceptedAssets: [
      {
        asset: BASE_USDC,
        handling: "direct",
        senderNativeFeeRequirement: null,
      },
    ],
    safeInstructions: [
      "Use only this network and one listed asset.",
      "You can send any amount.",
      "Do not mix different assets in one transfer.",
    ],
  },
]);

console.log(
  "[funding-direct-ingress-source-tests] minimum-target ingress, Polygon pUSD/USDC.e, Base USDC, Solana USDC/native SOL canonical variants, exact-route fail-closed gating, committed follow-up, Privy gating, and trade-shortfall isolation passed",
);
