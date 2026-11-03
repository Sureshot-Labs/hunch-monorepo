// @requires-db
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createIntegrationTestPool } from "./test-database-target.js";

const db = await createIntegrationTestPool({
  max: 1,
  options: "-c statement_timeout=60000 -c lock_timeout=2000",
});
const migration = readFileSync(
  new URL(
    "../../../packages/db/migrations/0293_raw_book_compression_three_days.sql",
    import.meta.url,
  ),
  "utf8",
);
const target = (
  await db.query(
    "select current_database() as database_name,current_setting('server_version_num')::int as version",
  )
).rows[0];
assert.match(target.database_name, /^hunch_quote_compression_test_/);
assert.ok(target.version >= 160000 && target.version < 170000);
assert.equal(
  (
    await db.query(
      "select extversion from pg_extension where extname='timescaledb'",
    )
  ).rows[0].extversion,
  "2.14.2",
);
let bookCreated = false,
  tradeCreated = false;
const jobRows = async () =>
  (
    await db.query(
      `select job_id,proc_name,hypertable_name,config,schedule_interval::text,max_runtime::text,max_retries,retry_period::text,scheduled,fixed_schedule,next_start,initial_start from timescaledb_information.jobs where hypertable_schema='public' and hypertable_name in ('unified_book_top','quote_compression_test_other') order by job_id`,
    )
  ).rows;
const compressedCount = async () =>
  Number(
    (
      await db.query(
        "select count(*) as compressed from timescaledb_information.chunks where hypertable_schema='public' and hypertable_name='unified_book_top' and is_compressed",
      )
    ).rows[0].compressed,
  );
