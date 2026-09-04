#!/usr/bin/env tsx

import assert from "node:assert/strict";

import type { AccountValueReadModel } from "../../../account-value/runtime-service.js";
import { stableWalletAssetLocationIdentity } from "../../../account-value/canonical.js";
import { RELAY_PINNED_ASSETS } from "../../../funding-providers/relay/mappings.js";
import type { FundingRuntimePolicy } from "../../policies/funding-policy.js";
import type {
  AssetRef,
  EvmTransactionAction,
  SvmTransactionAction,
} from "../../domain/types.js";
import { withWithdrawalPlanningContract } from "../../domain/withdrawal-contract.js";
import { compileFundingIntentPolicy } from "../../policies/funding-policy-v2.js";
import { PRIVY_USER_AUTHORIZED_EVM_SPONSORSHIP_POLICY_ID } from "../../execution/sponsorship-policy.js";
import { TELEGRAM_RELAY_EVM_FUNDING_PROFILE_ID } from "../../execution/delegated-funding-profile-ids.js";
import { SOLANA_NATIVE_EXECUTION_RESERVE_LAMPORTS } from "../../domain/network-fees.js";
import {
  buildPolymarketPreRouteHandoffSteps,
  deriveProductionRelayEligibleSourceFacts,
  filterRelayEligibleSourceFactsForExecutionProfile,
  restrictRelayRoutesToExecutionProfile,
} from "../../planner/production-source-planner.js";
import { groupWalletExecutableActions } from "../../planner/evm-action-batching.js";
import { DirectWithdrawalSourceAdapter } from "../../planner/direct-withdrawal-source-adapter.js";
import { assertDirectWithdrawalActionMatchesRecipient } from "../../execution/direct-withdrawal-transfer.js";

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
const POLYGON_USDC = {
  networkId: "evm:137",
  assetId: RELAY_PINNED_ASSETS.polygonUsdc,
  decimals: 6,
} as const;
const POLYGON_USDCE = {
  networkId: "evm:137",
  assetId: RELAY_PINNED_ASSETS.polygonUsdce,
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
    contractVersion: 1,
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

function accountForExactAsset(asset: AssetRef): AccountValueReadModel {
  const base = account();
  const component = base.projection.components[0];
  const availability = base.cashAvailability.components[0];
  const wallet = base.ownership?.wallets[0];
  assert.ok(component);
  assert.ok(availability);
  assert.ok(wallet);
  const sourceAddress =
    asset.networkId === "solana:mainnet"
      ? "78Hpb2CbmvW2Gp2aJGZec8nphXdqtRdfjPwwLfxKgo6t"
      : component.location.details.address;
  return {
    ...base,
    projection: {
      ...base.projection,
      components: [
        {
          ...component,
          location: {
            ...component.location,
            asset,
            details: { ...component.location.details, address: sourceAddress },
          },
          amount: { asset, raw: component.amount.raw },
        },
      ],
    },
    cashAvailability: {
      ...base.cashAvailability,
      components: [
        {
          ...availability,
          amount: { asset, raw: availability.amount.raw },
        },
      ],
    },
    ownership: {
      ...base.ownership,
      wallets: [
        { ...wallet, networkId: asset.networkId, address: sourceAddress },
      ],
    },
  } as unknown as AccountValueReadModel;
}

async function directWithdrawalOptionsForAsset(
  asset: AssetRef,
  raw = "1000000",
) {
  const recipient = {
    recipientId: `recipient_${asset.networkId.replace(":", "_")}_${asset.assetId.slice(-8)}`,
    accountId: ACCOUNT_ID,
    networkId: asset.networkId,
    asset,
    addressFingerprint: "recipient_fingerprint_12345678",
    validatedAt: NOW,
    expiresAt: "2026-07-24T12:15:00.000Z",
    validationPolicyVersion: 1,
  } as const;
  const amount = { asset, raw } as const;
  const recipientAddress =
    asset.networkId === "solana:mainnet"
      ? "F7RnPpFGLzY2r17MLTrxgJXDWiHF5etiEaLNn11GebLJ"
      : "0x1a9ec8b3c44a748f7fad6623fd79332ce683ceb0";
  return new DirectWithdrawalSourceAdapter(accountForExactAsset(asset)).list({
    accountId: ACCOUNT_ID,
    request: {
      purpose: "withdrawal",
      requestedDestinationAmount: amount,
      confirmedSourceAmount: null,
      marketContextId: null,
      destinationOptionId: null,
      withdrawalRecipientId: recipient.recipientId,
      venueBindingOptionId: null,
      maxFeeUsd: null,
      maxSlippageBps: null,
      deadline: null,
    },
    marketContext: null,
    destinationFacts: null,
    destination: {
      destinationId: recipient.recipientId,
      destinationLocationPatternId: "withdrawal-exact-evm-test-v1",
      target: { kind: "external_recipient", recipient },
      requiredAsset: asset,
      spendability: null,
      venueId: null,
      venueBindingOption: null,
      externalRecipientId: recipient.recipientId,
      recipientAddress,
    },
    placement: {
      mode: "confirmed_withdrawal_amount",
      sourceAmount: amount,
      destinationRequirement: amount,
      targetVenueId: null,
      target: { kind: "external_recipient", recipient },
      boundedBuffer: null,
      reason: "explicit",
      policyVersion: 1,
    },
    requiredAmount: amount,
    policy: policy(),
    policyRevision: "policy_withdrawal_12345678",
    now: new Date(NOW),
  });
}

for (const asset of [BASE_USDC, POLYGON_USDC, POLYGON_USDCE, SOLANA_NATIVE]) {
  const options = await directWithdrawalOptionsForAsset(asset);
  assert.equal(options.length, 1);
  assert.equal(options[0]?.option.expiresAt, "2026-07-24T12:00:30.000Z");
  const plan = options[0]?.commitPlan;
  assert.ok(plan);
  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0]?.stepKind, "transaction");
  assert.equal(plan.steps[0]?.normalizedAction.networkId, asset.networkId);
  assert.equal(plan.steps[0]?.actionExpiresAt, "2026-07-24T12:15:00.000Z");
  assert.equal(plan.segments[0]?.quoteExpiresAt, "2026-07-24T12:15:00.000Z");
  assert.equal(plan.reservations[0]?.expiresAt, "2026-07-24T12:15:00.000Z");
  assert.equal(
    plan.steps[0]?.normalizedAction.kind,
    asset.networkId === "solana:mainnet"
      ? "svm_transaction"
      : "evm_transaction",
  );
  assert.equal(
    plan.steps[0]?.executorId,
    asset.networkId === "solana:mainnet"
      ? "wallet_profile_svm_v1"
      : "wallet_profile_evm_v1",
  );
  assert.equal(
    options[0]?.option.maximumSourceRaw,
    asset.networkId === "solana:mainnet" ? "1000000" : "4000000",
  );
  const expectedSourceAssetId =
    plan.steps[0]?.actionValidationResult.expectedSourceAssetId;
  assert.equal(typeof expectedSourceAssetId, "string");
  assert.equal(
    typeof expectedSourceAssetId === "string"
      ? expectedSourceAssetId.toLowerCase()
      : null,
    asset.assetId.toLowerCase(),
  );
  if (asset.networkId === "solana:mainnet") {
    const action = plan.steps[0]?.normalizedAction;
    assert.equal(action?.kind, "svm_transaction");
    assertDirectWithdrawalActionMatchesRecipient({
      action: action as SvmTransactionAction,
      actionValidationResult: plan.steps[0]?.actionValidationResult ?? {},
      recipient: {
        recipientId: "recipient_solana_mainnet_11111111",
        accountId: ACCOUNT_ID,
        networkId: asset.networkId,
        asset,
        addressFingerprint: "recipient_fingerprint_12345678",
        validatedAt: NOW,
        expiresAt: "2026-07-24T12:15:00.000Z",
        validationPolicyVersion: 1,
        address: "F7RnPpFGLzY2r17MLTrxgJXDWiHF5etiEaLNn11GebLJ",
      },
      required: true,
    });
  }
}

