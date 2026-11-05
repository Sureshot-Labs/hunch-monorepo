// @requires-db -- only the fixed disposable PG16/Timescale database below.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import {
  writeUnifiedBookTop,
  writeUnifiedBookTops,
  writeResolvedTerminalTokenTops,
  flushUnifiedBookTopLatestTouches,
  resetUnifiedBookTopWriteStateForTests,
} from "@hunch/db";

const pool = new Pool({
  connectionString:
    "postgres://postgres:embedding_test_local@127.0.0.1:55439/change24_test",
  max: 4,
  statement_timeout: 15000,
  lock_timeout: 2000,
});
const db = await pool.connect(),
  writer = await pool.connect();
const market = "quote-journal:m",
  yes = "limitless:quote-journal-y",
  no = "limitless:quote-journal-n";
const queued = async () =>
  Number(
    (
      await db.query(
        "select count(*) from unified_change24_market_journal where market_id=$1",
        [market],
      )
    ).rows[0].count,
  );
const clear = () =>
  db.query("delete from unified_change24_market_journal where market_id=$1", [
    market,
  ]);
const refresh = () =>
  db.query("select refresh_unified_market_event_change_24h_incremental()");
try {
  assert.equal(
    (await db.query("select current_database() as db")).rows[0].db,
    "change24_test",
  );
  assert.match(
    (await db.query("show server_version")).rows[0].server_version,
    /^16\./,
  );
  assert.equal(
    (
      await db.query(
        "select extversion from pg_extension where extname='timescaledb'",
      )
    ).rows[0].extversion,
    "2.14.2",
  );
  await db.query("begin");
  await db.query(
    readFileSync(
      new URL(
        "../../../packages/db/migrations/0295_change24_quote_journal.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  await db.query("commit");
  await db.query(
    "select alter_job(job_id,scheduled=>false) from timescaledb_information.jobs",
  );
  await db.query(
    "delete from unified_refresh_pipeline_state where pipeline_name='change24_quote_journal_handoff'",
  );
  await db.query(`insert into unified_events(id,venue,venue_event_id,title,status) values('quote-journal:e','limitless','quote-journal:e','Fixture','ACTIVE');
    insert into unified_markets(id,venue,venue_market_id,event_id,title,status,market_type) values('quote-journal:m','limitless','quote-journal:m','quote-journal:e','Fixture','ACTIVE','binary');
    insert into unified_market_tokens(market_id,token_id,venue,outcome_side) values('quote-journal:m','limitless:quote-journal-y','limitless','YES'),('quote-journal:m','limitless:quote-journal-n','limitless','NO');
    insert into unified_token_change_24h(token_id,avg_mid_24h) values('limitless:quote-journal-y',0.4),('limitless:quote-journal-n',0.6);`);
  await clear();
  await db.query(
    "insert into unified_token_top_latest(token_id,venue,ts,best_bid,best_ask) values($1,'limitless',now(),0.5,0.5),($2,'limitless',now(),0.5,0.5)",
    [yes, no],
  );
  assert.equal(
    await queued(),
    1,
    "two inserted sides deduplicate to one market in the insert statement",
  );
  // Normal refresh must not even acquire a raw relation read lock.
  await writer.query(
    "begin;lock table unified_book_top in access exclusive mode",
  );
  try {
    await db.query("begin;set local statement_timeout='1s'");
    await refresh();
    await db.query("commit");
  } finally {
    await db.query("rollback");
    await writer.query("rollback");
  }
  assert.equal(await queued(), 0);
  console.log(
    "ok - normal refresh succeeds with raw history exclusively locked",
  );

  await db.query("begin");
  const ts = new Date(Date.now() + 1000);
  resetUnifiedBookTopWriteStateForTests(db as unknown as Pool);
  await writeUnifiedBookTop(db as unknown as Pool, yes, 0.6, 0.6, ts);
  assert.equal(await queued(), 1);
  await clear();
  await writeUnifiedBookTop(
    db as unknown as Pool,
    yes,
    0.6,
    0.6,
    new Date(ts.getTime() + 1000),
    { touchLatestWhenUnchanged: true },
  );
  await flushUnifiedBookTopLatestTouches(db as unknown as Pool);
  assert.equal(await queued(), 0, "unchanged heartbeat does not create work");
  await writeUnifiedBookTops(db as unknown as Pool, [
    {
      tokenId: yes,
      ts: new Date(ts.getTime() + 2000),
      bestBid: 0.7,
      bestAsk: 0.7,
    },
    {
      tokenId: no,
      ts: new Date(ts.getTime() + 2000),
      bestBid: 0.3,
      bestAsk: 0.3,
    },
  ]);
  assert.equal(
    await queued(),
    1,
    "bulk sides wake one market, not one record per token",
  );
  await clear();
  resetUnifiedBookTopWriteStateForTests(db as unknown as Pool);
  await writeUnifiedBookTops(db as unknown as Pool, [
    {
      tokenId: yes,
      ts: new Date(ts.getTime() - 10000),
      bestBid: 0.1,
      bestAsk: 0.1,
    },
  ]);
  assert.equal(
    await queued(),
    0,
    "DB-rejected old top cannot create a price wake-up",
  );
  await writeResolvedTerminalTokenTops(db, {
    yesTokenId: yes,
    noTokenId: no,
    resolvedOutcome: "YES",
    observedAt: new Date(ts.getTime() + 3000),
  });
  assert.equal(
    await queued(),
    1,
    "terminal helper is covered without a caller-specific hook",
  );
  await clear();
  await db.query(
    "update unified_token_top_latest set best_bid=null,best_ask=null where token_id=$1",
    [yes],
  );
  assert.equal(await queued(), 1, "authoritative clearing creates work");
  await clear();
  await db.query(
    "insert into unified_market_tokens(market_id,token_id,venue,outcome_side) values($1,'limitless:quote-journal-alias','limitless','YES')",
    [market],
  );
  await clear();
  await db.query(
    "update unified_token_top_latest set token_id='limitless:quote-journal-alias' where token_id=$1",
    [yes],
  );
  assert.equal(
    await queued(),
    1,
    "identity changes invalidate both old and new token mappings",
  );
  await db.query(
    "update unified_token_top_latest set token_id=$1 where token_id='limitless:quote-journal-alias'",
    [yes],
  );
  await clear();
  await db.query("delete from unified_token_top_latest where token_id=$1", [
    yes,
  ]);
  assert.equal(await queued(), 1, "quote deletion creates work");
  await db.query("rollback");
  assert.equal(
    await queued(),
    0,
    "rolling back quotes also rolls back their wake-ups",
  );
  console.log(
    "ok - single/bulk/touch/old/terminal/clear/delete paths preserve atomic deduplication",
  );

  await writer.query("begin");
  await writer.query(
    "update unified_token_top_latest set best_bid=0.6,best_ask=0.6 where token_id=$1",
    [yes],
  );
  await refresh();
  await writer.query("commit");
  assert.equal(
    await queued(),
    1,
    "late commit remains visible after consumer ACK",
  );
  await refresh();
  assert.equal(await queued(), 0);
  await db.query("begin");
  await refresh();
  await writer.query("set statement_timeout='1s'");
  await writer.query(
    "update unified_token_top_latest set best_bid=0.7,best_ask=0.7 where token_id=$1",
    [yes],
  );
  await db.query("commit");
  assert.equal(
    await queued(),
    1,
    "producer appends while consumer transaction remains open",
  );
  await refresh();
  console.log(
    "ok - late commits and concurrent price writers survive exact-ID acknowledgement",
  );

  await db.query("begin");
  await db.query(
    "update unified_markets set expiration_time=now()-interval '10 seconds' where id=$1",
    [market],
  );
  await clear();
  await db.query(
    "update unified_refresh_pipeline_state set successful_cutoff=now()-interval '1 minute' where pipeline_name='market_event_change_24h'",
  );
  await refresh();
  assert.equal(
    Number(
      (
        await db.query(
          "select count(*) from unified_market_change_24h where market_id=$1",
          [market],
        )
      ).rows[0].count,
    ),
    0,
  );
  await db.query("rollback");
  console.log(
    "ok - indexed expiration boundary removes cached data without an incoming wake-up",
  );

  await db.query("begin");
  await db.query(
    "update unified_token_top_latest set best_bid=case when token_id=$1 then 0.6 else 0.4 end,best_ask=case when token_id=$1 then 0.6 else 0.4 end where token_id=any($2::text[])",
    [yes, [yes, no]],
  );
  await db.query(
    "insert into unified_book_top(token_id,venue,ts,best_bid,best_ask,mid) values($1,'limitless',now()-interval '1 minute',0.6,0.6,0.6) on conflict do nothing",
    [yes],
  );
  await clear(); // Simulate a price written just before trigger installation.
  await db.query(
    "insert into unified_refresh_pipeline_state(pipeline_name,successful_cutoff) values('change24_quote_journal_handoff',clock_timestamp()) on conflict(pipeline_name) do update set successful_cutoff=excluded.successful_cutoff",
  );
  await db.query(
    "update unified_refresh_pipeline_state set successful_cutoff=now()-interval '2 minutes' where pipeline_name='market_event_change_24h'",
  );
  await db.query("savepoint handoff");
  await refresh();
  assert.equal(
    (
      await db.query(
        "select change_24h::text as value from unified_market_change_24h where market_id=$1",
        [market],
      )
    ).rows[0].value,
    "0.50000000000000000000",
  );
  assert.equal(
    Number(
      (
        await db.query(
          "select count(*) from unified_refresh_pipeline_state where pipeline_name='change24_quote_journal_handoff'",
        )
      ).rows[0].count,
    ),
    0,
  );
  await db.query("rollback to savepoint handoff");
  assert.equal(
    Number(
      (
        await db.query(
          "select count(*) from unified_refresh_pipeline_state where pipeline_name='change24_quote_journal_handoff'",
        )
      ).rows[0].count,
    ),
    1,
  );
  await refresh();
  await db.query("commit");
  console.log(
    "ok - cutover discovers pre-trigger prices and marker ACK rolls back with caches",
  );
  await db.query("begin");
  await db.query(`insert into unified_markets(id,venue,venue_market_id,event_id,title,status,market_type)
    select 'quote-load:m'||n,'limitless','quote-load:m'||n,'quote-journal:e','Fixture','ACTIVE','binary' from generate_series(1,1000)n;
    insert into unified_market_tokens(market_id,token_id,venue,outcome_side)
    select 'quote-load:m'||n,'limitless:quote-load:t'||n||side_row,'limitless',side_row from generate_series(1,1000)n cross join unnest(array['YES','NO'])side_row;`);
  const started = Date.now();
  await db.query(`insert into unified_token_top_latest(token_id,venue,ts,best_bid,best_ask)
    select 'limitless:quote-load:t'||n||side_row,'limitless',now(),0.5,0.5 from generate_series(1,1000)n cross join unnest(array['YES','NO'])side_row`);
  const queuedMarkets = Number(
    (
      await db.query(
        "select count(*) from unified_change24_market_journal where market_id like 'quote-load:%'",
      )
    ).rows[0].count,
  );
  assert.equal(queuedMarkets, 3000);
  console.log(
    JSON.stringify({
      kind: "quote_journal_write_scale",
      tokens: 2000,
      markets: 1000,
      quoteWriteMs: Date.now() - started,
      journalRecords: queuedMarkets,
    }),
  );
  await db.query("rollback");
} finally {
  await writer.query("rollback").catch(() => {});
  await db.query("rollback").catch(() => {});
  resetUnifiedBookTopWriteStateForTests(db as unknown as Pool);
  await db.query("delete from unified_market_change_24h where market_id=$1", [
    market,
  ]);
  await db.query("delete from unified_markets where id=$1;", [market]);
  await db.query("delete from unified_events where id='quote-journal:e'");
  await db.query(
    "delete from unified_token_top_latest where token_id=any($1::text[])",
    [[yes, no]],
  );
  await db.query(
    "delete from unified_token_change_24h where token_id=any($1::text[])",
    [[yes, no]],
  );
  await db.query(
    "delete from unified_book_top where token_id=any($1::text[])",
    [[yes, no]],
  );
  await db.query(
    "delete from unified_change24_market_journal where market_id=$1",
    [market],
  );
  await db.query(
    "delete from unified_change24_event_journal where event_id='quote-journal:e'",
  );
  writer.release();
  db.release();
  await pool.end();
}
