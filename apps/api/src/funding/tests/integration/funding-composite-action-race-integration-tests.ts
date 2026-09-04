#!/usr/bin/env tsx

// @requires-db

import assert from "node:assert/strict";
import crypto from "node:crypto";

import { tx } from "@hunch/infra";

import "../../../integration-test-database-guard.js";
import { pool } from "../../../db.js";
import { storeOrderInTransaction } from "../../../repos/orders-repo.js";
import { claimTelegramAppHandoffV2FundedTradeAttemptInTransaction } from "../../../repos/telegram-app-handoff-v2-direct-trade-repository.js";
import { canonicalJsonHash } from "../../persistence/canonical.js";
import {
  finishFundingStepAttemptForUserInTransaction,
  startFundingStepAttemptForUser,
  startFundingStepAttemptForUserInTransaction,
} from "../../persistence/funding-evidence-repository.js";
import {
  advanceFundingObservationFinalityInTransaction,
  allocateFundingObservationInTransaction,
  commitFundingOperation,
  createFundingQuote,
  FundingPersistenceError,
  type FundingCommitPlan,
} from "../../persistence/funding-operation-repository.js";
import {
  markFundingTradeAttemptSubmissionStartedInTransaction,
  recordFundingTradeAttemptOutcomeInTransaction,
} from "../../persistence/funding-trade-attempt-repository.js";
import { buildFundingTradeConsumerIntent } from "../../persistence/funding-trade-consumer-intent.js";
import { cancelFundingOperationForUser } from "../../reconciliation/funding-operation-cancellation.js";
import {
  reduceFundingOperation,
  reduceFundingOperationInTransaction,
  runFundingReconciliationBatch,
} from "../../reconciliation/funding-reducer.js";

const asset = {
  networkId: "evm:137",
  assetId: "0x0000000000000000000000000000000000000001",
  decimals: 6,
} as const;
const opaque = (prefix: string) => `${prefix}_${crypto.randomUUID()}`;
const digest = (value: string) =>
  crypto.createHash("sha256").update(value).digest("hex");

const userResult = await pool.query<{ id: string }>(
  `insert into users (email, is_active, is_verified)
   values ($1, true, true)
   returning id`,
  [`funding-composite-race-${crypto.randomUUID()}@example.com`],
);
const userId = userResult.rows[0]?.id;
if (!userId) throw new Error("race test user insert failed");

const source = (ordinal: number) => ({
  kind: "wallet" as const,
  locationId: opaque(`source_${ordinal}`),
  accountId: userId,
  asset,
  details: {
    walletId: opaque(`wallet_${ordinal}`),
    address: `0x${String(ordinal + 1).padStart(40, "0")}`,
  },
});
function makePlan(): FundingCommitPlan {
  const sources = [source(0), source(1)] as const;
  const actions = sources.map((location, ordinal) => ({
    kind: "evm_transaction" as const,
    actionId: opaque(`action_${ordinal}`),
    networkId: asset.networkId,
    senderWalletId: location.details.walletId,
    to: "0x00000000000000000000000000000000000000b1",
    data: "0x",
    valueRaw: "0",
    gasLimitRaw: "21000",
  }));
  const destination = {
    ...sources[0],
    locationId: opaque("destination"),
  };
  return {
    operation: {
      purpose: "add_funds",
      initialState: { status: "in_progress", stage: "committed" },
      experienceMode: "prepare_first",
      planKind: "composite_route",
      sourceSnapshot: { kind: "composite", legCount: 2 },
      destinationTargetSnapshot: {
        kind: "owned_location",
        location: destination,
      },
      externalRecipientId: null,
      venueId: "polymarket",
      marketId: null,
      marketContextSnapshot: null,
      venueBindingSnapshot: null,
      walletExecutionSnapshot: null,
      placementSnapshot: {},
      requestedSourceAmount: null,
      requestedDestinationAmount: { asset, raw: "1980000" },
      supportMetadata: { test: true },
    },
    segments: sources.map((location, ordinal) => ({
      providerId: "relay",
      adapterId: "relay_quote_v2",
      adapterVersion: 1,
      segmentKind: "same_network_swap" as const,
      status: "planned" as const,
      sourceSnapshot: { kind: "owned_location", location },
      destinationTargetSnapshot: {
        kind: "owned_location",
        location: destination,
      },
      quotedInput: { asset, raw: "1000000" },
      quotedExpectedOutput: { asset, raw: "995000" },
      quotedMinOutput: { asset, raw: "990000" },
      providerQuoteRefCiphertext: `ciphertext:race:${ordinal}`,
      providerQuoteRefLookupHmac: digest(`race:${ordinal}`),
      depositAddressCiphertext: null,
      depositAddressLookupHmac: null,
      lookupKeyVersion: 1,
      refundLocationSnapshot: location,
      quoteExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    })),
    steps: actions.map((action, ordinal) => ({
      ordinal,
      segmentOrdinal: ordinal,
      stepKind: "transaction" as const,
      state: "action_required" as const,
      actionFingerprint: canonicalJsonHash(action),
      executorId: "wallet_profile_evm_v1",
      payerRequirement: "user" as const,
      dependsOnOrdinal: null,
      normalizedAction: action,
      actionValidationResult: { valid: true },
    })),
    reservations: sources.map((location, ordinal) => ({
      segmentOrdinal: ordinal,
      componentId: opaque(`component_${ordinal}`),
      locationId: location.locationId,
      networkId: asset.networkId,
      assetId: asset.assetId,
      assetDecimals: asset.decimals,
      rawAmount: "1000000",
      mode: "subtract_available" as const,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })),
  };
}

