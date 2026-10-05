import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import {
  syncUnifiedMarketTokens,
  writeUnifiedBookTop,
  resetUnifiedBookTopWriteStateForTests,
} from "./unified-repo.js";

// Explicit local target, never repository .env or an implicit production pool.
const url = process.env.INDEXER_SQL_TEST_DATABASE_URL;
const expectedDatabase = process.env.INDEXER_SQL_TEST_EXPECT_DATABASE;
assert.ok(
  url,
  "Set INDEXER_SQL_TEST_DATABASE_URL to the disposable PG16 database",
);
assert.ok(expectedDatabase, "Set INDEXER_SQL_TEST_EXPECT_DATABASE explicitly");
const target = new URL(url);
assert.ok(["localhost", "127.0.0.1"].includes(target.hostname));
assert.equal(target.pathname, `/${expectedDatabase}`);
assert.equal(target.search, "");
const schema = `indexer_tx_${randomUUID().replaceAll("-", "")}`;
const pool = new Pool({
  connectionString: url,
  max: 6,
  options: `-c search_path=${schema},public`,
});
let schemaCreated = false;

before(async () => {
  const identity = (
    await pool.query(
      "select current_database() as db,current_setting('server_version_num')::int as version",
    )
  ).rows[0];
  assert.equal(identity.db, expectedDatabase);
  assert(identity.version >= 160000 && identity.version < 170000);
  await pool.query("create extension if not exists timescaledb");
  assert.equal(
    (
      await pool.query(
        "select extversion from pg_extension where extname='timescaledb'",
      )
    ).rows[0].extversion,
    "2.14.2",
  );
  await pool.query(`create schema ${schema}`);
  schemaCreated = true;
  await pool.query(`
    create table unified_events(id text primary key);
    create table unified_markets(id text primary key,event_id text references unified_events(id),venue text,token_yes text,token_no text,clob_token_ids text);
    create table unified_market_tokens(market_id text references unified_markets(id),token_id text unique,venue text,outcome_side text,primary key(market_id,token_id));
    create table unified_token_top_latest(token_id text primary key,venue text,ts timestamptz,best_bid numeric,best_ask numeric,mid numeric,spread numeric,updated_at timestamptz default now());
    create table unified_book_top(token_id text,venue text,ts timestamptz,best_bid numeric,best_ask numeric,mid numeric,spread numeric,primary key(token_id,ts));
  `);
  await pool.query(
    "select public.create_hypertable($1::regclass,'ts',chunk_time_interval=>interval '1 day')",
    [`${schema}.unified_book_top`],
  );
  for (const minutes of [1, 60])
    await pool.query(`create materialized view book_${minutes}m with (timescaledb.continuous) as
    select token_id,public.time_bucket(interval '${minutes} minutes',ts) as bucket,avg(mid) as avg_mid
    from unified_book_top group by token_id,bucket with no data`);
});
after(async () => {
  resetUnifiedBookTopWriteStateForTests(pool);
  try {
    if (schemaCreated) {
      const identity = (
        await pool.query(
          "select current_database() as db,exists(select 1 from pg_namespace where nspname=$1) as owned_schema",
          [schema],
        )
      ).rows[0];
      assert.equal(identity.db, expectedDatabase);
      assert.equal(identity.owned_schema, true);
      await pool.query(`drop schema ${schema} cascade`);
    }
  } finally {
    await pool.end();
  }
});
async function seedMarket(id: string, venue = "polymarket") {
  await pool.query(
    "insert into unified_markets(id,venue,token_yes,token_no) values($1,$2,$3,$4)",
    [id, venue, id + ":yes", id + ":no"],
  );
}
async function mapping(id: string) {
  return (
    await pool.query(
      "select token_id,outcome_side from unified_market_tokens where market_id=$1 order by token_id",
      [id],
    )
  ).rows;
}

test("PG16: pooled query interleaving cannot split token replacement or leak a transaction into subsequent parent/quote writes", async () => {
  const id = "polymarket:interleaved";
  await seedMarket(id);
  await pool.query(
    "insert into unified_market_tokens(market_id,token_id,venue,outcome_side) values($1,'old-token','polymarket','YES')",
    [id],
  );
  const left = await pool.connect(),
    right = await pool.connect();
  let outsideQueries = 0,
    checkouts = 0;
  // Every call to Pool.query is allowed to use a different connection. These
  // are real PG backends, with a deterministic schedule instead of a lucky race.
  const interleaved = {
    query: async (sql: string, params: unknown[] = []) =>
      (outsideQueries++ % 2 ? right : left).query(sql, params),
    connect: async () => {
      checkouts++;
      return pool.connect();
    },
  } as unknown as Pool;
  try {
    await syncUnifiedMarketTokens(interleaved, [id]);
    assert.deepEqual(await mapping(id), [
      { token_id: id + ":no", outcome_side: "NO" },
      { token_id: id + ":yes", outcome_side: "YES" },
    ]);
    assert.equal(outsideQueries, 0);
    assert.equal(checkouts, 1);
    await right.query(
      "insert into unified_events(id) values('parent-after-sync')",
    );
    await pool.query(
      "insert into unified_markets(id,event_id,venue) values('child-after-sync','parent-after-sync','polymarket')",
    );
    const pids = await Promise.all(
      [left, right].map(
        async (client) =>
          (await client.query("select pg_backend_pid() as pid")).rows[0].pid,
      ),
    );
    const states = (
      await pool.query(
        "select state from pg_stat_activity where pid=any($1::int[])",
        [pids],
      )
    ).rows;
    assert(states.every((row) => row.state !== "idle in transaction"));
  } finally {
    await left.query("rollback");
    await right.query("rollback");
    left.release();
    right.release();
  }
});

