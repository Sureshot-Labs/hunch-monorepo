#!/usr/bin/env tsx

import assert from "node:assert/strict";

import { RELAY_PINNED_ASSETS } from "../../../funding-providers/relay/mappings.js";

import type {
  FundingCommitPlan,
  StoredFundingQuote,
} from "../../persistence/funding-operation-repository.js";
import type {
  FundingPlanningStore,
  PersistedFundingPlanningSnapshot,
  PlannedSourceOption,
} from "../../planner/planning-types.js";
import type {
  AssetRef,
  FundingDestinationOption,
  FundingDiscoveryRequest,
  FundingExecutionPlan,
  FundingTarget,
  PlacementDecision,
  SourceOption,
  VenueAccountBinding,
  VenueBindingOption,
} from "../../domain/types.js";
import { resolveFundingDestinationChoice } from "../../domain/selections.js";
import { operationPurposeForExternalRecipient } from "../../domain/withdrawal-binding.js";
import type {
  FrozenPreparationDestination,
  ResolvedDestinationCandidate,
} from "../../planner/destination-adapters.js";
import {
  CombinedFundingDestinationResolver,
  FrozenPreparationDestinationAdapter,
  recommendFundingDestinations,
  toResolvedRouteDestination,
} from "../../planner/destination-adapters.js";
import { DirectIngressFundingSourceAdapter } from "../../planner/direct-ingress-source-adapter.js";
import { decidePlacement } from "../../planner/placement-policy.js";
import {
  classifyRouteExperience,
  routeAmountBand,
} from "../../planner/route-experience.js";
import {
  RelayFirstSourcePlanner,
  assertSingleSegmentExecutionPlan,
  buildRelayWalletSourceOption,
  selectRelayFirstSourceOptions,
} from "../../planner/source-options.js";
import { FundingPlanner } from "../../planner/planner.js";
import { FundingPlannerError } from "../../planner/money.js";
import {
  classifyFundingQuoteConsent,
  FundingQuoteService,
} from "../../planner/quote-service.js";
import { FundingOperationService } from "../../planner/operation-service.js";
import { canonicalJsonHash } from "../../persistence/canonical.js";
import {
  DEFAULT_FUNDING_RUNTIME_POLICY,
  FUNDING_TTL,
  type FundingRuntimePolicy,
} from "../../policies/funding-policy.js";

const NOW = new Date("2026-07-24T12:00:00.000Z");
const USER_ID = "10000000-0000-4000-8000-000000000001";
const POLYGON_PUSD: AssetRef = {
  networkId: "evm:137",
  assetId: RELAY_PINNED_ASSETS.polygonPusd,
  decimals: 6,
};
const BASE_USDC: AssetRef = {
  networkId: "evm:8453",
  assetId: "0x0000000000000000000000000000000000000002",
  decimals: 6,
};
const POLYGON_OTHER_TOKEN: AssetRef = {
  networkId: "evm:137",
  assetId: "0x0000000000000000000000000000000000000003",
  decimals: 18,
};

async function test(name: string, run: () => void | Promise<void>) {
  await run();
  console.log(`[funding-planner-tests] ok ${name}`);
}

await test("quote consent reuses Buy only for pinned stable collateral", () => {
  const polygonPusd: AssetRef = {
    networkId: "evm:137",
    assetId: "0xc011a7e12a19f7b1f670d46f03b03f3342e82dfb",
    decimals: 6,
  };
  const baseUsdc: AssetRef = {
    networkId: "evm:8453",
    assetId: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    decimals: 6,
  };
  const sol: AssetRef = {
    networkId: "solana:mainnet",
    assetId: "11111111111111111111111111111111",
    decimals: 9,
  };
  assert.equal(
    classifyFundingQuoteConsent({
      purpose: "trade_shortfall",
      ingress: false,
      sourceAmounts: [{ amount: { asset: polygonPusd, raw: "1000000" } }],
      expectedDestination: { asset: baseUsdc, raw: "990000" },
      minimumDestination: { asset: baseUsdc, raw: "980000" },
    }),
    "trade_intent",
  );
  assert.equal(
    classifyFundingQuoteConsent({
      purpose: "trade_shortfall",
      ingress: false,
      sourceAmounts: [],
      expectedDestination: { asset: polygonPusd, raw: "1000000" },
      minimumDestination: { asset: polygonPusd, raw: "1000000" },
    }),
    "explicit_economic_review",
  );
  assert.equal(
    classifyFundingQuoteConsent({
      purpose: "trade_shortfall",
      ingress: false,
      sourceAmounts: [{ amount: { asset: sol, raw: "10000000" } }],
      expectedDestination: { asset: baseUsdc, raw: "990000" },
      minimumDestination: { asset: baseUsdc, raw: "980000" },
    }),
    "explicit_economic_review",
  );
  assert.equal(
    classifyFundingQuoteConsent({
      purpose: "trade_shortfall",
      ingress: false,
      sourceAmounts: [
        {
          amount: {
            asset: { ...polygonPusd, decimals: 18 },
            raw: "1000000000000000000",
          },
        },
      ],
      expectedDestination: { asset: baseUsdc, raw: "990000" },
      minimumDestination: { asset: baseUsdc, raw: "980000" },
    }),
    "explicit_economic_review",
  );
  assert.equal(
    classifyFundingQuoteConsent({
      purpose: "trade_shortfall",
      ingress: true,
      sourceAmounts: [{ amount: { asset: polygonPusd, raw: "1000000" } }],
      expectedDestination: { asset: baseUsdc, raw: "990000" },
      minimumDestination: { asset: baseUsdc, raw: "980000" },
    }),
    "external_action",
  );
});

type DeepMutable<T> = T extends readonly (infer Item)[]
  ? DeepMutable<Item>[]
  : T extends object
    ? { -readonly [Key in keyof T]: DeepMutable<T[Key]> }
    : T;

function mutablePolicy(): DeepMutable<FundingRuntimePolicy> {
  return structuredClone(
    DEFAULT_FUNDING_RUNTIME_POLICY,
  ) as DeepMutable<FundingRuntimePolicy>;
}

function target(
  asset: AssetRef,
  venueId = "polymarket",
  address = "0x00000000000000000000000000000000000000aa",
): FundingTarget {
  return {
    kind: "owned_location",
    location: {
      kind: "venue_account",
      locationId: `location_${venueId}_12345678`,
      accountId: USER_ID,
      asset,
      details: {
        venueId,
        accountRef: `account_${venueId}_12345678`,
        controllerWalletId: "wallet_controller_12345678",
        address,
      },
    },
  };
}

function intent(
  purpose: FundingDiscoveryRequest["purpose"],
  requestedRaw: string,
  overrides: Partial<FundingDiscoveryRequest> = {},
): FundingDiscoveryRequest {
  return {
    purpose,
    requestedDestinationAmount: {
      asset: POLYGON_PUSD,
      raw: requestedRaw,
    },
    confirmedSourceAmount: null,
    marketContextId:
      purpose === "trade_shortfall" ? "marketctx_12345678" : null,
    consumerIntent:
      purpose === "trade_shortfall"
        ? {
            venueId: "polymarket",
            marketId: "polymarket:market_12345678",
            marketContextId: "marketctx_12345678",
            side: "BUY",
            spend: { asset: POLYGON_PUSD, raw: requestedRaw },
          }
        : null,
    destinationOptionId: "destination_poly_12345678",
    withdrawalRecipientId: null,
    venueBindingOptionId: null,
    maxFeeUsd: null,
    maxSlippageBps: null,
    deadline: null,
    ...overrides,
  };
}

function destinationOption(
  overrides: Partial<FundingDestinationOption> = {},
): FundingDestinationOption {
  return {
    destinationOptionId: "destination_poly_12345678",
    venueId: "polymarket",
    venueBindingId: "binding_account_poly_12345678",
    venueBindingOptionId: "binding_poly_12345678",
    controllerWalletId: "wallet_poly_12345678",
    safeLabel: "Polymarket · Hunch Trading Wallet",
    requiredAsset: POLYGON_PUSD,
    networkLabel: "Polygon",
    readinessClass: "internal_managed",
    preparationStatus: "ready",
    preparationPurpose: "fund",
    executionMode: "privy_authorization",
    marketClass: null,
    topology: "deposit_wallet",
    inspectionRevision: "inspection_poly_12345678",
    recommended: false,
    selectable: true,
    reasonCodes: [],
    ...overrides,
  };
}

function bindingOption(
  overrides: Partial<VenueBindingOption> = {},
): VenueBindingOption {
  return {
    venueBindingOptionId: "binding_poly_12345678",
    safeLabel: "Polymarket · Hunch Trading Wallet",
    readinessClass: "internal_managed",
    preparationPurpose: "fund",
    marketClass: null,
    topology: "deposit_wallet",
    inspectionRevision: "inspection_poly_12345678",
    selectable: true,
    reasonCodes: [],
    ...overrides,
  };
}

function candidate(
  overrides: Partial<ResolvedDestinationCandidate> = {},
): ResolvedDestinationCandidate {
  const availableNow = overrides.availableNow ?? {
    asset: POLYGON_PUSD,
    raw: "0",
  };
  return {
    destinationLocationPatternId: "venue_polymarket",
    collateralValuation: {
      unitPriceUsd: "1",
      pricePolicyId: "exact-stable-policy-v1",
      asOf: NOW.toISOString(),
      expiresAt: "2026-07-24T12:01:00.000Z",
    },
    spendability: {
      observedAmount: availableNow,
      lockedRaw: "0",
      reservedRaw: "0",
      submittedDebitRaw: "0",
      availableAmount: availableNow,
      revision: "availability_poly_12345678",
      asOf: NOW.toISOString(),
      expiresAt: "2026-07-24T12:01:00.000Z",
    },
    option: destinationOption(),
    bindingOption: bindingOption(),
    target: target(POLYGON_PUSD),
    availableNow,
    ...overrides,
    preparationActions: overrides.preparationActions ?? [],
    completeness: overrides.completeness ?? "complete",
    freshness: overrides.freshness ?? "fresh",
    venueBinding: overrides.venueBinding ?? {
      bindingId: "binding_poly_runtime_12345678",
      venueId: "polymarket",
      controllerWalletId: "wallet_poly_12345678",
      executionWalletId: "wallet_poly_12345678",
      accountRef: "0x00000000000000000000000000000000000000aa",
      settlementLocation: (
        target(POLYGON_PUSD) as Extract<
          FundingTarget,
          { kind: "owned_location" }
        >
      ).location,
      signingMode: "privy_authorization",
    },
    sourcePlanningEvidence: overrides.sourcePlanningEvidence ?? null,
  };
}

function sourceOption(
  requiredRaw: string,
  overrides: Partial<SourceOption> = {},
): SourceOption {
  return {
    sourceOptionId: "source_wallet_12345678",
    kind: "wallet_asset",
    safeLabel: "Polygon wallet pUSD",
    source: {
      kind: "owned_location",
      location: {
        kind: "wallet",
        locationId: "location_source_12345678",
        accountId: USER_ID,
        asset: POLYGON_PUSD,
        details: {
          walletId: "wallet_source_12345678",
          address: "0x00000000000000000000000000000000000000bb",
        },
      },
    },
    amountMode: "exact_output",
    maximumSourceRaw: requiredRaw,
    expectedDestination: { asset: POLYGON_PUSD, raw: requiredRaw },
    minimumDestination: { asset: POLYGON_PUSD, raw: requiredRaw },
    estimatedUsd: null,
    fees: [],
    eta: { minSeconds: 5, maxSeconds: 20 },
    experienceMode: "inline_funding",
    requiredActions: [],
    expiresAt: "2026-07-24T12:01:00.000Z",
    recommended: false,
    selectable: true,
    reasonCodes: [],
    ...overrides,
  };
}

function commitPlan(
  requiredRaw: string,
  option = sourceOption(requiredRaw),
): FundingCommitPlan {
  const destinationSnapshot = {
    destinationOptionId: "destination_poly_12345678",
    locationId: "location_polymarket_12345678",
  };
  return {
    operation: {
      purpose: "add_funds",
      initialState: { status: "in_progress", stage: "committed" },
      experienceMode: "inline",
      planKind: "wallet_route",
      sourceSnapshot: option as never,
      destinationTargetSnapshot: destinationSnapshot,
      externalRecipientId: null,
      venueId: "polymarket",
      marketId: null,
      marketContextSnapshot: null,
      venueBindingSnapshot: bindingOption() as never,
      walletExecutionSnapshot: null,
      placementSnapshot: { mode: "confirmed_deposit_amount" },
      requestedSourceAmount: {
        asset: POLYGON_PUSD,
        raw: requiredRaw,
      } as never,
      requestedDestinationAmount: {
        asset: POLYGON_PUSD,
        raw: requiredRaw,
      } as never,
    },
    segments: [
      {
        providerId: "relay",
        adapterId: "relay_quote_v2",
        adapterVersion: 1,
        segmentKind: "same_network_swap",
        status: "planned",
        sourceSnapshot: option as never,
        destinationTargetSnapshot: destinationSnapshot,
        quotedInput: {
          asset: POLYGON_PUSD,
          raw: requiredRaw,
        } as never,
        quotedExpectedOutput: {
          asset: POLYGON_PUSD,
          raw: requiredRaw,
        } as never,
        quotedMinOutput: {
          asset: POLYGON_PUSD,
          raw: requiredRaw,
        } as never,
        providerQuoteRefCiphertext: "ciphertext:relay-quote",
        providerQuoteRefLookupHmac: "a".repeat(64),
        depositAddressCiphertext: null,
        depositAddressLookupHmac: null,
        lookupKeyVersion: 1,
        refundLocationSnapshot: null,
        quoteExpiresAt: "2026-07-24T12:01:00.000Z",
      },
    ],
    steps: [],
    reservations: [],
  };
}

function plannedSource(requiredRaw: string): PlannedSourceOption {
  const option = sourceOption(requiredRaw);
  return {
    option,
    commitPlan: commitPlan(requiredRaw, option),
    routeId: "relay_polygon_pusd",
    providerId: "relay",
  };
}

function plannedVenuePreparationSource(
  requiredRaw: string,
  payerRequirement: "user" | "privy_sponsor",
): PlannedSourceOption {
  const option = sourceOption(requiredRaw, {
    sourceOptionId: `source_preparation_${payerRequirement}_12345678`,
    kind: "venue_preparation",
    safeLabel: "Prepare trading balance",
    source: {
      kind: "venue_preparation",
      venueId: "fixture_venue",
      venueBindingId: "binding_fixture_12345678",
      inputCount: 1,
    },
    experienceMode: "prepare_first",
  });
  const plan = commitPlan(requiredRaw, option);
  return {
    option,
    commitPlan: {
      ...plan,
      operation: {
        ...plan.operation,
        experienceMode: "prepare_first",
        planKind: "venue_preparation",
      },
      segments: [],
      steps: [
        {
          ordinal: 0,
          segmentOrdinal: null,
          stepKind: "venue_preparation",
          state: "action_required",
          actionFingerprint: `fingerprint_${payerRequirement}_12345678`,
          executorId: "wallet_profile_evm_v1",
          payerRequirement,
          dependsOnOrdinal: null,
          normalizedAction: { kind: "evm_transaction" },
          actionValidationResult: { validatorId: "fixture_preparation_v1" },
        },
      ],
      reservations: [
        {
          segmentOrdinal: null,
          componentId: "component_preparation_12345678",
          locationId: "location_preparation_12345678",
          networkId: POLYGON_PUSD.networkId,
          assetId: POLYGON_PUSD.assetId,
          assetDecimals: POLYGON_PUSD.decimals,
          rawAmount: requiredRaw,
          mode: "subtract_available",
          expiresAt: option.expiresAt,
        },
      ],
    },
    routeId: null,
    providerId: null,
  };
}

