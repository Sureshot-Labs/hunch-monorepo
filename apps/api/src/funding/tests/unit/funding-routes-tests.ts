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
  FundingReceiveSession,
  IntentLiquidityProjection,
  NormalizedAction,
} from "../../domain/types.js";
import type { PreparationResult } from "../../domain/contracts.js";
import type { FundingOperationStep } from "../../persistence/funding-evidence-repository.js";
import type { FundingOperationRow } from "../../persistence/funding-operation-repository.js";
import { WithdrawalDestinationError } from "../../execution/withdrawal-destination-runtime.js";
import { FundingPlannerError } from "../../planner/money.js";
import { PreparationContractError } from "../../preparation/core-adapter.js";
import {
  fundingRequestsPerMinute,
  registerFundingRoutes,
  type FundingRouteDependencies,
} from "../../../routes/funding.js";
import { fundingValidationErrorResponseSchema } from "../../../schemas/funding.js";

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
    venueBindingId: "binding_account_poly_12345678",
    venueBindingOptionId: "binding_poly_12345678",
    controllerWalletId: "wallet_poly_12345678",
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

function preparation(): PreparationResult {
  return {
    status: "ready",
    binding: {
      bindingId: "binding_poly_runtime_12345678",
      venueId: "polymarket",
      controllerWalletId: "wallet_poly_runtime_12345678",
      executionWalletId: "wallet_poly_runtime_12345678",
      accountRef: "0x0000000000000000000000000000000000000002",
      settlementLocation: {
        kind: "venue_account",
        locationId: "location_poly_runtime_12345678",
        accountId: USER_ID,
        asset: ASSET,
        details: {
          venueId: "polymarket",
          address: "0x0000000000000000000000000000000000000002",
        },
      },
      signingMode: "privy_authorization",
    },
    safeLabel: "Polymarket · Hunch Trading Wallet",
    purpose: "fund",
    marketClass: null,
    readinessClass: "internal_managed",
    executionMode: "venue_relayer",
    topology: "deposit_wallet",
    inspectionRevision: "inspection_poly_runtime_12345678",
    inspectedAt: NOW.toISOString(),
    expiresAt: "2026-07-24T12:01:00.000Z",
    requiredActions: [],
    postconditions: [],
    reasonCodes: [],
    evidence: { facts: {}, checks: [] },
  };
}

function preparedActions(): readonly NormalizedAction[] {
  return [
    {
      kind: "evm_transaction",
      actionId: "action_funding_route_12345678",
      networkId: "evm:137",
      senderWalletId: "wallet_poly_runtime_12345678",
      to: "0x0000000000000000000000000000000000000003",
      data: "0x",
      valueRaw: "0",
      gasLimitRaw: "21000",
    },
  ];
}

