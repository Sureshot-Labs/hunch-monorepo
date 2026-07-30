#!/usr/bin/env tsx

import assert from "node:assert/strict";

import type { AccountValueReadModel } from "../../../account-value/runtime-service.js";
import { RELAY_PINNED_ASSETS } from "../../../funding-providers/relay/mappings.js";
import type { FundingRuntimePolicy } from "../../policies/funding-policy.js";
import { PRIVY_USER_AUTHORIZED_EVM_SPONSORSHIP_POLICY_ID } from "../../execution/sponsorship-policy.js";
import {
  SOLANA_NATIVE_EXECUTION_RESERVE_LAMPORTS,
  buildPolymarketPreRouteHandoffSteps,
  deriveProductionRelayEligibleSourceFacts,
} from "../../planner/production-source-planner.js";
import { groupWalletExecutableActions } from "../../planner/evm-action-batching.js";

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
const SOLANA_USDC = {
  networkId: "solana:mainnet",
  assetId: RELAY_PINNED_ASSETS.solanaUsdc,
  decimals: 6,
} as const;

const batchProfile = {
  walletId: "wallet_batch_12345678",
  controllerWalletRef: "controller_wallet_12345678",
  networkId: "evm:137",
  address: "0x1111111111111111111111111111111111111111",
  source: "embedded" as const,
  signingModes: ["web_client", "privy_authorization"] as const,
  serverWalletRef: "privy_wallet_12345678",
  sponsorshipPolicyIds: [PRIVY_USER_AUTHORIZED_EVM_SPONSORSHIP_POLICY_ID],
  evmAtomicBatchMode: "privy_wallet_send_calls" as const,
};
const batchCandidates = [
  {
    kind: "evm_transaction" as const,
    actionId: "action_approve_12345678",
    networkId: "evm:137",
    senderWalletId: batchProfile.walletId,
    to: "0x2222222222222222222222222222222222222222",
    data: "0x01",
    valueRaw: "0",
    gasLimitRaw: "65000",
  },
  {
    kind: "evm_transaction" as const,
    actionId: "action_relay_12345678",
    networkId: "evm:137",
    senderWalletId: batchProfile.walletId,
    to: "0x3333333333333333333333333333333333333333",
    data: "0x02",
    valueRaw: "0",
    gasLimitRaw: "500000",
  },
];
const [atomicGroup] = groupWalletExecutableActions({
  actions: batchCandidates,
  profile: batchProfile,
});
assert.equal(atomicGroup?.action.kind, "evm_transaction_batch");
assert.deepEqual(
  atomicGroup?.action.kind === "evm_transaction_batch"
    ? atomicGroup.action.calls.map((call) => call.actionId)
    : [],
  batchCandidates.map((action) => action.actionId),
);
assert.deepEqual(
  atomicGroup?.sourceActions.map((action) =>
    action.kind === "evm_transaction" ? action.gasLimitRaw : null,
  ),
  batchCandidates.map((action) => action.gasLimitRaw),
);
assert.equal(
  groupWalletExecutableActions({
    actions: batchCandidates,
    profile: { ...batchProfile, evmAtomicBatchMode: null },
  }).length,
  2,
);

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
          controllerWalletRef: "8571f3cb-381e-4e55-8f4c-ecc4c7f2abb9",
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

const exactReceivedSource = deriveProductionRelayEligibleSourceFacts({
  accountId: ACCOUNT_ID,
  account: account(),
  policy: policy(),
  requiredAmount: { asset: POLYGON_PUSD, raw: "1" },
  confirmedSourceAmount: { asset: BASE_USDC, raw: "3000000" },
});
assert.equal(exactReceivedSource.length, 1);
assert.equal(exactReceivedSource[0]?.quoteInputAmount.raw, "3000000");
assert.equal(exactReceivedSource[0]?.quoteMinimumOutput?.raw, "2970000");
assert.equal(exactReceivedSource[0]?.quoteModeOverride, undefined);

const exactInputConversionSource = deriveProductionRelayEligibleSourceFacts({
  accountId: ACCOUNT_ID,
  account: account(),
  policy: policy(),
  requiredAmount: { asset: POLYGON_PUSD, raw: "1" },
  confirmedSourceAmount: { asset: BASE_USDC, raw: "3000000" },
  purpose: "convert_asset",
});
assert.equal(exactInputConversionSource.length, 1);
assert.equal(exactInputConversionSource[0]?.quoteInputAmount.raw, "3000000");
assert.equal(exactInputConversionSource[0]?.quoteMinimumOutput?.raw, "1");
assert.equal(exactInputConversionSource[0]?.quoteModeOverride, "exact_input");

