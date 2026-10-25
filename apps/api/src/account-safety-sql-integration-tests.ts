// @requires-db
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createIntegrationTestPool } from "./test-database-target.js";
import { confirmAdultAccount } from "./services/account-age-confirmation.js";
import { enqueueContentStorageDeletion } from "./services/content-asset-deletion.js";
import { moderateAdminSocialTarget } from "./services/social-moderation.js";
import type { DbQuery } from "./db.js";

const pool = await createIntegrationTestPool({ max: 2 });
const client = await pool.connect();
const plans: unknown[] = [];
const db: DbQuery = {
  query: async (text: string, values: unknown[] = []) => {
    await client.query("savepoint safety_plan");
    const plan = await client.query(
      "explain (analyze,buffers,format json) " + text,
      values,
    );
    plans.push({ sql: text, plan: plan.rows[0]["QUERY PLAN"] });
    await client.query("rollback to safety_plan");
    return client.query(text, values);
  },
} as DbQuery;
const id = (n: number) =>
  `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
try {
  await client.query("begin");
  await client.query("create schema account_safety_fixture");
  await client.query("set local search_path=account_safety_fixture,public");
  await client.query(`create table users(id uuid primary key,is_active boolean default true,
    avatar_asset_id uuid,avatar_url text,profile_avatar_edited_at timestamptz,updated_at timestamptz default now(),
    privy_user_id text,email text,username text,display_name text,handle text,bio text,
    handle_changed_at timestamptz,is_admin boolean,kalshi_proof_bypass boolean,is_verified boolean,
    created_at timestamptz default now(),last_login_at timestamptz,
    financial_deactivated_at timestamptz,financial_pseudonymized_at timestamptz,
    financial_deactivation_reason text,privy_deletion_pending boolean)`);
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
  await client.query(source.slice(start, end));
  await client.query(`create table content_assets(id uuid primary key,owner_user_id uuid,
    status text,kind text default 'image',storage_key text,public_url text,deleted_at timestamptz,metadata jsonb default '{}')`);
  await client.query(
    `create table social_reports(id uuid primary key,target_kind text,target_id uuid,status text,resolved_at timestamptz)`,
  );
  await client.query(`create table social_moderation_events(id uuid primary key default gen_random_uuid(),
    target_kind text,target_id uuid,action text constraint social_moderation_events_action_check
    check(action in ('hide','unhide','suspend','unsuspend','resolve_report')),reason text,admin_id uuid,report_id uuid,
    created_at timestamptz default now())`);
  await client.query(`insert into users(id,is_active)
    select ('10000000-0000-4000-8000-'||lpad(g::text,12,'0'))::uuid,g%10<>0 from generate_series(1,1000000)g`);
  await client.query(`insert into content_storage_deletion_jobs(storage_key,status,available_at,locked_at)
    select 'content/scale-'||g,case when g%1000=0 then 'pending' else 'completed' end,
    now()-(g||' seconds')::interval,null from generate_series(1,1000000)g`);
  await client.query(`insert into content_assets(id,owner_user_id,status,storage_key,public_url)
    select id,id,'ready','content/'||id,'https://cdn.example/content/'||id from users`);
  for (const migration of [
    "0288_account_age_confirmation.sql",
    "0289_content_erasure_invalidation.sql",
    "0290_avatar_moderation_action.sql",
  ])
    await client.query(
      await readFile(
        new URL(
          "../../../packages/db/migrations/" + migration,
          import.meta.url,
        ),
        "utf8",
      ),
    );
  await client.query(
    "analyze users; analyze content_assets; analyze content_storage_deletion_jobs",
  );
  const authSource = await readFile(
    new URL("./auth.ts", import.meta.url),
    "utf8",
  );
  const authSelect = authSource.match(
    /"(SELECT id, privy_user_id[^"\n]*adult_confirmed_at[^"\n]*FROM users WHERE id = \$1)"/,
  );
  assert.ok(authSelect);
  await db.query(authSelect[1], [id(1)]);
  await db.query(authSelect[1], [id(1000001)]);
  const pseudonymization = [...authSource.matchAll(/`([\s\S]*?)`/g)]
    .map((match) => match[1])
    .find((sql) => sql.includes("adult_confirmation_version = null"));
  assert.ok(pseudonymization);
  await db.query(pseudonymization, [id(2)]);
  const assetSource = await readFile(
    new URL("./services/content-assets.ts", import.meta.url),
    "utf8",
  );
  const resetQuery = [...assetSource.matchAll(/`([\s\S]*?)`/g)]
    .map((match) => match[1])
    .find(
      (sql) =>
        sql.includes(
          "update content_assets set status='pending' where id=$1",
        ) && sql.includes("verificationTargetKey"),
    );
  assert.ok(resetQuery);
  await client.query(
    `update content_assets set status='verifying',metadata='{"verificationTargetKey":"target"}' where id=$1`,
    [id(3)],
  );
  await db.query(resetQuery, [id(3), "content/" + id(3), "target"]);
  await db.query(resetQuery, [id(1000001), "missing", "target"]);
  const socialSource = await readFile(
    new URL("./services/social-service.ts", import.meta.url),
    "utf8",
  );
  const attachAvatar = [...socialSource.matchAll(/`([\s\S]*?)`/g)]
    .map((match) => match[1])
    .find((sql) => sql.startsWith("select public_url from content_assets"));
  assert.ok(attachAvatar);
  await client.query(
    `update content_assets set metadata='{"avatarModerationConsentVersion":1}' where id=$1`,
    [id(4)],
  );
  assert.equal((await db.query(attachAvatar, [id(4), id(4)])).rows.length, 1);
  assert.equal((await db.query(attachAvatar, [id(5), id(5)])).rows.length, 0);
  assert.equal((await db.query(attachAvatar, [id(4), id(5)])).rows.length, 0);
  const first = await confirmAdultAccount(db, id(1));
  assert.ok(first instanceof Date);
  assert.equal(
    (await confirmAdultAccount(db, id(1)))?.toISOString(),
    first.toISOString(),
  );
  assert.equal(await confirmAdultAccount(db, id(10)), null);
  assert.equal(await confirmAdultAccount(db, id(1000001)), null);
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
  await client.query(
    "update users set avatar_asset_id=id,avatar_url='https://cdn.example/avatar' where id=$1",
    [id(1)],
  );
  await assert.rejects(
    () =>
      moderateAdminSocialTarget(
        db,
        {
          target: { kind: "user", id: id(1) },
          action: "remove_avatar",
          reason: "Old preview",
          expectedAvatarUrl: "https://cdn.example/stale-avatar",
        },
        id(2),
        { pageSize: 10, maxPageSize: 100, moderationReasonMaxGraphemes: 500 },
      ),
    { code: "social_avatar_changed" },
  );
  const event = await moderateAdminSocialTarget(
    db,
    {
      target: { kind: "user", id: id(1) },
      action: "remove_avatar",
      expectedAvatarUrl: "https://cdn.example/avatar",
      reason: "Avatar violates guidelines",
    },
    id(2),
    { pageSize: 10, maxPageSize: 100, moderationReasonMaxGraphemes: 500 },
  );
  assert.equal(event.action, "remove_avatar");
  assert.equal(
    (await client.query("select avatar_url from users where id=$1", [id(1)]))
      .rows[0].avatar_url,
    null,
  );
  assert.equal(
    (
      await client.query("select status from content_assets where id=$1", [
        id(1),
      ])
    ).rows[0].status,
    "deleted",
  );
  const worker = await readFile(
    new URL("./services/content-worker.ts", import.meta.url),
    "utf8",
  );
  const workerSlice = worker.slice(
    worker.indexOf("async function claimStorageDeletion"),
    worker.indexOf("export async function runContentRetention"),
  );
  const queries = [...workerSlice.matchAll(/`([\s\S]*?)`/g)]
    .map((match) => match[1])
    .filter(
      (sql) =>
        sql.includes("content_storage_deletion_jobs") && !sql.includes("${"),
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
      ...[...sql.matchAll(/\$(\d+)/g)].map((match) => Number(match[1])),
    );
    await db.query(sql, parameters.slice(0, count));
  }
  // Empty-tail/sparse worker selection retains the same partial-index plan.
  await client.query(
    "update content_storage_deletion_jobs set status='completed' where status='pending'",
  );
  for (const sql of queries.filter((sql) =>
    sql.includes("select id, storage_key"),
  ))
    await db.query(sql, [8]);
  await client.query("set local plan_cache_mode=force_generic_plan");
  await client.query(
    "prepare age_generic(uuid) as select adult_confirmed_at from users where id=$1",
  );
  plans.push({
    genericAge: (
      await client.query(
        `explain(analyze,buffers,format json) execute age_generic('${id(1)}')`,
      )
    ).rows[0]["QUERY PLAN"],
  });
  await mkdir("build/compliance", { recursive: true });
  await writeFile(
    "build/compliance/sql-plans.json",
    JSON.stringify(plans, null, 2),
  );
  console.log(
    `[account-safety-sql] PostgreSQL 16: 1m users, 1m assets, 1m jobs; ${plans.length} plans; age idempotency/inactive/missing, atomic avatar removal and version/CDN worker SQL passed`,
  );
  await client.query("rollback");
} finally {
  client.release();
  await pool.end();
}
