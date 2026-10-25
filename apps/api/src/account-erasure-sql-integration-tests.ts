// @requires-db
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createIntegrationTestPool } from "./test-database-target.js";
import { enqueueContentStorageDeletion } from "./services/content-asset-deletion.js";
import type { DbQuery } from "./db.js";

const pool = await createIntegrationTestPool({ max: 2 });
const client = await pool.connect();
const plans: unknown[] = [];
const db: DbQuery = {
  query: async (text: string, values: unknown[] = []) => {
    await client.query("savepoint erasure_plan");
    const plan = await client.query(
      "explain (analyze,buffers,format json) " + text,
      values,
    );
    plans.push({ sql: text, plan: plan.rows[0]["QUERY PLAN"] });
    await client.query("rollback to erasure_plan");
    return client.query(text, values);
  },
} as DbQuery;
try {
  const version = await client.query("show server_version_num");
  assert.equal(
    Math.floor(Number(version.rows[0].server_version_num) / 10000),
    16,
  );
  await client.query("begin");
  await client.query("create schema account_erasure_fixture");
  await client.query("set local search_path=account_erasure_fixture,public");
  const source = await readFile(
    new URL(
      "../../../packages/db/migrations/0198_content_cms_adoption.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const start = source.indexOf(
    "CREATE TABLE IF NOT EXISTS content_storage_deletion_jobs (",
  );
  const end = source.indexOf(
    "DROP TRIGGER IF EXISTS content_storage_deletion_jobs_set_updated_at",
    start,
  );
  assert.ok(start >= 0 && end > start);
  await client.query(source.slice(start, end));
  await client.query(`insert into content_storage_deletion_jobs(storage_key,status,available_at)
    select 'content/scale-'||g,case when g%1000=0 then 'pending' else 'completed' end,
    now()-(g||' seconds')::interval from generate_series(1,1000000)g`);
  await client.query(
    await readFile(
      new URL(
        "../../../packages/db/migrations/0289_content_erasure_invalidation.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  await client.query("analyze content_storage_deletion_jobs");
  const identity = await db.query(
    "select current_database() as current_database",
  );
  assert.equal(
    identity.rows[0]?.current_database,
    process.env.HUNCH_TEST_EXPECT_DATABASE,
  );
  await enqueueContentStorageDeletion(db, "content/scale-1");
  await enqueueContentStorageDeletion(db, "content/new-key");
  await enqueueContentStorageDeletion(db, "content/scale-1", new Date(), {
    reopenAfterPossibleWrite: true,
  });
  await enqueueContentStorageDeletion(
    db,
    "content-staging/new-key",
    new Date(Date.now() + 100000),
  );
  const worker = await readFile(
    new URL("./services/content-worker.ts", import.meta.url),
    "utf8",
  );
  const slice = worker.slice(
    worker.indexOf("async function claimStorageDeletion"),
    worker.indexOf("export async function runContentRetention"),
  );
  const queries = [...slice.matchAll(/`([\s\S]*?)`/g)]
    .map((m) => m[1])
    .filter(
      (sql) =>
        sql.includes("content_storage_deletion_jobs") && !sql.includes("${"),
    );
  assert.equal(
    queries.length,
    7,
    "every storage-worker statement must be planned",
  );
  for (const sql of queries) {
    const parameters = /select id, storage_key/.test(sql)
      ? [8]
      : /status = 'processing'/.test(sql)
        ? [1000, "fixture-worker"]
        : /last_error = \$5/.test(sql)
          ? [1000, "fixture-worker", 8, "2", "test"]
          : /cdn_invalidation_id=\$3/.test(sql)
            ? [1000, "fixture-worker", "fixture-id"]
            : /where id/.test(sql)
              ? [1000, "fixture-worker"]
              : [];
    const count = Math.max(
      0,
      ...[...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])),
    );
    await db.query(sql, parameters.slice(0, count));
  }
  const selection = queries.find((sql) =>
    sql.includes("select id, storage_key"),
  );
  assert.ok(selection);
  const first = await db.query(selection, [8]);
  assert.ok(first.rows.length);
  await client.query(
    "update content_storage_deletion_jobs set status='processing',locked_at=now(),locked_by='fixture-worker' where id=$1",
    [first.rows[0].id],
  );
  const resumed = await db.query(selection, [8]);
  assert.notEqual(resumed.rows[0]?.id, first.rows[0].id);
  await client.query("set local plan_cache_mode=force_generic_plan");
  await client.query("prepare erasure_queue(integer) as " + selection);
  plans.push({
    genericQueue: (
      await client.query(
        "explain(analyze,buffers,format json) execute erasure_queue(8)",
      )
    ).rows[0]["QUERY PLAN"],
  });
  await client.query(
    "update content_storage_deletion_jobs set status='completed' where status='pending'",
  );
  const empty = await db.query(selection, [8]);
  assert.equal(empty.rows.length, 0);
  await mkdir("build/compliance", { recursive: true });
  await writeFile(
    "build/compliance/erasure-sql-plans.json",
    JSON.stringify(plans, null, 2),
  );
  console.log(
    `[account-erasure-sql] PostgreSQL 16, 1m jobs, ${plans.length} plans; enqueue/reopen, reclaim, claim, bounded progress, CDN polling, sparse/resumed/generic/empty selection passed`,
  );
  await client.query("rollback");
} finally {
  client.release();
  await pool.end();
}