const unavailableExactReceivedSource = deriveProductionRelayEligibleSourceFacts(
  {
    accountId: ACCOUNT_ID,
    account: account(),
    policy: policy(),
    requiredAmount: { asset: POLYGON_PUSD, raw: "1" },
    confirmedSourceAmount: { asset: BASE_USDC, raw: "5000000" },
  },
);
assert.equal(unavailableExactReceivedSource.length, 0);

{
  const base = account();
  const component = base.projection.components[0];
  assert.ok(component);
  const managedVenueLocation = {
    ...component.location,
    kind: "venue_account",
    details: {
      ...component.location.details,
      venueId: "polymarket",
      accountRef: component.location.details.address,
    },
  } as const;
  const managedVenueAccount = {
    ...base,
    projection: {
      ...base.projection,
      components: [{ ...component, location: managedVenueLocation }],
    },
  } as AccountValueReadModel;
  const managedVenueFacts = deriveProductionRelayEligibleSourceFacts({
    accountId: ACCOUNT_ID,
    account: managedVenueAccount,
    policy: policy(),
    requiredAmount: { asset: POLYGON_PUSD, raw: "3000000" },
  });
  assert.equal(managedVenueFacts.length, 1);
  assert.equal(
    managedVenueFacts[0]?.reservationLocationId,
    managedVenueLocation.locationId,
  );
  assert.equal(
    managedVenueFacts[0]?.source.kind === "owned_location"
      ? managedVenueFacts[0].source.location.kind
      : null,
    "wallet",
  );
  assert.equal(
    managedVenueFacts[0]?.source.kind === "owned_location"
      ? managedVenueFacts[0].source.location.details.balanceLocationId
      : null,
    managedVenueLocation.locationId,
  );
}

const connectedExternalWalletSource = deriveProductionRelayEligibleSourceFacts({
  accountId: ACCOUNT_ID,
  account: account({ internal: false }),
  policy: policy(),
  requiredAmount: { asset: POLYGON_PUSD, raw: "3000000" },
  purpose: "trade_shortfall",
});
assert.equal(connectedExternalWalletSource.length, 1);
assert.equal(connectedExternalWalletSource[0]?.safeLabel, "Connected wallet");
assert.equal(connectedExternalWalletSource[0]?.walletExecutionReady, true);
assert.equal(
  connectedExternalWalletSource[0]?.source.kind === "owned_location"
    ? connectedExternalWalletSource[0].source.location.details.walletId
    : null,
  "wallet_source_planner_12345678",
);

{
  const sourceOnly = account();
  const sourceOnlyOwnership = sourceOnly.ownership;
  if (!sourceOnlyOwnership) {
    throw new Error("source-only fixture is missing ownership");
  }
  const sourceOnlyAccount = {
    ...sourceOnly,
    ownership: {
      ...sourceOnlyOwnership,
      wallets: sourceOnlyOwnership.wallets.map((wallet) => ({
        ...wallet,
        source: "smart" as const,
        signingModes: [],
        serverWalletRef: null,
        sponsorshipPolicyIds: [],
      })),
    },
  } as AccountValueReadModel;
  const sourceOnlyFacts = deriveProductionRelayEligibleSourceFacts({
    accountId: ACCOUNT_ID,
    account: sourceOnlyAccount,
    policy: policy(),
    requiredAmount: { asset: POLYGON_PUSD, raw: "3000000" },
  });
  assert.equal(sourceOnlyFacts.length, 1);
  assert.equal(sourceOnlyFacts[0]?.walletExecutionReady, false);
  assert.equal(sourceOnlyFacts[0]?.nativeGasReady, false);
}

