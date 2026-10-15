// @requires-db — explicit disposable PG16 target, all fixtures roll back.
import assert from "node:assert/strict";
import { createIntegrationTestPool } from "./test-database-target.js";
import { readHip4TradingPolicy } from "./repos/hip4-trading-policy.js";

const pool = await createIntegrationTestPool({
  max: 1,
  options: "-c statement_timeout=10000",
});
const db = await pool.connect();
try {
  await db.query("begin");
  assert.match(
    (await db.query("show server_version")).rows[0].server_version,
    /^16\./u,
  );
  // The strict financial reader must not treat a missing schema as no override.
  await db.query("savepoint absent_policy_table");
  await db.query("set local search_path=pg_temp");
  await assert.rejects(
    readHip4TradingPolicy(db),
    /trading_policy_unavailable/u,
  );
  await db.query("rollback to savepoint absent_policy_table");
  // Same schema/index as production, no global runtime-policy fixtures retained.
  await db.query(
    "create temporary table runtime_policies (like public.runtime_policies including all) on commit drop",
  );
  const defaults = await readHip4TradingPolicy(db);
  assert.equal(defaults.minimumBuyNotionalUsd, "1.00");
  await db.query(`insert into runtime_policies(policy_key,effective_at,payload)
    select 'unrelated-policy',now()-n*interval '1 minute','{}'::jsonb from generate_series(1,50000) fixture_row(n)`);
  await db.query(`insert into runtime_policies(policy_key,effective_at,payload)
    select 'hip4_trading',now()-n*interval '1 minute','{"minimumBuyNotionalUsd":"2"}'::jsonb from generate_series(1,5000) fixture_row(n)`);
  await db.query("analyze runtime_policies");
  assert.equal((await readHip4TradingPolicy(db)).minimumBuyNotionalUsd, "2");
  // Capture the ACTUAL shared query, not a manually rewritten approximation.
  let sql = "";
  const capture = {
    query: async (statement: string) => {
      sql = statement;
      return { rows: [] };
    },
  } as unknown as Parameters<typeof readHip4TradingPolicy>[0];
  await readHip4TradingPolicy(capture);
  await db.query(`prepare hip4_policy_lookup(text,timestamptz) as ${sql}`);
  for (const planMode of ["force_generic_plan", "force_custom_plan"]) {
    await db.query(`set local plan_cache_mode=${planMode}`);
    for (const key of ["hip4_trading", "missing-policy"]) {
      const plan = (
        await db.query(
          `explain(analyze,buffers,format json) execute hip4_policy_lookup('${key}',now())`,
        )
      ).rows[0]["QUERY PLAN"][0];
      const nodes: Record<string, unknown>[] = [];
      const walk = (node: Record<string, unknown>) => {
        nodes.push(node);
        for (const child of (node.Plans ?? []) as Record<string, unknown>[])
          walk(child);
      };
      walk(plan.Plan);
      assert.ok(
        nodes.some((node) => String(node["Node Type"]).includes("Index")),
      );
      assert.ok(!nodes.some((node) => node["Node Type"] === "Seq Scan"));
      assert.ok(
        nodes.reduce(
          (sum, node) => sum + Number(node["Rows Removed by Filter"] ?? 0),
          0,
        ) <= 1,
      );
      console.log(
        "[hip4-trading-policy-plan]",
        JSON.stringify({
          planMode,
          key,
          ms: plan["Execution Time"],
          blocks: plan.Plan["Local Hit Blocks"],
        }),
      );
    }
  }
  console.log(
    "[hip4-trading-policy] strict missing-schema and 55k-row current-policy indexed lookup passed",
  );
} finally {
  await db.query("rollback");
  db.release();
  await pool.end();
}