const plan = makePlan();

const consentToken = opaque("consent");
const quote = await createFundingQuote(pool, {
  userId,
  discoveryProjectionId: opaque("projection"),
  selectedSourceOptionSnapshot: plan.operation.sourceSnapshot ?? {},
  marketContextSnapshot: null,
  destinationOptionSnapshot: plan.operation.destinationTargetSnapshot,
  venueBindingSnapshot: null,
  planSnapshot: plan,
  policyVersion: 1,
  policyRevision: "policy_composite_race_v1",
  canonicalRequest: { source: plan.operation.sourceSnapshot },
  consentToken,
  expiresAt: new Date(Date.now() + 60_000),
});
const committed = await commitFundingOperation(pool, {
  userId,
  quoteId: quote.id,
  consentToken,
  idempotencyKey: opaque("idempotency"),
  plan,
  subjectLookupHmac: digest("race-user"),
  subjectLookupKeyVersion: 1,
});
const stepResult = await pool.query<{
  action_fingerprint: string;
  executor_id: string;
  id: string;
}>(
  `select id, action_fingerprint, executor_id
     from funding_operation_steps
    where operation_id = $1
    order by ordinal`,
  [committed.operation.id],
);
const firstStep = stepResult.rows[0];
const siblingStep = stepResult.rows[1];
assert.ok(firstStep);
assert.ok(siblingStep);

