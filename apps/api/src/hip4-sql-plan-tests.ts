// @requires-db
import assert from "node:assert/strict";
import { createIntegrationTestPool } from "./test-database-target.js";
import {
  hip4DerivedDeleteSql,
  hip4DerivedReferencesSql,
} from "./services/hip4-retention.js";

const pool = await createIntegrationTestPool({ max: 1 });
const client = await pool.connect();
try {
  await client.query("begin");
  await client.query("set local statement_timeout='60s'");
  await client.query(
    "insert into unified_events(id,venue,venue_event_id,title,status) values('hip4-plan-event','hyperliquid','hip4-plan-event','Plan fixture','ACTIVE')",
  );
  await client.query(`insert into unified_markets(id,venue,venue_market_id,event_id,title,status,market_type)
    select 'hip4-plan-' || fixture_id, 'hyperliquid', 'hip4-plan-' || fixture_id, 'hip4-plan-event', 'Plan fixture', 'ACTIVE', 'binary'
    from generate_series(100000,119999) fixture_id`);
  await client.query(`insert into hip4_read_markets(market_id,environment,outcome,fetched_at,generation,read_model,raw)
    select 'hip4-plan-' || fixture_id,'mainnet',fixture_id,now(),gen_random_uuid(),'{}'::jsonb,'{}'::jsonb
    from generate_series(100000,119999) fixture_id`);
  await client.query(`insert into hip4_public_trades(environment,coin,time_ms,tid,market_id,side,price,size,transaction_hash)
    select 'mainnet','#1000000',1790000000000 + fixture_id,fixture_id,'hip4-plan-100000','B',0.5,10,'public-fixture'
    from generate_series(1,1000000) fixture_id`);
  await client.query("analyze hip4_read_markets");
  await client.query("analyze hip4_public_trades");
  await client.query("set local plan_cache_mode=force_generic_plan");
  await client.query(`prepare hip4_page(text,bigint[],bigint,int) as select read_model from hip4_read_markets
    where environment=$1 and outcome=any($2) and outcome>$3 order by outcome limit $4`);
  for (const after of [-1, 100001, 999999]) {
    const result = await client.query(
      `explain (analyze,buffers,format json) execute hip4_page('mainnet',ARRAY[100000,100001,100100,119999],${after},3)`,
    );
    const plan = result.rows[0]["QUERY PLAN"][0];
    assert.match(JSON.stringify(plan), /Index/);
    console.log(
      JSON.stringify({
        case: `generic-page-${after}`,
        executionMs: plan["Execution Time"],
        plan: plan.Plan,
      }),
    );
  }
  const tradePlan =
    await client.query(`explain (analyze,buffers,format json) select * from hip4_public_trades
    where market_id='hip4-plan-100000' and time_ms < 1790000500000 order by time_ms desc,coin,tid limit 21`);
  assert.match(
    JSON.stringify(tradePlan.rows),
    /hip4_public_trades_market_time_idx/,
  );
  console.log(
    JSON.stringify({
      case: "million-trades-resumed",
      plan: tradePlan.rows[0]["QUERY PLAN"],
    }),
  );
  await client.query(
    "create temp table candidate_pool(market_id text primary key) on commit drop",
  );
  await client.query("insert into candidate_pool values('hip4-plan-100001')");
  const derived = await client.query(
    hip4DerivedReferencesSql("candidate_pool"),
  );
  assert.equal(
    derived.rows.find((row) => row.label === "hip4_read_markets").rows,
    "1",
  );
  await client.query(
    "create temp table tmp_market_retention_removable_markets as select market_id from candidate_pool",
  );
  await client.query(hip4DerivedDeleteSql("hip4_public_trades"));
  assert.equal(
    (await client.query(hip4DerivedDeleteSql("hip4_read_markets"))).rowCount,
    1,
  );
  await client.query("deallocate hip4_page");
} finally {
  await client.query("rollback");
  client.release();
  await pool.end();
}
