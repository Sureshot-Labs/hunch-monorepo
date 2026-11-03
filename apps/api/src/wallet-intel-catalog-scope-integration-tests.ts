// @api-integration
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createIntegrationTestPool } from "./test-database-target.js";
import {
  scopeWalletIntelPolymarketTokens,
  WALLET_INTEL_MARKET_SCOPE_SQL,
  WALLET_INTEL_SCOPE_BINDINGS_SQL,
  WALLET_INTEL_SCOPE_REPAIR_SQL,
} from "./services/wallet-intel-market-scope.js";
import {
  loadWalletIntelRepairPlan,
  WALLET_INTEL_REPAIR_TARGETS_SQL,
} from "./services/wallet-intel-repair.js";
import { buildPolymarketAssetBindings } from "@hunch/db";

type PlanNode = {
  "Node Type": string;
  "Relation Name"?: string;
  "Actual Rows": number;
  "Rows Removed by Filter"?: number;
  "Rows Removed by Index Recheck"?: number;
  "Local Hit Blocks"?: number;
  Plans?: PlanNode[];
};

// Exact production statements on PG16, transaction-local tables only. The
// synthetic catalog includes 200K markets / 400K tokens / 400K bindings and
// 200K wallets. No persistent fixtures, provider calls, or catalog imports.
const pool = await createIntegrationTestPool({ max: 1 });
const client = await pool.connect();
try {
  assert.equal(
    (
      await client.query("show server_version_num")
    ).rows[0].server_version_num.slice(0, 2),
    "16",
  );
  await client.query("begin");
  await client.query(
    "set local statement_timeout='15s'; set local lock_timeout='2s'",
  );
  await client.query(`
    create temp table unified_markets(id text primary key,venue text,condition_id text,
      clob_token_ids text,outcomes text,metadata jsonb) on commit drop;
    create index on unified_markets(condition_id);
    create temp table unified_tokens(token_id text primary key,market_id text,venue text) on commit drop;
    create temp table unified_market_tokens(market_id text,token_id text,venue text,primary key(market_id,token_id)) on commit drop;
    create index on unified_market_tokens(venue,token_id);
    create temp table wallets(id uuid primary key,address text,chain text) on commit drop;
    create temp table wallet_tracking_subjects(wallet_id uuid,venue text,source text,status text,priority integer,
      last_selected_at timestamptz,last_refreshed_at timestamptz,last_refresh_attempted_at timestamptz) on commit drop;
    create index on wallet_tracking_subjects(wallet_id,venue);
  `);
  const bindingsDdl = readFileSync(
    new URL(
      "../../../packages/db/migrations/0270_polymarket_asset_bindings.sql",
      import.meta.url,
    ),
    "utf8",
  ).replace(
    "create table polymarket_asset_bindings",
    "create temp table polymarket_asset_bindings",
  );
  await client.query(bindingsDdl);
  await client.query(`
    insert into unified_markets select 'polymarket:'||fixture_row,'polymarket',
      '0x'||lpad(to_hex(fixture_row),64,'0'),json_build_array((fixture_row*2)::text,(fixture_row*2+1)::text)::text,
      '["Away","Home"]','{"version":"v1","negRisk":false}'::jsonb from generate_series(1,200000) fixture_row;
    insert into unified_tokens select (fixture_row*2+token_index)::text,'polymarket:'||fixture_row,'polymarket'
      from generate_series(1,200000) fixture_row cross join generate_series(0,1) token_index;
    insert into unified_market_tokens select market_id,token_id,venue from unified_tokens;
    insert into wallets select lpad(fixture_row::text,32,'0')::uuid,
      '0x'||lpad(to_hex(fixture_row),40,'0'),'polygon' from generate_series(1,200000) fixture_row;
    insert into wallet_tracking_subjects select id,'polymarket','whale','active',1,now()-interval '1 year',now(),now() from wallets;
  `);
  const source = (index: number) => ({
    id: `polymarket:${index}`,
    venue: "polymarket",
    condition_id: `0x${index.toString(16).padStart(64, "0")}`,
    clob_token_ids: JSON.stringify([String(index * 2), String(index * 2 + 1)]),
    outcomes: '["Away","Home"]',
    metadata: { version: "v1", negRisk: false },
  });
  // Insert the large binding fixture with the exact mutation being shipped.
  for (let page = 0; page < 200; page++) {
    const rows = Array.from({ length: 1000 }, (_, i) =>
      buildPolymarketAssetBindings(source(page * 1000 + i + 1)),
    ).flat();
    await client.query(WALLET_INTEL_SCOPE_REPAIR_SQL, [JSON.stringify(rows)]);
  }
  for (const name of [
    "unified_markets",
    "unified_tokens",
    "unified_market_tokens",
    "polymarket_asset_bindings",
    "wallets",
    "wallet_tracking_subjects",
  ])
    await client.query(`analyze pg_temp.${name}`);
  const hint = source(1).condition_id;
  const unknown = `0x${"ff".repeat(32)}`;
  const result = await scopeWalletIntelPolymarketTokens(
    client,
    [
      { tokenId: "2", conditionIds: [hint] },
      { tokenId: "3", conditionIds: [hint] },
      { tokenId: "900000", conditionIds: [unknown] },
    ],
    [],
  );
  assert.equal(result.complete, true);
  assert.deepEqual(result.tokenIds, ["2", "3"]);
  assert.equal(result.summary.skippedOutsideCatalog, 1);
  assert.equal(result.summary.repairedBindings, 0);
  await client.query(
    "delete from polymarket_asset_bindings where asset_id='3'; delete from unified_tokens where token_id='3'; delete from unified_market_tokens where token_id='3'",
  );
  const repaired = await scopeWalletIntelPolymarketTokens(
    client,
    [{ tokenId: "3", conditionIds: [hint] }],
    [],
  );
  assert.equal(repaired.summary.repairedBindings, 1);
  assert.equal(
    (
      await client.query(
        "select outcome_index from polymarket_asset_bindings where asset_id='3'",
      )
    ).rows[0].outcome_index,
    1,
  );
  const pending = await scopeWalletIntelPolymarketTokens(
    client,
    [{ tokenId: "900001", conditionIds: [hint] }],
    [],
  );
  assert.equal(
    pending.complete,
    false,
    "known condition / wrong token is not outside scope",
  );
  assert.equal(pending.summary.skippedOutsideCatalog, 0);
  assert.equal(
    (await scopeWalletIntelPolymarketTokens(client, [], ["900000"])).complete,
    false,
  );
  for (const count of [1001, 2001]) {
    let statements = 0;
    const bounded = {
      query: async (sql: string, params: unknown[]) => {
        assert.ok((params[0] as string[]).length <= 1000);
        statements++;
        return client.query(sql, params);
      },
    } as typeof client;
    const scanned = await scopeWalletIntelPolymarketTokens(
      bounded,
      Array.from({ length: count }, (_, i) => ({
        tokenId: String(2 * (i + 1)),
        conditionIds: [source(i + 1).condition_id],
      })),
      [],
    );
    assert.equal(scanned.complete, true);
    assert.equal(
      scanned.tokenIds.length,
      count,
      "all token batches are covered",
    );
    assert.equal(statements, 2 * Math.ceil(count / 1000));
  }
  const requested = [
    "00000000-0000-0000-0000-000000000001",
    "00000000-0000-0000-0000-000000200001",
  ];
  const firstRequested = requested[0];
  assert.ok(firstRequested);
  const plan = await loadWalletIntelRepairPlan(client, requested, {
    maxWallets: 50,
    enabledVenues: ["polymarket"],
    protocolAddresses: [],
  });
  assert.equal(plan.targets.length, 1);
  assert.equal(plan.targets[0]?.wallet_id, requested[0]);
  assert.equal(plan.report.excluded[0]?.reason, "unknown_wallet");
  assert.ok(
    plan.targets[0]?.priority === 1,
    "explicit repair ignores current rank, age and attempt selection backoff",
  );
  await client.query(
    "update wallet_tracking_subjects set status='disabled' where wallet_id=$1",
    [requested[0]],
  );
  assert.equal(
    (
      await loadWalletIntelRepairPlan(client, [firstRequested], {
        maxWallets: 50,
        enabledVenues: ["polymarket"],
        protocolAddresses: [],
      })
    ).report.excluded[0]?.reason,
    "inactive_tracking",
  );
  await client.query(
    "update wallet_tracking_subjects set status='active' where wallet_id=$1",
    [requested[0]],
  );

  const prepared = [
    WALLET_INTEL_MARKET_SCOPE_SQL,
    WALLET_INTEL_SCOPE_BINDINGS_SQL,
    WALLET_INTEL_REPAIR_TARGETS_SQL,
  ];
  const types = ["text[],text[],text[]", "text[]", "uuid[],text[]"];
  for (let i = 0; i < prepared.length; i++)
    await client.query(
      `prepare catalog_scope_${i}(${types[i]}) as ${prepared[i]}`,
    );
  const arrayLiteral = (values: string[]) =>
    `array[${values.map((v) => `'${v.replaceAll("'", "''")}'`).join(",")}]`;
  const timings: object[] = [];
  for (const mode of ["force_custom_plan", "force_generic_plan"]) {
    await client.query(`set local plan_cache_mode=${mode}`);
    for (const count of [0, 20, 50, 1000]) {
      const ids = Array.from({ length: count }, (_, i) => String(2 * (i + 1)));
      const hints = ids.map((_, i) => source(i + 1).condition_id);
      const walletIds = Array.from({ length: count }, (_, i) =>
        (i + 1).toString().padStart(32, "0"),
      );
      const params = [
        `${arrayLiteral(ids)}::text[],${arrayLiteral(ids)}::text[],${arrayLiteral(hints)}::text[]`,
        `${arrayLiteral(ids)}::text[]`,
        `${arrayLiteral(walletIds)}::uuid[],array[]::text[]`,
      ];
      for (let i = 0; i < prepared.length; i++) {
        const explained = (
          await client.query(
            `explain(analyze,buffers,format json) execute catalog_scope_${i}(${params[i]})`,
          )
        ).rows[0]["QUERY PLAN"][0];
        const nodes: PlanNode[] = [];
        const visit = (node: PlanNode) => {
          nodes.push(node);
          for (const child of node.Plans ?? []) visit(child);
        };
        visit(explained.Plan);
        assert.ok(
          !nodes.some(
            (n) =>
              [
                "unified_markets",
                "unified_tokens",
                "unified_market_tokens",
                "polymarket_asset_bindings",
                "wallets",
                "wallet_tracking_subjects",
              ].includes(n["Relation Name"] ?? "") &&
              n["Actual Rows"] +
                (n["Rows Removed by Filter"] ?? 0) +
                (n["Rows Removed by Index Recheck"] ?? 0) >
                10000,
          ),
          "no full catalog/history scan",
        );
        timings.push({
          mode,
          count,
          query: i,
          ms: explained["Execution Time"],
          buffers: explained.Plan["Local Hit Blocks"],
          rows: explained.Plan["Actual Rows"],
        });
      }
    }
  }
  await client.query(
    `prepare catalog_repair(jsonb) as ${WALLET_INTEL_SCOPE_REPAIR_SQL}`,
  );
  const mutations: object[] = [];
  for (const mode of ["force_custom_plan", "force_generic_plan"]) {
    await client.query(`set local plan_cache_mode=${mode}`);
    for (const count of [0, 1, 1000]) {
      const bindings = Array.from({ length: Math.ceil(count / 2) }, (_, i) =>
        buildPolymarketAssetBindings(source(i + 1)),
      )
        .flat()
        .slice(0, count);
      await client.query(
        "delete from polymarket_asset_bindings where asset_id=any($1::text[])",
        [bindings.map((row) => row.asset_id)],
      );
      for (const phase of ["new", "existing"]) {
        const explained = (
          await client.query(
            `explain(analyze,buffers,format json) execute catalog_repair('${JSON.stringify(bindings).replaceAll("'", "''")}'::jsonb)`,
          )
        ).rows[0]["QUERY PLAN"][0];
        assert.equal(
          explained.Plan["Tuples Inserted"],
          phase === "new" ? count : 0,
        );
        assert.equal(
          explained.Plan["Conflicting Tuples"],
          phase === "existing" ? count : 0,
        );
        mutations.push({
          mode,
          count,
          phase,
          ms: explained["Execution Time"],
          buffers: explained.Plan["Local Hit Blocks"],
        });
      }
    }
  }
  console.log(
    "[catalog scope PG16] exact SQL, bounded temp fixtures, custom/generic plans",
    JSON.stringify({ timings, mutations }),
  );
} finally {
  await client.query("rollback");
  client.release();
  await pool.end();
}