class MemoryPlanningStore implements FundingPlanningStore {
  readonly rows = new Map<string, PersistedFundingPlanningSnapshot>();

  async create(
    input: Parameters<FundingPlanningStore["create"]>[0],
  ): Promise<PersistedFundingPlanningSnapshot> {
    const row: PersistedFundingPlanningSnapshot = {
      id: input.projection.liquidityProjectionId,
      userId: input.userId,
      request: input.request,
      projection: input.projection,
      plannerSnapshot: input.plannerSnapshot,
      policyVersion: input.policyVersion,
      policyRevision: input.policyRevision,
      ownershipRevision: input.ownershipRevision,
      expiresAt: input.expiresAt,
      createdAt: NOW,
    };
    this.rows.set(row.id, row);
    return row;
  }

  async fetchOwnedCurrent(
    input: Parameters<FundingPlanningStore["fetchOwnedCurrent"]>[0],
  ): Promise<PersistedFundingPlanningSnapshot | null> {
    const row = this.rows.get(input.projectionId);
    return row?.userId === input.userId &&
      row.expiresAt.getTime() > input.now.getTime()
      ? row
      : null;
  }
}

await test("Placement Policy keeps Add Funds 100 distinct from trade 5 shortfall", () => {
  const policy = mutablePolicy();
  const addFunds = decidePlacement({
    intent: intent("add_funds", "100000000"),
    target: target(POLYGON_PUSD),
    targetVenueId: "polymarket",
    targetRequirement: { asset: POLYGON_PUSD, raw: "100000000" },
    availableNow: { asset: POLYGON_PUSD, raw: "2000000" },
    selectionReason: "explicit",
    policy,
  });
  assert.equal(addFunds.mode, "confirmed_deposit_amount");
  assert.equal(addFunds.destinationRequirement.raw, "100000000");

  const trade = decidePlacement({
    intent: intent("trade_shortfall", "5000000"),
    target: target(POLYGON_PUSD),
    targetVenueId: "polymarket",
    targetRequirement: { asset: POLYGON_PUSD, raw: "5000000" },
    availableNow: { asset: POLYGON_PUSD, raw: "2000000" },
    selectionReason: "current_trade",
    policy,
  });
  assert.equal(trade.mode, "trade_shortfall_only");
  assert.equal(trade.destinationRequirement.raw, "3000000");
  assert.equal(trade.boundedBuffer, null);
});

await test("trade buffer is requested explicitly and bounded by raw and USD caps", () => {
  const policy = mutablePolicy();
  policy.placement.maximumBufferBps = 1_000;
  policy.placement.maximumBufferUsd = "1";
  const base = {
    intent: intent("trade_shortfall", "5000000"),
    target: target(POLYGON_PUSD),
    targetVenueId: "polymarket",
    targetRequirement: { asset: POLYGON_PUSD, raw: "5000000" },
    availableNow: { asset: POLYGON_PUSD, raw: "2000000" },
    selectionReason: "current_trade" as const,
    policy,
  };
  const placement = decidePlacement({
    ...base,
    requestedBuffer: {
      amount: { asset: POLYGON_PUSD, raw: "200000" },
      estimatedUsd: "0.2",
    },
  });
  assert.equal(placement.destinationRequirement.raw, "3200000");
  assert.equal(placement.boundedBuffer?.raw, "200000");
  assert.throws(
    () =>
      decidePlacement({
        ...base,
        requestedBuffer: {
          amount: { asset: POLYGON_PUSD, raw: "400000" },
          estimatedUsd: "0.4",
        },
      }),
    /buffer exceeds/i,
  );
  assert.throws(
    () =>
      decidePlacement({
        ...base,
        requestedBuffer: {
          amount: { asset: POLYGON_PUSD, raw: "100000" },
          estimatedUsd: "2",
        },
      }),
    /buffer exceeds/i,
  );
});

await test("trade shortfall refills up to the bounded executable route floor", () => {
  const policy = mutablePolicy();
  const placement = decidePlacement({
    intent: intent("trade_shortfall", "1000000"),
    target: target(POLYGON_PUSD),
    targetVenueId: "polymarket",
    targetRequirement: { asset: POLYGON_PUSD, raw: "1000000" },
    availableNow: { asset: POLYGON_PUSD, raw: "940000" },
    minimumExecutableDestination: {
      asset: POLYGON_PUSD,
      raw: "1000000",
    },
    selectionReason: "current_trade",
    policy,
  });

  assert.equal(placement.destinationRequirement.raw, "1000000");
  assert.equal(placement.boundedBuffer?.raw, "940000");

  const alreadyFunded = decidePlacement({
    intent: intent("trade_shortfall", "1000000"),
    target: target(POLYGON_PUSD),
    targetVenueId: "polymarket",
    targetRequirement: { asset: POLYGON_PUSD, raw: "1000000" },
    availableNow: { asset: POLYGON_PUSD, raw: "1000000" },
    minimumExecutableDestination: {
      asset: POLYGON_PUSD,
      raw: "1000000",
    },
    selectionReason: "current_trade",
    policy,
  });
  assert.equal(alreadyFunded.destinationRequirement.raw, "0");
  assert.equal(alreadyFunded.boundedBuffer, null);

  const belowRouteFloor = decidePlacement({
    intent: intent("trade_shortfall", "500000"),
    target: target(POLYGON_PUSD),
    targetVenueId: "polymarket",
    targetRequirement: { asset: POLYGON_PUSD, raw: "500000" },
    availableNow: { asset: POLYGON_PUSD, raw: "490000" },
    minimumExecutableDestination: {
      asset: POLYGON_PUSD,
      raw: "1000000",
    },
    selectionReason: "current_trade",
    policy,
  });
  assert.equal(belowRouteFloor.destinationRequirement.raw, "500000");
  assert.equal(belowRouteFloor.boundedBuffer?.raw, "490000");
});

await test("Placement Policy has no Base parking or rebalance path", () => {
  const policy = mutablePolicy();
  assert.throws(
    () =>
      decidePlacement({
        intent: intent("manual_rebalance", "1000000"),
        target: target(BASE_USDC, "limitless"),
        targetVenueId: "limitless",
        targetRequirement: { asset: BASE_USDC, raw: "1000000" },
        availableNow: { asset: BASE_USDC, raw: "0" },
        selectionReason: "explicit",
        policy,
      }),
    /rebalance/i,
  );
});

await test("configurable recommendation never selects among real alternatives", () => {
  const options = recommendFundingDestinations(
    [
      destinationOption(),
      destinationOption({
        destinationOptionId: "destination_limitless_12345678",
        venueId: "limitless",
        venueBindingOptionId: "binding_limitless_12345678",
        safeLabel: "Limitless · Hunch Trading Wallet",
        requiredAsset: BASE_USDC,
        networkLabel: "Base",
        topology: "embedded_eoa",
        inspectionRevision: "inspection_limitless_12345678",
      }),
    ],
    ["limitless", "polymarket"],
  );
  assert.equal(options.filter((option) => option.recommended).length, 1);
  assert.equal(
    options.find((option) => option.recommended)?.venueId,
    "limitless",
  );
});

await test("frozen adapters preserve venue topology and accept a new registry entry", async () => {
  const binding = (
    venueId: string,
    id: string,
    asset: AssetRef,
  ): VenueAccountBinding => ({
    bindingId: `binding_${id}_12345678`,
    venueId,
    controllerWalletId: `wallet_${id}_controller`,
    executionWalletId: `wallet_${id}_execution`,
    accountRef: `account_${id}_12345678`,
    settlementLocation: (
      target(asset, venueId) as Extract<
        FundingTarget,
        { kind: "owned_location" }
      >
    ).location,
    signingMode: "privy_authorization",
  });
  const fact = (
    venueId: string,
    topology: string,
    marketClass: string,
    asset: AssetRef,
    purpose: "fund" | "buy",
  ): FrozenPreparationDestination => {
    const id = `${venueId}_${topology}_${marketClass}_${purpose}`;
    const exactBinding = binding(venueId, id, asset);
    const inspectionRevision = `inspection_${id}_12345678`;
    return {
      venueId,
      destinationLocationPatternId: `venue_${venueId}`,
      collateralValuation: {
        unitPriceUsd: "1",
        pricePolicyId: "exact-stable-policy-v1",
        asOf: NOW.toISOString(),
        expiresAt: "2027-07-24T12:00:00.000Z",
      },
      spendability: {
        observedAmount: { asset, raw: "0" },
        lockedRaw: "0",
        reservedRaw: "0",
        submittedDebitRaw: "0",
        availableAmount: { asset, raw: "0" },
        revision: `availability_${id}_12345678`,
        asOf: NOW.toISOString(),
        expiresAt: "2027-07-24T12:00:00.000Z",
      },
      bindingOption: {
        venueBindingOptionId: `bindingopt_${id}_12345678`,
        safeLabel: `${venueId} ${topology} ${marketClass} ${purpose}`,
        readinessClass: "internal_managed",
        preparationPurpose: purpose,
        marketClass,
        topology,
        inspectionRevision,
        selectable: true,
        reasonCodes: [],
      },
      preparation: {
        status: "ready",
        binding: exactBinding,
        safeLabel: `${venueId} ${topology} ${marketClass} ${purpose}`,
        purpose,
        marketClass,
        readinessClass: "internal_managed",
        executionMode: "privy_authorization",
        topology,
        inspectionRevision,
        inspectedAt: NOW.toISOString(),
        expiresAt: "2027-07-24T12:00:00.000Z",
        requiredActions: [],
        postconditions: [],
        reasonCodes: [],
        evidence: { facts: {}, checks: [] },
      },
      target: target(asset, venueId),
      requiredAsset: asset,
      networkLabel: venueId === "polymarket" ? "Polygon" : "Base",
      sourcePlanningEvidence: null,
    };
  };
  const facts = [
    fact("polymarket", "signer_eoa", "standard", POLYGON_PUSD, "fund"),
    fact("polymarket", "magic_proxy", "standard", POLYGON_PUSD, "fund"),
    fact("polymarket", "safe_proxy", "neg_risk", POLYGON_PUSD, "buy"),
    fact("polymarket", "deposit_wallet", "neg_risk", POLYGON_PUSD, "buy"),
    fact("limitless", "embedded_eoa", "clob", BASE_USDC, "buy"),
    fact("limitless", "embedded_eoa", "amm", BASE_USDC, "buy"),
    fact("future_venue", "future_binding", "spot", BASE_USDC, "fund"),
  ] as const;
  const mutations = 0;
  const resolver = async () => {
    assert.equal(mutations, 0);
    return facts;
  };
  const combined = new CombinedFundingDestinationResolver(
    [
      new FrozenPreparationDestinationAdapter(
        "polymarket",
        ["standard", "neg_risk"],
        resolver,
        () => NOW,
      ),
      new FrozenPreparationDestinationAdapter(
        "limitless",
        ["clob", "clob_neg_risk", "amm", "amm_neg_risk"],
        resolver,
        () => NOW,
      ),
      new FrozenPreparationDestinationAdapter(
        "future_venue",
        ["spot"],
        resolver,
        () => NOW,
      ),
    ],
    ["polymarket", "limitless", "future_venue"],
  );
  const polymarket = await combined.listOptions({
    accountId: USER_ID,
    purpose: "fund",
    marketContextId: null,
    marketClass: "standard",
    compatibleVenueBindingOptionIds: null,
  });
  assert.deepEqual(polymarket.map((option) => option.topology).sort(), [
    "magic_proxy",
    "signer_eoa",
  ]);
  const limitlessClob = await combined.listOptions({
    accountId: USER_ID,
    purpose: "buy",
    marketContextId: "marketctx_clob_12345678",
    marketClass: "clob",
    compatibleVenueBindingOptionIds: null,
  });
  const limitlessAmm = await combined.listOptions({
    accountId: USER_ID,
    purpose: "buy",
    marketContextId: "marketctx_amm_12345678",
    marketClass: "amm",
    compatibleVenueBindingOptionIds: null,
  });
  assert.equal(limitlessClob.length, 1);
  assert.equal(limitlessClob[0]?.marketClass, "clob");
  assert.equal(limitlessAmm.length, 1);
  assert.equal(limitlessAmm[0]?.marketClass, "amm");
  const futureVenue = await combined.listOptions({
    accountId: USER_ID,
    purpose: "fund",
    marketContextId: null,
    marketClass: "spot",
    compatibleVenueBindingOptionIds: null,
  });
  assert.equal(futureVenue.length, 1);
  assert.equal(futureVenue[0]?.venueId, "future_venue");
  assert.equal(mutations, 0);
});

await test("unknown or slow route experience is operational prepare_first", () => {
  const policy = structuredClone(DEFAULT_FUNDING_RUNTIME_POLICY);
  const route = {
    routeId: "relay_polygon_pusd",
    enabled: true,
    providerId: "relay",
    capability: "same_network_swap" as const,
    adapterId: "relay_quote_v2",
    adapterVersion: 1,
    sourceLocationPatternId: "wallet_polygon",
    destinationLocationPatternId: "venue_polymarket",
    sourceAsset: POLYGON_PUSD,
    destinationAsset: POLYGON_PUSD,
    fixtureIds: ["fixture_relay_12345678"],
    actionValidatorId: "validator_relay",
    networkExecutorId: "executor_evm",
    reconcilerId: "reconciler_relay",
    refundSemanticsId: "refund_relay",
    destinationObserverId: "observer_relay",
    experienceMode: "inline" as const,
    measuredObservationCount: 50,
    minimumInlineObservationCount: 20,
    fallbackKind: null,
    depositAddress: null,
  };
  assert.equal(
    classifyRouteExperience({
      route,
      global: policy.routeExperience,
      observation: null,
    }).mode,
    "prepare_first",
  );
  assert.equal(
    classifyRouteExperience({
      route,
      global: policy.routeExperience,
      observation: {
        observationCount: 50,
        succeededCount: 50,
        p95LatencyMs: 60_000,
      },
    }).mode,
    "prepare_first",
  );
  assert.equal(
    classifyRouteExperience({
      route,
      global: policy.routeExperience,
      observation: {
        observationCount: 50,
        succeededCount: 49,
        p95LatencyMs: 20_000,
      },
    }).mode,
    "inline_funding",
  );
});

await test("route amount bands match normative USD boundaries exactly", () => {
  assert.equal(routeAmountBand(null), "unknown");
  assert.equal(routeAmountBand("99.999999"), "usd_lt_100");
  assert.equal(routeAmountBand("100"), "usd_100_500");
  assert.equal(routeAmountBand("500"), "usd_100_500");
  assert.equal(routeAmountBand("500.000001"), "usd_gt_500");
});

