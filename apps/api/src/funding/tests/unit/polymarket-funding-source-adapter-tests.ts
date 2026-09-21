#!/usr/bin/env tsx

import assert from "node:assert/strict";
import type { Pool } from "@hunch/infra";
import { ProductionFundingSourcePlanner } from "../../planner/production-source-planner.js";
import { DEFAULT_FUNDING_RUNTIME_POLICY } from "../../policies/funding-policy.js";
import { deriveSafeProxyAddress } from "../../../services/polymarket-funder.js";

import { stableWalletAssetLocationIdentity } from "../../../account-value/canonical.js";
import type { AccountValueReadModel } from "../../../account-value/runtime-service.js";
import { RELAY_PINNED_ASSETS } from "../../../funding-providers/relay/mappings.js";
import { buildPolymarketPreRouteHandoffSteps } from "../../../funding-providers/relay/operation-plan.js";
import type { FundingPurpose } from "../../domain/types.js";
import {
  POLYMARKET_DEPOSIT_PUSD_FUND_PROFILE_ID,
  TELEGRAM_RELAY_EVM_FUNDING_PROFILE_ID,
} from "../../execution/delegated-funding-profile-ids.js";
import { PRIVY_USER_AUTHORIZED_EVM_SPONSORSHIP_POLICY_ID } from "../../execution/sponsorship-policy.js";
import { PolymarketFundingSourceAdapter } from "../../preparation/polymarket-funding-source-adapter.js";
import { polymarketFundingEvidence } from "../../preparation/polymarket-funding-snapshot.js";
import {
  maximumInternalFundingDestinationRaw,
  buildCompositeSourceOption,
} from "../../planner/composite-source-options.js";
import type { PlannedSourceOption } from "../../planner/planning-types.js";
import type { FundingSourcePlanningInput } from "../../planner/source-adapter.js";
import {
  FUNDING_OPERATION_RECONCILIATION_TTL_MS,
  fundingEconomicSourceReservations,
} from "../../persistence/funding-operation-repository.js";
import { isValidFundingCommitPlanBoundary } from "../../validation/funding-commit-plan-validator.js";
import { isPolymarketRouterCommitPlan } from "../../validation/polymarket-router-commit-plan-validator.js";

const ACCOUNT_ID = "account_pm_router_source_12345678";
const SIGNER = "0x00000000000000000000000000000000000000a1";
const DEPOSIT = "0x00000000000000000000000000000000000000a2";
const ROUTER = "0x00000000000000000000000000000000000000a3";
const PUSD = {
  networkId: "evm:137",
  assetId: RELAY_PINNED_ASSETS.polygonPusd,
  decimals: 6,
} as const;
const USDCE = {
  networkId: "evm:137",
  assetId: RELAY_PINNED_ASSETS.polygonUsdce,
  decimals: 6,
} as const;
const EXPIRES_AT = "2026-07-24T12:01:00.000Z";

function component(
  id: string,
  address: string,
  asset: typeof PUSD | typeof USDCE,
  raw: string,
  details: Readonly<Record<string, string>> = {},
) {
  return {
    componentId: id,
    location: {
      kind:
        details.polymarketFunderKind === "deposit_wallet"
          ? ("venue_account" as const)
          : ("wallet" as const),
      locationId: `location_${id}`,
      accountId: ACCOUNT_ID,
      asset,
      details: { address, ...details },
    },
    amount: { asset, raw },
    category: "cash",
    estimatedUsd: null,
    observedAt: "2026-07-24T12:00:00.000Z",
    observationFreshness: "fresh",
    observationError: null,
    valuationEligibility: "included",
    executionEligibility: "eligible",
    reasonCodes: [],
  } as const;
}

function account(
  includeSignerUsdce = true,
  signerUsdceRaw = "1500000",
  executionMode: "automatic" | "user_wallet" = "automatic",
  includeDepositWalletTopology = false,
): AccountValueReadModel {
  const components = [
    component(
      "deposit_usdce_12345678",
      DEPOSIT,
      USDCE,
      "1000000",
      includeDepositWalletTopology
        ? {
            linkedAddress: SIGNER,
            polymarketFunderKind: "deposit_wallet",
            venueId: "polymarket",
          }
        : {},
    ),
    component("signer_pusd_12345678", SIGNER, PUSD, "1500000"),
    ...(includeSignerUsdce
      ? [component("signer_usdce_12345678", SIGNER, USDCE, signerUsdceRaw)]
      : []),
  ];
  return {
    projection: { components },
    cashAvailability: {
      components: components.map((entry) => ({
        componentId: entry.componentId,
        freshness: "fresh",
        availableRaw: entry.amount.raw,
      })),
    },
    ownership: {
      wallets: [
        {
          walletId: "wallet_pm_signer_12345678",
          controllerWalletRef: "pm_signer_ref",
          networkId: "evm:137",
          address: SIGNER,
          source: executionMode === "automatic" ? "embedded" : "external",
          signingModes:
            executionMode === "automatic"
              ? ["web_client", "privy_authorization"]
              : ["web_client"],
          serverWalletRef:
            executionMode === "automatic" ? "privy_pm_signer_12345678" : null,
          sponsorshipPolicyIds:
            executionMode === "automatic"
              ? [PRIVY_USER_AUTHORIZED_EVM_SPONSORSHIP_POLICY_ID]
              : [],
        },
      ],
    },
  } as unknown as AccountValueReadModel;
}

function planningInput(
  fundingCapRaw = "4000000",
  requiredRaw = "4000000",
  signerUsdceRaw = "1500000",
  purpose: FundingPurpose = "trade_shortfall",
  routerPusdAllowanceRaw = "1500000",
  depositPusdRaw = "1500000",
  routerUsdceAllowanceRaw = signerUsdceRaw,
): FundingSourcePlanningInput {
  const settlementLocation = {
    kind: "venue_account",
    locationId: "location_pm_deposit_12345678",
    accountId: ACCOUNT_ID,
    asset: PUSD,
    details: { address: DEPOSIT, venueId: "polymarket" },
  } as const;
  const venueBinding = {
    bindingId: "binding_pm_deposit_12345678",
    venueId: "polymarket",
    controllerWalletId: "wallet_pm_signer_12345678",
    executionWalletId: "wallet_pm_signer_12345678",
    accountRef: DEPOSIT,
    settlementLocation,
    signingMode: "privy_authorization",
  } as const;
  return {
    accountId: ACCOUNT_ID,
    request: {
      purpose,
      requestedDestinationAmount: { asset: PUSD, raw: requiredRaw },
      confirmedSourceAmount:
        purpose === "convert_asset" ? { asset: USDCE, raw: requiredRaw } : null,
      marketContextId: "market_context_pm_12345678",
      destinationOptionId: "destination_pm_12345678",
      withdrawalRecipientId: null,
      venueBindingOptionId: "binding_option_pm_12345678",
      maxFeeUsd: null,
      maxSlippageBps: null,
      deadline: null,
    },
    marketContext: null,
    destinationFacts: {
      option: {
        venueId: "polymarket",
        destinationOptionId: "destination_pm_12345678",
        requiredAsset: PUSD,
      },
      target: { kind: "owned_location", location: settlementLocation },
      venueBinding,
      bindingOption: {
        inspectionRevision: "inspection_pm_12345678",
      },
      collateralValuation: {
        unitPriceUsd: "1",
        pricePolicyId: "exact-stable-policy-v1",
        asOf: "2026-07-24T12:00:00.000Z",
        expiresAt: EXPIRES_AT,
      },
      spendability: { expiresAt: EXPIRES_AT },
      sourcePlanningEvidence: polymarketFundingEvidence({
        signerAddress: SIGNER,
        depositWallet: DEPOSIT,
        depositPusdRaw,
        depositLockedRaw: depositPusdRaw === "0" ? "0" : "500000",
        depositUsdceRaw: "1000000",
        signerPusdRaw: "1500000",
        signerUsdceRaw,
        fundingCapRaw,
        routerAddress: ROUTER,
        routerNonceRaw: "7",
        routerPusdAllowanceRaw,
        routerUsdceAllowanceRaw,
        clobPusdRaw: "1500000",
        observedAt: "2026-07-24T12:00:00.000Z",
      }),
    },
    destination: {
      destinationId: "destination_pm_12345678",
      destinationLocationPatternId: "venue_polymarket_pusd",
      target: { kind: "owned_location", location: settlementLocation },
      requiredAsset: PUSD,
      venueId: "polymarket",
      venueBindingOption: null,
      externalRecipientId: null,
      recipientAddress: null,
    },
    placement: {} as FundingSourcePlanningInput["placement"],
    requiredAmount: { asset: PUSD, raw: requiredRaw },
    policy: {
      placement: { minimumDestinationUsd: "0.5" },
    } as FundingSourcePlanningInput["policy"],
    policyRevision: "policy_pm_router_12345678",
    now: new Date("2026-07-24T12:00:00.000Z"),
  } as unknown as FundingSourcePlanningInput;
}

