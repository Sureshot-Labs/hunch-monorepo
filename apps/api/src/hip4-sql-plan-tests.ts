// @requires-db
import assert from "node:assert/strict";
import { createIntegrationTestPool } from "./test-database-target.js";
import {
  HIP4_CATALOG_READ_SQL,
  HIP4_EVENT_READ_SQL,
} from "./services/hip4-repository.js";
import {
  hip4TradesReadSql,
  HIP4_CANDLES_READ_SQL,
  HIP4_COVERAGE_READ_SQL,
  HIP4_OLDER_CANDLE_SQL,
} from "./services/hip4-history.js";
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
  await client.query(`insert into unified_events(id,venue,venue_event_id,title,status)
    select 'hip4-event-' || fixture_id, 'hyperliquid', 'hip4-event-' || fixture_id, 'Plan fixture', 'ACTIVE'
    from generate_series(100000,119999) fixture_id`);
  await client.query(`insert into unified_markets(id,venue,venue_market_id,event_id,title,status,market_type)
    select 'hip4-plan-' || fixture_id, 'hyperliquid', 'hip4-plan-' || fixture_id, 'hip4-event-' || fixture_id, 'Plan fixture', 'ACTIVE', 'binary'
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
  await client.query(
    "insert into unified_events(id,venue,venue_event_id,title,status) values('hip4-sparse-event','hyperliquid','hip4-sparse-event','Sparse fixture','ACTIVE')",
  );
  await client.query(
    "update unified_markets set event_id='hip4-sparse-event' where id in ('hip4-plan-119990','hip4-plan-119998','hip4-plan-119999')",
  );
  await client.query("analyze unified_markets");
  await client.query(
    `prepare hip4_event_page(text,text,bigint,bigint[],int) as ${HIP4_EVENT_READ_SQL}`,
  );
  for (const after of [-1, 119990, 119999]) {
    const result = await client.query(
      `explain(analyze,buffers,format json) execute hip4_event_page('hip4-sparse-event','mainnet',${after},NULL,2)`,
    );
    const plan = result.rows[0]["QUERY PLAN"][0];
    assert.match(JSON.stringify(plan), /idx_unified_markets_event_id/);
    type PlanNode = {
      "Relation Name"?: string;
      "Actual Loops": number;
      "Actual Rows": number;
      Plans?: PlanNode[];
    };
    const inspect = (node: PlanNode) => {
      if (node["Relation Name"] === "hip4_read_markets") {
        assert.ok(
          node["Actual Loops"] <= 3,
          "read work must scale with event members, not the catalog",
        );
        assert.ok(node["Actual Rows"] <= 1);
      }
      for (const child of node.Plans ?? []) inspect(child);
    };
    inspect(plan.Plan);
    console.log(
      JSON.stringify({
        case: `event-sparse-${after}`,
        executionMs: plan["Execution Time"],
        plan: plan.Plan,
      }),
    );
  }
  await client.query(
    `prepare hip4_catalog_page(text,bigint,int) as ${HIP4_CATALOG_READ_SQL}`,
  );
  for (const after of [-1, 110000, 999999]) {
    const result = await client.query(
      `explain(analyze,buffers,format json) execute hip4_catalog_page('mainnet',${after},21)`,
    );
    const plan = result.rows[0]["QUERY PLAN"][0];
    assert.match(JSON.stringify(plan), /Index/);
    assert.doesNotMatch(
      JSON.stringify(plan),
      /"Node Type":"(?:Incremental )?Sort"/,
    );
    console.log(
      JSON.stringify({
        case: `catalog-${after}`,
        executionMs: plan["Execution Time"],
        plan: plan.Plan,
      }),
    );
  }
  // Visible demand reuses this exact existing indexed point lookup. Check
  // both custom/generic plans against the 20k catalog, including absent IDs
  // and environments; each candidate must remain cardinality-one work.
  await client.query(`prepare hip4_visible_point(text,bigint) as
    select read_model, raw from hip4_read_markets where environment=$1 and outcome=$2`);
  for (const mode of ["force_custom_plan", "force_generic_plan"]) {
    await client.query(`set local plan_cache_mode=${mode}`);
    for (const environment of ["mainnet", "testnet"])
      for (const outcome of [100000, 110000, 119999, 999999]) {
        const result = await client.query(
          `explain(analyze,buffers,format json) execute hip4_visible_point('${environment}',${outcome})`,
        );
        const plan = result.rows[0]["QUERY PLAN"][0];
        assert.match(JSON.stringify(plan), /Index/);
        assert.ok(plan.Plan["Actual Rows"] <= 1);
        assert.ok(
          plan.Plan["Shared Hit Blocks"] + plan.Plan["Shared Read Blocks"] <=
            10,
          "visible point work must not scan the catalog",
        );
        console.log(
          JSON.stringify({
            case: `visible-point-${mode}-${environment}-${outcome}`,
            executionMs: plan["Execution Time"],
            plan: plan.Plan,
          }),
        );
      }
  }
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
  await client.query(`insert into hip4_candles(market_id,bucket_ms,open_price,high_price,low_price,close_price,volume,trade_count,first_time_ms,first_tid,last_time_ms,last_tid)
    select 'hip4-plan-100000',1790000000000+fixture_id::bigint*60000,0.5,0.6,0.4,0.5,10,1,1790000000000+fixture_id::bigint*60000,fixture_id,1790000000000+fixture_id::bigint*60000,fixture_id from generate_series(1,100000) fixture_id`);
  await client.query(`insert into hip4_observation_intervals(market_id,bucket_ms,start_ms,end_ms,kind,reason)
    select 'hip4-plan-100000',1790000000000+fixture_id::bigint*60000,1790000000000+fixture_id::bigint*60000,1790000000000+fixture_id::bigint*60000+1000,'observed','ws_partial' from generate_series(1,100000) fixture_id`);
  await client.query("analyze hip4_candles");
  await client.query("analyze hip4_observation_intervals");
  await client.query(
    `prepare hip4_trade_cursor(text,int,bigint,text,bigint) as ${hip4TradesReadSql(true)}`,
  );
  await client.query(
    `prepare hip4_trade_first(text,int) as ${hip4TradesReadSql(false)}`,
  );
  await client.query(
    `prepare hip4_candle_page(text,bigint,bigint,int) as ${HIP4_CANDLES_READ_SQL}`,
  );
  await client.query(
    `prepare hip4_coverage_page(text,bigint,bigint,int) as ${HIP4_COVERAGE_READ_SQL}`,
  );
  await client.query(
    `prepare hip4_older_candle(text,bigint) as ${HIP4_OLDER_CANDLE_SQL}`,
  );
  for (const market of ["hip4-plan-100000", "hip4-plan-100001"])
    for (const edge of [1790001000000, 1790000000000, 1796000000001]) {
      for (const [label, call] of [
        [
          "trades",
          `hip4_trade_cursor('${market}',21,${edge},'#1000000',999999)`,
        ],
        ["trades-first", `hip4_trade_first('${market}',21)`],
        [
          "candles",
          `hip4_candle_page('${market}',${edge - 86400000},${edge},121)`,
        ],
        [
          "coverage",
          `hip4_coverage_page('${market}',${edge - 86400000},${edge},121)`,
        ],
        ["older-candle", `hip4_older_candle('${market}',${edge})`],
      ]) {
        const result = await client.query(
          `explain(analyze,buffers,format json) execute ${call}`,
        );
        const plan = result.rows[0]["QUERY PLAN"][0];
        assert.match(JSON.stringify(plan), /Index/);
        assert.doesNotMatch(
          JSON.stringify(plan),
          /"Node Type":"(?:Incremental )?Sort"/,
        );
        console.log(
          JSON.stringify({
            case: `${label}-${market}-${edge}`,
            executionMs: plan["Execution Time"],
            plan: plan.Plan,
          }),
        );
      }
    }
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
  await client.query(hip4DerivedDeleteSql("hip4_candles"));
  await client.query(hip4DerivedDeleteSql("hip4_observation_intervals"));
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
