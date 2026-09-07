#!/usr/bin/env tsx
// @requires-db

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createIntegrationTestPool } from "../../../test-database-target.js";
import { fetchUserFinancialLifecycleSummary } from "../../../services/user-financial-lifecycle.js";
import {
  createOrReplayFundingPreparationRun,
  fetchFundingPreparationRun,
  reportFundingPreparationAction,
  resolveFundingPreparationRun,
} from "../../persistence/funding-preparation-run-repository.js";
import {
  claimStandaloneReconciliation,
  finishStandaloneReconciliation,
  standaloneReconciliationSchemaReady,
} from "../../persistence/standalone-reconciliation-repository.js";
import {
  claimPositionActionSubmission,
  completePositionActionEffect,
  createOrReplayPositionAction,
  markStalePositionActionClaimForRecovery,
  POSITION_ACTION_MISSING_REFERENCE_CODE,
  recordPositionActionSubmission,
  recordPositionActionReceipt,
  recordPositionActionPostconditions,
  type PositionActionCreateInput,
} from "../../position-actions/position-action-repository.js";
import { runStandaloneReconciliationBatch } from "../../worker/standalone-reconciliation-worker.js";

const pool = await createIntegrationTestPool({
  max: 4,
  options: "-c statement_timeout=15000",
});
const userIds: string[] = [];

async function user(): Promise<string> {
  const result = await pool.query<{ id: string }>(
    "insert into users (email, is_active, is_verified) values ($1, true, true) returning id",
    [`standalone-recovery-${randomUUID()}@example.com`],
  );
  const id = result.rows[0]?.id;
  assert.ok(id);
  userIds.push(id);
  return id;
}

async function preparation(userId: string) {
  const actionId = `preparation_${randomUUID()}`;
  const run = await createOrReplayFundingPreparationRun(pool, {
    userId,
    request: {
      venueBindingOptionId: `binding_${randomUUID()}`,
      purpose: "buy",
      marketContextId: null,
      marketClass: null,
      positionActionRef: null,
      controllerWalletRef: null,
      expectedInspectionRevision: `inspection_${randomUUID()}`,
    },
    expiresAt: new Date(Date.now() + 60_000),
    materialize: async () => ({
      controllerWalletRef: randomUUID(),
      actions: [
        {
          kind: "evm_transaction",
          actionId,
          networkId: "evm:137",
          senderWalletId: "wallet_standalone_recovery",
          to: `0x${"a".repeat(40)}`,
          data: "0x",
          valueRaw: "0",
          gasLimitRaw: null,
        },
      ],
    }),
  });
  const submitted = await reportFundingPreparationAction(pool, {
    userId,
    runId: run.runId,
    actionId,
    report: {
      outcome: "submitted",
      transactionReference: `0x${"a".repeat(64)}`,
      networkFeeRaw: null,
    },
  });
  return submitted;
}

function positionInput(userId: string): PositionActionCreateInput {
  const suffix = randomUUID();
  return {
    userId,
    marketId: null,
    venueId: "polymarket",
    action: "redeem",
    positionRef: `position_${suffix}`,
    ownerBindingId: `binding_${suffix}`,
    ownerAddress: `0x${"a".repeat(40)}`,
    executionAddress: `0x${"b".repeat(40)}`,
    executionWalletId: `wallet_${suffix}`,
    executionMode: "web_client",
    inspectionRevision: `inspection_${suffix}`,
    actionDigest: `digest_${suffix}`,
    idempotencyKey: `idempotency_${suffix}`,
    status: "awaiting_user",
    planSnapshot: {},
    evidenceSnapshot: {},
    normalizedActions: [],
    postconditions: [],
  };
}

