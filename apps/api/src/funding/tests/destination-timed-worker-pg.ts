import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { relayExactRefundTestFixture } from "./relay-exact-refund-writer-pg.js";
import {
  recordRefundSourceActionForTest,
  recordRefundSourceDebitForTest,
} from "./refund-source-debit-fixture.js";
import { runFundingReconciliationBatch } from "../reconciliation/funding-reducer.js";
import { reconcileRelayDestinationReceipts } from "../reconciliation/relay-destination-receipts.js";
import type { FundingTransactionReferenceCodec } from "../execution/transaction-reference-codec.js";

type Fixture = ReturnType<typeof relayExactRefundTestFixture>;

/** Real job claim/lease/reducer/due scheduling with an advancing application
 * clock. Only chain/provider IO is synthetic. No sleeps, manual requeue after
 * each tick, enlarged timeout, historical execution, or alternate scheduler. */
export async function verifyDestinationTimedWorkerPg(
  pool: Pool,
  input: {
    fixture: (
      evm: boolean,
      existing?: { userId: string; owner: string },
    ) => Promise<Fixture>;
    publishMetadata: (data: Fixture) => Promise<void>;
    transactionReferenceCodec: FundingTransactionReferenceCodec;
  },
) {
  const target = await input.fixture(true);
  await recordRefundSourceDebitForTest(pool, target);
  const negatives: Fixture[] = [];
  for (let index = 0; index < 24; index++) {
    const candidate = await input.fixture(true, {
      userId: target.base.source.accountId,
      owner: target.owner,
    });
    await recordRefundSourceActionForTest(pool, candidate, "unsubmitted");
    negatives.push(candidate);
  }
  await input.publishMetadata(target);
  const startedAt = new Date();
  // Exact disposable fixtures only. Other retained integration jobs are not
  // changed. A one-job batch plus target priority keeps callbacks target-scoped.
  await pool.query(
    `update funding_reconciliation_jobs set due_at=$2::timestamptz+interval '1 day'
      where operation_id=any($1::uuid[])`,
    [negatives.map((data) => data.base.operationId), startedAt],
  );
  await pool.query(
    `update funding_reconciliation_jobs set priority=1000000,due_at=$2,status='scheduled',
      lease_owner=null,lease_token=null,lease_until=null where operation_id=$1`,
    [target.base.operationId, startedAt],
  );

  try {
    let changedNegative = false;
    let injectedThisTick = false;
    let rollbackObserved = false;
    const db = Object.create(pool) as Pool;
    db.query = pool.query.bind(pool);
    db.connect = (async () => {
      const client = await pool.connect();
      return new Proxy(client, {
        get(client, key) {
          if (key === "query")
            return async (sql: string, values?: unknown[]) => {
              if (
                !changedNegative &&
                sql.includes("select funding_classification_fence")
              ) {
                const facts = JSON.parse(String(values?.[0])) as {
                  operationId: string;
                }[];
                assert.ok(
                  facts.some(
                    (fact) =>
                      fact.operationId === negatives[0].base.operationId,
                  ),
                  "the real final fence includes the negative witness",
                );
                await pool.query(
                  "update funding_operation_segments set raw_status='pending' where id=$1",
                  [negatives[0].base.segmentId],
                );
                changedNegative = true;
                injectedThisTick = true;
              }
              return client.query(sql, values);
            };
          const value = Reflect.get(client, key);
          return typeof value === "function" ? value.bind(client) : value;
        },
      });
    }) as Pool["connect"];

    let at = startedAt;
    let observations = 0;
    const leaseTokens = new Set<string>();
    let ticks = 0;
    let finished = false;
    while (at.getTime() - startedAt.getTime() < 90_000) {
      ticks++;
      injectedThisTick = false;
      const tickStartedAt = Date.now();
      const result = await runFundingReconciliationBatch(db, {
        workerId: `timed-destination-${randomUUID()}`,
        limit: 1,
        concurrency: 1,
        leaseSeconds: 30,
        pollDelayMs: 2_000,
        idlePollDelayMs: 15_000,
        retryDelayMs: 30_000,
        recoveryPollDelayMs: 60_000,
        terminalTimeoutMs: 90_000,
        now: at,
        providerPoll: async (operationId, now, work) => {
          assert.equal(operationId, target.base.operationId);
          assert.ok(work);
          assert.ok(work.deadlineMs > Date.now());
          assert.equal(leaseTokens.has(work.progressToken), false);
          leaseTokens.add(work.progressToken);
          const lease = (
            await pool.query(
              `select status,lease_token::text,lease_until from funding_reconciliation_jobs
              where operation_id=$1`,
              [operationId],
            )
          ).rows[0];
          assert.equal(lease.status, "leased");
          assert.equal(lease.lease_token, work.progressToken);
          assert.equal(lease.lease_until.getTime() - at.getTime(), 30_000);
          await reconcileRelayDestinationReceipts(
            db,
            {
              operationId,
              segmentId: target.base.segmentId,
              transactionHashes: target.hashes,
              now,
              referenceCodec: target.base.referenceCodec,
              transactionReferenceCodec: input.transactionReferenceCodec,
              // Match finance-worker's runtime default. The one-job test limit
              // above bounds queue selection, not its existing evidence policy.
              work: { ...work, limit: 25 },
            },
            async () => {
              observations++;
              return target.evm;
            },
          );
          return { requestsPolled: 1 };
        },
      });
      assert.deepEqual(result.operationIds, [target.base.operationId]);
      assert.equal(result.deadLettered, 0);
      const state = (
        await pool.query(
          `select operation_row.status,operation_row.error_code,operation_row.support_metadata,
          job_row.status as job_status,job_row.due_at,job_row.lease_token,job_row.last_error_code,
          (select count(*)::int from funding_observations observation_row
            where observation_row.operation_id=operation_row.id and kind='destination_credit') as credits,
          (select count(*)::int from funding_receive_canonical_events event_row
            where event_row.network_id=$2 and event_row.tx_hash=any($3::text[])
              and event_row.allocation_error_code='internal_owned_route_destination_suppressed') as suppressions
        from funding_operations operation_row join funding_reconciliation_jobs job_row
          on job_row.operation_id=operation_row.id where operation_row.id=$1`,
          [target.base.operationId, target.evm[0].networkId, target.hashes],
        )
      ).rows[0];
      assert.notEqual(state.error_code, "reconciliation_evidence_timeout");
      assert.notEqual(state.status, "recovery_required");
      assert.equal(state.lease_token, null, "each real lease is finished");
      if (injectedThisTick) {
        assert.equal(
          result.failed,
          1,
          "stale F must fail this real worker pass",
        );
        assert.equal(state.credits, 0, "stale F rolls back all credits");
        assert.equal(
          state.suppressions,
          0,
          "stale F rolls back all suppressions",
        );
        assert.equal(state.job_status, "scheduled");
        assert.ok(state.last_error_code);
        assert.equal(state.due_at.getTime() - at.getTime(), 30_000);
        rollbackObserved = true;
      }
      if (state.credits === 2) {
        assert.equal(
          state.status,
          "completed",
          "the ordinary reducer consumes exact destination evidence",
        );
        finished = true;
        break;
      }
      assert.equal(state.credits, 0, "multi-event publication stays atomic");
      assert.equal(state.job_status, "scheduled");
      const delay = state.due_at.getTime() - at.getTime();
      assert.ok(
        delay === 2_000 || delay === 30_000,
        "ordinary active or transient-error scheduling, not manual due-date repair",
      );
      at = new Date(
        Math.max(
          state.due_at.getTime(),
          at.getTime() + Date.now() - tickStartedAt,
        ),
      );
    }
    assert.equal(
      finished,
      true,
      "healthy dense evidence finishes before generic timeout",
    );
    assert.equal(
      changedNegative,
      true,
      "stale cached negative is repaired by ordinary jobs",
    );
    assert.equal(rollbackObserved, true);
    assert.equal(observations, ticks, "one observation per real worker lease");
    assert.ok(
      ticks > 2,
      "the test exercises successive due jobs, not one local drain",
    );
    const progress = (
      await pool.query(
        `select coalesce(sum(scan_row.progress_revision),0)::text as pages
        from funding_receive_refund_scans scan_row join funding_receive_canonical_events event_row
          on event_row.id=scan_row.event_id where event_row.network_id=$1 and event_row.tx_hash=any($2::text[])`,
        [target.evm[0].networkId, target.hashes],
      )
    ).rows[0];
    assert.ok(
      Number(progress.pages) > 45,
      "one page per two-second tick would exceed 90 seconds",
    );
    assert.ok(Number(progress.pages) <= ticks * 25);
    console.log(
      "PASS timed destination worker",
      JSON.stringify({
        ticks,
        pages: progress.pages,
        modeledElapsedMs: at.getTime() - startedAt.getTime(),
      }),
    );
  } finally {
    // Keep this retained synthetic fixture out of later suites' global claims,
    // including on assertion failure. Never release money or alter evidence.
    await pool.query(
      `update funding_reconciliation_jobs set priority=0,
        due_at=greatest(due_at,$2::timestamptz+interval '1 day')
        where operation_id=$1 and lease_token is null`,
      [target.base.operationId, startedAt],
    );
  }
}