await test("Relay-first source selection rejects another provider and second segment", () => {
  const route = {
    routeId: "relay_polygon_pusd",
    enabled: true,
    providerId: "relay",
    capability: "same_network_swap" as const,
    adapterId: "relay_quote_v2",
    adapterVersion: 1,
    sourceLocationPatternId: "wallet_polygon",
    destinationLocationPatternId: "venue_polymarket",
    sourceAsset: POLYGON_PUSD,
    destinationAsset: POLYGON_PUSD,
    fixtureIds: ["fixture_relay_12345678"],
    actionValidatorId: "validator_relay",
    networkExecutorId: "executor_evm",
    reconcilerId: "reconciler_relay",
    refundSemanticsId: "refund_relay",
    destinationObserverId: "observer_relay",
    experienceMode: "prepare_first" as const,
    measuredObservationCount: 0,
    minimumInlineObservationCount: 20,
    fallbackKind: null,
    depositAddress: null,
  };
  const policy = mutablePolicy();
  policy.providers = [
    {
      providerId: "relay",
      enabledCapabilities: ["same_network_swap"],
    },
  ];
  policy.routes = [route];
  const plan = commitPlan("1000000");
  const executionPlan: FundingExecutionPlan = {
    kind: "wallet_route",
    segments: [
      {
        segmentId: "segment_relay_12345678",
        providerId: "relay",
        adapterId: "relay_quote_v2",
        adapterVersion: 1,
        source: sourceOption("1000000").source,
        destination: target(POLYGON_PUSD),
        amountMode: "exact_output",
      },
    ],
  };
  const selected = selectRelayFirstSourceOptions({
    candidates: [
      {
        routeId: route.routeId,
        providerId: "across",
        routeEnabled: true,
        sourceOption: sourceOption("1000000", {
          sourceOptionId: "source_across_12345678",
        }),
        executionPlan,
        commitPlan: plan,
      },
      {
        routeId: route.routeId,
        providerId: "relay",
        routeEnabled: true,
        sourceOption: sourceOption("1000000"),
        executionPlan,
        commitPlan: plan,
      },
    ],
    requiredDestination: { asset: POLYGON_PUSD, raw: "1000000" },
    policy,
  });
  assert.equal(selected.sources.length, 1);
  assert.equal(selected.sources[0]?.providerId, "relay");

  const exactInput = selectRelayFirstSourceOptions({
    candidates: [
      {
        routeId: route.routeId,
        providerId: "relay",
        routeEnabled: true,
        sourceOption: sourceOption("1000000", {
          amountMode: "exact_input",
          expectedDestination: { asset: POLYGON_PUSD, raw: "990000" },
          minimumDestination: { asset: POLYGON_PUSD, raw: "980000" },
        }),
        executionPlan,
        commitPlan: plan,
      },
    ],
    requiredDestination: { asset: POLYGON_PUSD, raw: "1000000" },
    policy,
  });
  assert.equal(exactInput.sources[0]?.option.selectable, true);
  assert.deepEqual(exactInput.sources[0]?.option.reasonCodes, []);

  const partialExactOutput = selectRelayFirstSourceOptions({
    candidates: [
      {
        routeId: route.routeId,
        providerId: "relay",
        routeEnabled: true,
        sourceOption: sourceOption("600000"),
        executionPlan,
        commitPlan: commitPlan("600000"),
      },
    ],
    requiredDestination: { asset: POLYGON_PUSD, raw: "1000000" },
    policy,
  });
  assert.equal(partialExactOutput.sources[0]?.option.selectable, false);
  assert.equal(partialExactOutput.sources[0]?.compositeEligible, true);

  const twoSegments = {
    kind: "wallet_route",
    segments: [
      executionPlan.segments[0],
      {
        ...executionPlan.segments[0],
        segmentId: "segment_second_12345678",
      },
    ],
  } as unknown as FundingExecutionPlan;
  assert.throws(
    () => assertSingleSegmentExecutionPlan(twoSegments),
    /second-segment|staged/i,
  );
});

await test("Relay-first source planner asks only one exact Relay route", async () => {
  const relayRoute = {
    routeId: "relay_polygon_pusd",
    enabled: true,
    providerId: "relay",
    capability: "same_network_swap" as const,
    adapterId: "relay_quote_v2",
    adapterVersion: 1,
    sourceLocationPatternId: "wallet_polygon",
    destinationLocationPatternId: "venue_polymarket",
    sourceAsset: POLYGON_PUSD,
    destinationAsset: POLYGON_PUSD,
    fixtureIds: ["fixture_relay_12345678"],
    actionValidatorId: "validator_relay",
    networkExecutorId: "executor_evm",
    reconcilerId: "reconciler_relay",
    refundSemanticsId: "refund_relay",
    destinationObserverId: "observer_relay",
    experienceMode: "prepare_first" as const,
    measuredObservationCount: 0,
    minimumInlineObservationCount: 20,
    fallbackKind: null,
    depositAddress: null,
  };
  const policy = mutablePolicy();
  policy.providers = [
    {
      providerId: "relay",
      enabledCapabilities: ["same_network_swap"],
    },
    {
      providerId: "across",
      enabledCapabilities: ["same_network_swap"],
    },
  ];
  policy.routes = [
    relayRoute,
    {
      ...relayRoute,
      routeId: "across_polygon_pusd",
      providerId: "across",
      adapterId: "across_legacy",
    },
  ];
  const exactDestination = candidate();
  const request = intent("add_funds", "1000000");
  const placement = decidePlacement({
    intent: request,
    target: exactDestination.target,
    targetVenueId: "polymarket",
    targetRequirement: { asset: POLYGON_PUSD, raw: "1000000" },
    availableNow: exactDestination.availableNow,
    selectionReason: "explicit",
    policy,
  });
  const exactSource = sourceOption("1000000").source;
  let relayCalls = 0;
  const planner = new RelayFirstSourcePlanner({
    listEligibleSources: async () => [
      {
        componentId: "component_blocked_12345678",
        sourceLocationPatternId: "wallet_polygon",
        safeLabel: "Blocked source",
        source: exactSource,
        quoteInputAmount: { asset: POLYGON_PUSD, raw: "1000000" },
        maximumSourceRaw: "1000000",
        maximumSlippageBps: 100,
        estimatedUsd: "1",
        transferable: false,
        riskEligible: true,
        walletExecutionReady: true,
        nativeGasReady: true,
        freshness: "fresh",
      },
      {
        componentId: "component_wallet_12345678",
        sourceLocationPatternId: "wallet_polygon",
        safeLabel: "Polygon wallet pUSD",
        source: exactSource,
        quoteInputAmount: { asset: POLYGON_PUSD, raw: "1000000" },
        maximumSourceRaw: "2000000",
        maximumSlippageBps: 100,
        estimatedUsd: "1",
        transferable: true,
        riskEligible: true,
        walletExecutionReady: true,
        nativeGasReady: true,
        freshness: "fresh",
      },
    ],
    quoteRelay: async ({
      route,
      sourceAmount,
      minimumOutput,
      signal,
      timeoutMs,
    }) => {
      relayCalls += 1;
      assert.equal(route.providerId, "relay");
      assert.equal(route.routeId, "relay_polygon_pusd");
      assert.equal(timeoutMs, 5_000);
      assert.equal(signal.aborted, false);
      const executionPlan: FundingExecutionPlan = {
        kind: "wallet_route",
        segments: [
          {
            segmentId: "segment_relay_orchestrated_12345678",
            providerId: "relay",
            adapterId: "relay_quote_v2",
            adapterVersion: 1,
            source: exactSource,
            destination: exactDestination.target,
            amountMode: "exact_input",
          },
        ],
      };
      return {
        sourceAmount,
        sourceEstimatedUsd: "1",
        candidate: {
          providerId: "relay",
          adapterVersion: 1,
          capability: "same_network_swap",
          amountMode: "exact_input",
          source: exactSource,
          destination: exactDestination.target,
          expectedOutput: minimumOutput,
          minimumOutput,
          fees: [],
          eta: { minSeconds: 5, maxSeconds: 15 },
          expiresAt: "2026-07-24T12:00:30.000Z",
          actionKinds: ["evm_transaction"],
          refundSemantics: "owned_refund",
          opaqueQuoteRef: "opaque_relay_quote_orchestrated_12345678",
        },
        feeUsd: [],
        minimumDestinationEstimatedUsd: "1",
        executionPlan,
        commitPlan: commitPlan(sourceAmount.raw),
      };
    },
    observeRoute: async () => null,
  });
  const plannerInput = {
    accountId: USER_ID,
    request,
    marketContext: null,
    destination: toResolvedRouteDestination(exactDestination),
    placement,
    requiredAmount: { asset: POLYGON_PUSD, raw: "1000000" },
    policy,
    policyRevision: "policy_revision_12345678",
    now: NOW,
  } as const;
  const sources = await planner.list(plannerInput);
  assert.equal(relayCalls, 1);
  assert.equal(sources.length, 1);
  assert.equal(sources[0]?.providerId, "relay");
  assert.equal(sources[0]?.option.amountMode, "exact_input");
  assert.deepEqual(
    sources[0]?.commitPlan.operation.destinationTargetSnapshot,
    exactDestination.target,
  );
  assert.deepEqual(
    sources[0]?.commitPlan.operation.placementSnapshot,
    placement,
  );

  let aborted = false;
  const timedOutPlanner = new RelayFirstSourcePlanner(
    {
      listEligibleSources: async () => [
        {
          componentId: "component_wallet_timeout_12345678",
          sourceLocationPatternId: "wallet_polygon",
          safeLabel: "Polygon wallet pUSD",
          source: exactSource,
          quoteInputAmount: { asset: POLYGON_PUSD, raw: "1000000" },
          maximumSourceRaw: "2000000",
          maximumSlippageBps: 100,
          estimatedUsd: "1",
          transferable: true,
          riskEligible: true,
          walletExecutionReady: true,
          nativeGasReady: true,
          freshness: "fresh",
        },
      ],
      quoteRelay: async ({ signal }) =>
        new Promise((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              resolve(null);
            },
            { once: true },
          );
        }),
      observeRoute: async () => {
        throw new Error("timed-out quote must not load route experience");
      },
    },
    { relayQuoteTimeoutMs: 5, totalPlannerTimeoutMs: 10 },
  );
  assert.deepEqual(await timedOutPlanner.discover(plannerInput), {
    sources: [],
    reasonCodes: ["provider_status_unknown"],
  });
  assert.equal(aborted, true);

  let resilientQuoteCalls = 0;
  const resilientPlanner = new RelayFirstSourcePlanner({
    listEligibleSources: async () => [
      {
        componentId: "component_invalid_quote_12345678",
        sourceLocationPatternId: "wallet_polygon",
        safeLabel: "Provider-drifted source",
        source: exactSource,
        quoteInputAmount: { asset: POLYGON_PUSD, raw: "1000000" },
        maximumSourceRaw: "2000000",
        maximumSlippageBps: 100,
        estimatedUsd: "1",
        transferable: true,
        riskEligible: true,
        walletExecutionReady: true,
        nativeGasReady: true,
        freshness: "fresh",
      },
      {
        componentId: "component_valid_quote_12345678",
        sourceLocationPatternId: "wallet_polygon",
        safeLabel: "Valid source",
        source: exactSource,
        quoteInputAmount: { asset: POLYGON_PUSD, raw: "1000000" },
        maximumSourceRaw: "2000000",
        maximumSlippageBps: 100,
        estimatedUsd: "1",
        transferable: true,
        riskEligible: true,
        walletExecutionReady: true,
        nativeGasReady: true,
        freshness: "fresh",
      },
    ],
    quoteRelay: async ({ source, sourceAmount, minimumOutput }) => {
      resilientQuoteCalls += 1;
      if (source.componentId === "component_invalid_quote_12345678") {
        throw new FundingPlannerError(
          "provider_unavailable",
          "Relay funding quote failed validation",
        );
      }
      return {
        sourceAmount,
        sourceEstimatedUsd: "1",
        candidate: {
          providerId: "relay",
          adapterVersion: 1,
          capability: "same_network_swap",
          amountMode: "exact_input",
          source: exactSource,
          destination: exactDestination.target,
          expectedOutput: minimumOutput,
          minimumOutput,
          fees: [],
          eta: { minSeconds: 5, maxSeconds: 15 },
          expiresAt: "2026-07-24T12:00:30.000Z",
          actionKinds: ["evm_transaction"],
          refundSemantics: "owned_refund",
          opaqueQuoteRef: "opaque_relay_quote_resilient_12345678",
        },
        feeUsd: [],
        minimumDestinationEstimatedUsd: "1",
        executionPlan: {
          kind: "wallet_route",
          segments: [
            {
              segmentId: "segment_relay_resilient_12345678",
              providerId: "relay",
              adapterId: "relay_quote_v2",
              adapterVersion: 1,
              source: exactSource,
              destination: exactDestination.target,
              amountMode: "exact_input",
            },
          ],
        },
        commitPlan: commitPlan(sourceAmount.raw),
      };
    },
    observeRoute: async () => null,
  });
  const resilientSources = await resilientPlanner.list(plannerInput);
  assert.equal(resilientQuoteCalls, 2);
  assert.equal(resilientSources.length, 1);
  assert.equal(resilientSources[0]?.option.safeLabel, "Valid source");

  let mixedFailureQuoteCalls = 0;
  const mixedFailurePlanner = new RelayFirstSourcePlanner({
    listEligibleSources: async () => [
      {
        componentId: "component_definitive_rejection_12345678",
        sourceLocationPatternId: "wallet_polygon",
        safeLabel: "Amount rejected",
        source: exactSource,
        quoteInputAmount: { asset: POLYGON_PUSD, raw: "1791747" },
        quoteMinimumOutput: { asset: POLYGON_PUSD, raw: "1773829" },
        maximumSourceRaw: "1791747",
        maximumSlippageBps: 100,
        estimatedUsd: "1.79",
        transferable: true,
        riskEligible: true,
        walletExecutionReady: true,
        nativeGasReady: true,
        freshness: "fresh",
      },
      {
        componentId: "component_parallel_provider_failure_12345678",
        sourceLocationPatternId: "wallet_polygon",
        safeLabel: "Provider-failed source",
        source: exactSource,
        quoteInputAmount: { asset: POLYGON_PUSD, raw: "500000" },
        quoteMinimumOutput: { asset: POLYGON_PUSD, raw: "495000" },
        maximumSourceRaw: "500000",
        maximumSlippageBps: 100,
        estimatedUsd: "0.5",
        transferable: true,
        riskEligible: true,
        walletExecutionReady: true,
        nativeGasReady: true,
        freshness: "fresh",
      },
    ],
    quoteRelay: async ({ source }) => {
      mixedFailureQuoteCalls += 1;
      if (source.componentId === "component_definitive_rejection_12345678") {
        return null;
      }
      throw new FundingPlannerError(
        "provider_unavailable",
        "parallel source timed out",
      );
    },
    observeRoute: async () => null,
  });
  assert.deepEqual(
    await mixedFailurePlanner.discover({
      ...plannerInput,
      requiredAmount: { asset: POLYGON_PUSD, raw: "1998348" },
    }),
    {
      sources: [],
      reasonCodes: ["provider_status_unknown", "provider_quote_rejected"],
    },
  );
  assert.equal(mixedFailureQuoteCalls, 2);

  const rejectionReasonPlanner = new RelayFirstSourcePlanner({
    listEligibleSources: async () =>
      [
        [
          "component_rejection_economics_12345678",
          "provider_quote_economics_rejected",
        ],
        ["component_rejection_invalid_12345678", "provider_quote_invalid"],
        ["component_rejection_provider_12345678", "provider_quote_rejected"],
      ].map(([componentId]) => ({
        componentId: componentId as string,
        sourceLocationPatternId: "wallet_polygon",
        safeLabel: "Rejected exact source",
        source: exactSource,
        quoteInputAmount: { asset: POLYGON_PUSD, raw: "1000000" },
        maximumSourceRaw: "1000000",
        maximumSlippageBps: 100,
        estimatedUsd: "1",
        transferable: true,
        riskEligible: true,
        walletExecutionReady: true,
        nativeGasReady: true,
        freshness: "fresh" as const,
      })),
    quoteRelay: async ({ source }) => {
      const reasonCode = source.componentId.includes("economics")
        ? ("provider_quote_economics_rejected" as const)
        : source.componentId.includes("invalid")
          ? ("provider_quote_invalid" as const)
          : ("provider_quote_rejected" as const);
      return { kind: "rejected", reasonCode };
    },
    observeRoute: async () => null,
  });
  assert.deepEqual(await rejectionReasonPlanner.discover(plannerInput), {
    sources: [],
    reasonCodes: [
      "provider_quote_economics_rejected",
      "provider_quote_invalid",
      "provider_quote_rejected",
    ],
  });

  let activeQuotes = 0;
  let maximumConcurrentQuotes = 0;
  let parallelQuoteCalls = 0;
  const pendingResolvers: Array<() => void> = [];
  const parallelPlanner = new RelayFirstSourcePlanner(
    {
      listEligibleSources: async () => [
        {
          componentId: "component_parallel_a_12345678",
          sourceLocationPatternId: "wallet_polygon",
          safeLabel: "Parallel A",
          source: exactSource,
          quoteInputAmount: { asset: POLYGON_PUSD, raw: "500000" },
          quoteMinimumOutput: { asset: POLYGON_PUSD, raw: "500000" },
          maximumSourceRaw: "500000",
          maximumSlippageBps: 100,
          estimatedUsd: "0.5",
          transferable: true,
          riskEligible: true,
          walletExecutionReady: true,
          nativeGasReady: true,
          freshness: "fresh",
        },
        {
          componentId: "component_parallel_b_12345678",
          sourceLocationPatternId: "wallet_polygon",
          safeLabel: "Parallel B",
          source: exactSource,
          quoteInputAmount: { asset: POLYGON_PUSD, raw: "500000" },
          quoteMinimumOutput: { asset: POLYGON_PUSD, raw: "500000" },
          maximumSourceRaw: "500000",
          maximumSlippageBps: 100,
          estimatedUsd: "0.5",
          transferable: true,
          riskEligible: true,
          walletExecutionReady: true,
          nativeGasReady: true,
          freshness: "fresh",
        },
      ],
      quoteRelay: ({ signal }) =>
        new Promise((resolve) => {
          parallelQuoteCalls += 1;
          activeQuotes += 1;
          maximumConcurrentQuotes = Math.max(
            maximumConcurrentQuotes,
            activeQuotes,
          );
          let finished = false;
          const finish = () => {
            if (finished) return;
            finished = true;
            activeQuotes -= 1;
            resolve(null);
          };
          pendingResolvers.push(finish);
          if (activeQuotes === 2) {
            for (const release of pendingResolvers.splice(0)) release();
          }
          signal.addEventListener("abort", finish, { once: true });
        }),
      observeRoute: async () => null,
    },
    { relayQuoteTimeoutMs: 50, totalPlannerTimeoutMs: 80 },
  );
  assert.deepEqual(await parallelPlanner.list(plannerInput), []);
  assert.equal(parallelQuoteCalls, 2);
  assert.equal(maximumConcurrentQuotes, 2);
});

