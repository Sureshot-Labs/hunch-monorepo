#!/usr/bin/env tsx

/**
 * @requires-db
 */

import assert from "node:assert/strict";
import crypto from "node:crypto";

import { pool } from "../../../db.js";
import type {
  FundingDiscoveryRequest,
  IntentLiquidityProjection,
} from "../../domain/types.js";
import {
  PostgresFundingPlanningStore,
  deleteExpiredFundingPlanningSnapshots,
} from "../../persistence/funding-planning-repository.js";
import {
  commitFundingOperation,
  createFundingQuote,
  type FundingCommitPlan,
} from "../../persistence/funding-operation-repository.js";
import {
  fetchFundingRouteExperience,
  fundingRouteExperienceFingerprint,
} from "../../persistence/route-experience-repository.js";

const ASSET = {
  networkId: "evm:137",
  assetId: "0x0000000000000000000000000000000000000001",
  decimals: 6,
};

async function insertUser(): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `
      insert into users (email, is_active, is_verified)
      values ($1, true, true)
      returning id
    `,
    [`funding-planning-${crypto.randomUUID()}@example.com`],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error("test user insert returned no row");
  return id;
}

function request(): FundingDiscoveryRequest {
  return {
    purpose: "add_funds",
    requestedDestinationAmount: { asset: ASSET, raw: "1000000" },
    confirmedSourceAmount: null,
    marketContextId: null,
    destinationOptionId: null,
    withdrawalRecipientId: null,
    venueBindingOptionId: null,
    maxFeeUsd: null,
    maxSlippageBps: null,
    deadline: null,
  };
}

function projection(id: string, now: Date): IntentLiquidityProjection {
  return {
    liquidityProjectionId: id,
    marketContextId: null,
    venueId: null,
    venueBindingOptionId: null,
    destinationOptionId: null,
    collateralAsset: ASSET,
    requestedCollateralRaw: "1000000",
    availableNowRaw: "0",
    shortfallRaw: "1000000",
    convertibleRaw: "0",
    requestedUsd: "1",
    availableNowUsd: "0",
    shortfallUsd: "1",
    convertibleUsd: "0",
    mode: "unavailable",
    eta: null,
    requiredActions: [],
    sourceOptions: [],
    asOf: now.toISOString(),
    expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    policyVersion: 1,
    completeness: "partial",
    freshness: "stale",
    errors: [],
    reasonCodes: ["destination_selection_required"],
    destinationOptions: [],
  };
}

const userId = await insertUser();
const otherUserId = await insertUser();
const store = new PostgresFundingPlanningStore(pool);
const now = new Date();
const projectionId = `projection_${crypto.randomUUID()}`;
const publicProjection = projection(projectionId, now);
let routeOperationId: string | null = null;
let routeQuoteId: string | null = null;

