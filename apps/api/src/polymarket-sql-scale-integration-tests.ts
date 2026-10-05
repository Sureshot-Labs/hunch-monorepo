// @api-integration
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fetchPolymarketAssetBindings } from "@hunch/db";
import {
  POLYMARKET_PROTOCOL_CONTRACTS as C,
  type PolymarketAssetContext,
} from "@hunch/shared";
import type { Pool } from "@hunch/infra";
import { createIntegrationTestPool } from "./test-database-target.js";
import { loadPolymarketHoldingMarkRows } from "./services/polymarket-holding-marks.js";
import { fetchMarketsByTokenIds } from "./repos/unified-read.js";
import { polymarketContextFromBinding } from "./services/polymarket-asset-context.js";

const db = await createIntegrationTestPool({
  max: 1,
  options: "-c statement_timeout=30000",
});
const client = await db.connect();
const suffix = randomUUID();
const fixtureSchema = `poly_v2_migration_${suffix.replaceAll("-", "")}`;
const eventId = `polymarket:scale-event-${suffix}`;
const marketPrefix = `polymarket:scale-${suffix}-`;
const assetBase = 100_000_000_000_000n;
try {
  await client.query("begin");
  const version = (
    await client.query(
      "select current_setting('server_version_num')::int as version",
    )
  ).rows[0]?.version;
  assert.ok(
    version >= 160000 && version < 170000,
    "parse migrations on PostgreSQL 16",
  );
  // Run the unmodified migration on representative old rows in a separate
  // transaction-local schema. Even malformed optional legacy JSON is tolerated.
  await client.query("savepoint migration_fixture");
  await client.query(`create schema ${fixtureSchema}`);
  await client.query(`set local search_path to ${fixtureSchema}, public`);
  await client.query(`create table positions (
    user_id uuid not null, wallet_address text, venue text not null, token_id text,
    side text, size numeric, legacy_payload jsonb,
    constraint positions_user_id_wallet_address_venue_token_id_key
      unique (user_id, wallet_address, venue, token_id)
  )`);
  await client.query(
    `insert into positions values
    ($1,'wallet','polymarket','17','LONG',2,'{"assetContext":"malformed"}'),
    ($1,'wallet','limitless','17','FLAT',0,'{}'),
    ($1,null,'polymarket',null,'LONG',0.000002,'null')`,
    [suffix],
  );
  await client.query(
    await readFile(
      new URL(
        "../../../packages/db/migrations/0270_polymarket_asset_bindings.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  await client.query(
    await readFile(
      new URL(
        "../../../packages/db/migrations/0271_positions_asset_ledger.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const migrated = (
    await client.query(
      "select venue, token_id, size::text, position_contract, asset_context from positions order by venue, token_id nulls last",
    )
  ).rows;
  assert.equal(migrated.length, 3);
  assert.ok(
    migrated.every(
      (row) => row.position_contract === "" && row.asset_context === null,
    ),
  );
  await client.query(
    "insert into positions(user_id,wallet_address,venue,token_id,size,position_contract) values($1,'wallet','polymarket','17',3,$2)",
    [suffix, C.positionManager.toLowerCase()],
  );
  await assert.rejects(
    () =>
      client.query(
        "insert into positions(user_id,wallet_address,venue,token_id) values($1,'wallet','polymarket','17')",
        [suffix],
      ),
    /unique constraint/,
  );
  await client.query("rollback to savepoint migration_fixture");

  await client.query(
    "insert into unified_events(id,venue,venue_event_id,title,status) values($1,'polymarket',$1,'SQL scale fixture','ACTIVE')",
    [eventId],
  );
  await client.query(
    `insert into unified_markets(id,venue,venue_market_id,event_id,title,status,market_type,outcomes,clob_token_ids,last_price)
    select $1 || fixture_row.ordinality, 'polymarket', $1 || fixture_row.ordinality, $2,
      'SQL scale fixture', 'ACTIVE', 'binary', '["Yes","No"]',
      jsonb_build_array(($3::numeric + fixture_row.ordinality * 2 - 1)::text,
        ($3::numeric + fixture_row.ordinality * 2)::text)::text, 0.5
    from generate_series(1,50000) as fixture_row(ordinality)`,
    [marketPrefix, eventId, assetBase.toString()],
  );
  await client.query(
    `insert into polymarket_asset_bindings(chain_id,position_contract,asset_id,market_id,
      protocol_version,asset_kind,condition_id,outcome_index,neg_risk,exchange_address,order_domain_version,conditional_asset_type)
    select 137,$1,($2::numeric + fixture_row.ordinality)::text,
      $3 || ((fixture_row.ordinality + 1) / 2), 'v1','ctf',
      '0x' || repeat('1',64), (fixture_row.ordinality + 1) % 2, false,$4,'2','CONDITIONAL'
    from generate_series(1,100000) as fixture_row(ordinality)`,
    [
      C.conditionalTokens.toLowerCase(),
      assetBase.toString(),
      marketPrefix,
      C.exchangeV2.toLowerCase(),
    ],
  );
  await client.query("analyze polymarket_asset_bindings");
  await client.query("analyze unified_markets");
  const tokens = [1n, 501n, 99999n].map((index) =>
    (assetBase + index).toString(),
  );
  const marks = await loadPolymarketHoldingMarkRows(
    client,
    tokens.map((tokenId) => ({ tokenId })),
  );
  assert.equal(marks.size, tokens.length);
  const contexts: PolymarketAssetContext[] = [];
  for (const tokenId of tokens) {
    const bindings = await fetchPolymarketAssetBindings(client, tokenId);
    assert.equal(bindings.length, 1);
    const binding = bindings[0];
    assert.ok(binding);
    const context = polymarketContextFromBinding(binding);
    assert.ok(context);
    contexts.push(context);
  }
  const frozenRows = await fetchMarketsByTokenIds(client as unknown as Pool, {
    tokenIds: tokens,
    venue: "polymarket",
    marketAssetContexts: contexts,
  });
  assert.equal(frozenRows.length, tokens.length);
  assert.ok(
    frozenRows.every((row) => row.asset_context?.assetId === row.token_id),
  );
  const plans: { name: string; executionMs: number; scans: string[] }[] = [];
  const explainDb = (name: string) =>
    ({
      query: async (sql: string, params: unknown[]) => {
        const explained = await client.query(
          `explain (analyze, buffers, format json) ${sql}`,
          params,
        );
        const plan = explained.rows[0]?.["QUERY PLAN"]?.[0];
        assert.ok(plan);
        const scans: string[] = [];
        const walk = (node: Record<string, unknown>) => {
          if (typeof node["Relation Name"] === "string")
            scans.push(
              `${node["Node Type"]}:${node["Relation Name"]}:${node["Actual Rows"]}`,
            );
          for (const child of (node.Plans ?? []) as Record<string, unknown>[])
            walk(child);
        };
        walk(plan.Plan);
        plans.push({ name, executionMs: plan["Execution Time"], scans });
        return { rows: [] };
      },
    }) as unknown as Pick<Pool, "query">;
  await fetchPolymarketAssetBindings(
    explainDb("binding-by-asset"),
    tokens[0] ?? "",
  );
  await fetchPolymarketAssetBindings(
    explainDb("binding-by-ledger"),
    tokens[0] ?? "",
    C.conditionalTokens,
  );
  await loadPolymarketHoldingMarkRows(
    explainDb("holding-marks-three"),
    tokens.map((tokenId) => ({ tokenId })),
  );
  await fetchMarketsByTokenIds(explainDb("frozen-metadata-three") as Pool, {
    tokenIds: tokens,
    venue: "polymarket",
    marketAssetContexts: contexts,
  });
  console.log(
    "[polymarket-sql-scale] PG16 unchanged migrations tolerate legacy rows; 100k bindings/50k markets",
    JSON.stringify(plans),
  );
} finally {
  await client.query("rollback");
  client.release();
  await db.end();
}
