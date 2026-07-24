#!/usr/bin/env tsx

import assert from "node:assert/strict";
import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";

import type {
  FundingDestinationOption,
  FundingQuoteSummary,
  IntentLiquidityProjection,
} from "./funding/domain/types.js";
import type { FundingOperationRow } from "./funding/persistence/funding-operation-repository.js";
import { FundingPlannerError } from "./funding/planner/money.js";
import {
  registerFundingRoutes,
  type FundingRouteDependencies,
} from "./routes/funding.js";

const USER_ID = "10000000-0000-4000-8000-000000000001";
const NOW = new Date("2026-07-24T12:00:00.000Z");
const ASSET = {
  networkId: "evm:137",
  assetId: "0x0000000000000000000000000000000000000001",
  decimals: 6,
};

async function test(name: string, run: () => void | Promise<void>) {
  await run();
  console.log(`[funding-routes-tests] ok ${name}`);
}

function destination(): FundingDestinationOption {
  return {
    destinationOptionId: "destination_poly_12345678",
    venueId: "polymarket",
    venueBindingOptionId: "binding_poly_12345678",
    safeLabel: "Polymarket · Hunch Trading Wallet",
    requiredAsset: ASSET,
    networkLabel: "Polygon",
    readinessClass: "internal_managed",
    preparationStatus: "ready",
    preparationPurpose: "fund",
    executionMode: "privy_authorization",
    marketClass: null,
    topology: "deposit_wallet",
    inspectionRevision: "inspection_poly_12345678",
    recommended: true,
    selectable: true,
    reasonCodes: [],
  };
}

function liquidity(): IntentLiquidityProjection {
  return {
    liquidityProjectionId: "projection_00000000-0000-4000-8000-000000000001",
    marketContextId: null,
    venueId: "polymarket",
    venueBindingOptionId: "binding_poly_12345678",
    destinationOptionId: "destination_poly_12345678",
    collateralAsset: ASSET,
    requestedCollateralRaw: "1000000",
    availableNowRaw: "0",
    shortfallRaw: "1000000",
    convertibleRaw: "0",
    requestedUsd: "1",
    availableNowUsd: "0",
    shortfallUsd: "1",
    convertibleUsd: "0",
    mode: "prepare_first",
    eta: null,
    requiredActions: [],
    sourceOptions: [],
    asOf: NOW.toISOString(),
    expiresAt: "2026-07-24T12:01:00.000Z",
    policyVersion: 1,
    completeness: "complete",
    freshness: "fresh",
    errors: [],
    reasonCodes: ["insufficient_liquidity"],
    destinationOptions: [destination()],
  };
}

function quote(): FundingQuoteSummary {
  return {
    quoteId: "quote_id_12345678",
    liquidityProjectionId: "projection_00000000-0000-4000-8000-000000000001",
    selectedSourceOptionId: "source_option_12345678",
    destinationOptionId: "destination_poly_12345678",
    venueBindingOptionId: "binding_poly_12345678",
    planKind: "wallet_route",
    experienceMode: "prepare_first",
    expectedDestination: { asset: ASSET, raw: "1000000" },
    minimumDestination: { asset: ASSET, raw: "990000" },
    fees: [],
    eta: { minSeconds: 5, maxSeconds: 20 },
    requiredActions: [],
    planHash: "a".repeat(64),
    consentToken: "consent_token_12345678",
    expiresAt: "2026-07-24T12:01:00.000Z",
    policyVersion: 1,
  };
}

function operation(): FundingOperationRow {
  return {
    id: "operation_id_12345678",
    userId: USER_ID,
    quoteId: "quote_id_12345678",
    purpose: "add_funds",
    status: "in_progress",
    progressStage: "committed",
    experienceMode: "prepare_first",
    planKind: "wallet_route",
    idempotencyKey: "idempotency_key_12345678",
    commitRequestHash: "b".repeat(64),
    planHash: "a".repeat(64),
    policyVersion: 1,
    policyRevision: "policy_revision_12345678",
    sourceSnapshot: null,
    destinationTargetSnapshot: {},
    marketId: null,
    requestedSourceAmount: null,
    requestedDestinationAmount: null,
    actualSourceAmount: null,
    actualDestinationAmount: null,
    errorCode: null,
    supportMetadata: {},
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: null,
  };
}