try {
  const stored = await store.create({
    userId,
    request: request(),
    projection: publicProjection,
    plannerSnapshot: {
      request: request(),
      marketContext: null,
      destination: null,
      withdrawalRecipient: null,
      placement: null,
      sources: [],
      projection: publicProjection,
      policyRevision: "policy_revision_12345678",
      ownershipRevision: "ownership_revision_12345678",
    },
    policyVersion: 1,
    policyRevision: "policy_revision_12345678",
    ownershipRevision: "ownership_revision_12345678",
    expiresAt: new Date(publicProjection.expiresAt),
  });
  assert.equal(stored.id, projectionId);
  assert.equal(stored.projection.liquidityProjectionId, projectionId);

  const owned = await store.fetchOwnedCurrent({
    userId,
    projectionId,
    now,
  });
  assert.equal(owned?.id, projectionId);

  const crossUser = await store.fetchOwnedCurrent({
    userId: otherUserId,
    projectionId,
    now,
  });
  assert.equal(crossUser, null);

  await assert.rejects(
    () =>
      pool.query(
        `
          update funding_liquidity_projections
          set policy_revision = 'mutated_revision_12345678'
          where id = $1
        `,
        [projectionId],
      ),
    /immutable/i,
  );

  const afterExpiry = new Date(Date.parse(publicProjection.expiresAt) + 1);
  assert.equal(
    await store.fetchOwnedCurrent({
      userId,
      projectionId,
      now: afterExpiry,
    }),
    null,
  );
  assert.equal(
    await deleteExpiredFundingPlanningSnapshots(pool, afterExpiry),
    1,
  );
  console.log(
    "[funding-planning-integration-tests] ok ownership, expiry, immutability, cleanup",
  );

  const destinationSnapshot = {
    destinationOptionId: "destination_route_12345678",
  };
  const routePlan: FundingCommitPlan = {
    operation: {
      purpose: "add_funds",
      initialState: { status: "ready", stage: "ready_for_consumer" },
      experienceMode: "instant",
      planKind: "already_available",
      sourceSnapshot: {},
      destinationTargetSnapshot: destinationSnapshot,
      externalRecipientId: null,
      venueId: "polymarket",
      marketId: null,
      marketContextSnapshot: null,
      venueBindingSnapshot: null,
      walletExecutionSnapshot: null,
      placementSnapshot: { mode: "confirmed_deposit_amount" },
      requestedSourceAmount: null,
      requestedDestinationAmount: {
        asset: ASSET,
        raw: "1000000",
      },
    },
    segments: [],
    steps: [],
    reservations: [],
  };
  const consentToken = `consent_${crypto.randomUUID()}`;
  const quote = await createFundingQuote(pool, {
    userId,
    discoveryProjectionId: projectionId,
    selectedSourceOptionSnapshot: {},
    marketContextSnapshot: null,
    destinationOptionSnapshot: destinationSnapshot,
    venueBindingSnapshot: null,
    planSnapshot: routePlan,
    policyVersion: 1,
    policyRevision: "policy_revision_12345678",
    canonicalRequest: { purpose: "route_experience_test" },
    consentToken,
    expiresAt: new Date(Date.now() + 60_000),
  });
  routeQuoteId = quote.id;
  const committed = await commitFundingOperation(pool, {
    userId,
    quoteId: quote.id,
    consentToken,
    idempotencyKey: `idempotency_${crypto.randomUUID()}`,
    plan: routePlan,
    subjectLookupHmac: "d".repeat(64),
    subjectLookupKeyVersion: 1,
  });
  routeOperationId = committed.operation.id;
  const lookupKey = "route-experience-integration-key".repeat(2);
  const routeKeyHmac = fundingRouteExperienceFingerprint(
    "relay|polygon-pusd|polymarket|usd_lt_100",
    lookupKey,
  );
  const startedAt = new Date();
  for (const [index, row] of [
    { outcome: "succeeded", latencyMs: 10_000 },
    { outcome: "succeeded", latencyMs: 20_000 },
    { outcome: "failed", latencyMs: 30_000 },
  ].entries()) {
    await pool.query(
      `
        insert into funding_route_observations (
          user_id,
          operation_id,
          route_key_hmac,
          route_key_version,
          provider_id,
          adapter_version,
          amount_band,
          started_at,
          finished_at,
          outcome,
          policy_revision
        )
        values ($1, $2, $3, 1, 'relay', 1, 'usd_lt_100', $4, $5, $6, $7)
      `,
      [
        userId,
        routeOperationId,
        routeKeyHmac,
        new Date(startedAt.getTime() + index),
        new Date(startedAt.getTime() + index + row.latencyMs),
        row.outcome,
        "policy_revision_12345678",
      ],
    );
  }
  const experience = await fetchFundingRouteExperience(pool, {
    routeKeyHmac,
    routeKeyVersion: 1,
    maximumAgeMs: 60_000,
    now: new Date(startedAt.getTime() + 40_000),
  });
  assert.equal(experience?.observationCount, 3);
  assert.equal(experience?.succeededCount, 2);
  assert.ok((experience?.p95LatencyMs ?? 0) >= 29_000);
  console.log(
    "[funding-planning-integration-tests] ok actual route observation aggregation",
  );
} finally {
  if (routeOperationId) {
    await pool.query(
      "delete from funding_route_observations where operation_id = $1",
      [routeOperationId],
    );
    await pool.query(
      "delete from funding_reconciliation_jobs where operation_id = $1",
      [routeOperationId],
    );
    await pool.query("delete from funding_operations where id = $1", [
      routeOperationId,
    ]);
  }
  if (routeQuoteId) {
    await pool.query("delete from funding_quotes where id = $1", [
      routeQuoteId,
    ]);
  }
  await pool.query(
    "delete from funding_liquidity_projections where user_id = any($1::uuid[])",
    [[userId, otherUserId]],
  );
  await pool.query("delete from users where id = any($1::uuid[])", [
    [userId, otherUserId],
  ]);
}