function preparedAction(): NormalizedAction {
  const action = preparedActions()[0];
  if (!action) throw new Error("prepared action fixture is missing");
  return action;
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
    consentMode: "explicit_economic_review",
    sourceAmounts: [
      {
        safeLabel: "Polygon wallet",
        amount: { asset: ASSET, raw: "1000000" },
      },
    ],
    expectedDestination: { asset: ASSET, raw: "1000000" },
    minimumDestination: { asset: ASSET, raw: "990000" },
    fees: [],
    eta: { minSeconds: 5, maxSeconds: 20 },
    requiredActions: [],
    ingress: null,
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
    externalRecipientId: null,
    venueId: null,
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

function operationSteps(): readonly FundingOperationStep[] {
  return [
    {
      id: "step_id_12345678",
      operationId: "operation_id_12345678",
      segmentId: null,
      ordinal: 0,
      stepKind: "transaction",
      state: "action_required",
      actionFingerprint: "c".repeat(64),
      executorId: "wallet_profile_evm_v1",
      payerRequirement: "user",
      dependsOnStepId: null,
      dependencyState: null,
      normalizedAction: preparedAction(),
      actionValidationResult: {},
    },
  ];
}

function receiveSession(): FundingReceiveSession {
  const receiveTarget = {
    receiveTargetId: "receive_target_12345678",
    networkId: "evm:137",
    destinationAddress: "0x0000000000000000000000000000000000000002",
    acceptedAssets: [{ asset: ASSET, handling: "direct" as const }],
    safeInstructions: ["Send only the displayed asset on Polygon."],
  };
  const receiveIngress = (ingressKind: "manual" | "privy") => ({
    ingressKind,
    sourceNetworkId: ingressKind === "privy" ? ASSET.networkId : null,
    sourceAsset: ingressKind === "privy" ? ASSET : null,
    receiveTargets: [receiveTarget],
    recommendedReceiveTargetId: receiveTarget.receiveTargetId,
    destinationOptionId: destination().destinationOptionId,
    destinationAddress: receiveTarget.destinationAddress,
    requestedAmount: null,
    amountSemantics: "minimum" as const,
    expiresAt: new Date(NOW.getTime() + 86_400_000).toISOString(),
    safeInstructions: ["Send only the displayed asset on Polygon."],
  });
  return {
    receiveSessionId: "20000000-0000-4000-8000-000000000001",
    status: "open",
    venueId: "polymarket",
    destinationOptionId: destination().destinationOptionId,
    venueBindingOptionId: destination().venueBindingOptionId,
    destinationAsset: ASSET,
    methods: [
      {
        methodId: "receive_method_manual_12345678",
        kind: "manual",
        safeLabel: "Send crypto",
        ingress: receiveIngress("manual"),
      },
      {
        methodId: "receive_method_privy_12345678",
        kind: "privy",
        safeLabel: "Fund with Privy",
        ingress: receiveIngress("privy"),
      },
    ],
    receiveTargets: [receiveTarget],
    selectedReceiveTargetId: "receive_target_12345678",
    automationPolicy: {
      stableConversion: "automatic_within_caps",
      volatileConversion: "review_required",
      maximumFeeUsd: "1",
      maximumFeeBps: 500,
      maximumSlippageBps: 100,
    },
    version: 1,
    openedAt: NOW.toISOString(),
    lastObservedAt: null,
    expiresAt: new Date(NOW.getTime() + 86_400_000).toISOString(),
    observeUntil: new Date(NOW.getTime() + 8 * 86_400_000).toISOString(),
    closedAt: null,
  };
}

function receiveReceipt() {
  return {
    receiptId: "00000000-0000-4000-8000-000000000051",
    receiveSessionId: receiveSession().receiveSessionId,
    variantId: "ingress_variant_review_12345678",
    asset: {
      networkId: "solana:mainnet",
      assetId: "11111111111111111111111111111111",
      decimals: 9,
    },
    destinationAddress: "9xQeWvG816bUx9EPfB1G6QxgXLKWMuD5YpLQwJwN6JY",
    rawAmount: "10000000",
    observationRevision: "solana_transfer_review_12345678",
    observedAt: NOW.toISOString(),
    status: "review_required" as const,
    handling: "review_required" as const,
    childFundingOperationId: null,
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
    capabilities: async () => ({
      fundingApiVersion: 1,
      receiveSessionsVersion: 1,
      creationMode: "on",
      supportedActionKinds: [
        "add_funds",
        "trade_shortfall",
        "convert_asset",
        "withdrawal",
        "redeem",
      ],
    }),
    registerWithdrawalDestination: async () => ({
      recipientId: "recipient_withdrawal_12345678",
      networkId: "evm:137",
      asset: ASSET,
      safeAddress: "0x000000…000001",
      addressFingerprint: "f".repeat(64),
      validatedAt: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
      validationPolicyVersion: 1,
      replayed: false,
    }),
    revokeWithdrawalDestination: async (_, recipientId) => ({
      recipientId,
      revoked: true,
      revokedAt: NOW.toISOString(),
    }),
    destinations: async () => [destination()],
    inspectPreparation: async () => preparation(),
    prepare: async () => ({
      actions: preparedActions(),
      controllerWalletRef: USER_ID,
    }),
    liquidity: async () => liquidity(),
    quote: async () => quote(),
    commit: async () => ({ operation: operation(), replayed: false }),
    operation: async () => operation(),
    operationSteps: async () => operationSteps(),
    consumerReservation: async () => null,
    operations: async () => [operation()],
    cancelOperation: async () => ({
      ...operation(),
      status: "cancelled",
      progressStage: "terminal",
      completedAt: NOW,
    }),
    prepareOperationAction: async () => ({
      attemptId: "attempt_id_12345678",
      action: preparedAction(),
      actionFingerprint: "c".repeat(64),
      controllerWalletRef: USER_ID,
      executorId: "wallet_profile_evm_v1",
      executionMode: "web_client",
      payerRequirement: "user",
      sponsorshipPolicyId: null,
    }),
    reportOperationAction: async () => ({
      accepted: true,
      stepState: "submitted",
    }),
    openReceiveSession: async () => ({
      session: receiveSession(),
      receipts: [],
      replayed: false,
    }),
    receiveSession: async () => ({
      session: receiveSession(),
      receipts: [],
      replayed: true,
    }),
    cancelReceiveSession: async () => ({
      session: {
        ...receiveSession(),
        status: "cancelled",
        closedAt: NOW.toISOString(),
      },
      receipts: [],
      replayed: false,
    }),
    reviewReceiveReceipt: async () => ({
      receipt: receiveReceipt(),
      quote: {
        ...quote(),
        consentMode: "explicit_economic_review",
      },
    }),
    commitReceiveReceiptReview: async () => ({
      operation: operation(),
      replayed: false,
    }),
    ...overrides,
  };
  registerFundingRoutes(app, dependencies);
  await app.ready();
  return app;
}

await test("funding capabilities publish the rollout contract", async () => {
  const app = await buildApp();
  try {
    const response = await app.inject({
      method: "GET",
      url: "/funding/capabilities",
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      ok: true,
      fundingApiVersion: 1,
      receiveSessionsVersion: 1,
      creationMode: "on",
      supportedActionKinds: [
        "add_funds",
        "trade_shortfall",
        "convert_asset",
        "withdrawal",
        "redeem",
      ],
    });
  } finally {
    await app.close();
  }
});

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

await test("receive session opens without a requested amount", async () => {
  let observedUserId: string | null = null;
  let observedBody: unknown = null;
  const app = await buildApp({
    openReceiveSession: async (userId, request) => {
      observedUserId = userId;
      observedBody = request;
      return {
        session: receiveSession(),
        receipts: [],
        replayed: false,
      };
    },
  });
  try {
    const response = await app.inject({
      method: "POST",
      url: "/funding/receive-sessions",
      payload: {
        destinationOptionId: destination().destinationOptionId,
        venueBindingOptionId: destination().venueBindingOptionId,
        selectedReceiveTargetId: null,
      },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(observedUserId, USER_ID);
    assert.deepEqual(observedBody, {
      destinationOptionId: destination().destinationOptionId,
      venueBindingOptionId: destination().venueBindingOptionId,
      selectedReceiveTargetId: null,
    });
    assert.equal(
      response.json().session.receiveSessionId,
      receiveSession().receiveSessionId,
    );
    assert.deepEqual(response.json().session.methods, receiveSession().methods);
    assert.equal("amount" in (observedBody as object), false);
  } finally {
    await app.close();
  }
});

await test("receive session reads only through the authenticated owner", async () => {
  let observedUserId: string | null = null;
  const app = await buildApp({
    receiveSession: async (userId) => {
      observedUserId = userId;
      return {
        session: receiveSession(),
        receipts: [],
        replayed: true,
      };
    },
  });
  try {
    const response = await app.inject({
      method: "GET",
      url: `/funding/receive-sessions/${receiveSession().receiveSessionId}`,
    });
    assert.equal(response.statusCode, 200);
    assert.equal(observedUserId, USER_ID);
  } finally {
    await app.close();
  }
});

await test("volatile receive receipt review uses the authenticated receipt identity", async () => {
  let observed: Readonly<{
    userId: string;
    sessionId: string;
    receiptId: string;
  }> | null = null;
  const app = await buildApp({
    reviewReceiveReceipt: async (userId, sessionId, receiptId) => {
      observed = { userId, sessionId, receiptId };
      return {
        receipt: receiveReceipt(),
        quote: quote(),
      };
    },
  });
  try {
    const response = await app.inject({
      method: "POST",
      url: `/funding/receive-sessions/${receiveSession().receiveSessionId}/receipts/${receiveReceipt().receiptId}/quote`,
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(observed, {
      userId: USER_ID,
      sessionId: receiveSession().receiveSessionId,
      receiptId: receiveReceipt().receiptId,
    });
    assert.equal(response.json().quote.consentMode, "explicit_economic_review");
    assert.equal(response.json().receipt.handling, "review_required");
  } finally {
    await app.close();
  }
});

await test("volatile receive receipt commit remains on the standard operation contract", async () => {
  let observedRequest: unknown = null;
  const app = await buildApp({
    commitReceiveReceiptReview: async (
      userId,
      receiveSessionId,
      receiptId,
      request,
    ) => {
      observedRequest = { userId, receiveSessionId, receiptId, request };
      return { operation: operation(), replayed: false };
    },
  });
  try {
    const request = {
      quoteId: quote().quoteId,
      consentToken: quote().consentToken,
      idempotencyKey: "receive_review_commit_12345678",
    };
    const response = await app.inject({
      method: "POST",
      url: `/funding/receive-sessions/${receiveSession().receiveSessionId}/receipts/${receiveReceipt().receiptId}/commit`,
      payload: request,
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(observedRequest, {
      userId: USER_ID,
      receiveSessionId: receiveSession().receiveSessionId,
      receiptId: receiveReceipt().receiptId,
      request,
    });
    assert.equal(response.json().operation.operationId, operation().id);
  } finally {
    await app.close();
  }
});

await test("destinations accept short backend market references", async () => {
  let observedQuery:
    | Parameters<FundingRouteDependencies["destinations"]>[1]
    | undefined;
  const app = await buildApp({
    destinations: async (_userId, query) => {
      observedQuery = query;
      return [destination()];
    },
  });
  try {
    const response = await app.inject({
      method: "GET",
      url:
        "/funding/destinations?purpose=buy&marketContextId=561251" +
        "&controllerWalletRef=8571f3cb-381e-4e55-8f4c-ecc4c7f2abb9",
    });
    assert.equal(response.statusCode, 200);
    assert.equal(observedQuery?.marketContextId, "561251");
    assert.equal(
      observedQuery?.controllerWalletRef,
      "8571f3cb-381e-4e55-8f4c-ecc4c7f2abb9",
    );
  } finally {
    await app.close();
  }
});

await test("sell destination discovery forwards the owner-scoped position reference", async () => {
  const positionActionRef = "20000000-0000-4000-8000-000000000001";
  let observedQuery:
    | Parameters<FundingRouteDependencies["destinations"]>[1]
    | undefined;
  const app = await buildApp({
    destinations: async (_userId, query) => {
      observedQuery = query;
      return [destination()];
    },
  });
  try {
    const response = await app.inject({
      method: "GET",
      url:
        "/funding/destinations?purpose=sell&marketContextId=561251" +
        `&positionActionRef=${positionActionRef}`,
    });
    assert.equal(response.statusCode, 200);
    assert.equal(observedQuery?.purpose, "sell");
    assert.equal(observedQuery?.positionActionRef, positionActionRef);
  } finally {
    await app.close();
  }
});

await test("sanitized funding validation errors remain serializable", () => {
  assert.doesNotThrow(() =>
    fundingValidationErrorResponseSchema.parse({
      statusCode: 400,
      code: "FST_ERR_VALIDATION",
      error: "Bad Request",
    }),
  );
  assert.doesNotThrow(() =>
    fundingValidationErrorResponseSchema.parse({
      error: "Invalid request",
    }),
  );
});

await test("standard auth errors remain serializable", async () => {
  const app = await buildApp({
    authenticate: async (_request, reply) =>
      reply
        .code(401)
        .send({ error: "Missing or invalid authorization header" }),
  });
  try {
    const response = await app.inject({
      method: "GET",
      url: "/funding/operations?limit=25",
    });
    assert.equal(response.statusCode, 401);
    assert.deepEqual(response.json(), {
      error: "Missing or invalid authorization header",
    });
  } finally {
    await app.close();
  }
});

await test("withdrawal registration is owner-scoped and never echoes the raw address", async () => {
  const rawAddress = "0x0000000000000000000000000000000000000001";
  let observed:
    | Readonly<{
        userId: string;
        request: Readonly<{
          asset: typeof ASSET;
          address: string;
        }>;
      }>
    | undefined;
  const app = await buildApp({
    registerWithdrawalDestination: async (userId, request) => {
      observed = {
        userId,
        request: {
          asset: request.asset as typeof ASSET,
          address: request.address,
        },
      };
      return {
        recipientId: "recipient_withdrawal_12345678",
        networkId: request.asset.networkId,
        asset: request.asset,
        safeAddress: "0x000000…000001",
        addressFingerprint: "f".repeat(64),
        validatedAt: NOW.toISOString(),
        expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
        validationPolicyVersion: 1,
        replayed: false,
      };
    },
  });
  try {
    const response = await app.inject({
      method: "POST",
      url: "/funding/withdrawal-destinations",
      payload: { asset: ASSET, address: rawAddress },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(observed?.userId, USER_ID);
    assert.deepEqual(observed?.request, {
      asset: ASSET,
      address: rawAddress,
    });
    const body = response.json();
    assert.equal(body.recipientId, "recipient_withdrawal_12345678");
    assert.equal(body.safeAddress, "0x000000…000001");
    assert.equal(Object.hasOwn(body, "address"), false);
    assert.notEqual(body.safeAddress, rawAddress);
  } finally {
    await app.close();
  }
});

await test("withdrawal registration rejects client authority fields", async () => {
  let called = false;
  const app = await buildApp({
    registerWithdrawalDestination: async () => {
      called = true;
      throw new Error("unreachable");
    },
  });
  try {
    const response = await app.inject({
      method: "POST",
      url: "/funding/withdrawal-destinations",
      payload: {
        asset: ASSET,
        address: "0x0000000000000000000000000000000000000001",
        userId: "attacker-selected-owner",
        validated: true,
      },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(called, false);
  } finally {
    await app.close();
  }
});

await test("withdrawal revocation is owner-scoped and typed failures stay fail closed", async () => {
  let observed: Readonly<{ userId: string; recipientId: string }> | undefined;
  const app = await buildApp({
    revokeWithdrawalDestination: async (userId, recipientId) => {
      observed = { userId, recipientId };
      throw new WithdrawalDestinationError(
        "withdrawal_destination_not_found",
        "not owned",
      );
    },
  });
  try {
    const recipientId = "recipient_withdrawal_12345678";
    const response = await app.inject({
      method: "DELETE",
      url: `/funding/withdrawal-destinations/${recipientId}`,
    });
    assert.equal(response.statusCode, 404);
    assert.deepEqual(observed, { userId: USER_ID, recipientId });
    assert.equal(response.json().code, "withdrawal_destination_not_found");
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

await test("trade shortfall liquidity forwards the selected controller wallet", async () => {
  const controllerWalletRef = "20000000-0000-4000-8000-000000000002";
  let observedControllerWalletRef: string | null | undefined;
  const app = await buildApp({
    liquidity: async (_userId, request) => {
      observedControllerWalletRef = request.controllerWalletRef;
      return liquidity();
    },
  });
  try {
    const response = await app.inject({
      method: "POST",
      url: "/funding/liquidity",
      payload: {
        purpose: "trade_shortfall",
        requestedDestinationAmount: { asset: ASSET, raw: "1000000" },
        confirmedSourceAmount: null,
        marketContextId: "polymarket:token-yes",
        destinationOptionId: "destination_poly_12345678",
        withdrawalRecipientId: null,
        venueBindingOptionId: "binding_poly_12345678",
        controllerWalletRef,
        maxFeeUsd: null,
        maxSlippageBps: null,
        deadline: null,
      },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(observedControllerWalletRef, controllerWalletRef);
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

await test("preparation inspection is account-bound and returns sanitized evidence", async () => {
  let observedUserId: string | null = null;
  let observedPositionActionRef: string | null | undefined;
  let observedControllerWalletRef: string | null | undefined;
  const positionActionRef = "20000000-0000-4000-8000-000000000001";
  const controllerWalletRef = "20000000-0000-4000-8000-000000000002";
  const app = await buildApp({
    inspectPreparation: async (userId, request) => {
      observedUserId = userId;
      observedPositionActionRef = request.positionActionRef;
      observedControllerWalletRef = request.controllerWalletRef;
      return preparation();
    },
  });
  try {
    const response = await app.inject({
      method: "POST",
      url: "/funding/preparation/inspect",
      payload: {
        venueBindingOptionId: "binding_poly_12345678",
        purpose: "fund",
        marketContextId: null,
        marketClass: null,
        positionActionRef,
        controllerWalletRef,
      },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(observedUserId, USER_ID);
    assert.equal(observedPositionActionRef, positionActionRef);
    assert.equal(observedControllerWalletRef, controllerWalletRef);
    assert.equal(
      response.json().preparation.inspectionRevision,
      "inspection_poly_runtime_12345678",
    );
  } finally {
    await app.close();
  }
});

await test("preparation rejects stale revisions before action construction", async () => {
  let observedPositionActionRef: string | null | undefined;
  let observedControllerWalletRef: string | null | undefined;
  const positionActionRef = "20000000-0000-4000-8000-000000000001";
  const controllerWalletRef = "20000000-0000-4000-8000-000000000002";
  const app = await buildApp({
    prepare: async (_userId, request) => {
      observedPositionActionRef = request.positionActionRef;
      observedControllerWalletRef = request.controllerWalletRef;
      throw new PreparationContractError(
        "evidence_stale",
        "inspection changed",
      );
    },
  });
  try {
    const response = await app.inject({
      method: "POST",
      url: "/funding/preparation/prepare",
      payload: {
        venueBindingOptionId: "binding_poly_12345678",
        purpose: "fund",
        marketContextId: null,
        marketClass: null,
        positionActionRef,
        controllerWalletRef,
        operationId: "operation_prepare_12345678",
        expectedInspectionRevision: "inspection_poly_runtime_12345678",
      },
    });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().code, "evidence_stale");
    assert.equal(observedPositionActionRef, positionActionRef);
    assert.equal(observedControllerWalletRef, controllerWalletRef);
  } finally {
    await app.close();
  }
});

await test("operation reads expose safe resumable state, not internal snapshots", async () => {
  let reservationScope:
    | Readonly<{ userId: string; operationId: string }>
    | undefined;
  const app = await buildApp({
    operation: async () => ({
      ...operation(),
      purpose: "trade_shortfall",
      status: "ready",
      progressStage: "ready_for_consumer",
      sourceSnapshot: {
        ingress: {
          ingressKind: "manual",
          sourceNetworkId: ASSET.networkId,
          sourceAsset: ASSET,
          destinationOptionId: "destination_poly_12345678",
          destinationAddress: "0x0000000000000000000000000000000000000004",
          requestedAmount: { asset: ASSET, raw: "1000000" },
          amountSemantics: "minimum",
          expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
          safeInstructions: [
            "Send only the exact asset to the exact destination.",
          ],
        },
      },
    }),
    consumerReservation: async (userId, operationId) => {
      reservationScope = { userId, operationId };
      return {
        operationId,
        reservationId: "reservation_id_12345678",
        rawAmount: "1000000",
        asset: ASSET,
        expiresAt: new Date(NOW.getTime() + 60_000),
      };
    },
  });
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
    assert.deepEqual(body.steps, [
      {
        stepId: "step_id_12345678",
        ordinal: 0,
        kind: "transaction",
        state: "action_required",
        dependsOnStepId: null,
        dependencyState: null,
        actionable: true,
      },
    ]);
    assert.equal("normalizedAction" in body.steps[0], false);
    assert.deepEqual(body.ingress, {
      ingressKind: "manual",
      sourceNetworkId: ASSET.networkId,
      sourceAsset: ASSET,
      destinationOptionId: "destination_poly_12345678",
      destinationAddress: "0x0000000000000000000000000000000000000004",
      requestedAmount: { asset: ASSET, raw: "1000000" },
      amountSemantics: "minimum",
      expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
      safeInstructions: ["Send only the exact asset to the exact destination."],
    });
    assert.deepEqual(reservationScope, {
      userId: USER_ID,
      operationId: "operation_id_12345678",
    });
    assert.deepEqual(body.consumerReservation, {
      operationId: "operation_id_12345678",
      reservationId: "reservation_id_12345678",
      rawAmount: "1000000",
      asset: ASSET,
      expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
    });
  } finally {
    await app.close();
  }
});

await test("operation reads hide dormant ingress completion until funds select it", async () => {
  const dormantCompletionStep: FundingOperationStep = {
    ...operationSteps()[0],
    id: "step_dormant_completion_12345678",
    ordinal: 1,
    state: "planned",
    actionValidationResult: {
      activation: "after_verified_ingress",
    },
  };
  const app = await buildApp({
    operationSteps: async () => [...operationSteps(), dormantCompletionStep],
  });
  try {
    const response = await app.inject({
      method: "GET",
      url: "/funding/operations/operation_id_12345678",
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(
      response.json().steps.map((step: { stepId: string }) => step.stepId),
      ["step_id_12345678"],
    );
  } finally {
    await app.close();
  }
});

await test("operation action prepare is owner-scoped and returns only the committed action", async () => {
  let observed:
    | Readonly<{ userId: string; operationId: string; stepId: string }>
    | undefined;
  const app = await buildApp({
    prepareOperationAction: async (userId, input) => {
      observed = { userId, ...input };
      return {
        attemptId: "attempt_id_12345678",
        action: preparedAction(),
        actionFingerprint: "c".repeat(64),
        controllerWalletRef: USER_ID,
        executorId: "wallet_profile_evm_v1",
        executionMode: "privy_authorization",
        payerRequirement: "privy_sponsor",
        sponsorshipPolicyId: "privy_user_authorized_evm_sponsorship_v1",
      };
    },
  });
  try {
    const response = await app.inject({
      method: "POST",
      url: "/funding/operations/operation_id_12345678/actions/step_id_12345678/prepare",
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(observed, {
      userId: USER_ID,
      operationId: "operation_id_12345678",
      stepId: "step_id_12345678",
    });
    assert.equal(response.json().action.kind, "evm_transaction");
    assert.equal(response.json().controllerWalletRef, USER_ID);
    assert.equal("providerQuoteRef" in response.json(), false);
  } finally {
    await app.close();
  }
});

await test("operation action reports accept transaction references but no replacement action", async () => {
  const observed: Array<
    Readonly<{
      userId: string;
      operationId: string;
      stepId: string;
      attemptId: string;
      outcome: string;
      transactionReference: string | null;
    }>
  > = [];
  const app = await buildApp({
    reportOperationAction: async (userId, input) => {
      observed.push({ userId, ...input });
      return { accepted: true, stepState: "submitted" };
    },
  });
  try {
    const rejected = await app.inject({
      method: "POST",
      url: "/funding/operations/operation_id_12345678/actions/step_id_12345678/report",
      payload: {
        attemptId: "attempt_id_12345678",
        outcome: "submitted",
        transactionReference: null,
        actualCosts: { networkFeeRaw: null },
        replacementAction: preparedActions()[0],
      },
    });
    assert.equal(rejected.statusCode, 400);
    assert.equal(observed.length, 0);

    const accepted = await app.inject({
      method: "POST",
      url: "/funding/operations/operation_id_12345678/actions/step_id_12345678/report",
      payload: {
        attemptId: "attempt_id_12345678",
        outcome: "submitted",
        transactionReference: `0x${"d".repeat(64)}`,
        actualCosts: { networkFeeRaw: "21000" },
      },
    });
    assert.equal(accepted.statusCode, 200);
    assert.equal(observed[0]?.userId, USER_ID);
    assert.equal(observed[0]?.operationId, "operation_id_12345678");
    assert.equal(observed[0]?.stepId, "step_id_12345678");
    assert.equal(observed[0]?.attemptId, "attempt_id_12345678");
    assert.equal(observed[0]?.outcome, "submitted");
  } finally {
    await app.close();
  }
});

await test("operation cancellation is owner-scoped and returns the terminal result", async () => {
  let observed: Readonly<{ userId: string; operationId: string }> | undefined;
  const app = await buildApp({
    cancelOperation: async (userId, operationId) => {
      observed = { userId, operationId };
      return {
        ...operation(),
        status: "completed",
        progressStage: "terminal",
        completedAt: NOW,
      };
    },
  });
  try {
    const response = await app.inject({
      method: "POST",
      url: "/funding/operations/operation_id_12345678/cancel",
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(observed, {
      userId: USER_ID,
      operationId: "operation_id_12345678",
    });
    assert.equal(response.json().operation.status, "completed");
    assert.equal(response.json().operation.progressStage, "terminal");
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

await test("active funding reads have a polling-safe rate limit", () => {
  assert.equal(fundingRequestsPerMinute("operation"), 180);
  assert.equal(fundingRequestsPerMinute("receive-session-read"), 180);
  assert.equal(fundingRequestsPerMinute("quote"), 30);
});

console.log("[funding-routes-tests] complete");