await test("source option experience consumes measured observation classification", () => {
  const route = {
    routeId: "relay_polygon_pusd",
    enabled: true,
    providerId: "relay",
    capability: "same_network_swap" as const,
    adapterId: "relay_quote_v2",
    adapterVersion: 1,
    sourceLocationPatternId: "wallet_polygon",
    destinationLocationPatternId: "venue_polymarket",
    sourceAsset: POLYGON_PUSD,
    destinationAsset: POLYGON_PUSD,
    fixtureIds: ["fixture_relay_12345678"],
    actionValidatorId: "validator_relay",
    networkExecutorId: "executor_evm",
    reconcilerId: "reconciler_relay",
    refundSemanticsId: "refund_relay",
    destinationObserverId: "observer_relay",
    experienceMode: "inline" as const,
    measuredObservationCount: 25,
    minimumInlineObservationCount: 20,
    fallbackKind: null,
    depositAddress: null,
  };
  const option = buildRelayWalletSourceOption({
    sourceOptionId: "source_relay_12345678",
    safeLabel: "Wallet pUSD",
    maximumSourceRaw: "1000000",
    estimatedUsd: "1",
    quote: {
      providerId: "relay",
      adapterVersion: 1,
      capability: "same_network_swap",
      amountMode: "exact_input",
      source: sourceOption("1000000").source,
      destination: target(POLYGON_PUSD),
      expectedOutput: { asset: POLYGON_PUSD, raw: "1000000" },
      minimumOutput: { asset: POLYGON_PUSD, raw: "990000" },
      fees: [],
      eta: { minSeconds: 5, maxSeconds: 15 },
      expiresAt: "2026-07-24T12:01:00.000Z",
      actionKinds: ["evm_transaction"],
      refundSemantics: "owned_refund",
      opaqueQuoteRef: "opaque_relay_quote_12345678",
    },
    feeUsd: [],
    route,
    routeObservation: null,
    routeExperiencePolicy: DEFAULT_FUNDING_RUNTIME_POLICY.routeExperience,
    maximumFeeUsd: "0",
    maximumFeeBps: 2_000,
    warningFeeUsd: "5",
    warningFeeBps: 1_000,
    minimumDestinationUsd: "0",
    maximumSlippageBps: 100,
    minimumDestinationEstimatedUsd: "0.99",
  });
  assert.equal(option.experienceMode, "prepare_first");
  assert.deepEqual(option.reasonCodes, ["provider_status_unknown"]);
});

await test("source economics fail closed on unknown fee, fee cap, or slippage", () => {
  const route = {
    routeId: "relay_polygon_pusd",
    enabled: true,
    providerId: "relay",
    capability: "same_network_swap" as const,
    adapterId: "relay_quote_v2",
    adapterVersion: 1,
    sourceLocationPatternId: "wallet_polygon",
    destinationLocationPatternId: "venue_polymarket",
    sourceAsset: POLYGON_PUSD,
    destinationAsset: POLYGON_PUSD,
    fixtureIds: ["fixture_relay_12345678"],
    actionValidatorId: "validator_relay",
    networkExecutorId: "executor_evm",
    reconcilerId: "reconciler_relay",
    refundSemanticsId: "refund_relay",
    destinationObserverId: "observer_relay",
    experienceMode: "prepare_first" as const,
    measuredObservationCount: 0,
    minimumInlineObservationCount: 20,
    fallbackKind: null,
    depositAddress: null,
  };
  const quote = {
    providerId: "relay",
    adapterVersion: 1,
    capability: "same_network_swap" as const,
    amountMode: "exact_input" as const,
    source: sourceOption("1000000").source,
    destination: target(POLYGON_PUSD),
    expectedOutput: { asset: POLYGON_PUSD, raw: "1000000" },
    minimumOutput: { asset: POLYGON_PUSD, raw: "980000" },
    fees: [
      {
        kind: "relayer",
        amount: { asset: POLYGON_PUSD, raw: "1000" },
      },
    ],
    eta: { minSeconds: 5, maxSeconds: 15 },
    expiresAt: "2026-07-24T12:01:00.000Z",
    actionKinds: ["evm_transaction" as const],
    refundSemantics: "owned_refund",
    opaqueQuoteRef: "opaque_relay_quote_12345678",
  };
  const build = (
    feeUsd: string | null,
    maximumFeeUsd: string,
    maximumSlippageBps: number,
    economics: Readonly<{
      maximumFeeBps?: number;
      warningFeeUsd?: string;
      warningFeeBps?: number;
      minimumDestinationUsd?: string;
      minimumDestinationEstimatedUsd?: string | null;
    }> = {},
  ) =>
    buildRelayWalletSourceOption({
      sourceOptionId: "source_relay_12345678",
      safeLabel: "Wallet pUSD",
      maximumSourceRaw: "1000000",
      estimatedUsd: "1",
      quote,
      feeUsd: [feeUsd],
      route,
      routeObservation: null,
      routeExperiencePolicy: DEFAULT_FUNDING_RUNTIME_POLICY.routeExperience,
      maximumFeeUsd,
      maximumFeeBps: economics.maximumFeeBps ?? 10_000,
      warningFeeUsd: economics.warningFeeUsd ?? "100",
      warningFeeBps: economics.warningFeeBps ?? 10_000,
      minimumDestinationUsd: economics.minimumDestinationUsd ?? "0",
      maximumSlippageBps,
      minimumDestinationEstimatedUsd:
        economics.minimumDestinationEstimatedUsd === undefined
          ? "0.98"
          : economics.minimumDestinationEstimatedUsd,
    });
  assert.deepEqual(build(null, "1", 500).reasonCodes, [
    "trusted_price_unavailable",
  ]);
  assert.deepEqual(build("0.5", "0.1", 500).reasonCodes, [
    "fee_limit_exceeded",
  ]);
  assert.deepEqual(build("0.05", "0.1", 100).reasonCodes, [
    "minimum_output_not_met",
  ]);
  assert.equal(build("0.05", "0.1", 100).selectable, false);
  const integerRoundedMinimum = buildRelayWalletSourceOption({
    sourceOptionId: "source_relay_expected_output_12345678",
    safeLabel: "Wallet pUSD",
    maximumSourceRaw: "2000000",
    estimatedUsd: "1.04",
    quote: {
      ...quote,
      amountMode: "exact_output",
      expectedOutput: { asset: POLYGON_PUSD, raw: "1010102" },
      minimumOutput: { asset: POLYGON_PUSD, raw: "1000000" },
    },
    feeUsd: ["0.04"],
    route,
    routeObservation: null,
    routeExperiencePolicy: DEFAULT_FUNDING_RUNTIME_POLICY.routeExperience,
    maximumFeeUsd: "0.1",
    maximumFeeBps: 10_000,
    warningFeeUsd: "100",
    warningFeeBps: 10_000,
    minimumDestinationUsd: "0",
    maximumSlippageBps: 100,
    minimumDestinationEstimatedUsd: "1",
  });
  assert.equal(integerRoundedMinimum.selectable, true);
  assert.deepEqual(integerRoundedMinimum.reasonCodes, []);
  assert.deepEqual(
    build("0.25", "10", 500, { maximumFeeBps: 2_000 }).reasonCodes,
    ["fee_limit_exceeded"],
  );
  const warning = build("0.11", "10", 500, {
    maximumFeeBps: 2_000,
    warningFeeBps: 1_000,
  });
  assert.deepEqual(warning.reasonCodes, ["funding_cost_warning"]);
  assert.equal(warning.selectable, true);
  assert.deepEqual(
    build("0.05", "10", 500, {
      minimumDestinationUsd: "1",
      minimumDestinationEstimatedUsd: "0.5",
    }).reasonCodes,
    ["minimum_output_not_met"],
  );
  assert.deepEqual(
    build("0.05", "10", 500, {
      minimumDestinationEstimatedUsd: null,
    }).reasonCodes,
    ["trusted_price_unavailable"],
  );
});

await test("planner requires destination choice and keeps external balances out of precedence", async () => {
  const store = new MemoryPlanningStore();
  let sourceCalls = 0;
  const poly = candidate();
  const limitless = candidate({
    option: destinationOption({
      destinationOptionId: "destination_limitless_12345678",
      venueId: "limitless",
      venueBindingOptionId: "binding_limitless_12345678",
      safeLabel: "Limitless · Hunch Trading Wallet",
      requiredAsset: BASE_USDC,
      networkLabel: "Base",
      readinessClass: "external_ready",
      executionMode: "web_client",
      topology: "embedded_eoa",
      inspectionRevision: "inspection_limitless_12345678",
    }),
    bindingOption: bindingOption({
      venueBindingOptionId: "binding_limitless_12345678",
      safeLabel: "Limitless · Hunch Trading Wallet",
      readinessClass: "external_ready",
      topology: "embedded_eoa",
      inspectionRevision: "inspection_limitless_12345678",
    }),
    target: target(BASE_USDC, "limitless"),
    availableNow: { asset: BASE_USDC, raw: "999999999999" },
  });
  const policy = mutablePolicy();
  policy.creationMode = "on";
  const planner = new FundingPlanner({
    listDestinations: async () =>
      [limitless, poly].map((entry) => ({
        ...entry,
        option: {
          ...entry.option,
          recommended: entry.option.venueId === "limitless",
        },
      })),
    resolveMarketContext: async () => null,
    listSources: async () => {
      sourceCalls += 1;
      return [];
    },
    store,
    now: () => NOW,
  });
  const projection = await planner.discover({
    accountId: USER_ID,
    request: intent("add_funds", "100000000", {
      destinationOptionId: null,
    }),
    policy,
    policyRevision: "policy_revision_12345678",
    ownershipRevision: "ownership_revision_12345678",
  });
  assert.equal(projection.mode, "unavailable");
  assert.deepEqual(projection.reasonCodes, ["destination_selection_required"]);
  assert.equal(sourceCalls, 0);
  assert.equal(projection.destinationOptionId, null);
});

await test("destination and source discovery do not wait for ownership persistence evidence", async () => {
  const policy = mutablePolicy();
  policy.creationMode = "on";
  let ownershipSettled = false;
  let resolveOwnership!: (value: string) => void;
  let signalSourceStarted!: () => void;
  const ownershipRevision = new Promise<string>((resolve) => {
    resolveOwnership = (value) => {
      ownershipSettled = true;
      resolve(value);
    };
  });
  const sourceStarted = new Promise<void>((resolve) => {
    signalSourceStarted = resolve;
  });
  const discovery = new FundingPlanner({
    listDestinations: async () => {
      assert.equal(ownershipSettled, false);
      return [candidate()];
    },
    resolveMarketContext: async () => null,
    listSources: async () => {
      assert.equal(ownershipSettled, false);
      signalSourceStarted();
      return [];
    },
    store: new MemoryPlanningStore(),
    now: () => NOW,
  }).discover({
    accountId: USER_ID,
    request: intent("add_funds", "1000000"),
    policy,
    policyRevision: "policy_revision_12345678",
    ownershipRevision,
  });

  await sourceStarted;
  resolveOwnership("ownership_revision_12345678");
  const projection = await discovery;
  assert.equal(projection.destinationOptionId, "destination_poly_12345678");
});

await test("unresolved trade market context fails before destination inspection", async () => {
  let destinationCalls = 0;
  await assert.rejects(
    () =>
      new FundingPlanner({
        listDestinations: async () => {
          destinationCalls += 1;
          return [candidate()];
        },
        resolveMarketContext: async () => null,
        listSources: async () => [],
        store: new MemoryPlanningStore(),
        now: () => NOW,
      }).discover({
        accountId: USER_ID,
        request: intent("trade_shortfall", "1000000"),
        policy: mutablePolicy(),
        policyRevision: "policy_revision_12345678",
        ownershipRevision: "ownership_revision_12345678",
      }),
    (error: unknown) =>
      error instanceof FundingPlannerError &&
      error.code === "invalid_market_context",
  );
  assert.equal(destinationCalls, 0);
});