// Durable attempt evidence is append-only by schema. This test runs only on an
// explicitly named disposable database, whose lifecycle owns fixture cleanup.
{
  const firstAttempt = await startFundingStepAttemptForUser(pool, {
    userId,
    operationId: committed.operation.id,
    stepId: firstStep.id,
    canonicalActionFingerprint: firstStep.action_fingerprint,
    executorId: firstStep.executor_id,
  });
  const reportClient = await pool.connect();
  const startClient = await pool.connect();
  try {
    await reportClient.query("begin");
    await reportClient.query(
      "select id from funding_operations where id = $1 for update",
      [committed.operation.id],
    );
    await startClient.query("begin");
    await startClient.query("set local lock_timeout = '5s'");
    const siblingStart = startFundingStepAttemptForUserInTransaction(
      startClient,
      {
        userId,
        operationId: committed.operation.id,
        stepId: siblingStep.id,
        canonicalActionFingerprint: siblingStep.action_fingerprint,
        executorId: siblingStep.executor_id,
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    await finishFundingStepAttemptForUserInTransaction(reportClient, {
      userId,
      operationId: committed.operation.id,
      stepId: firstStep.id,
      attemptId: firstAttempt.attempt.id,
      outcome: "failed",
      broadcastMayHaveOccurred: false,
      referenceKind: null,
      receiptRefCiphertext: null,
      receiptRefLookupHmac: null,
      lookupKeyVersion: null,
      actualCosts: { reasonCode: "client_execution_failed" },
    });
    await reportClient.query("commit");
    await assert.rejects(siblingStart, (error: unknown) => {
      assert.ok(error instanceof FundingPersistenceError);
      assert.equal(error.code, "invalid_state_transition");
      return true;
    });
    await startClient.query("rollback");
  } finally {
    await reportClient.query("rollback").catch(() => undefined);
    await startClient.query("rollback").catch(() => undefined);
    reportClient.release();
    startClient.release();
  }
}

console.log(
  "[funding-composite-action-race-integration-tests] waiting sibling start observed the committed failure and was rejected",
);

// A claim that owns the intent must be able to cross the reservation deadline
// without deadlocking expiry. Its durable ambiguous attempt then fences expiry.
{
  const venueMarketId = opaque("venue_market");
  const marketId = `polymarket:${venueMarketId}`;
  const marketContextId = opaque("market_context");
  const venueOrderId = opaque("venue_order");
  const handoffId = crypto.randomUUID();
  const intentId = crypto.randomUUID();
  const planFingerprint = digest("claim-at-expiry-plan");
  const handoffTokenHash = digest(opaque("claim_at_expiry_token"));
  let reservationExpiry: Date;
  const eventId = opaque("event");
  await pool.query(
    `insert into unified_events (
       id, venue, venue_event_id, title, status, end_date
     ) values (
       $1, 'polymarket', $2, 'Funding lock race', 'ACTIVE',
       now() + interval '1 day'
     )`,
    [eventId, opaque("venue_event")],
  );
  await pool.query(
    `insert into unified_markets (
       id, venue, venue_market_id, event_id, title, status, market_type
     ) values (
       $1, 'polymarket', $2, $3, 'Funding lock race market',
       'ACTIVE', 'binary'
     )`,
    [marketId, venueMarketId, eventId],
  );
  await pool.query(
    `insert into unified_tokens (token_id, venue, market_id, side)
     values ($1, 'polymarket', $2, 'YES')`,
    [marketContextId, marketId],
  );
  const baseExpiryPlan = makePlan();
  const expiryPlan: FundingCommitPlan = {
    ...baseExpiryPlan,
    operation: {
      ...baseExpiryPlan.operation,
      purpose: "trade_shortfall",
      venueId: "polymarket",
      marketId,
      marketContextSnapshot: {
        marketContextId,
        marketId,
        venueId: "polymarket",
        side: "BUY",
        collateralAsset: asset,
        requestedCollateralRaw: "1000000",
      },
    },
  };
  const expiryConsentToken = opaque("expiry_consent");
  const expiryQuote = await createFundingQuote(pool, {
    userId,
    discoveryProjectionId: opaque("expiry_projection"),
    selectedSourceOptionSnapshot: expiryPlan.operation.sourceSnapshot ?? {},
    marketContextSnapshot: expiryPlan.operation.marketContextSnapshot,
    destinationOptionSnapshot: expiryPlan.operation.destinationTargetSnapshot,
    venueBindingSnapshot: null,
    planSnapshot: expiryPlan,
    policyVersion: 1,
    policyRevision: "policy_composite_expiry_race_v1",
    canonicalRequest: { source: expiryPlan.operation.sourceSnapshot },
    consentToken: expiryConsentToken,
    expiresAt: new Date(Date.now() + 60_000),
  });
  const expiryCommitted = await commitFundingOperation(pool, {
    userId,
    quoteId: expiryQuote.id,
    consentToken: expiryConsentToken,
    idempotencyKey: opaque("expiry_idempotency"),
    plan: expiryPlan,
    subjectLookupHmac: digest("expiry-race-user"),
    subjectLookupKeyVersion: 1,
  });
  const operationId = expiryCommitted.operation.id;
  const executionRows = await pool.query<{
    action_fingerprint: string;
    executor_id: string;
    segment_id: string;
    step_id: string;
  }>(
    `select step.id as step_id,
            step.segment_id,
            step.action_fingerprint,
            step.executor_id
       from funding_operation_steps step
      where step.operation_id = $1::uuid
      order by step.ordinal`,
    [operationId],
  );
  assert.equal(executionRows.rows.length, 2);
  for (const [ordinal, row] of executionRows.rows.entries()) {
    const minOutputRaw = expiryPlan.segments[ordinal]?.quotedMinOutput.raw;
    if (typeof minOutputRaw !== "string") {
      throw new Error("expiry fixture segment has no quoted minimum output");
    }
    const attempt = await startFundingStepAttemptForUser(pool, {
      userId,
      operationId,
      stepId: row.step_id,
      canonicalActionFingerprint: row.action_fingerprint,
      executorId: row.executor_id,
    });
    const observedAt = new Date();
    await tx(pool, (client) =>
      finishFundingStepAttemptForUserInTransaction(client, {
        userId,
        operationId,
        stepId: row.step_id,
        attemptId: attempt.attempt.id,
        outcome: "succeeded",
        broadcastMayHaveOccurred: false,
        referenceKind: null,
        receiptRefCiphertext: null,
        receiptRefLookupHmac: null,
        lookupKeyVersion: null,
        actualCosts: { fixture: "claim_at_expiry" },
        now: observedAt,
      }),
    );
    await allocateFundingObservationInTransaction(pool, {
      operationId,
      segmentId: row.segment_id,
      kind: "destination_credit",
      networkId: asset.networkId,
      assetId: asset.assetId,
      assetDecimals: asset.decimals,
      txHash: `0x${crypto.randomBytes(32).toString("hex")}`,
      eventIndex: "0",
      fromAddress: "0x00000000000000000000000000000000000000b1",
      toAddress: "0x00000000000000000000000000000000000000c1",
      rawAmount: minOutputRaw,
      observedAt,
      ledgerHeight: String(900 + ordinal),
      blockHash: `0x${crypto.randomBytes(32).toString("hex")}`,
      finalityStatus: "finalized",
      finalizedAt: observedAt,
      metadata: { fixture: "claim_at_expiry" },
    });
  }
  const readyReduction = await reduceFundingOperation(pool, {
    operationId,
    now: new Date(),
  });
  assert.deepEqual(readyReduction.finalState, {
    status: "ready",
    stage: "ready_for_consumer",
  });
  const generatedReservation = await pool.query<{
    expires_at: Date;
    id: string;
  }>(
    `select id, expires_at
       from balance_reservations
      where operation_id = $1::uuid
        and mode = 'settled_for_consumer'
        and state = 'active'
      for update`,
    [operationId],
  );
  assert.equal(generatedReservation.rowCount, 1);
  const generatedReservationId = generatedReservation.rows[0]?.id;
  assert.ok(generatedReservationId);
  const generatedReservationExpiry = generatedReservation.rows[0]?.expires_at;
  assert.ok(generatedReservationExpiry);
  reservationExpiry = generatedReservationExpiry;
  const reservationId = generatedReservationId;
  const telegramUserId = opaque("telegram_user");
  await pool.query(
    `insert into user_telegram_accounts (
       id, user_id, privy_user_id, telegram_user_id, username
     ) values ($1::uuid, $2::uuid, $3, $4, $5)`,
    [
      crypto.randomUUID(),
      userId,
      opaque("privy_user"),
      telegramUserId,
      opaque("telegram_username"),
    ],
  );
  await pool.query(
    `insert into telegram_trade_intents (
       id, telegram_user_id, user_id, action, venue, market_id, side,
       amount_usd, delivery_mode, status, funding_operation_id,
       funding_reservation_id, result, expires_at, idempotency_key
     ) values (
       $1::uuid, $2, $3::uuid, 'buy', 'polymarket', $4, 'YES', 1,
       'app_handoff', 'funding', $5::uuid, $6::uuid, $7::jsonb,
       clock_timestamp() + interval '30 minutes', $8
     )`,
    [
      intentId,
      telegramUserId,
      userId,
      marketId,
      operationId,
      reservationId,
      {
        appHandoffExecution: {
          committedAt: new Date().toISOString(),
          handoffId,
          version: 2,
        },
        appHandoffFunding: {
          handoffId,
          operationId,
          version: 2,
        },
      },
      opaque("intent_idempotency"),
    ],
  );
  await pool.query(
    `insert into telegram_app_handoffs (
       id, trade_intent_id, user_id, telegram_user_id, token_hash, state,
       plan_fingerprint, policy_revision, authority_fingerprint,
       quote_snapshot, plan_snapshot, expires_at, claimed_at,
       claimed_by_user_id, committed_at
     ) values (
       $1::uuid, $2::uuid, $3::uuid, $4, $5, 'committed', $6,
       'policy-claim-at-expiry', $7, '{}'::jsonb, $8::jsonb,
       clock_timestamp() + interval '30 minutes', clock_timestamp(),
       $3::uuid, clock_timestamp()
     )`,
    [
      handoffId,
      intentId,
      userId,
      telegramUserId,
      handoffTokenHash,
      planFingerprint,
      digest("claim-at-expiry-authority"),
      {
        kind: "funding",
        trade: {
          action: "buy",
          amountUsd: 1,
          controllerWalletAddress: "0x00000000000000000000000000000000000000b1",
          marketId,
          maxSpendUsd: 1,
          minReceiveShares: null,
          outcomeTokenId: marketContextId,
          venue: "polymarket",
        },
        version: 2,
      },
    ],
  );
  const fundingClaimInput = {
    assertCurrentScope: async () => true,
    binding: { handoffId, planFingerprint },
    canonicalFingerprint: digest("claim-at-expiry-trade"),
    consumerIntent: buildFundingTradeConsumerIntent({
      venueId: "polymarket",
      marketId,
      marketContextId,
      spend: { asset, raw: "1000000" },
    }),
    executionPath: "polymarket_clob" as const,
    externalReference: venueOrderId,
    idempotencyKey: opaque("trade_attempt"),
    marketId,
    operationId,
    reservationId,
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
    userId,
    now: new Date(reservationExpiry.getTime() - 1),
  };

  const claimClient = await pool.connect();
  const expiryClient = await pool.connect();
  try {
    await claimClient.query("begin");
    await expiryClient.query("begin");
    await claimClient.query("set local lock_timeout = '5s'");
    await expiryClient.query("set local lock_timeout = '5s'");
    await claimClient.query(
      "select id from telegram_trade_intents where id = $1 for update",
      [intentId],
    );
    const expiry = reduceFundingOperationInTransaction(expiryClient, {
      operationId,
      now: new Date(reservationExpiry.getTime() + 1),
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const claim =
      await claimTelegramAppHandoffV2FundedTradeAttemptInTransaction(
        claimClient,
        fundingClaimInput,
      );
    const started = await markFundingTradeAttemptSubmissionStartedInTransaction(
      claimClient,
      {
        userId,
        operationId,
        reservationId,
        attemptId: claim.attempt.id,
        claimToken: claim.attempt.claimToken,
        now: new Date(reservationExpiry.getTime() - 1),
      },
    );
    await recordFundingTradeAttemptOutcomeInTransaction(claimClient, {
      userId,
      attemptId: started.id,
      outcome: "ambiguous",
      externalReference: venueOrderId,
      errorCode: "provider_response_unknown",
      broadcastMayHaveOccurred: true,
    });
    await claimClient.query("commit");
    const reduction = await expiry;
    await expiryClient.query("commit");
    assert.equal(
      reduction.terminal,
      false,
      "an in-flight consumer claim must fence terminal expiry",
    );
    const retained = await pool.query<{
      attempt_state: string;
      reservation_state: string;
    }>(
      `select attempt.state as attempt_state,
              reservation.state as reservation_state
         from funding_trade_attempts attempt
         join balance_reservations reservation
           on reservation.id = attempt.reservation_id
        where attempt.id = $1`,
      [claim.attempt.id],
    );
    assert.deepEqual(retained.rows[0], {
      attempt_state: "ambiguous",
      reservation_state: "active",
    });
  } finally {
    await claimClient.query("rollback").catch(() => undefined);
    await expiryClient.query("rollback").catch(() => undefined);
    claimClient.release();
    expiryClient.release();
  }

  const retryClient = await pool.connect();
  try {
    await retryClient.query("begin");
    await retryClient.query("set local lock_timeout = '5s'");
    await retryClient.query(
      "select id from telegram_trade_intents where id = $1 for update",
      [intentId],
    );
    const cancellation = cancelFundingOperationForUser(pool, {
      userId,
      operationId,
      now: new Date(),
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const replay =
      await claimTelegramAppHandoffV2FundedTradeAttemptInTransaction(
        retryClient,
        fundingClaimInput,
      );
    assert.equal(replay.claimed, false);
    assert.equal(replay.reason, "replay_requires_reconciliation");
    await retryClient.query("commit");
    await assert.rejects(cancellation, (error: unknown) => {
      assert.ok(error instanceof FundingPersistenceError);
      assert.equal(error.code, "trade_submission_reconciling");
      return true;
    });
  } finally {
    await retryClient.query("rollback").catch(() => undefined);
    retryClient.release();
  }

  const orderInput = {
    userId,
    walletAddress: "0x00000000000000000000000000000000000000b1",
    venue: "polymarket" as const,
    venueOrderId,
    tokenId: marketContextId,
    side: "BUY" as const,
    orderType: "FOK" as const,
    price: 0.5,
    size: 2,
    status: "filled",
    errorMessage: null,
    rawError: null,
    orderHash: venueOrderId,
    filledAt: new Date(),
  };
  const ambiguousAttempt = await pool.query<{ id: string }>(
    `select id
       from funding_trade_attempts
      where operation_id = $1
        and reservation_id = $2
        and state = 'ambiguous'`,
    [operationId, reservationId],
  );
  const ambiguousAttemptId = ambiguousAttempt.rows[0]?.id;
  assert.ok(ambiguousAttemptId);

  const sealedRetryClient = await pool.connect();
  const historyStoreClient = await pool.connect();
  try {
    await sealedRetryClient.query("begin");
    await historyStoreClient.query("begin");
    await sealedRetryClient.query("set local lock_timeout = '5s'");
    await historyStoreClient.query("set local lock_timeout = '5s'");
    await sealedRetryClient.query(
      "select id from telegram_trade_intents where id = $1 for update",
      [intentId],
    );
    const historyStore = storeOrderInTransaction(
      historyStoreClient,
      orderInput,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    const replay =
      await claimTelegramAppHandoffV2FundedTradeAttemptInTransaction(
        sealedRetryClient,
        fundingClaimInput,
      );
    assert.equal(replay.claimed, false);
    await sealedRetryClient.query("commit");
    const stored = await historyStore;
    // Keep the ambiguous attempt available for the same-order writer race
    // below while still proving this waiter completes after the intent owner.
    await historyStoreClient.query("rollback");
    assert.equal(stored.order.venue_order_id, venueOrderId);
  } finally {
    await sealedRetryClient.query("rollback").catch(() => undefined);
    await historyStoreClient.query("rollback").catch(() => undefined);
    sealedRetryClient.release();
    historyStoreClient.release();
  }

  const explicitStoreClient = await pool.connect();
  const implicitStoreClient = await pool.connect();
  try {
    await explicitStoreClient.query("begin");
    await implicitStoreClient.query("begin");
    await explicitStoreClient.query("set local lock_timeout = '5s'");
    await implicitStoreClient.query("set local lock_timeout = '5s'");
    await explicitStoreClient.query(
      "select pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`orders:${userId}:polymarket:${venueOrderId}`],
    );
    const implicitStore = storeOrderInTransaction(
      implicitStoreClient,
      orderInput,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    const explicitStored = await storeOrderInTransaction(explicitStoreClient, {
      ...orderInput,
      fundingReservation: { operationId, reservationId },
      fundingTradeAttemptId: ambiguousAttemptId,
    });
    assert.equal(explicitStored.order.venue_order_id, venueOrderId);
    // Roll back the explicit writer's insert and funding consumption, then the
    // advisory waiter must recover and consume the same attempt without a
    // lock cycle.
    await explicitStoreClient.query("rollback");
    const implicitStored = await implicitStore;
    await implicitStoreClient.query("commit");
    assert.equal(implicitStored.order.venue_order_id, venueOrderId);
    const consumed = await pool.query<{
      operation_status: string;
      reservation_state: string;
    }>(
      `select operation.status as operation_status,
              reservation.state as reservation_state
         from funding_operations operation
         join balance_reservations reservation
           on reservation.operation_id = operation.id
        where reservation.id = $1`,
      [reservationId],
    );
    assert.deepEqual(consumed.rows[0], {
      operation_status: "completed",
      reservation_state: "consumed",
    });
  } finally {
    await explicitStoreClient.query("rollback").catch(() => undefined);
    await implicitStoreClient.query("rollback").catch(() => undefined);
    explicitStoreClient.release();
    implicitStoreClient.release();
  }

  // This fixture exercises a real Telegram-funded trade attempt, but it does
  // not exercise the global Telegram lifecycle worker. Remove only its card
  // and handoff after the race assertions so a later integration test does
  // not mistake this deliberately unfinished fixture for live user work.
  await pool.query(
    `delete from telegram_app_handoffs where trade_intent_id = $1::uuid`,
    [intentId],
  );
  await pool.query(`delete from telegram_trade_intents where id = $1::uuid`, [
    intentId,
  ]);
}

console.log(
  "[funding-composite-action-race-integration-tests] claim-at-expiry, claim-vs-cancel, implicit history recovery, and same-order writers used canonical locks",
);

async function createRefundedCompositeFixture(label: string) {
  const refundPlan = makePlan();
  const consentToken = opaque(`${label}_consent`);
  const quote = await createFundingQuote(pool, {
    userId,
    discoveryProjectionId: opaque(`${label}_projection`),
    selectedSourceOptionSnapshot: refundPlan.operation.sourceSnapshot ?? {},
    marketContextSnapshot: null,
    destinationOptionSnapshot: refundPlan.operation.destinationTargetSnapshot,
    venueBindingSnapshot: null,
    planSnapshot: refundPlan,
    policyVersion: 1,
    policyRevision: "policy_composite_refund_reorg_v1",
    canonicalRequest: { label, source: refundPlan.operation.sourceSnapshot },
    consentToken,
    expiresAt: new Date(Date.now() + 60_000),
  });
  const committed = await commitFundingOperation(pool, {
    userId,
    quoteId: quote.id,
    consentToken,
    idempotencyKey: opaque(`${label}_operation`),
    plan: refundPlan,
    subjectLookupHmac: digest(`${label}_subject`),
    subjectLookupKeyVersion: 1,
  });
  const segmentRows = await pool.query<{ id: string; ordinal: number }>(
    `select id, ordinal
       from funding_operation_segments
      where operation_id = $1::uuid
      order by ordinal`,
    [committed.operation.id],
  );
  assert.equal(segmentRows.rowCount, 2);
  const refundedAt = new Date();
  const refundIds: string[] = [];
  for (const segment of segmentRows.rows) {
    const allocated = await allocateFundingObservationInTransaction(pool, {
      operationId: committed.operation.id,
      segmentId: segment.id,
      kind: "refund_credit",
      networkId: asset.networkId,
      assetId: asset.assetId,
      assetDecimals: asset.decimals,
      txHash: `0x${crypto.randomBytes(32).toString("hex")}`,
      eventIndex: "0",
      fromAddress: "0x00000000000000000000000000000000000000b1",
      toAddress: `0x${String(segment.ordinal + 1).padStart(40, "0")}`,
      rawAmount: "1000000",
      observedAt: refundedAt,
      ledgerHeight: String(500 + segment.ordinal),
      blockHash: `0x${crypto.randomBytes(32).toString("hex")}`,
      finalityStatus: "finalized",
      finalizedAt: refundedAt,
      metadata: { fixture: label },
    });
    refundIds.push(allocated.observation.id);
  }
  const reduced = await reduceFundingOperation(pool, {
    operationId: committed.operation.id,
    now: refundedAt,
  });
  assert.deepEqual(reduced.finalState, {
    status: "refunded",
    stage: "terminal",
  });
  return {
    operationId: committed.operation.id,
    refundIds,
    refundedAt,
    segmentIds: segmentRows.rows.map((segment) => segment.id),
  };
}

async function scheduleCompositeRefundCheck(operationId: string, dueAt: Date) {
  await pool.query(
    `update funding_reconciliation_jobs
        set due_at = $2,
            status = 'scheduled',
            priority = 30000,
            lease_owner = null,
            lease_token = null,
            lease_until = null
      where operation_id = $1::uuid`,
    [operationId, dueAt],
  );
}

const replacementComposite = await createRefundedCompositeFixture(
  "composite_refund_replacement",
);
const replacementReorgAt = new Date(
  replacementComposite.refundedAt.getTime() + 1_000,
);
const replacementRefundId = replacementComposite.refundIds[0];
const replacementSegmentId = replacementComposite.segmentIds[0];
assert.ok(replacementRefundId);
assert.ok(replacementSegmentId);
await advanceFundingObservationFinalityInTransaction(pool, {
  observationId: replacementRefundId,
  expectedFinality: "finalized",
  nextFinality: "reorged",
  reorgedAt: replacementReorgAt,
  metadataPatch: { reason: "synthetic_composite_reorg" },
});
const beforeReplacementAt = new Date(replacementReorgAt.getTime() + 60_000);
await scheduleCompositeRefundCheck(
  replacementComposite.operationId,
  beforeReplacementAt,
);
const missingLegPass = await runFundingReconciliationBatch(pool, {
  workerId: opaque("composite_refund_missing_leg"),
  limit: 1,
  now: beforeReplacementAt,
});
assert.deepEqual(
  {
    claimed: missingLegPass.claimed,
    completed: missingLegPass.completed,
    deadLettered: missingLegPass.deadLettered,
    requeued: missingLegPass.requeued,
  },
  { claimed: 1, completed: 0, deadLettered: 0, requeued: 1 },
  "a canonical sibling refund must not hide another segment's reorg",
);
const reopenedComposite = await pool.query<{
  reorg_blocked: boolean;
  status: string;
}>(
  `select status,
          coalesce(
            (support_metadata ->> 'reorgBlockedByTerminalState')::boolean,
            false
          ) as reorg_blocked
     from funding_operations
    where id = $1::uuid`,
  [replacementComposite.operationId],
);
assert.deepEqual(reopenedComposite.rows, [
  { reorg_blocked: false, status: "recovery_required" },
]);

const exactReplacementAt = new Date(replacementReorgAt.getTime() + 120_000);
await allocateFundingObservationInTransaction(pool, {
  operationId: replacementComposite.operationId,
  segmentId: replacementSegmentId,
  kind: "refund_credit",
  networkId: asset.networkId,
  assetId: asset.assetId,
  assetDecimals: asset.decimals,
  txHash: `0x${crypto.randomBytes(32).toString("hex")}`,
  eventIndex: "0",
  fromAddress: "0x00000000000000000000000000000000000000b1",
  toAddress: "0x0000000000000000000000000000000000000001",
  rawAmount: "1000000",
  observedAt: exactReplacementAt,
  ledgerHeight: "510",
  blockHash: `0x${crypto.randomBytes(32).toString("hex")}`,
  finalityStatus: "finalized",
  finalizedAt: exactReplacementAt,
  metadata: {
    replacementForRefundObservationId: replacementRefundId,
  },
});
const exactReplacementReduction = await reduceFundingOperation(pool, {
  operationId: replacementComposite.operationId,
  now: exactReplacementAt,
});
assert.equal(exactReplacementReduction.reorgBlockedByTerminalState, false);
await scheduleCompositeRefundCheck(
  replacementComposite.operationId,
  new Date(exactReplacementAt.getTime() + 15 * 60_000),
);
const replacementMatured = await runFundingReconciliationBatch(pool, {
  workerId: opaque("composite_refund_replacement_matured"),
  limit: 1,
  now: new Date(exactReplacementAt.getTime() + 15 * 60_000),
});
assert.deepEqual(
  {
    claimed: replacementMatured.claimed,
    completed: replacementMatured.completed,
    deadLettered: replacementMatured.deadLettered,
  },
  { claimed: 1, completed: 1, deadLettered: 0 },
);

const unresolvedComposite = await createRefundedCompositeFixture(
  "composite_refund_unresolved",
);
const unresolvedReorgAt = new Date(
  unresolvedComposite.refundedAt.getTime() + 1_000,
);
const unresolvedRefundId = unresolvedComposite.refundIds[0];
assert.ok(unresolvedRefundId);
await advanceFundingObservationFinalityInTransaction(pool, {
  observationId: unresolvedRefundId,
  expectedFinality: "finalized",
  nextFinality: "reorged",
  reorgedAt: unresolvedReorgAt,
  metadataPatch: { reason: "synthetic_composite_reorg" },
});
await scheduleCompositeRefundCheck(
  unresolvedComposite.operationId,
  new Date(unresolvedReorgAt.getTime() + 15 * 60_000),
);
const unresolvedMatured = await runFundingReconciliationBatch(pool, {
  workerId: opaque("composite_refund_unresolved_matured"),
  limit: 1,
  now: new Date(unresolvedReorgAt.getTime() + 15 * 60_000),
});
assert.deepEqual(
  {
    claimed: unresolvedMatured.claimed,
    deadLettered: unresolvedMatured.deadLettered,
    requeued: unresolvedMatured.requeued,
  },
  { claimed: 1, deadLettered: 1, requeued: 0 },
  "a different segment's canonical refund must not suppress the missing leg incident",
);

console.log(
  "[funding-composite-action-race-integration-tests] composite refund reorgs are matched per segment through replacement and dead-letter boundaries",
);
