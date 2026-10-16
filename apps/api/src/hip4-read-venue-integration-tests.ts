// @requires-db
// Explicit disposable PG16 target only; synthetic public-read facts, no I/O.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createIntegrationTestPool } from "./test-database-target.js";
import {
  HIP4_TOKEN_READ_SQL,
  fetchHip4MarketsByTokenIds,
} from "./repos/hip4-token-read.js";
import { WALLET_POSITION_LATEST_VENUES_SQL } from "./services/wallet-position-approx.js";
import { mapHip4Market } from "./services/hip4-mapping.js";

const schemaName = `hip4_public_read_${randomUUID().replaceAll("-", "")}`;
const pool = await createIntegrationTestPool({
  max: 1,
  options: `-c search_path=${schemaName},public -c statement_timeout=15000`,
});
const client = await pool.connect();
let created = false;
try {
  const version = Number(
    (await client.query("show server_version_num")).rows[0].server_version_num,
  );
  assert(version >= 160000 && version < 170000);
  assert.equal(
    (
      await client.query("select to_regnamespace($1) as schema_oid", [
        schemaName,
      ])
    ).rows[0].schema_oid,
    null,
  );
  await client.query(`create schema ${schemaName}`);
  created = true;
  await client.query(`create table hip4_read_markets(market_id text primary key,environment text,outcome bigint,read_model jsonb,unique(environment,outcome));
    create table wallet_position_snapshots(wallet_id uuid,venue text,snapshot_at timestamptz,market_id text,shares numeric,metadata jsonb);
    create index idx_wallet_position_snapshots_wallet_venue_time on wallet_position_snapshots(wallet_id,venue,snapshot_at desc);
    insert into hip4_read_markets select 'unrelated:'||fixture_row.id,'mainnet',fixture_row.id,'{}' from generate_series(1000000,1100000) fixture_row(id);
    insert into wallet_position_snapshots select gen_random_uuid(),'polymarket',now(),'unrelated:'||fixture_row.id,1,'{}' from generate_series(1,100000) fixture_row(id);`);
  const captured = JSON.parse(
    readFileSync(
      new URL("./fixtures/hip4/public-reads.json", import.meta.url),
      "utf8",
    ),
  );
  const market = mapHip4Market({
    ...captured.observations[0],
    outcome: 8775,
    settlement: null,
    fetchedAt: new Date().toISOString(),
    generation: "synthetic-read",
  }).market;
  await client.query(
    "insert into hip4_read_markets values($1,'mainnet',$2,$3::jsonb),($4,'testnet',$2,'{}')",
    [
      market.marketId,
      market.outcome,
      JSON.stringify(market),
      market.marketId.replace("mainnet", "testnet"),
    ],
  );
  const nativeRows = await fetchHip4MarketsByTokenIds(client, {
    tokenIds: [market.sides[0].tokenId, market.sides[1].tokenId],
    environment: "mainnet",
  });
  assert.equal(nativeRows.length, 2);
  assert.equal(nativeRows[1].side, "NO");
  assert.deepEqual(
    await fetchHip4MarketsByTokenIds(client, {
      tokenIds: [market.sides[1].tokenId.replace("mainnet", "testnet")],
      environment: "mainnet",
    }),
    [],
  );
  const walletId = randomUUID();
  await client.query(
    "insert into wallet_position_snapshots values($1,'hyperliquid','2026-10-16T12:00:00Z',$2,7,'{\"costBasis\":\"unknown\"}'),($1,'hyperliquid','2026-10-15T12:00:00Z',$2,8,'{}'),($1,'polymarket','2026-10-16T11:00:00Z','polymarket:fixture',9,'{}')",
    [walletId, market.marketId],
  );
  const latestSql = `with candidate_venues(venue) as (${WALLET_POSITION_LATEST_VENUES_SQL}), latest_snapshots as (
    select cv.venue,latest.snapshot_at from candidate_venues cv join lateral (
      select ws.snapshot_at from wallet_position_snapshots ws where ws.wallet_id=$1::uuid and ws.venue=cv.venue
      order by ws.snapshot_at desc limit 1
    ) latest on true
  ) select * from latest_snapshots`;
  assert.equal(
    (await client.query(latestSql, [walletId])).rows
      .find((row) => row.venue === "hyperliquid")
      ?.snapshot_at.toISOString(),
    "2026-10-16T12:00:00.000Z",
  );
  await client.query("analyze hip4_read_markets");
  await client.query("analyze wallet_position_snapshots");
  await client.query("set plan_cache_mode=force_generic_plan");
  await client.query(
    `prepare native_token_read(text,bigint[]) as ${HIP4_TOKEN_READ_SQL}`,
  );
  await client.query(`prepare native_latest_snapshot(uuid) as ${latestSql}`);
  const walk = (node: Record<string, unknown>): Record<string, unknown>[] => [
    node,
    ...(Array.isArray(node.Plans)
      ? node.Plans.flatMap((value) => walk(value as Record<string, unknown>))
      : []),
  ];
  for (const statement of [
    "execute native_token_read('mainnet',array[8775]::bigint[])",
    "execute native_token_read('testnet',array[8775]::bigint[])",
    "execute native_token_read('mainnet',array[999999]::bigint[])",
    `execute native_latest_snapshot('${walletId}')`,
    `execute native_latest_snapshot('${randomUUID()}')`,
  ]) {
    const plan = (
      await client.query(`explain(analyze,buffers,format json) ${statement}`)
    ).rows[0]["QUERY PLAN"][0];
    const nodes = walk(plan.Plan);
    for (const node of nodes.filter((value) => value["Relation Name"])) {
      assert.notEqual(node["Node Type"], "Seq Scan");
      assert(
        Number(node["Actual Rows"] ?? 0) * Number(node["Actual Loops"] ?? 0) <=
          4,
      );
    }
    const buffers =
      Number(plan.Plan["Shared Hit Blocks"] ?? 0) +
      Number(plan.Plan["Shared Read Blocks"] ?? 0);
    assert(buffers <= 128);
    console.log(
      "HIP public-read PG16 plan",
      JSON.stringify({
        statement,
        executionMs: plan["Execution Time"],
        buffers,
      }),
    );
  }
  console.log("HIP public read SQL acceptance passed");
} finally {
  if (created) await client.query(`drop schema ${schemaName} cascade`);
  client.release();
  await pool.end();
}
