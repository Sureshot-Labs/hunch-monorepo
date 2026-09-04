#!/usr/bin/env tsx

// @requires-db

import assert from "node:assert/strict";
import crypto from "node:crypto";

import "../../../integration-test-database-guard.js";
import { pool } from "../../../db.js";
import {
  bindPositionActionSubmissionTransactionHash,
  claimPositionActionSubmission,
  completePositionActionEffect,
  createOrReplayPositionAction,
  fetchPositionActionForUser,
  PositionActionPersistenceError,
  recordPositionActionPostconditions,
  recordPositionActionReceipt,
  recordPositionActionSubmission,
  type PositionActionCreateInput,
} from "../../position-actions/position-action-repository.js";
import { embeddedEvmSponsorshipTestHooks } from "../../../services/embedded-evm-sponsorship.js";

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
