import assert from "node:assert/strict";
import type { Pool, PoolClient } from "@hunch/infra";
import {
  RELAY_STATUS_OPERATION_LOCK_SQL,
  RELAY_WEBHOOK_REQUEST_LOOKUP_SQL,
  RELAY_SEGMENT_STATUS_UPDATE_SQL,
} from "./reconciliation.js";

/** Run the real status writer in another transaction, prove its PG lock wait,
 * then change the status before releasing it. Not a timing-based mock race. */
export async function assertRelayStatusOperationFence<T>(
  pool: Pool,
  input: {
    operationId: string;
    segmentId: string;
    run: () => Promise<T>;
    whileBlocked: (client: PoolClient) => Promise<void>;
  },
): Promise<T> {
  const blocker = await pool.connect();
  let task: Promise<T> | undefined;
  try {
    await blocker.query("begin");
    const pid = (await blocker.query("select pg_backend_pid() as pid")).rows[0]
      .pid;
    await blocker.query(
      "select id from funding_operations where id=$1 for update",
      [input.operationId],
    );
    task = input.run();
    void task.catch(() => undefined);
    let blocked = false;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const waiters = await pool.query<{ query: string }>(
        `select query from pg_stat_activity
          where $1::int = any(pg_blocking_pids(pid))`,
        [pid],
      );
      if (waiters.rows.length) {
        assert.ok(
          waiters.rows.some(
            (row) =>
              row.query.trim() === RELAY_STATUS_OPERATION_LOCK_SQL.trim(),
          ),
          "status writer must wait for the operation before locking any child row",
        );
        blocked = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(blocked, "status writer did not reach the operation lock");
    await blocker.query(
      "select id from funding_provider_requests where segment_id=$1 for update nowait",
      [input.segmentId],
    );
    await blocker.query(
      "select id from funding_operation_segments where id=$1 for update nowait",
      [input.segmentId],
    );
    await input.whileBlocked(blocker);
    await blocker.query("commit");
    return await task;
  } finally {
    // Release the lock even when a test assertion fails so the actual writer
    // can finish and fixture cleanup cannot hang behind our own transaction.
    await blocker.query("rollback");
    if (task) await task.catch(() => undefined);
    blocker.release();
  }
}

/** Exact production SQL on representative indexed, transaction-local tables.
 * No provider request, global setting or persistent fixture is created here. */
export async function assertRelayStatusLookupPlans(pool: Pool): Promise<void> {
  const db = await pool.connect();
  try {
    await db.query("begin");
    assert.match(
      (await db.query("show server_version")).rows[0].server_version,
      /^16\./u,
    );
    // Shadow only this connection's relations. Include production indexes,
    // including the request HMAC/version and segment operation keys.
    for (const table of [
      "funding_operations",
      "funding_operation_segments",
      "funding_provider_requests",
    ]) {
      await db.query(
        `create temp table ${table} (like public.${table} including indexes) on commit drop`,
      );
      const columns = await db.query<{ column_name: string }>(
        `select column_name from information_schema.columns
          where table_schema='public' and table_name=$1 and is_nullable='NO'`,
        [table],
      );
      // Only the local lookup fixture needs nullable unused business columns.
      for (const { column_name: column } of columns.rows) {
        if (column === "id") continue;
        assert.match(column, /^[a-z_][a-z0-9_]*$/u);
        await db.query(
          `alter table pg_temp.${table} alter column "${column}" drop not null`,
        );
      }
    }
    await db.query(`insert into funding_operations(id)
      select md5('relay-lock-operation-'||entry)::uuid from generate_series(1,50000) entry`);
    await db.query(`insert into funding_operation_segments(id,operation_id,provider_id)
      select md5('relay-lock-segment-'||entry)::uuid,
             md5('relay-lock-operation-'||entry)::uuid,
             case when entry=123 then 'relay' else 'debridge' end
        from generate_series(1,50000) entry`);
    await db.query(`insert into funding_provider_requests(id,segment_id,request_ref_lookup_hmac,lookup_key_version,support_metadata)
      select md5('relay-lock-request-'||entry)::uuid,
             md5('relay-lock-segment-'||entry)::uuid,
             md5('relay-lock-hmac-'||entry),1,'{}'::jsonb
        from generate_series(1,50000) entry`);
    await db.query("analyze funding_operations");
    await db.query("analyze funding_operation_segments");
    await db.query("analyze funding_provider_requests");
    await db.query("set local plan_cache_mode=force_generic_plan");
    await db.query(
      `prepare relay_status_lock_probe(uuid,uuid) as ${RELAY_STATUS_OPERATION_LOCK_SQL}`,
    );
    await db.query(
      `prepare relay_webhook_lookup_probe(text,integer) as ${RELAY_WEBHOOK_REQUEST_LOOKUP_SQL}`,
    );
    await db.query(
      `prepare relay_webhook_lock_probe(text,integer) as ${RELAY_WEBHOOK_REQUEST_LOOKUP_SQL} for update of request`,
    );
    await db.query(
      "update funding_operation_segments set support_metadata='{}'::jsonb",
    );
    await db.query(
      `prepare relay_status_update_probe(uuid,text,jsonb,numeric,boolean) as ${RELAY_SEGMENT_STATUS_UPDATE_SQL}`,
    );
    const segmentId = (
      await db.query("select md5('relay-lock-segment-123')::uuid as id")
    ).rows[0].id;
    for (const reverse of [false, true]) {
      await db.query(
        "update funding_operation_segments set raw_status='pending',support_metadata='{}'::jsonb where id=$1",
        [segmentId],
      );
      const observations = [
        [
          "success",
          {
            providerUpdatedAt: 100,
            relaySuccessfulDestinationReferenceHashesV1: ["b".repeat(64)],
          },
          100,
        ],
        [
          "refund",
          {
            providerUpdatedAt: 200,
            relaySuccessfulDestinationReferenceHashesV1: [],
          },
          200,
        ],
      ];
      for (const [rawStatus, metadata, at] of reverse
        ? observations.reverse()
        : observations)
        await db.query(RELAY_SEGMENT_STATUS_UPDATE_SQL, [
          segmentId,
          rawStatus,
          metadata,
          at,
          true,
        ]);
      const latest = (
        await db.query(
          "select raw_status,support_metadata from funding_operation_segments where id=$1",
          [segmentId],
        )
      ).rows[0];
      assert.equal(latest.raw_status, "refund");
      assert.equal(latest.support_metadata.providerUpdatedAt, 200);
      assert.deepEqual(
        latest.support_metadata.relaySuccessfulDestinationReferenceHashesV1,
        ["b".repeat(64)],
        "newer sibling lifecycle status must not erase or prevent an older request's positive reference",
      );
      await db.query(RELAY_SEGMENT_STATUS_UPDATE_SQL, [
        segmentId,
        "success",
        {
          relaySuccessfulDestinationReferenceHashesV1: ["c".repeat(64)],
        },
        300,
        false,
      ]);
      const staleRequest = (
        await db.query(
          "select raw_status,support_metadata from funding_operation_segments where id=$1",
          [segmentId],
        )
      ).rows[0];
      assert.equal(staleRequest.raw_status, "refund");
      assert.equal(staleRequest.support_metadata.providerUpdatedAt, 200);
      assert.deepEqual(
        staleRequest.support_metadata
          .relaySuccessfulDestinationReferenceHashesV1,
        ["b".repeat(64), "c".repeat(64)],
        "request-local stale response appends positive proof without advancing segment state even when newer than a different sibling",
      );
    }
    // Legacy fingerprints mix source/destination/refund roles. Unlike the new
    // role-specific positives, they cannot outlive the status that gave them
    // meaning: an older refund must not enter a newer successful snapshot.
    for (const [at, advanceStatus] of [
      [100, true],
      [300, false],
    ] as const) {
      await db.query(
        "update funding_operation_segments set raw_status='success',support_metadata=$2::jsonb where id=$1",
        [
          segmentId,
          {
            providerUpdatedAt: 200,
            destinationTransactionReferenceCount: 1,
            relayTransactionReferenceFingerprints: ["a".repeat(64)],
          },
        ],
      );
      await db.query(RELAY_SEGMENT_STATUS_UPDATE_SQL, [
        segmentId,
        "refund",
        {
          providerUpdatedAt: at,
          destinationTransactionReferenceCount: 0,
          relayTransactionReferenceFingerprints: ["b".repeat(64)],
        },
        at,
        advanceStatus,
      ]);
      const rejectedStatus = (
        await db.query(
          "select raw_status,support_metadata from funding_operation_segments where id=$1",
          [segmentId],
        )
      ).rows[0];
      assert.equal(rejectedStatus.raw_status, "success");
      assert.equal(rejectedStatus.support_metadata.providerUpdatedAt, 200);
      assert.equal(
        rejectedStatus.support_metadata.destinationTransactionReferenceCount,
        1,
      );
      assert.deepEqual(
        rejectedStatus.support_metadata.relayTransactionReferenceFingerprints,
        ["a".repeat(64)],
      );
    }
    for (const entry of [123, 124, 50001]) {
      for (const [label, statement] of [
        [
          "operation",
          `execute relay_status_lock_probe(md5('relay-lock-operation-${entry}')::uuid,md5('relay-lock-segment-${entry}')::uuid)`,
        ],
        [
          "lookup",
          `execute relay_webhook_lookup_probe(md5('relay-lock-hmac-${entry}'),1)`,
        ],
        [
          "request-lock",
          `execute relay_webhook_lock_probe(md5('relay-lock-hmac-${entry}'),1)`,
        ],
        [
          "status-update",
          `execute relay_status_update_probe(md5('relay-lock-segment-${entry}')::uuid,'success',
          '{"relaySuccessfulDestinationReferenceHashesV1":["${"a".repeat(64)}"]}'::jsonb,123,true)`,
        ],
      ]) {
        const result = await db.query(
          `explain (analyze,buffers,format json) ${statement}`,
        );
        const plan = result.rows[0]["QUERY PLAN"][0];
        assert.doesNotMatch(JSON.stringify(plan), /Seq Scan/u);
        if (label !== "status-update")
          assert.equal(plan.Plan["Actual Rows"], entry === 123 ? 1 : 0);
        else
          assert.match(
            JSON.stringify(plan),
            /funding_operation_segments_pkey/u,
          );
        console.log(
          `[relay-status-plans] ${label}/${entry}: ${plan["Execution Time"]}ms, ${plan.Plan["Local Hit Blocks"]} local hits`,
        );
      }
    }
  } finally {
    await db.query("rollback");
    for (const statement of [
      "relay_status_lock_probe",
      "relay_webhook_lookup_probe",
      "relay_webhook_lock_probe",
      "relay_status_update_probe",
    ]) {
      await db.query(`deallocate ${statement}`).catch(() => undefined);
    }
    db.release();
  }
}