async function buildApp(overrides: Partial<FundingRouteDependencies> = {}) {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const dependencies: FundingRouteDependencies = {
    authenticate: async (request) => {
      request.user = {
        id: USER_ID,
        privyUserId: "did:privy:test",
      } as NonNullable<typeof request.user>;
    },
    rateLimit: async () => true,
    destinations: async () => [destination()],
    liquidity: async () => liquidity(),
    quote: async () => quote(),
    commit: async () => ({ operation: operation(), replayed: false }),
    operation: async () => operation(),
    operations: async () => [operation()],
    ...overrides,
  };
  registerFundingRoutes(app, dependencies);
  await app.ready();
  return app;
}

await test("funding routes derive ownership only from authenticated session", async () => {
  let observedUserId: string | null = null;
  const app = await buildApp({
    destinations: async (userId) => {
      observedUserId = userId;
      return [destination()];
    },
  });
  try {
    const response = await app.inject({
      method: "GET",
      url: "/funding/destinations?purpose=fund",
    });
    assert.equal(response.statusCode, 200);
    assert.equal(observedUserId, USER_ID);
    const body = response.json();
    assert.equal(
      body.options[0].destinationOptionId,
      destination().destinationOptionId,
    );
    assert.equal(
      JSON.stringify(body).includes(
        "0x00000000000000000000000000000000000000aa",
      ),
      false,
    );
  } finally {
    await app.close();
  }
});

await test("liquidity rejects provider and raw destination authority fields", async () => {
  let calls = 0;
  const app = await buildApp({
    liquidity: async () => {
      calls += 1;
      return liquidity();
    },
  });
  try {
    const response = await app.inject({
      method: "POST",
      url: "/funding/liquidity",
      payload: {
        purpose: "add_funds",
        requestedDestinationAmount: { asset: ASSET, raw: "1000000" },
        confirmedSourceAmount: null,
        marketContextId: null,
        destinationOptionId: "destination_poly_12345678",
        withdrawalRecipientId: null,
        venueBindingOptionId: null,
        maxFeeUsd: null,
        maxSlippageBps: null,
        deadline: null,
        providerId: "relay",
        destinationAddress: "0x00000000000000000000000000000000000000aa",
      },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(calls, 0);
  } finally {
    await app.close();
  }
});

await test("typed source-selection failures remain fail closed", async () => {
  const app = await buildApp({
    quote: async () => {
      throw new FundingPlannerError("source_not_selected", "source is absent");
    },
  });
  try {
    const response = await app.inject({
      method: "POST",
      url: "/funding/quotes",
      payload: {
        liquidityProjectionId:
          "projection_00000000-0000-4000-8000-000000000001",
        selectedSourceOptionId: "source_option_12345678",
        confirmedSourceAmount: null,
        requestedDestinationAmount: { asset: ASSET, raw: "1000000" },
      },
    });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().code, "source_not_selected");
  } finally {
    await app.close();
  }
});

await test("operation reads expose safe resumable state, not internal snapshots", async () => {
  const app = await buildApp();
  try {
    const response = await app.inject({
      method: "GET",
      url: "/funding/operations/operation_id_12345678",
    });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.operation.operationId, "operation_id_12345678");
    assert.equal("destinationTargetSnapshot" in body.operation, false);
    assert.equal("sourceSnapshot" in body.operation, false);
  } finally {
    await app.close();
  }
});

await test("financial endpoints fail closed when rate limiting is unavailable", async () => {
  const app = await buildApp({ rateLimit: async () => false });
  try {
    const response = await app.inject({
      method: "GET",
      url: "/funding/operations",
    });
    assert.equal(response.statusCode, 429);
    assert.equal(response.json().code, "rate_limit_exceeded");
  } finally {
    await app.close();
  }
});

console.log("[funding-routes-tests] complete");
