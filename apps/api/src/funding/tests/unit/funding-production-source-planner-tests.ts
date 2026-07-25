#!/usr/bin/env tsx

import assert from "node:assert/strict";

import type { AccountValueReadModel } from "../../../account-value/runtime-service.js";
import { RELAY_PINNED_ASSETS } from "../../../funding-providers/relay/mappings.js";
import type { FundingRuntimePolicy } from "../../policies/funding-policy.js";
import { PRIVY_USER_AUTHORIZED_EVM_SPONSORSHIP_POLICY_ID } from "../../execution/sponsorship-policy.js";
import {
  SOLANA_NATIVE_EXECUTION_RESERVE_LAMPORTS,
  deriveProductionRelayEligibleSourceFacts,
} from "../../planner/production-source-planner.js";

const NOW = "2026-07-24T12:00:00.000Z";
const ACCOUNT_ID = "account_source_planner_12345678";
const BASE_USDC = {
  networkId: "evm:8453",
  assetId: RELAY_PINNED_ASSETS.baseUsdc,
  decimals: 6,
} as const;
const POLYGON_PUSD = {
  networkId: "evm:137",
  assetId: RELAY_PINNED_ASSETS.polygonPusd,
  decimals: 6,
} as const;
const SOLANA_NATIVE = {
  networkId: "solana:mainnet",
  assetId: RELAY_PINNED_ASSETS.solanaNative,
  decimals: 9,
} as const;