{
  const base = account();
  const baseComponent = base.projection.components[0];
  const baseAvailability = base.cashAvailability.components[0];
  const baseEstimatedUsd = baseComponent?.estimatedUsd;
  const baseOwnership = base.ownership;
  assert.ok(baseComponent);
  assert.ok(baseAvailability);
  assert.ok(baseEstimatedUsd);
  assert.ok(baseOwnership);
  const funderWalletId = "wallet_polymarket_funder_12345678";
  const controllerWalletId = "wallet_polymarket_controller_12345678";
  const funderAddress = "0x00000000000000000000000000000000000000f1";
  const controllerAddress = "0x00000000000000000000000000000000000000c1";
  const location = {
    kind: "venue_account",
    locationId: "location_polymarket_funder_12345678",
    accountId: ACCOUNT_ID,
    asset: POLYGON_PUSD,
    details: {
      walletId: funderWalletId,
      address: funderAddress,
      linkedAddress: controllerAddress,
      venueId: "polymarket",
      polymarketFunderKind: "deposit_wallet",
      balanceClass: "polymarket",
    },
  } as const;
  const component = {
    ...baseComponent,
    componentId: "component_polymarket_funder_12345678",
    location,
    amount: { asset: POLYGON_PUSD, raw: "2000000" },
    estimatedUsd: {
      ...baseEstimatedUsd,
      value: "2",
    },
  } as const;
  const handoffPolicy = policy({
    locations: [
      {
        ...policy().locations[0],
        locationPatternId: "wallet_polygon_pusd",
        asset: POLYGON_PUSD,
      },
    ],
    routes: [
      {
        ...policy().routes[0],
        routeId: "polygon-pusd-to-base-usdc",
        sourceLocationPatternId: "wallet_polygon_pusd",
        destinationLocationPatternId: "venue_limitless_usdc",
        sourceAsset: POLYGON_PUSD,
        destinationAsset: BASE_USDC,
      },
    ],
  });
  const handoffAccount = {
    ...base,
    projection: { ...base.projection, components: [component] },
    cashAvailability: {
      ...base.cashAvailability,
      components: [
        {
          ...baseAvailability,
          componentId: component.componentId,
          amount: component.amount,
          availableRaw: "2000000",
          availableEstimatedUsd: "2",
        },
      ],
    },
    runtimePolicy: handoffPolicy,
    ownership: {
      ...baseOwnership,
      wallets: [
        {
          walletId: funderWalletId,
          networkId: "evm:137",
          address: funderAddress,
          source: "smart",
          signingModes: [],
          serverWalletRef: null,
          controllerWalletRef: "8571f3cb-381e-4e55-8f4c-ecc4c7f2abb9",
          sponsorshipPolicyIds: [],
        },
        {
          walletId: controllerWalletId,
          networkId: "evm:137",
          address: controllerAddress,
          source: "embedded",
          signingModes: ["web_client", "privy_authorization"],
          serverWalletRef: "privy_wallet_controller_12345678",
          controllerWalletRef: "8571f3cb-381e-4e55-8f4c-ecc4c7f2abb9",
          sponsorshipPolicyIds: [
            PRIVY_USER_AUTHORIZED_EVM_SPONSORSHIP_POLICY_ID,
          ],
        },
      ],
    },
    assetPreferences: {},
  } as unknown as AccountValueReadModel;
  const handoffFacts = deriveProductionRelayEligibleSourceFacts({
    accountId: ACCOUNT_ID,
    account: handoffAccount,
    policy: handoffPolicy,
    destinationLocationPatternId: "venue_limitless_usdc",
    requiredAmount: { asset: BASE_USDC, raw: "1000000" },
    purpose: "trade_shortfall",
  });
  assert.equal(handoffFacts.length, 1);
  const handoffFact = handoffFacts[0];
  assert.ok(handoffFact);
  assert.equal(handoffFact.safeLabel, "Polymarket balance");
  assert.equal(handoffFact.reservationLocationId, location.locationId);
  assert.equal(
    handoffFact.source.kind === "owned_location"
      ? handoffFact.source.location.details.address
      : null,
    controllerAddress,
  );
  assert.deepEqual(handoffFact.preRouteHandoff, {
    kind: "polymarket_deposit_wallet_to_controller_v1",
    sourceLocation: location,
    funderAddress,
    controllerAddress,
    tokenAddress: POLYGON_PUSD.assetId,
  });
  assert.equal(handoffFact.walletExecutionReady, true);
  assert.equal(handoffFact.nativeGasReady, true);
  const controllerProfile = handoffAccount.ownership?.wallets.find(
    (wallet) => wallet.walletId === controllerWalletId,
  );
  assert.ok(controllerProfile);
  const handoffSteps = buildPolymarketPreRouteHandoffSteps({
    source: handoffFact,
    sourceAmount: { asset: POLYGON_PUSD, raw: "1010102" },
    profile: controllerProfile,
    steps: [],
  });
  assert.equal(handoffSteps.length, 1);
  assert.equal(handoffSteps[0]?.stepKind, "external_handoff");
  assert.equal(
    handoffSteps[0]?.executorId,
    "polymarket_deposit_wallet_relayer_v1",
  );
  assert.equal(handoffSteps[0]?.payerRequirement, "provider");
  assert.equal(
    handoffSteps[0]?.normalizedAction.handoffKind,
    "polymarket_deposit_wallet_transfer",
  );
  assert.equal(
    deriveProductionRelayEligibleSourceFacts({
      accountId: ACCOUNT_ID,
      account: handoffAccount,
      policy: handoffPolicy,
      destinationLocationPatternId: "venue_limitless_usdc",
      requiredAmount: { asset: BASE_USDC, raw: "1000000" },
      purpose: "withdrawal",
    }).length,
    0,
  );
  const unsupportedSafeAccount = {
    ...handoffAccount,
    projection: {
      ...handoffAccount.projection,
      components: [
        {
          ...component,
          location: {
            ...location,
            details: {
              ...location.details,
              polymarketFunderKind: "safe",
            },
          },
        },
      ],
    },
  } as AccountValueReadModel;
  const unsupportedSafeFacts = deriveProductionRelayEligibleSourceFacts({
    accountId: ACCOUNT_ID,
    account: unsupportedSafeAccount,
    policy: handoffPolicy,
    destinationLocationPatternId: "venue_limitless_usdc",
    requiredAmount: { asset: BASE_USDC, raw: "1000000" },
    purpose: "trade_shortfall",
  });
  assert.equal(unsupportedSafeFacts.length, 1);
  assert.equal(unsupportedSafeFacts[0]?.preRouteHandoff, undefined);
  assert.equal(unsupportedSafeFacts[0]?.walletExecutionReady, false);
}

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

  const directNativePolicy = policy({
    ...nativePolicy,
    routes: [
      {
        ...nativePolicy.routes[0],
        routeId: "solana-sol-to-base-usdc",
        destinationLocationPatternId: "venue_limitless_usdc",
        destinationAsset: BASE_USDC,
        fixtureIds: [
          "relay_wallet_solana_sol_to_base_usdc_quote_live",
          "relay_status_lifecycle_v3",
        ],
      },
    ],
  });
  const directNativeFacts = deriveProductionRelayEligibleSourceFacts({
    accountId: ACCOUNT_ID,
    account: {
      ...nativeAccount,
      runtimePolicy: directNativePolicy,
    } as AccountValueReadModel,
    policy: directNativePolicy,
    destinationLocationPatternId: "venue_limitless_usdc",
    requiredAmount: { asset: BASE_USDC, raw: "1000000" },
  });
  assert.equal(directNativeFacts.length, 1);
  assert.equal(
    directNativeFacts[0]?.sourceLocationPatternId,
    "wallet_solana_native",
  );
  assert.equal(
    directNativeFacts[0]?.quoteMinimumOutput?.asset.networkId,
    "evm:8453",
  );
}