await test("single destination values exact liquidity without inventing consent", async () => {
  const policy = mutablePolicy();
  policy.creationMode = "on";
  const store = new MemoryPlanningStore();
  const exactCandidate = candidate({
    availableNow: { asset: POLYGON_PUSD, raw: "2000000" },
    spendability: {
      observedAmount: { asset: POLYGON_PUSD, raw: "5000000" },
      lockedRaw: "1000000",
      reservedRaw: "1000000",
      submittedDebitRaw: "1000000",
      availableAmount: { asset: POLYGON_PUSD, raw: "2000000" },
      revision: "availability_locked_12345678",
      asOf: NOW.toISOString(),
      expiresAt: "2026-07-24T12:01:00.000Z",
    },
  });
  const projection = await new FundingPlanner({
    listDestinations: async () => [exactCandidate],
    resolveMarketContext: async () => null,
    listSources: async ({ requiredAmount }) => [
      plannedSource(requiredAmount.raw),
    ],
    store,
    now: () => NOW,
  }).discover({
    accountId: USER_ID,
    request: intent("add_funds", "100000000", {
      destinationOptionId: null,
    }),
    policy,
    policyRevision: "policy_revision_12345678",
    ownershipRevision: "ownership_revision_12345678",
  });
  assert.equal(projection.destinationOptionId, "destination_poly_12345678");
  assert.equal(projection.requestedUsd, "100");
  assert.equal(projection.availableNowUsd, "2");
  assert.equal(projection.shortfallUsd, "100");
  assert.equal(projection.convertibleRaw, "100000000");
  assert.equal(projection.convertibleUsd, "100");
  assert.equal(projection.completeness, "complete");
  assert.equal(projection.freshness, "fresh");
});

await test("planner exposes missing native gas instead of only reporting no liquidity", async () => {
  const policy = mutablePolicy();
  policy.creationMode = "on";
  const projection = await new FundingPlanner({
    listDestinations: async () => [candidate()],
    resolveMarketContext: async () => null,
    listSources: async () => [],
    listSourceBlockers: async () => ["insufficient_gas"],
    store: new MemoryPlanningStore(),
    now: () => NOW,
  }).discover({
    accountId: USER_ID,
    request: intent("add_funds", "1000000"),
    policy,
    policyRevision: "policy_revision_12345678",
    ownershipRevision: "ownership_revision_12345678",
  });

  assert.equal(projection.mode, "unavailable");
  assert.equal(projection.sourceOptions.length, 0);
  assert.equal(projection.reasonCodes.includes("insufficient_gas"), true);
  assert.equal(projection.reasonCodes.includes("insufficient_liquidity"), true);
});

await test("a verified automatic source makes unrelated gas failure non-blocking", async () => {
  const policy = mutablePolicy();
  policy.creationMode = "on";
  const projection = await new FundingPlanner({
    listDestinations: async () => [candidate()],
    resolveMarketContext: async () => null,
    listSources: async ({ requiredAmount }) => [
      plannedSource(requiredAmount.raw),
    ],
    listSourceBlockers: async () => ["insufficient_gas"],
    store: new MemoryPlanningStore(),
    now: () => NOW,
  }).discover({
    accountId: USER_ID,
    request: intent("add_funds", "1000000"),
    policy,
    policyRevision: "policy_revision_12345678",
    ownershipRevision: "ownership_revision_12345678",
  });

  assert.equal(
    projection.sourceOptions.some((option) => option.selectable),
    true,
  );
  assert.equal(projection.reasonCodes.includes("insufficient_gas"), false);
  assert.equal(
    projection.reasonCodes.includes("insufficient_liquidity"),
    false,
  );
});

await test("automatic source is recommended ahead of a user-paid preparation option", async () => {
  const policy = mutablePolicy();
  policy.creationMode = "on";
  const projection = await new FundingPlanner({
    listDestinations: async () => [candidate()],
    resolveMarketContext: async () => null,
    listSources: async ({ requiredAmount }) => [
      plannedVenuePreparationSource(requiredAmount.raw, "user"),
      plannedSource(requiredAmount.raw),
    ],
    store: new MemoryPlanningStore(),
    now: () => NOW,
  }).discover({
    accountId: USER_ID,
    request: intent("add_funds", "1000000"),
    policy,
    policyRevision: "policy_revision_12345678",
    ownershipRevision: "ownership_revision_12345678",
  });

  assert.equal(
    projection.sourceOptions.find((option) => option.recommended)
      ?.sourceOptionId,
    "source_wallet_12345678",
  );
  assert.equal(projection.requiredActions.length, 0);
});

await test("automatic venue preparation is executable while user-paid preparation keeps its gas blocker", async () => {
  const discover = (payerRequirement: "user" | "privy_sponsor") =>
    new FundingPlanner({
      listDestinations: async () => [candidate()],
      resolveMarketContext: async () => null,
      listSources: async ({ requiredAmount }) => [
        plannedVenuePreparationSource(requiredAmount.raw, payerRequirement),
      ],
      listSourceBlockers: async () => ["insufficient_gas"],
      store: new MemoryPlanningStore(),
      now: () => NOW,
    }).discover({
      accountId: USER_ID,
      request: intent("add_funds", "1000000"),
      policy: {
        ...mutablePolicy(),
        creationMode: "on",
      },
      policyRevision: "policy_revision_12345678",
      ownershipRevision: "ownership_revision_12345678",
    });

  const automatic = await discover("privy_sponsor");
  assert.equal(automatic.convertibleRaw, "1000000");
  assert.equal(automatic.reasonCodes.includes("insufficient_gas"), false);
  assert.equal(automatic.sourceOptions[0]?.selectable, true);

  const userPaid = await discover("user");
  assert.equal(userPaid.convertibleRaw, "0");
  assert.equal(userPaid.reasonCodes.includes("insufficient_gas"), true);
  assert.equal(userPaid.sourceOptions[0]?.selectable, true);
});

await test("retryable source inventory failure is not reported as insufficient liquidity", async () => {
  const policy = mutablePolicy();
  policy.creationMode = "on";
  const projection = await new FundingPlanner({
    listDestinations: async () => [candidate()],
    resolveMarketContext: async () => null,
    listSources: async () => [],
    listSourceBlockers: async () => ["rpc_unavailable"],
    store: new MemoryPlanningStore(),
    now: () => NOW,
  }).discover({
    accountId: USER_ID,
    request: intent("add_funds", "1000000"),
    policy,
    policyRevision: "policy_revision_12345678",
    ownershipRevision: "ownership_revision_12345678",
  });

  assert.equal(projection.mode, "unavailable");
  assert.equal(projection.completeness, "partial");
  assert.equal(projection.freshness, "stale");
  assert.deepEqual(projection.errors, [
    { code: "rpc_unavailable", retryable: true },
  ]);
  assert.equal(projection.reasonCodes.includes("rpc_unavailable"), true);
  assert.equal(
    projection.reasonCodes.includes("insufficient_liquidity"),
    false,
  );
});

await test("transient provider failure remains a partial liquidity projection so manual funding stays available", async () => {
  const policy = mutablePolicy();
  policy.creationMode = "on";
  const projection = await new FundingPlanner({
    listDestinations: async () => [candidate()],
    resolveMarketContext: async () => null,
    listSources: async () => {
      throw new Error("discoverSources must be the single source boundary");
    },
    discoverSources: async () => ({
      sources: [],
      reasonCodes: ["provider_status_unknown"],
    }),
    store: new MemoryPlanningStore(),
    now: () => NOW,
  }).discover({
    accountId: USER_ID,
    request: intent("add_funds", "1000000"),
    policy,
    policyRevision: "policy_revision_12345678",
    ownershipRevision: "ownership_revision_12345678",
  });

  assert.equal(projection.mode, "unavailable");
  assert.equal(projection.completeness, "partial");
  assert.equal(projection.freshness, "stale");
  assert.deepEqual(projection.errors, [
    { code: "provider_status_unknown", retryable: true },
  ]);
  assert.equal(
    projection.reasonCodes.includes("provider_status_unknown"),
    true,
  );
  assert.equal(
    projection.reasonCodes.includes("insufficient_liquidity"),
    false,
  );
});

await test("planner evaluates collected evidence at a current clock and permits known-zero direct ingress", async () => {
  const policy = mutablePolicy();
  policy.creationMode = "on";
  policy.assets = [
    {
      asset: POLYGON_PUSD,
      enabled: true,
      observationEnabled: true,
      valuationEnabled: true,
      pricePolicyId: "exact-stable-policy-v1",
    },
  ];
  policy.locations = [
    {
      locationPatternId: "polymarket-venue-cash-v1",
      locationKind: "venue_account",
      asset: POLYGON_PUSD,
      ownership: "owned",
      observable: true,
      capabilities: ["observe", "venue_settlement"],
      enabled: true,
    },
    {
      locationPatternId: "wallet-polygon-pusd-v1",
      locationKind: "wallet",
      asset: POLYGON_PUSD,
      ownership: "owned",
      observable: true,
      capabilities: ["observe", "value", "execution_source"],
      enabled: true,
    },
  ];
  const evidenceAt = new Date(NOW.getTime() + 5);
  const evidenceExpiresAt = new Date(evidenceAt.getTime() + policy.ttl.quoteMs);
  const exactCandidate = candidate({
    destinationLocationPatternId: "polymarket-venue-cash-v1",
    availableNow: { asset: POLYGON_PUSD, raw: "0" },
    collateralValuation: {
      unitPriceUsd: "1",
      pricePolicyId: "exact-stable-policy-v1",
      asOf: evidenceAt.toISOString(),
      expiresAt: evidenceExpiresAt.toISOString(),
    },
    spendability: {
      observedAmount: { asset: POLYGON_PUSD, raw: "0" },
      lockedRaw: "0",
      reservedRaw: "0",
      submittedDebitRaw: "0",
      availableAmount: { asset: POLYGON_PUSD, raw: "0" },
      revision: "availability_known_zero_12345678",
      asOf: evidenceAt.toISOString(),
      expiresAt: evidenceExpiresAt.toISOString(),
    },
  });
  const adapter = new DirectIngressFundingSourceAdapter();
  let clock = NOW;
  let sourceCalls = 0;
  const projection = await new FundingPlanner({
    listDestinations: async () => {
      clock = evidenceAt;
      return [exactCandidate];
    },
    resolveMarketContext: async () => null,
    listSources: async (input) => {
      sourceCalls += 1;
      return adapter.list(input);
    },
    store: new MemoryPlanningStore(),
    now: () => clock,
  }).discover({
    accountId: USER_ID,
    request: intent("add_funds", "1000000"),
    policy,
    policyRevision: "policy_revision_12345678",
    ownershipRevision: "ownership_revision_12345678",
  });

  assert.equal(sourceCalls, 1);
  assert.equal(projection.mode, "prepare_first");
  assert.equal(projection.availableNowRaw, "0");
  assert.equal(projection.shortfallRaw, "1000000");
  assert.equal(projection.requestedUsd, "1");
  assert.deepEqual(
    projection.sourceOptions.map((option) => option.kind),
    ["manual_receive"],
  );
  assert.equal(projection.convertibleRaw, "0");
  assert.equal(projection.convertibleUsd, "0");
  assert.equal(
    projection.reasonCodes.includes("cash_availability_unknown"),
    false,
  );
  assert.equal(projection.reasonCodes.includes("trusted_price_stale"), false);
  assert.equal(
    projection.reasonCodes.includes("insufficient_liquidity"),
    false,
  );
});

await test("stale availability or valuation fails planner closed before quoting", async () => {
  const policy = mutablePolicy();
  policy.creationMode = "on";
  let sourceCalls = 0;
  const run = (exactCandidate: ResolvedDestinationCandidate) =>
    new FundingPlanner({
      listDestinations: async () => [exactCandidate],
      resolveMarketContext: async () => null,
      listSources: async () => {
        sourceCalls += 1;
        return [];
      },
      store: new MemoryPlanningStore(),
      now: () => NOW,
    }).discover({
      accountId: USER_ID,
      request: intent("add_funds", "1000000"),
      policy,
      policyRevision: "policy_revision_12345678",
      ownershipRevision: "ownership_revision_12345678",
    });
  const staleAvailability = await run(
    candidate({
      availableNow: { asset: POLYGON_PUSD, raw: "999999999" },
      freshness: "stale",
    }),
  );
  assert.equal(staleAvailability.mode, "unavailable");
  assert.equal(staleAvailability.availableNowRaw, "0");
  assert.ok(
    staleAvailability.reasonCodes.includes("cash_availability_unknown"),
  );

  const stalePrice = await run(
    candidate({
      collateralValuation: {
        unitPriceUsd: "1",
        pricePolicyId: "exact-stable-policy-v1",
        asOf: "2026-07-24T11:58:00.000Z",
        expiresAt: "2026-07-24T11:59:00.000Z",
      },
    }),
  );
  assert.equal(stalePrice.mode, "unavailable");
  assert.ok(stalePrice.reasonCodes.includes("trusted_price_stale"));

  const unpriced = await run(candidate({ collateralValuation: null }));
  assert.equal(unpriced.mode, "unavailable");
  assert.ok(unpriced.reasonCodes.includes("trusted_price_unavailable"));
  assert.equal(unpriced.requestedUsd, "0");
  assert.equal(unpriced.completeness, "partial");
  assert.equal(sourceCalls, 0);
});

await test("explicit unavailable destination never falls back to another venue", async () => {
  const policy = mutablePolicy();
  policy.creationMode = "on";
  const unavailable = candidate({
    option: destinationOption({ selectable: false }),
  });
  const fallback = candidate({
    destinationLocationPatternId: "venue_limitless",
    collateralValuation: {
      unitPriceUsd: "1",
      pricePolicyId: "exact-stable-policy-v1",
      asOf: NOW.toISOString(),
      expiresAt: "2026-07-24T12:01:00.000Z",
    },
    option: destinationOption({
      destinationOptionId: "destination_limitless_12345678",
      venueId: "limitless",
      venueBindingOptionId: "binding_limitless_12345678",
      requiredAsset: BASE_USDC,
      networkLabel: "Base",
      topology: "embedded_eoa",
      inspectionRevision: "inspection_limitless_12345678",
    }),
    bindingOption: bindingOption({
      venueBindingOptionId: "binding_limitless_12345678",
      topology: "embedded_eoa",
      inspectionRevision: "inspection_limitless_12345678",
    }),
    target: target(BASE_USDC, "limitless"),
    availableNow: { asset: BASE_USDC, raw: "0" },
  });
  const projection = await new FundingPlanner({
    listDestinations: async () => [unavailable, fallback],
    resolveMarketContext: async () => null,
    listSources: async () => {
      throw new Error("unavailable explicit destination must not quote");
    },
    store: new MemoryPlanningStore(),
    now: () => NOW,
  }).discover({
    accountId: USER_ID,
    request: intent("add_funds", "1000000"),
    policy,
    policyRevision: "policy_revision_12345678",
    ownershipRevision: "ownership_revision_12345678",
  });
  assert.equal(projection.mode, "unavailable");
  assert.equal(projection.destinationOptionId, null);
  assert.deepEqual(projection.reasonCodes, ["destination_unavailable"]);
});