function delegatedPusdPlanningInput(
  routerPusdAllowanceRaw = "1500000",
): FundingSourcePlanningInput {
  const input = planningInput(
    "1000000",
    "1000000",
    "0",
    "trade_shortfall",
    routerPusdAllowanceRaw,
    "0",
  );
  return {
    ...input,
    request: {
      ...input.request,
      serverExecutionProfileId: POLYMARKET_DEPOSIT_PUSD_FUND_PROFILE_ID,
    },
  };
}

const adapter = new PolymarketFundingSourceAdapter(account(), {
  canonicalRouterAddress: ROUTER,
  usdceAsset: USDCE,
});
const fullControllerAdapter = new PolymarketFundingSourceAdapter(
  account(true, "2500000"),
  {
    canonicalRouterAddress: ROUTER,
    usdceAsset: USDCE,
  },
);
const fullControllerInput = planningInput("4000000", "4000000", "2500000");
const [planned] = await fullControllerAdapter.list(fullControllerInput);
assert.ok(planned);
assert.equal(planned.option.kind, "venue_preparation");
assert.equal(planned.option.selectable, true);
assert.equal(planned.commitPlan.operation.planKind, "venue_preparation");
assert.equal(planned.commitPlan.segments.length, 0);
assert.equal(planned.commitPlan.steps.length, 1);
assert.equal(planned.commitPlan.steps[0]?.stepKind, "venue_preparation");
assert.equal(planned.commitPlan.steps[0]?.payerRequirement, "privy_sponsor");
assert.deepEqual(
  planned.commitPlan.operation.venueBindingSnapshot,
  fullControllerInput.destinationFacts?.venueBinding,
);
assert.deepEqual(
  planned.commitPlan.reservations.map((entry) => entry.rawAmount),
  ["1500000", "2500000"],
  "ordinary planning must ignore historical Deposit Wallet USDC.e allowances",
);
assert.ok(
  planned.commitPlan.reservations.every(
    (entry) =>
      entry.segmentOrdinal === null && entry.mode === "subtract_available",
  ),
);
assert.equal(
  (
    await adapter.list(
      planningInput(
        "1000000",
        "1000000",
        "0",
        "trade_shortfall",
        "1500000",
        "0",
        "0",
      ),
    )
  ).length,
  1,
  "the marker is irrelevant to controller pUSD-only funding",
);

const clientHandoffAdapter = new PolymarketFundingSourceAdapter(
  account(true, "500000", "automatic", true),
  {
    canonicalRouterAddress: ROUTER,
    usdceAsset: USDCE,
  },
);
const clientHandoffInput = planningInput(
  "3000000",
  "3000000",
  "500000",
  "trade_shortfall",
  "0",
  "0",
  "0",
);
const [clientHandoff] = await clientHandoffAdapter.list(clientHandoffInput);
assert.ok(clientHandoff);
const canonicalSafe = deriveSafeProxyAddress(SIGNER);
assert.ok(canonicalSafe);
const existingSafeAccount = account(true, "500000", "automatic", true);
const safeSourceAccount = {
  ...existingSafeAccount,
  projection: {
    ...existingSafeAccount.projection,
    components: existingSafeAccount.projection.components.map((entry) =>
      entry.componentId === "deposit_usdce_12345678"
        ? {
            ...entry,
            location: {
              ...entry.location,
              details: {
                ...entry.location.details,
                address: canonicalSafe,
                polymarketFunderKind: "safe",
              },
            },
          }
        : entry,
    ),
  },
};
const [safeFunding] = await new PolymarketFundingSourceAdapter(
  safeSourceAccount,
  { canonicalRouterAddress: ROUTER, usdceAsset: USDCE },
).list(clientHandoffInput);
assert.ok(safeFunding);
const otherOwner = "0x00000000000000000000000000000000000000b1";
const otherSafe = deriveSafeProxyAddress(otherOwner);
assert.ok(otherSafe);
const sourceOwnership = safeSourceAccount.ownership;
assert.ok(sourceOwnership);
const selectedProfile = sourceOwnership.wallets[0];
assert.ok(selectedProfile);
const ownerProfile = {
  ...selectedProfile,
  walletId: "wallet_other_safe_owner_12345678",
  controllerWalletRef: "other_safe_owner_ref",
  address: otherOwner,
  source: "external" as const,
  signingModes: ["web_client" as const],
  serverWalletRef: null,
  sponsorshipPolicyIds: [],
};
const crossOwnerAccount = {
  ...safeSourceAccount,
  connectedExternalWalletRefs: [ownerProfile.controllerWalletRef],
  nativeGasBalances: [
    { networkId: "evm:137", address: otherOwner, raw: "1000000000000000000" },
  ],
  ownership: {
    ...sourceOwnership,
    wallets: [...sourceOwnership.wallets, ownerProfile],
  },
  projection: {
    ...safeSourceAccount.projection,
    components: safeSourceAccount.projection.components.map((entry) =>
      entry.componentId === "deposit_usdce_12345678"
        ? {
            ...entry,
            location: {
              ...entry.location,
              details: {
                ...entry.location.details,
                address: otherSafe,
                linkedAddress: otherOwner,
              },
            },
          }
        : entry,
    ),
  },
};
const crossAdapter = (value: AccountValueReadModel) =>
  new PolymarketFundingSourceAdapter(value, {
    canonicalRouterAddress: ROUTER,
    usdceAsset: USDCE,
  });
const [crossFunding] =
  await crossAdapter(crossOwnerAccount).list(clientHandoffInput);
assert.ok(crossFunding);
// MAR46: MetaMask has zero POL; its Safe holds USDC.e, while the selected
// internal controller has only 0.125 USDC.e. A $1 Buy needs 1.049962 pUSD.
const mar46Components = crossOwnerAccount.projection.components.map(
  (entry) => ({
    ...entry,
    amount: {
      ...entry.amount,
      raw:
        entry.componentId === "deposit_usdce_12345678"
          ? "1534146"
          : entry.componentId === "signer_usdce_12345678"
            ? "125000"
            : "0",
    },
  }),
);
const mar46Account = {
  ...crossOwnerAccount,
  nativeGasBalances: [{ networkId: "evm:137", address: otherOwner, raw: "0" }],
  projection: { ...crossOwnerAccount.projection, components: mar46Components },
  cashAvailability: {
    ...crossOwnerAccount.cashAvailability,
    components: crossOwnerAccount.cashAvailability.components.map((entry) => {
      const source = mar46Components.find(
        (component) => component.componentId === entry.componentId,
      );
      assert.ok(source);
      return { ...entry, availableRaw: source.amount.raw };
    }),
  },
};
const mar46Input = planningInput(
  "125000",
  "1049962",
  "125000",
  "trade_shortfall",
  "0",
  "0",
  "125000",
);
const [mar46] = await crossAdapter(mar46Account).list(mar46Input);
assert.ok(mar46?.option.selectable);
assert.equal(isValidFundingCommitPlanBoundary(mar46.commitPlan), true);
assert.equal(
  mar46.commitPlan.steps[0]?.actionValidationResult.amountRaw,
  "924962",
);
assert.equal(
  mar46.commitPlan.segments.length,
  0,
  "same-chain USDC.e uses Router, not Relay",
);
assert.equal(
  fundingEconomicSourceReservations(mar46.commitPlan.reservations).reduce(
    (sum, entry) => sum + BigInt(entry.rawAmount),
    0n,
  ),
  1049962n,
);
const [mar46TooLarge] = await crossAdapter(mar46Account).list({
  ...mar46Input,
  requiredAmount: { asset: PUSD, raw: "1659147" },
});
assert.equal(mar46TooLarge?.option.selectable, false);
assert.equal(mar46TooLarge?.option.minimumDestination?.raw, "1659146");
const [unsponsored] = await crossAdapter({
  ...mar46Account,
  ownership: {
    ...sourceOwnership,
    wallets: [{ ...selectedProfile, sponsorshipPolicyIds: [] }, ownerProfile],
  },
}).list(mar46Input);
assert.ok(
  !unsponsored?.option.selectable,
  "ordinary wallet gas protections remain in force",
);
// The selected controller is empty. Another owned controller holds USDC.e;
// changing the trading wallet or involving Relay is unnecessary.
const ownedUsdce = component(
  "owned_usdce_12345678",
  otherOwner,
  USDCE,
  "1957954",
  { walletId: "wallet_owned_usdce_12345678" },
);
const ownedProfile = {
  ...selectedProfile,
  walletId: "wallet_owned_usdce_12345678",
  controllerWalletRef: "owned_usdce_ref",
  address: otherOwner,
};
const ownedUsdceAccount: AccountValueReadModel = {
  ...account(false),
  projection: { ...account(false).projection, components: [ownedUsdce] },
  cashAvailability: {
    ...account(false).cashAvailability,
    components: [
      {
        componentId: ownedUsdce.componentId,
        freshness: "fresh",
        availableRaw: "1957954",
      } as AccountValueReadModel["cashAvailability"]["components"][number],
    ],
  },
  ownership: { ...sourceOwnership, wallets: [selectedProfile, ownedProfile] },
};
const ownedUsdceInput = {
  ...planningInput("0", "1059502", "0", "trade_shortfall", "0", "0", "0"),
  internalSourcesOnly: true,
};
const [ownedUsdceFunding] =
  await crossAdapter(ownedUsdceAccount).list(ownedUsdceInput);
