import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  commitFundingClassificationTransaction,
  FUNDING_CLASSIFICATION_REVISION_SQL,
  FUNDING_CLASSIFICATION_CURRENT_SET_SQL,
  fundingClassificationRevisionsAreCurrent,
  FundingClassificationChangedError,
  lockFundingClassificationOperations,
  readFundingClassificationPage,
  readFundingClassificationRevision,
} from "../persistence/funding-classification-revisions.js";
import {
  advanceFundingObservationFinalityInTransaction,
  allocateFundingObservationInTransaction,
  releaseFundingReservationInTransaction,
} from "../persistence/funding-operation-repository.js";
import type { relayExactRefundTestFixture } from "./relay-exact-refund-writer-pg.js";

type Fixture = ReturnType<typeof relayExactRefundTestFixture>;

type PlanNode = {
  "Node Type": string;
  "Actual Rows": number;
  "Local Hit Blocks": number;
  "Local Read Blocks": number;
  Plans?: PlanNode[];
};

async function verifyRevisionLookupPlans(db: PoolClient, data: Fixture) {
  await db.query("begin");
  try {
    // Same indexed lookup columns, representative unrelated cardinality. These
    // temp relations test ONLY the read SQL, not trigger/foreign-key behavior.
    await db.query(
      "create temp table funding_operations(id uuid primary key,user_id uuid not null) on commit drop",
    );
    await db.query(
      "create temp table funding_classification_revisions(operation_id uuid primary key,revision bigint not null) on commit drop",
    );
    await db.query(
      "insert into funding_operations select gen_random_uuid(),gen_random_uuid() from generate_series(1,50000)",
    );
    await db.query(
      "insert into funding_classification_revisions select id,100 from funding_operations",
    );
    await db.query("insert into funding_operations values($1,$2)", [
      data.base.operationId,
      data.base.source.accountId,
    ]);
    await db.query("analyze funding_operations");
    await db.query("analyze funding_classification_revisions");
    await db.query(
      `prepare classification_revision_probe(uuid,uuid) as ${FUNDING_CLASSIFICATION_REVISION_SQL}`,
    );
    for (const mode of ["force_custom_plan", "force_generic_plan"] as const) {
      await db.query(`set local plan_cache_mode=${mode}`);
      for (const scenario of [
        "absent-zero",
        "hit",
        "wrong-owner",
        "missing",
      ] as const) {
        if (scenario === "hit")
          await db.query(
            "insert into funding_classification_revisions values($1,2)",
            [data.base.operationId],
          );
        const operationId =
          scenario === "missing" ? randomUUID() : data.base.operationId;
        const userId =
          scenario === "wrong-owner"
            ? randomUUID()
            : data.base.source.accountId;
        // Only locally generated UUIDs enter EXPLAIN EXECUTE; application SQL
        // itself always uses bound parameters.
        for (const value of [operationId, userId])
          assert.match(value, /^[0-9a-f-]{36}$/);
        const { rows } = await db.query<{
          "QUERY PLAN": { Plan: PlanNode; "Execution Time": number }[];
        }>(
          `explain (analyze,buffers,format json) execute classification_revision_probe('${operationId}','${userId}')`,
        );
        const plan = rows[0]["QUERY PLAN"][0];
        const nodes = (node: PlanNode): PlanNode[] => [
          node,
          ...(node.Plans ?? []).flatMap(nodes),
        ];
        assert.ok(
          nodes(plan.Plan).every((node) => node["Node Type"] !== "Seq Scan"),
        );
        assert.ok(nodes(plan.Plan).every((node) => node["Actual Rows"] <= 1));
        assert.equal(
          plan.Plan["Actual Rows"],
          scenario === "absent-zero" || scenario === "hit" ? 1 : 0,
        );
        console.log(
          JSON.stringify({
            suite: "classification-revision-lookup",
            mode,
            scenario,
            rows: plan.Plan["Actual Rows"],
            ms: plan["Execution Time"],
            buffers:
              plan.Plan["Local Hit Blocks"] + plan.Plan["Local Read Blocks"],
          }),
        );
      }
      await db.query(
        "delete from funding_classification_revisions where operation_id=$1",
        [data.base.operationId],
      );
    }
    await db.query("deallocate classification_revision_probe");
    await db.query(
      `prepare classification_current_set_probe(jsonb) as ${FUNDING_CLASSIFICATION_CURRENT_SET_SQL}`,
    );
    const populated = (
      await db.query<{ operation_id: string }>(
        "select operation_id from funding_classification_revisions order by operation_id limit 100",
      )
    ).rows;
    const expected = (
      await db.query<{ operation_id: string; user_id: string }>(
        "select id as operation_id,user_id from funding_operations where id=any($1::uuid[])",
        [populated.map((row) => row.operation_id)],
      )
    ).rows.map((row) => ({
      operationId: row.operation_id,
      userId: row.user_id,
      revision: "100",
    }));
    for (const mode of ["force_custom_plan", "force_generic_plan"] as const) {
      await db.query(`set local plan_cache_mode=${mode}`);
      for (const scenario of [
        "dense-hit",
        "stale",
        "foreign-owner",
        "deleted",
        "empty",
      ] as const) {
        const facts =
          scenario === "empty" ? [] : expected.map((fact) => ({ ...fact }));
        if (scenario === "stale") facts[0].revision = "99";
        if (scenario === "foreign-owner") facts[0].userId = randomUUID();
        if (scenario === "deleted") facts[0].operationId = randomUUID();
        assert.equal(
          await fundingClassificationRevisionsAreCurrent(db, facts),
          scenario === "dense-hit" || scenario === "empty",
        );
        // Synthetic UUIDs/decimal revisions only; no user input or private data.
        const payload = JSON.stringify(facts);
        assert.ok(!payload.includes("'"));
        const plan = (
          await db.query<{
            "QUERY PLAN": { Plan: PlanNode; "Execution Time": number }[];
          }>(
            `explain(analyze,buffers,format json) execute classification_current_set_probe('${payload}'::jsonb)`,
          )
        ).rows[0]["QUERY PLAN"][0];
        const nodes = (node: PlanNode): PlanNode[] => [
          node,
          ...(node.Plans ?? []).flatMap(nodes),
        ];
        assert.ok(
          nodes(plan.Plan).every((node) => node["Node Type"] !== "Seq Scan"),
        );
        const buffers =
          plan.Plan["Local Hit Blocks"] + plan.Plan["Local Read Blocks"];
        assert.ok(
          buffers <= 1500,
          "lookup work follows the exact dependency set, not 50k history",
        );
        console.log(
          JSON.stringify({
            suite: "classification-current-set",
            mode,
            scenario,
            ms: plan["Execution Time"],
            buffers,
          }),
        );
      }
    }
    await db.query("deallocate classification_current_set_probe");
  } finally {
    await db.query("rollback");
  }
}