await test("planner rebinds a refreshed destination through the exact stable binding", async () => {
  const policy = mutablePolicy();
  policy.creationMode = "on";
  const refreshed = candidate({
    option: destinationOption({
      destinationOptionId: "destination_refreshed_12345678",
      inspectionRevision: "inspection_refreshed_12345678",
    }),
    bindingOption: bindingOption({
      inspectionRevision: "inspection_refreshed_12345678",
    }),
  });
  const projection = await new FundingPlanner({
    listDestinations: async () => [refreshed],
    resolveMarketContext: async () => null,
    listSources: async ({ requiredAmount }) => [
      plannedSource(requiredAmount.raw),
    ],
    store: new MemoryPlanningStore(),
    now: () => NOW,
  }).discover({
    accountId: USER_ID,
    request: intent("add_funds", "1000000", {
      destinationOptionId: "destination_stale_12345678",
      venueBindingOptionId: refreshed.bindingOption.venueBindingOptionId,
    }),
    policy,
    policyRevision: "policy_revision_12345678",
    ownershipRevision: "ownership_revision_12345678",
  });

  assert.equal(
    projection.destinationOptionId,
    refreshed.option.destinationOptionId,
  );
  assert.equal(
    projection.venueBindingOptionId,
    refreshed.bindingOption.venueBindingOptionId,
  );
  assert.ok(!projection.reasonCodes.includes("destination_unavailable"));
});

await test("destination identity rebinds only one selectable stable binding", () => {
  const refreshed = destinationOption({
    destinationOptionId: "destination_refreshed_12345678",
  });
  assert.equal(
    resolveFundingDestinationChoice({
      options: [refreshed],
      destinationOptionId: "destination_stale_12345678",
      venueBindingOptionId: refreshed.venueBindingOptionId,
    })?.destinationOptionId,
    refreshed.destinationOptionId,
  );
  assert.equal(
    resolveFundingDestinationChoice({
      options: [
        refreshed,
        {
          ...refreshed,
          destinationOptionId: "destination_ambiguous_12345678",
        },
      ],
      destinationOptionId: "destination_stale_12345678",
      venueBindingOptionId: refreshed.venueBindingOptionId,
    }),
    null,
  );
  assert.equal(
    resolveFundingDestinationChoice({
      options: [refreshed],
      destinationOptionId: refreshed.destinationOptionId,
      venueBindingOptionId: "binding_other_12345678",
    }),
    null,
  );
});

await test("Convert rejects a source plan with exact-output economics", async () => {
  const policy = mutablePolicy();
  policy.creationMode = "on";
  await assert.rejects(
    () =>
      new FundingPlanner({
        listDestinations: async () => [candidate()],
        resolveMarketContext: async () => null,
        listSources: async ({ requiredAmount }) => [
          plannedSource(requiredAmount.raw),
        ],
        store: new MemoryPlanningStore(),
        now: () => NOW,
      }).discover({
        accountId: USER_ID,
        request: intent("convert_asset", "1", {
          confirmedSourceAmount: {
            asset: POLYGON_PUSD,
            raw: "1000000",
          },
        }),
        policy,
        policyRevision: "policy_revision_12345678",
        ownershipRevision: "ownership_revision_12345678",
      }),
    (error: unknown) =>
      error instanceof FundingPlannerError &&
      error.code === "invalid_policy" &&
      error.message.includes("exact input"),
  );
});

await test("Convert derives target units from its exact source, not the placeholder output", async () => {
  const policy = mutablePolicy();
  policy.creationMode = "on";
  let requiredRaw = "not-called";
  const projection = await new FundingPlanner({
    listDestinations: async () => [candidate()],
    resolveMarketContext: async () => null,
    listSources: async ({ requiredAmount }) => {
      requiredRaw = requiredAmount.raw;
      const source = plannedSource(requiredAmount.raw);
      return [
        {
          ...source,
          option: {
            ...source.option,
            amountMode: "exact_input",
            expectedDestination: {
              asset: requiredAmount.asset,
              raw: "990000",
            },
            minimumDestination: {
              asset: requiredAmount.asset,
              raw: "980000",
            },
          },
        },
      ];
    },
    store: new MemoryPlanningStore(),
    now: () => NOW,
  }).discover({
    accountId: USER_ID,
    request: intent("convert_asset", "1", {
      confirmedSourceAmount: {
        asset: POLYGON_PUSD,
        raw: "1000000",
      },
    }),
    policy,
    policyRevision: "policy_revision_12345678",
    ownershipRevision: "ownership_revision_12345678",
  });

  assert.equal(requiredRaw, "1000000");
  assert.equal(projection.requestedCollateralRaw, "1000000");
  assert.equal(projection.shortfallRaw, "1000000");
  assert.equal(projection.sourceOptions[0]?.amountMode, "exact_input");
  assert.equal(projection.sourceOptions[0]?.minimumDestination?.raw, "980000");
});

await test("planner preserves Add Funds exact amount and trade shortfall", async () => {
  const policy = mutablePolicy();
  policy.creationMode = "on";
  const store = new MemoryPlanningStore();
  const run = async (
    request: FundingDiscoveryRequest,
    availableRaw: string,
  ) => {
    const exactCandidate = candidate({
      option: destinationOption({
        preparationPurpose:
          request.purpose === "trade_shortfall" ? "buy" : "fund",
      }),
      bindingOption: bindingOption({
        preparationPurpose:
          request.purpose === "trade_shortfall" ? "buy" : "fund",
      }),
      availableNow: { asset: POLYGON_PUSD, raw: availableRaw },
    });
    return new FundingPlanner({
      listDestinations: async () => [exactCandidate],
      resolveMarketContext: async ({ marketContextId }) => ({
        marketContextId,
        venueId: "polymarket",
        marketId: "polymarket:market_12345678",
        side: "yes",
        executionProfileId: "profile_polymarket",
        marketPriceRevision: "marketprice_12345678",
        collateralAsset: POLYGON_PUSD,
        requestedCollateralRaw:
          request.consumerIntent?.spend.raw ??
          request.requestedDestinationAmount?.raw ??
          "0",
        compatibleVenueBindingOptionIds: [
          exactCandidate.bindingOption.venueBindingOptionId,
        ],
        expiresAt: "2026-07-24T12:01:00.000Z",
      }),
      listSources: async ({ requiredAmount }) => [
        plannedSource(requiredAmount.raw),
      ],
      store,
      now: () => NOW,
    }).discover({
      accountId: USER_ID,
      request,
      policy,
      policyRevision: "policy_revision_12345678",
      ownershipRevision: "ownership_revision_12345678",
    });
  };
  const add = await run(intent("add_funds", "100000000"), "5000000");
  assert.equal(add.shortfallRaw, "100000000");
  assert.equal(add.convertibleRaw, "100000000");
  assert.equal(add.convertibleUsd, "100");
  assert.equal(add.sourceOptions[0]?.minimumDestination?.raw, "100000000");

  const trade = await run(
    intent("trade_shortfall", "5000000", {
      destinationOptionId: null,
      consumerIntent: {
        venueId: "polymarket",
        marketId: "polymarket:market_12345678",
        marketContextId: "marketctx_12345678",
        side: "BUY",
        spend: { asset: POLYGON_PUSD, raw: "4900000" },
      },
    }),
    "2000000",
  );
  assert.equal(trade.shortfallRaw, "3000000");
  assert.equal(trade.availableNowRaw, "2000000");
  assert.equal(trade.convertibleRaw, "3000000");
  assert.equal(trade.convertibleUsd, "3");
  assert.equal(trade.sourceOptions[0]?.minimumDestination?.raw, "3000000");
  assert.equal(
    store.rows.get(trade.liquidityProjectionId)?.plannerSnapshot.marketContext
      ?.requestedCollateralRaw,
    "4900000",
  );
});

await test("an uncovered trade shortfall stays a usable insufficient-liquidity projection", async () => {
  const policy = mutablePolicy();
  policy.creationMode = "on";
  const request = intent("trade_shortfall", "10100401", {
    destinationOptionId: null,
    consumerIntent: {
      venueId: "polymarket",
      marketId: "polymarket:561251",
      marketContextId:
        "50862799703982327636174441241062907649998751737045006653560124656563256528691",
      side: "BUY",
      spend: { asset: POLYGON_PUSD, raw: "10000000" },
    },
    marketContextId:
      "50862799703982327636174441241062907649998751737045006653560124656563256528691",
  });
  const exactCandidate = candidate({
    option: destinationOption({ preparationPurpose: "buy" }),
    bindingOption: bindingOption({ preparationPurpose: "buy" }),
    availableNow: { asset: POLYGON_PUSD, raw: "8102053" },
  });
  let plannedShortfallRaw: string | null = null;
  const projection = await new FundingPlanner({
    listDestinations: async () => [exactCandidate],
    resolveMarketContext: async ({ marketContextId }) => ({
      marketContextId,
      venueId: "polymarket",
      marketId: "polymarket:561251",
      side: "yes",
      executionProfileId: "profile_polymarket",
      marketPriceRevision: "marketprice_561251",
      collateralAsset: POLYGON_PUSD,
      requestedCollateralRaw: "10000000",
      compatibleVenueBindingOptionIds: [
        exactCandidate.bindingOption.venueBindingOptionId,
      ],
      expiresAt: "2026-07-24T12:01:00.000Z",
    }),
    listSources: async ({ requiredAmount }) => {
      plannedShortfallRaw = requiredAmount.raw;
      return [];
    },
    store: new MemoryPlanningStore(),
    now: () => NOW,
  }).discover({
    accountId: USER_ID,
    request,
    policy,
    policyRevision: "policy_revision_12345678",
    ownershipRevision: "ownership_revision_12345678",
  });

  assert.equal(plannedShortfallRaw, "1998348");
  assert.equal(projection.requestedCollateralRaw, "10100401");
  assert.equal(projection.availableNowRaw, "8102053");
  assert.equal(projection.shortfallRaw, "1998348");
  assert.equal(projection.mode, "unavailable");
  assert.deepEqual(projection.sourceOptions, []);
  assert.equal(projection.reasonCodes.includes("insufficient_liquidity"), true);
  assert.equal(projection.errors.length, 0);
});

await test("one liquidity discovery resolves market context and destination candidates once", async () => {
  const policy = mutablePolicy();
  policy.creationMode = "on";
  const store = new MemoryPlanningStore();
  const destination = candidate({
    option: destinationOption({ preparationPurpose: "buy" }),
    bindingOption: bindingOption({ preparationPurpose: "buy" }),
    availableNow: { asset: POLYGON_PUSD, raw: "1000000" },
  });
  const request = intent("trade_shortfall", "1000000");
  let marketResolutionCalls = 0;
  let destinationDiscoveryCalls = 0;

  const projection = await new FundingPlanner({
    resolveMarketContext: async ({ marketContextId }) => {
      marketResolutionCalls += 1;
      return {
        marketContextId,
        venueId: "polymarket",
        marketId: "polymarket:market_12345678",
        side: "YES",
        executionProfileId: "profile_polymarket",
        marketPriceRevision: "marketprice_12345678",
        collateralAsset: POLYGON_PUSD,
        requestedCollateralRaw: "1000000",
        compatibleVenueBindingOptionIds: [],
        expiresAt: "2026-07-24T12:01:00.000Z",
      };
    },
    listDestinations: async () => {
      destinationDiscoveryCalls += 1;
      return [destination];
    },
    listSources: async () => [],
    store,
    now: () => NOW,
  }).discover({
    accountId: USER_ID,
    request,
    policy,
    policyRevision: "policy_revision_12345678",
    ownershipRevision: "ownership_revision_12345678",
  });

  assert.equal(marketResolutionCalls, 1);
  assert.equal(destinationDiscoveryCalls, 1);
  assert.equal(
    projection.destinationOptionId,
    destination.option.destinationOptionId,
  );
  assert.deepEqual(
    store.rows.get(projection.liquidityProjectionId)?.plannerSnapshot
      .marketContext?.compatibleVenueBindingOptionIds,
    [destination.bindingOption.venueBindingOptionId],
  );
});

await test("planner keeps the true tiny shortfall while quoting one executable trade refill", async () => {
  const policy = mutablePolicy();
  policy.creationMode = "on";
  // A runtime policy may tune warnings and fee caps, but it must not make
  // automatic trade refills economically meaningless.
  policy.placement.minimumDestinationUsd = "0.1";
  let plannedRequiredRaw: string | null = null;
  const plannedPlacements: PlacementDecision[] = [];
  const destination = candidate({
    option: destinationOption({ preparationPurpose: "buy" }),
    bindingOption: bindingOption({ preparationPurpose: "buy" }),
    availableNow: { asset: POLYGON_PUSD, raw: "940000" },
  });
  const request = intent("trade_shortfall", "1000000", {
    destinationOptionId: null,
  });

  const projection = await new FundingPlanner({
    listDestinations: async () => [destination],
    resolveMarketContext: async ({ marketContextId }) => ({
      marketContextId,
      venueId: "polymarket",
      marketId: "polymarket:market_12345678",
      side: "yes",
      executionProfileId: "profile_polymarket",
      marketPriceRevision: "marketprice_12345678",
      collateralAsset: POLYGON_PUSD,
      requestedCollateralRaw: "1000000",
      compatibleVenueBindingOptionIds: [
        destination.bindingOption.venueBindingOptionId,
      ],
      expiresAt: "2026-07-24T12:01:00.000Z",
    }),
    listSources: async ({ placement, requiredAmount }) => {
      plannedRequiredRaw = requiredAmount.raw;
      plannedPlacements.push(placement);
      return [plannedSource(requiredAmount.raw)];
    },
    store: new MemoryPlanningStore(),
    now: () => NOW,
  }).discover({
    accountId: USER_ID,
    request,
    policy,
    policyRevision: "policy_revision_12345678",
    ownershipRevision: "ownership_revision_12345678",
  });

  assert.equal(projection.shortfallRaw, "60000");
  assert.equal(projection.shortfallUsd, "0.06");
  assert.equal(plannedRequiredRaw, "500000");
  assert.equal(plannedPlacements[0]?.destinationRequirement.raw, "500000");
  assert.equal(plannedPlacements[0]?.boundedBuffer?.raw, "440000");
  assert.equal(projection.sourceOptions[0]?.minimumDestination?.raw, "500000");
  assert.equal(projection.mode, "inline_funding");
  assert.equal(
    projection.reasonCodes.includes("insufficient_liquidity"),
    false,
  );
});

await test("a tiny shortfall falls back when no source covers the executable refill", async () => {
  const policy = mutablePolicy();
  policy.creationMode = "on";
  policy.placement.minimumDestinationUsd = "0.1";
  const destination = candidate({
    option: destinationOption({ preparationPurpose: "buy" }),
    bindingOption: bindingOption({ preparationPurpose: "buy" }),
    availableNow: { asset: POLYGON_PUSD, raw: "940000" },
  });
  const request = intent("trade_shortfall", "1000000", {
    destinationOptionId: null,
  });
  let requiredRaw: string | null = null;

  const projection = await new FundingPlanner({
    listDestinations: async () => [destination],
    resolveMarketContext: async ({ marketContextId }) => ({
      marketContextId,
      venueId: "polymarket",
      marketId: "polymarket:market_12345678",
      side: "yes",
      executionProfileId: "profile_polymarket",
      marketPriceRevision: "marketprice_12345678",
      collateralAsset: POLYGON_PUSD,
      requestedCollateralRaw: "1000000",
      compatibleVenueBindingOptionIds: [
        destination.bindingOption.venueBindingOptionId,
      ],
      expiresAt: "2026-07-24T12:01:00.000Z",
    }),
    listSources: async ({ requiredAmount }) => {
      requiredRaw = requiredAmount.raw;
      return [];
    },
    store: new MemoryPlanningStore(),
    now: () => NOW,
  }).discover({
    accountId: USER_ID,
    request,
    policy,
    policyRevision: "policy_revision_12345678",
    ownershipRevision: "ownership_revision_12345678",
  });

  assert.equal(requiredRaw, "500000");
  assert.equal(projection.sourceOptions.length, 0);
  assert.equal(projection.mode, "unavailable");
  assert.equal(projection.reasonCodes.includes("insufficient_liquidity"), true);
});