function policy(
  overrides: Partial<FundingRuntimePolicy> = {},
): FundingRuntimePolicy {
  return {
    version: 1,
    creationMode: "on",
    gates: {
      quoteCreation: true,
      commit: true,
      startUnsubmittedAction: true,
      emergencyBroadcastPause: false,
      reconciliation: true,
      webhookIngestion: true,
      polling: true,
      refunds: true,
      recovery: true,
      workerDrain: true,
      withdrawalRegistration: false,
      withdrawalExecution: false,
    },
    headline: {
      mode: "liquid_only",
      userOverrideEnabled: false,
      referencedByExecutableLiquidity: false,
    },
    tradingWallet: {
      selectionScope: "current_intent",
      rememberedSelectionEnabled: false,
    },
    automation: { automaticRebalance: false, stagedContinuation: false },
    placement: {
      requireExplicitNoTradeDestinationSelection: true,
      maximumBufferBps: 0,
      maximumBufferUsd: "0",
      maximumSlippageBps: 100,
      maximumFeeUsd: "10",
      maximumFeeBps: 2000,
      warningFeeUsd: "5",
      warningFeeBps: 1000,
      minimumDestinationUsd: "1",
    },
    routeExperience: {
      maximumInlineP95Ms: 45_000,
      minimumInlineSuccessBps: 9500,
      minimumInlineObservationCount: 20,
    },
    ttl: {
      collectorMs: 60_000,
      priceMs: 60_000,
      quoteMs: 30_000,
      pollingMs: 15_000,
      reservationMs: 300_000,
    },
    assets: [],
    locations: [
      {
        locationPatternId: "wallet_base_usdc",
        locationKind: "wallet",
        ownership: "owned",
        observable: true,
        capabilities: ["observe", "value", "execution_source"],
        asset: BASE_USDC,
        enabled: true,
        policyVersion: 1,
      },
    ],
    venues: [],
    providers: [
      {
        providerId: "relay",
        enabled: true,
        enabledCapabilities: ["cross_network_swap"],
      },
    ],
    routes: [
      {
        routeId: "base-usdc-to-polygon-pusd",
        enabled: true,
        providerId: "relay",
        capability: "cross_network_swap",
        adapterId: "relay_quote_v2",
        adapterVersion: 1,
        sourceLocationPatternId: "wallet_base_usdc",
        destinationLocationPatternId: "venue_polymarket_pusd",
        sourceAsset: BASE_USDC,
        destinationAsset: POLYGON_PUSD,
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
    privyFundingMethods: [],
    walletPreparation: [],
    positionActions: [],
    genericAddFundsRecommendationOrder: [],
    ...overrides,
  } as FundingRuntimePolicy;
}

function account(
  input: {
    internal?: boolean;
    preference?: "ask" | "suggest" | "never_suggest";
    availableRaw?: string;
  } = {},
): AccountValueReadModel {
  const internal = input.internal ?? true;
  const walletId = "wallet_source_planner_12345678";
  const componentId = "component_source_planner_12345678";
  const location = {
    kind: "wallet",
    locationId: "location_source_planner_12345678",
    accountId: ACCOUNT_ID,
    asset: BASE_USDC,
    details: {
      walletId,
      address: "0x0000000000000000000000000000000000000001",
    },
  } as const;
  const component = {
    componentId,
    location,
    amount: { asset: BASE_USDC, raw: "5000000" },
    category: "cash",
    estimatedUsd: {
      value: "5",
      asOf: NOW,
      priceSource: "exact_stable",
      confidence: "high",
      policyId: "exact_stable",
    },
    observedAt: NOW,
    observationFreshness: "fresh",
    observationError: null,
    valuationEligibility: "included",
    executionEligibility: "eligible",
    reasonCodes: [],
  } as const;
  return {
    projection: {
      accountId: ACCOUNT_ID,
      liquidAssetsEstimatedUsd: "5",
      positionsEstimatedUsd: "0",
      totalPortfolioEstimatedUsd: "5",
      headlineMode: "liquid_only",
      positionValuationCompleteness: "complete",
      positionValuationFreshness: "fresh",
      cashEstimatedUsd: "5",
      tokenEstimatedUsd: "0",
      inTransitEstimatedUsd: "0",
      valuationCompleteness: "complete",
      valuationFreshness: "fresh",
      collectorErrors: [],
      unpricedAssetCount: 0,
      asOf: NOW,
      components: [component],
      positionComponents: [],
    },
    headline: {
      mode: "liquid_only",
      label: "Estimated assets",
      estimatedUsd: "5",
      completeness: "complete",
      freshness: "fresh",
    },
    cashAvailability: {
      cashAvailableEstimatedUsd: "4",
      byVenueEstimatedUsd: {},
      completeness: "complete",
      freshness: "fresh",
      collectorErrors: [],
      components: [
        {
          componentId,
          venueId: null,
          venueBindingId: null,
          amount: component.amount,
          lockedRaw: "500000",
          reservedRaw: "250000",
          submittedDebitRaw: "250000",
          availableRaw: input.availableRaw ?? "4000000",
          availableEstimatedUsd: "4",
          asOf: NOW,
          freshness: "fresh",
          reasonCodes: [],
        },
      ],
      asOf: NOW,
    },
    venues: {},
    policy: {
      creationMode: "on",
      revision: "policy_source_planner_12345678",
      source: "db",
      invalidStoredPolicy: false,
    },
    runtimePolicy: policy(),
    ownershipEvidenceRevision: "ownership_source_planner_12345678",
    ownership: {
      accountId: ACCOUNT_ID,
      wallets: [
        {
          walletId,
          networkId: BASE_USDC.networkId,
          address: location.details.address,
          source: internal ? "embedded" : "external",
          signingModes: internal
            ? ["web_client", "privy_authorization"]
            : ["web_client"],
          serverWalletRef: internal ? "privy_wallet_source_12345678" : null,
          sponsorshipPolicyIds: internal
            ? [PRIVY_USER_AUTHORIZED_EVM_SPONSORSHIP_POLICY_ID]
            : [],
        },
      ],
      venueBindings: [],
      evidenceRevision: "ownership_source_planner_12345678",
      asOf: NOW,
    },
    duplicateAssetObservationCount: 0,
    assetPreferences: {
      [componentId]: {
        componentId,
        userId: ACCOUNT_ID,
        preference: input.preference ?? "ask",
        createdAt: new Date(NOW),
        updatedAt: new Date(NOW),
      },
    },
  } as unknown as AccountValueReadModel;
}

const sponsored = deriveProductionRelayEligibleSourceFacts({
  accountId: ACCOUNT_ID,
  account: account(),
  policy: policy(),
  requiredAmount: { asset: POLYGON_PUSD, raw: "3000000" },
});
assert.equal(sponsored.length, 1);
assert.equal(sponsored[0]?.quoteInputAmount.raw, "3030304");
assert.equal(sponsored[0]?.quoteMinimumOutput?.raw, "3000000");
assert.equal(sponsored[0]?.maximumSourceRaw, "4000000");
assert.equal(sponsored[0]?.nativeGasReady, true);

const externalWalletIsNotADefaultSource =
  deriveProductionRelayEligibleSourceFacts({
    accountId: ACCOUNT_ID,
    account: account({ internal: false }),
    policy: policy(),
    requiredAmount: { asset: POLYGON_PUSD, raw: "3000000" },
  });
assert.equal(externalWalletIsNotADefaultSource.length, 0);

const excludedByPreference = deriveProductionRelayEligibleSourceFacts({
  accountId: ACCOUNT_ID,
  account: account({ preference: "never_suggest" }),
  policy: policy(),
  requiredAmount: { asset: POLYGON_PUSD, raw: "3000000" },
});
assert.equal(excludedByPreference.length, 0);

{
  const nativePolicy = policy({
    assets: [
      {
        asset: SOLANA_NATIVE,
        enabled: true,
        observationEnabled: true,
        valuationEnabled: false,
        pricePolicyId: null,
      },
    ],
    locations: [
      {
        locationPatternId: "wallet_solana_native",
        locationKind: "wallet",
        ownership: "owned",
        observable: true,
        capabilities: ["observe", "value", "execution_source"],
        asset: SOLANA_NATIVE,
        enabled: true,
      },
    ],
    routes: [
      {
        ...policy().routes[0],
        routeId: "solana-sol-to-polygon-pusd",
        sourceLocationPatternId: "wallet_solana_native",
        sourceAsset: SOLANA_NATIVE,
        actionValidatorId: "relay_svm_action_v1",
        networkExecutorId: "wallet_profile_svm_v1",
        fixtureIds: ["relay_wallet_solana_native_to_pusd_quote_live"],
      },
    ],
  });
  const base = account();
  const location = {
    kind: "wallet",
    locationId: "location_solana_native_12345678",
    accountId: ACCOUNT_ID,
    asset: SOLANA_NATIVE,
    details: {
      walletId: "wallet_solana_native_12345678",
      address: "78Hpb2CbmvW2Gp2aJGZec8nphXdqtRdfjPwwLfxKgo6t",
    },
  } as const;
  const nativeComponent = {
    ...base.projection.components[0],
    componentId: "component_solana_native_12345678",
    location,
    amount: { asset: SOLANA_NATIVE, raw: "20000000" },
    category: "cash",
    estimatedUsd: null,
    valuationEligibility: "unpriced",
    executionEligibility: "unknown",
    reasonCodes: ["trusted_price_unavailable"],
  } as const;
  const nativeAccount = {
    ...base,
    projection: { ...base.projection, components: [nativeComponent] },
    cashAvailability: {
      ...base.cashAvailability,
      freshness: "stale",
      components: [
        {
          ...base.cashAvailability.components[0],
          componentId: nativeComponent.componentId,
          amount: nativeComponent.amount,
          availableRaw: "20000000",
          availableEstimatedUsd: null,
          freshness: "stale",
          reasonCodes: ["trusted_price_unavailable"],
        },
      ],
    },
    runtimePolicy: nativePolicy,
    ownership: {
      ...base.ownership,
      wallets: [
        {
          walletId: location.details.walletId,
          networkId: "solana:mainnet",
          address: location.details.address,
          source: "embedded",
          signingModes: ["web_client"],
          serverWalletRef: null,
          sponsorshipPolicyIds: [],
        },
      ],
    },
    assetPreferences: {},
  } as unknown as AccountValueReadModel;
  const nativeFacts = deriveProductionRelayEligibleSourceFacts({
    accountId: ACCOUNT_ID,
    account: nativeAccount,
    policy: nativePolicy,
    requiredAmount: { asset: POLYGON_PUSD, raw: "1000000" },
  });
  assert.equal(nativeFacts.length, 1);
  assert.equal(
    nativeFacts[0]?.quoteInputAmount.raw,
    (20_000_000n - SOLANA_NATIVE_EXECUTION_RESERVE_LAMPORTS).toString(),
  );
  assert.equal(nativeFacts[0]?.quoteMinimumOutput?.raw, "1000000");
  assert.equal(nativeFacts[0]?.maximumSourceRaw, "17000000");
  assert.equal(nativeFacts[0]?.safeLabel, "SOL on Solana");
  assert.equal(nativeFacts[0]?.nativeGasReady, true);
}

const originalRoute = policy().routes[0];
assert.ok(originalRoute);
const duplicateRoutePolicy = policy({
  routes: [...policy().routes, { ...originalRoute, routeId: "duplicate" }],
});
assert.equal(
  deriveProductionRelayEligibleSourceFacts({
    accountId: ACCOUNT_ID,
    account: account(),
    policy: duplicateRoutePolicy,
    requiredAmount: { asset: POLYGON_PUSD, raw: "3000000" },
  }).length,
  0,
);

assert.equal(
  deriveProductionRelayEligibleSourceFacts({
    accountId: "foreign_account_12345678",
    account: account(),
    policy: policy(),
    requiredAmount: { asset: POLYGON_PUSD, raw: "3000000" },
  }).length,
  0,
);

assert.equal(
  deriveProductionRelayEligibleSourceFacts({
    accountId: ACCOUNT_ID,
    account: account(),
    policy: policy(),
    requiredAmount: { asset: POLYGON_PUSD, raw: "3000000" },
    purpose: "withdrawal",
  }).length,
  0,
);
const withdrawalPolicy = policy({
  locations: policy().locations.map((location) => ({
    ...location,
    capabilities: [...location.capabilities, "withdrawal_source"],
  })),
});
assert.equal(
  deriveProductionRelayEligibleSourceFacts({
    accountId: ACCOUNT_ID,
    account: account(),
    policy: withdrawalPolicy,
    requiredAmount: { asset: POLYGON_PUSD, raw: "3000000" },
    purpose: "withdrawal",
  }).length,
  1,
);

console.log(
  "[funding-production-source-planner-tests] source availability, sponsorship, withdrawal capability, preference, route uniqueness, and ownership passed",
);
