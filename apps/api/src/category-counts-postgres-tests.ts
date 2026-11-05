// @requires-db -- disposable PG16 database, not repository .env.
import assert from "node:assert/strict";
import { Pool } from "pg";
import { DEFAULT_CATEGORY_COUNTS_SQL } from "./repos/meta-categories.js";

const pool = new Pool({
  connectionString:
    "postgres://postgres:embedding_test_local@127.0.0.1:55439/change24_test",
  max: 1,
});
const db = await pool.connect();
const original = `select venue,lower(category) as category,count(*)::int as events from unified_events where status='ACTIVE' and venue=any($1::text[]) and category is not null and btrim(category)<>'' group by venue,lower(category) order by events desc,venue asc,category asc`;
try {
  assert.equal(
    (await db.query("select current_database() as db")).rows[0].db,
    "change24_test",
  );
  assert.match(
    (await db.query("show server_version")).rows[0].server_version,
    /^16\./,
  );
  await db.query(
    "begin;set local statement_timeout='15s';set local lock_timeout='2s';set local jit=off",
  );
  await db.query(`insert into unified_events(id,venue,venue_event_id,title,status,category)
    select 'category-plan:e'||n,case n%3 when 0 then 'polymarket' when 1 then 'limitless' else 'kalshi' end,'category-plan:e'||n,'Fixture',case when n%5=0 then 'CLOSED'::unified_status else 'ACTIVE'::unified_status end,
    case n%7 when 0 then null when 1 then '' when 2 then '  ' when 3 then 'SPORTS' when 4 then 'Sports' when 5 then 'Café' else 'economics' end from generate_series(1,100001)n;
    analyze unified_events;`);
  for (const venues of [
    [],
    ["limitless"],
    ["polymarket", "limitless", "kalshi"],
    ["missing"],
    ["limitless", "limitless"],
  ]) {
    const before = (await db.query(original, [venues])).rows;
    const after = (await db.query(DEFAULT_CATEGORY_COUNTS_SQL, [venues])).rows;
    assert.deepEqual(after, before);
  }
  await db.query(
    "prepare category_plan(text[]) as " + DEFAULT_CATEGORY_COUNTS_SQL,
  );
  for (const mode of ["force_custom_plan", "force_generic_plan"]) {
    await db.query("set local plan_cache_mode=" + mode);
    const explain = (
      await db.query(
        "explain(analyze,buffers,format json) execute category_plan('{polymarket,limitless,kalshi}')",
      )
    ).rows[0]["QUERY PLAN"][0];
    console.log(
      JSON.stringify({
        mode,
        fixtureEvents: 100001,
        ms: explain["Execution Time"],
        rows: explain.Plan["Actual Rows"],
        read: explain.Plan["Shared Read Blocks"],
        hit: explain.Plan["Shared Hit Blocks"],
        temp: explain.Plan["Temp Written Blocks"],
      }),
    );
  }
} finally {
  await db.query("rollback");
  db.release();
  await pool.end();
}
