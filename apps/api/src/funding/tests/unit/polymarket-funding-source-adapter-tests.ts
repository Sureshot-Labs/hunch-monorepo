#!/usr/bin/env tsx

import assert from "node:assert/strict";

import type { AccountValueReadModel } from "../../../account-value/runtime-service.js";
import type { FundingPurpose } from "../../domain/types.js";
import {
  POLYMARKET_DEPOSIT_USDCE_WRAP_PROFILE_ID,
  TELEGRAM_RELAY_EVM_FUNDING_PROFILE_ID,
} from "../../execution/delegated-funding-profile-ids.js";
import { PRIVY_USER_AUTHORIZED_EVM_SPONSORSHIP_POLICY_ID } from "../../execution/sponsorship-policy.js";
import { PolymarketFundingSourceAdapter } from "../../preparation/polymarket-funding-source-adapter.js";
import { polymarketFundingEvidence } from "../../preparation/polymarket-funding-snapshot.js";
import type { FundingSourcePlanningInput } from "../../planner/source-adapter.js";

const ACCOUNT_ID = "account_pm_router_source_12345678";
const SIGNER = "0x00000000000000000000000000000000000000a1";
const DEPOSIT = "0x00000000000000000000000000000000000000a2";
const ROUTER = "0x00000000000000000000000000000000000000a3";
const PUSD = {
  networkId: "evm:137",
  assetId: "0x00000000000000000000000000000000000000b1",
  decimals: 6,
} as const;
const USDCE = {
  networkId: "evm:137",
  assetId: "0x00000000000000000000000000000000000000b2",
  decimals: 6,
} as const;
const EXPIRES_AT = "2026-07-24T12:01:00.000Z";

function component(
  id: string,
  address: string,
  asset: typeof PUSD | typeof USDCE,
  raw: string,
) {
  return {
    componentId: id,
    location: {
      kind: "wallet",
      locationId: `location_${id}`,
      accountId: ACCOUNT_ID,
      asset,
      details: { address },
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
): AccountValueReadModel {
  const components = [
    component("deposit_usdce_12345678", DEPOSIT, USDCE, "1000000"),
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
        depositPusdRaw: "1500000",
        depositLockedRaw: "500000",
        depositUsdceRaw: "1000000",
        signerPusdRaw: "1500000",
        signerUsdceRaw,
        fundingCapRaw,
        routerAddress: ROUTER,
        routerNonceRaw: "7",
        depositRouterUsdceAllowanceRaw: "1000000",
        routerPusdAllowanceRaw: "1500000",
        routerUsdceAllowanceRaw: signerUsdceRaw,
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

function delegatedPlanningInput(): FundingSourcePlanningInput {
  const input = planningInput("1000000", "1000000", "0", "add_funds");
  return {
    ...input,
    request: {
      ...input.request,
      serverExecutionProfileId: POLYMARKET_DEPOSIT_USDCE_WRAP_PROFILE_ID,
    },
  };
}

const adapter = new PolymarketFundingSourceAdapter(account(), {
  canonicalRouterAddress: ROUTER,
  usdceAsset: USDCE,
});
const [planned] = await adapter.list(planningInput());
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
  planningInput().destinationFacts?.venueBinding,
);
assert.deepEqual(
  planned.commitPlan.reservations.map((entry) => entry.rawAmount),
  ["1000000", "1500000", "1500000"],
);
assert.ok(
  planned.commitPlan.reservations.every(
    (entry) =>
      entry.segmentOrdinal === null && entry.mode === "subtract_available",
  ),
);

const delegatedAdapter = new PolymarketFundingSourceAdapter(
  account(false, "0"),
  {
    canonicalRouterAddress: ROUTER,
    usdceAsset: USDCE,
  },
);
const [delegated] = await delegatedAdapter.list(delegatedPlanningInput());
assert.ok(delegated);
assert.deepEqual(delegated.commitPlan.operation.requestedSourceAmount, {
  asset: USDCE,
  raw: "1000000",
});
assert.equal(delegated.commitPlan.steps[0]?.state, "planned");
assert.equal(
  delegated.commitPlan.steps[0]?.executorId,
  POLYMARKET_DEPOSIT_USDCE_WRAP_PROFILE_ID,
);
assert.equal(delegated.option.requiredActions[0]?.actor, "server");
assert.deepEqual(
  delegated.commitPlan.reservations.map((entry) => entry.rawAmount),
  ["1000000"],
  "delegated wrap must bind only the exact received USDC.e amount",
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
assert.deepEqual(await missingExactInput.list(planningInput()), []);

assert.deepEqual(await adapter.list(planningInput("0")), []);

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
assert.equal(partial.option.expectedDestination?.raw, "3569075");
assert.equal(partial.option.minimumDestination?.raw, "3569075");
assert.equal(
  partial.commitPlan.operation.requestedDestinationAmount?.raw,
  "3569075",
);
assert.deepEqual(
  partial.commitPlan.reservations.map((entry) => entry.rawAmount),
  ["1000000", "1500000", "1069075"],
);

const relayFloorAdapter = new PolymarketFundingSourceAdapter(
  account(true, "1400000"),
  {
    canonicalRouterAddress: ROUTER,
    usdceAsset: USDCE,
  },
);
for (const purpose of [
  "add_funds",
  "trade_shortfall",
  "manual_rebalance",
] as const) {
  const [relayFloorPartial] = await relayFloorAdapter.list(
    planningInput("5000000", "4000000", "1400000", purpose),
  );
  assert.ok(relayFloorPartial);
  assert.equal(relayFloorPartial.option.expectedDestination?.raw, "3500000");
  assert.equal(relayFloorPartial.option.minimumDestination?.raw, "3500000");
  assert.deepEqual(
    relayFloorPartial.commitPlan.reservations.map((entry) => entry.rawAmount),
    ["1000000", "1500000", "1000000"],
  );
}

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

console.log(
  "[polymarket-funding-source-adapter-tests] exact and maximum partial multi-input plans, purpose-compatible exact-output preparation, automatic-only composite eligibility, sponsorship, fail-closed cap/allowance handling, and reservations passed",
);
