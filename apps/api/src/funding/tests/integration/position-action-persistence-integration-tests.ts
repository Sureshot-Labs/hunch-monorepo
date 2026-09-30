#!/usr/bin/env tsx

// @requires-db

import assert from "node:assert/strict";
import crypto from "node:crypto";
import { ethers } from "ethers";

import "../../../integration-test-database-guard.js";
import { pool } from "../../../db.js";
import {
  bindPositionActionSubmissionTransactionHash,
  claimPositionActionSubmission,
  completePositionActionEffect,
  hasCompletedPositionActionNotification,
  createOrReplayPositionAction,
  fetchPositionActionForUser,
  PositionActionPersistenceError,
  recordPositionActionPostconditions,
  recordPositionActionReceipt,
  recordPositionActionSubmission,
  type PositionActionCreateInput,
} from "../../position-actions/position-action-repository.js";
import { embeddedEvmSponsorshipTestHooks } from "../../../services/embedded-evm-sponsorship.js";
import {
  admitEmbeddedPositionSubmission,
  beginEmbeddedPositionDispatch,
  journalEmbeddedPositionAcceptance,
  journalEmbeddedPositionAuthorizationRejection,
} from "../../position-actions/embedded-submission.js";
import { markStalePositionActionClaimForRecovery } from "../../position-actions/position-action-repository.js";
import { PositionActionRuntimeService } from "../../position-actions/runtime-service.js";
import {
  executeEmbeddedEthereumTransactionRequests,
  EmbeddedEvmAuthorizationRejectedError,
  prepareEmbeddedEthereumTransactionRequests,
} from "../../../services/embedded-ethereum.js";

async function insertUser(label: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `
      insert into users (email, is_active, is_verified)
      values ($1, true, true)
      returning id
    `,
    [`position-action-${label}-${crypto.randomUUID()}@example.com`],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error("position action test user insert failed");
  return id;
}

function createInput(
  userId: string,
  suffix: string,
): PositionActionCreateInput {
  return {
    userId,
    marketId: null,
    venueId: "polymarket",
    action: "redeem",
    positionRef: `position_${suffix}`,
    ownerBindingId: `binding_${suffix}_12345678`,
    ownerAddress: "0x00000000000000000000000000000000000000a1",
    executionWalletId: `wallet_${suffix}_12345678`,
    executionAddress: "0x00000000000000000000000000000000000000a2",
    executionMode: "web_client",
    inspectionRevision: `inspection_${suffix}_12345678`,
    actionDigest: crypto
      .createHash("sha256")
      .update(`action:${suffix}`)
      .digest("hex"),
    idempotencyKey: `idempotency_${suffix}_${crypto.randomUUID()}`,
    status: "awaiting_user",
    planSnapshot: { target: "0x00000000000000000000000000000000000000b1" },
    evidenceSnapshot: { owner: "verified", balanceRaw: "1000000" },
    normalizedActions: [
      {
        kind: "evm_transaction",
        actionId: `action_${suffix}_12345678`,
      },
    ],
    postconditions: [{ kind: "position_zero" }, { kind: "collateral_delta" }],
  };
}

function freshAttempt(
  input: PositionActionCreateInput,
  label: string,
): PositionActionCreateInput {
  const idempotencyKey = `idempotency_${label}_${crypto.randomUUID()}`;
  const actionId = `action_${label}_${crypto.randomUUID()}`;
  return {
    ...input,
    idempotencyKey,
    // Runtime action IDs are derived from the request key. Exercise the real
    // concurrency shape instead of pretending that fresh keys share a digest.
    actionDigest: crypto
      .createHash("sha256")
      .update(`${idempotencyKey}:${actionId}`)
      .digest("hex"),
    normalizedActions: [{ kind: "evm_transaction", actionId }],
  };
}

const userId = await insertUser("owner");
const otherUserId = await insertUser("other");
const operationIds: string[] = [];

