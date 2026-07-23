#!/usr/bin/env tsx

import assert from "node:assert/strict";
import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";

import {
  projectAccountValue,
  resolveEffectiveHeadline,
} from "./account-value/account-value-projector.js";
import {
  rankAssetsForSuggestion,
  type StoredAssetFundingPreference,
} from "./account-value/asset-preferences.js";
import {
  deduplicateObservedAssets,
  deduplicatePositionComponents,
} from "./account-value/canonical.js";
import { projectCashAvailability } from "./account-value/cash-availability-projector.js";
import {
  addUnsignedDecimals,
  multiplyRawByUnitPrice,
  scaleUnsignedDecimalByRawRatio,
  subtractUnsignedDecimals,
} from "./account-value/decimal.js";
import {
  ExactStablePriceAdapter,
  resolveStableImpairmentState,
  ValuationService,
} from "./account-value/valuation-service.js";
import {
  estimatePositionUsdFromExactText,
  readResolvedPositionProbability,
} from "./account-value/position-value-collectors.js";
import { ExistingFactsOwnershipResolver } from "./account-value/ownership-resolver.js";
import type { PriceAdapter } from "./funding/domain/contracts.js";
import type {
  AssetLocation,
  AssetRef,
  ObservedAsset,
  ValuedAssetComponent,
  ValuedPositionComponent,
} from "./funding/domain/types.js";
import {
  registerAccountValueRoutes,
  type AccountValueRouteDependencies,
} from "./routes/account-value.js";

const NOW = new Date("2026-07-23T12:00:00.000Z");
const USDC: AssetRef = {
  networkId: "evm:137",
  assetId: "0x0000000000000000000000000000000000000001",
  decimals: 6,
};

function location(
  id: string,
  details: Record<string, string> = {},
): AssetLocation {
  return {
    kind: "wallet",
    locationId: `location_${id.padEnd(8, "0")}`,
    accountId: "account_00000001",
    asset: USDC,
    details: {
      address: "0x00000000000000000000000000000000000000aa",
      ...details,
    },
  };
}

function observation(inputs: {
  id: string;
  raw?: string;
  observedAt?: string;
  location?: AssetLocation;
}): ObservedAsset {
  const resolvedLocation = inputs.location ?? location(inputs.id);
  return {
    componentId: `asset_${inputs.id.padEnd(8, "0")}`,
    location: resolvedLocation,
    amount: { asset: USDC, raw: inputs.raw ?? "1000000" },
    ownershipEvidenceId: `evidence_${inputs.id.padEnd(8, "0")}`,
    observedAt: inputs.observedAt ?? NOW.toISOString(),
    observationFreshness: "fresh",
    observationError: null,
    metadataRisk: "verified",
  };
}

async function valuedAsset(inputs: {
  id: string;
  raw?: string;
  category?: "cash" | "token" | "in_transit";
  details?: Record<string, string>;
  executionEligibility?: ValuedAssetComponent["executionEligibility"];
}): Promise<ValuedAssetComponent> {
  const stableStates = new Map([
    [
      "evm:137:0x0000000000000000000000000000000000000001:6",
      {
        status: "healthy" as const,
      },
    ],
  ]);
  const service = new ValuationService({
    policies: [
      {
        asset: USDC,
        category: inputs.category ?? "cash",
        pricePolicyId: "exact-stable-policy-v1",
        maximumObservationAgeMs: 60_000,
        executionEligibility: inputs.executionEligibility ?? "unknown",
      },
    ],
    adapters: [new ExactStablePriceAdapter(stableStates)],
    stableStates,
  });
  const [component] = await service.value(
    [
      observation({
        id: inputs.id,
        raw: inputs.raw,
        location: location(inputs.id, inputs.details),
      }),
    ],
    NOW,
  );
  if (!component) throw new Error("valued fixture missing");
  return component;
}

async function test(name: string, fn: () => Promise<void> | void) {
  await fn();
  console.log(`[account-value-tests] ok ${name}`);
}

await test("decimal arithmetic never depends on JavaScript floating point", () => {
  assert.equal(
    addUnsignedDecimals(["0.1", "0.2", "1000000000000000000.000001"]),
    "1000000000000000000.300001",
  );
  assert.equal(
    multiplyRawByUnitPrice({
      raw: "1234567",
      decimals: 6,
      unitPriceUsd: "0.9995",
    }),
    "1.2339497165",
  );
  assert.equal(subtractUnsignedDecimals("1", "0.3333"), "0.6667");
  assert.equal(
    scaleUnsignedDecimalByRawRatio({
      value: "25",
      numeratorRaw: "80",
      denominatorRaw: "100",
    }),
    "20",
  );
});