assert.ok(ownedUsdceFunding?.option.selectable);
for (const walletRaw of ["0", "500000", "1000000"]) {
  const walletIdentity = stableWalletAssetLocationIdentity({
    accountId: ACCOUNT_ID,
    address: ownedProfile.address,
    asset: USDCE,
    balanceClass: "polymarket",
  });
  const walletSource = {
    ...ownedUsdce,
    componentId: walletIdentity.componentId,
    location: {
      ...ownedUsdce.location,
      locationId: walletIdentity.locationId,
    },
    amount: { asset: USDCE, raw: walletRaw },
  };
  const safeComponent = component(
    "other_safe_usdce",
    otherSafe,
    USDCE,
    "1000000",
    {
      linkedAddress: ownedProfile.address,
      polymarketFunderKind: "safe",
      venueId: "polymarket",
    },
  );
  const safeSource = {
    ...safeComponent,
    location: { ...safeComponent.location, kind: "venue_account" as const },
  };
  const components = [walletSource, safeSource];
  const availabilityTemplate = ownedUsdceAccount.cashAvailability.components[0];
  assert.ok(availabilityTemplate);
  const requiredRaw = (BigInt(walletRaw) + 1000000n).toString();
  const [combined] = await crossAdapter({
    ...ownedUsdceAccount,
    projection: { ...ownedUsdceAccount.projection, components },
    cashAvailability: {
      ...ownedUsdceAccount.cashAvailability,
      components: components.map((entry) => ({
        ...availabilityTemplate,
        componentId: entry.componentId,
        availableRaw: entry.amount.raw,
      })),
    },
  }).list({
    ...ownedUsdceInput,
    requiredAmount: { asset: PUSD, raw: requiredRaw },
    request: {
      ...ownedUsdceInput.request,
      requestedDestinationAmount: { asset: PUSD, raw: requiredRaw },
    },
  });
  assert.ok(combined?.option.selectable);
  assert.equal(isValidFundingCommitPlanBoundary(combined.commitPlan), true);
  const reservations = combined.commitPlan.reservations;
  assert.equal(
    new Set(
      reservations.map((entry) => `${entry.componentId}\u0000${entry.mode}`),
    ).size,
    reservations.length,
    "commit must not reject a canonical wallet source plus its Safe credit as duplicate reservations",
  );
  const ownerReservation = reservations.find(
    (entry) => entry.componentId === walletIdentity.componentId,
  );
  assert.equal(ownerReservation?.rawAmount, requiredRaw);
  assert.equal(
    ownerReservation?.economicRole,
    walletRaw === "0" ? "future_credit_fence" : "source_input",
  );
  assert.equal(
    ownerReservation?.sourceInputRawAmount,
    walletRaw === "0" ? undefined : walletRaw,
  );
  assert.equal(
    fundingEconomicSourceReservations(reservations).reduce(
      (sum, entry) => sum + BigInt(entry.rawAmount),
      0n,
    ),
    BigInt(requiredRaw),
    "future credits must stay fenced without counting them as additional money",
  );
  assert.deepEqual(
    combined.commitPlan.steps.map((step) => step.dependsOnOrdinal),
    combined.commitPlan.steps.map((_, index) =>
      index === 0 ? null : index - 1,
    ),
  );
}
assert.equal(
  isValidFundingCommitPlanBoundary(ownedUsdceFunding.commitPlan),
  true,
);
assert.equal(
  ownedUsdceFunding.commitPlan.steps[0]?.actionValidationResult.kind,
  "owned_wallet_controller_transfer",
);
assert.equal(
  ownedUsdceFunding.commitPlan.steps[0]?.normalizedAction.senderWalletId,
  ownedProfile.walletId,
);
assert.equal(
  ownedUsdceFunding.commitPlan.steps.at(-1)?.normalizedAction.senderWalletId,
  selectedProfile.walletId,
);
assert.equal(ownedUsdceFunding.commitPlan.segments.length, 0);
const persistedOwnedUsdcePlan = JSON.parse(
  JSON.stringify(ownedUsdceFunding.commitPlan),
) as typeof ownedUsdceFunding.commitPlan;
assert.equal(isValidFundingCommitPlanBoundary(persistedOwnedUsdcePlan), true);
assert.equal(
  isPolymarketRouterCommitPlan({
    ...persistedOwnedUsdcePlan,
    operation: {
      ...persistedOwnedUsdcePlan.operation,
      planKind: "composite_route",
    },
    steps: persistedOwnedUsdcePlan.steps.map((step) => ({
      ...step,
      ordinal: step.ordinal + 3,
      dependsOnOrdinal:
        step.dependsOnOrdinal === null ? null : step.dependsOnOrdinal + 3,
    })),
  }),
  true,
  "a persisted local contribution retains its exact dependencies in a composite",
);
assert.equal(
  fundingEconomicSourceReservations(
    ownedUsdceFunding.commitPlan.reservations,
  ).reduce((sum, entry) => sum + BigInt(entry.rawAmount), 0n),
  1059502n,
);
const ownedTransfer = ownedUsdceFunding.commitPlan.steps[0];
assert.ok(ownedTransfer);
for (const change of [
  {
    normalizedAction: {
      ...ownedTransfer.normalizedAction,
      senderWalletId: selectedProfile.walletId,
    },
  },
  {
    normalizedAction: {
      ...ownedTransfer.normalizedAction,
      to: PUSD.assetId,
    },
  },
  {
    actionValidationResult: {
      ...ownedTransfer.actionValidationResult,
      expectedDestinationRaw: "1",
    },
  },
  {
    actionValidationResult: {
      ...ownedTransfer.actionValidationResult,
      expectedDestinationAddress: otherOwner,
    },
  },
  { dependsOnOrdinal: 1 },
  { segmentOrdinal: 0 },
  { normalizedAction: { ...ownedTransfer.normalizedAction, data: "0x" } },
]) {
  assert.equal(
    isValidFundingCommitPlanBoundary({
      ...ownedUsdceFunding.commitPlan,
      steps: ownedUsdceFunding.commitPlan.steps.map((step, index) =>
        index === 0 ? { ...step, ...change } : step,
      ),
    }),
    false,
  );
}
for (const unavailableAccount of [
  {
    ...ownedUsdceAccount,
    ownership: { ...sourceOwnership, wallets: [selectedProfile] },
  },
  {
    ...ownedUsdceAccount,
    ownership: {
      ...sourceOwnership,
      wallets: [
        selectedProfile,
        { ...ownedProfile, source: "external" as const },
      ],
    },
  },
  {
    ...ownedUsdceAccount,
    cashAvailability: {
      ...ownedUsdceAccount.cashAvailability,
      components: ownedUsdceAccount.cashAvailability.components.map(
        (entry) => ({ ...entry, availableRaw: "0" }),
      ),
    },
  },
]) {
  assert.equal(
    (await crossAdapter(unavailableAccount).list(ownedUsdceInput)).length,
    0,
  );
}
assert.equal(
  (
    await crossAdapter(ownedUsdceAccount).list({
      ...ownedUsdceInput,
      excludedSourceComponentIds: [ownedUsdce.componentId],
    })
  ).length,
  0,
);
assert.equal(
  (
    await crossAdapter(ownedUsdceAccount).list({
      ...ownedUsdceInput,
      request: {
        ...ownedUsdceInput.request,
        serverExecutionProfileId: POLYMARKET_DEPOSIT_PUSD_FUND_PROFILE_ID,
      },
    })
  ).length,
  0,
);
const [overCapacityOwnedUsdce] = await crossAdapter(ownedUsdceAccount).list({
  ...ownedUsdceInput,
  requiredAmount: { asset: PUSD, raw: "1957955" },
});
assert.equal(overCapacityOwnedUsdce?.option.selectable, false);
assert.equal(overCapacityOwnedUsdce?.option.minimumDestination?.raw, "1957954");
const priorityPolicy = {
  ...DEFAULT_FUNDING_RUNTIME_POLICY,
  placement: {
    ...DEFAULT_FUNDING_RUNTIME_POLICY.placement,
    minimumDestinationUsd: "0.5",
  },
};
const priorityAccount: AccountValueReadModel = {
  ...crossOwnerAccount,
  runtimePolicy: priorityPolicy,
  projection: { ...crossOwnerAccount.projection, collectorErrors: [] },
};
const priorityPlanner = new ProductionFundingSourcePlanner(
  {} as Pool,
  priorityAccount,
  [crossAdapter(priorityAccount)],
);
const priorityDiscovery = await priorityPlanner.discover({
  ...clientHandoffInput,
  policy: priorityPolicy,
});
assert.ok(
  priorityDiscovery.sources.some(
    (source) =>
      source.option.selectable &&
      source.option.minimumDestination?.raw === "3000000",
  ),
  "external Safe can complete the same Router plan after internal capacity is exhausted",
);
const [internalOnlyFunding] = await crossAdapter(crossOwnerAccount).list({
  ...clientHandoffInput,
  internalSourcesOnly: true,
});
assert.ok(internalOnlyFunding);
assert.equal(
  fundingEconomicSourceReservations(
    internalOnlyFunding.commitPlan.reservations,
  ).some(
    ({ reservation }) => reservation.componentId === "deposit_usdce_12345678",
  ),
  false,
  "external Safe must wait until internal sources have contributed",
);
const [internalSafeFunding] = await crossAdapter(safeSourceAccount).list({
  ...clientHandoffInput,
  internalSourcesOnly: true,
});
assert.ok(internalSafeFunding);
assert.equal(
  fundingEconomicSourceReservations(
    internalSafeFunding.commitPlan.reservations,
  ).some(
    ({ reservation }) => reservation.componentId === "deposit_usdce_12345678",
  ),
  true,
  "a legacy Safe owned by the internal wallet remains a first-priority source",
);
const [excludedSafeFunding] = await crossAdapter(safeSourceAccount).list({
  ...clientHandoffInput,
  excludedSourceComponentIds: ["deposit_usdce_12345678"],
});
assert.ok(excludedSafeFunding);
assert.equal(
  fundingEconomicSourceReservations(
    excludedSafeFunding.commitPlan.reservations,
  ).some(
    ({ reservation }) => reservation.componentId === "deposit_usdce_12345678",
  ),
  false,
  "a source already used by another contributor cannot be spent again",
);
assert.equal(isValidFundingCommitPlanBoundary(crossFunding.commitPlan), true);
assert.equal(
  crossFunding.commitPlan.steps[0]?.normalizedAction.actorWalletId,
  ownerProfile.walletId,
);
assert.equal(
  crossFunding.commitPlan.steps[0]?.normalizedAction.payload &&
    (
      crossFunding.commitPlan.steps[0].normalizedAction.payload as {
        recipient: string;
      }
    ).recipient,
  selectedProfile.address,
);
assert.equal(
  crossFunding.commitPlan.steps.some(
    (step) => step.normalizedAction.senderWalletId === ownerProfile.walletId,
  ),
  false,
  "the external owner signs the Safe transfer but sends no gas-funded transaction",
);
for (const nativeGasBalances of [
  [],
  [{ networkId: "evm:137", address: otherOwner, raw: "0" }],
]) {
  const [noGasFunding] = await crossAdapter({
    ...crossOwnerAccount,
    nativeGasBalances,
  }).list(clientHandoffInput);
  assert.ok(noGasFunding?.option.selectable);
  assert.equal(isValidFundingCommitPlanBoundary(noGasFunding.commitPlan), true);
  assert.equal(noGasFunding.commitPlan.steps[0]?.payerRequirement, "provider");
  assert.equal(
    fundingEconomicSourceReservations(
      noGasFunding.commitPlan.reservations,
    ).reduce((sum, entry) => sum + BigInt(entry.rawAmount), 0n),
    3000000n,
  );
  assert.equal(
    noGasFunding.commitPlan.reservations.some(
      (entry) =>
        entry.economicRole === "future_credit_fence" &&
        entry.componentId ===
          stableWalletAssetLocationIdentity({
            accountId: ACCOUNT_ID,
            address: otherOwner,
            asset: USDCE,
            balanceClass: "polymarket",
          }).componentId,
    ),
    false,
  );
}
assert.equal(
  crossFunding.commitPlan.steps.at(-1)?.normalizedAction.senderWalletId,
  "wallet_pm_signer_12345678",
);
assert.equal(
  fundingEconomicSourceReservations(
    crossFunding.commitPlan.reservations,
  ).reduce((sum, entry) => sum + BigInt(entry.rawAmount), 0n),
  3000000n,
);
assert.equal(
  maximumInternalFundingDestinationRaw({
    candidates: [crossFunding],
    destinationAsset: PUSD,
    destinationUnitPriceUsd: "1",
    maximumFeeUsd: "1",
    maximumFeeBps: 2000,
    maximumSlippageBps: 1000,
    executionBoundary: "client_handoff",
  }),
  3000000n,
  "Max and Buy share the exact Safe contribution, not its intermediate fences",
);
assert.equal(
  isValidFundingCommitPlanBoundary({
    ...crossFunding.commitPlan,
    steps: crossFunding.commitPlan.steps.map((step) =>
      step.normalizedAction.actorWalletId === ownerProfile.walletId
        ? {
            ...step,
            normalizedAction: {
              ...step.normalizedAction,
              actorWalletId: selectedProfile.walletId,
            },
          }
        : step,
    ),
  }),
  false,
  "the destination controller cannot impersonate the Safe owner",
);
for (const unavailable of [
  { ...crossOwnerAccount, connectedExternalWalletRefs: [] },
  { ...crossOwnerAccount, ownership: safeSourceAccount.ownership },
]) {
  const [candidate] = await crossAdapter(unavailable).list(clientHandoffInput);
  assert.ok(
    !candidate?.commitPlan.steps.some(
      (step) => step.normalizedAction.actorWalletId === ownerProfile.walletId,
    ),
    "an unconnected/unowned signer cannot contribute Safe cash",
  );
}
for (const field of [
  "recipientAddress",
  "amountRaw",
  "signerAddress",
] as const) {
  assert.equal(
    isValidFundingCommitPlanBoundary({
      ...crossFunding.commitPlan,
      steps: crossFunding.commitPlan.steps.map((step) =>
        step.normalizedAction.actorWalletId === ownerProfile.walletId
          ? {
              ...step,
              actionValidationResult: {
                ...step.actionValidationResult,
                [field]: field === "amountRaw" ? "1" : DEPOSIT,
              },
            }
          : step,
      ),
    }),
    false,
  );
}
const safePusdAccount = {
  ...safeSourceAccount,
  projection: {
    ...safeSourceAccount.projection,
    components: safeSourceAccount.projection.components.map((entry) =>
      entry.componentId === "deposit_usdce_12345678"
        ? {
            ...entry,
            amount: { ...entry.amount, asset: PUSD },
            location: { ...entry.location, asset: PUSD },
          }
        : entry,
    ),
  },
};
const [safePusdFunding] = await new PolymarketFundingSourceAdapter(
  safePusdAccount,
  { canonicalRouterAddress: ROUTER, usdceAsset: USDCE },
).list(clientHandoffInput);
assert.ok(safePusdFunding);
const safeUsdceComponent = safeSourceAccount.projection.components.find(
  (entry) => entry.componentId === "deposit_usdce_12345678",
);
const safePusdComponent = safePusdAccount.projection.components.find(
  (entry) => entry.componentId === "deposit_usdce_12345678",
);
assert.ok(safeUsdceComponent && safePusdComponent);
const safeAvailability = existingSafeAccount.cashAvailability.components[0];
assert.ok(safeAvailability);
const mixedAccount = {
  ...existingSafeAccount,
  cashAvailability: {
    ...existingSafeAccount.cashAvailability,
    components: [
      ...existingSafeAccount.cashAvailability.components,
      {
        ...safeAvailability,
        componentId: "safe_usdce_mixed",
      },
      {
        ...safeAvailability,
        componentId: "safe_pusd_mixed",
      },
    ],
  },
  projection: {
    ...existingSafeAccount.projection,
    components: [
      ...existingSafeAccount.projection.components,
      {
        ...safeUsdceComponent,
        componentId: "safe_usdce_mixed",
        location: {
          ...safeUsdceComponent.location,
          locationId: "safe_usdce_location",
        },
      },
      {
        ...safePusdComponent,
        componentId: "safe_pusd_mixed",
        location: {
          ...safePusdComponent.location,
          locationId: "safe_pusd_location",
        },
      },
    ],
  },
};
const [mixedFunding] = await new PolymarketFundingSourceAdapter(mixedAccount, {
  canonicalRouterAddress: ROUTER,
  usdceAsset: USDCE,
}).list({
  ...clientHandoffInput,
  requiredAmount: { ...clientHandoffInput.requiredAmount, raw: "5000000" },
});
assert.ok(mixedFunding);
assert.equal(mixedFunding.option.selectable, true);
assert.equal(isValidFundingCommitPlanBoundary(mixedFunding.commitPlan), true);
assert.deepEqual(
  mixedFunding.commitPlan.steps
    .slice(0, 3)
    .map((step) => step.normalizedAction.handoffKind),
  [
    "polymarket_deposit_wallet_transfer",
    "polymarket_safe_transfer",
    "polymarket_safe_transfer",
  ],
);
assert.equal(
  fundingEconomicSourceReservations(
    mixedFunding.commitPlan.reservations,
  ).reduce((sum, entry) => sum + BigInt(entry.rawAmount), 0n),
  5000000n,
);
assert.equal(mixedFunding.commitPlan.steps.length, 6);
const brokenDependency = { ...mixedFunding.commitPlan };
brokenDependency.steps = brokenDependency.steps.map((step, ordinal) =>
  ordinal === 1 ? { ...step, dependsOnOrdinal: null } : step,
);
assert.equal(isValidFundingCommitPlanBoundary(brokenDependency), false);
const wrongController = { ...mixedFunding.commitPlan };
wrongController.steps = wrongController.steps.map((step) =>
  step.stepKind === "venue_preparation"
    ? {
        ...step,
        actionValidationResult: {
          ...step.actionValidationResult,
          signerAddress: DEPOSIT,
        },
      }
    : step,
);
assert.equal(isValidFundingCommitPlanBoundary(wrongController), false);
const repeatedInput = { ...mixedFunding.commitPlan };
const repeatedStep = repeatedInput.steps[1];
assert.ok(repeatedStep);
repeatedInput.steps = repeatedInput.steps.map((step, ordinal) =>
  ordinal === 2 ? { ...repeatedStep, ordinal: 2, dependsOnOrdinal: 1 } : step,
);
assert.equal(isValidFundingCommitPlanBoundary(repeatedInput), false);
assert.deepEqual(
  mixedFunding.commitPlan.steps.map((step) => step.dependsOnOrdinal),
  [null, 0, 1, 2, 3, 4],
);
assert.equal(
  isValidFundingCommitPlanBoundary(safePusdFunding.commitPlan),
  true,
);
assert.equal(
  safePusdFunding.commitPlan.steps[0]?.normalizedAction.handoffKind,
  "polymarket_safe_transfer",
);
assert.equal(
  fundingEconomicSourceReservations(
    safePusdFunding.commitPlan.reservations,
  ).reduce((sum, entry) => sum + BigInt(entry.rawAmount), 0n),
  3000000n,
);
assert.equal(
  safeFunding.commitPlan.steps[0]?.normalizedAction.handoffKind,
  "polymarket_safe_transfer",
);
assert.equal(isValidFundingCommitPlanBoundary(safeFunding.commitPlan), true);
assert.deepEqual(
  fundingEconomicSourceReservations(safeFunding.commitPlan.reservations).map(
    (entry) => entry.rawAmount,
  ),
  ["1500000", "1000000", "500000"],
);
assert.equal(
  maximumInternalFundingDestinationRaw({
    candidates: [safeFunding],
    destinationAsset: PUSD,
    destinationUnitPriceUsd: "1",
    maximumFeeUsd: "1",
    maximumFeeBps: 2000,
    maximumSlippageBps: 1000,
    executionBoundary: "automatic",
  }),
  0n,
);
assert.equal(
  maximumInternalFundingDestinationRaw({
    candidates: [safeFunding],
    destinationAsset: PUSD,
    destinationUnitPriceUsd: "1",
    maximumFeeUsd: "1",
    maximumFeeBps: 2000,
    maximumSlippageBps: 1000,
    executionBoundary: "client_handoff",
  }),
  3000000n,
);
assert.equal(
  maximumInternalFundingDestinationRaw({
    candidates: [clientHandoff],
    destinationAsset: PUSD,
    destinationUnitPriceUsd: "1",
    maximumFeeUsd: "1",
    maximumFeeBps: 2_000,
    maximumSlippageBps: 1_000,
    executionBoundary: "client_handoff",
  }),
  3_000_000n,
  "the production Deposit Wallet handoff/approval/fund chain must remain eligible for Mini App capacity planning",
);
assert.deepEqual(
  clientHandoff.commitPlan.reservations.map((reservation) => ({
    componentId: reservation.componentId,
    economicRole: reservation.economicRole ?? "source_input",
    rawAmount: reservation.rawAmount,
    sourceInputRawAmount: reservation.sourceInputRawAmount ?? null,
  })),
  [
    {
      componentId: "signer_pusd_12345678",
      economicRole: "source_input",
      rawAmount: "1500000",
      sourceInputRawAmount: null,
    },
    {
      componentId: "deposit_usdce_12345678",
      economicRole: "source_input",
      rawAmount: "1000000",
      sourceInputRawAmount: null,
    },
    {
      componentId: "signer_usdce_12345678",
      economicRole: "source_input",
      rawAmount: "1500000",
      sourceInputRawAmount: "500000",
    },
  ],
  "client preparation must fence both the Deposit Wallet debit and the controller balance after the exact transfer",
);
assert.deepEqual(
  fundingEconomicSourceReservations(clientHandoff.commitPlan.reservations).map(
    ({ reservation, rawAmount }) => ({
      componentId: reservation.componentId,
      rawAmount,
    }),
  ),
  [
    { componentId: "signer_pusd_12345678", rawAmount: "1500000" },
    { componentId: "deposit_usdce_12345678", rawAmount: "1000000" },
    { componentId: "signer_usdce_12345678", rawAmount: "500000" },
  ],
  "the controller fence may include the incoming credit without double-counting it as source economics",
);
assert.ok(
  clientHandoff.commitPlan.reservations.every(
    (reservation) =>
      reservation.expiresAt ===
      new Date(
        Date.parse(EXPIRES_AT) + FUNDING_OPERATION_RECONCILIATION_TTL_MS,
      ).toISOString(),
  ),
  "committed reservations must outlive the short inspection and remain active for reconciliation",
);
assert.deepEqual(
  clientHandoff.commitPlan.steps.map((step) => ({
    dependsOnOrdinal: step.dependsOnOrdinal,
    executorId: step.executorId,
    kind: step.actionValidationResult.kind,
    ordinal: step.ordinal,
    state: step.state,
    stepKind: step.stepKind,
  })),
  [
    {
      dependsOnOrdinal: null,
      executorId: "polymarket_deposit_wallet_relayer_v1",
      kind: undefined,
      ordinal: 0,
      state: "action_required",
      stepKind: "external_handoff",
    },
    {
      dependsOnOrdinal: 0,
      executorId: "wallet_profile_evm_v1",
      kind: "controller_usdce_router_approval",
      ordinal: 1,
      state: "action_required",
      stepKind: "transaction",
    },
    {
      dependsOnOrdinal: 1,
      executorId: "wallet_profile_evm_v1",
      kind: "controller_pusd_router_approval",
      ordinal: 2,
      state: "action_required",
      stepKind: "transaction",
    },
    {
      dependsOnOrdinal: 2,
      executorId: "wallet_profile_evm_v1",
      kind: undefined,
      ordinal: 3,
      state: "action_required",
      stepKind: "venue_preparation",
    },
  ],
  "the exact Deposit Wallet transfer must gate controller approvals and Router fund",
);
for (const approvalStep of clientHandoff.commitPlan.steps.filter(
  (step) =>
    step.actionValidationResult.kind === "controller_usdce_router_approval" ||
    step.actionValidationResult.kind === "controller_pusd_router_approval",
)) {
  assert.equal(
    approvalStep.actionValidationResult.signerAddress,
    SIGNER,
    "every controller approval must persist the signer required by receipt reconciliation",
  );
  assert.equal(
    approvalStep.actionValidationResult.validatorId,
    "polymarket_funding_router_v1",
    "every controller approval must carry the Router validator identity",
  );
}
assert.equal(
  clientHandoff.commitPlan.steps.at(-1)?.actionValidationResult.validatorId,
  "polymarket_funding_router_v1",
  "the produced Router fund step must carry its exact validator identity",
);
assert.deepEqual(
  clientHandoff.commitPlan.operation.supportMetadata?.planValidation,
  {
    validatorId: "polymarket_funding_router_v1",
    version: 1,
  },
  "the produced Router plan must declare its exact commit validator version",
);
assert.equal(
  isValidFundingCommitPlanBoundary(clientHandoff.commitPlan),
  true,
  "the produced direct USDC.e handoff plan must pass its declared exact validator",
);
assert.ok(
  clientHandoff.option.requiredActions.every(
    (requiredAction) => requiredAction.actor === "user",
  ),
  "the Deposit Wallet composition must remain client-executed",
);
const handoffAction = clientHandoff.commitPlan.steps[0]?.normalizedAction;
assert.equal(handoffAction?.kind, "external_handoff");
assert.equal(handoffAction?.handoffKind, "polymarket_deposit_wallet_transfer");
assert.equal(
  (handoffAction?.payload as Readonly<Record<string, unknown>> | undefined)
    ?.amountRaw,
  "1000000",
);
assert.equal(
  (handoffAction?.payload as Readonly<Record<string, unknown>> | undefined)
    ?.token,
  USDCE.assetId,
);
assert.equal(
  (
    (handoffAction?.payload as Readonly<Record<string, unknown>> | undefined)
      ?.calls as readonly unknown[] | undefined
  )?.length,
  1,
);

