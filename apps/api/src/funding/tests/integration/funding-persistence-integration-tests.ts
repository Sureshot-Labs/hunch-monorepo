#!/usr/bin/env tsx

// @api-integration

import assert from "node:assert/strict";
import crypto from "node:crypto";

import type { PoolClient } from "pg";

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
  fetchFundingOperationForUser,
  finishFundingReconciliationLease,
  FundingPersistenceError,
  releaseFundingReservationInTransaction,
  renewFundingReconciliationLease,
  transitionFundingOperationInTransaction,
  wakeFundingReconciliationInTransaction,
  type FundingCommitInput,
  type FundingCommitPlan,
  type FundingQuoteInsert,
} from "../../persistence/funding-operation-repository.js";
import { ingestFundingObservationInTransaction } from "../../reconciliation/funding-observation-ingestion.js";
import { reduceFundingOperationInTransaction } from "../../reconciliation/funding-reducer.js";

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
  } = {},
): FundingCommitPlan {
  const planKind = input.planKind ?? "wallet_route";
  const sourceSnapshot = {
    componentId: opaque("component"),
    locationId: opaque("source-location"),
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
          ? { marketId: input.marketId, venueId: input.venueId }
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
  if (operationId) {
    await pool.query(
      "delete from funding_reconciliation_jobs where operation_id = $1",
      [operationId],
    );
    await pool.query(
      "delete from balance_reservations where operation_id = $1",
      [operationId],
    );
    await pool.query(
      "delete from funding_operation_steps where operation_id = $1",
      [operationId],
    );
    await pool.query(
      "delete from funding_operation_segments where operation_id = $1",
      [operationId],
    );
    await pool.query("delete from funding_operations where id = $1", [
      operationId,
    ]);
  }
  await pool.query("delete from funding_quotes where id = $1", [quoteId]);
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
    const marketId = opaque("market");
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
      [marketId, opaque("venue-market"), eventId],
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
    const reservationBId = reservationB.rows[0]?.id;
    assert.ok(reservationBId);
    assert.equal(reservationB.rows[0]?.raw_amount, "990000");
    assert.deepEqual(
      await assertFundingReservationReadyForTrade(client as never, {
        userId: userB,
        link: {
          operationId: committedB.operation.id,
          reservationId: reservationBId,
        },
        venue: "polymarket",
        marketId,
      }),
      {
        rawAmount: "990000",
        expiresAt: reservationB.rows[0]?.expires_at,
      },
    );
    await expectFundingError(
      assertFundingReservationReadyForTrade(client as never, {
        userId: userB,
        link: {
          operationId: committedB.operation.id,
          reservationId: reservationBId,
        },
        venue: "polymarket",
        marketId: null,
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
    const executionInput = {
      userId: userB,
      walletAddress: "0x00000000000000000000000000000000000000b1",
      venue: "polymarket",
      unifiedMarketId: marketId,
      side: "BUY",
      status: "confirmed",
      txSignature: opaque("trade-execution"),
      fundingReservation: {
        operationId: committedB.operation.id,
        reservationId: reservationBId,
      },
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
    assert.equal(workerA.length, 1);
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

await testConcurrentCommitReplay();
console.log(
  "[funding-persistence-integration-tests] ok concurrent exact replay",
);
await testAtomicRollbackAfterPartialInsert();
console.log(
  "[funding-persistence-integration-tests] ok atomic rollback after partial insert",
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