const apply = async () => {
  await db.query("begin");
  try {
    await db.query(migration);
    await db.query("commit");
  } catch (error) {
    await db.query("rollback");
    throw error;
  }
};
try {
  // Missing optional policy is a no-op, not an availability-blocking assertion.
  await apply();
  await db.query(
    `create table public.unified_book_top(token_id text not null,venue text not null,ts timestamptz not null,best_bid numeric,best_ask numeric,mid numeric,spread numeric,primary key(token_id,ts))`,
  );
  bookCreated = true;
  await db.query(
    "select create_hypertable('public.unified_book_top','ts',chunk_time_interval=>interval '1 day')",
  );
  await db.query(
    "alter table public.unified_book_top set(timescaledb.compress,timescaledb.compress_segmentby='token_id',timescaledb.compress_orderby='ts')",
  );
  await db.query(
    `create table public.quote_compression_test_other(token_id text not null,ts timestamptz not null,price numeric,primary key(token_id,ts))`,
  );
  tradeCreated = true;
  await db.query(
    "select create_hypertable('public.quote_compression_test_other','ts',chunk_time_interval=>interval '1 day')",
  );
  await db.query(
    "alter table public.quote_compression_test_other set(timescaledb.compress,timescaledb.compress_segmentby='token_id',timescaledb.compress_orderby='ts')",
  );
  const compId = Number(
    (
      await db.query(
        "select add_compression_policy('public.unified_book_top',interval '7 days',schedule_interval=>interval '12 hours',initial_start=>now()+interval '1 day') as job_id",
      )
    ).rows[0].job_id,
  );
  await db.query(
    "select add_retention_policy('public.unified_book_top',interval '30 days',initial_start=>now()+interval '1 day')",
  );
  await db.query(
    "select add_compression_policy('public.quote_compression_test_other',interval '7 days',schedule_interval=>interval '12 hours',initial_start=>now()+interval '1 day')",
  );
  const before = await jobRows();
  await apply();
  const after = await jobRows();
  for (let i = 0; i < before.length; i++) {
    const expected = before[i];
    if (expected.job_id === compId)
      assert.deepEqual(after[i], {
        ...expected,
        config: {
          ...expected.config,
          compress_after: "3 days",
          maxchunks_to_compress: 1,
        },
      });
    else
      assert.deepEqual(
        after[i],
        expected,
        "unrelated compression/retention unchanged",
      );
  }
  await apply();
  assert.deepEqual(
    await jobRows(),
    after,
    "reapplication keeps schedule and job identity",
  );
  // A disabled installed job remains disabled; only its configuration is changed.
  await db.query("select alter_job($1::int,scheduled=>false)", [compId]);
  await apply();
  assert.equal(
    (await jobRows()).find((row) => row.job_id === compId).scheduled,
    false,
  );
  await db.query("select alter_job($1::int,scheduled=>true)", [compId]);

  await db.query(`insert into public.unified_book_top
 select 'compression-fixture:'||token_number,'polymarket',date_trunc('day',now())-day_number*interval '1 day'+tick_number*interval '86 seconds',
  0.40+tick_number::numeric/100000,0.42+tick_number::numeric/100000,0.41+tick_number::numeric/100000,0.02
 from generate_series(1,100) token_number cross join generate_series(1,10) day_number cross join generate_series(0,999) tick_number`);
  await db.query("analyze public.unified_book_top");
  const baseline = (
    await db.query(
      "select count(*)::int as row_count,sum(mid)::text as mid_sum from public.unified_book_top",
    )
  ).rows[0];
  assert.equal(baseline.row_count, 1000000);
  assert.equal(
    await compressedCount(),
    0,
    "migration never compresses data synchronously",
  );
  await db.query("call run_job($1::int)", [compId]);
  assert.equal(
    await compressedCount(),
    1,
    "exact installed policy compresses at most one chunk",
  );
  assert.deepEqual(
    (
      await db.query(
        "select count(*)::int as row_count,sum(mid)::text as mid_sum from public.unified_book_top",
      )
    ).rows[0],
    baseline,
    "all rows and decimal values preserved",
  );
  const compressedRow = (
    await db.query(
      "select chunk_name,range_start,range_end from timescaledb_information.chunks where hypertable_schema='public' and hypertable_name='unified_book_top' and is_compressed",
    )
  ).rows[0];
  assert.ok(Date.parse(compressedRow.range_end) < Date.now() - 3 * 86400000);
  const start = compressedRow.range_start;
  // Match the real writer's duplicate-first batch ON CONFLICT DO NOTHING.
  await db.query(
    `insert into public.unified_book_top(token_id,venue,ts,best_bid,best_ask,mid,spread)
 select 'compression-fixture:1','polymarket',$1::timestamptz+delta_seconds*interval '1 second',0.4,0.42,0.41,0.02
 from unnest(array[0,1,2]) delta_seconds on conflict do nothing`,
    [start],
  );
  assert.equal(
    Number(
      (
        await db.query(
          "select count(*) from public.unified_book_top where token_id='compression-fixture:1' and ts >= $1::timestamptz and ts < $1::timestamptz+interval '3 seconds'",
          [start],
        )
      ).rows[0].count,
    ),
    3,
  );
  await db.query(
    "update public.unified_book_top set mid=0.55 where token_id='compression-fixture:1' and ts=$1::timestamptz+interval '1 second'",
    [start],
  );
  await db.query(
    "delete from public.unified_book_top where token_id='compression-fixture:1' and ts=$1::timestamptz+interval '2 seconds'",
    [start],
  );
  await db.query(
    `create materialized view public.quote_compression_test_1m with(timescaledb.continuous) as select token_id,venue,time_bucket('1 minute',ts) as bucket,avg(mid) as avg_mid,count(*) as samples from public.unified_book_top group by token_id,venue,bucket with no data`,
  );
  await db.query(
    "call refresh_continuous_aggregate('public.quote_compression_test_1m',null,null)",
  );
  assert.equal(
    Number(
      (
        await db.query(
          "select sum(samples) from public.quote_compression_test_1m",
        )
      ).rows[0].sum,
    ),
    1000001,
  );
  assert.equal(
    (
      await db.query(
        "select mid::text from public.unified_book_top where token_id='compression-fixture:1' and ts=$1::timestamptz+interval '1 second'",
        [start],
      )
    ).rows[0].mid,
    "0.55",
  );
  // Recompression uses the same one-chunk budget and has a recovery path.
  await db.query("call run_job($1::int)", [compId]);
  assert.equal(
    await compressedCount(),
    1,
    "partially compressed oldest chunk is repaired within the cap",
  );
  await db.query("call run_job($1::int)", [compId]);
  assert.equal(
    await compressedCount(),
    2,
    "next ordinary invocation advances the backlog",
  );
  const selector = `select job_id,config||jsonb_build_object('compress_after','3 days','maxchunks_to_compress',1) as proposed_config from timescaledb_information.jobs compression_job where compression_job.hypertable_schema='public' and compression_job.hypertable_name='unified_book_top' and compression_job.proc_name='policy_compression' and compression_job.config ? 'compress_after' and not(compression_job.config ? 'compress_created_before')`;
  const plan = (
    await db.query(`explain(analyze,buffers,format json) ${selector}`)
  ).rows[0]["QUERY PLAN"][0];
  console.log(
    JSON.stringify({
      test: "quote_compression_policy",
      postgres: 16,
      timescale: "2.14.2",
      rows: baseline.row_count,
      scopeAndScheduleUnchanged: true,
      boundedCompressionAndRecompression: true,
      lateWritesAndAggregates: true,
      selectorExecutionMs: plan["Execution Time"],
    }),
  );
} finally {
  // Only fixture tables successfully created by this test, in an exact disposable
  // database; CASCADE removes their generated Timescale chunks/CAGG and jobs.
  if (bookCreated) await db.query("drop table public.unified_book_top cascade");
  if (tradeCreated)
    await db.query("drop table public.quote_compression_test_other cascade");
  await db.end();
}