assert.deepEqual(
  await clientHandoffAdapter.list({
    ...clientHandoffInput,
    request: {
      ...clientHandoffInput.request,
      serverExecutionProfileId: POLYMARKET_DEPOSIT_PUSD_FUND_PROFILE_ID,
    },
  }),
  [],
  "unattended Telegram funding must not consume Deposit Wallet USDC.e",
);

const depositOnlyHandoffAdapter = new PolymarketFundingSourceAdapter(
  account(false, "0", "automatic", true),
  {
    canonicalRouterAddress: ROUTER,
    usdceAsset: USDCE,
  },
);
const [depositOnlyHandoff] = await depositOnlyHandoffAdapter.list(
  planningInput("2500000", "2500000", "0", "trade_shortfall", "0", "0", "0"),
);
assert.ok(depositOnlyHandoff);
const emptyControllerUsdceIdentity = stableWalletAssetLocationIdentity({
  accountId: ACCOUNT_ID,
  address: SIGNER,
  asset: USDCE,
  balanceClass: "polymarket",
});
assert.deepEqual(
  depositOnlyHandoff.commitPlan.reservations.map((reservation) => ({
    componentId: reservation.componentId,
    economicRole: reservation.economicRole ?? "source_input",
    locationId: reservation.locationId,
    rawAmount: reservation.rawAmount,
    sourceInputRawAmount: reservation.sourceInputRawAmount ?? null,
  })),
  [
    {
      componentId: "signer_pusd_12345678",
      economicRole: "source_input",
      locationId: "location_signer_pusd_12345678",
      rawAmount: "1500000",
      sourceInputRawAmount: null,
    },
    {
      componentId: "deposit_usdce_12345678",
      economicRole: "source_input",
      locationId: "location_deposit_usdce_12345678",
      rawAmount: "1000000",
      sourceInputRawAmount: null,
    },
    {
      componentId: emptyControllerUsdceIdentity.componentId,
      economicRole: "future_credit_fence",
      locationId: emptyControllerUsdceIdentity.locationId,
      rawAmount: "1000000",
      sourceInputRawAmount: null,
    },
  ],
  "the controller USDC.e identity must be fenced before the direct handoff lands",
);
assert.deepEqual(
  fundingEconomicSourceReservations(
    depositOnlyHandoff.commitPlan.reservations,
  ).map(({ reservation, rawAmount }) => ({
    componentId: reservation.componentId,
    rawAmount,
  })),
  [
    { componentId: "signer_pusd_12345678", rawAmount: "1500000" },
    { componentId: "deposit_usdce_12345678", rawAmount: "1000000" },
  ],
  "the future controller USDC.e fence must not double-count the incoming source",
);

