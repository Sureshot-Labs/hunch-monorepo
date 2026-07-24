#!/usr/bin/env tsx

import assert from "node:assert/strict";
import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";

import type { PositionActionReadiness } from "../../domain/contracts.js";
import type { NormalizedAction } from "../../domain/types.js";
import type { StoredPositionAction } from "../../position-actions/position-action-repository.js";
import { PreparationContractError } from "../../preparation/core-adapter.js";
import {
  registerPositionActionRoutes,
  type PositionActionRouteDependencies,
} from "../../../routes/position-actions.js";

const USER_ID = "10000000-0000-4000-8000-000000000001";
const POSITION_ID = "20000000-0000-4000-8000-000000000002";
const OPERATION_ID = "30000000-0000-4000-8000-000000000003";
const NOW = new Date("2026-07-24T12:00:00.000Z");
const BINDING_ID = "binding_position_owner_12345678";
const REVISION = "position_inspection_revision_12345678";
const TX_HASH = `0x${"ab".repeat(32)}`;

function readiness(): PositionActionReadiness {
  return {
    ready: false,
    action: "redeem",
    venueId: "polymarket",
    positionRef: POSITION_ID,
    ownerBindingId: BINDING_ID,
    inspectionRevision: REVISION,
    inspectedAt: NOW.toISOString(),
    expiresAt: "2026-07-24T12:01:00.000Z",
    requiredActions: [
      {
        kind: "evm_transaction",
        safeLabel: "Redeem resolved position",
        actor: "user",
        valueMoving: true,
        sponsorship: "none",
      },
    ],
    postconditions: [
      {
        kind: "canonical_redemption_plan",
        safeLabel: "Submit canonical redemption",
      },
    ],
    reasonCodes: ["position_action_required"],
    evidence: {
      facts: { planDigest: "a".repeat(64) },
      checks: [
        {
          checkId: "canonical_redemption_plan",
          status: "user_action_required",
          safeLabel: "Submit canonical redemption",
          reasonCode: "position_action_required",
        },
      ],
    },
  };
}

function action(): NormalizedAction {
  return {
    kind: "evm_transaction",
    actionId: "action_position_redeem_12345678",
    networkId: "evm:137",
    senderWalletId: "wallet_position_owner_12345678",
    to: "0x0000000000000000000000000000000000000011",
    data: "0x1234",
    valueRaw: "0",
    gasLimitRaw: null,
  };
}

