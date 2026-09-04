#!/usr/bin/env tsx

// @api-integration

import assert from "node:assert/strict";
import crypto from "node:crypto";

import { tx } from "@hunch/infra";
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
import { storeOrderInTransaction } from "../../../repos/orders-repo.js";
import {
  claimTelegramAppHandoffV2FundedTradeAttemptInTransaction,
  claimTelegramAppHandoffV2DirectTradeSubmissionInTransaction,
  failTelegramAppHandoffV2DirectTradeSubmissionInTransaction,
  type TelegramAppHandoffV2ScopeAssertion,
} from "../../../repos/telegram-app-handoff-v2-direct-trade-repository.js";
import {
  cancelTelegramAppHandoff,
  resolveTelegramAppHandoff,
} from "../../../services/telegram-app-handoff.js";
import {
  applyFundingSourceDebitSuppression,
  loadFundingAccountValueFacts,
} from "../../../account-value/funding-movement-feed.js";
import type { ValuedAssetComponent } from "../../domain/types.js";
import type { PreparationResult } from "../../domain/contracts.js";
import {
  assertFundingReservationReadyForTrade,
  consumeFundingReservationForLinkedConsumerInTransaction,
  fetchFundingWithdrawalDestinationForUser,
  finishFundingRouteObservationInTransaction,
  finishFundingStepAttemptInTransaction,
  finishFundingStepAttemptForUserInTransaction,
  releaseFundingReservationForAbandonedTradeInTransaction,
  registerFundingWithdrawalDestination,
  registerFundingWithdrawalDestinationInTransaction,
  revokeFundingWithdrawalDestinationInTransaction,
  startFundingRouteObservationInTransaction,
  startFundingStepAttemptInTransaction,
  upsertFundingProviderRequestInTransaction,
} from "../../persistence/funding-evidence-repository.js";
import { polymarketRelayerTransactionReference } from "../../execution/polymarket-deposit-wallet-handoff.js";
import { inspectEvmTarget } from "../../execution/step-receipt-reconciler.js";
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
  wakeFundingReconciliationInTransaction,
  writeFundingOperationLifecycleProjectionCacheInTransaction,
  writeFundingOperationSupportFactsInTransaction,
  type FundingCommitInput,
  type FundingCommitPlan,
  type FundingQuoteInsert,
} from "../../persistence/funding-operation-repository.js";
import {
  applyFundingStepReceiptEvidence,
  applyFundingStepReceiptEvidenceInTransaction,
} from "../../persistence/funding-step-receipt-repository.js";
import {
  claimFundingTradeAttemptInTransaction,
  claimLimitlessTradeAttemptForReconciliation,
  FundingTradeAttemptError,
  markFundingTradeAttemptSubmissionStartedInTransaction,
  proveAmbiguousLimitlessTradeAttemptAbsentInTransaction,
  proveAmbiguousLimitlessTerminalRejectionInTransaction,
  recordFundingTradeAttemptOutcomeInTransaction,
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
  DEFAULT_FUNDING_RECONCILIATION_TERMINAL_TIMEOUT_MS,
  FUNDING_RECEIPT_REORG_UNRESOLVED_ERROR_CODE,
  FUNDING_RECONCILIATION_TIMEOUT_ERROR_CODE,
  fundingReconciliationPollDelayMs,
  fundingReconciliationWaitState,
  reduceFundingOperationInTransaction,
  runFundingReconciliationBatch,
} from "../../reconciliation/funding-reducer.js";
import { OwnedRouteDestinationObserver } from "../../reconciliation/owned-route-destination-observer.js";
import { DirectIngressDestinationObserver } from "../../reconciliation/direct-ingress-observer.js";
import {
  lockPolymarketFundingOperationPredecessor,
  PolymarketFundingPredecessorUnresolvedError,
} from "../../preparation/polymarket-funding-commit-guard.js";
import { hashOpaqueToken } from "../../persistence/canonical.js";
import { loadTelegramAppHandoffProjection } from "../../../services/telegram-bot-trading.js";
import { FundingPlanningRuntime } from "../../planner/runtime-service.js";
import { PreparationContractError } from "../../preparation/core-adapter.js";

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
      // Receipt observations are deliberately immutable in production. This
      // transaction is disposable-test cleanup only; disabling user triggers
      // locally lets the fixture remove its own evidence without weakening the
      // production guard.
      await client.query("set local session_replication_role = replica");
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
        "delete from funding_step_receipt_observations where operation_id = $1",
        [operationId],
      );
      await client.query(
        `
          delete from funding_operation_step_attempts attempt
          using funding_operation_steps step
          where attempt.step_id = step.id
            and step.operation_id = $1
        `,
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

async function testSubmittedPreparationRunSelfHealing(): Promise<void> {
  const userId = await insertUser(pool);
  const runIds: string[] = [];
  let inspectionAvailable = true;
  let inspectionStatus: PreparationResult["status"] = "ready";
  let inspectionError: PreparationContractError | null = null;
  let inspectionNeverSettles = false;
  const inspectionOptions: Array<Readonly<{ forceFresh?: boolean }>> = [];
  const inspectionInputs: Array<
    Readonly<{ controllerWalletRef?: string | null }>
  > = [];
  const runtime = new FundingPlanningRuntime(pool, {
    opportunisticPreparationReconcileTimeoutMs: 30,
  });
  Object.defineProperty(runtime, "preparationRuntime", {
    value: {
      inspectBindingOption: async (
        input: Readonly<{ controllerWalletRef?: string | null }>,
        options: Readonly<{ forceFresh?: boolean }> = {},
      ) => {
        inspectionInputs.push(input);
        inspectionOptions.push(options);
        if (inspectionNeverSettles) {
          return new Promise<PreparationResult>(() => undefined);
        }
        if (inspectionError) throw inspectionError;
        if (!inspectionAvailable) {
          throw new PreparationContractError(
            "preparation_unavailable",
            "test RPC unavailable",
          );
        }
        return { status: inspectionStatus } as PreparationResult;
      },
    },
  });

  const createSubmittedRun = async (
    revision: string,
    actionCount = 1,
    includeController = true,
  ) => {
    const request = {
      venueBindingOptionId: `binding:test:self-heal:${revision}`,
      purpose: "buy" as const,
      marketContextId: null,
      marketClass: "clob",
      positionActionRef: null,
      controllerWalletRef: includeController ? userId : null,
      expectedInspectionRevision: revision,
    };
    const created = await createOrReplayFundingPreparationRun(pool, {
      userId,
      request,
      expiresAt: new Date(Date.now() + 60_000),
      materialize: async (runId) => ({
        controllerWalletRef: userId,
        actions: Array.from({ length: actionCount }, (_, index) => ({
          kind: "evm_transaction" as const,
          actionId: `preparation_action_${runId}_${index}`,
          networkId: "evm:8453",
          senderWalletId: userId,
          to: "0x0000000000000000000000000000000000000001",
          data: "0x",
          valueRaw: "0",
          gasLimitRaw: null,
        })),
      }),
    });
    runIds.push(created.runId);
    const action = created.actions[0];
    assert.ok(action);
    const submitted = await reportFundingPreparationAction(pool, {
      userId,
      runId: created.runId,
      actionId: action.actionId,
      report: {
        outcome: "submitted",
        transactionReference: `0x${hash(revision.slice(0, 1))}`,
        networkFeeRaw: null,
      },
    });
    return { request, run: submitted };
  };

  try {
    const readable = await createSubmittedRun(hash("f"));
    const recoveredRead = await runtime.preparationRun(
      userId,
      readable.run.runId,
    );
    assert.equal(recoveredRead?.status, "succeeded");
    assert.equal(inspectionOptions.at(-1)?.forceFresh, true);

    const replayable = await createSubmittedRun(hash("a"), 2);
    inspectionAvailable = false;
    const unavailableRead = await runtime.preparationRun(
      userId,
      replayable.run.runId,
    );
    assert.equal(unavailableRead?.status, "submitted");

    inspectionAvailable = true;
    inspectionNeverSettles = true;
    const stalled = await createSubmittedRun(hash("c"));
    const stalledStartedAt = Date.now();
    const stalledRead = await runtime.preparationRun(userId, stalled.run.runId);
    assert.equal(stalledRead?.status, "submitted");
    assert.ok(Date.now() - stalledStartedAt < 500);
    inspectionNeverSettles = false;

    const rebound = await createSubmittedRun(hash("d"));
    inspectionError = new PreparationContractError(
      "binding_mismatch",
      "binding disappeared after broadcast",
    );
    const reboundRead = await runtime.preparationRun(userId, rebound.run.runId);
    assert.equal(reboundRead?.status, "submitted");
    await assert.rejects(
      runtime.reconcilePreparationRun(userId, rebound.run.runId),
      (error: unknown) =>
        error instanceof PreparationContractError &&
        error.code === "binding_mismatch",
    );
    inspectionError = null;

    inspectionStatus = "setup_required";
    const recoveredReplay = await runtime.prepare(userId, replayable.request);
    assert.equal(recoveredReplay.runId, replayable.run.runId);
    assert.equal(recoveredReplay.status, "submitted");
    assert.equal(recoveredReplay.replayed, true);
    const actionCount = await pool.query<{ count: string }>(
      `
        select count(*)::text as count
        from funding_preparation_action_attempts
        where run_id = $1
      `,
      [replayable.run.runId],
    );
    assert.equal(actionCount.rows[0]?.count, "2");

    inspectionStatus = "ready";
    const recoveredLater = await runtime.preparationRun(
      userId,
      replayable.run.runId,
    );
    assert.equal(recoveredLater?.status, "succeeded");

    const controllerless = await createSubmittedRun(hash("b"), 1, false);
    const recoveredControllerless = await runtime.preparationRun(
      userId,
      controllerless.run.runId,
    );
    assert.equal(recoveredControllerless?.status, "succeeded");
    assert.equal(inspectionInputs.at(-1)?.controllerWalletRef, userId);
  } finally {
    await pool.query(
      "delete from funding_preparation_action_attempts where run_id = any($1::uuid[])",
      [runIds],
    );
    await pool.query(
      "delete from funding_preparation_runs where id = any($1::uuid[])",
      [runIds],
    );
    await pool.query("delete from users where id = $1", [userId]);
  }
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
        dependsOnOrdinal: 0,
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
    const stepResult = await pool.query<{
      action_fingerprint: string;
      executor_id: string;
      id: string;
    }>(
      `select id, action_fingerprint, executor_id
         from funding_operation_steps
        where operation_id = $1::uuid and ordinal = 0`,
      [operationId],
    );
    const step = stepResult.rows[0];
    assert.ok(step);
    const attempt = await startFundingStepAttemptInTransaction(pool, {
      operationId,
      stepId: step.id,
      canonicalActionFingerprint: step.action_fingerprint,
      executorId: step.executor_id,
      now: new Date(Date.now() - 90_000),
    });
    await finishFundingStepAttemptInTransaction(pool, {
      attemptId: attempt.id,
      outcome: "ambiguous",
      broadcastMayHaveOccurred: true,
      referenceKind: "transaction",
      receiptRefCiphertext: "ciphertext:terminal-timeout",
      receiptRefLookupHmac: hash("e"),
      lookupKeyVersion: 1,
      actualCosts: {},
      now: new Date(Date.now() - 89_000),
    });
    await pool.query(
      `
        update funding_operation_steps
        set state = 'submitted'
        where operation_id = $1
          and ordinal = 0
          and state in ('planned', 'action_required')
      `,
      [operationId],
    );
    const now = new Date();
    await pool.query(
      `
        update funding_reconciliation_jobs
        set due_at = $2::timestamptz,
            status = 'scheduled',
            priority = 10000,
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
      // A dependent action cannot remain plausibly runnable while its source
      // action is under automatic evidence recovery.
      ["recovery_required", "recovery_required"],
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

async function testRecentBroadcastRecoveryUsesActiveReceiptCadence(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const userId = await insertUser(client);
    const plan = buildPlan();
    const consentToken = opaque("broadcast-recovery-consent");
    const quote = await createFundingQuoteInTransaction(
      client,
      quoteInput(userId, plan, consentToken),
    );
    const committed = await commitFundingOperationInTransaction(
      client,
      commitInput(userId, quote.id, consentToken, plan),
    );
    const operationId = committed.operation.id;
    const stepResult = await client.query<{ id: string }>(
      `select id
         from funding_operation_steps
        where operation_id = $1
          and ordinal = 0`,
      [operationId],
    );
    const stepId = stepResult.rows[0]?.id;
    assert.ok(stepId);
    const attempt = await startFundingStepAttemptInTransaction(client, {
      operationId,
      stepId,
      canonicalActionFingerprint: hash("b"),
      executorId: "synthetic-executor",
    });
    await finishFundingStepAttemptInTransaction(client, {
      attemptId: attempt.id,
      outcome: "ambiguous",
      broadcastMayHaveOccurred: true,
      referenceKind: "transaction",
      receiptRefCiphertext: "ciphertext:recent-broadcast",
      receiptRefLookupHmac: hash("9"),
      lookupKeyVersion: 1,
      actualCosts: {},
    });
    await client.query(
      `update funding_operation_steps set state = 'submitted' where id = $1`,
      [stepId],
    );
    await client.query(
      `update funding_operation_steps
          set state = 'reconcile_required'
        where id = $1`,
      [stepId],
    );
    await client.query(
      `update funding_operation_steps
          set state = 'recovery_required'
        where id = $1`,
      [stepId],
    );
    const waitState = await fundingReconciliationWaitState(
      client,
      operationId,
      90_000,
    );
    assert.equal(
      waitState.broadcastEvidenceActiveUntil?.getTime(),
      attempt.startedAt.getTime() + 90_000,
      "the persisted unresolved broadcast must define a bounded evidence window",
    );
    assert.equal(
      fundingReconciliationPollDelayMs(
        { status: "recovery_required", stage: "source_action" },
        {
          activePollDelayMs: 2_000,
          broadcastEvidenceActiveUntil: waitState.broadcastEvidenceActiveUntil,
          idlePollDelayMs: 15_000,
          now: new Date(attempt.startedAt.getTime() + 10_000),
          recoveryMode: "automatic_evidence",
          recoveryPollDelayMs: 60_000,
        },
      ),
      2_000,
    );
    await client.query("rollback");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function testLateCanonicalFailureRearmsRetryAndKeepsReorgWatch(): Promise<void> {
  const userId = await insertUser(pool);
  const plan = buildPlan();
  const consentToken = opaque("late-failure-retry-consent");
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
    const stepResult = await pool.query<{
      action_fingerprint: string;
      executor_id: string;
      id: string;
    }>(
      `select id, action_fingerprint, executor_id
         from funding_operation_steps
        where operation_id = $1::uuid and ordinal = 0`,
      [operationId],
    );
    const step = stepResult.rows[0];
    assert.ok(step);
    const failedAt = new Date();
    const attemptClient = await pool.connect();
    let attemptId: string;
    try {
      await attemptClient.query("begin");
      const attempt = await startFundingStepAttemptInTransaction(
        attemptClient,
        {
          operationId,
          stepId: step.id,
          canonicalActionFingerprint: step.action_fingerprint,
          executorId: step.executor_id,
          now: new Date(failedAt.getTime() - 5_000),
        },
      );
      attemptId = attempt.id;
      await finishFundingStepAttemptInTransaction(attemptClient, {
        attemptId,
        outcome: "submitted",
        broadcastMayHaveOccurred: true,
        referenceKind: "transaction",
        receiptRefCiphertext: "ciphertext:late-finalized-failure",
        receiptRefLookupHmac: hash("8"),
        lookupKeyVersion: 1,
        actualCosts: {},
        now: new Date(failedAt.getTime() - 4_000),
      });
      await attemptClient.query(
        `update funding_operation_steps
            set state = 'submitted', updated_at = $2::timestamptz
          where id = $1::uuid`,
        [step.id, new Date(failedAt.getTime() - 4_000)],
      );
      await attemptClient.query("commit");
    } catch (error) {
      await attemptClient.query("rollback");
      throw error;
    } finally {
      attemptClient.release();
    }

    const failedReceipt = await applyFundingStepReceiptEvidence(pool, {
      operationId,
      stepId: step.id,
      attemptId,
      networkId: ASSET.networkId,
      receipt: {
        status: "failed",
        actionMatch: true,
        ledgerHeight: "700",
        blockHash: `0x${"31".repeat(32)}`,
        canonical: true,
        failureCode: "polymarket_relayer_transaction_failed",
        evidence: { confirmations: 12, failureFinalized: true },
      },
      now: failedAt,
    });
    assert.equal(failedReceipt.status, "failed");
    const reduction = await pool.connect().then(async (client) => {
      try {
        await client.query("begin");
        const result = await reduceFundingOperationInTransaction(client, {
          operationId: committed.operation.id,
          now: failedAt,
        });
        await client.query("commit");
        return result;
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    });
    assert.deepEqual(reduction.finalState, {
      status: "in_progress",
      stage: "source_action",
    });
    const resumed = await pool.query<{
      error_code: string | null;
      recovery_mode: string | null;
      step_state: string;
    }>(
      `select operation.error_code,
              operation.recovery_mode,
              step.state as step_state
         from funding_operations operation
         join funding_operation_steps step on step.operation_id = operation.id
        where operation.id = $1::uuid and step.id = $2::uuid`,
      [operationId, step.id],
    );
    assert.deepEqual(resumed.rows[0], {
      error_code: null,
      recovery_mode: null,
      step_state: "action_required",
    });

    const outageAt = new Date(failedAt.getTime() + 250);
    await pool.query(
      `update funding_reconciliation_jobs
          set due_at = $2::timestamptz,
              status = 'scheduled',
              priority = 10000,
              lease_owner = null,
              lease_token = null,
              lease_until = null
        where operation_id = $1::uuid`,
      [operationId, outageAt],
    );
    const outageBatch = await runFundingReconciliationBatch(pool, {
      workerId: opaque("failed-receipt-provider-outage-worker"),
      limit: 1,
      now: outageAt,
      receiptPoll: async () => {
        throw new Error(
          "Polymarket relayer lookup is unavailable during hashless failure verification",
        );
      },
    });
    assert.deepEqual(
      {
        claimed: outageBatch.claimed,
        completed: outageBatch.completed,
        deadLettered: outageBatch.deadLettered,
        requeued: outageBatch.requeued,
      },
      { claimed: 1, completed: 0, deadLettered: 0, requeued: 1 },
      "a provider outage during a recent failed-receipt watch must requeue the job instead of consuming the watch",
    );
    const outageJob = await pool.query<{
      last_error_code: string | null;
      status: string;
    }>(
      `select status, last_error_code
         from funding_reconciliation_jobs
        where operation_id = $1::uuid`,
      [operationId],
    );
    assert.deepEqual(outageJob.rows[0], {
      status: "scheduled",
      last_error_code: "terminal_relay_receipt_verification_unavailable",
    });
    const stateAfterProviderOutage = await pool.query<{
      operation_status: string;
      receipt_status: string;
      step_state: string;
    }>(
      `select operation.status as operation_status,
              step.state as step_state,
              receipt.status as receipt_status
         from funding_operations operation
         join funding_operation_steps step on step.operation_id = operation.id
         join funding_step_receipt_observations receipt
           on receipt.step_id = step.id
        where operation.id = $1::uuid and step.id = $2::uuid`,
      [operationId, step.id],
    );
    assert.deepEqual(stateAfterProviderOutage.rows[0], {
      operation_status: "in_progress",
      step_state: "action_required",
      receipt_status: "failed",
    });

    const providerConflictProbe = await pool.connect();
    try {
      await providerConflictProbe.query("begin");
      const candidateTransactionHashA = `0x${"32".repeat(32)}`;
      const candidateTransactionHashB = `0x${"33".repeat(32)}`;
      const exactHashConflict = await inspectEvmTarget(
        {
          operationId,
          stepId: step.id,
          segmentId: null,
          attemptId,
          attemptStartedAt: new Date(failedAt.getTime() - 5_000),
          stepKind: "external_handoff",
          payerRequirement: "user",
          networkId: "evm:137",
          action: {
            kind: "external_handoff",
            actionId: "action_late_hash_conflict",
            networkId: "evm:137",
            actorWalletId: "wallet_late_hash_conflict",
            handoffKind: "polymarket_deposit_wallet_transfer",
            payload: {},
          },
          actionValidationResult: {},
          receiptRefCiphertext: "ciphertext:late-hash-conflict",
          receiptRefLookupHmac: hash("7"),
          lookupKeyVersion: 1,
          previousReceipt: failedReceipt,
        },
        polymarketRelayerTransactionReference("relayer_late_hash_conflict"),
        undefined,
        {
          findTransactionScan: async () => ({
            attributionComplete: true,
            attributionEndBlock: 701n,
            attributionEndBlockHash: `0x${"34".repeat(32)}`,
            attributionFenceChanged: false,
            attributionWindowClosed: true,
            candidateTransactions: {
              [candidateTransactionHashA]: failedAt.getTime(),
              [candidateTransactionHashB]: failedAt.getTime() + 1,
            },
            caughtUp: true,
            historyCovered: true,
            lastScannedFromBlock: 700n,
            lastScannedToBlock: 701n,
            match: null,
            newestScannedBlock: 701n,
            oldestScannedBlock: 700n,
            sweepTargetBlock: 701n,
          }),
          resolveReference: async () => {
            throw new Error("Polymarket relayer unavailable");
          },
        },
      );
      assert.deepEqual(
        {
          status: exactHashConflict.status,
          failureCode: exactHashConflict.failureCode,
          invalidatingReceiptStatus:
            exactHashConflict.evidence.invalidatingReceiptStatus,
          invalidatingReceiptFailureCode:
            exactHashConflict.evidence.invalidatingReceiptFailureCode,
          candidateCount: Object.keys(
            (exactHashConflict.evidence
              .polymarketHandoffCandidateTransactions ?? {}) as object,
          ).length,
        },
        {
          status: "reorged",
          failureCode: "polymarket_handoff_failure_evidence_invalidated",
          invalidatingReceiptStatus: "mismatch",
          invalidatingReceiptFailureCode:
            "polymarket_handoff_chain_candidate_ambiguity",
          candidateCount: 2,
        },
      );
      const invalidatedFailure =
        await applyFundingStepReceiptEvidenceInTransaction(
          providerConflictProbe,
          {
            operationId,
            stepId: step.id,
            attemptId,
            networkId: ASSET.networkId,
            receipt: exactHashConflict,
            now: new Date(failedAt.getTime() + 300),
          },
        );
      assert.equal(invalidatedFailure.status, "reorged");
      const conflictReduction = await reduceFundingOperationInTransaction(
        providerConflictProbe,
        {
          operationId,
          now: new Date(failedAt.getTime() + 301),
        },
      );
      assert.deepEqual(conflictReduction.finalState, {
        status: "recovery_required",
        stage: "source_action",
      });
      const conflictState = await providerConflictProbe.query<{
        recovery_mode: string | null;
        step_state: string;
      }>(
        `select operation.recovery_mode, step.state as step_state
           from funding_operations operation
           join funding_operation_steps step on step.operation_id = operation.id
          where operation.id = $1::uuid and step.id = $2::uuid`,
        [operationId, step.id],
      );
      assert.deepEqual(conflictState.rows[0], {
        recovery_mode: "automatic_evidence",
        step_state: "recovery_required",
      });
      await providerConflictProbe.query("rollback");
    } catch (error) {
      await providerConflictProbe.query("rollback");
      throw error;
    } finally {
      providerConflictProbe.release();
    }

    const retryProbe = await pool.connect();
    try {
      await retryProbe.query("begin");
      const retry = await startFundingStepAttemptInTransaction(retryProbe, {
        operationId,
        stepId: step.id,
        canonicalActionFingerprint: step.action_fingerprint,
        executorId: step.executor_id,
        now: new Date(failedAt.getTime() + 500),
      });
      assert.equal(retry.attemptNumber, 2);
      await retryProbe.query("rollback");
    } catch (error) {
      await retryProbe.query("rollback");
      throw error;
    } finally {
      retryProbe.release();
    }

    const expiresAt = new Date(failedAt.getTime() + 1_000);
    await pool.query(
      `update funding_operation_steps
          set action_expires_at = $2::timestamptz
        where id = $1::uuid`,
      [step.id, expiresAt],
    );
    await pool.query(
      `update funding_reconciliation_jobs
          set due_at = $2::timestamptz,
              status = 'scheduled',
              priority = 10000,
              lease_owner = null,
              lease_token = null,
              lease_until = null
        where operation_id = $1::uuid`,
      [operationId, expiresAt],
    );
    const polls: string[] = [];
    const batch = await runFundingReconciliationBatch(pool, {
      workerId: opaque("failed-receipt-expiry-watch-worker"),
      limit: 1,
      now: expiresAt,
      receiptPoll: async () => {
        polls.push("receipt");
        return { receiptsPolled: 1 };
      },
      postconditionPoll: async () => {
        polls.push("postcondition");
        return { postconditionsPolled: 0 };
      },
      destinationPoll: async () => {
        polls.push("destination");
        return { destinationsPolled: 0, destinationSatisfied: false };
      },
      providerPoll: async () => {
        polls.push("provider");
        return { requestsPolled: 0 };
      },
    });
    assert.deepEqual(
      {
        claimed: batch.claimed,
        completed: batch.completed,
        requeued: batch.requeued,
        polls: new Set(polls),
      },
      {
        claimed: 1,
        completed: 0,
        requeued: 1,
        polls: new Set(["receipt", "postcondition", "destination"]),
      },
    );
    const expired = await pool.query<{
      job_status: string;
      reservation_state: string;
      status: string;
    }>(
      `select operation.status,
              job.status as job_status,
              reservation.state as reservation_state
         from funding_operations operation
         join funding_reconciliation_jobs job on job.operation_id = operation.id
         join balance_reservations reservation
           on reservation.operation_id = operation.id
        where operation.id = $1::uuid`,
      [operationId],
    );
    assert.deepEqual(expired.rows[0], {
      status: "cancelled",
      job_status: "scheduled",
      reservation_state: "released",
    });
  } finally {
    await cleanupCommittedOperation(operationId, quote.id, userId);
  }
}

async function testUnresolvedExternalHandoffReorgBecomesManualReview(): Promise<void> {
  const userId = await insertUser(pool);
  const basePlan = buildPlan();
  const baseStep = basePlan.steps[0];
  assert.ok(baseStep);
  const plan: FundingCommitPlan = {
    ...basePlan,
    steps: [
      {
        ...baseStep,
        stepKind: "external_handoff",
        executorId: "polymarket_deposit_wallet_relayer_v1",
      },
    ],
  };
  const consentToken = opaque("external-handoff-reorg-consent");
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
    const client = await pool.connect();
    const reorgedAt = new Date();
    try {
      await client.query("begin");
      const step = await client.query<{
        action_fingerprint: string;
        executor_id: string;
        id: string;
      }>(
        `select id, action_fingerprint, executor_id
           from funding_operation_steps
          where operation_id = $1::uuid and ordinal = 0`,
        [operationId],
      );
      const stepRow = step.rows[0];
      assert.ok(stepRow);
      const attempt = await startFundingStepAttemptInTransaction(client, {
        operationId,
        stepId: stepRow.id,
        canonicalActionFingerprint: stepRow.action_fingerprint,
        executorId: stepRow.executor_id,
        now: new Date(reorgedAt.getTime() - 2_000),
      });
      await finishFundingStepAttemptForUserInTransaction(client, {
        userId,
        operationId,
        stepId: stepRow.id,
        attemptId: attempt.id,
        outcome: "submitted",
        broadcastMayHaveOccurred: true,
        referenceKind: "external_handoff",
        receiptRefCiphertext: "ciphertext:external-handoff-reorg",
        receiptRefLookupHmac: hash("9"),
        lookupKeyVersion: 1,
        actualCosts: {},
        now: new Date(reorgedAt.getTime() - 1_000),
      });
      const finalized = {
        status: "finalized" as const,
        actionMatch: true,
        ledgerHeight: "12345",
        blockHash: `0x${"61".repeat(32)}`,
        canonical: true,
        failureCode: null,
        evidence: {
          handoffEventIndex: "0",
          transactionHash: `0x${"62".repeat(32)}`,
        },
      };
      await applyFundingStepReceiptEvidenceInTransaction(client, {
        operationId,
        stepId: stepRow.id,
        attemptId: attempt.id,
        networkId: "evm:137",
        receipt: finalized,
        now: new Date(reorgedAt.getTime() - 500),
      });
      await applyFundingStepReceiptEvidenceInTransaction(client, {
        operationId,
        stepId: stepRow.id,
        attemptId: attempt.id,
        networkId: "evm:137",
        receipt: {
          ...finalized,
          status: "reorged",
          canonical: false,
          failureCode: "receipt_block_not_canonical",
        },
        now: reorgedAt,
      });
      await client.query(
        `update funding_operations
            set status = 'recovery_required',
                progress_stage = 'source_action',
                recovery_mode = 'automatic_evidence',
                error_code = 'receipt_block_not_canonical',
                version = version + 1,
                updated_at = $2::timestamptz
          where id = $1::uuid`,
        [operationId, reorgedAt],
      );
      await client.query(
        `update funding_reconciliation_jobs
            set status = 'scheduled',
                due_at = $2::timestamptz,
                priority = 10000,
                lease_owner = null,
                lease_token = null,
                lease_until = null
          where operation_id = $1::uuid`,
        [operationId, new Date(reorgedAt.getTime() + 15 * 60_000)],
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }

    const incidentAt = new Date(reorgedAt.getTime() + 15 * 60_000);
    const result = await runFundingReconciliationBatch(pool, {
      workerId: opaque("external-handoff-reorg-worker"),
      limit: 1,
      now: incidentAt,
      receiptPoll: async () => ({ receiptsPolled: 1 }),
      destinationPoll: async () => ({
        destinationsPolled: 1,
        destinationSatisfied: false,
      }),
    });
    assert.deepEqual(
      {
        claimed: result.claimed,
        deadLettered: result.deadLettered,
        requeued: result.requeued,
      },
      { claimed: 1, deadLettered: 1, requeued: 0 },
    );
    const state = await pool.query<{
      error_code: string | null;
      job_error_code: string | null;
      job_status: string;
      recovery_mode: string | null;
      status: string;
    }>(
      `select operation.status,
              operation.recovery_mode,
              operation.error_code,
              job.status as job_status,
              job.last_error_code as job_error_code
         from funding_operations operation
         join funding_reconciliation_jobs job
           on job.operation_id = operation.id
        where operation.id = $1::uuid`,
      [operationId],
    );
    assert.deepEqual(state.rows[0], {
      status: "recovery_required",
      recovery_mode: "manual_review",
      error_code: FUNDING_RECEIPT_REORG_UNRESOLVED_ERROR_CODE,
      job_status: "dead_letter",
      job_error_code: FUNDING_RECEIPT_REORG_UNRESOLVED_ERROR_CODE,
    });
  } finally {
    await cleanupCommittedOperation(operationId, quote.id, userId);
  }
}

async function testReconciliationBatchClaimsOnlyRunnableWave(): Promise<void> {
  const fixtures: Array<{
    operationId: string;
    quoteId: string;
    userId: string;
  }> = [];
  const now = new Date();
  try {
    for (let index = 0; index < 3; index += 1) {
      const userId = await insertUser(pool);
      const plan = buildPlan();
      const consentToken = opaque(`wave-consent-${index}`);
      const quote = await createFundingQuote(
        pool,
        quoteInput(userId, plan, consentToken),
      );
      const committed = await commitFundingOperation(
        pool,
        commitInput(userId, quote.id, consentToken, plan),
      );
      fixtures.push({
        operationId: committed.operation.id,
        quoteId: quote.id,
        userId,
      });
      const stepResult = await pool.query<{
        action_fingerprint: string;
        executor_id: string;
        id: string;
      }>(
        `select id, action_fingerprint, executor_id
           from funding_operation_steps
          where operation_id = $1::uuid and ordinal = 0`,
        [committed.operation.id],
      );
      const step = stepResult.rows[0];
      assert.ok(step);
      const attempt = await startFundingStepAttemptInTransaction(pool, {
        operationId: committed.operation.id,
        stepId: step.id,
        canonicalActionFingerprint: step.action_fingerprint,
        executorId: step.executor_id,
        now,
      });
      await finishFundingStepAttemptInTransaction(pool, {
        attemptId: attempt.id,
        outcome: "ambiguous",
        broadcastMayHaveOccurred: true,
        referenceKind: "transaction",
        receiptRefCiphertext: `ciphertext:wave-${index}`,
        receiptRefLookupHmac: hash(`${index + 3}`),
        lookupKeyVersion: 1,
        actualCosts: {},
        now,
      });
      await pool.query(
        `update funding_operation_steps
            set state = 'submitted', updated_at = $2::timestamptz
          where operation_id = $1::uuid`,
        [committed.operation.id, now],
      );
      await pool.query(
        `update funding_reconciliation_jobs
            set status = 'scheduled',
                due_at = $2::timestamptz,
                priority = 9000,
                lease_owner = null,
                lease_token = null,
                lease_until = null
          where operation_id = $1::uuid`,
        [committed.operation.id, now],
      );
    }

    let releaseFirstWave: (() => void) | null = null;
    const firstWaveReady = new Promise<void>((resolve) => {
      releaseFirstWave = resolve;
    });
    let started = 0;
    let active = 0;
    let peak = 0;
    const result = await runFundingReconciliationBatch(pool, {
      workerId: opaque("wave-worker"),
      concurrency: 2,
      limit: 3,
      now,
      pollDelayMs: 0,
      destinationPoll: async () => {
        started += 1;
        active += 1;
        peak = Math.max(peak, active);
        if (started === 2) releaseFirstWave?.();
        if (started <= 2) await firstWaveReady;
        active -= 1;
        return { destinationsPolled: 1, destinationSatisfied: false };
      },
    });
    assert.equal(peak, 2, "only one bounded claim wave may run concurrently");
    assert.equal(result.claimed, 3);
    assert.equal(new Set(result.operationIds).size, 3);
    assert.deepEqual(
      new Set(result.operationIds),
      new Set(fixtures.map((fixture) => fixture.operationId)),
      "a job requeued by an earlier wave must not be reclaimed in the same batch",
    );
  } finally {
    for (const fixture of fixtures.reverse()) {
      await cleanupCommittedOperation(
        fixture.operationId,
        fixture.quoteId,
        fixture.userId,
      );
    }
  }
}

async function testOlderFailedAttemptCannotRearmNewerBroadcast(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const userId = await insertUser(client);
    const plan = buildPlan();
    const consentToken = opaque("old-attempt-receipt-consent");
    const quote = await createFundingQuoteInTransaction(
      client,
      quoteInput(userId, plan, consentToken),
    );
    const committed = await commitFundingOperationInTransaction(
      client,
      commitInput(userId, quote.id, consentToken, plan),
    );
    const operationId = committed.operation.id;
    const stepResult = await client.query<{ id: string }>(
      `select id
         from funding_operation_steps
        where operation_id = $1
          and ordinal = 0`,
      [operationId],
    );
    const stepId = stepResult.rows[0]?.id;
    assert.ok(stepId);

    const firstAttempt = await startFundingStepAttemptInTransaction(client, {
      operationId,
      stepId,
      canonicalActionFingerprint: hash("b"),
      executorId: "synthetic-executor",
    });
    await finishFundingStepAttemptInTransaction(client, {
      attemptId: firstAttempt.id,
      outcome: "submitted",
      broadcastMayHaveOccurred: true,
      referenceKind: "transaction",
      receiptRefCiphertext: "ciphertext:first-broadcast",
      receiptRefLookupHmac: hash("7"),
      lookupKeyVersion: 1,
      actualCosts: {},
    });
    await client.query(
      `update funding_operation_steps
          set state = 'submitted'
        where id = $1`,
      [stepId],
    );
    const finalizedFailure = {
      status: "failed" as const,
      actionMatch: true,
      ledgerHeight: "100",
      blockHash: `0x${"12".repeat(32)}`,
      canonical: true,
      failureCode: "transaction_reverted",
      evidence: { confirmations: 12, failureFinalized: true },
    };
    await applyFundingStepReceiptEvidenceInTransaction(client, {
      operationId,
      stepId,
      attemptId: firstAttempt.id,
      networkId: ASSET.networkId,
      receipt: finalizedFailure,
    });
    const retryableStep = await client.query<{ state: string }>(
      `select state from funding_operation_steps where id = $1`,
      [stepId],
    );
    assert.equal(retryableStep.rows[0]?.state, "action_required");

    const secondAttempt = await startFundingStepAttemptInTransaction(client, {
      operationId,
      stepId,
      canonicalActionFingerprint: hash("b"),
      executorId: "synthetic-executor",
    });
    await finishFundingStepAttemptInTransaction(client, {
      attemptId: secondAttempt.id,
      outcome: "submitted",
      broadcastMayHaveOccurred: true,
      referenceKind: "transaction",
      receiptRefCiphertext: "ciphertext:second-broadcast",
      receiptRefLookupHmac: hash("8"),
      lookupKeyVersion: 1,
      actualCosts: {},
    });
    await client.query(
      `update funding_operation_steps
          set state = 'submitted'
        where id = $1
          and state = 'action_required'`,
      [stepId],
    );

    await applyFundingStepReceiptEvidenceInTransaction(client, {
      operationId,
      stepId,
      attemptId: firstAttempt.id,
      networkId: ASSET.networkId,
      receipt: finalizedFailure,
    });
    const afterStaleFailure = await client.query<{ state: string }>(
      `select state from funding_operation_steps where id = $1`,
      [stepId],
    );
    assert.equal(
      afterStaleFailure.rows[0]?.state,
      "submitted",
      "a canonical failure from attempt N must not authorize attempt N+2 after attempt N+1 already broadcast",
    );

    await applyFundingStepReceiptEvidenceInTransaction(client, {
      operationId,
      stepId,
      attemptId: firstAttempt.id,
      networkId: ASSET.networkId,
      receipt: {
        status: "reorged",
        actionMatch: true,
        ledgerHeight: "100",
        blockHash: `0x${"12".repeat(32)}`,
        canonical: false,
        failureCode: "canonical_block_hash_mismatch",
        evidence: { confirmations: 12, failureFinalized: true },
      },
    });
    const afterFailureReorg = await client.query<{ state: string }>(
      `select state from funding_operation_steps where id = $1`,
      [stepId],
    );
    assert.equal(
      afterFailureReorg.rows[0]?.state,
      "recovery_required",
      "a reorg of an older failure is operation-wide uncertainty and must stop a newer broadcast",
    );
    await client.query("rollback");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
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
        // Relay route IDs are shared by client-signed and delegated plans.
        // This fixture deliberately keeps the synthetic client executor so
        // late destination evidence must recover without delegated gating.
        routeId: "polygon-pusd-to-base-usdc",
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
    let operation = await writeFundingOperationSupportFactsInTransaction(pool, {
      operationId,
      expectedVersion: committed.operation.version,
      supportMetadataPatch: {
        lifecycleManualRecovery: {
          code: "manual_fixture",
          requestedAt: new Date().toISOString(),
        },
      },
      now: new Date(),
    });
    const stepResult = await pool.query<{
      action_fingerprint: string;
      executor_id: string;
      id: string;
    }>(
      `select id, action_fingerprint, executor_id
         from funding_operation_steps
        where operation_id = $1 and ordinal = 0`,
      [operationId],
    );
    const step = stepResult.rows[0];
    assert.ok(step);
    const reportedAttempt = await startFundingStepAttemptInTransaction(pool, {
      operationId,
      stepId: step.id,
      canonicalActionFingerprint: step.action_fingerprint,
      executorId: step.executor_id,
    });
    await finishFundingStepAttemptInTransaction(pool, {
      attemptId: reportedAttempt.id,
      outcome: "succeeded",
      broadcastMayHaveOccurred: false,
      referenceKind: null,
      receiptRefCiphertext: null,
      receiptRefLookupHmac: null,
      lookupKeyVersion: null,
      actualCosts: {},
    });
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

    const recoveryDeadline = new Date(
      Date.now() - DEFAULT_FUNDING_RECONCILIATION_TERMINAL_TIMEOUT_MS - 1,
    );
    await writeFundingOperationSupportFactsInTransaction(pool, {
      operationId,
      expectedVersion: operation.version,
      supportMetadataPatch: {
        lifecycleManualRecovery: null,
        reconciliationActiveSince: recoveryDeadline.toISOString(),
        reconciliationActiveAttemptBaseline: 0,
        reconciliationEvidenceDeadline: recoveryDeadline.toISOString(),
      },
      now: new Date(),
    });

    const withoutEvidenceClient = await pool.connect();
    try {
      await withoutEvidenceClient.query("begin");
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

async function testHistoricalReadyAndUnexposedRecoveryRoutesDoNotBlockDestinationObservation(): Promise<void> {
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
    const settledReadyCommit = await commit("settled-ready");
    const currentCommit = await commit("current");

    const currentStep = await client.query<{
      action_fingerprint: string;
      executor_id: string;
      id: string;
    }>(
      `select id, action_fingerprint, executor_id
         from funding_operation_steps
        where operation_id = $1 and ordinal = 0`,
      [currentCommit.operation.id],
    );
    const currentAction = currentStep.rows[0];
    assert.ok(currentAction);
    const currentAttempt = await startFundingStepAttemptInTransaction(client, {
      operationId: currentCommit.operation.id,
      stepId: currentAction.id,
      canonicalActionFingerprint: currentAction.action_fingerprint,
      executorId: currentAction.executor_id,
    });
    await finishFundingStepAttemptInTransaction(client, {
      attemptId: currentAttempt.id,
      outcome: "succeeded",
      broadcastMayHaveOccurred: false,
      referenceKind: "transaction",
      receiptRefCiphertext: "ciphertext:current-route",
      receiptRefLookupHmac: hash("c"),
      lookupKeyVersion: 1,
      actualCosts: {},
    });
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

    const settledStep = await client.query<{
      id: string;
      segment_id: string;
    }>(
      `
        select id, segment_id
        from funding_operation_steps
        where operation_id = $1 and ordinal = 0
      `,
      [settledReadyCommit.operation.id],
    );
    const settledStepId = settledStep.rows[0]?.id;
    const settledSegmentId = settledStep.rows[0]?.segment_id;
    assert.ok(settledStepId);
    assert.ok(settledSegmentId);
    const settledAttempt = await startFundingStepAttemptInTransaction(client, {
      operationId: settledReadyCommit.operation.id,
      stepId: settledStepId,
      canonicalActionFingerprint: hash("b"),
      executorId: "synthetic-executor",
    });
    await finishFundingStepAttemptInTransaction(client, {
      attemptId: settledAttempt.id,
      outcome: "succeeded",
      broadcastMayHaveOccurred: false,
      referenceKind: "transaction",
      receiptRefCiphertext: "ciphertext:settled-ready",
      receiptRefLookupHmac: hash("7"),
      lookupKeyVersion: 1,
      actualCosts: {},
    });
    const settledObservedAt = new Date("2026-07-29T22:35:00.000Z");
    await ingestFundingObservationInTransaction(client, {
      discoverySource: "chain_rpc",
      observation: {
        operationId: settledReadyCommit.operation.id,
        segmentId: settledSegmentId,
        kind: "destination_credit",
        networkId: ASSET.networkId,
        assetId: ASSET.assetId,
        assetDecimals: ASSET.decimals,
        txHash: opaque("settled-ready-destination"),
        eventIndex: "0",
        fromAddress: "0xrouter",
        toAddress: "0x00000000000000000000000000000000000000d1",
        rawAmount: "980000",
        observedAt: settledObservedAt,
        ledgerHeight: "300",
        blockHash: opaque("settled-ready-block"),
        finalityStatus: "finalized",
        finalizedAt: settledObservedAt,
      },
    });
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
      "an unbroadcast route and a ready route credited before the immutable baseline must not block a later delivered route",
    );

    const competingStep = await client.query<{
      action_fingerprint: string;
      executor_id: string;
      id: string;
    }>(
      `select id, action_fingerprint, executor_id
         from funding_operation_steps
        where operation_id = $1 and ordinal = 0`,
      [competingCommit.operation.id],
    );
    const competingAction = competingStep.rows[0];
    assert.ok(competingAction);
    const competingAttempt = await startFundingStepAttemptInTransaction(
      client,
      {
        operationId: competingCommit.operation.id,
        stepId: competingAction.id,
        canonicalActionFingerprint: competingAction.action_fingerprint,
        executorId: competingAction.executor_id,
      },
    );
    await finishFundingStepAttemptInTransaction(client, {
      attemptId: competingAttempt.id,
      outcome: "submitted",
      broadcastMayHaveOccurred: true,
      referenceKind: "transaction",
      receiptRefCiphertext: "ciphertext:competing-route",
      receiptRefLookupHmac: hash("d"),
      lookupKeyVersion: 1,
      actualCosts: {},
    });
    const recoveryDeadline = new Date(Date.now() - 1);
    await writeFundingOperationSupportFactsInTransaction(client, {
      operationId: competingCommit.operation.id,
      expectedVersion: competingCommit.operation.version,
      supportMetadataPatch: {
        reconciliationActiveSince: recoveryDeadline.toISOString(),
        reconciliationActiveAttemptBaseline: 0,
        reconciliationEvidenceDeadline: recoveryDeadline.toISOString(),
      },
      now: new Date(),
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
            priority = 10000,
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

    const firstStepResult = await pool.query<{
      action_fingerprint: string;
      executor_id: string;
      id: string;
    }>(
      `
        select id, action_fingerprint, executor_id
        from funding_operation_steps
        where operation_id = $1 and ordinal = 0
      `,
      [operationId],
    );
    const firstStep = firstStepResult.rows[0];
    assert.ok(firstStep);
    const reportedAt = new Date(waitingAt.getTime() + 1_000);
    const reportClient = await pool.connect();
    try {
      await reportClient.query("begin");
      const attempt = await startFundingStepAttemptInTransaction(reportClient, {
        operationId,
        stepId: firstStep.id,
        canonicalActionFingerprint: firstStep.action_fingerprint,
        executorId: firstStep.executor_id,
        now: reportedAt,
      });
      await finishFundingStepAttemptInTransaction(reportClient, {
        attemptId: attempt.id,
        outcome: "submitted",
        broadcastMayHaveOccurred: true,
        referenceKind: "transaction",
        receiptRefCiphertext: "ciphertext:idle-wait-resume",
        receiptRefLookupHmac: hash("f"),
        lookupKeyVersion: 1,
        actualCosts: {},
        now: reportedAt,
      });
      await reportClient.query(
        `
          update funding_operation_steps
          set state = 'submitted',
              updated_at = $3
          where operation_id = $1 and id = $2
        `,
        [operationId, firstStep.id, reportedAt],
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
            priority = 10000,
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
      cancellation_attempt_count: string;
      cancellation_attempt_outcome: string | null;
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
          (
            select count(*)::text
            from funding_operation_step_attempts attempt
            where attempt.step_id = step.id
          ) as cancellation_attempt_count,
          (
            select min(attempt.outcome)
            from funding_operation_step_attempts attempt
            where attempt.step_id = step.id
          ) as cancellation_attempt_outcome,
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
      cancellation_attempt_count: "1",
      cancellation_attempt_outcome: "cancelled",
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

async function testDepositWalletHandoffKeepsItsOwnActionTtl(): Promise<void> {
  const userId = await insertUser(pool);
  const basePlan = buildPlan();
  const quoteExpiresAt = new Date(Date.now() + 30_000).toISOString();
  const plan: FundingCommitPlan = {
    ...basePlan,
    operation: {
      ...basePlan.operation,
      planKind: "direct_external_handoff",
    },
    // The user-authorized Deposit Wallet handoff is a zero-provider action.
    // It must not inherit a short Relay segment/reservation deadline.
    segments: [],
    reservations: [],
    steps: basePlan.steps.map((step) => ({
      ...step,
      segmentOrdinal: null,
      stepKind: "venue_preparation" as const,
    })),
  };
  const consentToken = opaque("handoff-action-ttl-consent");
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
    const persisted = await pool.query<{
      action_expires_at: Date;
      created_at: Date;
    }>(
      `
        select action_expires_at, created_at
        from funding_operation_steps
        where operation_id = $1
      `,
      [operationId],
    );
    const step = persisted.rows[0];
    assert.ok(step?.action_expires_at);
    assert.ok(step?.created_at);
    assert.ok(
      step.action_expires_at.getTime() - step.created_at.getTime() >=
        14 * 60_000,
      "an exact Deposit Wallet handoff must not inherit a 30-second Relay quote expiry",
    );
    assert.ok(
      step.action_expires_at.getTime() > Date.parse(quoteExpiresAt),
      "the handoff remains actionable after its downstream Relay quote expires",
    );
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
  const destinationAddress = "0x00000000000000000000000000000000000000d1";
  const ingressVariant = {
    variantId: opaque("direct-ingress-variant"),
    networkId: ASSET.networkId,
    asset: ASSET,
    destinationAddress,
    destinationLocationId,
    baselineRaw: "1000000",
    baselineRevision: opaque("direct-ingress-baseline"),
    observation: {
      adapterId: "owned_destination_spendability_v1",
      payload: {},
    },
    completion: {
      kind: "committed_venue_preparation",
      stepOrdinal: 0,
    },
  } as const;
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
        location: {
          locationId: destinationLocationId,
          details: { address: destinationAddress },
        },
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
        ingressVariants: [ingressVariant],
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
    // Simulate a stale materialized cache from an interrupted older writer.
    // The commit guard and ingress observer must still follow immutable plan
    // plus evidence facts and not allow that cache to bypass a live route.
    await pool.query(
      `update funding_operations
          set status = 'completed',
              progress_stage = 'terminal',
              completed_at = clock_timestamp(),
              updated_at = clock_timestamp(),
              version = version + 1
        where id = $1`,
      [operationId],
    );
    await assert.rejects(
      tx(pool, (client) =>
        lockPolymarketFundingOperationPredecessor(client, {
          userId,
          venueBindingOptionId,
        }),
      ),
      PolymarketFundingPredecessorUnresolvedError,
    );
    const observed = await new DirectIngressDestinationObserver({
      observe: async () => ({
        variants: [
          {
            variantId: ingressVariant.variantId,
            observedRaw: "2000000",
            revision: opaque("direct-ingress-observed"),
            observedAt: new Date().toISOString(),
          },
        ],
      }),
    }).pollOperation(pool, operationId);
    assert.deepEqual(observed, {
      destinationsPolled: 1,
      destinationSatisfied: true,
    });
    const projection = await pool.query<{
      status: string;
      progress_stage: string;
      step_state: string;
    }>(
      `
        select
          operation.status,
          operation.progress_stage,
          step.state as step_state
        from funding_operations operation
        join funding_operation_steps step
          on step.operation_id = operation.id
        where operation.id = $1
      `,
      [operationId],
    );
    assert.deepEqual(projection.rows[0], {
      status: "in_progress",
      progress_stage: "source_observed",
      step_state: "action_required",
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
        normalizedAction: {
          actionId: opaque("preparation-action"),
          data: "0x",
          gasLimitRaw: null,
          kind: "evm_transaction",
          networkId: ASSET.networkId,
          senderWalletId: userId,
          to: "0x0000000000000000000000000000000000000001",
          valueRaw: "0",
        },
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
        normalizedAction: {
          actionId: opaque("relay-action"),
          data: "0x",
          gasLimitRaw: null,
          kind: "evm_transaction",
          networkId: ASSET.networkId,
          senderWalletId: userId,
          to: "0x0000000000000000000000000000000000000002",
          valueRaw: "0",
        },
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
        evidence: { confirmations: 2 },
      } as const;
      const firstFinalizedAt = new Date("2026-08-13T10:00:00.000Z");
      const firstFinalized = await applyFundingStepReceiptEvidenceInTransaction(
        replayClient,
        {
          operationId,
          stepId: preparationStepId,
          attemptId: preparationAttempt.id,
          networkId: ASSET.networkId,
          receipt: finalizedPreparationReceipt,
          now: firstFinalizedAt,
        },
      );
      assert.equal(
        firstFinalized.finalizedAt?.getTime(),
        firstFinalizedAt.getTime(),
      );
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
      await replayClient.query(
        `
          update funding_step_receipt_observations
          set evidence = evidence || jsonb_build_object(
            'allowanceExact', true,
            'allowanceRaw', '1000000',
            'allowanceBlock', ledger_height,
            'allowanceBlockHash', block_hash
          )
          where attempt_id = $1
        `,
        [preparationAttempt.id],
      );

      const repeatedFinalizedAt = new Date("2026-08-13T10:01:00.000Z");
      const repeatedFinalized =
        await applyFundingStepReceiptEvidenceInTransaction(replayClient, {
          operationId,
          stepId: preparationStepId,
          attemptId: preparationAttempt.id,
          networkId: ASSET.networkId,
          receipt: {
            ...finalizedPreparationReceipt,
            blockHash: hash("4"),
            evidence: { confirmations: 3 },
          },
          now: repeatedFinalizedAt,
        });
      assert.equal(
        repeatedFinalized.finalizedAt?.getTime(),
        firstFinalizedAt.getTime(),
        "repeated finalized polling must preserve the bounded-watch origin",
      );
      assert.equal(
        repeatedFinalized.observedAt.getTime(),
        repeatedFinalizedAt.getTime(),
      );
      assert.equal(repeatedFinalized.evidence.confirmations, 3);
      assert.equal(
        repeatedFinalized.evidence.allowanceExact,
        true,
        "repeated polling of the same receipt must preserve derived evidence",
      );
      assert.equal(repeatedFinalized.evidence.allowanceRaw, "1000000");
      assert.equal(repeatedFinalized.evidence.allowanceBlock, "100");
      assert.equal(repeatedFinalized.evidence.allowanceBlockHash, hash("3"));
      assert.equal(
        repeatedFinalized.blockHash,
        hash("4"),
        "provider receipt identity refreshes must not erase profile evidence",
      );
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
    // The operation is terminal by facts. Leave a coherent but stale live
    // cache behind: merge eligibility must use the factual projection, then
    // move the frozen row without applying a second status-cache predicate.
    await pool.query(
      `
        update funding_operations
        set status = 'recovery_required',
            progress_stage = 'source_action',
            error_code = 'reconciliation_evidence_timeout',
            recovery_mode = 'automatic_evidence',
            completed_at = null,
            version = version + 1
        where id = $1
      `,
      [committed.operation.id],
    );
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
    const userBTelegramUserId = `funding-handoff-${crypto.randomUUID()}`;
    await client.query(
      `insert into user_telegram_accounts (
         user_id, privy_user_id, telegram_user_id
       ) values ($1::uuid, $2, $3)`,
      [userB, userBPrivyId, userBTelegramUserId],
    );
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
    const marketContextId = String(
      planB.operation.marketContextSnapshot?.marketContextId ?? "",
    );
    assert.ok(marketContextId);
    await client.query(
      `insert into unified_tokens (token_id, venue, market_id, side)
       values ($1, 'polymarket', $2, 'YES')`,
      [marketContextId, marketId],
    );
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
    await client.query(
      `update funding_operation_steps
          set state = 'submitted'
        where id = $1 and operation_id = $2 and state = 'planned'`,
      [stepId, committedA.operation.id],
    );
    await applyFundingStepReceiptEvidenceInTransaction(client, {
      operationId: committedA.operation.id,
      stepId,
      attemptId: ambiguous.id,
      networkId: ASSET.networkId,
      receipt: {
        status: "finalized",
        actionMatch: true,
        ledgerHeight: "100",
        blockHash: hash("ambiguous-attempt-finalized-block"),
        canonical: true,
        failureCode: null,
        evidence: { transactionHash: opaque("ambiguous-attempt-tx") },
      },
    });

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

    await ingestFundingObservationInTransaction(client, {
      discoverySource: "chain_rpc",
      observation: {
        operationId: committedA.operation.id,
        segmentId,
        kind: "source_credit",
        networkId: ASSET.networkId,
        assetId: ASSET.assetId,
        assetDecimals: ASSET.decimals,
        txHash: opaque("source-credit-before-debit"),
        eventIndex: "0",
        fromAddress: "0xsender",
        toAddress: "0xsource",
        rawAmount: "1000000",
        observedAt: new Date(),
        ledgerHeight: "99",
        blockHash: opaque("source-credit-block"),
        finalityStatus: "finalized",
        finalizedAt: new Date(),
      },
    });
    const refundSourceSegmentResult = await client.query<{ id: string }>(
      `
        select id
        from funding_operation_segments
        where operation_id = $1
      `,
      [refundOperation.operation.id],
    );
    const refundSourceSegmentId = refundSourceSegmentResult.rows[0]?.id;
    assert.ok(refundSourceSegmentId);
    await ingestFundingObservationInTransaction(client, {
      discoverySource: "chain_rpc",
      observation: {
        operationId: refundOperation.operation.id,
        segmentId: refundSourceSegmentId,
        kind: "source_credit",
        networkId: ASSET.networkId,
        assetId: ASSET.assetId,
        assetDecimals: ASSET.decimals,
        txHash: opaque("source-credit-only"),
        eventIndex: "0",
        fromAddress: "0xsender",
        toAddress: "0xsource",
        rawAmount: "1000000",
        observedAt: new Date(),
        ledgerHeight: "98",
        blockHash: opaque("source-credit-only-block"),
        finalityStatus: "finalized",
        finalizedAt: new Date(),
      },
    });

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
    assert.equal(
      factsBeforeReducer.inTransit[0]?.operationId,
      committedA.operation.id,
    );
    assert.equal(factsBeforeReducer.inTransit[0]?.amount.raw, "1000000");

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
      writeFundingOperationLifecycleProjectionCacheInTransaction(client, {
        operationId: committedA.operation.id,
        expectedVersion: Number(operationAfterSource?.version),
        state: {
          status: "in_progress",
          stage: "source_observed",
        },
        actualSourceAmount: money("999999"),
        now: new Date(),
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
    const factsAfterCompletion = await loadFundingAccountValueFacts(
      client as never,
      userA,
    );
    assert.equal(
      factsAfterCompletion.availability.find(
        (row) =>
          row.componentId === planA.operation.sourceSnapshot?.componentId,
      ),
      undefined,
    );
    assert.equal(
      factsAfterCompletion.inTransit.some(
        (row) => row.operationId === committedA.operation.id,
      ),
      false,
    );
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
    const terminalMetadataPatch =
      await writeFundingOperationLifecycleProjectionCacheInTransaction(client, {
        operationId: committedA.operation.id,
        expectedVersion: completedOperation.version,
        state: {
          status: "completed",
          stage: "terminal",
        },
        supportMetadataPatch: {
          terminalReconciliationCheckedAt: terminalPatchedAt.toISOString(),
        },
        now: terminalPatchedAt,
      });
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
    assert.equal(reorgResult.reorgBlockedByTerminalState, false);
    assert.deepEqual(reorgResult.finalState, {
      status: "recovery_required",
      stage: "source_action",
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
    const handoffId = crypto.randomUUID();
    const handoffPlanFingerprint = hash("a");
    const handoffIntent = await client.query<{ id: string }>(
      `insert into telegram_trade_intents (
         telegram_user_id,
         user_id,
         action,
         venue,
         market_id,
         side,
         amount_usd,
         delivery_mode,
         status,
         funding_operation_id,
         funding_reservation_id,
         result,
         expires_at,
         idempotency_key
       )
       values (
         $1, $2, 'buy', 'polymarket', $3, 'YES', 1,
         'app_handoff', 'funding', $4::uuid, $5::uuid, $6::jsonb,
         clock_timestamp() + interval '30 minutes', $7
       )
       returning id::text`,
      [
        userBTelegramUserId,
        userB,
        marketId,
        committedB.operation.id,
        reservationBId,
        JSON.stringify({
          appHandoffExecution: {
            committedAt: new Date().toISOString(),
            handoffId,
            version: 2,
          },
          appHandoffFunding: {
            handoffId,
            operationId: committedB.operation.id,
            version: 2,
          },
          appHandoffFundingReady: {
            handoffId,
            operationId: committedB.operation.id,
            reservationId: reservationBId,
            version: 2,
          },
        }),
        `handoff-funding-consumer:${crypto.randomUUID()}`,
      ],
    );
    const handoffIntentId = handoffIntent.rows[0]?.id;
    assert.ok(handoffIntentId);
    await client.query(
      `insert into telegram_app_handoffs (
         id, trade_intent_id, user_id, telegram_user_id, token_hash, state,
         plan_fingerprint, policy_revision, authority_fingerprint,
         quote_snapshot, plan_snapshot, expires_at, claimed_at,
         claimed_by_user_id, committed_at
       ) values (
         $1::uuid, $2::uuid, $3::uuid, $4, $5, 'committed', $6,
         'policy-funding', $7, '{}'::jsonb, $8::jsonb,
         clock_timestamp() + interval '30 minutes', clock_timestamp(),
         $3::uuid, clock_timestamp()
       )`,
      [
        handoffId,
        handoffIntentId,
        userB,
        userBTelegramUserId,
        hash("b"),
        handoffPlanFingerprint,
        hash("c"),
        JSON.stringify({
          kind: "funding",
          trade: {
            action: "buy",
            amountUsd: 1,
            controllerWalletAddress:
              "0x00000000000000000000000000000000000000b1",
            marketId,
            maxSpendUsd: 1,
            minReceiveShares: null,
            outcomeTokenId: marketContextId,
            venue: "polymarket",
          },
          version: 2,
        }),
      ],
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
    const handoffFundingClaimInput = {
      ...tradeClaimInput,
      assertCurrentScope: async () => true,
      binding: {
        handoffId,
        planFingerprint: handoffPlanFingerprint,
      },
      submission: {
        action: "buy" as const,
        executionKind: "clob" as const,
        marketId,
        outcomeTokenId: marketContextId,
        receiveRaw: "1",
        signer: "0x00000000000000000000000000000000000000b1",
        spendRaw: "1000000",
        venue: "polymarket" as const,
      },
    } as const;
    await assert.rejects(
      claimFundingTradeAttemptInTransaction(client, tradeClaimInput),
      (error: unknown) => {
        assert.ok(error instanceof FundingTradeAttemptError);
        assert.equal(error.code, "sealed_handoff_required");
        return true;
      },
    );
    await client.query("savepoint cancelled_handoff_claim_fence");
    await client.query(
      `update telegram_trade_intents
          set status = 'cancelled'
        where id = $1::uuid`,
      [handoffIntentId],
    );
    await assert.rejects(
      claimFundingTradeAttemptInTransaction(client, tradeClaimInput),
      (error: unknown) => {
        assert.ok(error instanceof FundingTradeAttemptError);
        assert.equal(error.code, "sealed_handoff_required");
        return true;
      },
      "a cancelled sealed handoff must keep its reservation fenced until cleanup",
    );
    await client.query("rollback to savepoint cancelled_handoff_claim_fence");
    await client.query(
      `update telegram_trade_intents
          set status = 'external_handoff',
              error_code = 'external_handoff_required',
              error_message = 'The confirmed Buy continues in the Hunch Mini App.'
        where id = $1::uuid`,
      [handoffIntentId],
    );
    const tradeClaim =
      await claimTelegramAppHandoffV2FundedTradeAttemptInTransaction(
        client,
        handoffFundingClaimInput,
      );
    assert.equal(tradeClaim.claimed, true);
    const intentAtClaim = await client.query<{
      error_code: string | null;
      error_message: string | null;
      status: string;
      submit_started_at: Date | null;
    }>(
      `select error_code, error_message, status, submit_started_at
       from telegram_trade_intents
       where id = $1::uuid`,
      [handoffIntentId],
    );
    assert.equal(intentAtClaim.rows[0]?.status, "executing");
    assert.equal(intentAtClaim.rows[0]?.error_code, null);
    assert.equal(intentAtClaim.rows[0]?.error_message, null);
    assert.ok(
      intentAtClaim.rows[0]?.submit_started_at,
      "the funded handoff claim must close Telegram cancellation before provider submission",
    );
    const replayedTradeClaim =
      await claimTelegramAppHandoffV2FundedTradeAttemptInTransaction(client, {
        ...handoffFundingClaimInput,
        now: new Date(tradeClaim.attempt.claimedAt.getTime() + 1_000),
      });
    assert.equal(replayedTradeClaim.claimed, false);
    assert.equal(replayedTradeClaim.attempt.id, tradeClaim.attempt.id);
    const reclaimedTradeClaim =
      await claimTelegramAppHandoffV2FundedTradeAttemptInTransaction(client, {
        ...handoffFundingClaimInput,
        now: new Date(tradeClaim.attempt.claimLeaseUntil.getTime() + 1),
      });
    assert.equal(reclaimedTradeClaim.claimed, true);
    assert.equal(reclaimedTradeClaim.reason, "reclaimed_before_submission");
    assert.notEqual(
      reclaimedTradeClaim.attempt.claimToken,
      tradeClaim.attempt.claimToken,
    );
    const fundingResolvedAfterExpiry = new Date(
      reservationBRow.expires_at.getTime() + 1_000,
    );
    await client.query("savepoint expired_prebroadcast_claim");
    const expiredPrebroadcastClaim = await reduceFundingOperationInTransaction(
      client,
      {
        operationId: committedB.operation.id,
        now: fundingResolvedAfterExpiry,
      },
    );
    assert.deepEqual(expiredPrebroadcastClaim.finalState, {
      status: "completed",
      stage: "terminal",
    });
    const releasedPrebroadcastReservation = await client.query<{
      state: string;
    }>("select state from balance_reservations where id = $1", [
      reservationBId,
    ]);
    assert.equal(releasedPrebroadcastReservation.rows[0]?.state, "released");
    await client.query("rollback to savepoint expired_prebroadcast_claim");
    const startedTrade =
      await markFundingTradeAttemptSubmissionStartedInTransaction(client, {
        userId: userB,
        operationId: committedB.operation.id,
        reservationId: reservationBId,
        attemptId: tradeClaim.attempt.id,
        claimToken: reclaimedTradeClaim.attempt.claimToken,
      });
    assert.equal(startedTrade.state, "submission_started");
    await client.query("savepoint ambiguous_attempt_survives_expiry");
    await recordFundingTradeAttemptOutcomeInTransaction(client, {
      userId: userB,
      attemptId: tradeClaim.attempt.id,
      outcome: "ambiguous",
      externalReference: tradeExecutionReference,
      errorCode: "provider_response_unknown",
      broadcastMayHaveOccurred: true,
    });
    const retainedAfterExpiry = await reduceFundingOperationInTransaction(
      client,
      {
        operationId: committedB.operation.id,
        now: fundingResolvedAfterExpiry,
      },
    );
    assert.deepEqual(retainedAfterExpiry.finalState, {
      status: "ready",
      stage: "ready_for_consumer",
    });
    const activeAfterExpiry = await client.query<{ state: string }>(
      "select state from balance_reservations where id = $1",
      [reservationBId],
    );
    assert.equal(activeAfterExpiry.rows[0]?.state, "active");
    const lateExecution = await storeExecutionInTransaction(client, {
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
    });
    assert.equal(lateExecution.funding_operation_id, committedB.operation.id);
    const consumedAfterLateEvidence = await client.query<{
      operation_status: string;
      reservation_state: string;
    }>(
      `select operation.status as operation_status,
              reservation.state as reservation_state
         from funding_operations operation
         join balance_reservations reservation
           on reservation.operation_id = operation.id
        where reservation.id = $1`,
      [reservationBId],
    );
    assert.deepEqual(consumedAfterLateEvidence.rows[0], {
      operation_status: "completed",
      reservation_state: "consumed",
    });
    await client.query(
      "rollback to savepoint ambiguous_attempt_survives_expiry",
    );
    await client.query("savepoint terminal_no_fill_order");
    await storeOrderInTransaction(client, {
      userId: userB,
      walletAddress: "0x00000000000000000000000000000000000000b1",
      venue: "limitless",
      venueOrderId: tradeExecutionReference,
      tokenId: marketContextId,
      side: "BUY",
      orderType: "FOK",
      price: 0.5,
      size: 2,
      status: "expired",
      errorMessage: "Limitless market order was not filled.",
      rawError: null,
    });
    const noFillFundingState = await client.query<{
      attempt_state: string;
      reservation_state: string;
    }>(
      `select trade_attempt.state as attempt_state,
              funding_reservation.state as reservation_state
         from funding_trade_attempts trade_attempt
         join balance_reservations funding_reservation
           on funding_reservation.id = trade_attempt.reservation_id
        where trade_attempt.id = $1::uuid`,
      [tradeClaim.attempt.id],
    );
    assert.deepEqual(noFillFundingState.rows[0], {
      attempt_state: "submission_started",
      reservation_state: "active",
    });
    await client.query("rollback to savepoint terminal_no_fill_order");
    await client.query("savepoint handoff_funding_definitive_failure");
    await recordFundingTradeAttemptOutcomeInTransaction(client, {
      userId: userB,
      attemptId: tradeClaim.attempt.id,
      outcome: "definitive_failure",
      errorCode: "trade_no_fill",
      broadcastMayHaveOccurred: true,
    });
    await releaseFundingReservationForAbandonedTradeInTransaction(client, {
      userId: userB,
      link: {
        operationId: committedB.operation.id,
        reservationId: reservationBId,
      },
      outcomeReason: "trade_no_fill",
      handoffFailure: {
        code: "trade_no_fill",
        message: "The venue did not fill the Buy.",
      },
    });
    const intentAfterDefinitiveFailure = await client.query<{
      error_code: string | null;
      status: string;
    }>(
      `select status, error_code
         from telegram_trade_intents
        where id = $1::uuid`,
      [handoffIntentId],
    );
    assert.deepEqual(intentAfterDefinitiveFailure.rows[0], {
      error_code: "trade_no_fill",
      status: "failed",
    });
    await client.query(
      "rollback to savepoint handoff_funding_definitive_failure",
    );
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
    await client.query("savepoint funded_handoff_immediate_fill");
    const fundedOrder = await storeOrderInTransaction(client, {
      userId: userB,
      walletAddress: "0x00000000000000000000000000000000000000b1",
      venue: "polymarket",
      venueOrderId: opaque("funded-handoff-order"),
      tokenId: marketContextId,
      side: "BUY",
      orderType: "FOK",
      price: 0.5,
      size: 2,
      status: "filled",
      errorMessage: null,
      rawError: null,
      orderHash: opaque("funded-handoff-order-hash"),
      fundingReservation: {
        operationId: committedB.operation.id,
        reservationId: reservationBId,
      },
      fundingTradeAttemptId: tradeClaim.attempt.id,
      filledAt: fundingResolvedAfterExpiry,
    });
    const filledHandoffIntent = await client.query<{
      order_id: string | null;
      status: string;
      venue_order_id: string | null;
    }>(
      `select order_id::text, status, venue_order_id
         from telegram_trade_intents
        where id = $1::uuid`,
      [handoffIntentId],
    );
    assert.deepEqual(filledHandoffIntent.rows[0], {
      order_id: fundedOrder.order.id,
      status: "filled",
      venue_order_id: fundedOrder.order.venue_order_id,
    });
    await client.query("rollback to savepoint funded_handoff_immediate_fill");
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
    const advancedHandoffIntent = await client.query<{
      execution_id: string | null;
      result: unknown;
      status: string;
      venue_order_id: string | null;
    }>(
      `select execution_id::text, result, status, venue_order_id
         from telegram_trade_intents
        where id = $1::uuid`,
      [handoffIntentId],
    );
    assert.equal(advancedHandoffIntent.rows[0]?.status, "submitted");
    assert.equal(advancedHandoffIntent.rows[0]?.execution_id, execution.id);
    assert.equal(
      advancedHandoffIntent.rows[0]?.venue_order_id,
      tradeExecutionReference,
    );
    assert.deepEqual(
      (advancedHandoffIntent.rows[0]?.result as Record<string, unknown>)
        ?.appHandoffTradeExecution,
      {
        attemptId: tradeClaim.attempt.id,
        consumerKind: "execution",
        consumerRef: execution.id,
        externalReference: tradeExecutionReference,
        operationId: committedB.operation.id,
        reservationId: reservationBId,
        state: "accepted",
        version: 2,
      },
      "the shared consumer boundary advances the exact v2 intent with its durable attempt",
    );
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
    const sourceReservationsAfterConsumerResolution = await client.query<{
      state: string;
    }>(
      `
        select state
        from balance_reservations
        where operation_id = $1
          and mode <> 'settled_for_consumer'
      `,
      [committedB.operation.id],
    );
    assert.deepEqual(
      sourceReservationsAfterConsumerResolution.rows.map((row) => row.state),
      ["released"],
      "a completed shortfall cannot keep subtracting its pre-route source from later funding plans",
    );

    await client.query(
      `
        update funding_reconciliation_jobs
        set due_at = now() + interval '1 day'
        where operation_id <> $1::uuid
      `,
      [committedB.operation.id],
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
      "the lease assertion must only expose this fixture's reconciliation job",
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

async function testFundedTradeTerminalLockRace(): Promise<void> {
  const setup = await pool.connect();
  let userId = "";
  let operationId = "";
  let reservationId = "";
  let attemptId = "";
  let attemptClaimToken = "";
  let attemptClaimLeaseUntil = new Date(0);
  let intentId = "";
  let orderId = "";
  let quoteId = "";
  let eventId = "";
  let marketId = "";
  let tokenId = "";
  const clientOrderId = opaque("limitless-client-order");
  try {
    try {
      await setup.query("begin");
      userId = await insertUser(setup);
      eventId = opaque("limitless-lock-event");
      const venueMarketId = opaque("limitless-lock-market");
      marketId = `limitless:${venueMarketId}`;
      const rawTokenId = "123456789012345678901234567890123456789";
      tokenId = `limitless:${rawTokenId}`;
      await setup.query(
        `insert into unified_events (
         id, venue, venue_event_id, title, status, end_date
       ) values ($1, 'limitless', $2, 'Limitless lock event', 'ACTIVE',
                 now() + interval '1 day')`,
        [eventId, opaque("venue-event")],
      );
      await setup.query(
        `insert into unified_markets (
         id, venue, venue_market_id, event_id, title, status, market_type
       ) values ($1, 'limitless', $2, $3, 'Limitless lock market',
                 'ACTIVE', 'binary')`,
        [marketId, venueMarketId, eventId],
      );
      await setup.query(
        `insert into unified_tokens (token_id, venue, market_id, side)
       values ($1, 'limitless', $2, 'YES')`,
        [tokenId, marketId],
      );
      const basePlan = buildPlan({
        purpose: "trade_shortfall",
        venueId: "limitless",
        marketId,
        requestedCollateralRaw: "1000000",
      });
      const plan: FundingCommitPlan = {
        ...basePlan,
        operation: {
          ...basePlan.operation,
          marketContextSnapshot: {
            marketContextId: rawTokenId,
            marketId,
            venueId: "limitless",
            side: "BUY",
            collateralAsset: ASSET,
            requestedCollateralRaw: "1000000",
          },
        },
      };
      const consentToken = opaque("consent");
      const quote = await createFundingQuoteInTransaction(
        setup,
        quoteInput(userId, plan, consentToken),
      );
      quoteId = quote.id;
      const committed = await commitFundingOperationInTransaction(
        setup,
        commitInput(userId, quote.id, consentToken, plan),
      );
      operationId = committed.operation.id;
      const segment = await setup.query<{ id: string }>(
        `select id from funding_operation_segments
        where operation_id = $1 order by ordinal limit 1`,
        [operationId],
      );
      await ingestFundingObservationInTransaction(setup, {
        discoverySource: "venue_api",
        observation: {
          operationId,
          segmentId: segment.rows[0]?.id ?? null,
          kind: "destination_credit",
          networkId: ASSET.networkId,
          assetId: ASSET.assetId,
          assetDecimals: ASSET.decimals,
          txHash: opaque("destination-tx"),
          eventIndex: "0",
          fromAddress: "0xrouter",
          toAddress: "0xvenue",
          rawAmount: "990000",
          observedAt: new Date(),
          ledgerHeight: "1",
          blockHash: opaque("block"),
          finalityStatus: "finalized",
          finalizedAt: new Date(),
        },
      });
      await reduceFundingOperationInTransaction(setup, { operationId });
      const reservation = await setup.query<{ id: string }>(
        `select id from balance_reservations
        where operation_id = $1 and mode = 'settled_for_consumer'`,
        [operationId],
      );
      reservationId = reservation.rows[0]?.id ?? "";
      assert.ok(reservationId);
      const intent = await setup.query<{ id: string }>(
        `insert into telegram_trade_intents (
         telegram_user_id, user_id, action, venue, market_id, side,
         amount_usd, status, expires_at, idempotency_key,
         funding_operation_id, funding_reservation_id
       ) values ($1, $2, 'buy', 'limitless', $3, 'YES', 1,
                 'executing', now() + interval '30 minutes', $4, $5, $6)
       returning id`,
        [
          opaque("telegram-user"),
          userId,
          marketId,
          opaque("intent"),
          operationId,
          reservationId,
        ],
      );
      intentId = intent.rows[0]?.id ?? "";
      const consumerIntent = buildFundingTradeConsumerIntent({
        venueId: "limitless",
        marketId,
        marketContextId: rawTokenId,
        spend: { asset: ASSET, raw: "1000000" },
      });
      const claim = await claimFundingTradeAttemptInTransaction(setup, {
        userId,
        operationId,
        reservationId,
        venueId: "limitless",
        marketId,
        executionPath: "limitless_clob",
        idempotencyKey: opaque("trade-attempt"),
        canonicalFingerprint: hash("f"),
        consumerIntent,
        externalReference: clientOrderId,
      });
      attemptId = claim.attempt.id;
      attemptClaimToken = claim.attempt.claimToken;
      attemptClaimLeaseUntil = claim.attempt.claimLeaseUntil;
      await markFundingTradeAttemptSubmissionStartedInTransaction(setup, {
        userId,
        operationId,
        reservationId,
        attemptId,
        claimToken: claim.attempt.claimToken,
      });
      const order = await setup.query<{ id: string }>(
        `insert into orders (
         user_id, wallet_address, venue, venue_order_id, token_id, side,
         order_type, price, size, status, filled_size, error_message, raw_error,
         funding_operation_id, funding_reservation_id
       ) values ($1, $2, 'limitless', $3, $4, 'BUY', 'FOK', null, null,
                 'submitted', 0, null, null, $5, $6)
       returning id`,
        [
          userId,
          "0x00000000000000000000000000000000000000b1",
          clientOrderId,
          tokenId,
          operationId,
          reservationId,
        ],
      );
      orderId = order.rows[0]?.id ?? "";
      assert.ok(intentId && attemptId && orderId);
      await setup.query("commit");
    } finally {
      await setup.query("rollback").catch(() => undefined);
      setup.release();
    }

    const takeoverNow = new Date(attemptClaimLeaseUntil.getTime() + 1);
    const crashTakeover = await claimLimitlessTradeAttemptForReconciliation(
      pool,
      {
        attemptId,
        leaseSeconds: 30,
        now: takeoverNow,
        userId,
      },
    );
    assert.ok(crashTakeover);
    assert.notEqual(crashTakeover.claimToken, attemptClaimToken);
    assert.equal(crashTakeover.state, "ambiguous");
    assert.equal(crashTakeover.resolvedAt?.getTime(), takeoverNow.getTime());

    const immediateAbsenceClient = await pool.connect();
    try {
      await immediateAbsenceClient.query("begin");
      await assert.rejects(
        () =>
          proveAmbiguousLimitlessTradeAttemptAbsentInTransaction(
            immediateAbsenceClient,
            {
              attemptId,
              clientOrderId,
              expectedClaimToken: crashTakeover.claimToken,
              minimumAgeMs: 5 * 60_000,
              userId,
              now: new Date(takeoverNow.getTime() + 1),
            },
          ),
        (error: unknown) =>
          error instanceof FundingTradeAttemptError &&
          error.code === "invalid_state",
      );
    } finally {
      await immediateAbsenceClient.query("rollback").catch(() => undefined);
      immediateAbsenceClient.release();
    }

    const matureNow = new Date(takeoverNow.getTime() + 5 * 60_000);
    const matureTakeover = await claimLimitlessTradeAttemptForReconciliation(
      pool,
      {
        attemptId,
        leaseSeconds: 30,
        now: matureNow,
        userId,
      },
    );
    assert.ok(matureTakeover);
    assert.notEqual(matureTakeover.claimToken, crashTakeover.claimToken);
    assert.equal(matureTakeover.resolvedAt?.getTime(), takeoverNow.getTime());

    for (const terminalStatus of ["rejected", "cancelled"] as const) {
      const terminalClient = await pool.connect();
      try {
        await terminalClient.query("begin");
        await proveAmbiguousLimitlessTerminalRejectionInTransaction(
          terminalClient,
          {
            attemptId,
            clientOrderId,
            errorCode: `limitless_exact_status_${terminalStatus}`,
            expectedClaimToken: matureTakeover.claimToken,
            userId,
            now: matureNow,
          },
        );
        await releaseFundingReservationForAbandonedTradeInTransaction(
          terminalClient,
          {
            userId,
            link: { operationId, reservationId },
            outcomeReason: "trade_rejected",
            now: matureNow,
          },
        );
        const terminalOutcome = await terminalClient.query<{
          attempt_state: string;
          reservation_state: string;
        }>(
          `select trade_attempt.state as attempt_state,
                reservation.state as reservation_state
           from funding_trade_attempts trade_attempt
           join balance_reservations reservation
             on reservation.id = trade_attempt.reservation_id
          where trade_attempt.id = $1`,
          [attemptId],
        );
        assert.deepEqual(terminalOutcome.rows[0], {
          attempt_state: "definitive_failure",
          reservation_state: "released",
        });
      } finally {
        await terminalClient.query("rollback").catch(() => undefined);
        terminalClient.release();
      }
    }

    const matureAbsenceClient = await pool.connect();
    try {
      await matureAbsenceClient.query("begin");
      await proveAmbiguousLimitlessTradeAttemptAbsentInTransaction(
        matureAbsenceClient,
        {
          attemptId,
          clientOrderId,
          expectedClaimToken: matureTakeover.claimToken,
          minimumAgeMs: 5 * 60_000,
          userId,
          now: matureNow,
        },
      );
      await releaseFundingReservationForAbandonedTradeInTransaction(
        matureAbsenceClient,
        {
          userId,
          link: { operationId, reservationId },
          outcomeReason: "trade_not_accepted",
          now: matureNow,
        },
      );
      const terminalInsideProof = await matureAbsenceClient.query<{
        attempt_state: string;
        reservation_state: string;
      }>(
        `select trade_attempt.state as attempt_state,
              reservation.state as reservation_state
         from funding_trade_attempts trade_attempt
         join balance_reservations reservation
           on reservation.id = trade_attempt.reservation_id
        where trade_attempt.id = $1`,
        [attemptId],
      );
      assert.deepEqual(terminalInsideProof.rows[0], {
        attempt_state: "definitive_failure",
        reservation_state: "released",
      });
    } finally {
      // Keep the mature lease for the takeover race below while proving that a
      // mature exact absence would release atomically.
      await matureAbsenceClient.query("rollback").catch(() => undefined);
      matureAbsenceClient.release();
    }

    const consumerClient = await pool.connect();
    const proofClient = await pool.connect();
    try {
      await consumerClient.query("begin");
      await proofClient.query("begin");
      await consumerClient.query("set local lock_timeout = '5s'");
      await proofClient.query("set local lock_timeout = '5s'");
      const proof = (async () => {
        try {
          await proveAmbiguousLimitlessTradeAttemptAbsentInTransaction(
            proofClient,
            {
              attemptId,
              clientOrderId,
              expectedClaimToken: attemptClaimToken,
              minimumAgeMs: 1,
              userId,
              now: new Date(matureNow.getTime() + 1),
            },
          );
          await releaseFundingReservationForAbandonedTradeInTransaction(
            proofClient,
            {
              userId,
              link: { operationId, reservationId },
              outcomeReason: "trade_not_accepted",
              now: new Date(matureNow.getTime() + 1),
            },
          );
          await proofClient.query("commit");
        } catch (error) {
          await proofClient.query("rollback");
          throw error;
        }
      })();
      const consume = (async () => {
        await consumeFundingReservationForLinkedConsumerInTransaction(
          consumerClient,
          {
            userId,
            reservationId,
            tradeAttemptId: attemptId,
            tradeAttemptReconciliationClaimToken: matureTakeover.claimToken,
            consumer: { kind: "web_order", orderId },
            outcomeReason: "trade_order_recorded",
            now: new Date(matureNow.getTime() + 1),
          },
        );
        await consumerClient.query("commit");
      })();
      const [proofResult, consumeResult] = await Promise.allSettled([
        proof,
        consume,
      ]);
      assert.equal(proofResult.status, "rejected");
      if (proofResult.status === "rejected") {
        assert.ok(proofResult.reason instanceof FundingTradeAttemptError);
        assert.equal(proofResult.reason.code, "invalid_state");
      }
      assert.equal(consumeResult.status, "fulfilled");
      const outcome = await pool.query<{
        attempt_state: string;
        reservation_state: string;
      }>(
        `select trade_attempt.state as attempt_state,
              reservation.state as reservation_state
         from funding_trade_attempts trade_attempt
         join balance_reservations reservation
           on reservation.id = trade_attempt.reservation_id
        where trade_attempt.id = $1`,
        [attemptId],
      );
      assert.deepEqual(outcome.rows[0], {
        attempt_state: "accepted",
        reservation_state: "consumed",
      });
    } finally {
      await consumerClient.query("rollback").catch(() => undefined);
      await proofClient.query("rollback").catch(() => undefined);
      consumerClient.release();
      proofClient.release();
    }
  } finally {
    if (operationId) {
      await pool.query("delete from orders where funding_operation_id = $1", [
        operationId,
      ]);
      await pool.query(
        "delete from telegram_trade_intents where funding_operation_id = $1",
        [operationId],
      );
      await pool.query(
        "delete from funding_trade_attempts where operation_id = $1",
        [operationId],
      );
    }
    if (quoteId && userId) {
      await cleanupCommittedOperation(operationId || null, quoteId, userId);
    }
    if (tokenId) {
      await pool.query("delete from unified_tokens where token_id = $1", [
        tokenId,
      ]);
    }
    if (eventId) {
      await pool.query("delete from unified_events where id = $1", [eventId]);
    }
  }
}

async function testTelegramAppHandoffV2DirectTradeBinding(): Promise<void> {
  const client = await pool.connect();
  await client.query("begin");
  try {
    const userId = await insertUser(client);
    const telegramUserId = `handoff-direct-${crypto.randomUUID()}`;
    const privyUserId = `did:privy:handoff-direct-${crypto.randomUUID()}`;
    await client.query(
      `insert into user_telegram_accounts (
         user_id, privy_user_id, telegram_user_id
       ) values ($1::uuid, $2, $3)`,
      [userId, privyUserId, telegramUserId],
    );
    const eventId = opaque("handoff-direct-event");
    const marketId = `polymarket:${opaque("handoff-direct-market")}`;
    await client.query(
      `insert into unified_events (
         id, venue, venue_event_id, title, status, end_date
       ) values ($1, 'polymarket', $2, 'Direct handoff event', 'ACTIVE', now() + interval '1 day')`,
      [eventId, opaque("handoff-direct-venue-event")],
    );
    await client.query(
      `insert into unified_markets (
         id, venue, venue_market_id, event_id, title, status, market_type
       ) values ($1, 'polymarket', $2, $3, 'Direct handoff market', 'ACTIVE', 'binary')`,
      [marketId, opaque("handoff-direct-venue-market"), eventId],
    );

    const handoffId = crypto.randomUUID();
    const intentId = crypto.randomUUID();
    const fingerprint = hash("d");
    const outcomeTokenId = "123456789";
    const planSnapshot = {
      executionContractVersion: 2,
      kind: "direct_trade",
      trade: {
        action: "buy",
        amountUsd: 5,
        controllerWalletAddress: "0x00000000000000000000000000000000000000d1",
        eventId,
        marketId,
        maxSlippageBps: 500,
        maxSpendUsd: 5.25,
        minReceiveShares: 8,
        outcomeTokenId,
        side: "YES",
        venue: "polymarket",
      },
      version: 2,
    };
    await client.query(
      `insert into telegram_trade_intents (
         id, telegram_user_id, user_id, action, venue, market_id, event_id,
         side, amount_usd, delivery_mode, status, result, expires_at,
         idempotency_key
       ) values (
         $1::uuid, $2, $3::uuid, 'buy', 'polymarket', $4, $5, 'YES', 5,
         'app_handoff', 'external_handoff', $6::jsonb,
         clock_timestamp() + interval '10 minutes', $7
       )`,
      [
        intentId,
        telegramUserId,
        userId,
        marketId,
        eventId,
        JSON.stringify({
          appHandoffExecution: {
            committedAt: new Date().toISOString(),
            handoffId,
            version: 2,
          },
        }),
        `handoff-direct-intent:${crypto.randomUUID()}`,
      ],
    );
    await client.query(
      `insert into telegram_app_handoffs (
         id, trade_intent_id, user_id, telegram_user_id, token_hash, state,
         plan_fingerprint, policy_revision, authority_fingerprint,
         quote_snapshot, plan_snapshot, expires_at, claimed_at,
         claimed_by_user_id, committed_at
       ) values (
         $1::uuid, $2::uuid, $3::uuid, $4, $5, 'committed', $6,
         'policy-direct', $7, '{}'::jsonb, $8::jsonb,
         clock_timestamp() + interval '10 minutes', clock_timestamp(),
         $3::uuid, clock_timestamp()
       )`,
      [
        handoffId,
        intentId,
        userId,
        telegramUserId,
        hash("b"),
        fingerprint,
        hash("a"),
        JSON.stringify(planSnapshot),
      ],
    );
    const handoffProjection = await loadTelegramAppHandoffProjection(
      client as never,
      {
        telegramUserId,
        tradeIntentId: intentId,
        userId,
      },
    );
    assert.equal(
      handoffProjection?.stage,
      "attaching",
      "v2 projection query must parse against the real handoff schema",
    );
    const binding = { handoffId, planFingerprint: fingerprint } as const;
    const assertCurrentScope: TelegramAppHandoffV2ScopeAssertion = async (
      sealed,
    ) => {
      assert.notEqual(
        sealed.db,
        client,
        "the scope fence receives a query-only view, not reconnectable PoolClient",
      );
      const scopedIntent = await sealed.db.query<{ id: string }>(
        "select id::text from telegram_trade_intents where id = $1::uuid",
        [sealed.tradeIntentId],
      );
      assert.equal(scopedIntent.rows[0]?.id, sealed.tradeIntentId);
      return true;
    };
    const reconcileKeys = {
      orderHash: `0x${"ab".repeat(32)}`,
      tradeType: "clob" as const,
    };
    const venueOrderId = `handoff-direct-order:${crypto.randomUUID()}`;
    const submission = {
      executionKind: "clob" as const,
      marketId,
      outcomeTokenId,
      receiveRaw: "8000000",
      signer: "0x00000000000000000000000000000000000000d1",
      spendRaw: "5000000",
      venue: "polymarket" as const,
    };
    const recoveryPayload = {
      action: "BUY",
      exchangeAddress: "0x00000000000000000000000000000000000000e1",
      feePolicySnapshot: null,
      kind: "polymarket",
      orderHash: reconcileKeys.orderHash,
      orderPayload: { recovered: true },
      orderType: "FOK",
      positionWalletAddress: submission.signer,
      price: 0.625,
      requiredSpendRaw: submission.spendRaw,
      size: 8,
      tokenId: submission.outcomeTokenId,
    };
    await client.query("savepoint direct_handoff_rejection");
    await claimTelegramAppHandoffV2DirectTradeSubmissionInTransaction(client, {
      assertCurrentScope,
      binding,
      reconcileKeys,
      recoveryPayload,
      submission,
      userId,
    });
    const claimedSnapshot = await client.query<{
      recovery_payload: { orderHash?: string } | null;
    }>(
      `select prepared_snapshot -> 'recoveryPayload' as recovery_payload
         from telegram_trade_intents
        where id = $1::uuid`,
      [intentId],
    );
    assert.equal(
      claimedSnapshot.rows[0]?.recovery_payload?.orderHash,
      reconcileKeys.orderHash,
      "direct handoff records its recovery payload before provider submission",
    );
    await failTelegramAppHandoffV2DirectTradeSubmissionInTransaction(client, {
      binding,
      reason: {
        code: "polymarket_trade_rejected",
        message: "Polymarket rejected the sealed Buy before accepting it.",
      },
      submission,
      userId,
    });
    await failTelegramAppHandoffV2DirectTradeSubmissionInTransaction(client, {
      binding,
      reason: {
        code: "polymarket_trade_rejected",
        message: "Polymarket rejected the sealed Buy before accepting it.",
      },
      submission,
      userId,
    });
    const rejected = await client.query<{
      error_code: string | null;
      status: string;
    }>(
      `select error_code, status
         from telegram_trade_intents
        where id = $1::uuid`,
      [intentId],
    );
    assert.equal(rejected.rows[0]?.status, "failed");
    assert.equal(rejected.rows[0]?.error_code, "polymarket_trade_rejected");
    await client.query("rollback to savepoint direct_handoff_rejection");
    await claimTelegramAppHandoffV2DirectTradeSubmissionInTransaction(client, {
      assertCurrentScope,
      binding,
      reconcileKeys,
      recoveryPayload,
      submission,
      userId,
    });
    const stored = await storeOrderInTransaction(client, {
      userId,
      walletAddress: "0x00000000000000000000000000000000000000d1",
      venue: "polymarket",
      venueOrderId,
      tokenId: outcomeTokenId,
      side: "BUY",
      price: 0.6,
      size: 8,
      status: "matched",
      errorMessage: null,
      rawError: null,
      telegramAppHandoffV2DirectTrade: { ...binding, ...submission },
    });
    const linked = await client.query<{
      order_id: string | null;
      status: string;
      venue_order_id: string | null;
    }>(
      `select order_id::text, status, venue_order_id
         from telegram_trade_intents
        where id = $1::uuid`,
      [intentId],
    );
    assert.equal(linked.rows[0]?.order_id, stored.order.id);
    assert.equal(linked.rows[0]?.status, "filled");
    assert.equal(linked.rows[0]?.venue_order_id, venueOrderId);
    const replay = await storeOrderInTransaction(client, {
      userId,
      walletAddress: "0x00000000000000000000000000000000000000d1",
      venue: "polymarket",
      venueOrderId,
      tokenId: outcomeTokenId,
      side: "BUY",
      price: 0.6,
      size: 8,
      status: "matched",
      errorMessage: null,
      rawError: null,
      telegramAppHandoffV2DirectTrade: { ...binding, ...submission },
    });
    assert.equal(replay.order.id, stored.order.id);
    await assert.rejects(
      claimTelegramAppHandoffV2DirectTradeSubmissionInTransaction(client, {
        assertCurrentScope,
        binding,
        reconcileKeys,
        recoveryPayload,
        submission,
        userId,
      }),
      /intent_changed/u,
    );

    const sellIntentId = crypto.randomUUID();
    const sellHandoffId = crypto.randomUUID();
    const sellFingerprint = hash("c");
    const sellPlanSnapshot = {
      executionContractVersion: 2,
      kind: "direct_trade",
      trade: {
        action: "sell",
        controllerWalletAddress: "0x00000000000000000000000000000000000000d1",
        eventId,
        marketId,
        maxSlippageBps: 500,
        minimumReceiveRaw: "1200000",
        outcomeTokenId,
        sharesRaw: "5000000",
        side: "YES",
        venue: "polymarket",
      },
      version: 2,
    };
    await client.query(
      `insert into telegram_trade_intents (
         id, telegram_user_id, user_id, action, venue, market_id, event_id,
         side, shares_raw, delivery_mode, status, result, expires_at,
         idempotency_key
       ) values (
         $1::uuid, $2, $3::uuid, 'sell', 'polymarket', $4, $5, 'YES',
         '5000000', 'app_handoff', 'external_handoff', $6::jsonb,
         clock_timestamp() + interval '10 minutes', $7
       )`,
      [
        sellIntentId,
        telegramUserId,
        userId,
        marketId,
        eventId,
        JSON.stringify({
          appHandoffExecution: {
            committedAt: new Date().toISOString(),
            handoffId: sellHandoffId,
            kind: "direct_trade",
            version: 2,
          },
        }),
        `handoff-direct-sell:${crypto.randomUUID()}`,
      ],
    );
    await client.query(
      `insert into telegram_app_handoffs (
         id, trade_intent_id, user_id, telegram_user_id, token_hash, state,
         plan_fingerprint, policy_revision, authority_fingerprint,
         quote_snapshot, plan_snapshot, expires_at, claimed_at,
         claimed_by_user_id, committed_at
       ) values (
         $1::uuid, $2::uuid, $3::uuid, $4, $5, 'committed', $6,
         'policy-direct', $7, '{}'::jsonb, $8::jsonb,
         clock_timestamp() + interval '10 minutes', clock_timestamp(),
         $3::uuid, clock_timestamp()
       )`,
      [
        sellHandoffId,
        sellIntentId,
        userId,
        telegramUserId,
        hash("d"),
        sellFingerprint,
        hash("e"),
        JSON.stringify(sellPlanSnapshot),
      ],
    );
    const sellSubmission = {
      action: "sell" as const,
      executionKind: "clob" as const,
      marketId,
      outcomeTokenId,
      receiveRaw: "1200000",
      signer: "0x00000000000000000000000000000000000000d1",
      spendRaw: "5000000",
      venue: "polymarket" as const,
    };
    await assert.rejects(
      claimTelegramAppHandoffV2DirectTradeSubmissionInTransaction(client, {
        assertCurrentScope,
        binding: { handoffId: sellHandoffId, planFingerprint: sellFingerprint },
        reconcileKeys: {
          orderHash: `0x${"ce".repeat(32)}`,
          tradeType: "clob",
        },
        recoveryPayload: {
          kind: "polymarket",
          orderPayload: { rejected: true },
        },
        submission: { ...sellSubmission, spendRaw: "4000000" },
        readSellPositionAvailableRaw: async () => "5000000",
        userId,
      }),
      /order_out_of_scope/u,
      "a sealed Sell must submit the exact reviewed share quantity",
    );
    await claimTelegramAppHandoffV2DirectTradeSubmissionInTransaction(client, {
      assertCurrentScope,
      binding: { handoffId: sellHandoffId, planFingerprint: sellFingerprint },
      reconcileKeys: {
        orderHash: `0x${"cd".repeat(32)}`,
        tradeType: "clob",
      },
      recoveryPayload: {
        kind: "polymarket",
        orderPayload: { recovered: true },
      },
      readSellPositionAvailableRaw: async () => "5000000",
      submission: sellSubmission,
      userId,
    });
    // A prior direct Sell has no order row until its provider call returns.
    // The second claim must still reserve that exact outcome-token debit, or
    // two Mini App tabs could spend the same shares before persistence catches
    // up.
    const competingSellIntentId = crypto.randomUUID();
    const competingSellHandoffId = crypto.randomUUID();
    const competingSellFingerprint = hash("f");
    await client.query(
      `insert into telegram_trade_intents (
         id, telegram_user_id, user_id, action, venue, market_id, event_id,
         side, shares_raw, delivery_mode, status, result, expires_at,
         idempotency_key
       ) values (
         $1::uuid, $2, $3::uuid, 'sell', 'polymarket', $4, $5, 'YES',
         '5000000', 'app_handoff', 'external_handoff', $6::jsonb,
         clock_timestamp() + interval '10 minutes', $7
       )`,
      [
        competingSellIntentId,
        telegramUserId,
        userId,
        marketId,
        eventId,
        JSON.stringify({
          appHandoffExecution: {
            committedAt: new Date().toISOString(),
            handoffId: competingSellHandoffId,
            kind: "direct_trade",
            version: 2,
          },
        }),
        `handoff-direct-sell-competing:${crypto.randomUUID()}`,
      ],
    );
    await client.query(
      `insert into telegram_app_handoffs (
         id, trade_intent_id, user_id, telegram_user_id, token_hash, state,
         plan_fingerprint, policy_revision, authority_fingerprint,
         quote_snapshot, plan_snapshot, expires_at, claimed_at,
         claimed_by_user_id, committed_at
       ) values (
         $1::uuid, $2::uuid, $3::uuid, $4, $5, 'committed', $6,
         'policy-direct', $7, '{}'::jsonb, $8::jsonb,
         clock_timestamp() + interval '10 minutes', clock_timestamp(),
         $3::uuid, clock_timestamp()
       )`,
      [
        competingSellHandoffId,
        competingSellIntentId,
        userId,
        telegramUserId,
        hash("a"),
        competingSellFingerprint,
        hash("b"),
        JSON.stringify(sellPlanSnapshot),
      ],
    );
    await assert.rejects(
      claimTelegramAppHandoffV2DirectTradeSubmissionInTransaction(client, {
        assertCurrentScope,
        binding: {
          handoffId: competingSellHandoffId,
          planFingerprint: competingSellFingerprint,
        },
        reconcileKeys: {
          orderHash: `0x${"cf".repeat(32)}`,
          tradeType: "clob",
        },
        recoveryPayload: { kind: "polymarket", orderPayload: {} },
        readSellPositionAvailableRaw: async () => "5000000",
        submission: sellSubmission,
        userId,
      }),
      /sell_position_unavailable/u,
      "unpersisted direct Sell claims must consume the same position lane",
    );
    // Ordinary order persistence is the durable direct-handoff consumer. It
    // must accept the sealed SELL side exactly as it accepts the existing Buy
    // branch; roll it back so the rejection path below remains independently
    // covered by this same fixture.
    await client.query("savepoint direct_handoff_sell_order");
    const sellStored = await storeOrderInTransaction(client, {
      userId,
      walletAddress: "0x00000000000000000000000000000000000000d1",
      venue: "polymarket",
      venueOrderId: `handoff-direct-sell-order:${crypto.randomUUID()}`,
      tokenId: outcomeTokenId,
      side: "SELL",
      price: 0.24,
      size: 5,
      status: "matched",
      errorMessage: null,
      rawError: null,
      telegramAppHandoffV2DirectTrade: {
        ...binding,
        handoffId: sellHandoffId,
        planFingerprint: sellFingerprint,
        ...sellSubmission,
      },
    });
    assert.equal(sellStored.order.status, "matched");
    const sellLinked = await client.query<{ status: string }>(
      `select status
         from telegram_trade_intents
        where id = $1::uuid`,
      [sellIntentId],
    );
    assert.equal(sellLinked.rows[0]?.status, "filled");
    await client.query("rollback to savepoint direct_handoff_sell_order");
    await failTelegramAppHandoffV2DirectTradeSubmissionInTransaction(client, {
      binding: { handoffId: sellHandoffId, planFingerprint: sellFingerprint },
      reason: { code: "sell_rejected", message: "Sealed Sell was rejected." },
      submission: sellSubmission,
      userId,
    });
    const sellTerminal = await client.query<{ status: string }>(
      `select status from telegram_trade_intents where id = $1::uuid`,
      [sellIntentId],
    );
    assert.equal(sellTerminal.rows[0]?.status, "failed");
    await client.query("savepoint reject_invalid_sell_handoff_state");
    await assert.rejects(
      client.query(
        `update telegram_trade_intents
            set status = 'funding'
          where id = $1::uuid`,
        [sellIntentId],
      ),
      (error: unknown) =>
        error instanceof Error &&
        "constraint" in error &&
        error.constraint === "telegram_trade_intents_delivery_authority_check",
      "Sell cannot enter a funding state",
    );
    await client.query(
      "rollback to savepoint reject_invalid_sell_handoff_state",
    );
  } finally {
    await client.query("rollback");
    client.release();
  }
}

/**
 * A committed v2 direct handoff can be cancelled before its venue boundary.
 * This uses the actual PostgreSQL schema because both the immutable handoff
 * lifecycle and the linked intent cancellation are money-path boundaries.
 */
async function testTelegramAppHandoffV2CommittedCancellationStopsLinkedBuy(): Promise<void> {
  const userId = crypto.randomUUID();
  const handoffId = crypto.randomUUID();
  const intentId = crypto.randomUUID();
  const webFundingPreviewIntentId = crypto.randomUUID();
  const telegramUserId = (
    9_000_000_000_000_000_000n + BigInt(crypto.randomInt(1_000_000))
  ).toString();
  const privyUserId = `did:privy:handoff-cancel-${crypto.randomUUID()}`;
  const eventId = opaque("handoff-cancel-event");
  const marketId = `polymarket:${opaque("handoff-cancel-market")}`;
  const token = `th1_${crypto.randomBytes(32).toString("base64url")}`;
  const client = await pool.connect();
  try {
    await client.query(
      `insert into users (id, email, is_active, is_verified)
       values ($1::uuid, $2, true, true)`,
      [userId, `funding-cancel-${crypto.randomUUID()}@example.com`],
    );
    await client.query(
      `insert into user_telegram_accounts (
         user_id, privy_user_id, telegram_user_id
       ) values ($1::uuid, $2, $3)`,
      [userId, privyUserId, telegramUserId],
    );
    await client.query(
      `insert into unified_events (
         id, venue, venue_event_id, title, status, end_date
       ) values ($1, 'polymarket', $2, 'Cancellation event', 'ACTIVE', now() + interval '1 day')`,
      [eventId, opaque("handoff-cancel-venue-event")],
    );
    await client.query(
      `insert into unified_markets (
         id, venue, venue_market_id, event_id, title, status, market_type
       ) values ($1, 'polymarket', $2, $3, 'Cancellation market', 'ACTIVE', 'binary')`,
      [marketId, opaque("handoff-cancel-venue-market"), eventId],
    );
    await client.query(
      `insert into telegram_trade_intents (
         id, telegram_user_id, user_id, action, venue, market_id, event_id,
         side, amount_usd, delivery_mode, status, result, expires_at,
         idempotency_key
       ) values (
         $1::uuid, $2, $3::uuid, 'buy', 'polymarket', $4, $5, 'YES', 1,
         'app_handoff', 'external_handoff', '{}'::jsonb,
         clock_timestamp() + interval '10 minutes', $6
       )`,
      [
        intentId,
        telegramUserId,
        userId,
        marketId,
        eventId,
        `handoff-cancel-intent:${crypto.randomUUID()}`,
      ],
    );
    await client.query(
      `insert into telegram_trade_intents (
         id, telegram_user_id, user_id, action, venue, market_id, event_id,
         side, amount_usd, delivery_mode, status, result, expires_at,
         idempotency_key
       ) values (
         $1::uuid, $2, $3::uuid, 'buy', 'polymarket', $4, $5, 'YES', 1,
         'app_handoff', 'previewed',
         jsonb_build_object(
           'appHandoffV2', jsonb_build_object('version', 2, 'plan', '{}'::jsonb),
           'fundingState', 'web_funding_plan'
         ),
         clock_timestamp() + interval '10 minutes', $6
       )`,
      [
        webFundingPreviewIntentId,
        telegramUserId,
        userId,
        marketId,
        eventId,
        `handoff-web-funding-preview:${crypto.randomUUID()}`,
      ],
    );
    const confirmedWebFundingPreview = await client.query<{ status: string }>(
      `update telegram_trade_intents
          set status = 'confirming'
        where id = $1::uuid
        returning status`,
      [webFundingPreviewIntentId],
    );
    assert.equal(
      confirmedWebFundingPreview.rows[0]?.status,
      "confirming",
      "a v2 web funding plan must reach its normal Telegram confirmation card",
    );
    await client.query(
      `insert into telegram_app_handoffs (
         id, trade_intent_id, user_id, telegram_user_id, token_hash, state,
         plan_fingerprint, policy_revision, authority_fingerprint,
         quote_snapshot, plan_snapshot, expires_at, claimed_at,
         claimed_by_user_id, committed_at
       ) values (
         $1::uuid, $2::uuid, $3::uuid, $4, $5, 'committed', $6,
         'policy-cancel', $7, '{}'::jsonb, $8::jsonb,
         clock_timestamp() + interval '10 minutes', clock_timestamp(),
         $3::uuid, clock_timestamp()
       )`,
      [
        handoffId,
        intentId,
        userId,
        telegramUserId,
        hashOpaqueToken(token),
        hash("a"),
        hash("b"),
        JSON.stringify({
          executionContractVersion: 2,
          kind: "direct_trade",
          trade: { action: "buy" },
          version: 2,
        }),
      ],
    );
    const cancelled = await cancelTelegramAppHandoff({
      db: pool,
      telegramUserId,
      token,
      userId,
    });
    assert.equal(cancelled.state, "cancelled");
    const intent = await client.query<{ status: string }>(
      `select status from telegram_trade_intents where id = $1::uuid`,
      [intentId],
    );
    assert.equal(
      intent.rows[0]?.status,
      "cancelled",
      "v2 handoff cancellation must stop the future Buy, not only revoke its token",
    );
    assert.equal(
      (
        await resolveTelegramAppHandoff({
          db: pool,
          telegramUserId,
          token,
          userId,
        })
      ).state,
      "cancelled",
      "a cancelled v2 handoff stays observable for Mini App resume",
    );
  } finally {
    await client.query(
      `delete from telegram_app_handoffs where id = $1::uuid`,
      [handoffId],
    );
    await client.query(
      `delete from telegram_trade_intents where id = $1::uuid`,
      [intentId],
    );
    await client.query(
      `delete from telegram_trade_intents where id = $1::uuid`,
      [webFundingPreviewIntentId],
    );
    await client.query(`delete from unified_markets where id = $1`, [marketId]);
    await client.query(`delete from unified_events where id = $1`, [eventId]);
    await client.query(
      `delete from user_telegram_accounts where user_id = $1::uuid`,
      [userId],
    );
    await client.query(`delete from users where id = $1::uuid`, [userId]);
    client.release();
  }
}

await testConcurrentPreparationRunReplay();
console.log(
  "[funding-persistence-integration-tests] ok concurrent preparation replay, report idempotency, and reconcile",
);
await testSubmittedPreparationRunSelfHealing();
console.log(
  "[funding-persistence-integration-tests] ok submitted preparation read and replay self-healing",
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
await testRecentBroadcastRecoveryUsesActiveReceiptCadence();
console.log(
  "[funding-persistence-integration-tests] ok recent Base, Polygon, and Solana broadcasts retain a bounded active receipt cadence during automatic recovery",
);
await testLateCanonicalFailureRearmsRetryAndKeepsReorgWatch();
console.log(
  "[funding-persistence-integration-tests] ok late canonical failure exits automatic recovery, re-arms only the retry, and remains reorg-watched through action expiry",
);
await testUnresolvedExternalHandoffReorgBecomesManualReview();
console.log(
  "[funding-persistence-integration-tests] ok unresolved external-handoff receipt reorg becomes bounded manual review",
);
await testReconciliationBatchClaimsOnlyRunnableWave();
console.log(
  "[funding-persistence-integration-tests] ok reconciliation batch claims bounded concurrent waves without reclaiming its own requeues",
);
await testOlderFailedAttemptCannotRearmNewerBroadcast();
console.log(
  "[funding-persistence-integration-tests] ok an older failed attempt cannot rearm a newer broadcast, while a reorg still stops it",
);
await testOwnedRouteCompetitionQueryParses();
console.log(
  "[funding-persistence-integration-tests] ok owned-route competition query parses",
);
await testAutomaticRecoveryAcceptsLateDestinationEvidence();
console.log(
  "[funding-persistence-integration-tests] ok automatic recovery accepts late owned-destination evidence idempotently",
);
await testHistoricalReadyAndUnexposedRecoveryRoutesDoNotBlockDestinationObservation();
console.log(
  "[funding-persistence-integration-tests] ok historical ready and unexposed recovery routes do not block destination observation",
);
await testActionWaitUsesIdleReconciliationWithoutExternalPolling();
console.log(
  "[funding-persistence-integration-tests] ok action wait skips external polling, uses idle cadence, wakes on report, and mixed work remains active",
);
await testExpiredUnbroadcastActionWaitCancelsSafely();
console.log(
  "[funding-persistence-integration-tests] ok expired unbroadcast action wait cancels and releases reservations without external polling",
);
await testDepositWalletHandoffKeepsItsOwnActionTtl();
console.log(
  "[funding-persistence-integration-tests] ok Deposit Wallet handoff keeps its own action TTL",
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
await testFundedTradeTerminalLockRace();
console.log(
  "[funding-persistence-integration-tests] ok funded trade consume versus absence-proof race has one authoritative outcome",
);
await testTelegramAppHandoffV2DirectTradeBinding();
console.log(
  "[funding-persistence-integration-tests] ok v2 direct handoff claim and atomic order binding",
);
await testTelegramAppHandoffV2CommittedCancellationStopsLinkedBuy();
console.log(
  "[funding-persistence-integration-tests] ok committed v2 handoff cancellation stops its linked future Buy",
);
console.log("[funding-persistence-integration-tests] complete");