try {
  const futureVenueInput = {
    ...createInput(userId, "future-venue"),
    venueId: "future_venue",
  };
  const futureVenueCreated = await createOrReplayPositionAction(
    pool,
    futureVenueInput,
  );
  operationIds.push(futureVenueCreated.operation.id);
  assert.equal(futureVenueCreated.operation.venueId, "future_venue");

  const ambiguousInput = createInput(userId, "ambiguous");
  const created = await createOrReplayPositionAction(pool, ambiguousInput);
  operationIds.push(created.operation.id);
  assert.equal(created.replayed, false);
  assert.equal(created.operation.ownerBindingId, ambiguousInput.ownerBindingId);

  const replay = await createOrReplayPositionAction(pool, ambiguousInput);
  assert.equal(replay.replayed, true);
  assert.equal(replay.operation.id, created.operation.id);

  const exactReplayIgnoresVolatileEvidence = await createOrReplayPositionAction(
    pool,
    {
      ...ambiguousInput,
      evidenceSnapshot: { owner: "fresh-rpc-snapshot" },
    },
  );
  assert.equal(exactReplayIgnoresVolatileEvidence.replayed, true);
  assert.equal(
    exactReplayIgnoresVolatileEvidence.operation.id,
    created.operation.id,
  );

  await assert.rejects(
    () =>
      createOrReplayPositionAction(pool, {
        ...ambiguousInput,
        positionRef: "position_key_reuse_conflict",
      }),
    (error: unknown) =>
      error instanceof PositionActionPersistenceError &&
      error.code === "idempotency_conflict",
  );

  const claim = await claimPositionActionSubmission(pool, {
    userId,
    operationId: created.operation.id,
    canonicalActionFingerprint: "a".repeat(64),
    executorId: "web-client-evm-v1",
  });
  assert.equal(claim.claimed, true);
  assert.equal(claim.attemptNumber, 1);

  const concurrent = await claimPositionActionSubmission(pool, {
    userId,
    operationId: created.operation.id,
    canonicalActionFingerprint: "a".repeat(64),
    executorId: "web-client-evm-v1",
  });
  assert.equal(concurrent.claimed, false);
  assert.equal(concurrent.reason, "already_broadcast");

  const ambiguous = await recordPositionActionSubmission(pool, {
    userId,
    operationId: created.operation.id,
    attemptNumber: 1,
    outcome: "ambiguous",
    submissionFingerprint: null,
    errorCode: "submit_response_lost",
  });
  assert.equal(ambiguous.status, "reconcile_required");
  assert.equal(ambiguous.broadcastMayHaveOccurred, true);

  const ambiguousFreshRequest = await createOrReplayPositionAction(
    pool,
    freshAttempt(ambiguousInput, "ambiguous-retry"),
  );
  assert.equal(ambiguousFreshRequest.replayed, true);
  assert.equal(ambiguousFreshRequest.operation.id, created.operation.id);

  const retryAfterAmbiguous = await claimPositionActionSubmission(pool, {
    userId,
    operationId: created.operation.id,
    canonicalActionFingerprint: "a".repeat(64),
    executorId: "web-client-evm-v1",
  });
  assert.equal(retryAfterAmbiguous.claimed, false);

  const relayerInput: PositionActionCreateInput = {
    ...createInput(userId, "relayer-reference"),
    executionMode: "venue_relayer",
  };
  const relayerCreated = await createOrReplayPositionAction(pool, relayerInput);
  operationIds.push(relayerCreated.operation.id);
  const relayerClaim = await claimPositionActionSubmission(pool, {
    userId,
    operationId: relayerCreated.operation.id,
    canonicalActionFingerprint: "e".repeat(64),
    executorId: "position-action:venue_relayer",
  });
  const relayerReference = "polymarket-relayer:v1:relayer_transaction_12345678";
  const relayerSubmitted = await recordPositionActionSubmission(pool, {
    userId,
    operationId: relayerCreated.operation.id,
    attemptNumber: relayerClaim.attemptNumber ?? 0,
    outcome: "submitted",
    submissionFingerprint: relayerReference,
  });
  assert.equal(relayerSubmitted.submissionFingerprint, relayerReference);
  const resolvedHash = `0x${"f".repeat(64)}`;
  const relayerBound = await bindPositionActionSubmissionTransactionHash(pool, {
    userId,
    operationId: relayerCreated.operation.id,
    expectedSubmissionReference: relayerReference,
    transactionHash: resolvedHash,
  });
  assert.equal(relayerBound.submissionFingerprint, resolvedHash);
  const relayerBoundReplay = await bindPositionActionSubmissionTransactionHash(
    pool,
    {
      userId,
      operationId: relayerCreated.operation.id,
      expectedSubmissionReference: relayerReference,
      transactionHash: resolvedHash,
    },
  );
  assert.equal(relayerBoundReplay.submissionFingerprint, resolvedHash);

  const successInput = createInput(userId, "success");
  const successCreated = await createOrReplayPositionAction(pool, successInput);
  operationIds.push(successCreated.operation.id);
  const successClaim = await claimPositionActionSubmission(pool, {
    userId,
    operationId: successCreated.operation.id,
    canonicalActionFingerprint: "b".repeat(64),
    executorId: "privy-authorization-evm-v1",
  });
  assert.equal(successClaim.claimed, true);

  const submitted = await recordPositionActionSubmission(pool, {
    userId,
    operationId: successCreated.operation.id,
    attemptNumber: successClaim.attemptNumber ?? 0,
    outcome: "submitted",
    submissionFingerprint: `0x${"c".repeat(64)}`,
  });
  assert.equal(submitted.status, "submitted");
  assert.equal(submitted.receiptStatus, "pending");

  const confirmed = await recordPositionActionReceipt(pool, {
    userId,
    operationId: successCreated.operation.id,
    receipt: "success",
    receiptEvidence: { blockNumber: "123", status: "success" },
  });
  assert.equal(confirmed.status, "confirmed");
  assert.equal(confirmed.receiptStatus, "success");

  assert.equal(
    await hasCompletedPositionActionNotification(
      pool,
      userId,
      successCreated.operation.id,
    ),
    false,
  );
  await completePositionActionEffect(pool, {
    userId,
    operationId: successCreated.operation.id,
    effectKind: "position_refresh",
    evidence: { positionBalanceRaw: "0" },
  });
  await completePositionActionEffect(pool, {
    userId,
    operationId: successCreated.operation.id,
    effectKind: "collateral_refresh",
    evidence: { collateralDeltaRaw: "1000000" },
  });
  const completed = await recordPositionActionPostconditions(pool, {
    userId,
    operationId: successCreated.operation.id,
    status: "satisfied",
  });
  assert.equal(completed.status, "completed");
  assert.equal(completed.postconditionStatus, "satisfied");

  const completedSameRequest = await createOrReplayPositionAction(
    pool,
    successInput,
  );
  assert.equal(completedSameRequest.replayed, true);
  assert.equal(completedSameRequest.operation.id, successCreated.operation.id);

  const completedFreshRequest = await createOrReplayPositionAction(
    pool,
    freshAttempt(successInput, "reacquired-position"),
  );
  assert.equal(completedFreshRequest.replayed, false);
  assert.notEqual(
    completedFreshRequest.operation.id,
    successCreated.operation.id,
  );
  operationIds.push(completedFreshRequest.operation.id);

  const retryableInput = createInput(userId, "safe-terminal-retry");
  const retryableCreated = await createOrReplayPositionAction(
    pool,
    retryableInput,
  );
  operationIds.push(retryableCreated.operation.id);
  const retryableClaim = await claimPositionActionSubmission(pool, {
    userId,
    operationId: retryableCreated.operation.id,
    canonicalActionFingerprint: "f".repeat(64),
    executorId: "privy-authorization-evm-v1",
  });
  await recordPositionActionSubmission(pool, {
    userId,
    operationId: retryableCreated.operation.id,
    attemptNumber: retryableClaim.attemptNumber ?? 0,
    outcome: "not_broadcast",
    submissionFingerprint: null,
    errorCode: "wallet_request_failed",
  });

  const terminalSameRequest = await createOrReplayPositionAction(
    pool,
    retryableInput,
  );
  assert.equal(terminalSameRequest.replayed, true);
  assert.equal(terminalSameRequest.operation.id, retryableCreated.operation.id);

  const freshRetryInputs = ["a", "b"].map((label) =>
    freshAttempt(retryableInput, `safe-retry-${label}`),
  );
  const freshRetries = await Promise.all(
    freshRetryInputs.map((input) => createOrReplayPositionAction(pool, input)),
  );
  assert.equal(freshRetries[0]?.operation.id, freshRetries[1]?.operation.id);
  assert.equal(freshRetries.filter((result) => !result.replayed).length, 1);
  const freshRetryOperation = freshRetries[0]?.operation;
  assert.ok(freshRetryOperation);
  assert.notEqual(freshRetryOperation.id, retryableCreated.operation.id);
  operationIds.push(freshRetryOperation.id);

  const exactFreshRequestReplay = await createOrReplayPositionAction(
    pool,
    freshRetryInputs[0] as PositionActionCreateInput,
  );
  assert.equal(exactFreshRequestReplay.replayed, true);
  assert.equal(exactFreshRequestReplay.operation.id, freshRetryOperation.id);

  const revertedInput = createInput(userId, "reverted-retry");
  const revertedCreated = await createOrReplayPositionAction(
    pool,
    revertedInput,
  );
  operationIds.push(revertedCreated.operation.id);
  const revertedClaim = await claimPositionActionSubmission(pool, {
    userId,
    operationId: revertedCreated.operation.id,
    canonicalActionFingerprint: "9".repeat(64),
    executorId: "privy-authorization-evm-v1",
  });
  await recordPositionActionSubmission(pool, {
    userId,
    operationId: revertedCreated.operation.id,
    attemptNumber: revertedClaim.attemptNumber ?? 0,
    outcome: "submitted",
    submissionFingerprint: `0x${"8".repeat(64)}`,
  });
  await recordPositionActionReceipt(pool, {
    userId,
    operationId: revertedCreated.operation.id,
    receipt: "reverted",
    receiptEvidence: { status: "reverted" },
  });
  const revertedFreshRequest = await createOrReplayPositionAction(
    pool,
    freshAttempt(revertedInput, "reverted-fresh"),
  );
  assert.equal(revertedFreshRequest.replayed, false);
  assert.notEqual(
    revertedFreshRequest.operation.id,
    revertedCreated.operation.id,
  );
  operationIds.push(revertedFreshRequest.operation.id);

  await pool.query(
    `
      update position_action_effects
      set status = 'failed',
          attempt_count = attempt_count + 1,
          last_error_code = 'marker_write_failed',
          next_attempt_at = now()
      where action_operation_id = $1
        and effect_kind = 'activity'
    `,
    [successCreated.operation.id],
  );
  const afterMarkerFailure = await fetchPositionActionForUser(pool, {
    userId,
    operationId: successCreated.operation.id,
  });
  assert.equal(afterMarkerFailure?.status, "completed");

  const noDuplicateBroadcast = await claimPositionActionSubmission(pool, {
    userId,
    operationId: successCreated.operation.id,
    canonicalActionFingerprint: "b".repeat(64),
    executorId: "privy-authorization-evm-v1",
  });
  assert.equal(noDuplicateBroadcast.claimed, false);
  assert.equal(noDuplicateBroadcast.reason, "already_broadcast");

  const sponsoredInput: PositionActionCreateInput = {
    ...createInput(userId, "sponsored"),
    executionMode: "privy_authorization",
    normalizedActions: [
      {
        kind: "evm_transaction_batch",
        actionId: "action_sponsored_batch_12345678",
        networkId: "evm:137",
        senderWalletId: "wallet_sponsored_12345678",
        calls: [
          {
            actionId: "action_sponsored_batch_12345678:call:0",
            to: "0x00000000000000000000000000000000000000b1",
            data: "0x1234",
            valueRaw: "0",
          },
          {
            actionId: "action_sponsored_batch_12345678:call:1",
            to: "0x00000000000000000000000000000000000000b2",
            data: "0x5678",
            valueRaw: "0",
          },
        ],
      },
    ],
  };
  const sponsoredCreated = await createOrReplayPositionAction(
    pool,
    sponsoredInput,
  );
  operationIds.push(sponsoredCreated.operation.id);
  const sponsoredClaim = await claimPositionActionSubmission(pool, {
    userId,
    operationId: sponsoredCreated.operation.id,
    canonicalActionFingerprint: "d".repeat(64),
    executorId: "privy-authorization-evm-v1",
  });
  assert.equal(sponsoredClaim.claimed, true);
  const exactSponsoredCall = {
    chainId: 137,
    signer: sponsoredInput.executionAddress,
    transaction: {
      id: "action_sponsored_batch_12345678:call:1",
      label: "Redeem position",
      to: "0x00000000000000000000000000000000000000b2",
      data: "0x5678",
    },
    userId,
  };
  assert.equal(
    await embeddedEvmSponsorshipTestHooks.matchesPositionAction(
      pool,
      exactSponsoredCall,
    ),
    true,
  );
  assert.equal(
    await embeddedEvmSponsorshipTestHooks.matchesPositionAction(pool, {
      ...exactSponsoredCall,
      signer: "0x00000000000000000000000000000000000000ff",
    }),
    false,
  );
  assert.equal(
    await embeddedEvmSponsorshipTestHooks.matchesPositionAction(pool, {
      ...exactSponsoredCall,
      transaction: { ...exactSponsoredCall.transaction, data: "0xabcd" },
    }),
    false,
  );

  await completePositionActionEffect(pool, {
    userId,
    operationId: successCreated.operation.id,
    effectKind: "activity",
    evidence: { activityId: "activity_wp6_12345678" },
  });
  await completePositionActionEffect(pool, {
    userId,
    operationId: successCreated.operation.id,
    effectKind: "notification",
    evidence: { notificationId: "notification_wp6_12345678" },
  });
  assert.equal(
    await hasCompletedPositionActionNotification(
      pool,
      userId,
      successCreated.operation.id,
    ),
    true,
  );
  assert.equal(
    await hasCompletedPositionActionNotification(
      pool,
      otherUserId,
      successCreated.operation.id,
    ),
    false,
  );

  assert.equal(
    await fetchPositionActionForUser(pool, {
      userId: otherUserId,
      operationId: successCreated.operation.id,
    }),
    null,
  );

  await assert.rejects(
    () =>
      pool.query(
        `
          update position_action_operations
          set owner_binding_id = 'binding_mutated_12345678'
          where id = $1
        `,
        [successCreated.operation.id],
      ),
    /immutable/i,
  );

  const embeddedInput: PositionActionCreateInput = {
    ...createInput(userId, "server-journal"),
    planSnapshot: {
      ...createInput(userId, "server-journal").planSnapshot,
      tokenId: "123",
    },
    executionMode: "privy_authorization",
    normalizedActions: [
      {
        kind: "evm_transaction",
        networkId: "evm:8453",
        senderWalletId: "wallet_server-journal_12345678",
        to: "0x00000000000000000000000000000000000000b1",
        data: "0x12345678",
        valueRaw: "0",
        gasLimitRaw: null,
      },
    ],
  };
  const embedded = await createOrReplayPositionAction(pool, embeddedInput);
  operationIds.push(embedded.operation.id);
  await claimPositionActionSubmission(pool, {
    userId,
    operationId: embedded.operation.id,
    canonicalActionFingerprint: "e".repeat(64),
    executorId: "privy-authorization-evm-v1",
  });
  const payload = {
    kind: "ethereum" as const,
    signer: embeddedInput.executionAddress,
    chainId: 8453,
    executionMode: "sequential" as const,
    returnOnAccepted: true,
    transactions: [
      {
        to: "0x00000000000000000000000000000000000000b1",
        data: "0x12345678",
        value: "0",
        sponsor: true,
      },
    ],
  };
  const executionKey = `${embedded.operation.id}:1`;
  const admission = await admitEmbeddedPositionSubmission(
    pool,
    userId,
    executionKey,
    payload,
  );
  assert.ok(admission);
  assert.equal(admission.acceptedReference, null);
  await assert.rejects(() =>
    admitEmbeddedPositionSubmission(pool, otherUserId, executionKey, payload),
  );
  await assert.rejects(() =>
    admitEmbeddedPositionSubmission(pool, userId, executionKey, {
      ...payload,
      chainId: 137,
    }),
  );
  const dispatches = await Promise.allSettled([
    beginEmbeddedPositionDispatch(pool, userId, admission),
    beginEmbeddedPositionDispatch(pool, userId, admission),
  ]);
  assert.equal(
    dispatches.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal(
    dispatches.filter((result) => result.status === "rejected").length,
    1,
  );
  await assert.rejects(
    () => admitEmbeddedPositionSubmission(pool, userId, executionKey, payload),
    /reconciliation/,
    "lost provider response cannot permit a second POST even without a worker",
  );
  for (const outcome of ["ambiguous", "not_broadcast", "failed"] as const) {
    const weakReport = await recordPositionActionSubmission(pool, {
      userId,
      operationId: embedded.operation.id,
      attemptNumber: 1,
      outcome,
      submissionFingerprint: null,
      errorCode: "client_response_lost",
    });
    assert.equal(weakReport.status, "reconcile_required");
    assert.equal(weakReport.broadcastMayHaveOccurred, true);
    assert.equal(
      weakReport.lastErrorCode,
      "position_action_submission_reference_missing",
    );
  }

  // Feed the journal real executor output, not hand-invented raw IDs. No
  // network/RPC is allowed: only the Privy POST is replaced by an exact mock.
  async function providerResponse(
    key: string,
    responsePayload: Record<string, unknown> | null,
    status = 200,
  ) {
    const requests = prepareEmbeddedEthereumTransactionRequests({
      context: {
        signer: embeddedInput.executionAddress,
        walletId: embeddedInput.executionWalletId,
        walletProfile: {
          walletId: embeddedInput.executionWalletId,
          address: embeddedInput.executionAddress,
          walletType: "ethereum",
          source: "embedded",
          isInternalWallet: true,
        },
      },
      chainId: payload.chainId,
      executionMode: payload.executionMode,
      executionKey: key,
      transactions: payload.transactions.map((transaction) => ({
        ...transaction,
        id: "redeem",
        label: "Redeem fixture",
      })),
    });
    assert.equal(requests.length, 1);
    const preparedRequest = requests[0];
    assert.ok(preparedRequest);
    const savedFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async (input, init) => {
      assert.equal(String(input), preparedRequest.input.url);
      assert.equal(init?.method, "POST");
      calls += 1;
      return new Response(JSON.stringify(responsePayload), { status });
    };
    try {
      const result = await executeEmbeddedEthereumTransactionRequests({
        chainId: payload.chainId,
        requests,
        returnOnAccepted: true,
        signatures: requests.map(({ id }) => ({
          id,
          signature: "signed-fixture",
        })),
      });
      assert.equal(calls, 1);
      return result;
    } finally {
      globalThis.fetch = savedFetch;
    }
  }
  async function providerAcceptance(
    key: string,
    providerData: Record<string, string | undefined>,
  ) {
    const result = await providerResponse(key, { data: providerData });
    assert.equal(result.transactionReferences.length, 1);
    const acceptedReference = result.transactionReferences[0];
    assert.ok(acceptedReference);
    return acceptedReference;
  }

  // Actual executor response -> server journal -> late browser report -> fresh
  // consent. Only explicit single-POST authorization denials release the claim.
  for (const scenario of [
    {
      status: 401,
      body: { error: "Invalid authorization signature" },
      count: 1,
      definite: true,
    },
    {
      status: 403,
      body: { message: "Authorization policy denied" },
      count: 1,
      definite: true,
    },
    {
      status: 400,
      body: { error: "Invalid authorization signature" },
      count: 1,
      definite: false,
    },
    {
      status: 502,
      body: { error: "Invalid authorization signature" },
      count: 1,
      definite: false,
    },
    { status: 401, body: null, count: 1, definite: false },
    {
      status: 401,
      body: { error: "Denied", data: { transaction_id: "accepted-reference" } },
      count: 1,
      definite: false,
    },
    {
      status: 401,
      body: { error: "Invalid authorization signature" },
      count: 2,
      definite: false,
    },
  ]) {
    const fixtureInput = {
      ...embeddedInput,
      positionRef: `position_rejection-${crypto.randomUUID()}`,
      ownerBindingId: `binding_rejection-${crypto.randomUUID()}`,
      idempotencyKey: `rejection-${crypto.randomUUID()}`,
    };
    const fixture = await createOrReplayPositionAction(pool, fixtureInput);
    operationIds.push(fixture.operation.id);
    await claimPositionActionSubmission(pool, {
      userId,
      operationId: fixture.operation.id,
      canonicalActionFingerprint: "e".repeat(64),
      executorId: "privy-authorization-evm-v1",
      embeddedDispatchProtocol: "privy_position_v1",
    });
    const scope = { operationId: fixture.operation.id, attemptNumber: 1 };
    await beginEmbeddedPositionDispatch(pool, userId, scope);
    await assert.rejects(
      pool.query(
        `update position_action_operations set broadcast_may_have_occurred = false where id = $1`,
        [scope.operationId],
      ),
      /broadcast evidence cannot regress/u,
      "the new rejection exception must not admit unproved broadcast regression",
    );
    let failure: unknown;
    try {
      await providerResponse(
        `${fixture.operation.id}:1`,
        scenario.body,
        scenario.status,
      );
      assert.fail("Provider fixture must reject");
    } catch (error) {
      failure = error;
    }
    assert.ok(failure instanceof Error);
    await journalEmbeddedPositionAuthorizationRejection(
      pool,
      userId,
      scope,
      scenario.count,
      failure,
    );
    const lateBrowser = await recordPositionActionSubmission(pool, {
      userId,
      ...scope,
      outcome: "ambiguous",
      submissionFingerprint: null,
      errorCode: "client_response_lost",
    });
    assert.equal(
      lateBrowser.status,
      scenario.definite ? "failed" : "reconcile_required",
    );
    assert.equal(lateBrowser.broadcastMayHaveOccurred, !scenario.definite);
    const fresh = await createOrReplayPositionAction(
      pool,
      freshAttempt(fixtureInput, `fresh-rejection-${crypto.randomUUID()}`),
    );
    operationIds.push(fresh.operation.id);
    assert.equal(fresh.replayed, !scenario.definite);
    const retry = await claimPositionActionSubmission(pool, {
      userId,
      operationId: fresh.operation.id,
      canonicalActionFingerprint: "e".repeat(64),
      executorId: "privy-authorization-evm-v1",
    });
    assert.equal(retry.claimed, scenario.definite);
  }
  const providerRef = await providerAcceptance(executionKey, {
    transaction_id: `accepted-${crypto.randomUUID()}`,
  });
  await journalEmbeddedPositionAcceptance(pool, userId, admission, [
    providerRef,
  ]);
  await journalEmbeddedPositionAuthorizationRejection(
    pool,
    userId,
    admission,
    1,
    new EmbeddedEvmAuthorizationRejectedError("late denial", 401),
  );
  const acceptedReplay = await admitEmbeddedPositionSubmission(
    pool,
    userId,
    executionKey,
    payload,
  );
  assert.deepEqual(
    acceptedReplay?.acceptedReference,
    providerRef,
    "provider acceptance is replayed without another send",
  );
  const cancelledBrowser = await recordPositionActionSubmission(pool, {
    userId,
    operationId: embedded.operation.id,
    attemptNumber: 1,
    outcome: "not_broadcast",
    submissionFingerprint: null,
  });
  assert.equal(cancelledBrowser.status, "submitted");
  assert.equal(cancelledBrowser.broadcastMayHaveOccurred, true);
  assert.ok(cancelledBrowser.submissionFingerprint);
  const transactionHash = `0x${crypto.randomBytes(32).toString("hex")}`;
  await bindPositionActionSubmissionTransactionHash(pool, {
    userId,
    operationId: embedded.operation.id,
    expectedSubmissionReference: cancelledBrowser.submissionFingerprint,
    transactionHash,
  });
  await journalEmbeddedPositionAcceptance(pool, userId, admission, [
    providerRef,
  ]);
  assert.deepEqual(
    (await admitEmbeddedPositionSubmission(pool, userId, executionKey, payload))
      ?.acceptedReference,
    { kind: "transaction", value: transactionHash },
  );

  for (const providerData of [
    { user_operation_hash: `0x${crypto.randomBytes(32).toString("hex")}` },
    { hash: `0x${crypto.randomBytes(32).toString("hex")}` },
  ]) {
    const alternate = await createOrReplayPositionAction(pool, {
      ...embeddedInput,
      positionRef: `position_reference-${crypto.randomUUID()}`,
      ownerBindingId: `binding_reference-${crypto.randomUUID()}`,
      idempotencyKey: `reference-${crypto.randomUUID()}`,
    });
    operationIds.push(alternate.operation.id);
    await claimPositionActionSubmission(pool, {
      userId,
      operationId: alternate.operation.id,
      canonicalActionFingerprint: "c".repeat(64),
      executorId: "privy-authorization-evm-v1",
    });
    const key = `${alternate.operation.id}:1`;
    const scope = await admitEmbeddedPositionSubmission(
      pool,
      userId,
      key,
      payload,
    );
    await beginEmbeddedPositionDispatch(pool, userId, scope);
    const reference = await providerAcceptance(key, providerData);
    await journalEmbeddedPositionAcceptance(pool, userId, scope, [reference]);
    assert.deepEqual(
      (await admitEmbeddedPositionSubmission(pool, userId, key, payload))
        ?.acceptedReference,
      reference,
      "accepted hash/user operation replays in the same wire format without a new POST",
    );
  }

  const expiredClaim = await createOrReplayPositionAction(pool, {
    ...embeddedInput,
    positionRef: "position_expired-first-send",
    ownerBindingId: "binding_expired-first-send",
    idempotencyKey: `expired-${crypto.randomUUID()}`,
  });
  operationIds.push(expiredClaim.operation.id);
  await claimPositionActionSubmission(pool, {
    userId,
    operationId: expiredClaim.operation.id,
    canonicalActionFingerprint: "a".repeat(64),
    executorId: "privy-authorization-evm-v1",
    embeddedDispatchProtocol: "privy_position_v1",
  });
  await pool.query(
    `update position_action_attempts set started_at = now() - interval '6 minutes'
      where action_operation_id = $1`,
    [expiredClaim.operation.id],
  );
  const expiredScope = await admitEmbeddedPositionSubmission(
    pool,
    userId,
    `${expiredClaim.operation.id}:1`,
    payload,
  );
  await assert.rejects(
    () => beginEmbeddedPositionDispatch(pool, userId, expiredScope),
    /reconciliation/,
    "stale started claims do not authorize a provider POST even without worker cleanup",
  );
  assert.equal(
    (
      await fetchPositionActionForUser(pool, {
        userId,
        operationId: expiredClaim.operation.id,
      })
    )?.status,
    "failed",
  );
  const expiredState = await fetchPositionActionForUser(pool, {
    userId,
    operationId: expiredClaim.operation.id,
  });
  assert.equal(expiredState?.broadcastMayHaveOccurred, false);
  const retryExpired = await createOrReplayPositionAction(
    pool,
    freshAttempt(
      {
        ...embeddedInput,
        positionRef: "position_expired-first-send",
        ownerBindingId: "binding_expired-first-send",
      },
      "expired-retry",
    ),
  );
  operationIds.push(retryExpired.operation.id);
  assert.equal(
    retryExpired.replayed,
    false,
    "fresh consent can retry a proven never-dispatched claim",
  );
  assert.equal(
    (
      await claimPositionActionSubmission(pool, {
        userId,
        operationId: retryExpired.operation.id,
        canonicalActionFingerprint: "a".repeat(64),
        executorId: "privy-authorization-evm-v1",
        embeddedDispatchProtocol: "privy_position_v1",
      })
    ).claimed,
    true,
  );
  const expiredRuntime = new PositionActionRuntimeService(
    pool,
    () => new Date(Date.now() + 6 * 60_000),
    [],
    null,
  );
  assert.equal(
    (await expiredRuntime.reconcile(userId, retryExpired.operation.id)).status,
    "failed",
    "the runtime exposes a terminal failure, not in_progress, after proving no dispatch",
  );
  assert.equal(
    (
      await fetchPositionActionForUser(pool, {
        userId,
        operationId: retryExpired.operation.id,
      })
    )?.status,
    "failed",
    "worker also closes new-protocol claims proven never dispatched",
  );

  const duplicate = await createOrReplayPositionAction(pool, {
    ...embeddedInput,
    positionRef: "position_duplicate-journal",
    ownerBindingId: "binding_duplicate_12345678",
    idempotencyKey: `duplicate-${crypto.randomUUID()}`,
  });
  operationIds.push(duplicate.operation.id);
  await claimPositionActionSubmission(pool, {
    userId,
    operationId: duplicate.operation.id,
    canonicalActionFingerprint: "f".repeat(64),
    executorId: "privy-authorization-evm-v1",
  });
  await recordPositionActionSubmission(pool, {
    userId,
    operationId: duplicate.operation.id,
    attemptNumber: 1,
    outcome: "submitted",
    submissionFingerprint: `privy-transaction-v1:other-${crypto.randomUUID()}`,
  });
  const duplicateState = await fetchPositionActionForUser(pool, {
    userId,
    operationId: duplicate.operation.id,
  });
  assert.ok(duplicateState?.submissionFingerprint);
  const duplicateReference = duplicateState.submissionFingerprint;
  await assert.rejects(
    () =>
      bindPositionActionSubmissionTransactionHash(pool, {
        userId,
        operationId: duplicate.operation.id,
        expectedSubmissionReference: duplicateReference,
        transactionHash,
      }),
    /already attributed/,
  );

  // One canonical EntryPoint bundle can redeem distinct tokens/owners. Both
  // direct reports and provider-reference binding must retain that identity.
  const bundleHash = `0x${crypto.randomBytes(32).toString("hex")}`;
  const ctf = "0x00000000000000000000000000000000000000b1";
  const collateral = "0x00000000000000000000000000000000000000c2";
  const ctfAbi = new ethers.Interface([
    "function redeemPositions(address,bytes32,bytes32,uint256[])",
  ]);
  for (const [index, identity] of [
    { ownerAddress: embeddedInput.ownerAddress, tokenId: "123" },
    { ownerAddress: embeddedInput.ownerAddress, tokenId: "124" },
    {
      ownerAddress: "0x00000000000000000000000000000000000000c1",
      tokenId: "123",
    },
  ].entries()) {
    const bundled = await createOrReplayPositionAction(pool, {
      ...embeddedInput,
      ...identity,
      positionRef: `position_bundle_${index}`,
      ownerBindingId: `binding_bundle_${index}_12345678`,
      planSnapshot: {
        outcome: "YES",
        tokenId: identity.tokenId,
        plan: {
          redeemable: true,
          targetAddress: ctf,
          payoutTokenAddress: collateral,
          data: ctfAbi.encodeFunctionData("redeemPositions", [
            collateral,
            ethers.ZeroHash,
            ethers.id(`bundle-condition-${identity.tokenId}`),
            [1],
          ]),
          expectedPayoutRaw: "1000000",
          yesBalanceRaw: "1000000",
          noBalanceRaw: "0",
        },
      },
      idempotencyKey: `bundle-${crypto.randomUUID()}`,
    });
    operationIds.push(bundled.operation.id);
    await claimPositionActionSubmission(pool, {
      userId,
      operationId: bundled.operation.id,
      canonicalActionFingerprint: "b".repeat(64),
      executorId: "privy-authorization-evm-v1",
    });
    const reference =
      index === 0
        ? bundleHash
        : `privy-transaction-v1:bundle-${crypto.randomUUID()}`;
    await recordPositionActionSubmission(pool, {
      userId,
      operationId: bundled.operation.id,
      attemptNumber: 1,
      outcome: "submitted",
      submissionFingerprint: reference,
    });
    const bound = await bindPositionActionSubmissionTransactionHash(pool, {
      userId,
      operationId: bundled.operation.id,
      expectedSubmissionReference: reference,
      transactionHash: bundleHash,
    });
    assert.equal(bound.submissionFingerprint, bundleHash);
  }

  const missing = await createOrReplayPositionAction(pool, {
    ...embeddedInput,
    positionRef: "position_missing-journal",
    ownerBindingId: "binding_missing_12345678",
    idempotencyKey: `missing-${crypto.randomUUID()}`,
  });
  operationIds.push(missing.operation.id);
  await claimPositionActionSubmission(pool, {
    userId,
    operationId: missing.operation.id,
    canonicalActionFingerprint: "d".repeat(64),
    executorId: "privy-authorization-evm-v1",
  });
  await markStalePositionActionClaimForRecovery(pool, {
    userId,
    operationId: missing.operation.id,
    staleBefore: new Date(Date.now() + 1_000),
  });
  await assert.rejects(
    () =>
      admitEmbeddedPositionSubmission(
        pool,
        userId,
        `${missing.operation.id}:1`,
        payload,
      ),
    /reconciliation/,
  );

  console.log(
    "[position-action-persistence-integration-tests] ok generic venue IDs, terminal-safe retry, concurrent idempotency, owner binding, exact sponsored action binding, ambiguous submit, receipt, postconditions, marker recovery",
  );
} finally {
  if (operationIds.length > 0) {
    await pool.query(
      `
        delete from position_action_effects
        where action_operation_id = any($1::uuid[])
      `,
      [operationIds],
    );
    await pool.query(
      `
        delete from position_action_attempts
        where action_operation_id = any($1::uuid[])
      `,
      [operationIds],
    );
    await pool.query(
      `
        delete from position_action_operations
        where id = any($1::uuid[])
      `,
      [operationIds],
    );
  }
  await pool.query("delete from users where id = any($1::uuid[])", [
    [userId, otherUserId],
  ]);
}