function operation(
  overrides: Partial<StoredPositionAction> = {},
): StoredPositionAction {
  return {
    id: OPERATION_ID,
    userId: USER_ID,
    marketId: "market-position-owner-12345678",
    venueId: "polymarket",
    action: "redeem",
    positionRef: POSITION_ID,
    ownerBindingId: BINDING_ID,
    ownerAddress: "0x0000000000000000000000000000000000000022",
    executionWalletId: "wallet_position_owner_12345678",
    executionAddress: "0x0000000000000000000000000000000000000033",
    executionMode: "web_client",
    inspectionRevision: REVISION,
    actionDigest: `position_action_${"a".repeat(64)}`,
    idempotencyKey: "position_action_idempotency_12345678",
    status: "awaiting_user",
    planSnapshot: {},
    evidenceSnapshot: {},
    normalizedActions: [action()],
    postconditions: [],
    submissionFingerprint: null,
    broadcastMayHaveOccurred: false,
    receiptStatus: "unobserved",
    receiptObservedAt: null,
    postconditionStatus: "pending",
    lastErrorCode: null,
    submittedAt: null,
    completedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

async function buildApp(
  overrides: Partial<PositionActionRouteDependencies> = {},
) {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const dependencies: PositionActionRouteDependencies = {
    authenticate: async (request) => {
      request.user = {
        id: USER_ID,
        privyUserId: "did:privy:test",
      } as NonNullable<typeof request.user>;
    },
    rateLimit: async () => true,
    inspect: async () => readiness(),
    prepare: async () => ({
      actions: [action()],
      operation: operation(),
      replayed: false,
    }),
    operation: async () => operation(),
    claim: async () => ({
      claimed: true,
      operation: operation({ status: "submitting" }),
      attemptNumber: 1,
      reason: "claimed",
    }),
    report: async () =>
      operation({
        status: "submitted",
        submissionFingerprint: TX_HASH,
        broadcastMayHaveOccurred: true,
        receiptStatus: "pending",
      }),
    reconcile: async () => ({
      status: "in_progress",
      submissionFingerprint: TX_HASH,
      reasonCodes: [],
    }),
    ...overrides,
  };
  registerPositionActionRoutes(app, dependencies);
  await app.ready();
  return app;
}

async function test(name: string, run: () => Promise<void>) {
  await run();
  console.log(`[position-action-routes-tests] ok ${name}`);
}

await test("inspection derives account ownership from the session", async () => {
  let observedUserId: string | null = null;
  const app = await buildApp({
    inspect: async (userId) => {
      observedUserId = userId;
      return readiness();
    },
  });
  try {
    const response = await app.inject({
      method: "POST",
      url: "/position-actions/inspect",
      payload: {
        action: "redeem",
        venueId: "polymarket",
        positionRef: POSITION_ID,
        ownerBindingId: BINDING_ID,
      },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(observedUserId, USER_ID);
    assert.equal(response.json().readiness.positionRef, POSITION_ID);
  } finally {
    await app.close();
  }
});

await test("raw wallet, target, and calldata authority fields are rejected", async () => {
  let calls = 0;
  const app = await buildApp({
    inspect: async () => {
      calls += 1;
      return readiness();
    },
  });
  try {
    const response = await app.inject({
      method: "POST",
      url: "/position-actions/inspect",
      payload: {
        action: "redeem",
        venueId: "polymarket",
        positionRef: POSITION_ID,
        ownerBindingId: BINDING_ID,
        walletAddress: "0x0000000000000000000000000000000000000099",
        target: "0x0000000000000000000000000000000000000088",
        calldata: "0xdeadbeef",
      },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(calls, 0);
  } finally {
    await app.close();
  }
});

await test("stale preparation fails before a durable action is returned", async () => {
  const app = await buildApp({
    prepare: async () => {
      throw new PreparationContractError("evidence_stale", "stale");
    },
  });
  try {
    const response = await app.inject({
      method: "POST",
      url: "/position-actions/prepare",
      payload: {
        action: "redeem",
        venueId: "polymarket",
        positionRef: POSITION_ID,
        ownerBindingId: BINDING_ID,
        expectedInspectionRevision: REVISION,
        idempotencyKey: "position_action_idempotency_12345678",
      },
    });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().code, "evidence_stale");
  } finally {
    await app.close();
  }
});

await test("claim and report expose no persisted plan or owner address", async () => {
  const app = await buildApp();
  try {
    const claimed = await app.inject({
      method: "POST",
      url: `/position-actions/${OPERATION_ID}/submission/claim`,
    });
    assert.equal(claimed.statusCode, 200);
    assert.equal(claimed.json().attemptNumber, 1);
    assert.equal("planSnapshot" in claimed.json().operation, false);
    assert.equal("ownerAddress" in claimed.json().operation, false);

    const reported = await app.inject({
      method: "POST",
      url: `/position-actions/${OPERATION_ID}/submission/report`,
      payload: {
        attemptNumber: 1,
        outcome: "submitted",
        submissionFingerprint: TX_HASH,
        errorCode: null,
      },
    });
    assert.equal(reported.statusCode, 200);
    assert.equal(reported.json().operation.submissionFingerprint, TX_HASH);
  } finally {
    await app.close();
  }
});

await test("position action endpoints fail closed on rate-limit uncertainty", async () => {
  const app = await buildApp({ rateLimit: async () => false });
  try {
    const response = await app.inject({
      method: "GET",
      url: `/position-actions/${OPERATION_ID}`,
    });
    assert.equal(response.statusCode, 429);
    assert.equal(response.json().code, "rate_limit_exceeded");
  } finally {
    await app.close();
  }
});

console.log("[position-action-routes-tests] complete");
