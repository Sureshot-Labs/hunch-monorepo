// @requires-db -- local representative-scale SELECT plans, never production DML.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
const pool = new Pool({
  connectionString:
    "postgres://postgres:embedding_test_local@127.0.0.1:55439/change24_test",
  max: 1,
});
const db = await pool.connect();
function calculation(file: string) {
  const text = readFileSync(
    new URL("../../../packages/db/migrations/" + file, import.meta.url),
    "utf8",
  );
  const start = text.indexOf("    WITH candidate_market_ids AS MATERIALIZED (");
  const end = text.indexOf("    deleted_market_cache AS (", start);
  assert.ok(start > 0 && end > start);
  const sql =
    text.slice(start, end).trim().replace(/,\s*$/, "") +
    " SELECT * FROM calculated_changes";
  assert.doesNotMatch(sql, /\b(insert|delete|update|call|perform)\b/i);
  return sql
    .replaceAll("v_market_ids", "$1::text[]")
    .replaceAll("v_scan_until", "$2::timestamptz");
}
try {
  assert.equal(
    (await db.query("select current_database() as db")).rows[0].db,
    "change24_test",
  );
  await db.query("begin;set local statement_timeout='120s';set local jit=off");
  await db.query(`insert into unified_events(id,venue,venue_event_id,title,status) values('plans:e','limitless','plans:e','Fixture','ACTIVE');
    insert into unified_markets(id,venue,venue_market_id,event_id,title,status,market_type)
    select 'plans:m'||n,'limitless','plans:m'||n,'plans:e','Fixture','ACTIVE','binary' from generate_series(1,102001) n;
    insert into unified_market_tokens(market_id,token_id,venue,outcome_side)
    select 'plans:m'||n,'plans:t'||n||side_row,'limitless',side_row from generate_series(1,2001) n cross join unnest(array['YES','NO']) side_row;
    insert into unified_token_change_24h(token_id,avg_mid_24h) select token_id,case outcome_side when 'YES' then 0.4 else 0.6 end from unified_market_tokens where market_id like 'plans:%';
    insert into unified_token_top_latest(token_id,venue,ts,best_bid,best_ask) select token_id,'limitless',now(),0.5,0.5 from unified_market_tokens where market_id like 'plans:%';
    analyze unified_markets;analyze unified_market_tokens;analyze unified_token_top_latest;analyze unified_token_change_24h;
    set local statement_timeout='15s';set local lock_timeout='2s';`);
  await db.query(`insert into unified_market_tokens(market_id,token_id,venue,outcome_side,updated_at)
    values('plans:m1','plans:t1YES-new','limitless','YES',now()+interval '1 minute'),
          ('plans:m2','plans:t2NO-null','limitless','NO',null),
          ('plans:m3','plans:t3YES-tie','limitless','YES',now());
    insert into unified_token_change_24h(token_id,avg_mid_24h)
    values('plans:t1YES-new',0.4),('plans:t2NO-null',0.6),('plans:t3YES-tie',0.4);
    insert into unified_token_top_latest(token_id,venue,ts,best_bid,best_ask)
    values('plans:t1YES-new','limitless',now(),0.5,0.5),('plans:t2NO-null','limitless',now(),0.5,0.5),('plans:t3YES-tie','limitless',now(),0.5,0.5);`);
  const original = calculation("0241_incremental_market_event_change_24h.sql");
  const bounded = calculation("0295_change24_quote_journal.sql");
  const cutoff = new Date().toISOString();
  const ids = Array.from({ length: 1000 }, (_, n) => "plans:m" + (n + 1));
  for (const input of [
    [],
    ["missing:fixture"],
    ["plans:m1", "plans:m1", "plans:m2", "plans:m3"],
    ids,
  ]) {
    const before = (await db.query(original, [input, cutoff])).rows.sort(
      (a, b) => a.market_id.localeCompare(b.market_id),
    );
    const after = (await db.query(bounded, [input, cutoff])).rows.sort((a, b) =>
      a.market_id.localeCompare(b.market_id),
    );
    assert.deepEqual(after, before);
  }
  await db.query("prepare bounded_change24(text[],timestamptz) as " + bounded);
  for (const mode of ["force_custom_plan", "force_generic_plan"]) {
    await db.query("set local plan_cache_mode=" + mode);
    // IDs below are generated fixture literals, not arbitrary SQL input.
    const result = await db.query(
      `explain(analyze,buffers,format json) execute bounded_change24('{${ids.join(",")}}','${cutoff}')`,
    );
    const plan = result.rows[0]["QUERY PLAN"][0];
    const scans: unknown[] = [];
    const visit = (node: Record<string, unknown>) => {
      if (node["Relation Name"])
        scans.push({
          relation: node["Relation Name"],
          type: node["Node Type"],
          index: node["Index Name"],
          rows: node["Actual Rows"],
          loops: node["Actual Loops"],
        });
      for (const child of (node.Plans ?? []) as Record<string, unknown>[])
        visit(child);
    };
    visit(plan.Plan);
    assert.equal(plan.Plan["Actual Rows"], 1000);
    console.log(
      JSON.stringify({
        mode,
        fixtureMarkets: 102001,
        resultRows: 1000,
        ms: plan["Execution Time"],
        read: plan.Plan["Shared Read Blocks"],
        hit: plan.Plan["Shared Hit Blocks"],
        temp: plan.Plan["Temp Written Blocks"],
        scans,
      }),
    );
  }
} finally {
  await db.query("rollback");
  db.release();
  await pool.end();
}
