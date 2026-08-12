#!/usr/bin/env tsx

// @api-integration

import assert from "node:assert/strict";
import crypto from "node:crypto";

import type { PoolClient } from "pg";

import "../../../integration-test-database-guard.js";
import {
  FundingMergeConflictError,
  mergeUsers,
  type UserRow as MergeUserRow,
} from "../../../admin-merge-user-core.js";
import { pool } from "../../../db.js";
import { AuthService } from "../../../auth.js";
import { storeExecutionInTransaction } from "../../../repos/executions-repo.js";
import {
  applyFundingSourceDebitSuppression,
  loadFundingAccountValueFacts,
} from "../../../account-value/funding-movement-feed.js";
import type { ValuedAssetComponent } from "../../domain/types.js";
import {
  assertFundingReservationReadyForTrade,
  consumeFundingReservationForLinkedConsumerInTransaction,
  fetchFundingWithdrawalDestinationForUser,
  finishFundingRouteObservationInTransaction,
  finishFundingStepAttemptInTransaction,
  releaseFundingReservationForAbandonedTradeInTransaction,
  registerFundingWithdrawalDestination,
  registerFundingWithdrawalDestinationInTransaction,
  revokeFundingWithdrawalDestinationInTransaction,
  startFundingRouteObservationInTransaction,
  startFundingStepAttemptInTransaction,
  upsertFundingProviderRequestInTransaction,
} from "../../persistence/funding-evidence-repository.js";
import {
  advanceFundingObservationFinalityInTransaction,
  allocateFundingObservationInTransaction,
  claimFundingReconciliationJobsInTransaction,
  commitFundingOperation,
  commitFundingOperationInTransaction,
  createFundingQuote,
  createFundingQuoteInTransaction,
  fetchFundingQuoteForUser,
  fetchFundingOperationForUser,
  finishFundingReconciliationLease,
  FundingPersistenceError,
  releaseFundingReservationInTransaction,
  renewFundingReconciliationLease,
  transitionFundingOperation,
  transitionFundingOperationInTransaction,
  wakeFundingReconciliationInTransaction,
  type FundingCommitInput,
  type FundingCommitPlan,
  type FundingQuoteInsert,
} from "../../persistence/funding-operation-repository.js";
import { applyFundingStepReceiptEvidenceInTransaction } from "../../persistence/funding-step-receipt-repository.js";
import {
  claimFundingTradeAttemptInTransaction,
  markFundingTradeAttemptSubmissionStartedInTransaction,
} from "../../persistence/funding-trade-attempt-repository.js";
import { buildFundingTradeConsumerIntent } from "../../persistence/funding-trade-consumer-intent.js";
import {
  createOrReplayFundingPreparationRun,
  fetchFundingPreparationRun,
  reportFundingPreparationAction,
  resolveFundingPreparationRun,
} from "../../persistence/funding-preparation-run-repository.js";
import { ingestFundingObservationInTransaction } from "../../reconciliation/funding-observation-ingestion.js";
import {
  FUNDING_RECONCILIATION_TIMEOUT_ERROR_CODE,
  reduceFundingOperationInTransaction,
  runFundingReconciliationBatch,
} from "../../reconciliation/funding-reducer.js";
import { OwnedRouteDestinationObserver } from "../../reconciliation/owned-route-destination-observer.js";

const ASSET = {
  networkId: "eip155:137",
  assetId: "erc20:0x0000000000000000000000000000000000000001",
  decimals: 6,
} as const;

function opaque(prefix: string): string {
  return `${prefix}:${crypto.randomUUID()}`;
}

function hash(character: string): string {
  return character.repeat(64);
}

function money(raw: string) {
  return { asset: ASSET, raw } as const;
}

function buildPlan(
  input: {
    purpose?: "add_funds" | "trade_shortfall";
    planKind?: "wallet_route" | "already_available";
    marketId?: string | null;
    venueId?: string | null;
    includeReservation?: boolean;
    includeStep?: boolean;
    invalidDependency?: boolean;
    marketSide?: string;
    requestedCollateralRaw?: string;
    sourceComponentId?: string;
    sourceLocationId?: string;
  } = {},
): FundingCommitPlan {
  const planKind = input.planKind ?? "wallet_route";
  const sourceSnapshot = {
    componentId: input.sourceComponentId ?? opaque("component"),
    locationId: input.sourceLocationId ?? opaque("source-location"),
    networkId: ASSET.networkId,
    assetId: ASSET.assetId,
  };
  const destinationTargetSnapshot = {
    componentId: opaque("destination-component"),
    locationId: opaque("destination-location"),
    preparation: "none",
    networkId: ASSET.networkId,
    assetId: ASSET.assetId,
  };
  return {
    operation: {
      purpose: input.purpose ?? "add_funds",
      initialState:
        planKind === "already_available"
          ? { status: "completed", stage: "terminal" }
          : { status: "in_progress", stage: "committed" },
      experienceMode: "instant",
      planKind,
      sourceSnapshot,
      destinationTargetSnapshot,
      externalRecipientId: null,
      venueId: input.venueId ?? null,
      marketId: input.marketId ?? null,
      marketContextSnapshot:
        input.marketId && input.venueId
          ? {
              marketContextId: opaque("market-context"),
              marketId: input.marketId,
              venueId: input.venueId,
              side: input.marketSide ?? "BUY",
              collateralAsset: ASSET,
              requestedCollateralRaw: input.requestedCollateralRaw ?? "990000",
            }
          : null,
      venueBindingSnapshot: null,
      walletExecutionSnapshot: null,
      placementSnapshot: {},
      requestedSourceAmount: money("1000000"),
      requestedDestinationAmount: money("990000"),
      supportMetadata: { test: true },
    },
    segments:
      planKind === "already_available"
        ? []
        : [
            {
              providerId: "synthetic",
              adapterId: "synthetic-read-only",
              adapterVersion: 1,
              segmentKind: "same_network_swap",
              status: "planned",
              sourceSnapshot,
              destinationTargetSnapshot,
              quotedInput: money("1000000"),
              quotedExpectedOutput: money("990000"),
              quotedMinOutput: money("980000"),
              providerQuoteRefCiphertext: "ciphertext:quote",
              providerQuoteRefLookupHmac: hash("a"),
              depositAddressCiphertext: null,
              depositAddressLookupHmac: null,
              lookupKeyVersion: 1,
              refundLocationSnapshot: sourceSnapshot,
              quoteExpiresAt: new Date(Date.now() + 60_000).toISOString(),
            },
          ],
    steps:
      input.includeStep === false
        ? []
        : [
            {
              ordinal: 0,
              segmentOrdinal: planKind === "already_available" ? null : 0,
              stepKind: "transaction",
              state: "planned",
              actionFingerprint: hash("b"),
              executorId: "synthetic-executor",
              payerRequirement: "user",
              dependsOnOrdinal: input.invalidDependency ? 9 : null,
              normalizedAction: { kind: "synthetic" },
              actionValidationResult: { valid: true },
            },
          ],
    reservations:
      input.includeReservation === false || planKind === "already_available"
        ? []
        : [
            {
              segmentOrdinal:
                planKind === "wallet_route" ||
                planKind === "relay_deposit_address"
                  ? 0
                  : null,
              componentId: sourceSnapshot.componentId,
              locationId: sourceSnapshot.locationId,
              networkId: ASSET.networkId,
              assetId: ASSET.assetId,
              assetDecimals: ASSET.decimals,
              rawAmount: "1000000",
              mode: "subtract_available",
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
            },
          ],
  };
}

function quoteInput(
  userId: string,
  plan: FundingCommitPlan,
  consentToken: string,
): FundingQuoteInsert {
  return {
    userId,
    discoveryProjectionId: opaque("projection"),
    selectedSourceOptionSnapshot: plan.operation.sourceSnapshot ?? {},
    marketContextSnapshot: plan.operation.marketContextSnapshot,
    destinationOptionSnapshot: plan.operation.destinationTargetSnapshot,
    venueBindingSnapshot: plan.operation.venueBindingSnapshot,
    planSnapshot: plan,
    policyVersion: 1,
    policyRevision: "wp3-test",
    canonicalRequest: {
      source: plan.operation.sourceSnapshot,
      destination: plan.operation.destinationTargetSnapshot,
      amount: plan.operation.requestedSourceAmount,
    },
    consentToken,
    expiresAt: new Date(Date.now() + 60_000),
  };
}

function commitInput(
  userId: string,
  quoteId: string,
  consentToken: string,
  plan: FundingCommitPlan,
  idempotencyKey = opaque("idempotency"),
): FundingCommitInput {
  return {
    userId,
    quoteId,
    consentToken,
    idempotencyKey,
    plan,
    subjectLookupHmac: hash("c"),
    subjectLookupKeyVersion: 1,
  };
}

async function insertUser(client: Pick<PoolClient, "query">): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `
      insert into users (email, is_active, is_verified)
      values ($1, true, true)
      returning id
    `,
    [`funding-wp3-${crypto.randomUUID()}@example.com`],
  );
  const id = rows[0]?.id;
  assert.ok(id);
  return id;
}

async function expectFundingError(
  promise: Promise<unknown>,
  code: FundingPersistenceError["code"],
): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof FundingPersistenceError);
    assert.equal(error.code, code);
    return true;
  });
}