const [delegatedPusd] = await adapter.list(delegatedPusdPlanningInput());
assert.ok(delegatedPusd);
assert.equal(
  delegatedPusd.option.sourceLegs,
  undefined,
  "a single Router pUSD preparation must not masquerade as a composite source",
);
assert.equal(delegatedPusd.commitPlan.steps.length, 1);
assert.equal(
  delegatedPusd.commitPlan.steps[0]?.executorId,
  POLYMARKET_DEPOSIT_PUSD_FUND_PROFILE_ID,
);
assert.equal(delegatedPusd.commitPlan.steps[0]?.state, "planned");

const [delegatedPusdNeedsApproval] = await adapter.list(
  delegatedPusdPlanningInput("0"),
);
assert.ok(delegatedPusdNeedsApproval);
assert.deepEqual(
  delegatedPusdNeedsApproval.commitPlan.steps.map((step) => ({
    executorId: step.executorId,
    kind: step.actionValidationResult.kind,
    dependsOnOrdinal: step.dependsOnOrdinal,
    ordinal: step.ordinal,
  })),
  [
    {
      executorId: POLYMARKET_DEPOSIT_PUSD_FUND_PROFILE_ID,
      kind: "controller_pusd_router_approval",
      dependsOnOrdinal: null,
      ordinal: 0,
    },
    {
      executorId: POLYMARKET_DEPOSIT_PUSD_FUND_PROFILE_ID,
      kind: undefined,
      dependsOnOrdinal: 0,
      ordinal: 1,
    },
  ],
  "the exact policy-approved controller pUSD approval must precede Router fund when required",
);