await test("duplicate ownership evidence counts one canonical balance", () => {
  const sharedLocation = location("dedupe");
  const result = deduplicateObservedAssets([
    observation({ id: "a", location: sharedLocation }),
    observation({ id: "b", location: sharedLocation }),
  ]);
  assert.equal(result.observations.length, 1);
  assert.equal(result.duplicateCount, 1);
  assert.deepEqual(result.ambiguousComponentIds, []);
});

await test("conflicting same-time duplicates fail closed", () => {
  const sharedLocation = location("conflict");
  const result = deduplicateObservedAssets([
    observation({ id: "a", raw: "1000000", location: sharedLocation }),
    observation({ id: "b", raw: "2000000", location: sharedLocation }),
  ]);
  assert.equal(result.observations.length, 1);
  assert.equal(
    result.observations[0]?.observationError?.code,
    "ambiguous_duplicate_observation",
  );
});

await test("ownership profiles and venue bindings have canonical unique ids", async () => {
  const resolver = new ExistingFactsOwnershipResolver({
    wallets: [
      {
        address: "0x00000000000000000000000000000000000000aa",
        walletType: "ethereum",
        source: "external",
        linkedAddress: "0x00000000000000000000000000000000000000aa",
        serverWalletRef: null,
      },
    ],
    venueBindings: [
      {
        venueId: "polymarket",
        controllerAddress: "0x00000000000000000000000000000000000000aa",
        executionAddress: "0x00000000000000000000000000000000000000aa",
        accountRef: "0x00000000000000000000000000000000000000aa",
        settlementAsset: USDC,
        signingMode: "web_client",
      },
    ],
    now: () => NOW,
  });
  const graph = await resolver.resolve("account_00000001");
  assert.equal(graph.wallets.length, 2);
  assert.equal(new Set(graph.wallets.map((wallet) => wallet.walletId)).size, 2);
  assert.equal(graph.venueBindings.length, 1);
  assert.equal(graph.venueBindings[0]?.venueId, "polymarket");
});

await test("exact stable policy values only the configured contract", async () => {
  const component = await valuedAsset({ id: "stable", raw: "1234567" });
  assert.equal(component.estimatedUsd?.value, "1.234567");
  assert.equal(component.valuationEligibility, "included");

  const impairedStates = new Map([
    [
      "evm:137:0x0000000000000000000000000000000000000001:6",
      {
        status: "impaired" as const,
        reasonCode: "asset_unpriced" as const,
        observedAt: NOW.toISOString(),
      },
    ],
  ]);
  const impairedService = new ValuationService({
    policies: [
      {
        asset: USDC,
        category: "cash",
        pricePolicyId: "exact-stable-policy-v1",
        maximumObservationAgeMs: 60_000,
        executionEligibility: "eligible",
      },
    ],
    adapters: [new ExactStablePriceAdapter(impairedStates)],
    stableStates: impairedStates,
  });
  const [impaired] = await impairedService.value(
    [observation({ id: "impaired" })],
    NOW,
  );
  assert.equal(impaired?.estimatedUsd, null);
  assert.equal(impaired?.valuationEligibility, "unpriced");
  assert.equal(impaired?.executionEligibility, "ineligible");
  assert.equal(
    resolveStableImpairmentState("stable-impaired-v1", NOW.toISOString())
      .status,
    "impaired",
  );
});