async function cleanupCommittedOperation(
  operationId: string | null,
  quoteId: string,
  userId: string,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    if (operationId) {
      await client.query(
        "delete from funding_reconciliation_jobs where operation_id = $1",
        [operationId],
      );
      await client.query(
        "delete from funding_observations where operation_id = $1",
        [operationId],
      );
      await client.query(
        "delete from balance_reservations where operation_id = $1",
        [operationId],
      );
      await client.query(
        "delete from funding_operation_steps where operation_id = $1",
        [operationId],
      );
      await client.query(
        `
          delete from funding_provider_requests
          where segment_id in (
            select id
            from funding_operation_segments
            where operation_id = $1
          )
        `,
        [operationId],
      );
      await client.query(
        "delete from funding_operation_segments where operation_id = $1",
        [operationId],
      );
      await client.query("delete from funding_operations where id = $1", [
        operationId,
      ]);
    }
    await client.query("delete from funding_quotes where id = $1", [quoteId]);
    await client.query("delete from users where id = $1", [userId]);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function testConcurrentPreparationRunReplay(): Promise<void> {
  const userId = await insertUser(pool);
  let materializations = 0;
  const request = {
    venueBindingOptionId: "binding:test:preparation",
    purpose: "buy" as const,
    marketContextId: "market:test:preparation",
    marketClass: null,
    positionActionRef: null,
    controllerWalletRef: userId,
    expectedInspectionRevision: hash("b"),
  };
  const create = () =>
    createOrReplayFundingPreparationRun(pool, {
      userId,
      request,
      expiresAt: new Date(Date.now() + 60_000),
      materialize: async (runId) => {
        materializations += 1;
        return {
          controllerWalletRef: userId,
          actions: [
            {
              kind: "evm_transaction" as const,
              actionId: `preparation_action_${runId}`,
              networkId: "evm:137",
              senderWalletId: userId,
              to: "0x0000000000000000000000000000000000000001",
              data: "0x",
              valueRaw: "0",
              gasLimitRaw: null,
            },
          ],
        };
      },
    });
  const [first, second] = await Promise.all([create(), create()]);
  assert.equal(first.runId, second.runId);
  assert.equal(materializations, 1);
  assert.deepEqual([first.replayed, second.replayed].sort(), [false, true]);
  const action = first.actions[0];
  assert.ok(action);
  const report = {
    outcome: "submitted" as const,
    transactionReference: `0x${hash("c")}`,
    networkFeeRaw: null,
  };
  const submitted = await reportFundingPreparationAction(pool, {
    userId,
    runId: first.runId,
    actionId: action.actionId,
    report,
  });
  assert.equal(submitted.status, "submitted");
  const replayedReport = await reportFundingPreparationAction(pool, {
    userId,
    runId: first.runId,
    actionId: action.actionId,
    report,
  });
  assert.equal(replayedReport.replayed, true);
  await expectFundingError(
    reportFundingPreparationAction(pool, {
      userId,
      runId: first.runId,
      actionId: action.actionId,
      report: { ...report, outcome: "ambiguous" },
    }),
    "idempotency_conflict",
  );
  const resolved = await resolveFundingPreparationRun(pool, {
    userId,
    runId: first.runId,
    succeeded: true,
  });
  assert.equal(resolved.status, "succeeded");

  const expiring = await createOrReplayFundingPreparationRun(pool, {
    userId,
    request: {
      ...request,
      expectedInspectionRevision: hash("d"),
    },
    expiresAt: new Date(Date.now() - 1),
    materialize: async (runId) => ({
      controllerWalletRef: userId,
      actions: [
        {
          kind: "evm_transaction" as const,
          actionId: `preparation_action_${runId}`,
          networkId: "evm:137",
          senderWalletId: userId,
          to: "0x0000000000000000000000000000000000000001",
          data: "0x",
          valueRaw: "0",
          gasLimitRaw: null,
        },
      ],
    }),
  });
  const expired = await fetchFundingPreparationRun(pool, {
    userId,
    runId: expiring.runId,
  });
  assert.equal(expired?.status, "expired");
  const lateSubmitted = await reportFundingPreparationAction(pool, {
    userId,
    runId: expiring.runId,
    actionId: expiring.actions[0]?.actionId ?? "",
    report: {
      outcome: "submitted",
      transactionReference: `0x${hash("e")}`,
      networkFeeRaw: null,
    },
  });
  assert.equal(lateSubmitted.status, "submitted");
  const stillSubmitted = await fetchFundingPreparationRun(pool, {
    userId,
    runId: expiring.runId,
  });
  assert.equal(stillSubmitted?.status, "submitted");

  await pool.query(
    "delete from funding_preparation_action_attempts where run_id = any($1::uuid[])",
    [[first.runId, expiring.runId]],
  );
  await pool.query(
    "delete from funding_preparation_runs where id = any($1::uuid[])",
    [[first.runId, expiring.runId]],
  );
  await pool.query("delete from users where id = $1", [userId]);
}

async function testConcurrentCommitReplay(): Promise<void> {
  const userId = await insertUser(pool);
  const plan = buildPlan({
    planKind: "already_available",
    includeStep: false,
  });
  const consentToken = opaque("consent");
  const quote = await createFundingQuote(
    pool,
    quoteInput(userId, plan, consentToken),
  );
  const input = commitInput(
    userId,
    quote.id,
    consentToken,
    plan,
    opaque("concurrent-idempotency"),
  );
  let operationId: string | null = null;
  try {
    const [left, right] = await Promise.all([
      commitFundingOperation(pool, input),
      commitFundingOperation(pool, input),
    ]);
    operationId = left.operation.id;
    assert.equal(left.operation.id, right.operation.id);
    assert.deepEqual([left.replayed, right.replayed].sort(), [false, true]);
    const count = await pool.query<{ count: string }>(
      `
        select count(*)::text as count
        from funding_operations
        where user_id = $1 and idempotency_key = $2
      `,
      [userId, input.idempotencyKey],
    );
    assert.equal(count.rows[0]?.count, "1");
  } finally {
    await cleanupCommittedOperation(operationId, quote.id, userId);
  }
}

async function testPersistedQuoteSurvivesStatelessCommitBoundary(): Promise<void> {
  const userId = await insertUser(pool);
  const plan = buildPlan({
    planKind: "already_available",
    includeStep: false,
  });
  const consentToken = opaque("consent");
  const quote = await createFundingQuote(
    pool,
    quoteInput(userId, plan, consentToken),
  );
  let operationId: string | null = null;
  try {
    const reloaded = await fetchFundingQuoteForUser(pool, {
      userId,
      quoteId: quote.id,
    });
    assert.ok(reloaded);
    const reloadedPlan = reloaded.planSnapshot as unknown as FundingCommitPlan;
    assert.deepEqual(reloadedPlan, plan);

    const committed = await commitFundingOperation(
      pool,
      commitInput(userId, quote.id, consentToken, reloadedPlan),
    );
    operationId = committed.operation.id;
    assert.equal(committed.replayed, false);
    assert.equal(committed.operation.quoteId, quote.id);
  } finally {
    await cleanupCommittedOperation(operationId, quote.id, userId);
  }
}

async function testExpiredQuoteCannotCommit(): Promise<void> {
  const userId = await insertUser(pool);
  const plan = buildPlan({
    planKind: "already_available",
    includeStep: false,
  });
  const consentToken = opaque("consent");
  const expiresAt = new Date(Date.now() + 60_000);
  const quote = await createFundingQuote(pool, {
    ...quoteInput(userId, plan, consentToken),
    expiresAt,
  });
  try {
    await expectFundingError(
      commitFundingOperation(pool, {
        ...commitInput(userId, quote.id, consentToken, plan),
        now: new Date(expiresAt.getTime() + 1),
      }),
      "quote_expired",
    );
    const reloaded = await fetchFundingQuoteForUser(pool, {
      userId,
      quoteId: quote.id,
    });
    assert.ok(reloaded);
    assert.equal(reloaded.consumedAt, null);
    const operationCount = await pool.query<{ count: string }>(
      `
        select count(*)::text as count
        from funding_operations
        where quote_id = $1
      `,
      [quote.id],
    );
    assert.equal(operationCount.rows[0]?.count, "0");
  } finally {
    await cleanupCommittedOperation(null, quote.id, userId);
  }
}

async function testQuoteCannotExpireDuringCurrentFactsCheck(): Promise<void> {
  const userId = await insertUser(pool);
  const plan = buildPlan({
    planKind: "already_available",
    includeStep: false,
  });
  const consentToken = opaque("consent");
  const { rows } = await pool.query<{ expires_at: Date }>(
    "select clock_timestamp() + interval '200 milliseconds' as expires_at",
  );
  const expiresAt = rows[0]?.expires_at;
  assert.ok(expiresAt);
  const quote = await createFundingQuote(pool, {
    ...quoteInput(userId, plan, consentToken),
    expiresAt,
  });
  try {
    await expectFundingError(
      commitFundingOperation(pool, {
        ...commitInput(userId, quote.id, consentToken, plan),
        verifyCurrentFacts: async (client) => {
          await client.query("select pg_sleep(0.3)");
        },
      }),
      "quote_expired",
    );
  } finally {
    await cleanupCommittedOperation(null, quote.id, userId);
  }
}

async function testAtomicRollbackAfterPartialInsert(): Promise<void> {
  const userId = await insertUser(pool);
  const plan = buildPlan({
    planKind: "already_available",
    invalidDependency: true,
  });
  const consentToken = opaque("consent");
  const quote = await createFundingQuote(
    pool,
    quoteInput(userId, plan, consentToken),
  );
  try {
    await expectFundingError(
      commitFundingOperation(
        pool,
        commitInput(userId, quote.id, consentToken, plan),
      ),
      "quote_mismatch",
    );
    const operationCount = await pool.query<{ count: string }>(
      "select count(*)::text as count from funding_operations where quote_id = $1",
      [quote.id],
    );
    const quoteState = await pool.query<{ consumed_at: Date | null }>(
      "select consumed_at from funding_quotes where id = $1",
      [quote.id],
    );
    assert.equal(operationCount.rows[0]?.count, "0");
    assert.equal(quoteState.rows[0]?.consumed_at, null);
  } finally {
    await cleanupCommittedOperation(null, quote.id, userId);
  }
}

async function testPollingFailureHonorsTerminalTimeout(): Promise<void> {
  const userId = await insertUser(pool);
  const plan = buildPlan();
  const consentToken = opaque("consent");
  const quote = await createFundingQuote(
    pool,
    quoteInput(userId, plan, consentToken),
  );
  let operationId: string | null = null;
  try {
    const committed = await commitFundingOperation(
      pool,
      commitInput(userId, quote.id, consentToken, plan),
    );
    operationId = committed.operation.id;
    await pool.query(
      `
        update funding_operation_steps
        set state = 'submitted'
        where operation_id = $1
          and state in ('planned', 'action_required')
      `,
      [operationId],
    );
    await pool.query(
      `
        update funding_operation_steps
        set state = 'succeeded'
        where operation_id = $1
          and state = 'submitted'
      `,
      [operationId],
    );
    const now = new Date();
    await pool.query(
      `
        update funding_reconciliation_jobs
        set due_at = $2::timestamptz,
            status = 'scheduled',
            lease_owner = null,
            lease_token = null,
            lease_until = null
        where operation_id = $1
      `,
      [operationId, now],
    );
    await pool.query(
      `
        update funding_operations
        set support_metadata = support_metadata || jsonb_build_object(
          'reconciliationActiveSince',
          ($2::timestamptz - interval '90 seconds')::text,
          'reconciliationActiveAttemptBaseline',
          0
        ),
            version = version + 1
        where id = $1
      `,
      [operationId, now],
    );

    const result = await runFundingReconciliationBatch(pool, {
      workerId: opaque("terminal-timeout-succeeded-worker"),
      limit: 1,
      terminalTimeoutMs: 90_000,
      now,
      providerPoll: async () => {
        throw new Error("synthetic provider timeout");
      },
    });

    assert.deepEqual(
      {
        claimed: result.claimed,
        deadLettered: result.deadLettered,
        failed: result.failed,
        requeued: result.requeued,
      },
      { claimed: 1, deadLettered: 0, failed: 0, requeued: 1 },
    );
    const operation = await pool.query<{
      error_code: string | null;
      recovery_mode: string | null;
      status: string;
    }>(
      `
        select status, error_code, recovery_mode
        from funding_operations
        where id = $1
      `,
      [operationId],
    );
    assert.deepEqual(operation.rows[0], {
      status: "recovery_required",
      error_code: FUNDING_RECONCILIATION_TIMEOUT_ERROR_CODE,
      recovery_mode: "automatic_evidence",
    });
    const steps = await pool.query<{ state: string }>(
      `
        select state
        from funding_operation_steps
        where operation_id = $1
        order by ordinal
      `,
      [operationId],
    );
    assert.deepEqual(
      steps.rows.map((step) => step.state),
      ["succeeded"],
    );
    const job = await pool.query<{
      due_at: Date;
      last_error_code: string | null;
      status: string;
    }>(
      `
        select status, last_error_code, due_at
        from funding_reconciliation_jobs
        where operation_id = $1
      `,
      [operationId],
    );
    assert.deepEqual(job.rows[0], {
      status: "scheduled",
      last_error_code: null,
      due_at: new Date(now.getTime() + 60_000),
    });
  } finally {
    await cleanupCommittedOperation(operationId, quote.id, userId);
  }
}

async function testOwnedRouteCompetitionQueryParses(): Promise<void> {
  const observer = new OwnedRouteDestinationObserver();
  assert.deepEqual(await observer.pollOperation(pool, crypto.randomUUID()), {
    destinationsPolled: 0,
    destinationSatisfied: false,
  });
}

async function testAutomaticRecoveryAcceptsLateDestinationEvidence(): Promise<void> {
  const userId = await insertUser(pool);
  const destinationLocationId = opaque("recovery-destination");
  const destinationComponentId = opaque("recovery-component");
  const destinationTargetSnapshot = {
    kind: "owned_location",
    componentId: destinationComponentId,
    locationId: destinationLocationId,
    preparation: "none",
    networkId: ASSET.networkId,
    assetId: ASSET.assetId,
    location: {
      kind: "venue_account",
      locationId: destinationLocationId,
      accountId: userId,
      asset: ASSET,
      details: {
        address: "0x00000000000000000000000000000000000000d2",
        venueId: "limitless",
      },
    },
  } as const;
  const basePlan = buildPlan({
    purpose: "trade_shortfall",
    venueId: "limitless",
  });
  const plan: FundingCommitPlan = {
    ...basePlan,
    operation: {
      ...basePlan.operation,
      destinationTargetSnapshot,
      requestedSourceAmount: money("5090982"),
      requestedDestinationAmount: money("5006577"),
      venueBindingSnapshot: {
        venueBindingOptionId: opaque("recovery-binding"),
      },
      supportMetadata: {
        destinationObservation: {
          observerId: "relay_owned_destination_observation_v1",
          locationId: destinationLocationId,
          asset: ASSET,
          baselineRaw: "4993423",
          baselineRevision: opaque("recovery-baseline"),
          baselineAsOf: "2026-07-31T02:23:04.647Z",
        },
      },
    },
    segments: basePlan.segments.map((segment) => ({
      ...segment,
      providerId: "relay",
      destinationTargetSnapshot,
      quotedInput: money("5090982"),
      quotedExpectedOutput: money("5057149"),
      quotedMinOutput: money("5006577"),
    })),
    reservations: basePlan.reservations.map((reservation) => ({
      ...reservation,
      rawAmount: "5090982",
    })),
  };
  const consentToken = opaque("recovery-consent");
  const quote = await createFundingQuote(
    pool,
    quoteInput(userId, plan, consentToken),
  );
  let operationId: string | null = null;
  try {
    const committed = await commitFundingOperation(
      pool,
      commitInput(userId, quote.id, consentToken, plan),
    );
    operationId = committed.operation.id;
    let operation = await transitionFundingOperation(pool, {
      operationId,
      scope: { kind: "worker" },
      expectedVersion: committed.operation.version,
      expectedState: {
        status: committed.operation.status,
        stage: committed.operation.progressStage,
      },
      nextState: { status: "in_progress", stage: "source_action" },
    });
    operation = await transitionFundingOperation(pool, {
      operationId,
      scope: { kind: "worker" },
      expectedVersion: operation.version,
      expectedState: {
        status: operation.status,
        stage: operation.progressStage,
      },
      nextState: {
        status: "recovery_required",
        stage: "source_action",
      },
      errorCode: "manual_fixture",
      recoveryMode: "manual_review",
    });
    await pool.query(
      `
        update funding_operation_steps
        set state = 'submitted'
        where operation_id = $1
      `,
      [operationId],
    );
    await pool.query(
      `
        update funding_operation_steps
        set state = 'succeeded'
        where operation_id = $1
      `,
      [operationId],
    );
    await pool.query(
      `
        update funding_operation_segments
        set status = 'submitted',
            submitted_at = now(),
            raw_status = 'success',
            support_metadata = support_metadata || jsonb_build_object(
              'relayStatusCategory', 'provider_success',
              'originTransactionReferenceCount', 1,
              'destinationTransactionReferenceCount', 1
            )
        where operation_id = $1
      `,
      [operationId],
    );

    const observedAt = new Date();
    let balanceReads = 0;
    const observer = new OwnedRouteDestinationObserver({
      observe: async () => {
        balanceReads += 1;
        return {
          observedRaw: "10050674",
          revision: "recovery-observation",
          observedAt: observedAt.toISOString(),
        };
      },
    });
    assert.deepEqual(await observer.pollOperation(pool, operationId), {
      destinationsPolled: 0,
      destinationSatisfied: false,
    });
    assert.equal(balanceReads, 0);

    const manualRecoveryClient = await pool.connect();
    try {
      await manualRecoveryClient.query("begin");
      const segment = await manualRecoveryClient.query<{ id: string }>(
        `
          select id
          from funding_operation_segments
          where operation_id = $1 and ordinal = 0
        `,
        [operationId],
      );
      const segmentId = segment.rows[0]?.id;
      assert.ok(segmentId);
      await ingestFundingObservationInTransaction(manualRecoveryClient, {
        discoverySource: "chain_rpc",
        observation: {
          operationId,
          segmentId,
          kind: "destination_credit",
          networkId: ASSET.networkId,
          assetId: ASSET.assetId,
          assetDecimals: ASSET.decimals,
          txHash: opaque("manual-recovery-destination"),
          eventIndex: "0",
          fromAddress: "0xrouter",
          toAddress: "0x00000000000000000000000000000000000000d2",
          rawAmount: "5057251",
          observedAt,
          ledgerHeight: "200",
          blockHash: opaque("manual-recovery-block"),
          finalityStatus: "finalized",
          finalizedAt: observedAt,
        },
      });
      const manualRecovery = await reduceFundingOperationInTransaction(
        manualRecoveryClient,
        { operationId },
      );
      assert.deepEqual(manualRecovery.finalState, {
        status: "ready",
        stage: "ready_for_consumer",
      });
      const resolvedManual = await fetchFundingOperationForUser(
        manualRecoveryClient,
        { userId, operationId },
      );
      assert.equal(resolvedManual?.recoveryMode, null);
      assert.equal(resolvedManual?.errorCode, null);
      await manualRecoveryClient.query("rollback");
    } catch (error) {
      await manualRecoveryClient.query("rollback");
      throw error;
    } finally {
      manualRecoveryClient.release();
    }

    operation = await transitionFundingOperation(pool, {
      operationId,
      scope: { kind: "worker" },
      expectedVersion: operation.version,
      expectedState: {
        status: operation.status,
        stage: operation.progressStage,
      },
      nextState: { status: "in_progress", stage: "source_action" },
    });
    await transitionFundingOperation(pool, {
      operationId,
      scope: { kind: "worker" },
      expectedVersion: operation.version,
      expectedState: {
        status: operation.status,
        stage: operation.progressStage,
      },
      nextState: {
        status: "recovery_required",
        stage: "source_action",
      },
      errorCode: FUNDING_RECONCILIATION_TIMEOUT_ERROR_CODE,
      recoveryMode: "automatic_evidence",
    });

    const withoutEvidenceClient = await pool.connect();
    try {
      await withoutEvidenceClient.query("begin");
      await withoutEvidenceClient.query(
        `
          update funding_operation_steps
          set state = 'recovery_required'
          where operation_id = $1
        `,
        [operationId],
      );
      const withoutEvidence = await reduceFundingOperationInTransaction(
        withoutEvidenceClient,
        { operationId },
      );
      assert.deepEqual(withoutEvidence.finalState, {
        status: "recovery_required",
        stage: "source_action",
      });
      const preserved = await fetchFundingOperationForUser(
        withoutEvidenceClient,
        { userId, operationId },
      );
      assert.equal(
        preserved?.errorCode,
        FUNDING_RECONCILIATION_TIMEOUT_ERROR_CODE,
      );
      assert.equal(preserved?.recoveryMode, "automatic_evidence");
      await withoutEvidenceClient.query("rollback");
    } catch (error) {
      await withoutEvidenceClient.query("rollback");
      throw error;
    } finally {
      withoutEvidenceClient.release();
    }

    assert.deepEqual(await observer.pollOperation(pool, operationId), {
      destinationsPolled: 1,
      destinationSatisfied: true,
    });
    assert.equal(balanceReads, 1);
    const reductionClient = await pool.connect();
    try {
      await reductionClient.query("begin");
      await reduceFundingOperationInTransaction(reductionClient, {
        operationId,
      });
      await reductionClient.query("commit");
    } catch (error) {
      await reductionClient.query("rollback");
      throw error;
    } finally {
      reductionClient.release();
    }

    const recovered = await fetchFundingOperationForUser(pool, {
      userId,
      operationId,
    });
    assert.equal(recovered?.status, "ready");
    assert.equal(recovered?.progressStage, "ready_for_consumer");
    assert.equal(recovered?.recoveryMode, null);
    assert.equal(recovered?.errorCode, null);
    const recoveredFacts = await pool.query<{
      destination_credit_count: string;
      segment_status: string;
      settled_reservation_count: string;
    }>(
      `
        select
          (
            select count(*)::text
            from funding_observations observation
            where observation.operation_id = operation.id
              and observation.kind = 'destination_credit'
          ) as destination_credit_count,
          (
            select segment.status
            from funding_operation_segments segment
            where segment.operation_id = operation.id
              and segment.ordinal = 0
          ) as segment_status,
          (
            select count(*)::text
            from balance_reservations reservation
            where reservation.operation_id = operation.id
              and reservation.mode = 'settled_for_consumer'
          ) as settled_reservation_count
        from funding_operations operation
        where operation.id = $1
      `,
      [operationId],
    );
    assert.deepEqual(recoveredFacts.rows[0], {
      destination_credit_count: "1",
      segment_status: "succeeded",
      settled_reservation_count: "1",
    });

    assert.deepEqual(await observer.pollOperation(pool, operationId), {
      destinationsPolled: 0,
      destinationSatisfied: false,
    });
    const replayClient = await pool.connect();
    try {
      await replayClient.query("begin");
      await reduceFundingOperationInTransaction(replayClient, { operationId });
      await replayClient.query("commit");
    } catch (error) {
      await replayClient.query("rollback");
      throw error;
    } finally {
      replayClient.release();
    }
    const replayFacts = await pool.query<{
      destination_credit_count: string;
      settled_reservation_count: string;
    }>(
      `
        select
          (
            select count(*)::text
            from funding_observations observation
            where observation.operation_id = operation.id
              and observation.kind = 'destination_credit'
          ) as destination_credit_count,
          (
            select count(*)::text
            from balance_reservations reservation
            where reservation.operation_id = operation.id
              and reservation.mode = 'settled_for_consumer'
          ) as settled_reservation_count
        from funding_operations operation
        where operation.id = $1
      `,
      [operationId],
    );
    assert.deepEqual(replayFacts.rows[0], {
      destination_credit_count: "1",
      settled_reservation_count: "1",
    });
  } finally {
    await cleanupCommittedOperation(operationId, quote.id, userId);
  }
}

async function testUnexposedRecoveryRouteDoesNotBlockDestinationObservation(): Promise<void> {
  const client = await pool.connect();
  await client.query("begin");
  try {
    const userId = await insertUser(client);
    const destinationLocationId = opaque("shared-destination");
    const destinationTargetSnapshot = {
      kind: "owned_location",
      location: {
        kind: "venue_account",
        locationId: destinationLocationId,
        accountId: userId,
        asset: ASSET,
        details: {
          address: "0x00000000000000000000000000000000000000d1",
          venueId: "polymarket",
        },
      },
    } as const;
    const basePlan = buildPlan({
      includeReservation: false,
      venueId: "polymarket",
    });
    const relayPlan: FundingCommitPlan = {
      ...basePlan,
      operation: {
        ...basePlan.operation,
        destinationTargetSnapshot,
        requestedDestinationAmount: money("980000"),
        venueBindingSnapshot: {
          venueBindingOptionId: opaque("binding"),
        },
        supportMetadata: {
          destinationObservation: {
            observerId: "relay_owned_destination_observation_v1",
            locationId: destinationLocationId,
            asset: ASSET,
            baselineRaw: "1000000",
            baselineRevision: opaque("baseline"),
            baselineAsOf: "2026-07-29T22:35:48.275Z",
          },
        },
      },
      segments: basePlan.segments.map((segment) => ({
        ...segment,
        providerId: "relay",
      })),
    };
    const commit = async (label: string) => {
      const consentToken = opaque(`consent-${label}`);
      const quote = await createFundingQuoteInTransaction(
        client,
        quoteInput(userId, relayPlan, consentToken),
      );
      return commitFundingOperationInTransaction(
        client,
        commitInput(
          userId,
          quote.id,
          consentToken,
          relayPlan,
          opaque(`idempotency-${label}`),
        ),
      );
    };
    const competingCommit = await commit("competing");
    const currentCommit = await commit("current");

    await client.query(
      `
        update funding_operation_steps
        set state = 'submitted'
        where operation_id = $1
      `,
      [currentCommit.operation.id],
    );
    await client.query(
      `
        update funding_operation_steps
        set state = 'succeeded'
        where operation_id = $1
      `,
      [currentCommit.operation.id],
    );
    await client.query(
      `
        update funding_operation_segments
        set raw_status = 'success',
            support_metadata = support_metadata || jsonb_build_object(
              'relayStatusCategory', 'provider_success',
              'originTransactionReferenceCount', 1,
              'destinationTransactionReferenceCount', 1
            )
        where operation_id = $1
      `,
      [currentCommit.operation.id],
    );

    const observer = new OwnedRouteDestinationObserver({
      observe: async () => ({
        observedRaw: "1990000",
        revision: opaque("observation"),
        observedAt: "2026-07-29T22:36:30.000Z",
      }),
      persist: async () => true,
    });
    assert.deepEqual(
      await observer.pollOperation(
        client as unknown as Parameters<
          OwnedRouteDestinationObserver["pollOperation"]
        >[0],
        currentCommit.operation.id,
      ),
      { destinationsPolled: 1, destinationSatisfied: true },
      "an unbroadcast action_required route must not block a delivered route",
    );

    let competingOperation = await transitionFundingOperationInTransaction(
      client,
      {
        operationId: competingCommit.operation.id,
        scope: { kind: "worker" },
        expectedVersion: competingCommit.operation.version,
        expectedState: {
          status: competingCommit.operation.status,
          stage: competingCommit.operation.progressStage,
        },
        nextState: { status: "in_progress", stage: "source_action" },
      },
    );
    competingOperation = await transitionFundingOperationInTransaction(client, {
      operationId: competingOperation.id,
      scope: { kind: "worker" },
      expectedVersion: competingOperation.version,
      expectedState: {
        status: competingOperation.status,
        stage: competingOperation.progressStage,
      },
      nextState: {
        status: "reconcile_required",
        stage: "source_action",
      },
    });
    await transitionFundingOperationInTransaction(client, {
      operationId: competingOperation.id,
      scope: { kind: "worker" },
      expectedVersion: competingOperation.version,
      expectedState: {
        status: competingOperation.status,
        stage: competingOperation.progressStage,
      },
      nextState: { status: "recovery_required", stage: "source_action" },
      errorCode: "fixture_recovery",
    });
    await client.query(
      `
        update funding_operation_segments
        set raw_status = 'submitted',
            support_metadata = support_metadata || jsonb_build_object(
              'relayStatusCategory', 'in_progress',
              'originTransactionReferenceCount', 1,
              'destinationTransactionReferenceCount', 0
            )
        where operation_id = $1
      `,
      [competingCommit.operation.id],
    );
    assert.deepEqual(
      await observer.pollOperation(
        client as unknown as Parameters<
          OwnedRouteDestinationObserver["pollOperation"]
        >[0],
        currentCommit.operation.id,
      ),
      { destinationsPolled: 1, destinationSatisfied: true },
    );

    await client.query(
      `
        update funding_operation_segments
        set raw_status = 'success',
            support_metadata = support_metadata || jsonb_build_object(
              'relayStatusCategory', 'provider_success',
              'destinationTransactionReferenceCount', 1
            )
        where operation_id = $1
      `,
      [competingCommit.operation.id],
    );
    assert.deepEqual(
      await observer.pollOperation(
        client as unknown as Parameters<
          OwnedRouteDestinationObserver["pollOperation"]
        >[0],
        currentCommit.operation.id,
      ),
      { destinationsPolled: 0, destinationSatisfied: false },
    );
  } finally {
    await client.query("rollback");
    client.release();
  }
}

async function testActionWaitUsesIdleReconciliationWithoutExternalPolling(): Promise<void> {
  const userId = await insertUser(pool);
  const basePlan = buildPlan();
  const firstStep = basePlan.steps[0];
  assert.ok(firstStep);
  const plan: FundingCommitPlan = {
    ...basePlan,
    steps: [
      firstStep,
      {
        ...firstStep,
        ordinal: 1,
        actionFingerprint: hash("d"),
      },
    ],
  };
  const consentToken = opaque("consent");
  const quote = await createFundingQuote(
    pool,
    quoteInput(userId, plan, consentToken),
  );
  let operationId: string | null = null;
  try {
    const committed = await commitFundingOperation(
      pool,
      commitInput(userId, quote.id, consentToken, plan),
    );
    operationId = committed.operation.id;
    const waitingAt = new Date(
      committed.operation.createdAt.getTime() + 10_000,
    );
    await pool.query(
      `
        update funding_operations
        set progress_stage = 'source_action',
            support_metadata = support_metadata || jsonb_build_object(
              'reconciliationActiveSince',
              '2026-07-29T14:00:00.000Z',
              'reconciliationActiveAttemptBaseline',
              0
            ),
            version = version + 1
        where id = $1
      `,
      [operationId],
    );
    await pool.query(
      `
        update funding_operation_steps
        set state = 'action_required'
        where operation_id = $1
      `,
      [operationId],
    );
    await pool.query(
      `
        update funding_reconciliation_jobs
        set due_at = $2,
            status = 'scheduled',
            attempt_count = 99,
            lease_owner = null,
            lease_token = null,
            lease_until = null
        where operation_id = $1
      `,
      [operationId, waitingAt],
    );

    const externalPolls: string[] = [];
    const waitingResult = await runFundingReconciliationBatch(pool, {
      workerId: opaque("inactive-window-worker"),
      limit: 1,
      maxAttempts: 2,
      pollDelayMs: 2_000,
      idlePollDelayMs: 15_000,
      now: waitingAt,
      receiptPoll: async () => {
        externalPolls.push("receipt");
        return { receiptsPolled: 0 };
      },
      postconditionPoll: async () => {
        externalPolls.push("postcondition");
        return { postconditionsPolled: 0 };
      },
      destinationPoll: async () => {
        externalPolls.push("destination");
        return { destinationsPolled: 0, destinationSatisfied: false };
      },
      providerPoll: async () => {
        externalPolls.push("provider");
        return { requestsPolled: 0 };
      },
    });
    assert.deepEqual(
      {
        claimed: waitingResult.claimed,
        requeued: waitingResult.requeued,
        deadLettered: waitingResult.deadLettered,
        externalPolls,
      },
      { claimed: 1, requeued: 1, deadLettered: 0, externalPolls: [] },
    );
    const idleWait = await pool.query<{
      active_since: string | null;
      attempt_baseline: string | null;
      due_at: Date;
    }>(
      `
        select
          support_metadata ->> 'reconciliationActiveSince' as active_since,
          support_metadata ->> 'reconciliationActiveAttemptBaseline'
            as attempt_baseline,
          job.due_at
        from funding_operations operation
        join funding_reconciliation_jobs job
          on job.operation_id = operation.id
        where operation.id = $1
      `,
      [operationId],
    );
    assert.deepEqual(idleWait.rows[0], {
      active_since: null,
      attempt_baseline: null,
      due_at: new Date(waitingAt.getTime() + 15_000),
    });

    const firstStepResult = await pool.query<{ id: string }>(
      `
        select id
        from funding_operation_steps
        where operation_id = $1 and ordinal = 0
      `,
      [operationId],
    );
    const firstStepId = firstStepResult.rows[0]?.id;
    assert.ok(firstStepId);
    const reportedAt = new Date(waitingAt.getTime() + 1_000);
    const reportClient = await pool.connect();
    try {
      await reportClient.query("begin");
      await reportClient.query(
        `
          update funding_operation_steps
          set state = 'submitted',
              updated_at = $3
          where operation_id = $1 and id = $2
        `,
        [operationId, firstStepId, reportedAt],
      );
      await wakeFundingReconciliationInTransaction(reportClient, {
        operationId,
        dueAt: reportedAt,
      });
      await reportClient.query("commit");
    } catch (error) {
      await reportClient.query("rollback");
      throw error;
    } finally {
      reportClient.release();
    }
    const wokenJob = await pool.query<{ due_at: Date; status: string }>(
      `
        select due_at, status
        from funding_reconciliation_jobs
        where operation_id = $1
      `,
      [operationId],
    );
    assert.equal(wokenJob.rows[0]?.status, "scheduled");
    assert.ok(
      Number(wokenJob.rows[0]?.due_at.getTime()) <= reportedAt.getTime(),
      "action report must leave reconciliation immediately claimable",
    );

    const mixedPolls: string[] = [];
    const resumedResult = await runFundingReconciliationBatch(pool, {
      workerId: opaque("resumed-window-worker"),
      limit: 1,
      maxAttempts: 2,
      pollDelayMs: 2_000,
      idlePollDelayMs: 15_000,
      now: reportedAt,
      receiptPoll: async () => {
        mixedPolls.push("receipt");
        return { receiptsPolled: 1 };
      },
      postconditionPoll: async () => {
        mixedPolls.push("postcondition");
        return { postconditionsPolled: 0 };
      },
      destinationPoll: async () => {
        mixedPolls.push("destination");
        return { destinationsPolled: 0, destinationSatisfied: false };
      },
      providerPoll: async () => {
        mixedPolls.push("provider");
        throw new Error("synthetic provider timeout after resume");
      },
    });
    assert.deepEqual(
      {
        claimed: resumedResult.claimed,
        failed: resumedResult.failed,
        deadLettered: resumedResult.deadLettered,
        mixedPolls: new Set(mixedPolls),
      },
      {
        claimed: 1,
        failed: 1,
        deadLettered: 0,
        mixedPolls: new Set([
          "receipt",
          "postcondition",
          "destination",
          "provider",
        ]),
      },
    );
    const resumedWindow = await pool.query<{
      active_since: string | null;
      attempt_baseline: string | null;
      operation_status: string;
      job_status: string;
    }>(
      `
        select
          op.support_metadata ->> 'reconciliationActiveSince'
            as active_since,
          op.support_metadata ->> 'reconciliationActiveAttemptBaseline'
            as attempt_baseline,
          op.status as operation_status,
          job.status as job_status
        from funding_operations op
        join funding_reconciliation_jobs job
          on job.operation_id = op.id
        where op.id = $1
      `,
      [operationId],
    );
    assert.deepEqual(resumedWindow.rows[0], {
      active_since: reportedAt.toISOString(),
      attempt_baseline: "100",
      operation_status: "in_progress",
      job_status: "scheduled",
    });
  } finally {
    await cleanupCommittedOperation(operationId, quote.id, userId);
  }
}

async function testExpiredUnbroadcastActionWaitCancelsSafely(): Promise<void> {
  const userId = await insertUser(pool);
  const plan = buildPlan();
  const consentToken = opaque("expiry-consent");
  const quote = await createFundingQuote(
    pool,
    quoteInput(userId, plan, consentToken),
  );
  let operationId: string | null = null;
  try {
    const committed = await commitFundingOperation(
      pool,
      commitInput(userId, quote.id, consentToken, plan),
    );
    operationId = committed.operation.id;
    await pool.query(
      `
        update funding_operations
        set progress_stage = 'source_action',
            version = version + 1
        where id = $1
      `,
      [operationId],
    );
    await pool.query(
      `
        update funding_operation_steps
        set state = 'action_required',
            action_expires_at = created_at + interval '1 millisecond'
        where operation_id = $1
      `,
      [operationId],
    );
    const deadline = await pool.query<{ action_expires_at: Date }>(
      `select action_expires_at
         from funding_operation_steps
        where operation_id = $1`,
      [operationId],
    );
    const actionExpiresAt = deadline.rows[0]?.action_expires_at;
    assert.ok(actionExpiresAt);
    await pool.query(
      `
        update funding_reconciliation_jobs
        set due_at = $2,
            status = 'scheduled',
            lease_owner = null,
            lease_token = null,
            lease_until = null
        where operation_id = $1
      `,
      [operationId, actionExpiresAt],
    );

    const externalPolls: string[] = [];
    const result = await runFundingReconciliationBatch(pool, {
      workerId: opaque("expired-action-wait-worker"),
      limit: 1,
      now: actionExpiresAt,
      receiptPoll: async () => {
        externalPolls.push("receipt");
        return { receiptsPolled: 0 };
      },
      postconditionPoll: async () => {
        externalPolls.push("postcondition");
        return { postconditionsPolled: 0 };
      },
      destinationPoll: async () => {
        externalPolls.push("destination");
        return { destinationsPolled: 0, destinationSatisfied: false };
      },
      providerPoll: async () => {
        externalPolls.push("provider");
        return { requestsPolled: 0 };
      },
    });
    assert.deepEqual(
      {
        claimed: result.claimed,
        completed: result.completed,
        externalPolls,
      },
      { claimed: 1, completed: 1, externalPolls: [] },
    );
    const expired = await pool.query<{
      completed_at: Date | null;
      expires_at: Date;
      job_status: string;
      reservation_state: string;
      status: string;
      step_state: string;
      terminal_reason: string | null;
    }>(
      `
        select
          operation.status,
          operation.completed_at,
          operation.expires_at,
          operation.support_metadata ->> 'terminalReason'
            as terminal_reason,
          step.state as step_state,
          reservation.state as reservation_state,
          job.status as job_status
        from funding_operations operation
        join funding_operation_steps step
          on step.operation_id = operation.id
        join balance_reservations reservation
          on reservation.operation_id = operation.id
        join funding_reconciliation_jobs job
          on job.operation_id = operation.id
        where operation.id = $1
      `,
      [operationId],
    );
    assert.deepEqual(expired.rows[0], {
      status: "cancelled",
      completed_at: actionExpiresAt,
      expires_at: committed.operation.expiresAt,
      terminal_reason: "unbroadcast_action_expired",
      step_state: "cancelled",
      reservation_state: "released",
      job_status: "completed",
    });
  } finally {
    await cleanupCommittedOperation(operationId, quote.id, userId);
  }
}

async function testConcurrentSourceReservationExclusion(): Promise<void> {
  const userId = await insertUser(pool);
  const sourceComponentId = opaque("shared-component");
  const sourceLocationId = opaque("shared-source-location");
  const planA = buildPlan({ sourceComponentId, sourceLocationId });
  const planB = buildPlan({ sourceComponentId, sourceLocationId });
  const consentA = opaque("consent");
  const consentB = opaque("consent");
  const quoteA = await createFundingQuote(
    pool,
    quoteInput(userId, planA, consentA),
  );
  const quoteB = await createFundingQuote(
    pool,
    quoteInput(userId, planB, consentB),
  );
  const operationIds: string[] = [];
  let cleanupFailure: unknown;
  try {
    const results = await Promise.allSettled([
      commitFundingOperation(
        pool,
        commitInput(userId, quoteA.id, consentA, planA),
      ),
      commitFundingOperation(
        pool,
        commitInput(userId, quoteB.id, consentB, planB),
      ),
    ]);
    const successes = results.filter(
      (
        result,
      ): result is PromiseFulfilledResult<
        Awaited<ReturnType<typeof commitFundingOperation>>
      > => result.status === "fulfilled",
    );
    const failures = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    assert.equal(successes.length, 1);
    assert.equal(failures.length, 1);
    const committed = successes[0]?.value;
    assert.ok(committed);
    operationIds.push(committed.operation.id);
    assert.ok(failures[0]?.reason instanceof FundingPersistenceError);
    assert.equal(failures[0]?.reason.code, "quote_invalidated");
  } finally {
    const cleanupClient = await pool.connect();
    try {
      await cleanupClient.query("begin");
      for (const operationId of operationIds) {
        await cleanupClient.query(
          "delete from funding_reconciliation_jobs where operation_id = $1",
          [operationId],
        );
        await cleanupClient.query(
          "delete from balance_reservations where operation_id = $1",
          [operationId],
        );
        await cleanupClient.query(
          "delete from funding_operation_steps where operation_id = $1",
          [operationId],
        );
        await cleanupClient.query(
          `
            delete from funding_provider_requests
            where segment_id in (
              select id
              from funding_operation_segments
              where operation_id = $1
            )
          `,
          [operationId],
        );
        await cleanupClient.query(
          "delete from funding_operation_segments where operation_id = $1",
          [operationId],
        );
        await cleanupClient.query(
          "delete from funding_operations where id = $1",
          [operationId],
        );
      }
      await cleanupClient.query(
        "delete from funding_quotes where id = any($1::uuid[])",
        [[quoteA.id, quoteB.id]],
      );
      await cleanupClient.query("delete from users where id = $1", [userId]);
      await cleanupClient.query("commit");
    } catch (error) {
      await cleanupClient.query("rollback");
      cleanupFailure = error;
    } finally {
      cleanupClient.release();
    }
  }
  if (cleanupFailure) {
    throw cleanupFailure;
  }
}

async function readMergeUser(userId: string): Promise<MergeUserRow> {
  const { rows } = await pool.query<MergeUserRow>(
    `
      select
        id,
        email,
        username,
        display_name,
        avatar_url,
        privy_user_id,
        referral_code,
        is_admin,
        kalshi_proof_bypass,
        last_login_at
      from users
      where id = $1
    `,
    [userId],
  );
  const row = rows[0];
  assert.ok(row);
  return row;
}

async function testDirectIngressWithDeferredPreparationCommit(): Promise<void> {
  const userId = await insertUser(pool);
  const destinationLocationId = opaque("destination-location");
  const venueBindingOptionId = opaque("venue-binding-option");
  const plan: FundingCommitPlan = {
    operation: {
      purpose: "add_funds",
      initialState: {
        status: "awaiting_external_funds",
        stage: "source_action",
      },
      experienceMode: "prepare_first",
      planKind: "direct_external_handoff",
      sourceSnapshot: {
        kind: "external_ingress",
        ingressKind: "manual",
      },
      destinationTargetSnapshot: {
        kind: "owned_location",
        locationId: destinationLocationId,
      },
      externalRecipientId: null,
      venueId: "polymarket",
      marketId: null,
      marketContextSnapshot: null,
      venueBindingSnapshot: {
        venueId: "polymarket",
        venueBindingOptionId,
      },
      walletExecutionSnapshot: {
        profileId: opaque("wallet-profile"),
      },
      placementSnapshot: {},
      requestedSourceAmount: money("1000000"),
      requestedDestinationAmount: money("1000000"),
      supportMetadata: {
        preparationKind: "polymarket_funding_router",
        venueBindingOptionId,
      },
    },
    segments: [],
    steps: [
      {
        ordinal: 0,
        segmentOrdinal: null,
        stepKind: "venue_preparation",
        state: "planned",
        actionFingerprint: hash("d"),
        executorId: "wallet_profile_evm_v1",
        payerRequirement: "privy_sponsor",
        dependsOnOrdinal: null,
        normalizedAction: {
          kind: "polymarket_funding_router",
        },
        actionValidationResult: {
          valid: true,
          activation: "after_verified_ingress",
        },
      },
    ],
    reservations: [
      {
        segmentOrdinal: null,
        componentId: opaque("direct-pusd"),
        locationId: destinationLocationId,
        networkId: ASSET.networkId,
        assetId: ASSET.assetId,
        assetDecimals: ASSET.decimals,
        rawAmount: "1000000",
        mode: "advisory_destination",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      {
        segmentOrdinal: null,
        componentId: opaque("direct-usdce"),
        locationId: destinationLocationId,
        networkId: ASSET.networkId,
        assetId: "erc20:0x0000000000000000000000000000000000000002",
        assetDecimals: ASSET.decimals,
        rawAmount: "1000000",
        mode: "advisory_destination",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    ],
  };
  const consentToken = opaque("consent");
  const quote = await createFundingQuote(
    pool,
    quoteInput(userId, plan, consentToken),
  );
  let operationId: string | null = null;
  try {
    const committed = await commitFundingOperation(
      pool,
      commitInput(userId, quote.id, consentToken, plan),
    );
    operationId = committed.operation.id;
    assert.equal(committed.operation.planKind, "direct_external_handoff");
    const shape = await pool.query<{
      reservation_count: string;
      step_count: string;
    }>(
      `
        select
          (
            select count(*)::text
            from funding_operation_steps
            where operation_id = $1
          ) as step_count,
          (
            select count(*)::text
            from balance_reservations
            where operation_id = $1
          ) as reservation_count
      `,
      [operationId],
    );
    assert.deepEqual(shape.rows[0], {
      reservation_count: "2",
      step_count: "1",
    });
  } finally {
    await cleanupCommittedOperation(operationId, quote.id, userId);
  }
}

async function testCompositePreparationAndRelayCommit(): Promise<void> {
  const userId = await insertUser(pool);
  const relaySource = {
    componentId: opaque("relay-component"),
    locationId: opaque("relay-source-location"),
    networkId: ASSET.networkId,
    assetId: ASSET.assetId,
  };
  const preparationSource = {
    componentId: opaque("preparation-component"),
    locationId: opaque("preparation-source-location"),
  };
  const destinationTarget = {
    componentId: opaque("destination-component"),
    locationId: opaque("destination-location"),
    preparation: "polymarket_funding_router",
    networkId: ASSET.networkId,
    assetId: ASSET.assetId,
  };
  const venueBindingOptionId = opaque("venue-binding-option");
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const plan: FundingCommitPlan = {
    operation: {
      purpose: "trade_shortfall",
      initialState: { status: "in_progress", stage: "committed" },
      experienceMode: "prepare_first",
      planKind: "composite_route",
      sourceSnapshot: { kind: "composite", legCount: 2 },
      destinationTargetSnapshot: destinationTarget,
      externalRecipientId: null,
      venueId: "polymarket",
      marketId: null,
      marketContextSnapshot: null,
      venueBindingSnapshot: { venueId: "polymarket", venueBindingOptionId },
      walletExecutionSnapshot: {},
      placementSnapshot: {},
      requestedSourceAmount: null,
      requestedDestinationAmount: money("4227649"),
      supportMetadata: {
        containsVenuePreparation: true,
        venuePreparationMinimumDestination: money("3569075"),
        preparationKind: "polymarket_funding_router",
        venueBindingOptionId,
        fundingPlan: {
          totalAmountRaw: "3569075",
        },
      },
    },
    segments: [
      {
        providerId: "relay",
        adapterId: "relay_quote_v2",
        adapterVersion: 1,
        segmentKind: "same_network_swap",
        status: "planned",
        sourceSnapshot: relaySource,
        destinationTargetSnapshot: destinationTarget,
        quotedInput: money("670000"),
        quotedExpectedOutput: money("660000"),
        quotedMinOutput: money("658574"),
        providerQuoteRefCiphertext: "ciphertext:composite-request",
        providerQuoteRefLookupHmac: hash("e"),
        depositAddressCiphertext: null,
        depositAddressLookupHmac: null,
        lookupKeyVersion: 1,
        refundLocationSnapshot: relaySource,
        quoteExpiresAt: expiresAt,
      },
    ],
    steps: [
      {
        ordinal: 0,
        segmentOrdinal: null,
        stepKind: "venue_preparation",
        state: "action_required",
        actionFingerprint: hash("f"),
        executorId: "wallet_profile_evm_v1",
        payerRequirement: "privy_sponsor",
        dependsOnOrdinal: null,
        normalizedAction: { kind: "polymarket_funding_router" },
        actionValidationResult: { valid: true },
      },
      {
        ordinal: 1,
        segmentOrdinal: 0,
        stepKind: "transaction",
        state: "action_required",
        actionFingerprint: hash("1"),
        executorId: "wallet_profile_evm_v1",
        payerRequirement: "privy_sponsor",
        dependsOnOrdinal: null,
        normalizedAction: { kind: "relay_transaction" },
        actionValidationResult: { valid: true },
      },
    ],
    reservations: [
      {
        segmentOrdinal: null,
        componentId: preparationSource.componentId,
        locationId: preparationSource.locationId,
        networkId: ASSET.networkId,
        assetId: ASSET.assetId,
        assetDecimals: ASSET.decimals,
        rawAmount: "3569075",
        mode: "subtract_available",
        expiresAt,
      },
      {
        segmentOrdinal: 0,
        componentId: relaySource.componentId,
        locationId: relaySource.locationId,
        networkId: ASSET.networkId,
        assetId: ASSET.assetId,
        assetDecimals: ASSET.decimals,
        rawAmount: "670000",
        mode: "subtract_available",
        expiresAt,
      },
    ],
  };
  const consentToken = opaque("consent");
  const quote = await createFundingQuote(
    pool,
    quoteInput(userId, plan, consentToken),
  );
  let operationId: string | null = null;
  try {
    const committed = await commitFundingOperation(
      pool,
      commitInput(userId, quote.id, consentToken, plan),
    );
    operationId = committed.operation.id;
    const shape = await pool.query<{
      bound_reservations: string;
      segment_count: string;
      unbound_reservations: string;
      unbound_steps: string;
    }>(
      `
        select
          (
            select count(*)::text
            from funding_operation_segments
            where operation_id = $1
          ) as segment_count,
          (
            select count(*)::text
            from funding_operation_steps
            where operation_id = $1 and segment_id is null
          ) as unbound_steps,
          (
            select count(*)::text
            from balance_reservations
            where operation_id = $1 and segment_id is null
          ) as unbound_reservations,
          (
            select count(*)::text
            from balance_reservations
            where operation_id = $1 and segment_id is not null
          ) as bound_reservations
      `,
      [operationId],
    );
    assert.deepEqual(shape.rows[0], {
      bound_reservations: "1",
      segment_count: "1",
      unbound_reservations: "1",
      unbound_steps: "1",
    });

    const replayClient = await pool.connect();
    await replayClient.query("begin");
    try {
      const preparationStep = await replayClient.query<{ id: string }>(
        `
          select id
          from funding_operation_steps
          where operation_id = $1
            and step_kind = 'venue_preparation'
        `,
        [operationId],
      );
      const preparationStepId = preparationStep.rows[0]?.id;
      assert.ok(preparationStepId);
      const preparationAttempt = await startFundingStepAttemptInTransaction(
        replayClient,
        {
          operationId,
          stepId: preparationStepId,
          canonicalActionFingerprint: hash("f"),
          executorId: "wallet_profile_evm_v1",
        },
      );
      await finishFundingStepAttemptInTransaction(replayClient, {
        attemptId: preparationAttempt.id,
        outcome: "submitted",
        broadcastMayHaveOccurred: true,
        referenceKind: "transaction",
        receiptRefCiphertext: "ciphertext:preparation-transaction",
        receiptRefLookupHmac: hash("2"),
        lookupKeyVersion: 1,
        actualCosts: {},
      });
      await replayClient.query(
        `
          update funding_operation_steps
          set state = 'submitted'
          where operation_id = $1
            and id = $2
            and state = 'action_required'
        `,
        [operationId, preparationStepId],
      );
      const finalizedPreparationReceipt = {
        status: "finalized",
        actionMatch: true,
        ledgerHeight: "100",
        blockHash: hash("3"),
        canonical: true,
        failureCode: null,
        evidence: {},
      } as const;
      await applyFundingStepReceiptEvidenceInTransaction(replayClient, {
        operationId,
        stepId: preparationStepId,
        attemptId: preparationAttempt.id,
        networkId: ASSET.networkId,
        receipt: finalizedPreparationReceipt,
      });
      await replayClient.query(
        `
          update funding_operation_steps
          set state = 'succeeded'
          where operation_id = $1
            and id = $2
            and state = 'submitted'
        `,
        [operationId, preparationStepId],
      );

      await applyFundingStepReceiptEvidenceInTransaction(replayClient, {
        operationId,
        stepId: preparationStepId,
        attemptId: preparationAttempt.id,
        networkId: ASSET.networkId,
        receipt: finalizedPreparationReceipt,
      });
      const replayedPreparationStep = await replayClient.query<{
        state: string;
      }>(
        `
          select state
          from funding_operation_steps
          where operation_id = $1
            and id = $2
        `,
        [operationId, preparationStepId],
      );
      assert.equal(replayedPreparationStep.rows[0]?.state, "succeeded");
    } finally {
      await replayClient.query("rollback");
      replayClient.release();
    }
  } finally {
    await cleanupCommittedOperation(operationId, quote.id, userId);
  }
}

async function testTerminalFundingMergeLifecycle(): Promise<void> {
  const sourceId = await insertUser(pool);
  const targetId = await insertUser(pool);
  const plan = buildPlan({
    planKind: "already_available",
    includeStep: false,
  });
  const consentToken = opaque("consent");
  const quote = await createFundingQuote(
    pool,
    quoteInput(sourceId, plan, consentToken),
  );
  const committed = await commitFundingOperation(
    pool,
    commitInput(sourceId, quote.id, consentToken, plan),
  );
  const destination = await registerFundingWithdrawalDestination(pool, {
    userId: sourceId,
    networkId: ASSET.networkId,
    assetId: ASSET.assetId,
    assetDecimals: ASSET.decimals,
    addressCiphertext: "ciphertext:merge-destination",
    addressLookupHmac: hash("9"),
    lookupKeyVersion: 1,
    validationEvidence: { owned: true },
    policyVersion: 1,
    expiresAt: new Date(Date.now() + 60_000),
  });
  const routeObservationId = await startFundingRouteObservationInTransaction(
    pool,
    {
      userId: sourceId,
      operationId: committed.operation.id,
      routeKeyHmac: hash("8"),
      routeKeyVersion: 1,
      providerId: "synthetic",
      adapterVersion: 1,
      amountBand: "merge-test",
      policyRevision: "wp3-test",
    },
  );
  try {
    await assert.rejects(
      mergeUsers(
        await readMergeUser(sourceId),
        await readMergeUser(targetId),
        { dryRun: false, keepSource: false },
        pool,
      ),
      (error: unknown) => {
        assert.ok(error instanceof FundingMergeConflictError);
        assert.equal(error.conflicts.activeFundingRoutes, 1);
        return true;
      },
    );
    await finishFundingRouteObservationInTransaction(pool, {
      userId: sourceId,
      routeObservationId,
      outcome: "succeeded",
      latencyStages: { totalMs: 1 },
      refundObserved: false,
      recoveryRequired: false,
    });
    const result = await mergeUsers(
      await readMergeUser(sourceId),
      await readMergeUser(targetId),
      { dryRun: false, keepSource: false },
      pool,
    );
    assert.equal(result.summary.fundingOperationsMoved, 1);
    assert.equal(result.summary.fundingQuotesMoved, 1);
    assert.equal(result.summary.fundingDestinationsRevoked, 1);
    assert.equal(result.summary.fundingDestinationsMoved, 1);
    assert.equal(result.summary.fundingRouteObservationsMoved, 1);
    assert.equal(result.summary.sourceUserDeleted, 1);

    const operation = await pool.query<{
      support_metadata: Record<string, unknown>;
      user_id: string;
    }>(
      `
        select user_id, support_metadata
        from funding_operations
        where id = $1
      `,
      [committed.operation.id],
    );
    assert.equal(operation.rows[0]?.user_id, targetId);
    assert.ok(operation.rows[0]?.support_metadata.userMergeAudit);
    const movedQuote = await pool.query<{ user_id: string }>(
      "select user_id from funding_quotes where id = $1",
      [quote.id],
    );
    assert.equal(movedQuote.rows[0]?.user_id, targetId);
    const movedDestination = await pool.query<{
      revoked_at: Date | null;
      user_id: string;
    }>(
      `
        select user_id, revoked_at
        from funding_withdrawal_destinations
        where id = $1
      `,
      [destination.destination.id],
    );
    assert.equal(movedDestination.rows[0]?.user_id, targetId);
    assert.ok(movedDestination.rows[0]?.revoked_at);
    const movedRoute = await pool.query<{ user_id: string }>(
      "select user_id from funding_route_observations where id = $1",
      [routeObservationId],
    );
    assert.equal(movedRoute.rows[0]?.user_id, targetId);
  } finally {
    await pool.query("delete from funding_route_observations where id = $1", [
      routeObservationId,
    ]);
    await pool.query(
      "delete from funding_withdrawal_destinations where id = $1",
      [destination.destination.id],
    );
    await cleanupCommittedOperation(committed.operation.id, quote.id, targetId);
    await pool.query("delete from users where id = $1", [sourceId]);
  }
}

async function testTransactionalPersistenceContracts(): Promise<void> {
  const client = await pool.connect();
  await client.query("begin");
  try {
    const userA = await insertUser(client);
    const userB = await insertUser(client);
    const eventId = opaque("event");
    const venueMarketId = opaque("market");
    const marketId = `polymarket:${venueMarketId}`;
    await client.query(
      `
        insert into unified_events (
          id,
          venue,
          venue_event_id,
          title,
          status,
          end_date
        )
        values ($1, 'polymarket', $2, 'WP6 reservation event', 'ACTIVE', now() + interval '1 day')
      `,
      [eventId, opaque("venue-event")],
    );
    await client.query(
      `
        insert into unified_markets (
          id,
          venue,
          venue_market_id,
          event_id,
          title,
          status,
          market_type
        )
        values ($1, 'polymarket', $2, $3, 'WP6 reservation market', 'ACTIVE', 'binary')
      `,
      [marketId, venueMarketId, eventId],
    );
    const userBPrivyId = `did:privy:wp3-${crypto.randomUUID()}`;
    await client.query("update users set privy_user_id = $2 where id = $1", [
      userB,
      userBPrivyId,
    ]);
    const planA = buildPlan();
    const tokenA = opaque("consent");
    const quoteA = await createFundingQuoteInTransaction(
      client,
      quoteInput(userA, planA, tokenA),
    );
    const inputA = commitInput(userA, quoteA.id, tokenA, planA);
    const committedA = await commitFundingOperationInTransaction(
      client,
      inputA,
    );
    assert.equal(committedA.replayed, false);
    await client.query("set constraints all immediate");
    await client.query("set constraints all deferred");

    const replayA = await commitFundingOperationInTransaction(client, inputA);
    assert.equal(replayA.replayed, true);
    assert.equal(replayA.operation.id, committedA.operation.id);
    await expectFundingError(
      commitFundingOperationInTransaction(client, {
        ...inputA,
        plan: {
          ...planA,
          operation: {
            ...planA.operation,
            placementSnapshot: { changed: true },
          },
        },
      }),
      "idempotency_conflict",
    );
    await expectFundingError(
      commitFundingOperationInTransaction(client, {
        ...inputA,
        userId: userB,
        idempotencyKey: opaque("other-user"),
      }),
      "quote_not_found",
    );
    assert.equal(
      await fetchFundingOperationForUser(client as never, {
        userId: userB,
        operationId: committedA.operation.id,
      }),
      null,
    );

    const planB = buildPlan({
      purpose: "trade_shortfall",
      venueId: "polymarket",
      marketId,
      marketSide: "NO",
      requestedCollateralRaw: "1000000",
    });
    const tokenB = opaque("consent");
    const quoteB = await createFundingQuoteInTransaction(
      client,
      quoteInput(userB, planB, tokenB),
    );
    const committedB = await commitFundingOperationInTransaction(
      client,
      commitInput(userB, quoteB.id, tokenB, planB),
    );
    await client.query("set constraints all immediate");
    await client.query("set constraints all deferred");

    const refundPlan = buildPlan();
    const refundToken = opaque("consent");
    const refundQuote = await createFundingQuoteInTransaction(
      client,
      quoteInput(userA, refundPlan, refundToken),
    );
    const refundOperation = await commitFundingOperationInTransaction(
      client,
      commitInput(userA, refundQuote.id, refundToken, refundPlan),
    );
    await client.query("set constraints all immediate");
    await client.query("set constraints all deferred");

    const destinationNow = new Date();
    const destinationInput = {
      userId: userA,
      networkId: ASSET.networkId,
      assetId: ASSET.assetId,
      assetDecimals: ASSET.decimals,
      addressCiphertext: "ciphertext:destination",
      addressLookupHmac: hash("d"),
      lookupKeyVersion: 1,
      validationEvidence: { owned: true },
      policyVersion: 1,
      expiresAt: new Date(destinationNow.getTime() + 60_000),
      now: destinationNow,
    };
    const destination = await registerFundingWithdrawalDestinationInTransaction(
      client,
      destinationInput,
    );
    assert.equal(destination.replayed, false);
    const destinationReplay =
      await registerFundingWithdrawalDestinationInTransaction(client, {
        ...destinationInput,
        addressCiphertext: "ciphertext:randomized-replay",
        validationEvidence: { owned: true, refreshed: true },
        expiresAt: new Date(destinationNow.getTime() + 120_000),
        now: new Date(destinationNow.getTime() + 10_000),
      });
    assert.equal(destinationReplay.replayed, true);
    assert.equal(destinationReplay.destination.id, destination.destination.id);
    assert.equal(
      destinationReplay.destination.addressCiphertext,
      "ciphertext:destination",
    );

    const renewedDestination =
      await registerFundingWithdrawalDestinationInTransaction(client, {
        ...destinationInput,
        addressCiphertext: "ciphertext:renewed-destination",
        validationEvidence: { owned: true, renewed: true },
        expiresAt: new Date(destinationNow.getTime() + 180_000),
        now: new Date(destinationNow.getTime() + 61_000),
      });
    assert.equal(renewedDestination.replayed, false);
    assert.notEqual(
      renewedDestination.destination.id,
      destination.destination.id,
    );
    const supersededDestination =
      await fetchFundingWithdrawalDestinationForUser(client as never, {
        userId: userA,
        destinationId: destination.destination.id,
      });
    assert.equal(supersededDestination?.addressCiphertext, null);
    assert.equal(supersededDestination?.revocationReason, "revalidated");
    assert.equal(
      await fetchFundingWithdrawalDestinationForUser(client as never, {
        userId: userB,
        destinationId: renewedDestination.destination.id,
      }),
      null,
    );
    await expectFundingError(
      revokeFundingWithdrawalDestinationInTransaction(client, {
        userId: userB,
        destinationId: renewedDestination.destination.id,
        reason: "idor-test",
        cryptoShred: true,
      }),
      "operation_not_found",
    );
    const revoked = await revokeFundingWithdrawalDestinationInTransaction(
      client,
      {
        userId: userA,
        destinationId: renewedDestination.destination.id,
        reason: "test_complete",
        cryptoShred: true,
      },
    );
    assert.equal(revoked.addressCiphertext, null);
    assert.equal(revoked.addressLookupHmac, hash("d"));
    await client.query("savepoint destination_ciphertext_restore");
    await assert.rejects(
      client.query(
        `
          update funding_withdrawal_destinations
          set address_ciphertext = 'ciphertext:restored'
          where id = $1
        `,
        [renewedDestination.destination.id],
      ),
    );
    await client.query("rollback to savepoint destination_ciphertext_restore");

    const stepResult = await client.query<{ id: string }>(
      `
        select id
        from funding_operation_steps
        where operation_id = $1 and ordinal = 0
      `,
      [committedA.operation.id],
    );
    const stepId = stepResult.rows[0]?.id;
    assert.ok(stepId);
    const attempt = await startFundingStepAttemptInTransaction(client, {
      operationId: committedA.operation.id,
      stepId,
      canonicalActionFingerprint: hash("b"),
      executorId: "synthetic-executor",
    });
    await expectFundingError(
      startFundingStepAttemptInTransaction(client, {
        operationId: committedA.operation.id,
        stepId,
        canonicalActionFingerprint: hash("b"),
        executorId: "synthetic-executor",
      }),
      "invalid_state_transition",
    );
    const ambiguous = await finishFundingStepAttemptInTransaction(client, {
      attemptId: attempt.id,
      outcome: "ambiguous",
      broadcastMayHaveOccurred: true,
      referenceKind: "transaction",
      receiptRefCiphertext: "ciphertext:tx",
      receiptRefLookupHmac: hash("e"),
      lookupKeyVersion: 1,
      actualCosts: { gasRaw: "100" },
    });
    assert.equal(ambiguous.broadcastMayHaveOccurred, true);
    await expectFundingError(
      startFundingStepAttemptInTransaction(client, {
        operationId: committedA.operation.id,
        stepId,
        canonicalActionFingerprint: hash("b"),
        executorId: "synthetic-executor",
      }),
      "invalid_state_transition",
    );

    const succeededStepResult = await client.query<{ id: string }>(
      `
        select id
        from funding_operation_steps
        where operation_id = $1 and ordinal = 0
      `,
      [committedB.operation.id],
    );
    const succeededStepId = succeededStepResult.rows[0]?.id;
    assert.ok(succeededStepId);
    const succeededAttempt = await startFundingStepAttemptInTransaction(
      client,
      {
        operationId: committedB.operation.id,
        stepId: succeededStepId,
        canonicalActionFingerprint: hash("b"),
        executorId: "synthetic-executor",
      },
    );
    await expectFundingError(
      finishFundingStepAttemptInTransaction(client, {
        attemptId: succeededAttempt.id,
        outcome: "succeeded",
        broadcastMayHaveOccurred: true,
        referenceKind: "transaction",
        receiptRefCiphertext: "ciphertext:succeeded-tx",
        receiptRefLookupHmac: hash("1"),
        lookupKeyVersion: 1,
        actualCosts: { gasRaw: "50" },
      }),
      "invalid_state_transition",
    );
    await client.query("savepoint attempt_broadcast_shape");
    await assert.rejects(
      client.query(
        `
          update funding_operation_step_attempts
          set outcome = 'succeeded',
              broadcast_may_have_occurred = true,
              reference_kind = 'transaction',
              receipt_ref_ciphertext = 'ciphertext:succeeded-tx',
              receipt_ref_lookup_hmac = $2,
              lookup_key_version = 1,
              actual_costs = '{"gasRaw":"50"}'::jsonb,
              finished_at = now()
          where id = $1
        `,
        [succeededAttempt.id, hash("1")],
      ),
    );
    await client.query("rollback to savepoint attempt_broadcast_shape");
    await finishFundingStepAttemptInTransaction(client, {
      attemptId: succeededAttempt.id,
      outcome: "succeeded",
      broadcastMayHaveOccurred: false,
      referenceKind: "transaction",
      receiptRefCiphertext: "ciphertext:succeeded-tx",
      receiptRefLookupHmac: hash("1"),
      lookupKeyVersion: 1,
      actualCosts: { gasRaw: "50" },
    });
    await expectFundingError(
      startFundingStepAttemptInTransaction(client, {
        operationId: committedB.operation.id,
        stepId: succeededStepId,
        canonicalActionFingerprint: hash("b"),
        executorId: "synthetic-executor",
      }),
      "invalid_state_transition",
    );
    await client.query(
      `
        update funding_operation_step_attempts
        set receipt_ref_ciphertext = null
        where id = $1
      `,
      [succeededAttempt.id],
    );
    await client.query("savepoint attempt_ciphertext_restore");
    await assert.rejects(
      client.query(
        `
          update funding_operation_step_attempts
          set receipt_ref_ciphertext = 'ciphertext:restored'
          where id = $1
        `,
        [succeededAttempt.id],
      ),
    );
    await client.query("rollback to savepoint attempt_ciphertext_restore");

    const segmentResult = await client.query<{ id: string }>(
      `
        select id
        from funding_operation_segments
        where operation_id = $1
      `,
      [committedA.operation.id],
    );
    const segmentId = segmentResult.rows[0]?.id;
    assert.ok(segmentId);
    const providerRequest = await upsertFundingProviderRequestInTransaction(
      client,
      {
        operationId: committedA.operation.id,
        segmentId,
        requestKind: "initial",
        requestRefCiphertext: "ciphertext:provider-request",
        requestRefLookupHmac: hash("f"),
        rawStatus: "created",
        discoverySource: "synthetic-test",
        lookupKeyVersion: 1,
      },
    );
    assert.equal(providerRequest.replayed, false);
    const providerReplay = await upsertFundingProviderRequestInTransaction(
      client,
      {
        operationId: committedA.operation.id,
        segmentId,
        requestKind: "initial",
        requestRefCiphertext: "ciphertext:provider-request",
        requestRefLookupHmac: hash("f"),
        rawStatus: "pending",
        discoverySource: "synthetic-test",
        lookupKeyVersion: 1,
      },
    );
    assert.equal(providerReplay.id, providerRequest.id);
    assert.equal(providerReplay.replayed, true);
    await expectFundingError(
      upsertFundingProviderRequestInTransaction(client, {
        operationId: committedA.operation.id,
        segmentId,
        requestKind: "initial",
        requestRefCiphertext: "ciphertext:different",
        requestRefLookupHmac: hash("f"),
        rawStatus: "pending",
        discoverySource: "synthetic-test",
        lookupKeyVersion: 1,
      }),
      "idempotency_conflict",
    );
    await client.query("savepoint provider_request_identity");
    await assert.rejects(
      client.query(
        `
          update funding_provider_requests
          set discovery_source = 'rewritten'
          where id = $1
        `,
        [providerRequest.id],
      ),
    );
    await client.query("rollback to savepoint provider_request_identity");

    const routeObservationId = await startFundingRouteObservationInTransaction(
      client,
      {
        userId: userA,
        operationId: committedA.operation.id,
        routeKeyHmac: hash("7"),
        routeKeyVersion: 1,
        providerId: "synthetic",
        adapterVersion: 1,
        amountBand: "test",
        policyRevision: "wp3-test",
      },
    );
    await client.query("savepoint route_observation_shape");
    await assert.rejects(
      client.query(
        `
          update funding_route_observations
          set outcome = 'succeeded'
          where id = $1
        `,
        [routeObservationId],
      ),
    );
    await client.query("rollback to savepoint route_observation_shape");
    await expectFundingError(
      finishFundingRouteObservationInTransaction(client, {
        userId: userB,
        routeObservationId,
        outcome: "succeeded",
        latencyStages: { totalMs: 10 },
        refundObserved: false,
        recoveryRequired: false,
      }),
      "invalid_state_transition",
    );
    await client.query("savepoint route_observation_identity");
    await assert.rejects(
      client.query(
        `
          update funding_route_observations
          set provider_id = 'rewritten'
          where id = $1
        `,
        [routeObservationId],
      ),
    );
    await client.query("rollback to savepoint route_observation_identity");
    await finishFundingRouteObservationInTransaction(client, {
      userId: userA,
      routeObservationId,
      outcome: "succeeded",
      latencyStages: { totalMs: 10 },
      refundObserved: false,
      recoveryRequired: false,
    });
    await expectFundingError(
      finishFundingRouteObservationInTransaction(client, {
        userId: userA,
        routeObservationId,
        outcome: "failed",
        latencyStages: { totalMs: 20 },
        refundObserved: false,
        recoveryRequired: false,
      }),
      "invalid_state_transition",
    );

    const sourceObservation = await ingestFundingObservationInTransaction(
      client,
      {
        discoverySource: "webhook",
        observation: {
          operationId: committedA.operation.id,
          segmentId,
          kind: "source_debit",
          networkId: ASSET.networkId,
          assetId: ASSET.assetId,
          assetDecimals: ASSET.decimals,
          txHash: opaque("source-tx"),
          eventIndex: "0",
          fromAddress: "0xsource",
          toAddress: "0xrouter",
          rawAmount: "1000000",
          observedAt: new Date(),
          ledgerHeight: "100",
          blockHash: opaque("block"),
          finalityStatus: "finalized",
          finalizedAt: new Date(),
        },
      },
    );
    assert.equal(sourceObservation.replayed, false);
    const sourceReplay = await ingestFundingObservationInTransaction(client, {
      discoverySource: "polling",
      observation: {
        operationId: committedA.operation.id,
        segmentId,
        kind: "source_debit",
        networkId: ASSET.networkId,
        assetId: ASSET.assetId,
        assetDecimals: ASSET.decimals,
        txHash: sourceObservation.observation.txHash,
        eventIndex: "0",
        fromAddress: "0xsource",
        toAddress: "0xrouter",
        rawAmount: "1000000",
        observedAt: sourceObservation.observation.observedAt,
        ledgerHeight: "100",
        blockHash: sourceObservation.observation.blockHash,
        finalityStatus: "finalized",
        finalizedAt: sourceObservation.observation.finalizedAt,
      },
    });
    assert.equal(sourceReplay.replayed, true);
    await client.query(
      `
        update funding_observations
        set metadata = metadata || '{"confirmations":12}'::jsonb
        where id = $1
      `,
      [sourceObservation.observation.id],
    );
    await client.query("savepoint observation_finalized_at");
    await assert.rejects(
      client.query(
        `
          update funding_observations
          set finalized_at = finalized_at + interval '1 second'
          where id = $1
        `,
        [sourceObservation.observation.id],
      ),
    );
    await client.query("rollback to savepoint observation_finalized_at");
    await client.query("savepoint observation_metadata");
    await assert.rejects(
      client.query(
        `
          update funding_observations
          set metadata = jsonb_set(
            metadata,
            '{discoverySource}',
            '"polling"'::jsonb
          )
          where id = $1
        `,
        [sourceObservation.observation.id],
      ),
    );
    await client.query("rollback to savepoint observation_metadata");
    await expectFundingError(
      allocateFundingObservationInTransaction(client, {
        operationId: committedB.operation.id,
        segmentId: null,
        kind: "source_debit",
        networkId: ASSET.networkId,
        assetId: ASSET.assetId,
        assetDecimals: ASSET.decimals,
        txHash: sourceObservation.observation.txHash,
        eventIndex: "0",
        fromAddress: "0xsource",
        toAddress: "0xrouter",
        rawAmount: "1000000",
        observedAt: new Date(),
        ledgerHeight: "100",
        blockHash: sourceObservation.observation.blockHash,
        finalityStatus: "finalized",
        finalizedAt: new Date(),
      }),
      "ambiguous_duplicate_observation",
    );
    await expectFundingError(
      allocateFundingObservationInTransaction(client, {
        operationId: committedA.operation.id,
        segmentId,
        kind: "source_debit",
        networkId: ASSET.networkId,
        assetId: ASSET.assetId,
        assetDecimals: 18,
        txHash: sourceObservation.observation.txHash,
        eventIndex: "0",
        fromAddress: "0xsource",
        toAddress: "0xrouter",
        rawAmount: "1000000",
        observedAt: new Date(),
        ledgerHeight: "100",
        blockHash: sourceObservation.observation.blockHash,
        finalityStatus: "finalized",
        finalizedAt: new Date(),
      }),
      "ambiguous_duplicate_observation",
    );
    await expectFundingError(
      allocateFundingObservationInTransaction(client, {
        operationId: committedA.operation.id,
        segmentId,
        kind: "source_debit",
        networkId: ASSET.networkId,
        assetId: "erc20:0x0000000000000000000000000000000000000002",
        assetDecimals: ASSET.decimals,
        txHash: sourceObservation.observation.txHash,
        eventIndex: "0",
        fromAddress: "0xsource",
        toAddress: "0xrouter",
        rawAmount: "1000000",
        observedAt: new Date(),
        ledgerHeight: "100",
        blockHash: sourceObservation.observation.blockHash,
        finalityStatus: "finalized",
        finalizedAt: new Date(),
      }),
      "ambiguous_duplicate_observation",
    );

    const factsBeforeReducer = await loadFundingAccountValueFacts(
      client as never,
      userA,
    );
    const availability = factsBeforeReducer.availability.find(
      (row) => row.componentId === planA.operation.sourceSnapshot?.componentId,
    );
    assert.equal(availability?.reservedRaw, "0");
    assert.equal(availability?.submittedDebitRaw, "1000000");
    assert.equal(factsBeforeReducer.inTransit.length, 1);

    const staleComponent: ValuedAssetComponent = {
      componentId: String(planA.operation.sourceSnapshot?.componentId),
      location: {
        kind: "wallet",
        locationId: String(planA.operation.sourceSnapshot?.locationId),
        accountId: userA,
        asset: ASSET,
        details: {},
      },
      amount: money("2000000"),
      category: "cash",
      estimatedUsd: {
        value: "2.000000",
        asOf: new Date().toISOString(),
        priceSource: "test",
        confidence: "high",
        policyId: "test",
      },
      observedAt: new Date(
        sourceObservation.observation.observedAt.getTime() - 1_000,
      ).toISOString(),
      observationFreshness: "fresh",
      observationError: null,
      valuationEligibility: "included",
      executionEligibility: "eligible",
      reasonCodes: [],
    };
    const suppressed = applyFundingSourceDebitSuppression(
      [staleComponent],
      factsBeforeReducer.inTransit,
    );
    assert.equal(suppressed[0]?.amount.raw, "1000000");
    assert.equal(suppressed[0]?.estimatedUsd?.value, "1");

    const sourceReduction = await reduceFundingOperationInTransaction(client, {
      operationId: committedA.operation.id,
    });
    assert.deepEqual(sourceReduction.finalState, {
      status: "in_progress",
      stage: "source_observed",
    });
    const operationAfterSource = await fetchFundingOperationForUser(
      client as never,
      {
        userId: userA,
        operationId: committedA.operation.id,
      },
    );
    assert.equal(operationAfterSource?.requestedSourceAmount?.raw, "1000000");
    assert.equal(operationAfterSource?.actualSourceAmount?.raw, "1000000");
    const segmentAfterSource = await client.query<{
      actual_input: { raw?: string } | null;
      status: string;
    }>(
      `
        select status, actual_input
        from funding_operation_segments
        where id = $1
      `,
      [segmentId],
    );
    assert.equal(segmentAfterSource.rows[0]?.status, "submitted");
    assert.equal(segmentAfterSource.rows[0]?.actual_input?.raw, "1000000");
    await expectFundingError(
      transitionFundingOperationInTransaction(client, {
        operationId: committedA.operation.id,
        scope: { kind: "worker" },
        expectedVersion: Number(operationAfterSource?.version),
        expectedState: {
          status: "in_progress",
          stage: "source_observed",
        },
        nextState: {
          status: "in_progress",
          stage: "source_observed",
        },
        actualSourceAmount: money("999999"),
      }),
      "actual_amount_conflict",
    );
    const reservationA = await client.query<{
      id: string;
      state: string;
    }>(
      `
        select id, state
        from balance_reservations
        where operation_id = $1 and mode = 'subtract_available'
      `,
      [committedA.operation.id],
    );
    assert.equal(reservationA.rows[0]?.state, "released");
    await expectFundingError(
      releaseFundingReservationInTransaction(client, {
        reservationId: String(reservationA.rows[0]?.id),
        outcomeReason: "duplicate_release",
      }),
      "invalid_state_transition",
    );

    await ingestFundingObservationInTransaction(client, {
      discoverySource: "chain_rpc",
      observation: {
        operationId: committedA.operation.id,
        segmentId,
        kind: "destination_credit",
        networkId: ASSET.networkId,
        assetId: ASSET.assetId,
        assetDecimals: ASSET.decimals,
        txHash: opaque("destination-tx"),
        eventIndex: "0",
        fromAddress: "0xrouter",
        toAddress: "0xdestination",
        rawAmount: "990000",
        observedAt: new Date(),
        ledgerHeight: "101",
        blockHash: opaque("block"),
        finalityStatus: "finalized",
        finalizedAt: new Date(),
      },
    });
    const completed = await reduceFundingOperationInTransaction(client, {
      operationId: committedA.operation.id,
    });
    assert.deepEqual(completed.finalState, {
      status: "completed",
      stage: "terminal",
    });
    const completedOperation = await fetchFundingOperationForUser(
      client as never,
      {
        userId: userA,
        operationId: committedA.operation.id,
      },
    );
    assert.ok(completedOperation?.completedAt);
    const terminalPatchedAt = new Date(
      completedOperation.completedAt.getTime() + 60_000,
    );
    const terminalMetadataPatch = await transitionFundingOperationInTransaction(
      client,
      {
        operationId: committedA.operation.id,
        scope: { kind: "worker" },
        expectedVersion: completedOperation.version,
        expectedState: {
          status: "completed",
          stage: "terminal",
        },
        nextState: {
          status: "completed",
          stage: "terminal",
        },
        supportMetadataPatch: {
          terminalReconciliationCheckedAt: terminalPatchedAt.toISOString(),
        },
        now: terminalPatchedAt,
      },
    );
    assert.equal(
      terminalMetadataPatch.completedAt?.toISOString(),
      completedOperation.completedAt.toISOString(),
    );
    const segmentAfterDestination = await client.query<{
      actual_output: { raw?: string } | null;
      status: string;
    }>(
      `
        select status, actual_output
        from funding_operation_segments
        where id = $1
      `,
      [segmentId],
    );
    assert.equal(segmentAfterDestination.rows[0]?.status, "succeeded");
    assert.equal(segmentAfterDestination.rows[0]?.actual_output?.raw, "990000");
    await client.query("savepoint segment_actual_output");
    await assert.rejects(
      client.query(
        `
          update funding_operation_segments
          set actual_output = jsonb_set(actual_output, '{raw}', '"1"'::jsonb)
          where id = $1
        `,
        [segmentId],
      ),
    );
    await client.query("rollback to savepoint segment_actual_output");
    await client.query(
      `
        update funding_operation_segments
        set provider_quote_ref_ciphertext = null
        where id = $1
      `,
      [segmentId],
    );
    await client.query("savepoint segment_ciphertext_restore");
    await assert.rejects(
      client.query(
        `
          update funding_operation_segments
          set provider_quote_ref_ciphertext = 'ciphertext:restored'
          where id = $1
        `,
        [segmentId],
      ),
    );
    await client.query("rollback to savepoint segment_ciphertext_restore");

    const syntheticReorgAt = new Date();
    await advanceFundingObservationFinalityInTransaction(client, {
      observationId: sourceObservation.observation.id,
      expectedFinality: "finalized",
      nextFinality: "reorged",
      reorgedAt: syntheticReorgAt,
      metadataPatch: { reason: "synthetic_reorg" },
    });
    await client.query("savepoint observation_reorged_at");
    await assert.rejects(
      client.query(
        `
          update funding_observations
          set reorged_at = reorged_at + interval '1 second'
          where id = $1
        `,
        [sourceObservation.observation.id],
      ),
    );
    await client.query("rollback to savepoint observation_reorged_at");
    const reorgResult = await reduceFundingOperationInTransaction(client, {
      operationId: committedA.operation.id,
    });
    assert.equal(reorgResult.reorgBlockedByTerminalState, true);
    assert.deepEqual(reorgResult.finalState, {
      status: "completed",
      stage: "terminal",
    });

    const refundSegment = await client.query<{ id: string }>(
      `
        select id
        from funding_operation_segments
        where operation_id = $1
      `,
      [refundOperation.operation.id],
    );
    await ingestFundingObservationInTransaction(client, {
      discoverySource: "polling",
      observation: {
        operationId: refundOperation.operation.id,
        segmentId: refundSegment.rows[0]?.id ?? null,
        kind: "refund_credit",
        networkId: ASSET.networkId,
        assetId: ASSET.assetId,
        assetDecimals: ASSET.decimals,
        txHash: opaque("refund-tx"),
        eventIndex: "0",
        fromAddress: "0xrouter",
        toAddress: "0xsource",
        rawAmount: "1000000",
        observedAt: new Date(),
        ledgerHeight: "102",
        blockHash: opaque("block"),
        finalityStatus: "finalized",
        finalizedAt: new Date(),
      },
    });
    const refunded = await reduceFundingOperationInTransaction(client, {
      operationId: refundOperation.operation.id,
    });
    assert.deepEqual(refunded.finalState, {
      status: "refunded",
      stage: "terminal",
    });
    assert.equal(refunded.terminal, true);
    const refundedSegment = await client.query<{ status: string }>(
      `
        select status
        from funding_operation_segments
        where operation_id = $1
      `,
      [refundOperation.operation.id],
    );
    assert.equal(refundedSegment.rows[0]?.status, "refunded");

    const segmentB = await client.query<{ id: string }>(
      `
        select id
        from funding_operation_segments
        where operation_id = $1
      `,
      [committedB.operation.id],
    );
    await ingestFundingObservationInTransaction(client, {
      discoverySource: "venue_api",
      observation: {
        operationId: committedB.operation.id,
        segmentId: segmentB.rows[0]?.id ?? null,
        kind: "destination_credit",
        networkId: ASSET.networkId,
        assetId: ASSET.assetId,
        assetDecimals: ASSET.decimals,
        txHash: opaque("trade-shortfall-destination"),
        eventIndex: "0",
        fromAddress: "0xrouter",
        toAddress: "0xvenue",
        rawAmount: "990000",
        observedAt: new Date(),
        ledgerHeight: "103",
        blockHash: opaque("block"),
        finalityStatus: "finalized",
        finalizedAt: new Date(),
      },
    });
    const readyForConsumer = await reduceFundingOperationInTransaction(client, {
      operationId: committedB.operation.id,
    });
    assert.deepEqual(readyForConsumer.finalState, {
      status: "ready",
      stage: "ready_for_consumer",
    });
    const readySegment = await client.query<{ status: string }>(
      `
        select status
        from funding_operation_segments
        where operation_id = $1
      `,
      [committedB.operation.id],
    );
    assert.equal(readySegment.rows[0]?.status, "succeeded");
    const reservationB = await client.query<{
      expires_at: Date;
      id: string;
      raw_amount: string;
    }>(
      `
        select id, raw_amount, expires_at
        from balance_reservations
        where operation_id = $1 and mode = 'settled_for_consumer'
      `,
      [committedB.operation.id],
    );
    const reservationBRow = reservationB.rows[0];
    assert.ok(reservationBRow);
    const reservationBId = reservationBRow.id;
    assert.equal(reservationBRow.raw_amount, "990000");
    const marketContextId = String(
      committedB.operation.supportMetadata.test
        ? planB.operation.marketContextSnapshot?.marketContextId
        : "",
    );
    const consumerIntent = buildFundingTradeConsumerIntent({
      venueId: "polymarket",
      marketId,
      marketContextId,
      spend: { asset: ASSET, raw: "1000000" },
    });
    assert.deepEqual(
      await assertFundingReservationReadyForTrade(client as never, {
        userId: userB,
        link: {
          operationId: committedB.operation.id,
          reservationId: reservationBId,
        },
        intent: consumerIntent,
      }),
      {
        rawAmount: "990000",
        expiresAt: reservationBRow.expires_at,
      },
    );
    await expectFundingError(
      assertFundingReservationReadyForTrade(client as never, {
        userId: userB,
        link: {
          operationId: committedB.operation.id,
          reservationId: reservationBId,
        },
        intent: buildFundingTradeConsumerIntent({
          venueId: "polymarket",
          marketId,
          marketContextId,
          spend: { asset: ASSET, raw: "990000" },
        }),
      }),
      "invalid_state_transition",
    );
    await expectFundingError(
      consumeFundingReservationForLinkedConsumerInTransaction(client, {
        userId: userB,
        reservationId: reservationBId,
        consumer: {
          kind: "execution",
          executionId: crypto.randomUUID(),
        },
        outcomeReason: "unlinked_consumer",
      }),
      "operation_not_found",
    );
    await client.query("savepoint wrong_trade_consumer_scope");
    const wrongConsumer = await client.query<{ id: string }>(
      `
        insert into executions (
          user_id,
          wallet_address,
          venue,
          unified_market_id,
          side,
          tx_signature,
          status,
          funding_operation_id,
          funding_reservation_id
        )
        values ($1, $2, 'limitless', $3, 'SELL', $4, 'confirmed', $5, $6)
        returning id
      `,
      [
        userB,
        "0x00000000000000000000000000000000000000b1",
        opaque("wrong-market"),
        opaque("wrong-consumer"),
        committedB.operation.id,
        reservationBId,
      ],
    );
    await expectFundingError(
      consumeFundingReservationForLinkedConsumerInTransaction(client, {
        userId: userB,
        reservationId: reservationBId,
        consumer: {
          kind: "execution",
          executionId: String(wrongConsumer.rows[0]?.id),
        },
        outcomeReason: "wrong_trade_scope",
      }),
      "operation_not_found",
    );
    await client.query("rollback to savepoint wrong_trade_consumer_scope");
    const tradeExecutionReference = opaque("trade-execution");
    const tradeClaimInput = {
      userId: userB,
      operationId: committedB.operation.id,
      reservationId: reservationBId,
      venueId: "polymarket",
      marketId,
      executionPath: "polymarket_clob",
      idempotencyKey: `polymarket-clob:${tradeExecutionReference}`,
      canonicalFingerprint: hash("t"),
      consumerIntent,
      externalReference: tradeExecutionReference,
    } as const;
    const tradeClaim = await claimFundingTradeAttemptInTransaction(
      client,
      tradeClaimInput,
    );
    assert.equal(tradeClaim.claimed, true);
    const replayedTradeClaim = await claimFundingTradeAttemptInTransaction(
      client,
      {
        ...tradeClaimInput,
        now: new Date(tradeClaim.attempt.claimedAt.getTime() + 1_000),
      },
    );
    assert.equal(replayedTradeClaim.claimed, false);
    assert.equal(replayedTradeClaim.attempt.id, tradeClaim.attempt.id);
    const reclaimedTradeClaim = await claimFundingTradeAttemptInTransaction(
      client,
      {
        ...tradeClaimInput,
        now: new Date(tradeClaim.attempt.claimLeaseUntil.getTime() + 1),
      },
    );
    assert.equal(reclaimedTradeClaim.claimed, true);
    assert.equal(reclaimedTradeClaim.reason, "reclaimed_before_submission");
    assert.notEqual(
      reclaimedTradeClaim.attempt.claimToken,
      tradeClaim.attempt.claimToken,
    );
    const startedTrade =
      await markFundingTradeAttemptSubmissionStartedInTransaction(client, {
        userId: userB,
        operationId: committedB.operation.id,
        reservationId: reservationBId,
        attemptId: tradeClaim.attempt.id,
        claimToken: reclaimedTradeClaim.attempt.claimToken,
      });
    assert.equal(startedTrade.state, "submission_started");
    await expectFundingError(
      releaseFundingReservationForAbandonedTradeInTransaction(client, {
        userId: userB,
        link: {
          operationId: committedB.operation.id,
          reservationId: reservationBId,
        },
        outcomeReason: "concurrent_cancel",
      }),
      "trade_submission_reconciling",
    );
    const fundingResolvedAfterExpiry = new Date(
      reservationBRow.expires_at.getTime() + 1_000,
    );
    const executionInput = {
      userId: userB,
      walletAddress: "0x00000000000000000000000000000000000000b1",
      venue: "polymarket",
      unifiedMarketId: marketId,
      side: "BUY",
      status: "confirmed",
      txSignature: tradeExecutionReference,
      fundingReservation: {
        operationId: committedB.operation.id,
        reservationId: reservationBId,
      },
      fundingTradeAttemptId: tradeClaim.attempt.id,
      fundingResolvedAt: fundingResolvedAfterExpiry,
    } as const;
    const execution = await storeExecutionInTransaction(client, executionInput);
    assert.equal(execution.funding_operation_id, committedB.operation.id);
    assert.equal(execution.funding_reservation_id, reservationBId);
    const replayedExecution = await storeExecutionInTransaction(
      client,
      executionInput,
    );
    assert.equal(replayedExecution.id, execution.id);
    const consumed = await client.query<{
      consumer_kind: string | null;
      consumer_ref: string | null;
      state: string;
    }>(
      `
        select state, consumer_kind, consumer_ref
        from balance_reservations
        where id = $1
      `,
      [reservationBId],
    );
    assert.equal(consumed.rows[0]?.state, "consumed");
    assert.equal(consumed.rows[0]?.consumer_kind, "execution");
    assert.equal(consumed.rows[0]?.consumer_ref, execution.id);
    const consumedOperation = await fetchFundingOperationForUser(
      client as never,
      {
        userId: userB,
        operationId: committedB.operation.id,
      },
    );
    assert.deepEqual(
      {
        stage: consumedOperation?.progressStage,
        status: consumedOperation?.status,
      },
      { stage: "terminal", status: "completed" },
    );

    await client.query(
      `
        update funding_reconciliation_jobs
        set due_at = now() + interval '1 day'
        where operation_id = any($1::uuid[])
      `,
      [[committedA.operation.id, refundOperation.operation.id]],
    );
    const leaseNow = new Date();
    const workerA = await claimFundingReconciliationJobsInTransaction(client, {
      leaseOwner: "worker-a",
      limit: 10,
      leaseSeconds: 5,
      now: leaseNow,
    });
    assert.equal(
      workerA.length,
      1,
      "funding persistence lease contract requires an exclusive migrated test database with no finance worker",
    );
    assert.equal(workerA[0]?.operationId, committedB.operation.id);
    const blockedWorker = await claimFundingReconciliationJobsInTransaction(
      client,
      {
        leaseOwner: "worker-b",
        limit: 10,
        leaseSeconds: 5,
        now: leaseNow,
      },
    );
    assert.equal(blockedWorker.length, 0);

    await wakeFundingReconciliationInTransaction(client, {
      operationId: committedB.operation.id,
      dueAt: leaseNow,
      priority: 10,
    });
    const leaseAfterDuplicateWake = await client.query<{
      count: string;
      lease_token: string | null;
      status: string;
    }>(
      `
        select
          count(*)::text as count,
          min(lease_token::text) as lease_token,
          min(status) as status
        from funding_reconciliation_jobs
        where operation_id = $1
      `,
      [committedB.operation.id],
    );
    assert.equal(leaseAfterDuplicateWake.rows[0]?.count, "1");
    assert.equal(leaseAfterDuplicateWake.rows[0]?.status, "leased");
    assert.equal(
      leaseAfterDuplicateWake.rows[0]?.lease_token,
      workerA[0]?.leaseToken,
    );

    const renewedWorkerA = await renewFundingReconciliationLease(
      client as never,
      {
        jobId: String(workerA[0]?.jobId),
        leaseOwner: "worker-a",
        leaseToken: String(workerA[0]?.leaseToken),
        leaseSeconds: 5,
        now: new Date(leaseNow.getTime() + 1_000),
      },
    );
    assert.ok(
      renewedWorkerA.leaseUntil.getTime() >
        Number(workerA[0]?.leaseUntil.getTime()),
    );
    const stillBlockedAfterOriginalExpiry =
      await claimFundingReconciliationJobsInTransaction(client, {
        leaseOwner: "worker-b",
        limit: 10,
        leaseSeconds: 5,
        now: new Date(
          (workerA[0]?.leaseUntil.getTime() ?? leaseNow.getTime()) + 1,
        ),
      });
    assert.equal(stillBlockedAfterOriginalExpiry.length, 0);

    const workerB = await claimFundingReconciliationJobsInTransaction(client, {
      leaseOwner: "worker-b",
      limit: 10,
      leaseSeconds: 5,
      now: new Date(renewedWorkerA.leaseUntil.getTime() + 1),
    });
    assert.equal(workerB.length, 1);
    assert.equal(workerB[0]?.operationId, committedB.operation.id);
    assert.notEqual(workerB[0]?.leaseToken, workerA[0]?.leaseToken);
    await expectFundingError(
      finishFundingReconciliationLease(client as never, {
        jobId: String(workerA[0]?.jobId),
        leaseOwner: "worker-a",
        leaseToken: String(workerA[0]?.leaseToken),
        result: { kind: "completed" },
      }),
      "lease_lost",
    );
    await finishFundingReconciliationLease(client as never, {
      jobId: String(workerB[0]?.jobId),
      leaseOwner: "worker-b",
      leaseToken: String(workerB[0]?.leaseToken),
      result: {
        kind: "requeue",
        dueAt: leaseNow,
      },
      now: leaseNow,
    });
    await wakeFundingReconciliationInTransaction(client, {
      operationId: committedB.operation.id,
      dueAt: leaseNow,
    });
    await wakeFundingReconciliationInTransaction(client, {
      operationId: committedB.operation.id,
      dueAt: leaseNow,
    });
    const workerC = await claimFundingReconciliationJobsInTransaction(client, {
      leaseOwner: "worker-c",
      limit: 10,
      leaseSeconds: 5,
      now: leaseNow,
    });
    assert.equal(workerC.length, 1);
    assert.equal(workerC[0]?.attemptCount, 3);

    const routeOnlyUser = await insertUser(client);
    const routeOnlyPlan = buildPlan({
      planKind: "already_available",
      includeStep: false,
    });
    const routeOnlyToken = opaque("consent");
    const routeOnlyQuote = await createFundingQuoteInTransaction(
      client,
      quoteInput(routeOnlyUser, routeOnlyPlan, routeOnlyToken),
    );
    const routeOnlyOperation = await commitFundingOperationInTransaction(
      client,
      commitInput(
        routeOnlyUser,
        routeOnlyQuote.id,
        routeOnlyToken,
        routeOnlyPlan,
      ),
    );
    await startFundingRouteObservationInTransaction(client, {
      userId: routeOnlyUser,
      operationId: routeOnlyOperation.operation.id,
      routeKeyHmac: hash("6"),
      routeKeyVersion: 1,
      providerId: "synthetic",
      adapterVersion: 1,
      amountBand: "deletion-test",
      policyRevision: "wp3-test",
    });
    const routeOnlyDeletion = await AuthService.deleteUser(
      routeOnlyUser,
      client,
    );
    assert.equal(routeOnlyDeletion.disposition, "deactivated");
    assert.equal(routeOnlyDeletion.activeMovement, true);
    assert.equal(routeOnlyDeletion.privyDeletionAllowed, false);
    assert.ok(
      routeOnlyDeletion.protectedReasons.includes("active_funding_movement"),
    );

    const disposableUser = await insertUser(client);
    const hardDeletion = await AuthService.deleteUser(disposableUser, client);
    assert.equal(hardDeletion.disposition, "hard_deleted");
    assert.equal(hardDeletion.activeMovement, false);
    const disposableUserCount = await client.query<{ count: string }>(
      "select count(*)::text as count from users where id = $1",
      [disposableUser],
    );
    assert.equal(disposableUserCount.rows[0]?.count, "0");

    const preparationUser = await insertUser(client);
    await client.query(
      `
        insert into funding_preparation_runs (
          user_id,
          request_fingerprint,
          request_snapshot,
          inspection_revision,
          status,
          expires_at
        )
        values ($1, $2, '{}'::jsonb, $3, 'action_required', now() + interval '1 hour')
      `,
      [preparationUser, hash("p"), "inspection-revision-test"],
    );
    const preparationDeletion = await AuthService.deleteUser(
      preparationUser,
      client,
    );
    assert.equal(preparationDeletion.disposition, "deactivated");
    assert.equal(preparationDeletion.activeMovement, false);
    assert.ok(
      preparationDeletion.protectedReasons.includes("funding_evidence"),
    );

    const retainedDeletion = await AuthService.deleteUser(userB, client);
    assert.equal(retainedDeletion.disposition, "deactivated");
    assert.equal(retainedDeletion.activeMovement, true);
    assert.equal(retainedDeletion.privyDeletionAllowed, false);
    assert.ok(retainedDeletion.protectedReasons.includes("funding_evidence"));
    const retainedUser = await client.query<{
      email: string | null;
      is_active: boolean;
      privy_deletion_pending: boolean;
      privy_user_id: string | null;
    }>(
      `
        select
          email,
          is_active,
          privy_deletion_pending,
          privy_user_id
        from users
        where id = $1
      `,
      [userB],
    );
    assert.equal(retainedUser.rows[0]?.is_active, false);
    assert.equal(retainedUser.rows[0]?.email, null);
    assert.equal(retainedUser.rows[0]?.privy_deletion_pending, true);
    assert.match(String(retainedUser.rows[0]?.privy_user_id), /^did:privy:/);
    await assert.rejects(
      AuthService.resolveExistingUserIdForPrivyLoginWithClient(client, {
        privyUserId: userBPrivyId,
        privyWallets: [],
        telegramAccount: null,
        email: null,
      }),
      /deactivated while retained financial activity/i,
    );
    const retainedOperationCount = await client.query<{ count: string }>(
      `
        select count(*)::text as count
        from funding_operations
        where user_id = $1
      `,
      [userB],
    );
    assert.equal(retainedOperationCount.rows[0]?.count, "1");

    await client.query("savepoint invalid_state");
    await assert.rejects(
      client.query(
        `
          update funding_operations
          set status = 'ready',
              progress_stage = 'routing',
              version = version + 1
          where id = $1
        `,
        [committedB.operation.id],
      ),
    );
    await client.query("rollback to savepoint invalid_state");

    await client.query("savepoint immutable_expiry");
    await assert.rejects(
      client.query(
        `
          update funding_operations
          set expires_at = expires_at + interval '1 minute',
              version = version + 1
          where id = $1
        `,
        [committedB.operation.id],
      ),
      /funding operation expiry is immutable/i,
    );
    await client.query("rollback to savepoint immutable_expiry");

    await client.query("savepoint second_segment");
    await assert.rejects(async () => {
      await client.query(
        `
            insert into funding_operation_segments (
              operation_id,
              ordinal,
              provider_id,
              adapter_id,
              adapter_version,
              segment_kind,
              status,
              source_snapshot,
              destination_target_snapshot,
              quoted_input,
              quoted_expected_output,
              quoted_min_output,
              lookup_key_version,
              quote_expires_at
            )
            values (
              $1, 1, 'synthetic', 'synthetic', 1, 'same_network_swap',
              'planned', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
              '{}'::jsonb, 1, now() + interval '1 hour'
            )
          `,
        [committedB.operation.id],
      );
      await client.query(
        "set constraints funding_operation_segments_shape immediate",
      );
    });
    await client.query("rollback to savepoint second_segment");

    const unknownLegacy = await client.query<{ count: string }>(
      `
        select count(*)::text as count
        from bridge_orders
        where adapter_version is null
          and lower(trim(status)) not in (
            'fulfilled', 'filled', 'completed', 'success', 'confirmed',
            'failed', 'reverted', 'error', 'expired', 'refunded',
            'cancelled', 'canceled'
          )
      `,
    );
    assert.equal(unknownLegacy.rows[0]?.count, "0");
  } finally {
    await client.query("rollback");
    client.release();
  }
}

await testConcurrentPreparationRunReplay();
console.log(
  "[funding-persistence-integration-tests] ok concurrent preparation replay, report idempotency, and reconcile",
);
await testConcurrentCommitReplay();
console.log(
  "[funding-persistence-integration-tests] ok concurrent exact replay",
);
await testPersistedQuoteSurvivesStatelessCommitBoundary();
console.log(
  "[funding-persistence-integration-tests] ok persisted quote survives stateless commit boundary",
);
await testExpiredQuoteCannotCommit();
console.log(
  "[funding-persistence-integration-tests] ok expired quote cannot commit",
);
await testQuoteCannotExpireDuringCurrentFactsCheck();
console.log(
  "[funding-persistence-integration-tests] ok quote expiry is rechecked after current facts",
);
await testAtomicRollbackAfterPartialInsert();
console.log(
  "[funding-persistence-integration-tests] ok atomic rollback after partial insert",
);
await testPollingFailureHonorsTerminalTimeout();
console.log(
  "[funding-persistence-integration-tests] ok polling failure honors terminal timeout",
);
await testOwnedRouteCompetitionQueryParses();
console.log(
  "[funding-persistence-integration-tests] ok owned-route competition query parses",
);
await testAutomaticRecoveryAcceptsLateDestinationEvidence();
console.log(
  "[funding-persistence-integration-tests] ok automatic recovery accepts late owned-destination evidence idempotently",
);
await testUnexposedRecoveryRouteDoesNotBlockDestinationObservation();
console.log(
  "[funding-persistence-integration-tests] ok unexposed recovery route does not block destination observation",
);
await testActionWaitUsesIdleReconciliationWithoutExternalPolling();
console.log(
  "[funding-persistence-integration-tests] ok action wait skips external polling, uses idle cadence, wakes on report, and mixed work remains active",
);
await testExpiredUnbroadcastActionWaitCancelsSafely();
console.log(
  "[funding-persistence-integration-tests] ok expired unbroadcast action wait cancels and releases reservations without external polling",
);
await testConcurrentSourceReservationExclusion();
console.log(
  "[funding-persistence-integration-tests] ok concurrent source reservation exclusion",
);
await testDirectIngressWithDeferredPreparationCommit();
console.log(
  "[funding-persistence-integration-tests] ok direct ingress with deferred preparation commit",
);
await testCompositePreparationAndRelayCommit();
console.log(
  "[funding-persistence-integration-tests] ok composite venue preparation plus Relay commit",
);
await testTerminalFundingMergeLifecycle();
console.log(
  "[funding-persistence-integration-tests] ok terminal funding merge lifecycle",
);
await testTransactionalPersistenceContracts();
console.log(
  "[funding-persistence-integration-tests] ok ownership, evidence, accounting, reducer, and leases",
);
console.log("[funding-persistence-integration-tests] complete");