const mixedControllerInput = planningInput(
  "1800000",
  "1800000",
  "300000",
  "trade_shortfall",
  "0",
  "0",
  "0",
);
const [delegatedPusdAndUsdce] = await adapter.list({
  ...mixedControllerInput,
  request: {
    ...mixedControllerInput.request,
    serverExecutionProfileId: POLYMARKET_DEPOSIT_PUSD_FUND_PROFILE_ID,
  },
});
assert.ok(delegatedPusdAndUsdce);
assert.equal(
  delegatedPusdAndUsdce.option.safeLabel,
  "Use controller pUSD + USDC.e in one Polymarket funding step",
);
assert.equal(
  delegatedPusdAndUsdce.option.sourceLegs,
  undefined,
  "one Router fund call is one venue-preparation action, not a generic composite route",
);
assert.deepEqual(
  delegatedPusdAndUsdce.commitPlan.reservations.map((entry) => entry.rawAmount),
  ["1500000", "300000"],
);
assert.deepEqual(
  delegatedPusdAndUsdce.commitPlan.steps.map((step) => ({
    kind: step.actionValidationResult.kind,
    dependsOnOrdinal: step.dependsOnOrdinal,
    ordinal: step.ordinal,
  })),
  [
    {
      kind: "controller_usdce_router_approval",
      dependsOnOrdinal: null,
      ordinal: 0,
    },
    {
      kind: "controller_pusd_router_approval",
      dependsOnOrdinal: 0,
      ordinal: 1,
    },
    { kind: undefined, dependsOnOrdinal: 1, ordinal: 2 },
  ],
  "two missing token approvals must be serialized before the one Router fund call",
);

const zeroAllowanceDerivedCapInput = planningInput(
  "0",
  "1800000",
  "300000",
  "trade_shortfall",
  "0",
  "0",
  "0",
);
const [delegatedPusdWithZeroAllowanceDerivedCap] = await adapter.list({
  ...zeroAllowanceDerivedCapInput,
  request: {
    ...zeroAllowanceDerivedCapInput.request,
    serverExecutionProfileId: POLYMARKET_DEPOSIT_PUSD_FUND_PROFILE_ID,
  },
});
assert.ok(
  delegatedPusdWithZeroAllowanceDerivedCap,
  "a missing current Router allowance must not turn an otherwise exact delegated pUSD + USDC.e route into Deposit fallback",
);
assert.deepEqual(
  delegatedPusdWithZeroAllowanceDerivedCap.commitPlan.reservations.map(
    (entry) => entry.rawAmount,
  ),
  ["1500000", "300000"],
);

const relayProfileInput = planningInput();
assert.deepEqual(
  await adapter.list({
    ...relayProfileInput,
    request: {
      ...relayProfileInput.request,
      serverExecutionProfileId: TELEGRAM_RELAY_EVM_FUNDING_PROFILE_ID,
    },
  }),
  [],
  "a Relay profile must not inherit a partial Polygon preparation and become a residual-only composite",
);

const missingExactInput = new PolymarketFundingSourceAdapter(account(false), {
  canonicalRouterAddress: ROUTER,
  usdceAsset: USDCE,
});
const [pUsdOnlyPartial] = await missingExactInput.list(planningInput());
assert.ok(pUsdOnlyPartial);
assert.equal(pUsdOnlyPartial.option.selectable, false);
assert.deepEqual(
  pUsdOnlyPartial.commitPlan.reservations.map((entry) => entry.rawAmount),
  ["1500000"],
  "a missing USDC.e component must not discard a valid partial pUSD contribution",
);

assert.equal(
  (await adapter.list(planningInput("0")))[0]?.option.selectable,
  false,
  "a zero allowance-derived snapshot cap must not hide a client route that can prepare its controller approvals",
);

const partialAdapter = new PolymarketFundingSourceAdapter(
  account(true, "1069075"),
  {
    canonicalRouterAddress: ROUTER,
    usdceAsset: USDCE,
  },
);
const [partial] = await partialAdapter.list(
  planningInput("5000000", "4227649", "1069075"),
);
assert.ok(partial);
assert.equal(partial.option.selectable, false);
assert.equal(partial.compositeEligible, true);
assert.equal(partial.option.expectedDestination?.raw, "2569075");
assert.equal(partial.option.minimumDestination?.raw, "2569075");
assert.equal(
  partial.commitPlan.operation.requestedDestinationAmount?.raw,
  "2569075",
);
assert.deepEqual(
  partial.commitPlan.reservations.map((entry) => entry.rawAmount),
  ["1500000", "1069075"],
);