await test("withdrawal stays independent of funding pause through discovery, quote, and atomic commit", async () => {
  const recipient = {
    recipientId: "recipient_withdrawal_12345678",
    accountId: USER_ID,
    networkId: POLYGON_PUSD.networkId,
    asset: POLYGON_PUSD,
    address: "0x00000000000000000000000000000000000000d1",
    addressFingerprint: "d".repeat(64),
    validatedAt: NOW.toISOString(),
    expiresAt: "2026-07-24T12:01:00.000Z",
    validationPolicyVersion: 1,
  } as const;
  const { address: _recipientAddress, ...recipientSnapshot } = recipient;
  const request = intent("withdrawal", "1000000", {
    destinationOptionId: null,
    withdrawalRecipientId: recipient.recipientId,
  });
  const policy = mutablePolicy();
  policy.ttl.quoteMs = 1;
  assert.equal(policy.creationMode, "off");
  assert.equal(policy.gates.quoteCreation, false);
  assert.equal(policy.gates.commit, false);
  const store = new MemoryPlanningStore();
  let frozenPlan: FundingCommitPlan | null = null;
  const projection = await new FundingPlanner({
    listDestinations: async () => {
      throw new Error("withdrawal must not select a venue destination");
    },
    resolveMarketContext: async () => null,
    resolveWithdrawalRecipient: async ({ accountId, recipientId }) => {
      assert.equal(accountId, USER_ID);
      assert.equal(recipientId, recipient.recipientId);
      return recipient;
    },
    listSources: async ({ destination, placement, requiredAmount }) => {
      assert.equal(destination.externalRecipientId, recipient.recipientId);
      assert.equal(destination.venueId, null);
      assert.equal(destination.venueBindingOption, null);
      assert.equal(destination.recipientAddress, recipient.address);
      assert.deepEqual(destination.target, {
        kind: "external_recipient",
        recipient: recipientSnapshot,
      });
      const option = sourceOption(requiredAmount.raw);
      const base = commitPlan(requiredAmount.raw, option);
      frozenPlan = {
        ...base,
        operation: {
          ...base.operation,
          purpose: operationPurposeForExternalRecipient(recipient.recipientId),
          sourceSnapshot: option as never,
          destinationTargetSnapshot: destination.target as never,
          externalRecipientId: recipient.recipientId,
          venueId: null,
          venueBindingSnapshot: null,
          placementSnapshot: placement as never,
        },
        segments: base.segments.map((segment) => ({
          ...segment,
          destinationTargetSnapshot: destination.target as never,
        })),
      };
      return [
        {
          option,
          commitPlan: frozenPlan,
          routeId: "relay_polygon_withdrawal",
          providerId: "relay",
        },
      ];
    },
    store,
    now: () => NOW,
  }).discover({
    accountId: USER_ID,
    request,
    policy,
    policyRevision: "policy_revision_12345678",
    ownershipRevision: "ownership_revision_12345678",
  });
  assert.equal(projection.destinationOptionId, null);
  assert.equal(projection.venueBindingOptionId, null);
  assert.equal(projection.sourceOptions.length, 1);
  assert.equal(projection.mode, "inline_funding");
  assert.equal(
    projection.expiresAt,
    new Date(NOW.getTime() + FUNDING_TTL.quoteMs).toISOString(),
  );
  assert.equal(
    store.rows.get(projection.liquidityProjectionId)?.plannerSnapshot
      .withdrawalRecipient?.recipientId,
    recipient.recipientId,
  );
  assert.equal(
    JSON.stringify(
      store.rows.get(projection.liquidityProjectionId)?.plannerSnapshot,
    ).includes(recipient.address),
    false,
  );
  const createdPlan = frozenPlan as FundingCommitPlan | null;
  assert.ok(createdPlan);
  assert.equal(createdPlan.operation.purpose, "withdrawal");

  let currentRecipientChecks = 0;
  let storedQuote: StoredFundingQuote | null = null;
  const quoteService = new FundingQuoteService({
    db: {} as never,
    planningStore: store,
    now: () => NOW,
    revalidateWithdrawalRecipient: async (userId, recipientId) => {
      currentRecipientChecks += 1;
      assert.equal(userId, USER_ID);
      assert.equal(recipientId, recipient.recipientId);
    },
    createQuote: async (_db, input) => {
      storedQuote = {
        id: "quote_withdrawal_12345678",
        userId: input.userId,
        discoveryProjectionId: input.discoveryProjectionId,
        selectedSourceOptionSnapshot: input.selectedSourceOptionSnapshot,
        marketContextSnapshot: input.marketContextSnapshot,
        destinationOptionSnapshot: input.destinationOptionSnapshot,
        venueBindingSnapshot: input.venueBindingSnapshot,
        planSnapshot: input.planSnapshot,
        policyVersion: input.policyVersion,
        policyRevision: input.policyRevision,
        canonicalRequestHash: "a".repeat(64),
        planHash: canonicalJsonHash(input.planSnapshot),
        consentTokenHash: "b".repeat(64),
        expiresAt: input.expiresAt,
        consumedAt: null,
        invalidatedAt: null,
      };
      return storedQuote;
    },
  });
  const selectedSourceOption = projection.sourceOptions[0];
  assert.ok(selectedSourceOption);
  const quoteSummary = await quoteService.quote({
    userId: USER_ID,
    request: {
      liquidityProjectionId: projection.liquidityProjectionId,
      selectedSourceOptionId: selectedSourceOption.sourceOptionId,
      confirmedSourceAmount: null,
      requestedDestinationAmount: {
        asset: POLYGON_PUSD,
        raw: "1000000",
      },
    },
    policy,
    policyRevision: "policy_revision_12345678",
    ownershipRevision: "ownership_revision_12345678",
  });
  assert.equal(quoteSummary.destinationOptionId, null);
  assert.equal(quoteSummary.venueBindingOptionId, null);
  assert.equal(currentRecipientChecks, 1);
  assert.ok(storedQuote);
  const committedQuote = storedQuote as StoredFundingQuote;
  assert.equal(
    JSON.stringify(committedQuote.planSnapshot).includes(recipient.address),
    false,
  );

  const resolvedPolicy = {
    source: "db" as const,
    policy,
    revision: "policy_revision_12345678",
    effectiveAt: NOW,
    createdAt: NOW,
    createdBy: USER_ID,
    invalidStoredPolicy: false,
    validationIssues: [],
  };
  await new FundingOperationService({
    db: {} as never,
    subjectLookupHmac: () => "c".repeat(64),
    subjectLookupKeyVersion: 1,
    resolveOwnershipRevision: async () => "ownership_revision_12345678",
    revalidateWithdrawalRecipient: async (_db, input) => {
      currentRecipientChecks += 1;
      assert.equal(input.userId, USER_ID);
      assert.equal(input.recipientId, recipient.recipientId);
    },
    fetchQuote: async () => committedQuote,
    resolvePolicy: async () => {
      throw new Error("withdrawal commit must not resolve funding policy");
    },
    commitOperation: async (_db, input) => {
      await input.verifyCurrentFacts?.({} as never, committedQuote);
      return { operation: {} as never, replayed: false };
    },
    now: () => NOW,
  }).commit({
    userId: USER_ID,
    request: {
      quoteId: committedQuote.id,
      consentToken: quoteSummary.consentToken,
      idempotencyKey: "withdrawal_commit_12345678",
    },
    policy,
    policyRevision: resolvedPolicy.revision,
    ownershipRevision: "ownership_revision_12345678",
  });
  assert.equal(currentRecipientChecks, 2);
});

await test("quote preserves a venue-preparation runtime binding and rejects changed raw amounts", async () => {
  const store = new MemoryPlanningStore();
  const exactDestination = candidate();
  const request = intent("add_funds", "1000000");
  const placement = decidePlacement({
    intent: request,
    target: exactDestination.target,
    targetVenueId: "polymarket",
    targetRequirement: { asset: POLYGON_PUSD, raw: "1000000" },
    availableNow: exactDestination.availableNow,
    selectionReason: "explicit",
    policy: DEFAULT_FUNDING_RUNTIME_POLICY,
  });
  const prepared = plannedVenuePreparationSource("1000000", "privy_sponsor");
  const option = prepared.option;
  const basePlan = prepared.commitPlan;
  const exactPlan: FundingCommitPlan = {
    ...basePlan,
    operation: {
      ...basePlan.operation,
      planKind: "venue_preparation",
      sourceSnapshot: option as never,
      destinationTargetSnapshot: exactDestination.target as never,
      venueBindingSnapshot: exactDestination.venueBinding as never,
      placementSnapshot: placement as never,
      requestedSourceAmount: null,
    },
  };
  const projection = {
    ...liquidityProjectionFixture(),
    liquidityProjectionId: "projection_00000000-0000-4000-8000-000000000009",
    sourceOptions: [option],
    destinationOptions: [exactDestination.option],
  };
  await store.create({
    userId: USER_ID,
    request,
    projection,
    plannerSnapshot: {
      request,
      marketContext: null,
      destination: exactDestination,
      withdrawalRecipient: null,
      placement,
      sources: [
        {
          option,
          commitPlan: exactPlan,
          routeId: null,
          providerId: null,
        },
      ],
      projection,
      policyRevision: "policy_revision_12345678",
      ownershipRevision: "ownership_revision_12345678",
    },
    policyVersion: 1,
    policyRevision: "policy_revision_12345678",
    ownershipRevision: "ownership_revision_12345678",
    expiresAt: new Date("2026-07-24T12:01:00.000Z"),
  });
  const policy = mutablePolicy();
  policy.creationMode = "on";
  policy.gates.quoteCreation = true;
  const insertedPlans: FundingCommitPlan[] = [];
  const service = new FundingQuoteService({
    db: {} as never,
    planningStore: store,
    now: () => NOW,
    createQuote: async (_db, input) => {
      insertedPlans.push(input.planSnapshot);
      return {
        id: "quote_id_12345678",
        userId: input.userId,
        discoveryProjectionId: input.discoveryProjectionId,
        selectedSourceOptionSnapshot: input.selectedSourceOptionSnapshot,
        marketContextSnapshot: input.marketContextSnapshot,
        destinationOptionSnapshot: input.destinationOptionSnapshot,
        venueBindingSnapshot: input.venueBindingSnapshot,
        planSnapshot: input.planSnapshot,
        policyVersion: input.policyVersion,
        policyRevision: input.policyRevision,
        canonicalRequestHash: "b".repeat(64),
        planHash: canonicalJsonHash(input.planSnapshot),
        consentTokenHash: "c".repeat(64),
        expiresAt: input.expiresAt,
        consumedAt: null,
        invalidatedAt: null,
      };
    },
  });
  const summary = await service.quote({
    userId: USER_ID,
    request: {
      liquidityProjectionId: projection.liquidityProjectionId,
      selectedSourceOptionId: option.sourceOptionId,
      confirmedSourceAmount: null,
      requestedDestinationAmount: {
        asset: POLYGON_PUSD,
        raw: "1000000",
      },
    },
    policy,
    policyRevision: "policy_revision_12345678",
    ownershipRevision: "ownership_revision_12345678",
  });
  assert.equal(summary.selectedSourceOptionId, option.sourceOptionId);
  assert.equal(summary.minimumDestination.raw, "1000000");
  assert.deepEqual(summary.sourceAmounts, [
    {
      safeLabel: option.safeLabel,
      amount: { asset: POLYGON_PUSD, raw: "1000000" },
    },
  ]);
  assert.equal(
    insertedPlans[0]?.operation.supportMetadata?.ownershipRevision,
    "ownership_revision_12345678",
  );
  await assert.rejects(
    () =>
      service.quote({
        userId: USER_ID,
        request: {
          liquidityProjectionId: projection.liquidityProjectionId,
          selectedSourceOptionId: option.sourceOptionId,
          confirmedSourceAmount: null,
          requestedDestinationAmount: {
            asset: POLYGON_PUSD,
            raw: "999999",
          },
        },
        policy,
        policyRevision: "policy_revision_12345678",
        ownershipRevision: "ownership_revision_12345678",
      }),
    /raw amounts differ/,
  );
});