/** Real committed fixtures and writers, only in the explicit disposable PG16
 * concurrency suite. No provider IO, transport mocks or production mutations. */
export async function verifyFundingClassificationRevisionsPg(
  pool: Pool,
  fixture: () => Promise<Fixture>,
) {
  const read = async (data: Fixture) => {
    const result = await readFundingClassificationRevision(pool, {
      operationId: data.base.operationId,
      userId: data.base.source.accountId,
    });
    assert.ok(result);
    return result;
  };
  const insertObservation = async (
    db: Pick<PoolClient, "query">,
    data: Fixture,
    eventIndex: string,
  ) =>
    (
      await allocateFundingObservationInTransaction(db, {
        operationId: data.base.operationId,
        segmentId: data.base.segmentId,
        kind: "source_debit",
        networkId: data.evm[0].networkId,
        assetId: data.evm[0].asset.assetId,
        assetDecimals: data.evm[0].asset.decimals,
        txHash: data.hashes[0],
        eventIndex,
        fromAddress: data.owner,
        toAddress: data.evm[0].sourceAddress,
        rawAmount: "10000000",
        observedAt: data.base.now,
        ledgerHeight: "100",
        blockHash: data.evm[0].blockHash,
        finalityStatus: "observed",
        metadata: { observerId: "relay_client_receipt_source_debit_v1" },
      })
    ).observation;
  const finalize = (db: PoolClient, observationId: string) =>
    advanceFundingObservationFinalityInTransaction(db, {
      observationId,
      expectedFinality: "observed",
      nextFinality: "finalized",
      finalizedAt: new Date(),
    });
  const assertNoTouches = async () => {
    assert.equal(
      (
        await pool.query(
          "select count(*)::int as count from funding_classification_touches",
        )
      ).rows[0].count,
      0,
    );
  };
  const data = await fixture();
  const initial = await read(data);
  assert.equal(initial.revision, "1", "all fixture writes coalesce at commit");
  const a = await pool.connect();
  const b = await pool.connect();
  try {
    const aPid = (await a.query("select pg_backend_pid() as pid")).rows[0].pid;
    const bPid = (await b.query("select pg_backend_pid() as pid")).rows[0].pid;
    const waitBlocked = async (pid: number) => {
      for (let probe = 0; probe < 200; probe++) {
        if (
          (
            await pool.query(
              "select cardinality(pg_blocking_pids($1)) > 0 as blocked",
              [pid],
            )
          ).rows[0].blocked
        )
          return;
      }
      assert.fail("expected real PostgreSQL lock contention");
    };
    await a.query("begin");
    await a.query(
      "update funding_operation_segments set raw_status='refund' where id=$1",
      [data.base.segmentId],
    );
    await a.query(
      "update funding_operation_segments set raw_status='failure' where id=$1",
      [data.base.segmentId],
    );
    assert.deepEqual(
      await read(data),
      initial,
      "uncommitted changes stay invisible",
    );
    await a.query("rollback");
    assert.deepEqual(await read(data), initial);
    await assertNoTouches();

    // Polling diagnostics cannot prevent a multi-page scan from completing.
    for (let page = 0; page < 4; page++) {
      const result = await readFundingClassificationPage(
        pool,
        initial,
        async () => {
          await pool.query(
            `update funding_operation_segments set support_metadata=support_metadata || $2::jsonb,
          updated_at=clock_timestamp() where id=$1`,
            [
              data.base.segmentId,
              JSON.stringify({
                providerUpdatedAt: new Date().toISOString(),
                exactRefundReceipts: { checkedAt: page, cursor: page },
              }),
            ],
          );
          return page;
        },
      );
      assert.equal(result, page);
    }
    await assert.rejects(
      readFundingClassificationPage(pool, initial, async () => {
        await pool.query(
          `update funding_operation_segments set support_metadata=support_metadata ||
          '{"relayStatusCategory":"provider_success"}'::jsonb where id=$1`,
          [data.base.segmentId],
        );
        return "discard this page";
      }),
      FundingClassificationChangedError,
    );
    assert.equal((await read(data)).revision, "2");
    const unrelated = await fixture();
    const unrelatedRevision = await read(unrelated);
    await pool.query(
      "update funding_operation_segments set raw_status='refund' where id=$1",
      [data.base.segmentId],
    );
    assert.deepEqual(
      await read(unrelated),
      unrelatedRevision,
      "only changed candidate restarts",
    );
    console.log(
      "PASS classification revision: rollback, semantic-only polling, bounded page invalidation",
    );

    // Actual observation writer does NOT lock O. It may commit after publisher
    // owns O; the final F check must invalidate ALL publisher effects.
    const observation = await insertObservation(pool, data, "91");
    const expected = await read(data);
    await a.query("begin");
    await finalize(a, observation.id);
    await b.query("begin");
    await lockFundingClassificationOperations(b, [expected]);
    await b.query(
      `update funding_operations set version=version+1,support_metadata=support_metadata ||
      '{"classificationSpeculative":true}'::jsonb where id=$1`,
      [data.base.operationId],
    );
    await b.query(
      "update funding_operation_segments set raw_status='speculative' where id=$1",
      [data.base.segmentId],
    );
    await a.query("commit");
    await assert.rejects(
      commitFundingClassificationTransaction(b, [expected]),
      FundingClassificationChangedError,
    );
    assert.equal(
      (
        await pool.query(
          "select support_metadata->'classificationSpeculative' as value from funding_operations where id=$1",
          [data.base.operationId],
        )
      ).rows[0].value,
      null,
    );
    assert.equal(
      (
        await pool.query(
          "select raw_status from funding_operation_segments where id=$1",
          [data.base.segmentId],
        )
      ).rows[0].raw_status,
      "refund",
    );
    await assertNoTouches();

    // Retry on new facts succeeds, and its OWN fact change bumps only at commit.
    const retry = await read(data);
    await b.query("begin");
    await lockFundingClassificationOperations(b, [retry]);
    await b.query(
      "update funding_operation_segments set raw_status='recovered' where id=$1",
      [data.base.segmentId],
    );
    await commitFundingClassificationTransaction(b, [retry]);
    assert.equal(
      (await read(data)).revision,
      String(BigInt(retry.revision) + 1n),
    );
    console.log(
      "PASS no-operation-lock writer invalidates fence; effects rollback; ordinary retry recovers",
    );

    // In the reverse order, publisher has F first and writer is waiting only at
    // COMMIT, not holding a child lock that publisher still needs after F.
    const reverseObservation = await insertObservation(pool, data, "92");
    const reverseExpected = await read(data);
    await b.query("begin");
    await lockFundingClassificationOperations(b, [reverseExpected]);
    const fence = await b.query(
      "select funding_classification_fence($1::jsonb) as valid",
      [JSON.stringify([reverseExpected])],
    );
    assert.equal(fence.rows[0].valid, true);
    await a.query("begin");
    await finalize(a, reverseObservation.id);
    const writerCommit = a.query("commit");
    await waitBlocked(aPid);
    await b.query("commit");
    await writerCommit;
    assert.equal(
      (await read(data)).revision,
      String(BigInt(reverseExpected.revision) + 1n),
    );

    // Child collision BEFORE the final fence must wait without an F->child
    // cycle. Publisher sees changed revision after that writer commits.
    const childObservation = await insertObservation(pool, data, "93");
    const childExpected = await read(data);
    await a.query("begin");
    await finalize(a, childObservation.id);
    await b.query("begin");
    await lockFundingClassificationOperations(b, [childExpected]);
    const childWrite = b.query(
      'update funding_observations set metadata=metadata || \'{"receiptAttemptId":"changed"}\'::jsonb where id=$1',
      [childObservation.id],
    );
    await waitBlocked(bPid);
    await a.query("commit");
    await childWrite;
    await assert.rejects(
      commitFundingClassificationTransaction(b, [childExpected]),
      FundingClassificationChangedError,
    );
    await assertNoTouches();
    console.log(
      "PASS opposite race and child-row collision: no F-to-child deadlock",
    );

    // Independent children, same two operations, reversed write order. Deferred
    // drain must order the full operation set, not individual trigger events.
    const pair = [data, unrelated].sort((left, right) =>
      left.base.operationId.localeCompare(right.base.operationId),
    );
    const firstChildren = await Promise.all(
      pair.map((item) => insertObservation(pool, item, "94")),
    );
    const secondChildren = await Promise.all(
      pair.map((item) => insertObservation(pool, item, "95")),
    );
    await a.query("begin");
    await b.query("begin");
    await finalize(a, firstChildren[1].id);
    await finalize(a, firstChildren[0].id);
    await finalize(b, secondChildren[0].id);
    await finalize(b, secondChildren[1].id);
    await Promise.all([a.query("commit"), b.query("commit")]);
    await assertNoTouches();

    // Publisher proof only names the later UUID, effects touch both. Its fence
    // still locks staged-only earlier IDs before that proof's revision row.
    const thirdChildren = await Promise.all(
      pair.map((item) => insertObservation(pool, item, "96")),
    );
    const unionExpected = await read(pair[1]);
    await b.query("begin");
    await lockFundingClassificationOperations(b, [
      await read(pair[0]),
      unionExpected,
    ]);
    await finalize(b, thirdChildren[1].id);
    await finalize(b, thirdChildren[0].id);
    assert.equal(
      (
        await b.query(
          "select funding_classification_fence($1::jsonb) as valid",
          [JSON.stringify([unionExpected])],
        )
      ).rows[0].valid,
      true,
    );
    await b.query("commit");
    await assertNoTouches();

    // Simulate a pre-migration operation with no revision row. Test-only delete
    // is never a production cleanup path; the migration itself does no backfill.
    const legacy = await fixture();
    await pool.query(
      "delete from funding_classification_revisions where operation_id=$1",
      [legacy.base.operationId],
    );
    const zero = await read(legacy);
    assert.equal(zero.revision, "0");
    await b.query("begin");
    await lockFundingClassificationOperations(b, [zero]);
    await commitFundingClassificationTransaction(b, [zero]);
    assert.equal((await read(legacy)).revision, "0");
    await b.query("begin");
    assert.equal(
      (
        await b.query(
          "select funding_classification_fence($1::jsonb) as valid",
          [
            JSON.stringify([
              { operationId: legacy.base.operationId, revision: null },
            ]),
          ],
        )
      ).rows[0].valid,
      false,
    );
    await b.query("rollback");
    assert.equal(
      await readFundingClassificationRevision(pool, {
        operationId: legacy.base.operationId,
        userId: data.base.source.accountId,
      }),
      null,
    );
    await b.query("begin");
    await assert.rejects(
      lockFundingClassificationOperations(b, [
        { ...zero, userId: data.base.source.accountId },
      ]),
      FundingClassificationChangedError,
    );
    await b.query("rollback");
    await assertNoTouches();
    console.log(
      "PASS global deferred order, staged-only IDs, absent-zero fence and owner mismatch",
    );

    const factFixture = await fixture();
    const expectBump = async (change: () => Promise<unknown>) => {
      const before = await read(factFixture);
      await change();
      assert.equal(
        (await read(factFixture)).revision,
        String(BigInt(before.revision) + 1n),
      );
    };
    const stepId = randomUUID(),
      attemptId = randomUUID();
    await expectBump(() =>
      pool.query(
        `insert into funding_operation_steps
      (id,operation_id,segment_id,ordinal,step_kind,action_fingerprint,executor_id,payer_requirement,
       normalized_action,action_validation_result)
      values($1,$2,$3,0,'transaction',$4,'offline_revision_test','user','{}','{}')`,
        [
          stepId,
          factFixture.base.operationId,
          factFixture.base.segmentId,
          "a".repeat(64),
        ],
      ),
    );
    await expectBump(() =>
      pool.query(
        `insert into funding_operation_step_attempts
      (id,step_id,attempt_number,canonical_action_fingerprint,executor_id)
      values($1,$2,1,$3,'offline_revision_test')`,
        [attemptId, stepId, "a".repeat(64)],
      ),
    );
    await expectBump(() =>
      pool.query(
        `update funding_operation_step_attempts
      set outcome='failed',finished_at=clock_timestamp(),actual_costs='{"embeddedSubmission":{"phase":"closed"}}'
      where id=$1`,
        [attemptId],
      ),
    );
    await expectBump(() =>
      pool.query(
        `insert into funding_step_receipt_observations
      (operation_id,step_id,attempt_id,network_id,status,action_match,canonical,evidence,first_seen_at,observed_at)
      values($1,$2,$3,'evm:8453','pending',null,true,'{}',now(),now())`,
        [factFixture.base.operationId, stepId, attemptId],
      ),
    );
    const pendingFacts = await read(factFixture);
    await pool.query(
      `update funding_step_receipt_observations
      set observed_at=clock_timestamp(),evidence=evidence || '{"confirmations":100}' where attempt_id=$1`,
      [attemptId],
    );
    assert.deepEqual(
      await read(factFixture),
      pendingFacts,
      "receipt polling is not new execution evidence",
    );
    await expectBump(() =>
      pool.query(
        `update funding_step_receipt_observations
        set status='failed',action_match=true,finalized_at=clock_timestamp(),evidence='{"failureFinalized":true}' where attempt_id=$1`,
        [attemptId],
      ),
    );
    const settledFacts = await read(factFixture);
    const reservationId = (
      await pool.query(
        "select id from balance_reservations where operation_id=$1",
        [factFixture.base.operationId],
      )
    ).rows[0].id;
    await releaseFundingReservationInTransaction(pool, {
      reservationId,
      outcomeReason: "test_complete",
    });
    assert.deepEqual(
      await read(factFixture),
      settledFacts,
      "reservation expiry/release does not erase source membership",
    );
    await assertNoTouches();
    console.log(
      "PASS real step/attempt/receipt trigger paths and polling-only exclusions",
    );
    await verifyRevisionLookupPlans(a, data);
  } finally {
    await a.query("rollback");
    await b.query("rollback");
    a.release();
    b.release();
  }
}
