import assert from "node:assert/strict";

// Explicit disposable endpoints; skip dotenv so these can never be retargeted.
process.env.HUNCH_RUNTIME_SECRETS_LOADED = "1";
process.env.DATABASE_URL =
  "postgres://postgres:embedding_test_local@127.0.0.1:55439/change24_test";
process.env.REDIS_URL = "redis://127.0.0.1:56439/1";
const { pool } = await import("./db.js");
const { redis } = await import("./redis.js");
const {
  applyLimitlessResolvedMarketTop,
  flushLimitlessResolutionPublications,
} = await import("./wsMarket.js");
try {
  assert.equal(
    (await pool.query("select current_database() as db")).rows[0].db,
    "change24_test",
  );
  await redis.connect();
  await pool.query(
    "drop trigger if exists fixture_reject_resolution on limitless_markets;drop function if exists fixture_reject_resolution()",
  );
  await pool.query(
    "delete from unified_token_top_latest where token_id in ('limitless:resolution-y','limitless:resolution-n');delete from limitless_resolution_publications where market_id='limitless:resolution-m'",
  );
  await pool.query(`begin;
    insert into unified_events(id,venue,venue_event_id,title,status) values('resolution:e','limitless','resolution:e','Fixture','ACTIVE');
    insert into unified_markets(id,venue,venue_market_id,event_id,title,status,market_type,token_yes,token_no) values('limitless:resolution-m','limitless','resolution-m','resolution:e','Fixture','ACTIVE','binary','limitless:resolution-y','limitless:resolution-n');
    insert into limitless_events(id,title,market_type,raw) values('resolution:e','Fixture','single','{}');
    insert into limitless_markets(id,event_id,title,market_type,raw) values('resolution-m','resolution:e','Fixture','binary','{}');
    commit`);
  // A source-row failure must roll back both tops and the unified market.
  await pool.query(`create function fixture_reject_resolution() returns trigger language plpgsql as $$begin raise exception 'fixture source persistence failure';end$$;
    create trigger fixture_reject_resolution before update on limitless_markets for each row execute function fixture_reject_resolution()`);
  await assert.rejects(
    applyLimitlessResolvedMarketTop({
      marketId: "resolution-m",
      winningOutcome: "YES",
      source: "ws_market_resolved",
    }),
    /fixture source persistence failure/,
  );
  assert.equal(
    (
      await pool.query(
        "select status from unified_markets where id='limitless:resolution-m'",
      )
    ).rows[0].status,
    "ACTIVE",
  );
  assert.equal(
    (
      await pool.query(
        "select count(*)::int as count from unified_token_top_latest where token_id='limitless:resolution-y'",
      )
    ).rows[0].count,
    0,
  );
  await pool.query(
    "drop trigger fixture_reject_resolution on limitless_markets;drop function fixture_reject_resolution()",
  );
  const multi = redis.multi.bind(redis);
  redis.multi = (() => {
    throw Error("fixture redis unavailable");
  }) as typeof redis.multi;
  await assert.rejects(
    applyLimitlessResolvedMarketTop({
      marketId: "resolution-m",
      winningOutcome: "YES",
      source: "ws_market_resolved",
    }),
    /fixture redis unavailable/,
  );
  assert.equal(
    (
      await pool.query(
        "select status from unified_markets where id='limitless:resolution-m'",
      )
    ).rows[0].status,
    "SETTLED",
  );
  assert.equal(
    (
      await pool.query(
        "select count(*)::int as count from limitless_resolution_publications where market_id='limitless:resolution-m'",
      )
    ).rows[0].count,
    1,
  );
  redis.multi = multi;
  assert.equal(
    await flushLimitlessResolutionPublications(),
    1,
    "periodic outbox drain needs no duplicate event",
  );
  assert.equal(
    (
      await pool.query(
        "select count(*)::int as count from limitless_resolution_publications where market_id='limitless:resolution-m'",
      )
    ).rows[0].count,
    0,
  );
  const top = await redis.get("top:limitless:resolution-y");
  assert.ok(top);
  assert.equal(JSON.parse(top).best_bid, 1);
  await applyLimitlessResolvedMarketTop({
    marketId: "resolution-m",
    winningOutcome: "YES",
    source: "http_fallback",
  });
  console.log(
    "ok - PG16 atomic terminal tops/source rows, rollback, durable Redis outage and retry without replay",
  );
} finally {
  await pool
    .query(
      "delete from unified_markets where id='limitless:resolution-m';delete from unified_events where id='resolution:e';delete from limitless_events where id='resolution:e'",
    )
    .catch(() => {});
  await pool
    .query(
      "delete from unified_token_top_latest where token_id in ('limitless:resolution-y','limitless:resolution-n');delete from limitless_resolution_publications where market_id='limitless:resolution-m'",
    )
    .catch(() => {});
  await pool.end();
  if (redis.isOpen) await redis.quit();
}
