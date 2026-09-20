import assert from "node:assert/strict";
import { Pool } from "pg";
import {
  MARKET_REPAIR_CANDIDATES_SQL,
  parseRepairCursor,
  repairCursorKey,
  runRepairSweep,
  type RepairCursor,
} from "./lib/market-repair-sweep.js";

const rows = ["a", "b", "c", "d", "e"].map((market_id) => ({
  market_id,
  cursor_terminal_at: "2026-01-01 00:00:00.000001+00",
}));
let saved: RepairCursor | null = null;
const seen: string[] = [];
const load = async (cursor: RepairCursor | null, limit: number) =>
  rows.filter((r) => !cursor || r.market_id > cursor.marketId).slice(0, limit);
const options = {
  limit: 3,
  batchSize: 2,
  load,
  process: async (batch: typeof rows) => {
    seen.push(...batch.map((r) => r.market_id));
  },
  checkpoint: async (cursor: RepairCursor | null) => {
    saved = cursor;
  },
};
await runRepairSweep({ ...options, cursor: saved });
assert.deepEqual(seen, ["a", "b", "c"]);
assert.deepEqual(saved, {
  terminalAt: rows[0].cursor_terminal_at,
  marketId: "c",
});
await runRepairSweep({ ...options, cursor: saved });
assert.deepEqual(seen, ["a", "b", "c", "d", "e"]); // unchanged/open rows did not block the tail
assert.equal(saved, null); // wrap only on the next run, never repeat this run
assert.equal(
  parseRepairCursor(
    JSON.stringify({ terminalAt: rows[0].cursor_terminal_at, marketId: "a" }),
  )?.terminalAt,
  rows[0].cursor_terminal_at,
);
assert.throws(() => parseRepairCursor('{"terminalAt":"bad","marketId":"a"}'));
assert.equal(
  repairCursorKey(["kalshi", "polymarket"], 1),
  repairCursorKey(["polymarket", "kalshi"], 1),
);
assert.notEqual(
  repairCursorKey(["polymarket"], 1),
  repairCursorKey(["polymarket"], 90),
);
await assert.rejects(
  runRepairSweep({
    ...options,
    cursor: null,
    process: async () => {
      throw Error("commit failed");
    },
  }),
);
assert.equal(saved, null); // no checkpoint before successful processing
let dryRunWrites = 0;
const dry = await runRepairSweep({
  ...options,
  cursor: null,
  checkpoint: async () => {
    dryRunWrites += 0;
  },
});
assert.equal(dry.processed, 3);
assert.equal(dryRunWrites, 0);
assert.equal(saved, null);

await assert.rejects(
  runRepairSweep({ ...options, cursor: null, batchSize: 0 }),
);
let pages = 0;
await assert.rejects(
  runRepairSweep({
    ...options,
    cursor: null,
    limit: 5,
    process: async () => {
      if (++pages === 2) throw Error("second page failed");
    },
  }),
);
assert.deepEqual(saved, {
  terminalAt: rows[0].cursor_terminal_at,
  marketId: "b",
});
const resumed: string[] = [];
await runRepairSweep({
  ...options,
  cursor: saved,
  process: async (batch) => {
    resumed.push(...batch.map((r) => r.market_id));
  },
});
assert.deepEqual(resumed, ["c", "d", "e"]);
assert.deepEqual(saved, {
  terminalAt: rows[0].cursor_terminal_at,
  marketId: "e",
});
// Exactly hitting --limit cannot prove exhaustion until the next read.
const exhausted = await runRepairSweep({ ...options, cursor: saved });
assert.equal(exhausted.processed, 0);
assert.equal(exhausted.complete, true);
assert.equal(saved, null);

const url = process.env.MARKET_REPAIR_TEST_DATABASE_URL;
if (url) {
  const target = new URL(url);
  assert.ok(["localhost", "127.0.0.1"].includes(target.hostname));
  assert.equal(target.pathname, "/market_repair_test");
  const pool = new Pool({ connectionString: url, max: 2 });
  const client = await pool.connect();
  try {
    const version = await client.query("show server_version_num");
    assert.equal(
      Math.floor(Number(version.rows[0].server_version_num) / 10000),
      16,
    );
    await client.query("begin");
    await client.query("set local statement_timeout='5s'");
    await client.query(`
      create type pg_temp.unified_status as enum ('ACTIVE','CLOSED');
      create temp table unified_events (id text primary key,end_date timestamptz);
      create temp table unified_markets (id text primary key,venue text,venue_market_id text,slug text,event_id text,title text,status pg_temp.unified_status,close_time timestamptz,expiration_time timestamptz);
      insert into unified_events values ('event','2026-01-01 00:00:00.000003+00');
      insert into unified_markets values
        ('a','polymarket','a',null,'event','a','ACTIVE','2026-01-01 00:00:00.000001+00',null),
        ('b','polymarket','b',null,'event','b','ACTIVE','2026-01-01 00:00:00.000001+00',null),
        ('c','polymarket','c',null,'event','c','ACTIVE',null,'2026-01-01 00:00:00.000002+00'),
        ('d','polymarket','d',null,'event','d','ACTIVE',null,null),
        ('future','polymarket','future',null,'event','future','ACTIVE','2028-01-01',null),
        ('precedence','polymarket','precedence',null,'event','precedence','ACTIVE','2028-01-01','2020-01-01'),
        ('closed','polymarket','closed',null,'event','closed','CLOSED','2020-01-01',null),
        ('missing','polymarket',null,null,'event','missing','ACTIVE','2020-01-01',null),
        ('other','limitless','other',null,'event','other','ACTIVE','2020-01-01',null);
    `);
    const query = (cursor: RepairCursor | null, limit: number) =>
      client.query(MARKET_REPAIR_CANDIDATES_SQL, [
        ["polymarket"],
        "2026-09-20",
        limit,
        cursor?.terminalAt ?? null,
        cursor?.marketId ?? null,
      ]);
    const first = await query(null, 1);
    assert.deepEqual(
      first.rows.map((r) => r.market_id),
      ["a"],
    );
    const remaining = await query(
      { terminalAt: first.rows[0].cursor_terminal_at, marketId: "a" },
      10,
    );
    assert.deepEqual(
      remaining.rows.map((r) => r.market_id),
      ["b", "c", "d"],
    );
    const all = await query(null, 10);
    assert.deepEqual(
      all.rows.map((r) => r.market_id),
      ["a", "b", "c", "d"],
    );
    // Same-session transaction lock is reentrant; other sessions stay excluded.
    await client.query(
      "select pg_advisory_lock(hashtext('market_active_status_repair'))",
    );
    assert.equal(
      (
        await client.query(
          "select pg_try_advisory_xact_lock(hashtext('market_active_status_repair')) as locked",
        )
      ).rows[0].locked,
      true,
    );
    assert.equal(
      (
        await pool.query(
          "select pg_try_advisory_lock(hashtext('market_active_status_repair')) as locked",
        )
      ).rows[0].locked,
      false,
    );
    await client.query("rollback");
    assert.equal(
      (
        await pool.query(
          "select pg_try_advisory_lock(hashtext('market_active_status_repair')) as locked",
        )
      ).rows[0].locked,
      false,
    );
    await client.query(
      "select pg_advisory_unlock(hashtext('market_active_status_repair'))",
    );
    console.log(
      "PostgreSQL 16: candidate SQL, microsecond cursor, branches, precedence and run lock passed",
    );
  } finally {
    client.release(true);
    await pool.end();
  }
}
console.log(
  "Market repair sweep tests passed" +
    (url ? " (including PostgreSQL)" : " (unit only)"),
);
