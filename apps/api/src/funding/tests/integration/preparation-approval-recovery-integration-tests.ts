// @api-integration
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { ethers } from "ethers";
import { AuthService, type UserWallet } from "../../../auth.js";
import { stableWalletOpaqueId } from "../../../account-value/canonical.js";
import { createIntegrationTestPool } from "../../../test-database-target.js";
import { FundingPlanningRuntime } from "../../planner/runtime-service.js";
import type { PreparationResult } from "../../domain/contracts.js";
import type { PreparationReceiptReader } from "../../preparation/approval-receipt.js";
import {
  createOrReplayFundingPreparationRun,
  fetchFundingPreparationRun,
  reportFundingPreparationAction,
  resolveFundingPreparationRun,
  type FundingPreparationRun,
} from "../../persistence/funding-preparation-run-repository.js";

const schema = `preparation_test_${randomUUID().replaceAll("-", "")}`;
const db = await createIntegrationTestPool({
  max: 1,
  options: `-c search_path=${schema},public`,
});
const originalWalletLoader = AuthService.getUserWallets;
const userId = randomUUID();
const controllerId = randomUUID();
const owner = "0x1111111111111111111111111111111111111111";
const token = "0x2222222222222222222222222222222222222222";
const spender = "0x3333333333333333333333333333333333333333";
const hash = `0x${"ab".repeat(32)}`;
const iface = new ethers.Interface([
  "function approve(address spender,uint256 amount)",
  "event Approval(address indexed owner,address indexed spender,uint256 value)",
]);
const data = iface.encodeFunctionData("approve", [spender, 99n]);
const event = iface.encodeEventLog("Approval", [owner, spender, 99n]);
const receipt = {
  succeeded: true,
  blockNumber: 1,
  blockHash: hash,
  canonicalBlockHash: hash,
  confirmations: 100,
  logs: [{ address: token, data: event.data, topics: event.topics }],
};
const transaction = { chainId: 8453n, from: owner, to: token, data, value: 0n };
let outcome: "success" | "failure" | "unknown" = "success";
let unknownReference: string | null = null;
let inspectionFails = false;
let inspectionStatus: PreparationResult["status"] = "ready";
let inspections = 0;
const reader: PreparationReceiptReader = async (_, reference) => {
  if (outcome === "unknown" || reference === unknownReference)
    throw new Error("RPC timeout");
  return {
    transaction,
    receipt: {
      ...receipt,
      succeeded: outcome === "success",
      logs: outcome === "success" ? receipt.logs : [],
    },
  };
};
const runtime = new FundingPlanningRuntime(db, {
  preparationReceiptReader: reader,
});
Object.defineProperty(runtime, "preparationRuntime", {
  value: {
    inspectBindingOption: async (
      input: { controllerWalletRef: string },
      options: { forceFresh: boolean },
    ) => {
      inspections++;
      assert.equal(input.controllerWalletRef, controllerId);
      assert.equal(options.forceFresh, true);
      if (inspectionFails) throw new Error("current readiness unavailable");
      return { status: inspectionStatus } as PreparationResult;
    },
  },
});
AuthService.getUserWallets = async () => [
  {
    id: controllerId,
    walletType: "ethereum",
    isVerified: true,
    walletAddress: owner,
  } as UserWallet,
];
async function create(count = 1, submittedCount = count) {
  const run = await createOrReplayFundingPreparationRun(db, {
    userId,
    request: {
      venueBindingOptionId: `binding_${randomUUID()}`,
      purpose: "buy",
      marketContextId: null,
      marketClass: "clob",
      positionActionRef: null,
      controllerWalletRef: null,
      expectedInspectionRevision: randomUUID(),
    },
    expiresAt: new Date(Date.now() + 60_000),
    materialize: async (runId) => ({
      controllerWalletRef: controllerId,
      actions: Array.from({ length: count }, (_, ordinal) => ({
        kind: "evm_transaction" as const,
        actionId: `approval_${runId}_${ordinal}`,
        networkId: "evm:8453",
        senderWalletId: stableWalletOpaqueId({
          walletType: "ethereum",
          networkId: "evm:8453",
          address: owner,
        }),
        to: token,
        data,
        valueRaw: "0",
        gasLimitRaw: null,
      })),
    }),
  });
  let result = run;
  for (const attempt of run.actions.slice(0, submittedCount)) {
    result = await reportFundingPreparationAction(db, {
      userId,
      runId: run.runId,
      actionId: attempt.actionId,
      report: {
        outcome: "submitted",
        transactionReference:
          attempt.ordinal === 0 ? hash : `0x${"cd".repeat(32)}`,
        networkFeeRaw: null,
      },
    });
  }
  return result;
}
async function read(run: FundingPreparationRun) {
  const result = await runtime.preparationRun(userId, run.runId);
  assert.ok(result);
  return result;
}
function actionAt(run: FundingPreparationRun, ordinal = 0) {
  const action = run.actions[ordinal];
  assert.ok(action);
  return action;
}
let createdSchema = false;
try {
  const version = await db.query("show server_version_num");
  assert.equal(
    Math.floor(Number(version.rows[0].server_version_num) / 10_000),
    16,
  );
  await db.query(`create schema ${schema}`);
  createdSchema = true;
  await db.query(`create table users (id uuid primary key);
    create function funding_touch_updated_at() returns trigger language plpgsql as $$ begin new.updated_at = now(); return new; end $$`);
  await db.query(
    await readFile(
      new URL(
        "../../../../../../packages/db/migrations/0193_funding_preparation_runs.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  await db.query("insert into users (id) values ($1)", [userId]);
  const legacy = await create(1, 0);
  await reportFundingPreparationAction(db, {
    userId,
    runId: legacy.runId,
    actionId: actionAt(legacy).actionId,
    report: {
      outcome: "failed",
      transactionReference: null,
      networkFeeRaw: null,
    },
  });
  const pendingBeforeMigration = await create();
  const oldSuccess = await create();
  await resolveFundingPreparationRun(db, {
    userId,
    runId: oldSuccess.runId,
    succeeded: true,
    expectedActions: oldSuccess.actions,
  });
  await db.query(
    await readFile(
      new URL(
        "../../../../../../packages/db/migrations/0256_preparation_approval_receipt_failure.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  assert.equal(
    (await fetchFundingPreparationRun(db, { userId, runId: legacy.runId }))
      ?.status,
    "failed",
  );
  assert.equal(
    (await fetchFundingPreparationRun(db, { userId, runId: oldSuccess.runId }))
      ?.status,
    "succeeded",
    "migration preserves the current production legacy shape",
  );

  const resolved = await read(pendingBeforeMigration);
  assert.equal(resolved.status, "succeeded");
  assert.equal(
    inspections,
    1,
    "receipt success refreshes exact readiness before returning",
  );
  // The worker and API own separate in-memory inspection caches. A terminal
  // journal read must refresh this API instance, not only the worker's cache.
  let terminalReceiptReads = 0;
  const apiRuntime = new FundingPlanningRuntime(db, {
    preparationReceiptReader: async () => {
      terminalReceiptReads++;
      throw new Error("terminal reads must not re-read receipt or submit");
    },
  });
  let apiReady = false;
  Object.defineProperty(apiRuntime, "preparationRuntime", {
    value: {
      inspectBindingOption: async (
        input: { controllerWalletRef: string },
        options: { forceFresh?: boolean } = {},
      ) => {
        assert.equal(input.controllerWalletRef, controllerId);
        if (options.forceFresh) apiReady = true;
        return { status: apiReady ? "ready" : "setup_required" };
      },
    },
  });
  const exactRequest = {
    ...resolved.request,
    controllerWalletRef: controllerId,
  };
  assert.equal(
    (await apiRuntime.inspectPreparation(userId, exactRequest)).status,
    "setup_required",
  );
  await apiRuntime.preparationRun(userId, resolved.runId);
  assert.equal(
    (await apiRuntime.inspectPreparation(userId, exactRequest)).status,
    "ready",
    "GET after worker success must refresh API-local pre-approval readiness",
  );
  apiReady = false;
  await apiRuntime.reconcilePreparationRun(userId, resolved.runId);
  assert.equal(
    apiReady,
    true,
    "explicit reconcile refreshes terminal success too",
  );
  assert.equal(terminalReceiptReads, 0);
  await read(resolved);
  assert.equal(
    inspections,
    2,
    "terminal read refreshes readiness without re-approving",
  );
  for (const fails of [false, true]) {
    inspectionStatus = "unavailable";
    inspectionFails = fails;
    assert.equal(
      (await read(await create())).status,
      "succeeded",
      "market readiness/RPC cannot undo approval receipt success",
    );
  }
  inspectionFails = false;
  inspectionStatus = "ready";
  outcome = "failure";
  const failedRun = await create(2, 1);
  const before = inspections;
  const failed = await read(failedRun);
  assert.equal(failed.status, "failed");
  assert.ok(failed.resolvedAt);
  assert.equal(failed.actions[0]?.broadcastMayHaveOccurred, true);
  assert.equal(failed.actions[0]?.transactionReference, hash);
  assert.deepEqual(failed.actions[0]?.report, failedRun.actions[0]?.report);
  assert.equal(
    failed.actions[1]?.state,
    "action_required",
    "never fabricate a sibling broadcast",
  );
  assert.equal(
    inspections,
    before,
    "failed receipt cannot be replaced by current ready allowance",
  );
  assert.equal(
    (await runtime.reconcilePreparationRun(userId, failed.runId))?.status,
    "failed",
  );
  const preserved = await db.query(
    "select receipt_evidence from funding_preparation_action_attempts where action_id=$1",
    [actionAt(failed).actionId],
  );
  assert.equal(preserved.rows[0].receipt_evidence.failureFinalized, true);
  assert.equal(
    (
      await reportFundingPreparationAction(db, {
        userId,
        runId: failed.runId,
        actionId: actionAt(failed).actionId,
        report: {
          outcome: "submitted",
          transactionReference: hash,
          networkFeeRaw: null,
        },
      })
    ).status,
    "failed",
    "same report is replayable after receipt resolution",
  );
  await reportFundingPreparationAction(db, {
    userId,
    runId: failed.runId,
    actionId: actionAt(failed, 1).actionId,
    report: {
      outcome: "cancelled",
      transactionReference: null,
      networkFeeRaw: null,
    },
  });
  assert.equal(
    (await runtime.reconcilePreparationRun(userId, failed.runId))?.status,
    "failed",
    "late unsubmitted sibling report cannot resurrect a proven failure as ready",
  );

  const mixed = await create(2);
  unknownReference = actionAt(mixed, 1).transactionReference;
  const stillPending = await read(mixed);
  assert.equal(stillPending.status, "submitted");
  assert.equal(stillPending.actions[0]?.state, "failed");
  assert.equal(stillPending.actions[1]?.state, "submitted");
  assert.equal(
    stillPending.resolvedAt,
    null,
    "unknown sibling remains tracked",
  );
  unknownReference = null;
  outcome = "success";
  const finishedMixed = await read(stillPending);
  assert.equal(finishedMixed.status, "failed");
  assert.equal(finishedMixed.actions[1]?.state, "succeeded");

  outcome = "unknown";
  const unknown = await create();
  await db.query(
    "update funding_preparation_runs set expires_at = now() - interval '1 day' where id=$1",
    [unknown.runId],
  );
  assert.equal(
    (await read(unknown)).status,
    "submitted",
    "expiry cannot release an unknown broadcast",
  );
  await assert.rejects(
    db.query(
      "update funding_preparation_action_attempts set state='failed', resolved_at=now() where action_id=$1",
      [actionAt(unknown).actionId],
    ),
    /check constraint/,
  );
  await assert.rejects(
    resolveFundingPreparationRun(db, {
      userId: randomUUID(),
      runId: unknown.runId,
      succeeded: true,
    }),
    /not found/,
  );
  const unchanged = await resolveFundingPreparationRun(db, {
    userId,
    runId: unknown.runId,
    approvalOutcomes: [
      {
        actionId: actionAt(unknown).actionId,
        status: "failed",
        evidence: preserved.rows[0].receipt_evidence,
      },
    ],
    expectedActions: unknown.actions.map((a) => ({
      ...a,
      actionFingerprint: "changed",
    })),
  });
  assert.equal(
    unchanged.status,
    "submitted",
    "stale expected action snapshot cannot resolve a newer attempt",
  );
  await assert.rejects(
    resolveFundingPreparationRun(db, {
      userId,
      runId: unknown.runId,
      expectedActions: unknown.actions,
      approvalOutcomes: [
        {
          actionId: actionAt(unknown).actionId,
          status: "failed",
          evidence: {
            ...preserved.rows[0].receipt_evidence,
            transactionReference: `0x${"ef".repeat(32)}`,
          },
        },
      ],
    }),
    /does not match/,
  );
  assert.equal((await read(unknown)).status, "submitted");
  console.log(
    "[preparation-approval-recovery] PostgreSQL 16 migration, cached readiness, failure/unknown, sibling, replay and ownership checks passed",
  );
} finally {
  AuthService.getUserWallets = originalWalletLoader;
  if (createdSchema) await db.query(`drop schema ${schema} cascade`);
  await db.end();
}