try {
  assert.equal(await standaloneReconciliationSchemaReady(pool), true);
  const prepUser = await user();
  const first = await preparation(prepUser);
  const second = await preparation(prepUser);
  const due = new Date(Date.now() + 1_000);
  // Explicitly order fixtures and isolate this disposable test's queue scope.
  await pool.query(
    "update funding_preparation_runs set reconciliation_next_attempt_at = $2 where id = any($1::uuid[])",
    [[first.runId, second.runId], new Date(due.getTime() - 1_000)],
  );
  const [left, right] = await Promise.all([
    claimStandaloneReconciliation(pool, {
      kind: "preparation",
      limit: 1,
      now: due,
      leaseMs: 5_000,
    }),
    claimStandaloneReconciliation(pool, {
      kind: "preparation",
      limit: 1,
      now: due,
      leaseMs: 5_000,
    }),
  ]);
  assert.equal(left.length, 1);
  assert.equal(right.length, 1);
  assert.notEqual(left[0]?.id, right[0]?.id);
  const firstLease = left[0];
  assert.ok(firstLease);
  const retryAt = new Date(due.getTime() + 30_000);
  assert.equal(
    await finishStandaloneReconciliation(pool, {
      lease: { ...firstLease, leaseToken: randomUUID() },
      retryAt,
    }),
    false,
  );
  assert.equal(
    await finishStandaloneReconciliation(pool, { lease: firstLease, retryAt }),
    true,
  );
  assert.equal(
    (
      await claimStandaloneReconciliation(pool, {
        kind: "preparation",
        limit: 2,
        now: due,
        leaseMs: 5_000,
      })
    ).length,
    0,
  );
  const recovered = await claimStandaloneReconciliation(pool, {
    kind: "preparation",
    limit: 1,
    now: new Date(due.getTime() + 5_001),
    leaseMs: 5_000,
  });
  assert.equal(recovered.length, 1);
  const lostLease = right[0];
  assert.ok(lostLease);
  assert.equal(
    await finishStandaloneReconciliation(pool, { lease: lostLease, retryAt }),
    false,
  );
  const newLease = recovered[0];
  assert.ok(newLease);
  await finishStandaloneReconciliation(pool, { lease: newLease, retryAt });

  await pool.query(
    "update funding_preparation_runs set reconciliation_next_attempt_at = $2 where user_id = $1",
    [prepUser, due],
  );
  const batch = await runStandaloneReconciliationBatch(
    pool,
    {
      preparation: async (userId, runId) => {
        assert.equal(userId, prepUser);
        if (runId === first.runId) throw new Error("bounded provider failure");
        return resolveFundingPreparationRun(pool, {
          userId,
          runId,
          succeeded: true,
        });
      },
      positionAction: async () => {
        throw new Error("unexpected position action");
      },
    },
    { now: due, retryDelayMs: 60_000 },
  );
  assert.equal(batch.claimed, 2);
  assert.equal(batch.reconciled, 1);
  assert.equal(batch.retryableErrors, 1);
  assert.equal(
    (
      await fetchFundingPreparationRun(pool, {
        userId: prepUser,
        runId: second.runId,
      })
    )?.status,
    "succeeded",
  );
  const pendingSummary = await fetchUserFinancialLifecycleSummary(pool, [
    prepUser,
  ]);
  assert.equal(pendingSummary.activeMovement, true);
  await resolveFundingPreparationRun(pool, {
    userId: prepUser,
    runId: first.runId,
    succeeded: true,
  });
  const resolvedSummary = await fetchUserFinancialLifecycleSummary(pool, [
    prepUser,
  ]);
  assert.equal(
    resolvedSummary.activeMovement,
    false,
    "historical successful broadcast must not block deletion",
  );
  assert.equal(
    resolvedSummary.protectedEvidence,
    true,
    "retain historical financial evidence",
  );

  const positionUser = await user();
  const input = positionInput(positionUser);
  const created = await createOrReplayPositionAction(pool, input);
  const claim = await claimPositionActionSubmission(pool, {
    userId: positionUser,
    operationId: created.operation.id,
    canonicalActionFingerprint: "b".repeat(64),
    executorId: "web-client-evm-v1",
  });
  assert.equal(claim.claimed, true);
  const fresh = await markStalePositionActionClaimForRecovery(pool, {
    userId: positionUser,
    operationId: created.operation.id,
    staleBefore: new Date(Date.now() - 60_000),
  });
  assert.equal(fresh.status, "submitting");
  const stale = await markStalePositionActionClaimForRecovery(pool, {
    userId: positionUser,
    operationId: created.operation.id,
    staleBefore: new Date(Date.now() + 1_000),
  });
  assert.equal(stale.status, "reconcile_required");
  assert.equal(stale.lastErrorCode, POSITION_ACTION_MISSING_REFERENCE_CODE);
  assert.equal(stale.broadcastMayHaveOccurred, true);
  const replay = await createOrReplayPositionAction(pool, {
    ...input,
    idempotencyKey: `fresh_${randomUUID()}`,
  });
  assert.equal(replay.operation.id, stale.id);
  assert.equal(
    (
      await claimPositionActionSubmission(pool, {
        userId: positionUser,
        operationId: stale.id,
        canonicalActionFingerprint: "b".repeat(64),
        executorId: "web-client-evm-v1",
      })
    ).claimed,
    false,
  );
  assert.equal(
    (
      await claimStandaloneReconciliation(pool, {
        kind: "position_action",
        limit: 1,
        now: new Date(Date.now() + 1_000),
        leaseMs: 5_000,
      })
    ).length,
    0,
    "missing-reference manual recovery must not hot-loop",
  );
  assert.equal(
    (await fetchUserFinancialLifecycleSummary(pool, [positionUser]))
      .activeMovement,
    true,
  );
  await assert.rejects(() =>
    recordPositionActionSubmission(pool, {
      userId: positionUser,
      operationId: stale.id,
      attemptNumber: claim.attemptNumber ?? 0,
      outcome: "failed",
      submissionFingerprint: null,
    }),
  );
  const late = await recordPositionActionSubmission(pool, {
    userId: positionUser,
    operationId: stale.id,
    attemptNumber: claim.attemptNumber ?? 0,
    outcome: "submitted",
    submissionFingerprint: `0x${"b".repeat(64)}`,
  });
  assert.equal(late.status, "submitted");
  const positionLeases = await claimStandaloneReconciliation(pool, {
    kind: "position_action",
    limit: 1,
    now: new Date(Date.now() + 1_000),
    leaseMs: 5_000,
  });
  assert.equal(
    positionLeases[0]?.id,
    late.id,
    "late receipt restores background polling without rebroadcast",
  );

  // A confirmed receipt may complete the financial action before its durable
  // activity/notification effects. Keep scheduling those unfinished effects.
  await recordPositionActionReceipt(pool, {
    userId: positionUser,
    operationId: late.id,
    receipt: "success",
    receiptEvidence: {},
  });
  await recordPositionActionPostconditions(pool, {
    userId: positionUser,
    operationId: late.id,
    status: "satisfied",
  });
  for (const effectKind of [
    "position_refresh",
    "collateral_refresh",
  ] as const) {
    await completePositionActionEffect(pool, {
      userId: positionUser,
      operationId: late.id,
      effectKind,
      evidence: {},
    });
  }
  const positionLease = positionLeases[0];
  assert.ok(positionLease);
  await finishStandaloneReconciliation(pool, {
    lease: positionLease,
    retryAt: due,
  });
  const effectsLease = (
    await claimStandaloneReconciliation(pool, {
      kind: "position_action",
      limit: 1,
      now: new Date(Date.now() + 2_000),
      leaseMs: 5_000,
    })
  )[0];
  assert.equal(
    effectsLease?.id,
    late.id,
    "completed operation still schedules pending effects",
  );
  assert.ok(effectsLease);
  for (const effectKind of ["activity", "notification"] as const) {
    await completePositionActionEffect(pool, {
      userId: positionUser,
      operationId: late.id,
      effectKind,
      evidence: {},
    });
  }
  await finishStandaloneReconciliation(pool, {
    lease: effectsLease,
    retryAt: due,
  });
  assert.equal(
    (
      await claimStandaloneReconciliation(pool, {
        kind: "position_action",
        limit: 1,
        now: new Date(Date.now() + 2_000),
        leaseMs: 5_000,
      })
    ).length,
    0,
    "fully completed operations must leave the queue",
  );

  // A lost submission response can have an already-finished ambiguous attempt;
  // a late positive reference must still recover that same immutable claim.
  const ambiguousCreated = await createOrReplayPositionAction(
    pool,
    positionInput(positionUser),
  );
  const ambiguousClaim = await claimPositionActionSubmission(pool, {
    userId: positionUser,
    operationId: ambiguousCreated.operation.id,
    canonicalActionFingerprint: "c".repeat(64),
    executorId: "web-client-evm-v1",
  });
  await recordPositionActionSubmission(pool, {
    userId: positionUser,
    operationId: ambiguousCreated.operation.id,
    attemptNumber: ambiguousClaim.attemptNumber ?? 0,
    outcome: "ambiguous",
    submissionFingerprint: null,
  });
  await markStalePositionActionClaimForRecovery(pool, {
    userId: positionUser,
    operationId: ambiguousCreated.operation.id,
    staleBefore: new Date(Date.now() + 1_000),
  });
  const recoveredAmbiguous = await recordPositionActionSubmission(pool, {
    userId: positionUser,
    operationId: ambiguousCreated.operation.id,
    attemptNumber: ambiguousClaim.attemptNumber ?? 0,
    outcome: "submitted",
    submissionFingerprint: `0x${"c".repeat(64)}`,
  });
  assert.equal(recoveredAmbiguous.status, "submitted");
  console.log(
    "[standalone-reconciliation-integration-tests] leases, recovery and deletion checks passed",
  );
} finally {
  for (const table of [
    "position_action_effects",
    "position_action_attempts",
  ] as const) {
    await pool.query(
      `delete from ${table} where action_operation_id in (select id from position_action_operations where user_id = any($1::uuid[]))`,
      [userIds],
    );
  }
  await pool.query(
    "delete from position_action_operations where user_id = any($1::uuid[])",
    [userIds],
  );
  await pool.query(
    "delete from funding_preparation_action_attempts where run_id in (select id from funding_preparation_runs where user_id = any($1::uuid[]))",
    [userIds],
  );
  await pool.query(
    "delete from funding_preparation_runs where user_id = any($1::uuid[])",
    [userIds],
  );
  await pool.query("delete from users where id = any($1::uuid[])", [userIds]);
  await pool.end();
}
