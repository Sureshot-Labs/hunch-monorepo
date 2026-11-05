// @requires-db -- exact isolated local PG16/Timescale fixture, never repository .env.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import {
  writeResolvedTerminalTokenTops,
  writeUnifiedBookTops,
  resetUnifiedBookTopWriteStateForTests,
} from "@hunch/db";

const pool = new Pool({
  connectionString:
    "postgres://postgres:embedding_test_local@127.0.0.1:55439/change24_test",
  max: 4,
  statement_timeout: 15000,
  lock_timeout: 2000,
});
const db = await pool.connect();
try {
  assert.equal(
    (await db.query("select current_database() as db")).rows[0].db,
    "change24_test",
  );
  assert.match(
    (await db.query("show server_version_num")).rows[0].server_version_num,
    /^16/,
  );
  assert.equal(
    (
      await db.query(
        "select extversion from pg_extension where extname='timescaledb'",
      )
    ).rows[0].extversion,
    "2.14.2",
  );
  // Disable only schedules in this fixed disposable database, never production.
  await db.query(
    "select alter_job(job_id,scheduled=>false) from timescaledb_information.jobs",
  );
  // Recover this test's exact named fixture after an interrupted previous run.
  await db.query(`drop trigger if exists fixture_event_cache_failure on unified_event_change_24h;
    drop function if exists fixture_event_cache_failure();
    delete from unified_markets where id='rollback:m';delete from unified_events where id='rollback:e';
    delete from unified_token_change_24h where token_id='rollback:y';delete from unified_token_top_latest where token_id='rollback:y'`);
  await db.query("begin");
  await db.query(`insert into unified_events(id,venue,venue_event_id,title,status) values('journal:e','limitless','journal:e','Fixture','ACTIVE');
  insert into unified_markets(id,venue,venue_market_id,event_id,title,status,market_type)
  select 'journal:m'||n,'limitless','journal:'||n,'journal:e','Fixture','ACTIVE','binary' from generate_series(1,2001) n;
  insert into unified_market_tokens(market_id,token_id,venue,outcome_side)
  select 'journal:m'||n,'journal:t'||n||side_row,'limitless',side_row from generate_series(1,2001) n cross join unnest(array['YES','NO']) side_row;
  insert into unified_token_change_24h(token_id,avg_mid_24h) select token_id,case outcome_side when 'YES' then 0.4 else 0.6 end from unified_market_tokens where market_id like 'journal:%';
  insert into unified_token_top_latest(token_id,venue,ts,best_bid,best_ask) select token_id,'limitless',now(),0.5,0.5 from unified_market_tokens where market_id like 'journal:%';
  insert into unified_change24_dirty_markets values('journal:m1',now());
  select refresh_unified_market_event_change_24h_incremental();`);
  assert.equal(
    (
      await db.query(
        "select count(*)::int as count from unified_market_change_24h where market_id like 'journal:%' and change_24h=0.25",
      )
    ).rows[0].count,
    2001,
  );
  assert.equal(
    (
      await db.query(
        "select count(*)::int as count from unified_change24_dirty_markets where market_id='journal:m1'",
      )
    ).rows[0].count,
    0,
  );
  await db.query("rollback");
  assert.equal(
    (
      await db.query(
        "select count(*)::int as count from unified_market_change_24h where market_id like 'journal:%'",
      )
    ).rows[0].count,
    0,
  );
  console.log(
    "ok - exact migrated function processes >1000 candidates and legacy handoff, rollback restores state",
  );

  // Long consumer transactions must not block a producer for the same entity.
  await db.query(
    "select enqueue_unified_change24_market('journal:concurrent')",
  );
  await db.query("begin");
  const observed = (
    await db.query(
      "select id from unified_change24_market_journal where market_id='journal:concurrent'",
    )
  ).rows.map((r) => r.id);
  await db.query(
    "select refresh_unified_market_event_change_24h_incremental()",
  );
  const other = await pool.connect();
  try {
    await other.query("set statement_timeout='1s'");
    await other.query(
      "select enqueue_unified_change24_market('journal:concurrent')",
    );
    await db.query("commit");
    const remaining = (
      await other.query(
        "select id from unified_change24_market_journal where market_id='journal:concurrent'",
      )
    ).rows.map((r) => r.id);
    assert.equal(remaining.length, 1);
    assert.ok(!observed.includes(remaining[0]));
    await other.query(
      "select refresh_unified_market_event_change_24h_incremental()",
    );
    assert.equal(
      (
        await other.query(
          "select count(*)::int as count from unified_change24_market_journal where market_id='journal:concurrent'",
        )
      ).rows[0].count,
      0,
    );
  } finally {
    other.release();
  }
  console.log(
    "ok - concurrent same-market enqueue does not wait for the consumer and survives exact-ID ACK",
  );

  await db.query("begin");
  await db.query("select enqueue_unified_change24_market('journal:rollback')");
  await db.query("rollback");
  assert.equal(
    (
      await db.query(
        "select count(*)::int as count from unified_change24_market_journal where market_id='journal:rollback'",
      )
    ).rows[0].count,
    0,
  );
  await db.query(
    "select refresh_unified_market_event_change_24h_incremental()",
  );
  console.log("ok - empty and rolled-back producer paths execute on PG16");
  await db.query("select enqueue_unified_change24_market('journal:crash')");
  const crashingConsumer = await pool.connect();
  crashingConsumer.on("error", () => {});
  try {
    await crashingConsumer.query("begin");
    const pid = (await crashingConsumer.query("select pg_backend_pid() as pid"))
      .rows[0].pid;
    await crashingConsumer.query(
      "select refresh_unified_market_event_change_24h_incremental()",
    );
    assert.equal(
      (await db.query("select pg_terminate_backend($1) as terminated", [pid]))
        .rows[0].terminated,
      true,
    );
    await assert.rejects(crashingConsumer.query("select 1"));
  } finally {
    crashingConsumer.release(true);
  }
  assert.equal(
    (
      await db.query(
        "select count(*)::int as count from unified_change24_market_journal where market_id='journal:crash'",
      )
    ).rows[0].count,
    1,
  );
  await db.query(
    "select refresh_unified_market_event_change_24h_incremental()",
  );
  console.log(
    "ok - killed consumer connection rolls back ACK and keeps durable work",
  );

  // Sequence allocation is not commit order. Neither event nor market ACK may
  // delete an earlier, previously invisible record after it commits late.
  for (const kind of ["market", "event"]) {
    const writer = await pool.connect();
    try {
      await writer.query("begin");
      await writer.query(
        `select enqueue_unified_change24_${kind}('journal:late')`,
      );
      await db.query(
        `select enqueue_unified_change24_${kind}('journal:visible')`,
      );
      await db.query(
        "select refresh_unified_market_event_change_24h_incremental()",
      );
      await writer.query("commit");
      const column = kind === "market" ? "market_id" : "event_id";
      assert.equal(
        (
          await db.query(
            `select count(*)::int as count from unified_change24_${kind}_journal where ${column}='journal:late'`,
          )
        ).rows[0].count,
        1,
      );
      await db.query("begin");
      await db.query(
        "select refresh_unified_market_event_change_24h_incremental()",
      );
      await writer.query(
        `select enqueue_unified_change24_${kind}('journal:during')`,
      );
      await db.query("commit");
      assert.equal(
        (
          await db.query(
            `select count(*)::int as count from unified_change24_${kind}_journal where ${column}='journal:during'`,
          )
        ).rows[0].count,
        1,
      );
    } finally {
      writer.release();
    }
  }
  await db.query(
    "insert into unified_change24_market_journal(market_id) select 'journal:backlog' from generate_series(1,25001)",
  );
  const backlogStart = Date.now();
  await db.query(
    "select refresh_unified_market_event_change_24h_incremental()",
  );
  assert.equal(
    (
      await db.query(
        "select count(*)::int as count from unified_change24_market_journal where market_id='journal:backlog'",
      )
    ).rows[0].count,
    0,
  );
  console.log(
    "ok - both queues preserve late commits and concurrent changes; 25001-record backlog drained in",
    Date.now() - backlogStart,
    "ms",
  );

  await db.query("begin");
  await db.query(`insert into unified_events(id,venue,venue_event_id,title,status) values('rollback:e','limitless','rollback:e','Fixture','ACTIVE');
    insert into unified_markets(id,venue,venue_market_id,event_id,title,status,market_type,last_price) values('rollback:m','limitless','rollback:m','rollback:e','Fixture','ACTIVE','binary',0.5);
    insert into unified_market_tokens(market_id,token_id,venue,outcome_side) values('rollback:m','rollback:y','limitless','YES');
    insert into unified_token_change_24h(token_id,avg_mid_24h) values('rollback:y',0.4);
    insert into unified_token_top_latest(token_id,venue,ts,best_bid,best_ask) values('rollback:y','limitless',now(),0.5,0.5);
    create function fixture_event_cache_failure() returns trigger language plpgsql as $$begin raise exception 'fixture event cache failure';end$$;
    create trigger fixture_event_cache_failure before insert on unified_event_change_24h for each row execute function fixture_event_cache_failure()`);
  await db.query("savepoint cache_failure");
  await assert.rejects(
    db.query("select refresh_unified_market_event_change_24h_incremental()"),
    /fixture event cache failure/,
  );
  await db.query("rollback to savepoint cache_failure");
  assert.equal(
    (
      await db.query(
        "select count(*)::int as count from unified_market_change_24h where market_id='rollback:m'",
      )
    ).rows[0].count,
    0,
  );
  assert.ok(
    (
      await db.query(
        "select count(*)::int as count from unified_change24_market_journal where market_id='rollback:m'",
      )
    ).rows[0].count > 0,
  );
  await db.query(
    "drop trigger fixture_event_cache_failure on unified_event_change_24h;drop function fixture_event_cache_failure();select refresh_unified_market_event_change_24h_incremental()",
  );
  assert.equal(
    Number(
      (
        await db.query(
          "select change_24h::text as change from unified_market_change_24h where market_id='rollback:m'",
        )
      ).rows[0].change,
    ),
    0.25,
  );
  await db.query("rollback");
  console.log(
    "ok - failure between market/event stages rolls back cache writes and keeps journal work for recovery",
  );

  // Execute the actual changed top SQL, not a hand-written SELECT imitation.
  await db.query("begin");
  await db.query(
    "insert into unified_events(id,venue,venue_event_id,title,status) values('journal:top-event','limitless','journal:top-event','Fixture','ACTIVE');insert into unified_markets(id,venue,venue_market_id,event_id,title,status,market_type,last_price) values('journal:top-market','limitless','journal:top-market','journal:top-event','Fixture','ACTIVE','binary',1)",
  );
  const before = (
    await db.query(
      "select ctid from unified_markets where id='journal:top-market'",
    )
  ).rows[0].ctid;
  await writeResolvedTerminalTokenTops(db, {
    marketId: "journal:top-market",
    yesTokenId: "journal:y",
    noTokenId: "journal:n",
    resolvedOutcome: "YES",
    observedAt: new Date(),
  });
  assert.equal(
    (
      await db.query(
        "select ctid from unified_markets where id='journal:top-market'",
      )
    ).rows[0].ctid,
    before,
    "unchanged terminal market is not rewritten",
  );
  await db.query("rollback");
  const ts = new Date();
  resetUnifiedBookTopWriteStateForTests(pool);
  const make = (ids: string[], offset: number) =>
    ids.map((tokenId) => ({
      tokenId,
      ts: new Date(ts.getTime() + offset),
      bestBid: 0.4,
      bestAsk: 0.6,
    }));
  await Promise.all([
    writeUnifiedBookTops(pool, make(["journal:b", "journal:a"], 0)),
    writeUnifiedBookTops(pool, make(["journal:a", "journal:b"], 1)),
  ]);
  await writeUnifiedBookTops(pool, make(["journal:a", "journal:b"], -1000));
  assert.equal(
    (
      await db.query(
        "select ts from unified_token_top_latest where token_id='journal:a'",
      )
    ).rows[0].ts.getTime(),
    ts.getTime() + 1,
  );
  console.log(
    "ok - real bulk top SQL locks consistently and rejects older ticks",
  );
  const migration = readFileSync(
    new URL(
      "../../../packages/db/migrations/0294_change24_append_journal.sql",
      import.meta.url,
    ),
    "utf8",
  );
  assert.doesNotMatch(
    migration,
    /ON CONFLICT \((market_id|event_id)\) DO NOTHING/,
  );
} finally {
  await db.query("rollback").catch(() => {});
  db.release();
  await pool.end();
}
