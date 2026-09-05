// @requires-db
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createIntegrationTestPool } from "./test-database-target.js";

const source = readFileSync(
  new URL("./routes/market-map.ts", import.meta.url),
  "utf8",
);
const functionSource = source.split(
  "async function loadEventSignalSummaryByEventId(",
)[1];
const sql = functionSource.split("`")[1];
assert.ok(
  functionSource.includes(
    "if (!runId || eventIds.length === 0) return byEventId;",
  ),
);
const oldSql = sql.replace(
  "n.lineage ? 'map_run_id'\n        and n.lineage->>'map_run_id' = $2",
  "coalesce(n.lineage->>'map_run_id', '') = $2",
);
assert.notEqual(sql, oldSql);
const pool = await createIntegrationTestPool({ max: 1 });
const client = await pool.connect();
try {
  await client.query("begin");
  await client.query(`create temporary table ai_notes (
    id text, title text, description text, signal_type text, direction text,
    confidence numeric, created_at timestamptz, note_type text,
    producer_type text, status text, lineage jsonb
  ) on commit drop;
  create temporary table ai_note_targets (
    note_id text, target_kind text, target_id text, is_primary boolean,
    target_rank integer, target_meta jsonb
  ) on commit drop;
  create temporary table unified_markets (id text, event_id text, title text, venue text) on commit drop;
  insert into unified_markets values ('m1','e1','Market','polymarket');
  insert into ai_notes
    select n::text, 'Signal', null, 'test', 'yes', 0.7,
      '2026-01-01'::timestamptz + n * interval '1 minute',
      'signal', 'map_signals', 'active',
      case n when 4 then '{}'::jsonb when 5 then '{"map_run_id":null}'::jsonb
        when 6 then '{"map_run_id":"old"}'::jsonb
        else '{"map_run_id":"current"}'::jsonb end
    from generate_series(1,6) n;
  insert into ai_note_targets
    select n::text,'event','e1',false,1,'{}'::jsonb from generate_series(1,6) n;
  insert into ai_note_targets values ('1','market','m1',true,0,'{}');`);
  for (const runId of ["current", "old", "missing"]) {
    for (const eventIds of [[], ["e1"], ["e1", "e1", "absent"]]) {
      for (const limit of [1, 3]) {
        const params = [eventIds, runId, limit];
        assert.deepEqual(
          (await client.query(sql, params)).rows,
          (await client.query(oldSql, params)).rows,
        );
      }
    }
  }
  const rows = (await client.query(sql, [["e1"], "current", 3])).rows;
  assert.equal(rows.length, 3);
  assert.equal(Number(rows[0].signal_count), 3);
  assert.equal(rows[2].target_market_id, "m1");
  console.log(
    "ok - market-map signal SQL parity, ranking, dedup, lineage and target context",
  );
} finally {
  await client.query("rollback");
  client.release();
  await pool.end();
}