await test("quote preserves a frozen composite preparation binding without replanning", async () => {
  const store = new MemoryPlanningStore();
  const exactDestination = candidate({
    availableNow: { asset: POLYGON_PUSD, raw: "4108032" },
  });
  const request = intent("trade_shortfall", "8335681");
  const placement = decidePlacement({
    intent: request,
    target: exactDestination.target,
    targetVenueId: "polymarket",
    targetRequirement: { asset: POLYGON_PUSD, raw: "8335681" },
    availableNow: exactDestination.availableNow,
    selectionReason: "current_trade",
    policy: DEFAULT_FUNDING_RUNTIME_POLICY,
  });
  assert.equal(placement.destinationRequirement.raw, "4227649");
  const relayOption = sourceOption("658574", {
    sourceOptionId: "source_relay_residual_12345678",
  });
  assert.equal(relayOption.source.kind, "owned_location");
  if (relayOption.source.kind !== "owned_location") {
    throw new Error("relay fixture must use an owned source location");
  }
  const preparationAmount = {
    asset: POLYGON_PUSD,
    raw: "3569075",
  } as const;
  const relayAmount = {
    asset: POLYGON_PUSD,
    raw: "658574",
  } as const;
  const compositeOption: SourceOption = {
    sourceOptionId: "source_composite_preparation_relay_12345678",
    kind: "composite",
    safeLabel: "Use 2 balances",
    source: { kind: "composite", legCount: 2 },
    sourceLegs: [
      {
        sourceLegId: "source_leg_preparation_12345678",
        safeLabel: "Prepare trading balance",
        source: {
          kind: "venue_preparation",
          venueId: "polymarket",
          venueBindingId: exactDestination.venueBinding.bindingId,
          inputCount: 2,
        },
        sourceAmount: preparationAmount,
        expectedDestination: preparationAmount,
        minimumDestination: preparationAmount,
        fees: [],
        eta: { minSeconds: 5, maxSeconds: 90 },
        requiredActions: [],
      },
      {
        sourceLegId: "source_leg_relay_12345678",
        safeLabel: relayOption.safeLabel,
        source: relayOption.source,
        sourceAmount: relayAmount,
        expectedDestination: relayAmount,
        minimumDestination: relayAmount,
        fees: [],
        eta: { minSeconds: 5, maxSeconds: 20 },
        requiredActions: [],
      },
    ],
    amountMode: "exact_output",
    maximumSourceRaw: null,
    expectedDestination: { asset: POLYGON_PUSD, raw: "4227649" },
    minimumDestination: { asset: POLYGON_PUSD, raw: "4227649" },
    estimatedUsd: "4.227649",
    fees: [],
    eta: { minSeconds: 5, maxSeconds: 90 },
    experienceMode: "prepare_first",
    requiredActions: [],
    expiresAt: "2026-07-24T12:01:00.000Z",
    recommended: true,
    selectable: true,
    reasonCodes: [],
  };
  const relayPlan = commitPlan("658574", relayOption);
  const compositePlan: FundingCommitPlan = {
    ...relayPlan,
    operation: {
      ...relayPlan.operation,
      purpose: "trade_shortfall",
      experienceMode: "prepare_first",
      planKind: "composite_route",
      sourceSnapshot: compositeOption as never,
      destinationTargetSnapshot: exactDestination.target as never,
      venueBindingSnapshot: exactDestination.venueBinding as never,
      placementSnapshot: placement as never,
      requestedSourceAmount: null,
      requestedDestinationAmount: {
        asset: POLYGON_PUSD,
        raw: "4227649",
      },
      supportMetadata: {
        containsVenuePreparation: true,
        venuePreparationMinimumDestination: preparationAmount,
        venueBindingOptionId:
          exactDestination.bindingOption.venueBindingOptionId,
      },
    },
    segments: relayPlan.segments.map((segment) => ({
      ...segment,
      destinationTargetSnapshot: exactDestination.target as never,
    })),
    steps: [
      {
        ordinal: 0,
        segmentOrdinal: null,
        stepKind: "venue_preparation",
        state: "action_required",
        actionFingerprint: "d".repeat(64),
        executorId: "wallet_profile_evm_v1",
        payerRequirement: "privy_sponsor",
        dependsOnOrdinal: null,
        normalizedAction: { kind: "evm_transaction" },
        actionValidationResult: {
          valid: true,
          compositeSourceLegId: "source_leg_preparation_12345678",
        },
      },
    ],
    reservations: [
      {
        segmentOrdinal: null,
        componentId: "component_preparation_token_12345678",
        locationId: "location_preparation_token_12345678",
        networkId: POLYGON_OTHER_TOKEN.networkId,
        assetId: POLYGON_OTHER_TOKEN.assetId,
        assetDecimals: POLYGON_OTHER_TOKEN.decimals,
        rawAmount: "100000000000000000",
        mode: "subtract_available",
        expiresAt: compositeOption.expiresAt,
      },
      {
        segmentOrdinal: null,
        componentId: "component_preparation_pusd_12345678",
        locationId: "location_preparation_pusd_12345678",
        networkId: POLYGON_PUSD.networkId,
        assetId: POLYGON_PUSD.assetId,
        assetDecimals: POLYGON_PUSD.decimals,
        rawAmount: "2000000",
        mode: "subtract_available",
        expiresAt: compositeOption.expiresAt,
      },
    ],
  };
  const projection = {
    ...liquidityProjectionFixture(),
    liquidityProjectionId: "projection_composite_quote_12345678",
    requestedCollateralRaw: "8335681",
    availableNowRaw: "4108032",
    shortfallRaw: "4227649",
    convertibleRaw: "4227649",
    requestedUsd: "8.335681",
    availableNowUsd: "4.108032",
    shortfallUsd: "4.227649",
    convertibleUsd: "4.227649",
    mode: "prepare_first" as const,
    sourceOptions: [compositeOption],
    destinationOptions: [exactDestination.option],
  };
  await store.create({
    userId: USER_ID,
    request,
    projection,
    plannerSnapshot: {
      request,
      marketContext: null,
      destination: exactDestination,
      withdrawalRecipient: null,
      placement,
      sources: [
        {
          option: compositeOption,
          commitPlan: compositePlan,
          routeId: null,
          providerId: null,
        },
      ],
      projection,
      policyRevision: "policy_revision_12345678",
      ownershipRevision: "ownership_revision_12345678",
    },
    policyVersion: 1,
    policyRevision: "policy_revision_12345678",
    ownershipRevision: "ownership_revision_12345678",
    expiresAt: new Date("2026-07-24T12:01:00.000Z"),
  });
  const policy = mutablePolicy();
  policy.creationMode = "on";
  policy.gates.quoteCreation = true;
  const insertedPlans: FundingCommitPlan[] = [];
  const service = new FundingQuoteService({
    db: {} as never,
    planningStore: store,
    now: () => NOW,
    createQuote: async (_db, input) => {
      insertedPlans.push(input.planSnapshot);
      return {
        id: "quote_composite_12345678",
        userId: input.userId,
        discoveryProjectionId: input.discoveryProjectionId,
        selectedSourceOptionSnapshot: input.selectedSourceOptionSnapshot,
        marketContextSnapshot: input.marketContextSnapshot,
        destinationOptionSnapshot: input.destinationOptionSnapshot,
        venueBindingSnapshot: input.venueBindingSnapshot,
        planSnapshot: input.planSnapshot,
        policyVersion: input.policyVersion,
        policyRevision: input.policyRevision,
        canonicalRequestHash: "b".repeat(64),
        planHash: canonicalJsonHash(input.planSnapshot),
        consentTokenHash: "c".repeat(64),
        expiresAt: input.expiresAt,
        consumedAt: null,
        invalidatedAt: null,
      };
    },
  });
  const summary = await service.quote({
    userId: USER_ID,
    request: {
      liquidityProjectionId: projection.liquidityProjectionId,
      selectedSourceOptionId: compositeOption.sourceOptionId,
      confirmedSourceAmount: null,
      requestedDestinationAmount: {
        asset: POLYGON_PUSD,
        raw: "4227649",
      },
    },
    policy,
    policyRevision: "policy_revision_12345678",
    ownershipRevision: "ownership_revision_12345678",
  });

  assert.equal(summary.selectedSourceOptionId, compositeOption.sourceOptionId);
  assert.equal(summary.minimumDestination.raw, "4227649");
  assert.equal(summary.consentMode, "explicit_economic_review");
  assert.deepEqual(
    summary.sourceAmounts.map((source) => source.amount),
    [
      { asset: POLYGON_OTHER_TOKEN, raw: "100000000000000000" },
      { asset: POLYGON_PUSD, raw: "2000000" },
      relayAmount,
    ],
  );
  assert.deepEqual(
    insertedPlans[0]?.operation.venueBindingSnapshot,
    exactDestination.venueBinding,
  );
});

await test("direct ingress receives a fresh commit window after review", async () => {
  const store = new MemoryPlanningStore();
  const exactDestination = candidate();
  const request = intent("add_funds", "1000000");
  const placement = decidePlacement({
    intent: request,
    target: exactDestination.target,
    targetVenueId: "polymarket",
    targetRequirement: { asset: POLYGON_PUSD, raw: "1000000" },
    availableNow: exactDestination.availableNow,
    selectionReason: "explicit",
    policy: DEFAULT_FUNDING_RUNTIME_POLICY,
  });
  const ingress = {
    ingressKind: "manual" as const,
    sourceNetworkId: POLYGON_PUSD.networkId,
    sourceAsset: POLYGON_PUSD,
    destinationOptionId: exactDestination.option.destinationOptionId,
    destinationAddress: "0x00000000000000000000000000000000000000aa",
    requestedAmount: { asset: POLYGON_PUSD, raw: "1000000" },
    amountSemantics: "minimum" as const,
    expiresAt: "2026-07-24T12:00:30.000Z",
    safeInstructions: ["Send only pUSD on Polygon."],
  };
  const option = sourceOption("1000000", {
    kind: "manual_receive",
    safeLabel: "Deposit crypto",
    source: {
      kind: "external_ingress",
      ingressKind: "manual",
      networkId: POLYGON_PUSD.networkId,
      asset: POLYGON_PUSD,
      controlledSender: false,
    },
    ingress,
    experienceMode: "prepare_first",
    requiredActions: [
      {
        kind: "external_handoff",
        safeLabel: "Explicitly send from your external wallet",
        actor: "user",
        valueMoving: true,
        sponsorship: "none",
      },
    ],
    expiresAt: ingress.expiresAt,
  });
  const exactPlan: FundingCommitPlan = {
    operation: {
      purpose: "add_funds",
      initialState: {
        status: "awaiting_external_funds",
        stage: "source_action",
      },
      experienceMode: "prepare_first",
      planKind: "direct_external_handoff",
      sourceSnapshot: option as never,
      destinationTargetSnapshot: exactDestination.target as never,
      externalRecipientId: null,
      venueId: "polymarket",
      marketId: null,
      marketContextSnapshot: null,
      venueBindingSnapshot: exactDestination.bindingOption as never,
      walletExecutionSnapshot: null,
      placementSnapshot: placement as never,
      requestedSourceAmount: {
        asset: POLYGON_PUSD,
        raw: "1000000",
      } as never,
      requestedDestinationAmount: {
        asset: POLYGON_PUSD,
        raw: "1000000",
      } as never,
    },
    segments: [],
    steps: [],
    reservations: [],
  };
  const projection = {
    ...liquidityProjectionFixture(),
    liquidityProjectionId: "projection_00000000-0000-4000-8000-000000000010",
    sourceOptions: [option],
    destinationOptions: [exactDestination.option],
  };
  await store.create({
    userId: USER_ID,
    request,
    projection,
    plannerSnapshot: {
      request,
      marketContext: null,
      destination: exactDestination,
      withdrawalRecipient: null,
      placement,
      sources: [
        {
          option,
          commitPlan: exactPlan,
          routeId: null,
          providerId: null,
        },
      ],
      projection,
      policyRevision: "policy_revision_12345678",
      ownershipRevision: "ownership_revision_12345678",
    },
    policyVersion: 1,
    policyRevision: "policy_revision_12345678",
    ownershipRevision: "ownership_revision_12345678",
    expiresAt: new Date(ingress.expiresAt),
  });
  const policy = mutablePolicy();
  policy.creationMode = "on";
  policy.gates.quoteCreation = true;
  const quoteNow = new Date("2026-07-24T12:00:29.000Z");
  let storedExpiresAtIso = "";
  const service = new FundingQuoteService({
    db: {} as never,
    planningStore: store,
    now: () => quoteNow,
    createQuote: async (_db, input) => {
      storedExpiresAtIso = input.expiresAt.toISOString();
      return {
        id: "quote_direct_ingress_12345678",
        userId: input.userId,
        discoveryProjectionId: input.discoveryProjectionId,
        selectedSourceOptionSnapshot: input.selectedSourceOptionSnapshot,
        marketContextSnapshot: input.marketContextSnapshot,
        destinationOptionSnapshot: input.destinationOptionSnapshot,
        venueBindingSnapshot: input.venueBindingSnapshot,
        planSnapshot: input.planSnapshot,
        policyVersion: input.policyVersion,
        policyRevision: input.policyRevision,
        canonicalRequestHash: "b".repeat(64),
        planHash: canonicalJsonHash(input.planSnapshot),
        consentTokenHash: "c".repeat(64),
        expiresAt: input.expiresAt,
        consumedAt: null,
        invalidatedAt: null,
      };
    },
  });
  const summary = await service.quote({
    userId: USER_ID,
    request: {
      liquidityProjectionId: projection.liquidityProjectionId,
      selectedSourceOptionId: option.sourceOptionId,
      confirmedSourceAmount: null,
      requestedDestinationAmount: {
        asset: POLYGON_PUSD,
        raw: "1000000",
      },
    },
    policy,
    policyRevision: "policy_revision_12345678",
    ownershipRevision: "ownership_revision_12345678",
  });

  assert.equal(storedExpiresAtIso, "2026-07-24T12:00:59.000Z");
  assert.equal(summary.expiresAt, "2026-07-24T12:00:59.000Z");
});

await test("commit revalidates policy and ownership under the locked quote", async () => {
  const policy = mutablePolicy();
  policy.creationMode = "on";
  policy.gates.commit = true;
  const option = sourceOption("1000000");
  const plan = {
    ...commitPlan("1000000", option),
    operation: {
      ...commitPlan("1000000", option).operation,
      supportMetadata: {
        ownershipRevision: "ownership_revision_12345678",
      },
    },
  };
  const quote = {
    id: "quote_id_12345678",
    userId: USER_ID,
    discoveryProjectionId: "projection_00000000-0000-4000-8000-000000000001",
    selectedSourceOptionSnapshot: option as never,
    marketContextSnapshot: null,
    destinationOptionSnapshot: plan.operation.destinationTargetSnapshot,
    venueBindingSnapshot: plan.operation.venueBindingSnapshot,
    planSnapshot: plan,
    policyVersion: policy.version,
    policyRevision: "policy_revision_12345678",
    canonicalRequestHash: "a".repeat(64),
    planHash: canonicalJsonHash(plan),
    consentTokenHash: "b".repeat(64),
    expiresAt: new Date("2026-07-24T12:01:00.000Z"),
    consumedAt: null,
    invalidatedAt: null,
  };
  const resolvedPolicy = {
    source: "db" as const,
    policy,
    revision: "policy_revision_12345678",
    effectiveAt: NOW,
    createdAt: NOW,
    createdBy: USER_ID,
    invalidStoredPolicy: false,
    validationIssues: [],
  };
  const build = (ownershipRevision: string, currentPolicy = resolvedPolicy) =>
    new FundingOperationService({
      db: {} as never,
      subjectLookupHmac: () => "c".repeat(64),
      subjectLookupKeyVersion: 1,
      resolveOwnershipRevision: async () => ownershipRevision,
      fetchQuote: async () => quote,
      resolvePolicy: async () => currentPolicy,
      commitOperation: async (_db, input) => {
        await input.verifyCurrentFacts?.({} as never, quote);
        return { operation: {} as never, replayed: false };
      },
      now: () => NOW,
    });
  const request = {
    quoteId: quote.id,
    consentToken: "consent_token_12345678",
    idempotencyKey: "idempotency_key_12345678",
  };
  await build("ownership_revision_12345678").commit({
    userId: USER_ID,
    request,
    policy,
    policyRevision: resolvedPolicy.revision,
    ownershipRevision: "ownership_revision_12345678",
  });
  await assert.rejects(
    () =>
      build("ownership_revision_changed").commit({
        userId: USER_ID,
        request,
        policy,
        policyRevision: resolvedPolicy.revision,
        ownershipRevision: "ownership_revision_12345678",
      }),
    /ownership facts changed/i,
  );
  await assert.rejects(
    () =>
      build("ownership_revision_12345678", {
        ...resolvedPolicy,
        revision: "policy_revision_changed",
      }).commit({
        userId: USER_ID,
        request,
        policy,
        policyRevision: resolvedPolicy.revision,
        ownershipRevision: "ownership_revision_12345678",
      }),
    /policy changed/i,
  );
});

console.log("[funding-planner-tests] complete");

function liquidityProjectionFixture() {
  return {
    liquidityProjectionId: "projection_00000000-0000-4000-8000-000000000001",
    marketContextId: null,
    venueId: "polymarket",
    venueBindingOptionId: "binding_poly_12345678",
    destinationOptionId: "destination_poly_12345678",
    collateralAsset: POLYGON_PUSD,
    requestedCollateralRaw: "1000000",
    availableNowRaw: "0",
    shortfallRaw: "1000000",
    convertibleRaw: "0",
    requestedUsd: "1",
    availableNowUsd: "0",
    shortfallUsd: "1",
    convertibleUsd: "0",
    mode: "inline_funding" as const,
    eta: { minSeconds: 5, maxSeconds: 20 },
    requiredActions: [],
    sourceOptions: [],
    asOf: NOW.toISOString(),
    expiresAt: "2026-07-24T12:01:00.000Z",
    policyVersion: 1,
    completeness: "complete" as const,
    freshness: "fresh" as const,
    errors: [],
    reasonCodes: [],
    destinationOptions: [],
  };
}
