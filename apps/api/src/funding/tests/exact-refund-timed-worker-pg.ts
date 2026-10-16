import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Pool } from "@hunch/infra";
import { RelayClient } from "../../funding-providers/relay/client.js";
import { RelayReconciliationDriver } from "../../funding-providers/relay/reconciliation.js";
import { createRelayDepositAddressCodec } from "../../funding-providers/relay/reference-codec.js";
import { createFundingTransactionReferenceCodec } from "../execution/transaction-reference-codec.js";
import {
  recoverStoppedFundingOperations,
  runFundingReconciliationBatch,
  type FundingEvidenceWorkContext,
} from "../reconciliation/funding-reducer.js";
import { reconcileRelayExactRefundReceipts } from "../reconciliation/relay-exact-refund-runtime.js";
import { loadFundingLifecycleFactsForOperationInTransaction } from "../lifecycle/funding-lifecycle-facts-repository.js";
import {
  recordRefundSourceActionForTest,
  recordRefundSourceDebitForTest,
} from "./refund-source-debit-fixture.js";
import type { relayExactRefundTestFixture } from "./relay-exact-refund-writer-pg.js";

type Fixture = ReturnType<typeof relayExactRefundTestFixture>;

/** Actual queue leases, due scheduling, fifth provider callback and stopped
 * evidence-only repair. Only provider/chain transport is synthetic. No sleeps,
 * manual requeue between ticks, execution callback or alternate scheduler. */