const relayFloorAdapter = new PolymarketFundingSourceAdapter(
  account(true, "1400000"),
  {
    canonicalRouterAddress: ROUTER,
    usdceAsset: USDCE,
  },
);
for (const purpose of ["add_funds", "manual_rebalance"] as const) {
  const [relayFloorPartial] = await relayFloorAdapter.list(
    planningInput("5000000", "4000000", "1400000", purpose),
  );
  assert.ok(relayFloorPartial);
  assert.equal(relayFloorPartial.option.expectedDestination?.raw, "2900000");
  assert.equal(relayFloorPartial.option.minimumDestination?.raw, "2900000");
  assert.deepEqual(
    relayFloorPartial.commitPlan.reservations.map((entry) => entry.rawAmount),
    ["1500000", "1400000"],
  );
}

const exactShortfallAdapter = new PolymarketFundingSourceAdapter(
  account(true, "2400000"),
  {
    canonicalRouterAddress: ROUTER,
    usdceAsset: USDCE,
  },
);
const [exactShortfallPartial] = await exactShortfallAdapter.list(
  planningInput("5000000", "4000000", "2400000", "trade_shortfall"),
);
assert.ok(exactShortfallPartial);
assert.equal(exactShortfallPartial.option.expectedDestination?.raw, "3900000");
assert.equal(exactShortfallPartial.option.minimumDestination?.raw, "3900000");
assert.deepEqual(
  exactShortfallPartial.commitPlan.reservations.map((entry) => entry.rawAmount),
  ["1500000", "2400000"],
);

const userWalletPartialAdapter = new PolymarketFundingSourceAdapter(
  account(true, "1069075", "user_wallet"),
  {
    canonicalRouterAddress: ROUTER,
    usdceAsset: USDCE,
  },
);
const [userWalletPartial] = await userWalletPartialAdapter.list(
  planningInput("5000000", "4227649", "1069075"),
);
assert.ok(userWalletPartial);
assert.equal(userWalletPartial.commitPlan.steps[0]?.payerRequirement, "user");
assert.equal(userWalletPartial.compositeEligible, false);

for (const purpose of ["convert_asset", "withdrawal"] as const) {
  assert.deepEqual(
    await adapter.list(planningInput("4000000", "4000000", "1500000", purpose)),
    [],
  );
}
for (const purpose of [
  "add_funds",
  "trade_shortfall",
  "manual_rebalance",
] as const) {
  assert.equal(
    (
      await adapter.list(
        planningInput("4000000", "4000000", "1500000", purpose),
      )
    )[0]?.option.amountMode,
    "exact_output",
  );
}

// MAR33: the selected Deposit Wallet is empty, but another internal one
// contains the missing dollar. No native gas or external connection is needed.
const mar33Owner = {
  ...selectedProfile,
  source: "embedded" as const,
  walletId: "wallet_mar33_owner",
  address: otherOwner,
  controllerWalletRef: "mar33_owner_ref",
  serverWalletRef: "mar33_privy",
  signingModes: ["web_client", "privy_authorization"] as const,
  sponsorshipPolicyIds: [PRIVY_USER_AUTHORIZED_EVM_SPONSORSHIP_POLICY_ID],
};
const mar33Deposit = "0x85fff5e1be3b82dcb35048f6d4c9b02f51920f5d";
const mar33Component = component("mar33_pusd", mar33Deposit, PUSD, "1000000", {
  walletId: "wallet_mar33_deposit",
  venueId: "polymarket",
  polymarketFunderKind: "deposit_wallet",
  linkedAddress: otherOwner,
});
const mar33Account: AccountValueReadModel = {
  ...safeSourceAccount,
  nativeGasBalances: [],
  connectedExternalWalletRefs: [],
  projection: { ...safeSourceAccount.projection, components: [mar33Component] },
  cashAvailability: {
    ...safeSourceAccount.cashAvailability,
    components: [
      {
        componentId: mar33Component.componentId,
        availableRaw: "1000000",
        freshness: "fresh",
      },
    ] as unknown as AccountValueReadModel["cashAvailability"]["components"],
  },
  ownership: {
    ...sourceOwnership,
    wallets: [
      selectedProfile,
      mar33Owner,
      {
        ...mar33Owner,
        walletId: "wallet_mar33_deposit",
        address: mar33Deposit,
        source: "smart",
        signingModes: [],
        serverWalletRef: null,
      },
    ],
  },
};
const mar33Input = {
  ...planningInput("7098652", "7098652", "0", "trade_shortfall", "0", "0", "0"),
  internalSourcesOnly: true,
};
const [mar33Funding] = await crossAdapter(mar33Account).list(mar33Input);
assert.ok(mar33Funding);
assert.ok(mar33Funding.option.minimumDestination);
assert.equal(mar33Funding.option.minimumDestination?.raw, "1000000");
assert.equal(isValidFundingCommitPlanBoundary(mar33Funding.commitPlan), true);
assert.equal(
  mar33Funding.commitPlan.steps[0]?.normalizedAction.actorWalletId,
  mar33Owner.walletId,
);
assert.equal(
  mar33Funding.commitPlan.steps[1]?.normalizedAction.senderWalletId,
  mar33Owner.walletId,
);
assert.equal(
  mar33Funding.commitPlan.steps.at(-1)?.normalizedAction.senderWalletId,
  selectedProfile.walletId,
);
assert.equal(
  fundingEconomicSourceReservations(
    mar33Funding.commitPlan.reservations,
  ).reduce((sum, entry) => sum + BigInt(entry.rawAmount), 0n),
  1000000n,
);
assert.equal(
  mar33Funding.commitPlan.reservations.filter(
    (entry) => entry.economicRole === "future_credit_fence",
  ).length,
  2,
);
assert.equal(
  BigInt(mar33Funding.option.minimumDestination.raw) + 1931876n + 4189921n >=
    7098652n,
  true,
);
assert.equal(
  BigInt(mar33Funding.option.minimumDestination.raw) + 1931876n + 4189921n >=
    7204602n,
  false,
);
assert.deepEqual(
  await crossAdapter(mar33Account).list({
    ...mar33Input,
    excludedSourceComponentIds: [mar33Component.componentId],
  }),
  [],
);
assert.deepEqual(
  await crossAdapter(mar33Account).list({
    ...mar33Input,
    request: {
      ...mar33Input.request,
      serverExecutionProfileId: POLYMARKET_DEPOSIT_PUSD_FUND_PROFILE_ID,
    },
  }),
  [],
);
for (const field of [
  "expectedDestinationRaw",
  "expectedDestinationAddress",
  "signerAddress",
]) {
  assert.equal(
    isValidFundingCommitPlanBoundary({
      ...mar33Funding.commitPlan,
      steps: mar33Funding.commitPlan.steps.map((step) =>
        step.actionValidationResult.kind === "owned_deposit_controller_transfer"
          ? {
              ...step,
              actionValidationResult: {
                ...step.actionValidationResult,
                [field]: field === "expectedDestinationRaw" ? "1" : DEPOSIT,
              },
            }
          : step,
      ),
    }),
    false,
  );
}
assert.equal(
  isValidFundingCommitPlanBoundary({
    ...mar33Funding.commitPlan,
    operation: {
      ...mar33Funding.commitPlan.operation,
      supportMetadata: {
        ...mar33Funding.commitPlan.operation.supportMetadata,
        planValidation: {
          validatorId: "polymarket_funding_router_v1",
          version: 4,
        },
      },
    },
  }),
  false,
);
assert.ok(mar33Account.ownership);
const mar33Unowned = {
  ...mar33Account,
  ownership: {
    ...mar33Account.ownership,
    wallets: mar33Account.ownership.wallets.filter(
      (entry) => entry.walletId !== mar33Owner.walletId,
    ),
  },
};
assert.deepEqual(await crossAdapter(mar33Unowned).list(mar33Input), []);

