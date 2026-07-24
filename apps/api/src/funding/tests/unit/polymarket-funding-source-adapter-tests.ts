#!/usr/bin/env tsx

import assert from "node:assert/strict";

import type { AccountValueReadModel } from "../../../account-value/runtime-service.js";
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

function account(includeSignerUsdce = true): AccountValueReadModel {
  const components = [
    component("deposit_usdce_12345678", DEPOSIT, USDCE, "1000000"),
    component("signer_pusd_12345678", SIGNER, PUSD, "1500000"),
    ...(includeSignerUsdce
      ? [component("signer_usdce_12345678", SIGNER, USDCE, "1500000")]
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
          source: "embedded",
          signingModes: ["web_client", "privy_authorization"],
          serverWalletRef: "privy_pm_signer_12345678",
          sponsorshipPolicyIds: [
            PRIVY_USER_AUTHORIZED_EVM_SPONSORSHIP_POLICY_ID,
          ],
        },
      ],
    },
  } as unknown as AccountValueReadModel;
}

function planningInput(): FundingSourcePlanningInput {
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
      purpose: "trade_shortfall",
      requestedDestinationAmount: { asset: PUSD, raw: "4000000" },
      confirmedSourceAmount: null,
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
      spendability: { expiresAt: EXPIRES_AT },
      sourcePlanningEvidence: polymarketFundingEvidence({
        signerAddress: SIGNER,
        depositWallet: DEPOSIT,
        depositPusdRaw: "1500000",
        depositLockedRaw: "500000",
        depositUsdceRaw: "1000000",
        signerPusdRaw: "1500000",
        signerUsdceRaw: "1500000",
        fundingCapRaw: "4000000",
        routerAddress: ROUTER,
        routerNonceRaw: "7",
        depositRouterUsdceAllowanceRaw: "1000000",
        routerPusdAllowanceRaw: "1500000",
        routerUsdceAllowanceRaw: "1500000",
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
    requiredAmount: { asset: PUSD, raw: "4000000" },
    policy: {} as FundingSourcePlanningInput["policy"],
    policyRevision: "policy_pm_router_12345678",
    now: new Date("2026-07-24T12:00:00.000Z"),
  } as unknown as FundingSourcePlanningInput;
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
  planned.commitPlan.reservations.map((entry) => entry.rawAmount),
  ["1000000", "1500000", "1500000"],
);
assert.ok(
  planned.commitPlan.reservations.every(
    (entry) =>
      entry.segmentOrdinal === null && entry.mode === "subtract_available",
  ),
);

const missingExactInput = new PolymarketFundingSourceAdapter(account(false), {
  canonicalRouterAddress: ROUTER,
  usdceAsset: USDCE,
});
assert.deepEqual(await missingExactInput.list(planningInput()), []);

console.log(
  "[polymarket-funding-source-adapter-tests] exact multi-input plan, sponsorship, and fail-closed reservations passed",
);