test("PG16: a real token uniqueness failure restores the old mapping and a subsequent repair succeeds", async () => {
  await seedMarket("collision-owner");
  await seedMarket("collision-target");
  await syncUnifiedMarketTokens(pool, ["collision-owner", "collision-target"]);
  const before = await mapping("collision-target");
  await pool.query(
    "update unified_markets set token_yes='collision-owner:yes' where id='collision-target'",
  );
  await assert.rejects(
    syncUnifiedMarketTokens(pool, ["collision-target"]),
    (error: unknown) => (error as { code: string }).code === "23505",
  );
  assert.deepEqual(await mapping("collision-target"), before);
  await pool.query(
    "update unified_markets set token_yes='repaired-yes' where id='collision-target'",
  );
  await syncUnifiedMarketTokens(pool, ["collision-target"]);
  assert.deepEqual(await mapping("collision-target"), [
    { token_id: "collision-target:no", outcome_side: "NO" },
    { token_id: "repaired-yes", outcome_side: "YES" },
  ]);
});

test("PG16: Polymarket, Limitless and native Solana token identities and empty/duplicate batches are preserved", async () => {
  for (const venue of ["polymarket", "limitless", "kalshi"]) {
    const id = venue + ":batch";
    await seedMarket(id, venue);
    const prefix = venue === "kalshi" ? "sol:native-mint" : id;
    await pool.query(
      "update unified_markets set token_yes=$2,token_no=$3,clob_token_ids=$4 where id=$1",
      [
        id,
        prefix + ":yes",
        prefix + ":no",
        JSON.stringify([prefix + ":yes", prefix + ":no", prefix + ":other"]),
      ],
    );
    await syncUnifiedMarketTokens(pool, [id, id, "missing"]);
    assert.deepEqual(await mapping(id), [
      { token_id: prefix + ":no", outcome_side: "NO" },
      { token_id: prefix + ":other", outcome_side: null },
      { token_id: prefix + ":yes", outcome_side: "YES" },
    ]);
  }
  await syncUnifiedMarketTokens(pool, []);
  await pool.query(
    "update unified_markets set token_yes=null,token_no=null,clob_token_ids=null where id='kalshi:batch'",
  );
  await syncUnifiedMarketTokens(pool, ["kalshi:batch"]);
  assert.deepEqual(await mapping("kalshi:batch"), []);
});

test("PG16: token source stays locked until replacement commits and a competing update can then retry", async () => {
  const id = "polymarket:source-race";
  await seedMarket(id);
  const client = await pool.connect();
  const updater = await pool.connect();
  let signalLocked!: () => void, resumeReplacement!: () => void;
  const locked = new Promise<void>((resolve) => {
    signalLocked = resolve;
  });
  const resume = new Promise<void>((resolve) => {
    resumeReplacement = resolve;
  });
  const pinned = {
    connect: async () => ({
      query: async (sql: string, params?: unknown[]) => {
        if (sql.includes("delete from unified_market_tokens")) {
          signalLocked();
          await resume;
        }
        return client.query(sql, params);
      },
      release: () => {}, // Fixture owns this checkout until both probes finish.
    }),
  } as unknown as Pool;
  const replacement = syncUnifiedMarketTokens(pinned, [id]);
  try {
    await locked;
    await updater.query("set statement_timeout='100ms'");
    await assert.rejects(
      updater.query(
        "update unified_markets set token_yes='race-new-yes' where id=$1",
        [id],
      ),
      (error: unknown) => (error as { code: string }).code === "57014",
    );
    resumeReplacement();
    await replacement;
    assert.equal(
      (await mapping(id)).find((row) => row.outcome_side === "YES")?.token_id,
      id + ":yes",
    );
    await updater.query("set statement_timeout='5s'");
    await updater.query(
      "update unified_markets set token_yes='race-new-yes' where id=$1",
      [id],
    );
    await syncUnifiedMarketTokens(pool, [id]);
    assert.equal(
      (await mapping(id)).find((row) => row.outcome_side === "YES")?.token_id,
      "race-new-yes",
    );
  } finally {
    resumeReplacement();
    await replacement.catch(() => {});
    await updater.query("reset statement_timeout");
    client.release();
    updater.release();
  }
});