export async function verifyExactRefundTimedWorkerPg(
  pool: Pool,
  fixture: (existing?: { userId: string; owner: string }) => Promise<Fixture>,
) {
  const transactionReferenceCodec = createFundingTransactionReferenceCodec({
    encryptionKey: Buffer.alloc(32, 79),
    lookupHmacKey: "offline-exact-timed-worker-transaction-key",
    keyVersion: 1,
  });
  let startedAt = new Date();
  const readState = async (data: Fixture) =>
    (
      await pool.query(
        `select operation_row.status,operation_row.error_code,operation_row.support_metadata,
      job_row.status as job_status,job_row.due_at,job_row.lease_token,
      (select count(*)::int from funding_observations observation_row
        where observation_row.operation_id=operation_row.id and kind='refund_credit') as credits,
      (select count(*)::int from funding_operation_step_attempts attempt_row
        join funding_operation_steps step_row on step_row.id=attempt_row.step_id
        where step_row.operation_id=operation_row.id) as attempts
      from funding_operations operation_row join funding_reconciliation_jobs job_row
        on job_row.operation_id=operation_row.id where operation_row.id=$1`,
        [data.base.operationId],
      )
    ).rows[0];
  const parked: Fixture[] = [];
  const driverFor = (
    data: Fixture,
    read: () => { indices: number[]; pending?: boolean },
    checkWork: (work: FundingEvidenceWorkContext) => Promise<void>,
  ) => {
    const relay = new RelayClient({
      apiKey: "offline-exact-timed-worker",
      fetchImpl: async (url) => {
        assert.equal(new URL(url).pathname, "/intents/status/v3");
        return Response.json(data.status);
      },
    });
    return new RelayReconciliationDriver(
      relay,
      data.base.referenceCodec,
      createRelayDepositAddressCodec({
        encryptionKey: Buffer.alloc(32, 80),
        lookupHmacKey: "offline-exact-timed-worker-deposit-key",
        keyVersion: 1,
      }),
      async () => assert.fail("refund reached destination callback"),
      async (db, target) => {
        assert.ok(target.work);
        const originalWork = target.work;
        await checkWork(originalWork);
        await reconcileRelayExactRefundReceipts(
          db,
          relay,
          {
            ...data.base,
            ...target,
            transactionReferenceCodec,
            work: { ...originalWork, limit: 25 },
          },
          async (_db, _relay, input) => {
            assert.ok(input.deadlineMs !== undefined);
            assert.ok(
              input.deadlineMs <= originalWork.deadlineMs &&
                input.deadlineMs > Date.now(),
            );
            const selected = read();
            return selected.pending
              ? { kind: "pending", reason: "refund_work_deadline" }
              : {
                  kind: "observed",
                  request: data.request,
                  evmEvents: selected.indices.map((index) => data.evm[index]),
                  nativeLedger: [],
                  reason: null,
                };
          },
        );
      },
    );
  };
  try {
    const data = await fixture();
    parked.push(data);
    await recordRefundSourceDebitForTest(pool, data);
    const negatives: Fixture[] = [];
    for (let index = 0; index < 24; index++) {
      const candidate = await fixture({
        userId: data.base.source.accountId,
        owner: data.owner,
      });
      negatives.push(candidate);
      parked.push(candidate);
      await recordRefundSourceActionForTest(pool, candidate, "unsubmitted");
    }
    startedAt = new Date();
    await pool.query(
      "update funding_reconciliation_jobs set due_at=$2::timestamptz+interval '1 day' where operation_id=any($1::uuid[])",
      [negatives.map((item) => item.base.operationId), startedAt],
    );
    await pool.query(
      `update funding_reconciliation_jobs set priority=1000000,due_at=$2,status='scheduled',
      lease_owner=null,lease_token=null,lease_until=null where operation_id=$1`,
      [data.base.operationId, startedAt],
    );
    const tokens = new Set<string>();
    let tick = 0;
    let partial = false;
    let completed = false;
    let at = startedAt;
    const driver = driverFor(
      data,
      () => ({ indices: partial ? [0, 1] : [0], pending: tick === 1 }),
      async (work) => {
        assert.equal(tokens.has(work.progressToken), false);
        tokens.add(work.progressToken);
        const lease = (
          await pool.query(
            "select status,lease_token::text from funding_reconciliation_jobs where operation_id=$1",
            [data.base.operationId],
          )
        ).rows[0];
        assert.equal(lease.status, "leased");
        assert.equal(lease.lease_token, work.progressToken);
      },
    );
    while (at.getTime() - startedAt.getTime() < 90_000) {
      tick++;
      const tickStartedAt = Date.now();
      const result = await runFundingReconciliationBatch(pool, {
        workerId: `exact-timed-${randomUUID()}`,
        limit: 1,
        concurrency: 1,
        leaseSeconds: 30,
        pollDelayMs: 2_000,
        idlePollDelayMs: 15_000,
        retryDelayMs: 30_000,
        terminalTimeoutMs: 90_000,
        now: at,
        providerPoll: (id, now, work) =>
          driver.pollOperation(pool, id, now, work),
      });
      assert.deepEqual(result.operationIds, [data.base.operationId]);
      assert.equal(result.failed, 0);
      assert.equal(result.deadLettered, 0);
      const state = await readState(data);
      assert.equal(
        state.lease_token,
        null,
        "ordinary worker finishes each original lease",
      );
      assert.equal(
        state.attempts,
        1,
        "evidence never creates another financial attempt",
      );
      assert.notEqual(state.error_code, "reconciliation_evidence_timeout");
      if (tick === 1)
        assert.equal(state.credits, 0, "expired observation is not money");
      if (state.credits === 1) {
        partial = true;
        assert.notEqual(state.status, "refunded");
      }
      if (state.credits === 2) {
        assert.equal(state.status, "refunded");
        completed = true;
        break;
      }
      assert.equal(state.job_status, "scheduled");
      assert.ok(state.due_at.getTime() > at.getTime());
      at = new Date(
        Math.max(
          state.due_at.getTime(),
          at.getTime() + Date.now() - tickStartedAt,
        ),
      );
    }
    assert.equal(partial, true, "real successive leases persist a partial set");
    assert.equal(
      completed,
      true,
      "healthy dense exact evidence converges before generic timeout",
    );
    assert.ok(tick >= 3);
    console.log(
      "PASS timed exact worker deadline -> ordinary retry -> partial -> refunded",
      JSON.stringify({
        ticks: tick,
        modeledElapsedMs: at.getTime() - startedAt.getTime(),
      }),
    );

    const stopped = await fixture();
    parked.push(stopped);
    await recordRefundSourceDebitForTest(pool, stopped);
    await pool.query(
      "update funding_operations set status='recovery_required',version=version+1 where id=$1",
      [stopped.base.operationId],
    );
    await pool.query(
      `update funding_reconciliation_jobs set status='dead_letter',lease_owner=null,lease_token=null,
      lease_until=null,completed_at=now() where operation_id=$1`,
      [stopped.base.operationId],
    );
    // Exact disposable queue selection only, as in the existing stopped-repair
    // tests; do not rewrite ordinary due dates or manufacture a recovery token.
    const previous = (
      BigInt(`0x${stopped.base.operationId.replaceAll("-", "")}`) - 1n
    )
      .toString(16)
      .padStart(32, "0");
    const previousId = `${previous.slice(0, 8)}-${previous.slice(8, 12)}-${previous.slice(12, 16)}-${previous.slice(16, 20)}-${previous.slice(20)}`;
    await pool.query(
      "update funding_recovery_scan_cursor set last_operation_id=$1 where cursor_name='stopped_evidence_v1'",
      [previousId],
    );
    let stoppedCalls = 0;
    const stoppedDriver = driverFor(
      stopped,
      () => ({ indices: [0, 1] }),
      async (work) => {
        stoppedCalls++;
        const state = await readState(stopped);
        assert.ok(
          state.support_metadata.evidenceOnlyRecoveryAt,
          "old consent is fenced BEFORE provider callback",
        );
        assert.equal(state.lease_token, work.progressToken);
      },
    );
    const repairAt = new Date(startedAt.getTime() + 8 * 86400_000);
    assert.equal(
      await recoverStoppedFundingOperations(pool, {
        workerId: `exact-stopped-${randomUUID()}`,
        now: repairAt,
        receiptPoll: async () => ({ receiptsPolled: 0 }),
        providerPoll: (id, now, work) => {
          assert.equal(id, stopped.base.operationId);
          return stoppedDriver.pollOperation(pool, id, now, work);
        },
      }),
      1,
    );
    const repaired = await readState(stopped);
    assert.equal(stoppedCalls, 1);
    assert.equal(repaired.credits, 2);
    assert.equal(repaired.status, "refunded");
    assert.equal(
      repaired.job_status,
      "scheduled",
      "repair returns to ordinary reorg watch",
    );
    assert.equal(repaired.lease_token, null);
    assert.equal(repaired.attempts, 1);
    const facts = await loadFundingLifecycleFactsForOperationInTransaction(
      pool,
      { operationId: stopped.base.operationId, now: repairAt },
    );
    assert.equal(
      facts?.actions[0]?.authorization,
      "blocked",
      "repaired cash never revives old execution consent",
    );
    console.log(
      "PASS stopped evidence-only repair -> actual fifth callback -> exact refund, no new attempt/old consent",
    );
  } finally {
    await pool.query(
      `update funding_reconciliation_jobs set priority=0,
      due_at=greatest(due_at,$2::timestamptz+interval '1 day')
      where operation_id=any($1::uuid[]) and lease_token is null`,
      [parked.map((data) => data.base.operationId), startedAt],
    );
  }
}