assert.equal(
  (await directWithdrawalOptionsForAsset(SOLANA_NATIVE, "1000001")).length,
  0,
);

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
assert.equal(sponsored[0]?.quoteModeOverride, undefined);

const balanceCappedStableSource = deriveProductionRelayEligibleSourceFacts({
  accountId: ACCOUNT_ID,
  account: account(),
  policy: policy(),
  requiredAmount: { asset: POLYGON_PUSD, raw: "5000000" },
});
assert.equal(balanceCappedStableSource.length, 1);
assert.equal(balanceCappedStableSource[0]?.quoteInputAmount.raw, "4000000");
assert.equal(balanceCappedStableSource[0]?.quoteMinimumOutput?.raw, "1");
assert.equal(balanceCappedStableSource[0]?.quoteModeOverride, "exact_input");
assert.equal(balanceCappedStableSource[0]?.maximumSourceRaw, "4000000");

const exactReceivedSource = deriveProductionRelayEligibleSourceFacts({
  accountId: ACCOUNT_ID,
  account: account(),
  policy: policy(),
  requiredAmount: { asset: POLYGON_PUSD, raw: "1" },
  confirmedSourceAmount: { asset: BASE_USDC, raw: "3000000" },
});
assert.equal(exactReceivedSource.length, 1);
assert.equal(exactReceivedSource[0]?.quoteInputAmount.raw, "3000000");
assert.equal(exactReceivedSource[0]?.quoteMinimumOutput?.raw, "1");
assert.equal(exactReceivedSource[0]?.quoteModeOverride, "exact_input");

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
  const withdrawalHandoffFacts = deriveProductionRelayEligibleSourceFacts({
    accountId: ACCOUNT_ID,
    account: handoffAccount,
    policy: withWithdrawalPlanningContract(handoffPolicy, BASE_USDC),
    destinationLocationPatternId: "withdrawal-base-usdc-v1",
    requiredAmount: { asset: BASE_USDC, raw: "1000000" },
    purpose: "withdrawal",
  });
  assert.equal(withdrawalHandoffFacts.length, 1);
  assert.equal(
    withdrawalHandoffFacts[0]?.preRouteHandoff?.kind,
    "polymarket_deposit_wallet_to_controller_v1",
  );

  const withdrawalAmount = { asset: POLYGON_PUSD, raw: "1000000" } as const;
  const withdrawalRecipient = {
    recipientId: "recipient_withdrawal_12345678",
    accountId: ACCOUNT_ID,
    networkId: "evm:137",
    asset: POLYGON_PUSD,
    addressFingerprint: "recipient_fingerprint_12345678",
    validatedAt: NOW,
    expiresAt: "2026-07-24T12:15:00.000Z",
    validationPolicyVersion: 1,
  } as const;
  const withdrawalOptions = await new DirectWithdrawalSourceAdapter(
    handoffAccount,
  ).list({
    accountId: ACCOUNT_ID,
    request: {
      purpose: "withdrawal",
      requestedDestinationAmount: withdrawalAmount,
      confirmedSourceAmount: null,
      marketContextId: null,
      destinationOptionId: null,
      withdrawalRecipientId: withdrawalRecipient.recipientId,
      venueBindingOptionId: null,
      maxFeeUsd: null,
      maxSlippageBps: null,
      deadline: null,
    },
    marketContext: null,
    destinationFacts: null,
    destination: {
      destinationId: withdrawalRecipient.recipientId,
      destinationLocationPatternId: "withdrawal-polygon-pusd-v1",
      target: {
        kind: "external_recipient",
        recipient: withdrawalRecipient,
      },
      requiredAsset: POLYGON_PUSD,
      spendability: null,
      venueId: null,
      venueBindingOption: null,
      externalRecipientId: withdrawalRecipient.recipientId,
      recipientAddress: "0x1a9ec8b3c44a748f7fad6623fd79332ce683ceb0",
    },
    placement: {
      mode: "confirmed_withdrawal_amount",
      sourceAmount: withdrawalAmount,
      destinationRequirement: withdrawalAmount,
      targetVenueId: null,
      target: {
        kind: "external_recipient",
        recipient: withdrawalRecipient,
      },
      boundedBuffer: null,
      reason: "explicit",
      policyVersion: 1,
    },
    requiredAmount: withdrawalAmount,
    policy: handoffPolicy,
    policyRevision: "policy_withdrawal_12345678",
    now: new Date(NOW),
  });
  assert.equal(withdrawalOptions.length, 1);
  const withdrawalPlan = withdrawalOptions[0]?.commitPlan;
  assert.ok(withdrawalPlan);
  assert.equal(withdrawalPlan.operation.planKind, "wallet_route");
  assert.equal(withdrawalPlan.segments[0]?.providerId, "direct_wallet");
  assert.equal(withdrawalPlan.steps.length, 2);
  assert.equal(withdrawalPlan.steps[0]?.stepKind, "external_handoff");
  assert.equal(withdrawalPlan.steps[0]?.segmentOrdinal, null);
  assert.equal(withdrawalPlan.steps[1]?.stepKind, "transaction");
  assert.equal(withdrawalPlan.steps[1]?.segmentOrdinal, 0);
  assert.equal(withdrawalPlan.steps[1]?.dependsOnOrdinal, 0);
  assert.equal(
    withdrawalOptions[0]?.option.expiresAt,
    "2026-07-24T12:00:30.000Z",
  );
  assert.equal(
    withdrawalPlan.steps[1]?.actionExpiresAt,
    withdrawalRecipient.expiresAt,
  );
  assert.equal(
    withdrawalPlan.segments[0]?.quoteExpiresAt,
    withdrawalRecipient.expiresAt,
  );
  assert.equal(
    withdrawalPlan.reservations[0]?.expiresAt,
    withdrawalRecipient.expiresAt,
  );
  assert.equal(
    withdrawalPlan.steps[1]?.actionValidationResult.recipientAddress,
    "0x1a9eC8B3C44A748F7fAd6623Fd79332cE683cEb0",
  );
  assert.equal(withdrawalPlan.reservations[0]?.locationId, location.locationId);
  const withdrawalAction = withdrawalPlan.steps[1]?.normalizedAction;
  assert.equal(withdrawalAction?.kind, "evm_transaction");
  if (withdrawalAction?.kind !== "evm_transaction") {
    throw new Error("withdrawal action fixture is not an EVM transaction");
  }
  assertDirectWithdrawalActionMatchesRecipient({
    action: withdrawalAction as unknown as EvmTransactionAction,
    actionValidationResult:
      withdrawalPlan.steps[1]?.actionValidationResult ?? {},
    recipient: {
      ...withdrawalRecipient,
      address: "0x1a9ec8b3c44a748f7fad6623fd79332ce683ceb0",
    },
    required: true,
  });
  assert.throws(
    () =>
      assertDirectWithdrawalActionMatchesRecipient({
        action: withdrawalAction as unknown as EvmTransactionAction,
        actionValidationResult: {},
        recipient: {
          ...withdrawalRecipient,
          address: "0x1a9ec8b3c44a748f7fad6623fd79332ce683ceb0",
        },
        required: true,
      }),
    /validation is invalid/,
  );
  assert.throws(
    () =>
      assertDirectWithdrawalActionMatchesRecipient({
        action: withdrawalAction as unknown as EvmTransactionAction,
        actionValidationResult:
          withdrawalPlan.steps[1]?.actionValidationResult ?? {},
        recipient: {
          ...withdrawalRecipient,
          address: "0x1111111111111111111111111111111111111111",
        },
      }),
    /differs from frozen recipient/,
  );

  const usdceLocation = {
    ...location,
    locationId: "location_polymarket_usdce_funder_12345678",
    asset: POLYGON_USDCE,
  } as const;
  const usdceComponent = {
    ...component,
    componentId: "component_polymarket_usdce_funder_12345678",
    location: usdceLocation,
    amount: { asset: POLYGON_USDCE, raw: "18472217" },
    estimatedUsd: { ...baseEstimatedUsd, value: "18.472217" },
  } as const;
  const usdceDepositWalletAccount = {
    ...handoffAccount,
    projection: {
      ...handoffAccount.projection,
      components: [usdceComponent],
    },
    cashAvailability: {
      ...handoffAccount.cashAvailability,
      components: [
        {
          ...baseAvailability,
          componentId: usdceComponent.componentId,
          amount: usdceComponent.amount,
          availableRaw: usdceComponent.amount.raw,
          availableEstimatedUsd: "18.472217",
        },
      ],
    },
  } as unknown as AccountValueReadModel;
  assert.equal(
    deriveProductionRelayEligibleSourceFacts({
      accountId: ACCOUNT_ID,
      account: usdceDepositWalletAccount,
      policy: handoffPolicy,
      destinationLocationPatternId: "venue_limitless_usdc",
      requiredAmount: { asset: BASE_USDC, raw: "1000000" },
      purpose: "trade_shortfall",
    }).length,
    0,
    "generic Web/Telegram/automation Relay discovery must not treat Deposit Wallet USDC.e as controller USDC.e",
  );
  const usdceWithdrawalAmount = {
    asset: POLYGON_USDCE,
    raw: "5000000",
  } as const;
  const usdceWithdrawalRecipient = {
    ...withdrawalRecipient,
    recipientId: "recipient_usdce_withdrawal_12345678",
    asset: POLYGON_USDCE,
  } as const;
  const usdceWithdrawalOptions = await new DirectWithdrawalSourceAdapter(
    usdceDepositWalletAccount,
  ).list({
    accountId: ACCOUNT_ID,
    request: {
      purpose: "withdrawal",
      requestedDestinationAmount: usdceWithdrawalAmount,
      confirmedSourceAmount: null,
      marketContextId: null,
      destinationOptionId: null,
      withdrawalRecipientId: usdceWithdrawalRecipient.recipientId,
      venueBindingOptionId: null,
      maxFeeUsd: null,
      maxSlippageBps: null,
      deadline: null,
    },
    marketContext: null,
    destinationFacts: null,
    destination: {
      destinationId: usdceWithdrawalRecipient.recipientId,
      destinationLocationPatternId: "withdrawal-polygon-usdce-v1",
      target: {
        kind: "external_recipient",
        recipient: usdceWithdrawalRecipient,
      },
      requiredAsset: POLYGON_USDCE,
      spendability: null,
      venueId: null,
      venueBindingOption: null,
      externalRecipientId: usdceWithdrawalRecipient.recipientId,
      recipientAddress: "0x1a9ec8b3c44a748f7fad6623fd79332ce683ceb0",
    },
    placement: {
      mode: "confirmed_withdrawal_amount",
      sourceAmount: usdceWithdrawalAmount,
      destinationRequirement: usdceWithdrawalAmount,
      targetVenueId: null,
      target: {
        kind: "external_recipient",
        recipient: usdceWithdrawalRecipient,
      },
      boundedBuffer: null,
      reason: "explicit",
      policyVersion: 1,
    },
    requiredAmount: usdceWithdrawalAmount,
    policy: handoffPolicy,
    policyRevision: "policy_usdce_withdrawal_12345678",
    now: new Date(NOW),
  });
  assert.equal(usdceWithdrawalOptions.length, 1);
  const usdceWithdrawalPlan = usdceWithdrawalOptions[0]?.commitPlan;
  assert.ok(usdceWithdrawalPlan);
  assert.equal(
    usdceWithdrawalPlan.operation.supportMetadata?.withdrawalExecutionKind,
    "exact_same_asset_transfer",
  );
  assert.equal(usdceWithdrawalPlan.steps.length, 2);
  assert.deepEqual(
    usdceWithdrawalPlan.steps.map((step) => ({
      kind: step.stepKind,
      dependsOn: step.dependsOnOrdinal,
    })),
    [
      { kind: "external_handoff", dependsOn: null },
      { kind: "transaction", dependsOn: 0 },
    ],
  );
  assert.equal(
    usdceWithdrawalPlan.steps[0]?.actionValidationResult.executionEnvelope,
    "polymarket_deposit_wallet_to_controller_v1",
  );
  const handoffPayload = usdceWithdrawalPlan.steps[0]?.normalizedAction
    .payload as Readonly<Record<string, unknown>> | undefined;
  assert.equal(
    handoffPayload && Array.isArray(handoffPayload.calls)
      ? handoffPayload.calls.length
      : 0,
    1,
  );
  assert.equal(handoffPayload?.token, POLYGON_USDCE.assetId);
  assert.equal(handoffPayload?.conversionKind, undefined);
  const controllerUsdceIdentity = stableWalletAssetLocationIdentity({
    accountId: ACCOUNT_ID,
    address: controllerAddress,
    asset: POLYGON_USDCE,
    balanceClass: "polymarket",
  });
  assert.deepEqual(
    usdceWithdrawalPlan.reservations.map((reservation) => ({
      componentId: reservation.componentId,
      locationId: reservation.locationId,
      assetId: reservation.assetId,
      rawAmount: reservation.rawAmount,
      economicRole: reservation.economicRole ?? "source_input",
    })),
    [
      {
        componentId: usdceComponent.componentId,
        locationId: usdceLocation.locationId,
        assetId: POLYGON_USDCE.assetId,
        rawAmount: usdceWithdrawalAmount.raw,
        economicRole: "source_input",
      },
      {
        componentId: controllerUsdceIdentity.componentId,
        locationId: controllerUsdceIdentity.locationId,
        assetId: POLYGON_USDCE.assetId,
        rawAmount: usdceWithdrawalAmount.raw,
        economicRole: "future_credit_fence",
      },
    ],
  );
  const refundAsset = usdceWithdrawalPlan.segments[0]?.refundLocationSnapshot
    ?.asset as Readonly<Record<string, unknown>> | undefined;
  assert.equal(refundAsset?.assetId, POLYGON_USDCE.assetId);
  for (const step of usdceWithdrawalPlan.steps.slice(1)) {
    const action = step.normalizedAction;
    assert.equal(action.kind, "evm_transaction");
    assertDirectWithdrawalActionMatchesRecipient({
      action: action as unknown as EvmTransactionAction,
      actionValidationResult: step.actionValidationResult,
      recipient: {
        ...usdceWithdrawalRecipient,
        address: "0x1a9ec8b3c44a748f7fad6623fd79332ce683ceb0",
      },
      required: true,
    });
  }
  assert.throws(
    () =>
      assertDirectWithdrawalActionMatchesRecipient({
        action: usdceWithdrawalPlan.steps[1]
          ?.normalizedAction as unknown as EvmTransactionAction,
        actionValidationResult: {
          ...usdceWithdrawalPlan.steps[1]?.actionValidationResult,
          expectedSourceAssetId: POLYGON_PUSD.assetId,
        },
        recipient: {
          ...usdceWithdrawalRecipient,
          address: "0x1a9ec8b3c44a748f7fad6623fd79332ce683ceb0",
        },
        required: true,
      }),
    /differs from frozen recipient/,
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
    estimatedUsd: {
      value: "4",
      asOf: NOW,
      priceSource: "test_sol_price",
      confidence: "high",
      policyId: "test_sol_price",
    },
    valuationEligibility: "included",
    executionEligibility: "eligible",
    reasonCodes: [],
  } as const;
  const nativeAccount = {
    ...base,
    projection: { ...base.projection, components: [nativeComponent] },
    cashAvailability: {
      ...base.cashAvailability,
      freshness: "fresh",
      components: [
        {
          ...base.cashAvailability.components[0],
          componentId: nativeComponent.componentId,
          amount: nativeComponent.amount,
          availableRaw: "20000000",
          availableEstimatedUsd: "4",
          freshness: "fresh",
          reasonCodes: [],
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
  assert.equal(nativeFacts[0]?.quoteModeOverride, undefined);
  assert.equal(nativeFacts[0]?.exactInputFallbackOnSourceCap, true);
  assert.equal(nativeFacts[0]?.maximumSourceRaw, "17000000");
  assert.equal(nativeFacts[0]?.safeLabel, "SOL on Solana");
  assert.equal(nativeFacts[0]?.nativeGasReady, true);

  const incidentNativeComponent = {
    ...nativeComponent,
    amount: { asset: SOLANA_NATIVE, raw: "13080342" },
    estimatedUsd: {
      ...nativeComponent.estimatedUsd,
      value: "1.65",
    },
  };
  const incidentNativeAccount = {
    ...nativeAccount,
    projection: {
      ...nativeAccount.projection,
      components: [incidentNativeComponent],
    },
    cashAvailability: {
      ...nativeAccount.cashAvailability,
      components: [
        {
          ...nativeAccount.cashAvailability.components[0],
          componentId: incidentNativeComponent.componentId,
          amount: incidentNativeComponent.amount,
          availableRaw: incidentNativeComponent.amount.raw,
          availableEstimatedUsd: "1.65",
        },
      ],
    },
  } as AccountValueReadModel;
  const incidentNativeFacts = deriveProductionRelayEligibleSourceFacts({
    accountId: ACCOUNT_ID,
    account: incidentNativeAccount,
    policy: nativePolicy,
    // $7 request less the incident's $4.017453 direct pUSD balance.
    requiredAmount: { asset: POLYGON_PUSD, raw: "2982547" },
  });
  assert.equal(incidentNativeFacts.length, 1);
  assert.equal(incidentNativeFacts[0]?.quoteInputAmount.raw, "10080342");
  assert.equal(incidentNativeFacts[0]?.quoteMinimumOutput?.raw, "1");
  assert.equal(incidentNativeFacts[0]?.quoteModeOverride, "exact_input");
  assert.equal(
    incidentNativeFacts[0]?.exactInputFallbackOnSourceCap,
    undefined,
  );

  const staleOvervaluedNativeAccount = {
    ...nativeAccount,
    projection: {
      ...nativeAccount.projection,
      components: [
        {
          ...nativeComponent,
          estimatedUsd: {
            ...nativeComponent.estimatedUsd,
            value: "1000",
          },
          valuationEligibility: "excluded" as const,
          reasonCodes: ["trusted_price_stale" as const],
        },
      ],
    },
  } as AccountValueReadModel;
  const staleOvervaluedNativeFacts = deriveProductionRelayEligibleSourceFacts({
    accountId: ACCOUNT_ID,
    account: staleOvervaluedNativeAccount,
    policy: nativePolicy,
    requiredAmount: { asset: POLYGON_PUSD, raw: "1000000" },
  });
  assert.equal(staleOvervaluedNativeFacts.length, 1);
  assert.equal(staleOvervaluedNativeFacts[0]?.quoteInputAmount.raw, "17000000");
  assert.equal(
    staleOvervaluedNativeFacts[0]?.quoteMinimumOutput?.raw,
    "1000000",
  );
  assert.equal(staleOvervaluedNativeFacts[0]?.quoteModeOverride, undefined);
  assert.equal(
    staleOvervaluedNativeFacts[0]?.exactInputFallbackOnSourceCap,
    true,
  );

  const unpricedNativeAccount = {
    ...staleOvervaluedNativeAccount,
    projection: {
      ...staleOvervaluedNativeAccount.projection,
      components: [
        {
          ...nativeComponent,
          estimatedUsd: null,
          valuationEligibility: "unpriced" as const,
          reasonCodes: ["trusted_price_unavailable" as const],
        },
      ],
    },
  } as AccountValueReadModel;
  const unpricedNativeFacts = deriveProductionRelayEligibleSourceFacts({
    accountId: ACCOUNT_ID,
    account: unpricedNativeAccount,
    policy: nativePolicy,
    requiredAmount: { asset: POLYGON_PUSD, raw: "1000000" },
  });
  assert.equal(unpricedNativeFacts.length, 1);
  assert.equal(unpricedNativeFacts[0]?.quoteInputAmount.raw, "17000000");
  assert.equal(unpricedNativeFacts[0]?.quoteMinimumOutput?.raw, "1000000");
  assert.equal(unpricedNativeFacts[0]?.quoteModeOverride, undefined);
  assert.equal(unpricedNativeFacts[0]?.exactInputFallbackOnSourceCap, true);

  const reserveOnlyNativeAccount = {
    ...incidentNativeAccount,
    projection: {
      ...incidentNativeAccount.projection,
      components: [
        {
          ...incidentNativeComponent,
          amount: {
            asset: SOLANA_NATIVE,
            raw: SOLANA_NATIVE_EXECUTION_RESERVE_LAMPORTS.toString(),
          },
        },
      ],
    },
    cashAvailability: {
      ...incidentNativeAccount.cashAvailability,
      components: incidentNativeAccount.cashAvailability.components.map(
        (component) => ({
          ...component,
          amount: {
            asset: SOLANA_NATIVE,
            raw: SOLANA_NATIVE_EXECUTION_RESERVE_LAMPORTS.toString(),
          },
          availableRaw: SOLANA_NATIVE_EXECUTION_RESERVE_LAMPORTS.toString(),
        }),
      ),
    },
  } as AccountValueReadModel;
  assert.equal(
    deriveProductionRelayEligibleSourceFacts({
      accountId: ACCOUNT_ID,
      account: reserveOnlyNativeAccount,
      policy: nativePolicy,
      requiredAmount: { asset: POLYGON_PUSD, raw: "1" },
    }).length,
    0,
    "SOL reserved for execution fees must not be exposed as funding capacity",
  );

  const nativeCapacityFacts = deriveProductionRelayEligibleSourceFacts({
    accountId: ACCOUNT_ID,
    account: nativeAccount,
    policy: nativePolicy,
    requiredAmount: { asset: POLYGON_PUSD, raw: "1000000000000000" },
    quoteAvailableSourceCapacity: true,
  });
  assert.equal(nativeCapacityFacts.length, 1);
  assert.equal(nativeCapacityFacts[0]?.quoteInputAmount.raw, "17000000");
  assert.equal(nativeCapacityFacts[0]?.quoteMinimumOutput?.raw, "1");
  assert.equal(nativeCapacityFacts[0]?.quoteModeOverride, "exact_input");

  const directNativePolicy = policy({
    ...nativePolicy,
    routes: [
      {
        ...nativePolicy.routes[0],
        routeId: "solana-sol-to-base-usdc",
        destinationLocationPatternId: "venue_limitless_usdc",
        destinationAsset: BASE_USDC,
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

  const unpricedGasAccount = {
    ...atReserveAccount,
    projection: {
      ...atReserveAccount.projection,
      components: [
        sourceComponent,
        {
          ...fundedNativeComponent,
          estimatedUsd: null,
          valuationEligibility: "unpriced" as const,
          executionEligibility: "unknown" as const,
          reasonCodes: ["trusted_price_unavailable" as const],
        },
      ],
    },
    cashAvailability: {
      ...atReserveAccount.cashAvailability,
      freshness: "stale" as const,
      components: atReserveAccount.cashAvailability.components.map(
        (component) =>
          component.componentId === fundedNativeComponent.componentId
            ? {
                ...component,
                freshness: "stale" as const,
                availableEstimatedUsd: null,
                reasonCodes: ["trusted_price_unavailable" as const],
              }
            : component,
      ),
    },
  } as AccountValueReadModel;
  const unpricedGasFacts = deriveProductionRelayEligibleSourceFacts({
    accountId: ACCOUNT_ID,
    account: unpricedGasAccount,
    policy: tokenPolicy,
    requiredAmount: { asset: POLYGON_PUSD, raw: "1000000" },
  });
  assert.equal(unpricedGasFacts.length, 1);
  assert.equal(
    unpricedGasFacts[0]?.nativeGasReady,
    true,
    "a fresh raw SOL balance must remain usable for fees when USD valuation is unavailable",
  );

  const splitWalletPolicy = policy({
    locations: [
      ...tokenPolicy.locations,
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
      ...tokenPolicy.routes,
      {
        ...tokenPolicy.routes[0],
        routeId: "solana-sol-to-polygon-pusd",
        sourceLocationPatternId: "wallet_solana_native",
        sourceAsset: SOLANA_NATIVE,
      },
    ],
  });
  const externalWalletId = "wallet_solana_external_12345678";
  const externalAddress = "5CnexXUpyxp6bBJQWXoLe8v54FRGN5v3aDTtYsU2rgL3H";
  const externalNativeLocation = {
    kind: "wallet",
    locationId: "location_solana_external_native_12345678",
    accountId: ACCOUNT_ID,
    asset: SOLANA_NATIVE,
    details: {
      walletId: externalWalletId,
      address: externalAddress,
    },
  } as const;
  const externalNativeComponent = {
    ...nativeComponent,
    componentId: "component_solana_external_native_12345678",
    location: externalNativeLocation,
    amount: { asset: SOLANA_NATIVE, raw: "205985000" },
    estimatedUsd: null,
    valuationEligibility: "unpriced",
    reasonCodes: ["trusted_price_unavailable"],
  } as const;
  const belowReserveOwnership = belowReserveAccount.ownership;
  assert.ok(belowReserveOwnership);
  const splitWalletAccount = {
    ...belowReserveAccount,
    projection: {
      ...belowReserveAccount.projection,
      components: [sourceComponent, nativeComponent, externalNativeComponent],
    },
    cashAvailability: {
      ...belowReserveAccount.cashAvailability,
      components: [
        ...belowReserveAccount.cashAvailability.components,
        {
          ...belowReserveAccount.cashAvailability.components[0],
          componentId: externalNativeComponent.componentId,
          amount: externalNativeComponent.amount,
          availableRaw: externalNativeComponent.amount.raw,
          availableEstimatedUsd: null,
        },
      ],
    },
    runtimePolicy: splitWalletPolicy,
    ownership: {
      ...belowReserveOwnership,
      wallets: [
        ...belowReserveOwnership.wallets,
        {
          walletId: externalWalletId,
          networkId: "solana:mainnet",
          address: externalAddress,
          source: "external",
          signingModes: ["web_client"],
          serverWalletRef: null,
          sponsorshipPolicyIds: [],
        },
      ],
    },
  } as AccountValueReadModel;
  const splitWalletFacts = deriveProductionRelayEligibleSourceFacts({
    accountId: ACCOUNT_ID,
    account: splitWalletAccount,
    policy: splitWalletPolicy,
    requiredAmount: { asset: POLYGON_PUSD, raw: "2770428" },
  });
  const splitUsdcFact = splitWalletFacts.find(
    (fact) => fact.componentId === sourceComponent.componentId,
  );
  const splitNativeFact = splitWalletFacts.find(
    (fact) => fact.componentId === externalNativeComponent.componentId,
  );
  assert.equal(splitUsdcFact?.nativeGasReady, false);
  assert.equal(splitNativeFact?.nativeGasReady, true);
  assert.equal(
    splitNativeFact?.maximumSourceRaw,
    (205_985_000n - SOLANA_NATIVE_EXECUTION_RESERVE_LAMPORTS).toString(),
  );
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
const withdrawalPolicy = withWithdrawalPlanningContract(
  compileFundingIntentPolicy({
    version: 2,
    venues: [],
    receive: { assets: [], privy: false },
    paused: true,
  }),
  POLYGON_PUSD,
);
const unpricedWithdrawalAccount = structuredClone(account()) as unknown as {
  projection: {
    components: Array<{
      estimatedUsd: null;
      valuationEligibility: "excluded";
    }>;
  };
};
const [unpricedWithdrawalComponent] =
  unpricedWithdrawalAccount.projection.components;
if (!unpricedWithdrawalComponent) {
  throw new Error("unpriced withdrawal component fixture is missing");
}
unpricedWithdrawalComponent.estimatedUsd = null;
unpricedWithdrawalComponent.valuationEligibility = "excluded";
assert.equal(
  deriveProductionRelayEligibleSourceFacts({
    accountId: ACCOUNT_ID,
    account: unpricedWithdrawalAccount as unknown as AccountValueReadModel,
    policy: withdrawalPolicy,
    requiredAmount: { asset: POLYGON_PUSD, raw: "3000000" },
    purpose: "withdrawal",
  }).length,
  1,
);

const envelopeFacts = deriveProductionRelayEligibleSourceFacts({
  accountId: ACCOUNT_ID,
  account: account(),
  policy: policy(),
  requiredAmount: { asset: POLYGON_PUSD, raw: "3000000" },
});
const [baseEnvelopeFact] = envelopeFacts;
assert.ok(baseEnvelopeFact);
const irrelevantEnvelopeFact = {
  ...baseEnvelopeFact,
  componentId: "component_irrelevant_polygon_asset_12345678",
  quoteInputAmount: { asset: POLYGON_PUSD, raw: "3000000" },
};
assert.deepEqual(
  filterRelayEligibleSourceFactsForExecutionProfile(
    [irrelevantEnvelopeFact, baseEnvelopeFact],
    TELEGRAM_RELAY_EVM_FUNDING_PROFILE_ID,
  ).map((fact) => fact.componentId),
  [baseEnvelopeFact.componentId],
);
assert.equal(
  filterRelayEligibleSourceFactsForExecutionProfile(
    [baseEnvelopeFact],
    "unknown_server_execution_profile",
  ).length,
  0,
);

const [baseRoute] = policy().routes;
assert.ok(baseRoute);
const unrelatedRelayRoute = {
  ...baseRoute,
  routeId: "polygon-pusd-to-base-usdc",
  sourceAsset: POLYGON_PUSD,
  destinationAsset: BASE_USDC,
};
assert.deepEqual(
  restrictRelayRoutesToExecutionProfile(
    policy({ routes: [unrelatedRelayRoute, baseRoute] }),
    TELEGRAM_RELAY_EVM_FUNDING_PROFILE_ID,
  ).routes.map((route) => route.routeId),
  ["base-usdc-to-polygon-pusd"],
);

console.log(
  "[funding-production-source-planner-tests] source availability, sponsorship, withdrawal capability, preference, route uniqueness, and ownership passed",
);