test("PG16: 1001 markets use two bounded transactions, release both clients, and leave no open transaction", async () => {
  const ids = Array.from(
    { length: 1001 },
    (_, index) => `batch-boundary:${index}`,
  );
  await pool.query(
    "insert into unified_markets(id,venue,token_yes,token_no) select market_id,'limitless',market_id||':yes',market_id||':no' from unnest($1::text[]) as market_ids(market_id)",
    [ids],
  );
  let checkouts = 0,
    releases = 0;
  const pids: number[] = [];
  const observed = {
    connect: async () => {
      checkouts++;
      const client = await pool.connect();
      pids.push(
        (await client.query("select pg_backend_pid() as pid")).rows[0].pid,
      );
      return {
        query: client.query.bind(client),
        release: (discard?: boolean) => {
          releases++;
          client.release(discard);
        },
      };
    },
  } as unknown as Pool;
  await syncUnifiedMarketTokens(observed, ids);
  assert.equal(checkouts, 2);
  assert.equal(releases, 2);
  assert.equal(
    Number(
      (
        await pool.query(
          "select count(*) from unified_market_tokens where market_id=any($1::text[])",
          [ids],
        )
      ).rows[0].count,
    ),
    2002,
  );
  assert.equal(
    Number(
      (
        await pool.query(
          "select count(*) from pg_stat_activity where pid=any($1::int[]) and state='idle in transaction'",
          [pids],
        )
      ).rows[0].count,
    ),
    0,
  );
});

test("a failed rollback discards the checked-out client and preserves the original write error", async () => {
  const failure = new Error("synthetic connection failure");
  const calls: string[] = [];
  let discarded: boolean | undefined;
  const broken = {
    connect: async () => ({
      query: async (sql: string) => {
        calls.push(sql.trim());
        if (sql === "begin") return { rows: [] };
        if (sql === "rollback") throw new Error("synthetic rollback failure");
        throw failure;
      },
      release: (discard: boolean) => {
        discarded = discard;
      },
    }),
  } as unknown as Pool;
  await assert.rejects(
    syncUnifiedMarketTokens(broken, ["failed-market"]),
    (error) => error === failure,
  );
  assert.equal(discarded, true);
  assert.equal(calls[0], "begin");
  assert.equal(calls.at(-1), "rollback");
});

test("PG16: a latest-top lock timeout does not poison the cache; the next tick repairs the projection", async () => {
  resetUnifiedBookTopWriteStateForTests(pool);
  const token = "polymarket:timeout",
    now = new Date();
  await writeUnifiedBookTop(pool, token, 0.4, 0.5, now);
  const blocker = await pool.connect();
  const writer = await pool.connect();
  const writerPool = { query: writer.query.bind(writer) } as unknown as Pool;
  try {
    await blocker.query("begin");
    await blocker.query(
      "update unified_token_top_latest set updated_at=now() where token_id=$1",
      [token],
    );
    await writer.query("set statement_timeout='80ms'");
    await assert.rejects(
      writeUnifiedBookTop(writerPool, token, 0.6, 0.7, new Date(+now + 1000)),
      (error: unknown) => (error as { code: string }).code === "57014",
    );
    await blocker.query("rollback");
    await writer.query("set statement_timeout='5s'");
    await writeUnifiedBookTop(
      writerPool,
      token,
      0.6,
      0.7,
      new Date(+now + 1000),
    );
    assert.equal(
      Number(
        (
          await writer.query(
            "select best_bid from unified_token_top_latest where token_id=$1",
            [token],
          )
        ).rows[0].best_bid,
      ),
      0.6,
    );
    assert.equal(
      Number(
        (
          await writer.query(
            "select count(*) from unified_book_top where token_id=$1",
            [token],
          )
        ).rows[0].count,
      ),
      2,
    );
  } finally {
    await blocker.query("rollback");
    await writer.query("reset statement_timeout");
    blocker.release();
    writer.release();
    resetUnifiedBookTopWriteStateForTests(writerPool);
  }
});

test("Timescale 2.14.2: bounded concurrent writes and both aggregate refreshes succeed with exact latest quotes", async () => {
  const now = new Date(),
    token = "polymarket:aggregate-race";
  const writer = (async () => {
    for (let i = 0; i < 30; i++)
      await writeUnifiedBookTop(
        pool,
        token,
        0.3 + i / 1000,
        0.5 + i / 1000,
        new Date(+now + i),
      );
  })();
  const refresh = (async () => {
    for (let i = 0; i < 3; i++)
      for (const minutes of [1, 60])
        await pool.query(
          "call public.refresh_continuous_aggregate($1::regclass,$2::timestamptz,$3::timestamptz)",
          [
            `${schema}.book_${minutes}m`,
            new Date(+now - 86400000),
            new Date(+now + 3600000),
          ],
        );
  })();
  await Promise.all([writer, refresh]);
  assert.equal(
    Number(
      (
        await pool.query(
          "select best_bid from unified_token_top_latest where token_id=$1",
          [token],
        )
      ).rows[0].best_bid,
    ),
    0.329,
  );
  assert.equal(
    Number(
      (
        await pool.query(
          "select count(*) from unified_book_top where token_id=$1",
          [token],
        )
      ).rows[0].count,
    ),
    30,
  );
});
