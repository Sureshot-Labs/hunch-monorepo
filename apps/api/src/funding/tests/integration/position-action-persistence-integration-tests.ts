#!/usr/bin/env tsx

// @requires-db

import assert from "node:assert/strict";
import crypto from "node:crypto";

import { pool } from "../../../db.js";
import {
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

  await assert.rejects(
    () =>
      createOrReplayPositionAction(pool, {
        ...ambiguousInput,
        evidenceSnapshot: { owner: "foreign" },
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

  const retryAfterAmbiguous = await claimPositionActionSubmission(pool, {
    userId,
    operationId: created.operation.id,
    canonicalActionFingerprint: "a".repeat(64),
    executorId: "web-client-evm-v1",
  });
  assert.equal(retryAfterAmbiguous.claimed, false);

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
    "[position-action-persistence-integration-tests] ok generic venue IDs, idempotency, owner binding, ambiguous submit, receipt, postconditions, marker recovery",
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
