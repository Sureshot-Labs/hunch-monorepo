import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { relayExactRefundTestFixture } from "./relay-exact-refund-writer-pg.js";
import { createFundingTransactionReferenceCodec } from "../execution/transaction-reference-codec.js";
import { publishRelayExactRefundReceipts } from "../reconciliation/relay-exact-refund-publication.js";
import {
  prepareRelayExactRefundReceipts,
  revalidateRelayExactRefundReceipts,
  relayExactRefundCanonicalEvents,
  applyRelayExactRefundReceiptsInTransaction,
  recordRelayExactRefundReceiptsInTransaction,
  RELAY_EXACT_REFUND_CONTEXT_SQL,
} from "../reconciliation/relay-exact-refund-receipts.js";
import {
  FundingClassificationChangedError,
  lockFundingClassificationOperations,
  commitFundingClassificationTransaction,
} from "../persistence/funding-classification-revisions.js";
import { lockFundingReceiveCanonicalEvents } from "../persistence/funding-receive-session-repository.js";
import { listFundingObservationsForOperation } from "../persistence/funding-operation-repository.js";
import { recordRefundSourceActionForTest } from "./refund-source-debit-fixture.js";

type Fixture = ReturnType<typeof relayExactRefundTestFixture>;

function tracePool(
  pool: Pool,
  onQuery: (sql: string, values: unknown[]) => Promise<void> | void,
) {
  const wrapped = Object.create(pool) as Pool;
  wrapped.query = pool.query.bind(pool);
  wrapped.connect = (async () => {
    const db = await pool.connect();
    return new Proxy(db, {
      get(target, name) {
        if (name === "query")
          return async (sql: string, values: unknown[] = []) => {
            await onQuery(sql, values);
            return target.query(sql, values);
          };
        const value = Reflect.get(target, name);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }) as Pool["connect"];
  return wrapped;
}

/** Actual commits and raw F/COMMIT adjacency; no transport or financial submit.
 * Uses the common committed route fixture, not an approximate schema/writer.
 */
export async function verifyExactRefundPublicationPg(
  pool: Pool,
  fixture: (existing?: { userId: string; owner: string }) => Promise<Fixture>,
) {
  const transactionReferenceCodec = createFundingTransactionReferenceCodec({
    encryptionKey: Buffer.alloc(32, 41),
    lookupHmacKey: "offline-joint-refund-publication-test-key",
    keyVersion: 1,
  });
  const runOnce = (db: Pool, data: Fixture, indices: number[]) =>
    publishRelayExactRefundReceipts(db, {
      ...data.base,
      evmEvents: indices.map((index) => data.evm[index]),
      transactionReferenceCodec,
      work: {
        progressToken: randomUUID(),
        deadlineMs: Date.now() + 30_000,
        limit: 50,
      },
    });
  const run = async (db: Pool, data: Fixture, indices: number[]) => {
    for (let tick = 0; tick < 100; tick++) {
      const result = await runOnce(db, data, indices);
      if (result.kind !== "pending") return result;
    }
    assert.fail("ordinary exact refund ticks did not finish bounded role work");
  };
  const refunds = async (data: Fixture) =>
    (
      await listFundingObservationsForOperation(pool, data.base.operationId)
    ).filter((row) => row.kind === "refund_credit");

  const data = await fixture();
  const readSql: string[] = [];
  const prepared = await prepareRelayExactRefundReceipts(
    {
      query: async (sql: string, values: unknown[]) => {
        readSql.push(sql);
        return pool.query(sql, values);
      },
    } as never,
    { ...data.base, evmEvents: [data.evm[0]] },
  );
  assert.equal(prepared.kind, "prepared");
  assert.ok(readSql.includes(RELAY_EXACT_REFUND_CONTEXT_SQL));
  assert.ok(
    readSql.every((sql) => /^\s*select\b/iu.test(sql)),
    "prepare has no E/O or effects",
  );
  assert.equal((await refunds(data)).length, 0);
  const statements: string[] = [];
  const traced = tracePool(pool, (sql) => {
    statements.push(sql);
  });
  assert.deepEqual(await run(traced, data, [0, 0]), {
    kind: "partial",
    inserted: 1,
    reason: "refund_receipts_incomplete",
  });
  assert.deepEqual(await run(traced, data, [1]), {
    kind: "complete",
    inserted: 1,
    reason: null,
  });
  statements.length = 0;
  assert.deepEqual(await run(traced, data, []), {
    kind: "complete",
    inserted: 0,
    reason: null,
  });
  assert.equal((await refunds(data)).length, 2);
  const beforeAnchorConflict = await refunds(data);
  assert.deepEqual(
    await publishRelayExactRefundReceipts(pool, {
      ...data.base,
      evmEvents: [
        {
          ...data.evm[0],
          ledgerHeight: "999",
          blockHash: `0x${"cc".repeat(32)}`,
        },
      ],
      transactionReferenceCodec,
      work: {
        progressToken: randomUUID(),
        deadlineMs: Date.now() + 30_000,
        limit: 50,
      },
    }),
    { kind: "pending", reason: "refund_receipt_conflict" },
  );
  assert.deepEqual(
    await refunds(data),
    beforeAnchorConflict,
    "fresh B cannot be replaced silently by stored canonical A",
  );
  assert.equal(
    statements.some((sql) =>
      sql.includes("insert into funding_reconciliation_jobs"),
    ),
    false,
    "replay does not wake a new provider poll",
  );
  for (let index = 0; index < statements.length; index++)
    if (statements[index].includes("select funding_classification_fence"))
      assert.equal(
        statements[index + 1],
        "commit",
        "no SQL or budget SET between F and COMMIT",
      );
  const operationLock = statements.findIndex((sql) =>
    sql.includes("order by id for update"),
  );
  assert.ok(operationLock > 0);
  assert.ok(
    statements
      .slice(0, operationLock)
      .some((sql) =>
        sql.includes("insert into funding_receive_canonical_events"),
      ),
  );

  // A prepared witness never becomes newer just because revalidation reads a
  // newer context under O. Only final F can accept the ORIGINAL authority.
  const stale = await fixture();
  const proposal = await prepareRelayExactRefundReceipts(pool, {
    ...stale.base,
    evmEvents: stale.evm,
  });
  assert.equal(proposal.kind, "prepared");
  if (proposal.kind !== "prepared") throw Error("missing proposal");
  await pool.query(
    "update funding_operation_segments set raw_status='refund' where id=$1",
    [stale.base.segmentId],
  );
  const client = await pool.connect();
  try {
    await client.query("begin");
    await lockFundingReceiveCanonicalEvents(
      client,
      relayExactRefundCanonicalEvents(proposal),
    );
    await lockFundingClassificationOperations(client, [proposal.facts]);
    const latest = await revalidateRelayExactRefundReceipts(client, proposal);
    assert.deepEqual(latest.facts, proposal.facts);
    assert.notEqual(latest.context.facts.revision, proposal.facts.revision);
    await applyRelayExactRefundReceiptsInTransaction(client, latest);
    await assert.rejects(
      commitFundingClassificationTransaction(client, [latest.facts]),
      FundingClassificationChangedError,
    );
  } finally {
    await client.query("rollback");
    client.release();
  }
  assert.equal((await refunds(stale)).length, 0);
  assert.equal(
    (
      await pool.query(
        "select id from funding_receive_canonical_events where tx_hash=any($1::text[])",
        [stale.hashes],
      )
    ).rowCount,
    0,
    "failed F rolls back quarantine and canonical rows too",
  );
  assert.equal(
    (await run(pool, stale, [1, 0])).kind,
    "complete",
    "fresh ordinary tick recovers without reset or cooldown",
  );

  // A negative sibling belongs in the very same final fence, not just the
  // operation that gets credited. Mutate after effects using a second session.
  const target = await fixture();
  const sibling = await fixture({
    userId: target.base.source.accountId,
    owner: target.owner,
  });
  await recordRefundSourceActionForTest(pool, sibling, "unsubmitted");
  let changed = false;
  const fenceSql: string[] = [];
  const changing = tracePool(pool, async (sql, values) => {
    fenceSql.push(sql);
    if (!changed && sql.includes("select funding_classification_fence")) {
      const expected = JSON.parse(String(values[0])) as {
        operationId: string;
      }[];
      assert.ok(
        expected.some(
          (facts) => facts.operationId === sibling.base.operationId,
        ),
        "negative source witness is included in F",
      );
      changed = true;
      await pool.query(
        "update funding_operation_segments set raw_status='pending' where id=$1",
        [sibling.base.segmentId],
      );
    }
  });
  let rejected = false;
  for (let tick = 0; tick < 100 && !changed; tick++) {
    const result = await runOnce(changing, target, [0, 1]);
    rejected ||=
      result.kind === "pending" && result.reason === "candidate_facts_changed";
  }
  assert.ok(changed && rejected);
  assert.equal((await refunds(target)).length, 0);
  assert.ok(fenceSql.includes("rollback"));
  assert.equal((await run(pool, target, [0, 1])).kind, "complete");

  // A second receipt commits while the first publisher has E but has not yet
  // acquired O. Do NOT acquire its newly visible E under O during revalidation.
  const disjoint = await fixture();
  let otherCommitted = false;
  const interleavedSql: string[] = [];
  const interleaved = tracePool(pool, async (sql) => {
    interleavedSql.push(sql);
    if (!otherCommitted && sql.includes("order by id for update")) {
      const other = await pool.connect();
      try {
        await other.query("begin");
        assert.equal(
          (
            await recordRelayExactRefundReceiptsInTransaction(other, {
              ...disjoint.base,
              evmEvents: [disjoint.evm[1]],
            })
          ).kind,
          "partial",
        );
        await other.query("commit");
        otherCommitted = true;
      } catch (error) {
        await other.query("rollback");
        throw error;
      } finally {
        other.release();
      }
    }
  });
  let staleResult;
  for (let tick = 0; tick < 100 && !otherCommitted; tick++)
    staleResult = await runOnce(interleaved, disjoint, [0]);
  assert.ok(otherCommitted);
  assert.deepEqual(staleResult, {
    kind: "pending",
    reason: "refund_evidence_changed_retry",
  });
  const operationBoundary = interleavedSql.findIndex((sql) =>
    sql.includes("order by id for update"),
  );
  const rollbackBoundary = interleavedSql.indexOf(
    "rollback",
    operationBoundary,
  );
  assert.ok(rollbackBoundary > operationBoundary);
  assert.ok(
    !interleavedSql
      .slice(operationBoundary, rollbackBoundary)
      .some((sql) =>
        /(?:insert into funding_receive_canonical_events|insert into funding_observations|update funding_receive_canonical_events|insert into funding_reconciliation_jobs)/u.test(
          sql,
        ),
      ),
    "stale revalidation does not acquire new E or apply any effect under O",
  );
  assert.equal((await refunds(disjoint)).length, 1);
  assert.equal((await run(pool, disjoint, [0])).kind, "complete");
  assert.equal(
    (await refunds(disjoint)).reduce(
      (sum, row) => sum + BigInt(row.rawAmount),
      0n,
    ),
    9800000n,
  );

  const simultaneous = await fixture();
  const parallelResults = await Promise.all([
    run(pool, simultaneous, [0]),
    run(pool, simultaneous, [1]),
  ]);
  assert.ok(
    parallelResults.every(
      (result) => result.kind === "partial" || result.kind === "complete",
    ),
  );
  assert.equal((await refunds(simultaneous)).length, 2);
  assert.equal((await run(pool, simultaneous, [])).kind, "complete");
  console.log(
    "PASS exact joint refund: first proposal/partial/disjoint/replay, frozen revision, negative-sibling F rollback/recovery, current-manifest and simultaneous two-session races, raw F immediately COMMIT",
  );
}

/** Exact new context statement, custom and generic plans at dense owner scale.
 * Transaction-local shadows disappear on rollback; no product data is seeded.
 */
export async function verifyExactRefundContextPlansPg(pool: Pool) {
  const db = await pool.connect();
  try {
    await db.query("begin");
    await db.query(`create temp table funding_operations(id uuid primary key,user_id uuid,plan_kind text,source_snapshot jsonb) on commit drop;
      create temp table funding_operation_segments(id uuid primary key,operation_id uuid,provider_id text,source_snapshot jsonb,quoted_input jsonb,refund_location_snapshot jsonb,provider_quote_ref_ciphertext text,provider_quote_ref_lookup_hmac text,lookup_key_version int,support_metadata jsonb) on commit drop;
      create temp table funding_classification_revisions(operation_id uuid primary key,revision bigint) on commit drop;
      insert into funding_operations select md5('context-operation-'||series_index)::uuid,'11111111-1111-4111-8111-111111111111','wallet_route','{}'::jsonb from generate_series(1,100000) series_index;
      insert into funding_operation_segments select md5('context-segment-'||series_index)::uuid,md5('context-operation-'||series_index)::uuid,'relay','{}','{}','{}','offline','offline',1,'{}' from generate_series(1,100000) series_index;
      insert into funding_classification_revisions select id,7 from funding_operations;
      analyze funding_operations;analyze funding_operation_segments;analyze funding_classification_revisions;`);
    const metrics: unknown[] = [];
    for (const mode of ["force_custom_plan", "force_generic_plan"]) {
      await db.query(`set local plan_cache_mode=${mode}`);
      await db.query(
        `prepare exact_refund_context_plan(uuid,uuid) as ${RELAY_EXACT_REFUND_CONTEXT_SQL}`,
      );
      for (const [name, operation, segment, count] of [
        ["hit", 100000, 100000, 1],
        ["wrong-segment", 1, 100000, 0],
        ["missing-tail", 100001, 100001, 0],
      ] as const) {
        const statement = `execute exact_refund_context_plan(md5('context-operation-${operation}')::uuid,md5('context-segment-${segment}')::uuid)`;
        assert.equal((await db.query(statement)).rowCount, count);
        const result = (
          await db.query(`explain (analyze,buffers,format json) ${statement}`)
        ).rows[0]["QUERY PLAN"][0];
        const plan = result.Plan;
        assert.ok(
          (plan["Shared Hit Blocks"] ?? 0) + (plan["Local Hit Blocks"] ?? 0) <
            40,
          JSON.stringify(result),
        );
        assert.ok(
          !JSON.stringify(plan).includes('"Node Type":"Seq Scan"'),
          JSON.stringify(result),
        );
        metrics.push({
          mode,
          name,
          timeMs: result["Execution Time"],
          localBuffers: plan["Local Hit Blocks"],
          sharedBuffers: plan["Shared Hit Blocks"],
        });
      }
      await db.query("deallocate exact_refund_context_plan");
    }
    console.log(
      "PASS exact refund context 100k same-owner plans",
      JSON.stringify(metrics),
    );
  } finally {
    await db.query("rollback");
    db.release();
  }
}