await test("priced token contributes to estimated assets but never cash availability", async () => {
  const token: AssetRef = {
    networkId: "evm:8453",
    assetId: "0x0000000000000000000000000000000000000002",
    decimals: 18,
  };
  const tokenLocation: AssetLocation = {
    kind: "wallet",
    locationId: "location_token_00000001",
    accountId: "account_00000001",
    asset: token,
    details: {
      address: "0x00000000000000000000000000000000000000aa",
    },
  };
  const adapter: PriceAdapter = {
    adapterId: "test-token-price",
    async value(input) {
      if (input.policyId !== "test-token-price") return null;
      return {
        value: "25",
        asOf: input.observedAt,
        priceSource: "test-token-price",
        confidence: "medium",
        policyId: input.policyId,
      };
    },
  };
  const service = new ValuationService({
    policies: [
      {
        asset: token,
        category: "token",
        pricePolicyId: "test-token-price",
        maximumObservationAgeMs: 60_000,
        executionEligibility: "ineligible",
      },
    ],
    adapters: [adapter],
  });
  const [component] = await service.value(
    [
      {
        componentId: "asset_token_00000001",
        location: tokenLocation,
        amount: { asset: token, raw: "1000000000000000000" },
        ownershipEvidenceId: "evidence_token_00000001",
        observedAt: NOW.toISOString(),
        observationFreshness: "fresh",
        observationError: null,
        metadataRisk: "verified",
      },
    ],
    NOW,
  );
  if (!component) throw new Error("priced token fixture missing");
  const projection = projectAccountValue({
    accountId: "account_00000001",
    headlineMode: "liquid_only",
    components: [component],
    positionComponents: [],
    asOf: NOW.toISOString(),
  });
  const cashAvailability = projectCashAvailability({
    components: [component],
    adjustments: [],
    asOf: NOW.toISOString(),
  });
  assert.equal(projection.tokenEstimatedUsd, "25");
  assert.equal(projection.liquidAssetsEstimatedUsd, "25");
  assert.equal(component.executionEligibility, "ineligible");
  assert.equal(cashAvailability.cashAvailableEstimatedUsd, "0");
});

await test("locks reduce availability but never Account Value", async () => {
  const cash = await valuedAsset({ id: "cash", raw: "10000000" });
  const account = projectAccountValue({
    accountId: "account_00000001",
    headlineMode: "liquid_only",
    components: [cash],
    positionComponents: [],
    asOf: NOW.toISOString(),
  });
  const availability = projectCashAvailability({
    components: [cash],
    adjustments: [
      {
        componentId: cash.componentId,
        venueId: "polymarket",
        venueBindingId: "binding_00000001",
        lockedRaw: "3000000",
        reservedRaw: "1000000",
        submittedDebitRaw: "500000",
      },
    ],
    asOf: NOW.toISOString(),
  });
  assert.equal(account.liquidAssetsEstimatedUsd, "10");
  assert.equal(availability.cashAvailableEstimatedUsd, "5.5");
});

await test("availability scales non-stable estimates without floating point", async () => {
  const cash = {
    ...(await valuedAsset({ id: "ratio", raw: "100" })),
    estimatedUsd: {
      value: "25",
      asOf: NOW.toISOString(),
      priceSource: "test-token-price",
      confidence: "medium" as const,
      policyId: "test-token-policy",
    },
  };
  const availability = projectCashAvailability({
    components: [cash],
    adjustments: [
      {
        componentId: cash.componentId,
        venueId: "limitless",
        venueBindingId: "binding_00000001",
        lockedRaw: "20",
        reservedRaw: "0",
        submittedDebitRaw: "0",
      },
    ],
    asOf: NOW.toISOString(),
  });
  assert.equal(availability.cashAvailableEstimatedUsd, "20");
});

await test("unknown venue locks fail availability closed without reducing value", async () => {
  const cash = await valuedAsset({ id: "unknown-locks", raw: "10000000" });
  const availability = projectCashAvailability({
    components: [cash],
    adjustments: [
      {
        componentId: cash.componentId,
        venueId: "polymarket",
        venueBindingId: "binding_00000001",
        lockedRaw: "0",
        reservedRaw: "0",
        submittedDebitRaw: "0",
        availabilityKnown: false,
      },
    ],
    collectorErrors: [
      {
        collectorId: "cash-availability-locks",
        code: "cash_lock_collection_failed",
        retryable: true,
      },
    ],
    asOf: NOW.toISOString(),
  });
  assert.equal(availability.cashAvailableEstimatedUsd, "0");
  assert.equal(availability.components[0]?.availableEstimatedUsd, null);
  assert.equal(availability.completeness, "partial");
  assert.equal(availability.freshness, "stale");
  assert.equal(cash.estimatedUsd?.value, "10");
});

