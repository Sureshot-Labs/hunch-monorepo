// @requires-db
import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createIntegrationTestPool } from "./test-database-target.js";
const pool = await createIntegrationTestPool({ max: 1 });
const client = await pool.connect();
const plans: unknown[] = [];
const id = (n: number) =>
  `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
async function statements(file: string) {
  const source = await readFile(new URL(file, import.meta.url), "utf8");
  return [...source.matchAll(/`([^`]*?)`/gs)].map((match) => match[1]);
}
async function plan(
  name: string,
  sql: string | undefined,
  values: unknown[] = [],
) {
  assert.ok(sql);
  assert.ok(!sql.includes("${"), "plan the actual resolved statement");
  await client.query("savepoint fix_plan");
  const result = await client.query(
    "explain(analyze,buffers,format json) " + sql,
    values,
  );
  plans.push({ name, sql, values, plan: result.rows[0]["QUERY PLAN"] });
  await client.query("rollback to fix_plan");
}
try {
  await client.query("begin");
  await client.query(
    "create schema erasure_fix_scale; set local search_path=erasure_fix_scale,public",
  );
  await client.query(`create table users(id uuid primary key);
    create table content_assets(id uuid primary key,status text,storage_key text,metadata jsonb);
    insert into users select ('10000000-0000-4000-8000-'||lpad(g::text,12,'0'))::uuid from generate_series(1,1000000)g;
    insert into content_assets select id,case when id='10000000-0000-4000-8000-000000001000' then 'ready' else 'deleted' end,'content/'||id,'{}' from users;`);
  await client.query(
    await readFile(
      new URL(
        "../../../packages/db/migrations/0291_account_merge_erasure.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const adoption = await readFile(
    new URL(
      "../../../packages/db/migrations/0198_content_cms_adoption.sql",
      import.meta.url,
    ),
    "utf8",
  );
  await client.query(
    adoption.slice(
      adoption.indexOf(
        "CREATE TABLE IF NOT EXISTS content_storage_deletion_jobs (",
      ),
      adoption.indexOf(
        "DROP TRIGGER IF EXISTS content_storage_deletion_jobs_set_updated_at",
      ),
    ),
  );
  await client.query(
    await readFile(
      new URL(
        "../../../packages/db/migrations/0289_content_erasure_invalidation.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  await client.query(`insert into account_merge_transfers(id,source_user_id,target_user_id,keep_source)
    select id,id,id,false from users;
    insert into account_erasure_aliases select id,case when id<='10000000-0000-4000-8000-000000001000' then '10000000-0000-4000-8000-000000000001'::uuid else id end from users;
    insert into content_promotion_intents(id,asset_id,storage_key,next_check_at)
    select id,id,'content/'||id,case when right(id::text,3)='000' then now()-interval '1 minute' else now()+interval '1 day' end from users;
    insert into content_storage_deletion_jobs(storage_key,status,locked_at,locked_by,attempts)
    select 'content/'||id,case when right(id::text,3)='000' then 'processing' else 'completed' end,
    now()-interval '3 minutes','old-lease',8 from users;
    analyze users; analyze content_assets; analyze account_merge_transfers; analyze account_erasure_aliases; analyze content_promotion_intents; analyze content_storage_deletion_jobs;`);
  const lineage = await statements("./services/account-erasure-lineage.ts");
  const update = lineage.find((sql) =>
    sql.startsWith("update account_erasure_aliases"),
  );
  const insert = lineage.find((sql) => sql.startsWith("with transfer as"));
  const page = lineage.find((sql) =>
    sql.includes("select a.transfer_id,t.source_user_id"),
  );
  for (const [label, owner, cursor] of [
    ["first", id(1), null],
    ["resumed", id(1), id(100)],
    ["empty-tail", id(1), id(1000)],
    ["sparse", id(2000), null],
    ["missing", id(1000001), null],
  ] as const)
    await plan("lineage-page-" + label, page, [owner, cursor]);
  await plan("lineage-transfer", update, [id(1), id(2)]);
  await plan("lineage-insert", insert, [id(1), id(2), true]);
  const auth = await statements("./auth.ts");
  const resolve = auth.find((sql) =>
    sql.includes("select a.owner_user_id from account_merge_transfers"),
  );
  await plan("resolve-current-owner", resolve, [id(1)]);
  await plan("resolve-missing-owner", resolve, [id(1000001)]);
  const replay = await statements("./account-erasure-replay.ts");
  const marker = replay.find((sql) =>
    sql.startsWith("select id from account_merge_transfers"),
  );
  await plan("restore-transfer-present", marker, [id(1)]);
  await plan("restore-transfer-absent", marker, [id(1000001)]);
  await client.query(
    "update content_assets set status='pending',storage_key='content-staging/'||id,metadata=jsonb_build_object('verificationTargetKey','content/'||id) where id=$1",
    [id(2000)],
  );
  const promotion = await statements("./services/content-promotion-intents.ts");
  const due = promotion.find((sql) =>
    sql.startsWith("with page as materialized"),
  );
  assert.ok(due);
  await plan("promotion-due", due, [100]);
  const livePending = (await client.query(due, [100])).rows.find(
    (row) => row.id === id(2000),
  );
  assert.equal(
    livePending?.live,
    true,
    "pending owner retry must keep its verified target",
  );
  const advance = promotion.find((sql) =>
    sql.startsWith("update content_promotion_intents"),
  );
  await plan("promotion-advance", advance, [[id(1000), id(2000)]]);
  const asset = await statements("./services/content-assets.ts");
  await plan(
    "promotion-journal-insert",
    asset.find((sql) =>
      sql.startsWith("insert into content_promotion_intents"),
    ),
    [id(1000001), id(1), "content/fixture"],
  );
  await plan(
    "promotion-journal-ack",
    asset.find((sql) =>
      sql.startsWith("delete from content_promotion_intents"),
    ),
    [id(1)],
  );
  const worker = await statements("./services/content-worker.ts");
  const reclaim = worker.find(
    (sql) =>
      sql.includes("with expired as materialized") &&
      sql.includes("update content_storage_deletion_jobs job"),
  );
  await plan("expired-final-lease", reclaim);
  await client.query("set local plan_cache_mode=force_generic_plan");
  for (const [name, sql, types, values] of [
    ["lineage_page", page, "uuid,uuid", [id(1), id(100)]],
    ["lineage_owner", resolve, "uuid", [id(1)]],
    ["promotion_due", due, "integer", [100]],
  ] as const) {
    await client.query(`prepare ${name}(${types}) as ${sql}`);
    const literals = values
      .map((value) =>
        typeof value === "number" ? String(value) : `'${value}'`,
      )
      .join(",");
    await plan("generic-" + name, `execute ${name}(${literals})`);
    await client.query(`deallocate ${name}`);
  }
  await client.query(
    "update content_promotion_intents set next_check_at=now()+interval '1 day' where next_check_at<=now()",
  );
  await plan("promotion-empty-tail", due, [100]);
  await client.query(
    "update content_storage_deletion_jobs set status='completed' where status='processing'",
  );
  await plan("expired-lease-empty-tail", reclaim);
  await mkdir("build/compliance", { recursive: true });
  await writeFile(
    "build/compliance/erasure-fix-sql-plans.json",
    JSON.stringify(plans, null, 2),
  );
  console.log(
    `[account-erasure-fix-sql] PG16, 1m rows in each of six tables, ${plans.length} actual plans; sparse/resumed/empty/generic cases passed`,
  );
} finally {
  await client.query("rollback");
  client.release();
  await pool.end();
}