function mar33RelayLeg(
  id: string,
  networkId: string,
  sourceRaw: string,
  expectedRaw: string,
  minimumRaw: string,
  template = mar33Funding,
  assetId = `${id}_usdc`,
): PlannedSourceOption {
  assert.ok(template);
  const templateStep = template.commitPlan.steps.at(-1);
  assert.ok(templateStep);
  const asset = { networkId, assetId, decimals: 6 };
  const location = {
    kind: "wallet" as const,
    locationId: `location_${id}_mar33`,
    accountId: ACCOUNT_ID,
    asset,
    details: { address: `${id}_address`, walletId: `${id}_wallet` },
  };
  const source = { kind: "owned_location" as const, location };
  const expected = { asset: PUSD, raw: expectedRaw };
  const minimum = { asset: PUSD, raw: minimumRaw };
  const option = {
    ...template.option,
    kind: "wallet_asset" as const,
    sourceOptionId: `source_${id}_mar33`,
    source,
    maximumSourceRaw: sourceRaw,
    expectedDestination: expected,
    minimumDestination: minimum,
    requiredActions: [
      {
        kind: "evm_transaction" as const,
        actor: "user" as const,
        safeLabel: id,
        valueMoving: true,
        sponsorship: "requested" as const,
      },
    ],
  };
  return {
    option,
    providerId: "relay",
    routeId: `route_${id}`,
    compositeEligible: true,
    commitPlan: {
      operation: {
        ...template.commitPlan.operation,
        planKind: "wallet_route",
        sourceSnapshot: source,
        supportMetadata: {
          destinationObservation: {
            observerId: "owned_route_destination_observer_v1",
            locationId: "location_pm_deposit_12345678",
            asset: PUSD,
            baselineRaw: "0",
            baselineRevision: "mar33_baseline",
            baselineAsOf: "2026-07-24T12:00:00.000Z",
          },
        },
        requestedSourceAmount: { asset, raw: sourceRaw },
      },
      segments: [
        {
          providerId: "relay",
          adapterId: "relay_quote_v2",
          adapterVersion: 1,
          segmentKind: "cross_network_transfer",
          status: "planned",
          sourceSnapshot: source,
          destinationTargetSnapshot:
            template.commitPlan.operation.destinationTargetSnapshot,
          quotedInput: { asset, raw: sourceRaw },
          quotedExpectedOutput: expected,
          quotedMinOutput: minimum,
          providerQuoteRefCiphertext: `ciphertext_${id}`,
          providerQuoteRefLookupHmac: `hmac_${id}`,
          depositAddressCiphertext: null,
          depositAddressLookupHmac: null,
          lookupKeyVersion: 1,
          refundLocationSnapshot: location,
          quoteExpiresAt: EXPIRES_AT,
        },
      ],
      steps: [
        {
          ...templateStep,
          ordinal: 0,
          segmentOrdinal: 0,
          stepKind: "transaction",
          dependsOnOrdinal: null,
          actionValidationResult: { validatorId: "fixture_relay" },
          normalizedAction: { kind: "evm_transaction" },
        },
      ],
      reservations: [
        {
          segmentOrdinal: 0,
          componentId: `component_${id}_mar33`,
          locationId: location.locationId,
          networkId,
          assetId: asset.assetId,
          assetDecimals: 6,
          rawAmount: sourceRaw,
          mode: "subtract_available",
          expiresAt: EXPIRES_AT,
        },
      ],
    },
  };
}
const mar33Candidates = [
  mar33Funding,
  mar33RelayLeg("solana", "solana:mainnet", "2000000", "1951390", "1931876"),
  mar33RelayLeg("base", "evm:8453", "4281691", "4232244", "4189921"),
];
const mar33CompositeInput = {
  candidates: mar33Candidates,
  requiredDestination: { asset: PUSD, raw: "7098652" },
  destinationUnitPriceUsd: "1",
  maximumFeeUsd: "1",
  maximumFeeBps: 2000,
  executionBoundary: "client_handoff" as const,
};
const mar33Composite = buildCompositeSourceOption(mar33CompositeInput);
assert.ok(
  mar33Composite,
  "historical MAR33 must form a three-source client composite",
);
assert.equal(mar33Composite.option.minimumDestination?.raw, "7121797");
assert.equal(isValidFundingCommitPlanBoundary(mar33Composite.commitPlan), true);

// Production MAR46 retry: Safe USDC.e -> Router plus a separate Safe USDC
// handoff -> Relay. Both handoffs have null segmentOrdinal by design.
const [retryPreparation] = await crossAdapter(mar46Account).list({
  ...mar46Input,
  requiredAmount: { asset: PUSD, raw: "1261927" },
});
assert.ok(retryPreparation);
const retryRelay = mar33RelayLeg(
  "safe_usdc",
  "evm:137",
  "913911",
  "850000",
  "837995",
  retryPreparation,
  RELAY_PINNED_ASSETS.polygonUsdc,
);
assert.equal(retryRelay.option.source.kind, "owned_location");
if (retryRelay.option.source.kind !== "owned_location")
  throw new Error("fixture source");
const retryRelaySteps = buildPolymarketPreRouteHandoffSteps({
  source: {
    preRouteHandoff: {
      kind: "polymarket_safe_to_owned_wallet_v1",
      ownerProfile,
      funderAddress: otherSafe,
      controllerAddress: selectedProfile.address,
      tokenAddress: RELAY_PINNED_ASSETS.polygonUsdc,
      sourceLocation: retryRelay.option.source.location,
    },
  },
  profile: selectedProfile,
  sourceAmount: {
    asset: { ...PUSD, assetId: RELAY_PINNED_ASSETS.polygonUsdc },
    raw: "913911",
  },
  steps: retryRelay.commitPlan.steps,
});
// The same composition contract applies to owned EOA, Safe, Deposit Wallet,
// and mixed preparation chains, not just the latest two-step Router fixture.
for (const preparation of [
  mar46,
  ownedUsdceFunding,
  mar33Funding,
  safeFunding,
  mixedFunding,
]) {
  assert.ok(preparation);
  for (const providerFirst of [false, true]) {
    let ordinalBase = 0;
    const groups = providerFirst
      ? [
          { steps: retryRelaySteps, segment: 0, leg: "provider" },
          { steps: preparation.commitPlan.steps, segment: null, leg: "router" },
        ]
      : [
          { steps: preparation.commitPlan.steps, segment: null, leg: "router" },
          { steps: retryRelaySteps, segment: 0, leg: "provider" },
        ];
    const steps = groups.flatMap((group) => {
      const base = ordinalBase;
      ordinalBase += group.steps.length;
      return group.steps.map((step) => ({
        ...step,
        ordinal: base + step.ordinal,
        dependsOnOrdinal:
          step.dependsOnOrdinal == null ? null : base + step.dependsOnOrdinal,
        actionValidationResult: {
          ...step.actionValidationResult,
          compositeSourceLegId: group.leg,
          compositeSegmentOrdinal: group.segment,
        },
      }));
    });
    assert.equal(
      isValidFundingCommitPlanBoundary({
        operation: {
          ...preparation.commitPlan.operation,
          planKind: "composite_route",
        },
        steps,
      }),
      true,
      "every supported preparation chain composes with an independent provider handoff",
    );
  }
}
for (const providerFirst of [false, true]) {
  const candidate = {
    ...retryRelay,
    commitPlan: { ...retryRelay.commitPlan, steps: retryRelaySteps },
    option: {
      ...retryRelay.option,
      expiresAt: providerFirst
        ? "2026-07-24T12:00:59.000Z"
        : "2026-07-24T12:01:01.000Z",
    },
  };
  const composed = buildCompositeSourceOption({
    ...mar33CompositeInput,
    candidates: [retryPreparation, candidate],
    requiredDestination: { asset: PUSD, raw: "2099922" },
  });
  assert.ok(composed);
  assert.equal(
    isValidFundingCommitPlanBoundary(composed.commitPlan),
    true,
    `Router and provider handoffs stay separate (provider first: ${providerFirst})`,
  );
  const providerStep = composed.commitPlan.steps.find(
    (step) => step.segmentOrdinal === 0,
  );
  const routerStep = composed.commitPlan.steps.find(
    (step) => step.stepKind === "venue_preparation",
  );
  const providerHandoff = composed.commitPlan.steps.find(
    (step) =>
      step.segmentOrdinal === null &&
      step.actionValidationResult.compositeSegmentOrdinal === 0,
  );
  assert.ok(providerStep && routerStep && providerHandoff);
  for (const steps of [
    composed.commitPlan.steps.filter((step) => step !== providerStep),
    composed.commitPlan.steps.map((step) =>
      step === providerStep ? { ...step, dependsOnOrdinal: null } : step,
    ),
    composed.commitPlan.steps.map((step) =>
      step === routerStep
        ? { ...step, dependsOnOrdinal: providerHandoff.ordinal }
        : step,
    ),
    composed.commitPlan.steps.map((step) =>
      step === providerHandoff
        ? {
            ...step,
            actionValidationResult: {
              ...step.actionValidationResult,
              compositeSegmentOrdinal: 9,
            },
          }
        : step,
    ),
    composed.commitPlan.steps.map((step) =>
      step === routerStep
        ? {
            ...step,
            actionValidationResult: {
              ...step.actionValidationResult,
              valid: false,
            },
          }
        : step,
    ),
    composed.commitPlan.steps.map((step) =>
      step === providerHandoff
        ? { ...step, stepKind: "transaction" as const }
        : step,
    ),
  ]) {
    assert.equal(
      isValidFundingCommitPlanBoundary({ ...composed.commitPlan, steps }),
      false,
      "orphan, crossed, mislabeled or invalid contributor cannot bypass validation",
    );
  }
}
assert.equal(
  buildCompositeSourceOption({
    ...mar33CompositeInput,
    requiredDestination: { asset: PUSD, raw: "7204602" },
  }),
  null,
);

console.log(
  "[polymarket-funding-source-adapter-tests] exact and maximum partial multi-input plans, purpose-compatible exact-output preparation, automatic-only composite eligibility, sponsorship, fail-closed cap/allowance handling, and reservations passed",
);