{
  const tokenPolicy = policy({
    locations: [
      {
        locationPatternId: "wallet_solana_usdc",
        locationKind: "wallet",
        ownership: "owned",
        observable: true,
        capabilities: ["observe", "value", "execution_source"],
        asset: SOLANA_USDC,
        enabled: true,
      },
    ],
    routes: [
      {
        ...policy().routes[0],
        routeId: "solana-usdc-to-polygon-pusd",
        sourceLocationPatternId: "wallet_solana_usdc",
        sourceAsset: SOLANA_USDC,
        actionValidatorId: "relay_svm_action_v1",
        networkExecutorId: "wallet_profile_svm_v1",
        fixtureIds: ["relay_wallet_solana_usdc_to_pusd_quote_live"],
      },
    ],
  });
  const base = account();
  const sourceAddress = "78Hpb2CbmvW2Gp2aJGZec8nphXdqtRdfjPwwLfxKgo6t";
  const walletId = "wallet_solana_usdc_12345678";
  const sourceLocation = {
    kind: "wallet",
    locationId: "location_solana_usdc_12345678",
    accountId: ACCOUNT_ID,
    asset: SOLANA_USDC,
    details: { walletId, address: sourceAddress },
  } as const;
  const nativeLocation = {
    ...sourceLocation,
    locationId: "location_solana_native_gas_12345678",
    asset: SOLANA_NATIVE,
  } as const;
  const sourceComponent = {
    ...base.projection.components[0],
    componentId: "component_solana_usdc_12345678",
    location: sourceLocation,
    amount: { asset: SOLANA_USDC, raw: "5000000" },
  } as const;
  const nativeComponent = {
    ...base.projection.components[0],
    componentId: "component_solana_native_gas_12345678",
    location: nativeLocation,
    amount: {
      asset: SOLANA_NATIVE,
      raw: (SOLANA_NATIVE_EXECUTION_RESERVE_LAMPORTS - 1n).toString(),
    },
  } as const;
  const belowReserveAccount = {
    ...base,
    projection: {
      ...base.projection,
      components: [sourceComponent, nativeComponent],
    },
    cashAvailability: {
      ...base.cashAvailability,
      components: [
        {
          ...base.cashAvailability.components[0],
          componentId: sourceComponent.componentId,
          amount: sourceComponent.amount,
          availableRaw: "4000000",
        },
        {
          ...base.cashAvailability.components[0],
          componentId: nativeComponent.componentId,
          amount: nativeComponent.amount,
          availableRaw: nativeComponent.amount.raw,
        },
      ],
    },
    runtimePolicy: tokenPolicy,
    ownership: {
      ...base.ownership,
      wallets: [
        {
          walletId,
          networkId: "solana:mainnet",
          address: sourceAddress,
          source: "embedded",
          signingModes: ["web_client"],
          serverWalletRef: null,
          sponsorshipPolicyIds: [],
        },
      ],
    },
    assetPreferences: {},
  } as unknown as AccountValueReadModel;
  const belowReserveFacts = deriveProductionRelayEligibleSourceFacts({
    accountId: ACCOUNT_ID,
    account: belowReserveAccount,
    policy: tokenPolicy,
    requiredAmount: { asset: POLYGON_PUSD, raw: "1000000" },
  });
  assert.equal(belowReserveFacts.length, 1);
  assert.equal(belowReserveFacts[0]?.nativeGasReady, false);

  const fundedNativeComponent = {
    ...nativeComponent,
    amount: {
      asset: SOLANA_NATIVE,
      raw: SOLANA_NATIVE_EXECUTION_RESERVE_LAMPORTS.toString(),
    },
  };
  const atReserveAccount = {
    ...belowReserveAccount,
    projection: {
      ...belowReserveAccount.projection,
      components: [sourceComponent, fundedNativeComponent],
    },
    cashAvailability: {
      ...belowReserveAccount.cashAvailability,
      components: belowReserveAccount.cashAvailability.components.map(
        (component) =>
          component.componentId === fundedNativeComponent.componentId
            ? {
                ...component,
                amount: fundedNativeComponent.amount,
                availableRaw: fundedNativeComponent.amount.raw,
              }
            : component,
      ),
    },
  } as AccountValueReadModel;
  const atReserveFacts = deriveProductionRelayEligibleSourceFacts({
    accountId: ACCOUNT_ID,
    account: atReserveAccount,
    policy: tokenPolicy,
    requiredAmount: { asset: POLYGON_PUSD, raw: "1000000" },
  });
  assert.equal(atReserveFacts.length, 1);
  assert.equal(atReserveFacts[0]?.nativeGasReady, true);
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

const destinationDisambiguatedPolicy = policy({
  routes: [
    originalRoute,
    {
      ...originalRoute,
      routeId: "withdrawal",
      destinationLocationPatternId: "external_polygon_pusd",
    },
  ],
});
assert.equal(
  deriveProductionRelayEligibleSourceFacts({
    accountId: ACCOUNT_ID,
    account: account(),
    policy: destinationDisambiguatedPolicy,
    destinationLocationPatternId: originalRoute.destinationLocationPatternId,
    requiredAmount: { asset: POLYGON_PUSD, raw: "3000000" },
  }).length,
  1,
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
