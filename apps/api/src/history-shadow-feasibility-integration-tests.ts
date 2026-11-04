// @requires-db
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createIntegrationTestPool } from "./test-database-target.js";

// Deliberately isolated feasibility fixture, NOT a production cleanup command.
assert.ok(process.env.HUNCH_TEST_EXPECT_DATABASE);
assert.ok(process.env.DATABASE_URL);
assert.ok(
  ["127.0.0.1", "localhost", "[::1]"].includes(
    new URL(process.env.DATABASE_URL).hostname,
  ),
);
const pool = await createIntegrationTestPool({ max: 1 });
const db = await pool.connect();
const schema = `history_shadow_${randomUUID().replaceAll("-", "")}`;
let created = false;
try {
  const version = await db.query(
    "select current_setting('server_version_num') as pg,extversion from pg_extension where extname='timescaledb'",
  );
  assert.match(version.rows[0].pg, /^16/);
  assert.equal(version.rows[0].extversion, "2.14.2");
  await db.query("set statement_timeout='15s';set lock_timeout='2s'");
  assert.equal(
    (await db.query("select 1 from pg_namespace where nspname=$1", [schema]))
      .rowCount,
    0,
  );
  await db.query(`create schema ${schema}`);
  created = true;
  await db.query(`set search_path=${schema},public`);
  await db.query(`create table raw_quotes(token_id text,venue text,ts timestamptz not null,mid numeric,best_bid numeric,best_ask numeric);
 select create_hypertable('raw_quotes','ts',chunk_time_interval=>interval '1 day');
 create materialized view hour_quotes with(timescaledb.continuous,timescaledb.materialized_only=true) as
 select token_id,venue,time_bucket('1 hour',ts) as bucket,avg(mid) as avg_mid,min(mid) as min_mid,max(mid) as max_mid,avg(best_bid) as avg_best_bid,avg(best_ask) as avg_best_ask,count(*) as samples from raw_quotes group by token_id,venue,bucket with no data;
 create table retirement_manifest(token_id text,venue text,confirmed boolean,primary key(token_id,venue));
 create table current_instruments(token_id text,venue text,primary key(token_id,venue));
 insert into retirement_manifest values('retired','polymarket',true),('reintroduced','polymarket',true),('unknown','polymarket',false);
 insert into current_instruments values('keep','polymarket'),('shared-generation','polymarket');
 insert into raw_quotes select token_row,'polymarket',time_row,0.4,0.39,0.41 from
 unnest(array['retired','keep','unknown','reintroduced','shared-generation']) token_row
 cross join unnest(array['2026-02-01T12:00Z'::timestamptz,'2026-11-01T12:00Z'::timestamptz]) time_row;`);
  await db.query("call refresh_continuous_aggregate('hour_quotes',null,null)");
  await db.query(`create table cold_history(like hour_quotes);
 create unique index on cold_history(token_id,venue,bucket);
 select create_hypertable('cold_history','bucket',chunk_time_interval=>interval '1 day');
 create table rollback_history(like hour_quotes);
 insert into rollback_history select * from hour_quotes where bucket<'2026-10-01';`);
  const copy = `insert into cold_history select history_row.* from hour_quotes history_row
 where bucket<'2026-10-01' and not exists(select 1 from retirement_manifest manifest_row
 where manifest_row.token_id=history_row.token_id and manifest_row.venue=history_row.venue and manifest_row.confirmed
 and not exists(select 1 from current_instruments current_row where current_row.token_id=history_row.token_id and current_row.venue=history_row.venue))
 on conflict(token_id,venue,bucket) do update set avg_mid=excluded.avg_mid,min_mid=excluded.min_mid,max_mid=excluded.max_mid,avg_best_bid=excluded.avg_best_bid,avg_best_ask=excluded.avg_best_ask,samples=excluded.samples`;
  await db.query(copy);
  // Interrupted copy rolls back, leaving the original read path untouched.
  await db.query("begin");
  await db.query("delete from cold_history");
  await db.query("rollback");
  assert.equal(
    (await db.query("select count(*)::int as count from cold_history")).rows[0]
      .count,
    3,
  );
  // Reappearance and late writes before cutover require a fresh copy/validation.
  await db.query(
    "insert into current_instruments values('reintroduced','polymarket');insert into raw_quotes values('keep','polymarket','2026-02-01T12:15Z',0.6,0.59,0.61)",
  );
  await db.query(
    "call refresh_continuous_aggregate('hour_quotes','2026-02-01','2026-02-02')",
  );
  await db.query(copy);
  await db.query(copy);
  const expected = (
    await db.query(
      "select * from hour_quotes where bucket<'2026-10-01' and token_id<>'retired' order by token_id,bucket",
    )
  ).rows;
  assert.deepEqual(
    (await db.query("select * from cold_history order by token_id,bucket"))
      .rows,
    expected,
  );
  await db.query(
    "truncate rollback_history;insert into rollback_history select * from hour_quotes where bucket<'2026-10-01'",
  );
  const original = (
    await db.query("select * from hour_quotes order by token_id,bucket")
  ).rows;
  // Raw expiry does not let us recreate old aggregates. They were copied above.
  await db.query("delete from raw_quotes where ts<'2026-10-01'");
  const selected = await db.query(
    "select show_chunks('hour_quotes',older_than=>'2026-10-01'::timestamptz)::text as chunk",
  );
  assert.ok(selected.rows.length > 0);
  // Supported public API, only in this generated local fixture schema.
  await db.query(
    "select drop_chunks('hour_quotes',older_than=>'2026-10-01'::timestamptz)",
  );
  const combined = (
    await db.query(
      "select * from cold_history where bucket<'2026-10-01' union all select * from hour_quotes where bucket>='2026-10-01' order by token_id,bucket",
    )
  ).rows;
  assert.deepEqual(
    combined,
    original.filter(
      (row) =>
        row.token_id !== "retired" ||
        new Date(row.bucket) >= new Date("2026-10-01"),
    ),
  );
  const restored = (
    await db.query(
      "select * from rollback_history union all select * from hour_quotes where bucket>='2026-10-01' order by token_id,bucket",
    )
  ).rows;
  assert.deepEqual(
    restored,
    original,
    "reader rollback does not need missing raw quotes or internal CAGG DML",
  );
  console.log(
    "[history shadow] PG16/TS2.14.2 copy/late-write/reappearance/unknown/idempotency/interruption/public-drop/reader-rollback passed",
  );
} finally {
  if (created) {
    const owned = await db.query(
      "select nspname from pg_namespace where nspname=$1",
      [schema],
    );
    assert.equal(owned.rows[0]?.nspname, schema);
    await db.query("set search_path=public");
    await db.query(`drop schema ${schema} cascade`);
  }
  db.release();
  await pool.end();
}