await test("headline mode changes presentation only", async () => {
  const cash = await valuedAsset({ id: "headline", raw: "10000000" });
  const position: ValuedPositionComponent = {
    componentId: "position_00000001",
    venueId: "polymarket",
    venueBindingId: "binding_00000001",
    positionRef: "polymarket:wallet:token",
    estimatedUsd: {
      value: "3",
      asOf: NOW.toISOString(),
      priceSource: "test",
      confidence: "medium",
      policyId: "position-test",
    },
    valuationMethod: "test",
    observedAt: NOW.toISOString(),
    observationFreshness: "fresh",
    observationError: null,
    valuationEligibility: "included",
    reasonCodes: [],
  };
  const liquid = projectAccountValue({
    accountId: "account_00000001",
    headlineMode: "liquid_only",
    components: [cash],
    positionComponents: [position],
    asOf: NOW.toISOString(),
  });
  const portfolio = projectAccountValue({
    accountId: "account_00000001",
    headlineMode: "liquid_plus_positions",
    components: [cash],
    positionComponents: [position],
    asOf: NOW.toISOString(),
  });
  assert.equal(
    liquid.liquidAssetsEstimatedUsd,
    portfolio.liquidAssetsEstimatedUsd,
  );
  assert.equal(liquid.positionsEstimatedUsd, portfolio.positionsEstimatedUsd);
  assert.equal(liquid.totalPortfolioEstimatedUsd, "13");
  assert.equal(resolveEffectiveHeadline(liquid).estimatedUsd, "10");
  assert.equal(resolveEffectiveHeadline(portfolio).estimatedUsd, "13");
});

await test("partial collector failure preserves known value and reports partial", async () => {
  const cash = await valuedAsset({ id: "partial", raw: "10000000" });
  const projection = projectAccountValue({
    accountId: "account_00000001",
    headlineMode: "liquid_only",
    components: [cash],
    positionComponents: [],
    collectorErrors: [
      {
        collectorId: "wallet-inventory",
        code: "wallet_balance_collection_failed",
        retryable: true,
      },
    ],
    asOf: NOW.toISOString(),
  });
  assert.equal(projection.liquidAssetsEstimatedUsd, "10");
  assert.equal(projection.valuationCompleteness, "partial");
});

await test("source, in-transit, and destination representations count once", async () => {
  const source = await valuedAsset({
    id: "move-src",
    raw: "5000000",
    details: { movementId: "operation_1", representationStage: "source" },
  });
  const transit = await valuedAsset({
    id: "move-mid",
    raw: "4900000",
    category: "in_transit",
    details: {
      movementId: "operation_1",
      representationStage: "in_transit",
    },
  });
  const destination = await valuedAsset({
    id: "move-dst",
    raw: "4800000",
    details: {
      movementId: "operation_1",
      representationStage: "destination",
    },
  });
  const projection = projectAccountValue({
    accountId: "account_00000001",
    headlineMode: "liquid_only",
    components: [source, transit, destination],
    positionComponents: [],
    asOf: NOW.toISOString(),
  });
  assert.equal(projection.liquidAssetsEstimatedUsd, "4.8");
  assert.equal(
    projection.components.filter(
      (component) => component.valuationEligibility === "included",
    ).length,
    1,
  );
  const availability = projectCashAvailability({
    components: [source, transit, destination],
    adjustments: [],
    asOf: NOW.toISOString(),
  });
  assert.equal(availability.cashAvailableEstimatedUsd, "4.8");
  assert.equal(availability.components.length, 1);
});

await test("duplicate positions count once and conflicting marks fail closed", () => {
  assert.equal(readResolvedPositionProbability("0.25"), "0.25");
  assert.equal(readResolvedPositionProbability("2500"), "0.25");
  assert.equal(
    estimatePositionUsdFromExactText({
      size: "9007199254740993.123456",
      price: "0.5",
    }),
    "4503599627370496.561728",
  );
  const base: ValuedPositionComponent = {
    componentId: "position_00000001",
    venueId: "limitless",
    venueBindingId: "binding_00000001",
    positionRef: "limitless:wallet:token",
    estimatedUsd: {
      value: "2",
      asOf: NOW.toISOString(),
      priceSource: "test",
      confidence: "medium",
      policyId: "position-test",
    },
    valuationMethod: "test",
    observedAt: NOW.toISOString(),
    observationFreshness: "fresh",
    observationError: null,
    valuationEligibility: "included",
    reasonCodes: [],
  };
  const same = deduplicatePositionComponents([
    base,
    { ...base, componentId: "position_00000002" },
  ]);
  assert.equal(same.components.length, 1);
  assert.equal(same.duplicateCount, 1);

  const baseEstimate = base.estimatedUsd;
  if (!baseEstimate) throw new Error("position estimate fixture is missing");
  const conflict = deduplicatePositionComponents([
    base,
    {
      ...base,
      componentId: "position_00000003",
      estimatedUsd: { ...baseEstimate, value: "3" },
    },
  ]);
  assert.equal(conflict.components[0]?.valuationEligibility, "excluded");
  assert.equal(conflict.components[0]?.estimatedUsd, null);
});

await test("suggestion preference ranks only and grants no execution eligibility", async () => {
  const suggested = await valuedAsset({
    id: "suggested",
    category: "token",
    executionEligibility: "temporarily_unavailable",
  });
  const ordinary = await valuedAsset({
    id: "ordinary",
    category: "token",
    executionEligibility: "unknown",
  });
  const preferences: Record<string, StoredAssetFundingPreference> = {
    [suggested.componentId]: {
      componentId: suggested.componentId,
      preference: "suggest",
      revision: "1",
    },
  };
  const ranked = rankAssetsForSuggestion({
    components: [ordinary, suggested],
    preferences,
  });
  assert.equal(ranked[0]?.componentId, suggested.componentId);
  assert.equal(ranked[0]?.executionEligibility, "temporarily_unavailable");
  assert.equal(ranked[0]?.amount.raw, suggested.amount.raw);
});

await test("account routes require auth and preference response denies authority", async () => {
  const cash = await valuedAsset({ id: "route", raw: "1000000" });
  const secondCash = await valuedAsset({ id: "route-second", raw: "1000000" });
  const projection = projectAccountValue({
    accountId: "account_00000001",
    headlineMode: "liquid_only",
    components: [cash, secondCash],
    positionComponents: [],
    asOf: NOW.toISOString(),
  });
  const account = {
    projection,
    headline: resolveEffectiveHeadline(projection),
    cashAvailability: projectCashAvailability({
      components: [cash, secondCash],
      adjustments: [],
      asOf: NOW.toISOString(),
    }),
    venues: {
      polymarket: {
        cashEstimatedUsd: "2",
        cashAvailableEstimatedUsd: "2",
        positionsEstimatedUsd: "0",
        totalPortfolioEstimatedUsd: "2",
      },
    },
    policy: {
      creationMode: "off" as const,
      revision: "revision_00000001",
      source: "default" as const,
      invalidStoredPolicy: false,
    },
    ownershipEvidenceRevision: "a".repeat(64),
    duplicateAssetObservationCount: 0,
    assetPreferences: {},
  };
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const dependencies: AccountValueRouteDependencies = {
    authenticate: async (request) => {
      if (request.headers.authorization !== "test") return;
      request.user = { id: "account_00000001" } as NonNullable<
        typeof request.user
      >;
    },
    build: async () => account,
    setPreference: async (_userId, component, preference) => ({
      componentId: component.componentId,
      preference,
      revision: "1",
    }),
  };
  registerAccountValueRoutes(app, dependencies);
  await app.ready();

  const anonymous = await app.inject({
    method: "GET",
    url: "/account/value",
  });
  assert.equal(anonymous.statusCode, 401);

  const value = await app.inject({
    method: "GET",
    url: "/account/value",
    headers: { authorization: "test" },
  });
  assert.equal(value.statusCode, 200);
  assert.equal(value.json().account.headline.estimatedUsd, "2");

  const firstAssetsPage = await app.inject({
    method: "GET",
    url: "/account/assets?limit=1",
    headers: { authorization: "test" },
  });
  assert.equal(firstAssetsPage.statusCode, 200);
  assert.equal(firstAssetsPage.json().items.length, 1);
  assert.equal(firstAssetsPage.json().total, 2);
  assert.equal(typeof firstAssetsPage.json().nextCursor, "string");

  const secondAssetsPage = await app.inject({
    method: "GET",
    url: `/account/assets?limit=1&cursor=${encodeURIComponent(
      String(firstAssetsPage.json().nextCursor),
    )}`,
    headers: { authorization: "test" },
  });
  assert.equal(secondAssetsPage.statusCode, 200);
  assert.equal(secondAssetsPage.json().items.length, 1);
  assert.equal(secondAssetsPage.json().nextCursor, null);

  const preference = await app.inject({
    method: "PATCH",
    url: `/account/assets/${cash.componentId}/funding-preference`,
    headers: { authorization: "test" },
    payload: { preference: "suggest" },
  });
  assert.equal(preference.statusCode, 200);
  assert.equal(preference.json().grantsTransactionAuthority, false);
  await app.close();
});

console.log("[account-value-tests] complete");
