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
import { fetchPositionMarketRows } from "./services/position-market-rows.js";
import { fetchPositionsForUserWallet } from "./repos/positions-repo.js";
import {
  fetchPositionShareSourceById,
  fetchTopPositionShareSource,
} from "./repos/shares.js";
import {
  fetchUnifiedOrders,
  fetchUnifiedOrderById,
} from "./repos/unified-orders.js";
import { loadAutoTrackedPreviousOpenPositions } from "./wallet-intel-refresh.js";
import { runPositionResolutionNotificationProducer } from "./services/position-resolution-producer.js";

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
  // Run the actual migration on the production legacy identity constraint in a
  // transaction-local schema. Optional malformed JSON must remain harmless.
  await client.query("savepoint migration_fixture");
  await client.query(`create schema ${fixtureSchema}`);
  await client.query(`set local search_path to ${fixtureSchema}, public`);
  await client.query(`create table positions (
    user_id uuid not null, wallet_address text, venue text not null, token_id text not null,
    side text, size numeric, legacy_payload jsonb,
    constraint positions_user_id_wallet_address_venue_token_id_key
      unique nulls not distinct (user_id, wallet_address, venue, token_id)
  )`);
  await client.query(
    `insert into positions values
    ($1,'wallet','polymarket','17','LONG',2,'{"assetContext":"malformed"}'),
    ($1,'wallet','limitless','17','FLAT',0,'{}'),
    ($1,null,'polymarket','18','LONG',0.000002,'null')`,
    [suffix],
  );
  const nullWalletUpsert = `insert into positions(user_id,wallet_address,venue,token_id,size)
    values($1,null,'polymarket','18',$2)
    on conflict on constraint positions_user_id_wallet_address_venue_token_id_key
    do update set size = excluded.size`;
  await client.query(nullWalletUpsert, [suffix, 4]);
  assert.equal(
    (
      await client.query(
        "select count(*)::int as row_count from positions where user_id=$1 and wallet_address is null and venue='polymarket' and token_id='18'",
        [suffix],
      )
    ).rows[0].row_count,
    1,
    "the real pre-migration NULL-wallet key is idempotent",
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
  const migratedConstraint = await client.query<{
    indnullsnotdistinct: boolean;
  }>(
    `select index_row.indnullsnotdistinct
     from pg_constraint constraint_row
     join pg_index index_row on index_row.indexrelid = constraint_row.conindid
     where constraint_row.conrelid = 'positions'::regclass
       and constraint_row.conname = 'positions_user_id_wallet_address_venue_token_id_key'`,
  );
  assert.equal(migratedConstraint.rows[0]?.indnullsnotdistinct, true);
  await client.query(nullWalletUpsert, [suffix, 5]);
  await client.query(nullWalletUpsert, [suffix, 6]);
  assert.deepEqual(
    (
      await client.query(
        "select position_contract, count(*)::int as row_count, sum(size)::text as shares from positions where user_id=$1 and wallet_address is null and venue='polymarket' and token_id='18' group by position_contract order by position_contract",
        [suffix],
      )
    ).rows,
    [{ position_contract: "", row_count: 1, shares: "6" }],
    "post-migration legacy upserts update, never duplicate or inflate the holding",
  );
  const pmNullWalletUpsert = `insert into positions(user_id,wallet_address,venue,token_id,size,position_contract)
    values($1,null,'polymarket','18',$2,$3)
    on conflict on constraint positions_user_id_wallet_address_venue_token_id_key
    do update set size = excluded.size`;
  await client.query(pmNullWalletUpsert, [
    suffix,
    3,
    C.positionManager.toLowerCase(),
  ]);
  await client.query(pmNullWalletUpsert, [
    suffix,
    7,
    C.positionManager.toLowerCase(),
  ]);
  assert.deepEqual(
    (
      await client.query(
        "select position_contract, count(*)::int as row_count, sum(size)::text as shares from positions where user_id=$1 and wallet_address is null and venue='polymarket' and token_id='18' group by position_contract order by position_contract",
        [suffix],
      )
    ).rows,
    [
      { position_contract: "", row_count: 1, shares: "6" },
      {
        position_contract: C.positionManager.toLowerCase(),
        row_count: 1,
        shares: "7",
      },
    ],
    "NULL-wallet deduplication remains independent for colliding CTF and PM identities",
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
  await client.query("insert into users(id,email) values($1,$2)", [
    suffix,
    `sql-scale-${suffix}@example.com`,
  ]);
  await client.query(
    `insert into positions(user_id,wallet_address,venue,token_id,side,size)
    select $1,'scale-wallet','polymarket',($2::numeric + fixture_row.ordinality)::text,'LONG',2
    from generate_series(1,1000) as fixture_row(ordinality)`,
    [suffix, assetBase.toString()],
  );
  await client.query("analyze positions");
  const unrelatedUserId = randomUUID();
  await client.query("insert into users(id,email) values($1,$2)", [
    unrelatedUserId,
    `sql-scale-background-${suffix}@example.com`,
  ]);
  await client.query(
    `insert into orders(user_id,wallet_address,venue,venue_order_id,token_id,side,order_type,price,size,status)
    select case when fixture_row.ordinality <= 1000 then $1::uuid else $4::uuid end,'scale-wallet','polymarket',$3 || fixture_row.ordinality,($2::numeric + fixture_row.ordinality)::text,'SELL','GTC',0.5,1,'live'
    from generate_series(1,100000) as fixture_row(ordinality)`,
    [suffix, assetBase.toString(), `scale-order-${suffix}-`, unrelatedUserId],
  );
  await client.query("analyze orders");
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
  const plans: {
    name: string;
    executionMs: number;
    bufferHits: number;
    bufferReads: number;
    scans: string[];
  }[] = [];
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
              `${node["Node Type"]}:${node["Relation Name"]}:${node["Actual Rows"]}x${node["Actual Loops"]}`,
            );
          for (const child of (node.Plans ?? []) as Record<string, unknown>[])
            walk(child);
        };
        walk(plan.Plan);
        plans.push({
          name,
          executionMs: plan["Execution Time"],
          bufferHits: plan.Plan["Shared Hit Blocks"],
          bufferReads: plan.Plan["Shared Read Blocks"],
          scans,
        });
        return client.query(sql, params);
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
  const positionInputs = {
    userId: suffix,
    walletAddresses: ["scale-wallet"],
    venue: "polymarket",
    minSize: 0,
  };
  const filteredPositions = await fetchPositionsForUserWallet(
    explainDb("position-market-filter") as Pool,
    {
      ...positionInputs,
      marketId: `${marketPrefix}1`,
    },
  );
  assert.equal(filteredPositions.length, 2);
  const sharePositionId = filteredPositions[0]?.id;
  assert.ok(sharePositionId);
  assert.ok(
    await fetchPositionShareSourceById(explainDb("share-by-position"), {
      userId: suffix,
      positionId: sharePositionId,
      walletAddresses: ["scale-wallet"],
      venue: "polymarket",
    }),
  );
  assert.ok(
    await fetchTopPositionShareSource(explainDb("share-top-position") as Pool, {
      userId: suffix,
      walletAddresses: ["scale-wallet"],
      venue: "polymarket",
    }),
  );
  const orderInputs = {
    userId: suffix,
    type: "order" as const,
    venue: "polymarket",
    marketId: `${marketPrefix}1`,
    limit: 10,
    offset: 0,
  };
  const filteredOrders = await fetchUnifiedOrders(
    explainDb("orders-durable-market") as Pool,
    orderInputs,
  );
  assert.equal(filteredOrders.rows.length, 2);
  assert.equal(filteredOrders.total, 2);
  const firstOrderId = filteredOrders.rows[0]?.id;
  assert.ok(firstOrderId);
  assert.ok(
    await fetchUnifiedOrderById(explainDb("order-by-id") as Pool, {
      ...orderInputs,
      id: firstOrderId,
    }),
  );
  const firstPage = await fetchUnifiedOrders(
    explainDb("orders-first-page") as Pool,
    { ...orderInputs, marketId: undefined },
  );
  assert.equal(firstPage.rows.length, 10);
  const resumedPage = await fetchUnifiedOrders(
    explainDb("orders-resumed-page") as Pool,
    { ...orderInputs, marketId: undefined, offset: 100 },
  );
  assert.equal(resumedPage.rows.length, 10);
  assert.equal(
    (
      await fetchUnifiedOrders(explainDb("orders-empty-tail") as Pool, {
        ...orderInputs,
        offset: 2,
      })
    ).rows.length,
    0,
  );
  await fetchPositionsForUserWallet(
    explainDb("position-event-filter") as Pool,
    {
      ...positionInputs,
      eventId,
    },
  );
  const absentPositions = await fetchPositionsForUserWallet(
    explainDb("position-empty-filter") as Pool,
    {
      ...positionInputs,
      marketId: "polymarket:missing-scale-market",
    },
  );
  assert.equal(absentPositions.length, 0);
  const legacyMetadata = await fetchPositionMarketRows(
    explainDb("legacy-position-metadata") as Pool,
    filteredPositions,
    { venue: "polymarket", includeTop: false },
  );
  assert.equal(legacyMetadata.length, 2);
  await client.query(
    "insert into wallets(id,address,chain) values($1,$2,'polygon')",
    [suffix, `scale-${suffix}`],
  );
  await client.query(
    `insert into wallet_position_exposure(wallet_id,as_of,open_positions_version,open_positions)
    values($1,now(),1,$2::jsonb)`,
    [
      suffix,
      JSON.stringify([
        {
          venue: "polymarket",
          marketId: `${marketPrefix}1`,
          outcomeSide: "YES",
          price: "0.5",
        },
      ]),
    ],
  );
  const previous = await loadAutoTrackedPreviousOpenPositions(
    explainDb("previous-open-assets"),
    {
      wallets: [
        {
          wallet_id: suffix,
          address: `scale-${suffix}`,
          chain: "polygon",
          venue: "polymarket",
          sources: [],
          priority: 1,
        },
      ],
    },
  );
  assert.equal(previous.length, 1);
  assert.equal(previous[0]?.token_id, (assetBase + 1n).toString());
  await client.query(
    "update unified_markets set resolved_outcome='YES' where id=any($1::text[])",
    [Array.from({ length: 10 }, (_, index) => `${marketPrefix}${index + 1}`)],
  );
  const producer = await runPositionResolutionNotificationProducer({
    pool: {
      connect: async () => ({
        query: (sql: string, params: unknown[]) =>
          sql.includes("resolved_asset")
            ? explainDb("resolution-producer").query(sql, params)
            : client.query(sql, params),
        release: () => undefined,
      }),
    } as unknown as Pool,
    resolvePolicy: async () => ({
      effectiveAt: new Date(0).toISOString(),
      invalidOverride: false,
      source: "db",
      policy: {
        version: 1,
        positionResolutionProducerEnabled: true,
        activityEnqueueEnabled: false,
        positionSignalEnqueueEnabled: false,
        interestSignalEnqueueEnabled: false,
        deliveryEnabled: false,
      },
    }),
    createNotification: async () => null,
  });
  assert.equal(producer.candidates, 20);
  assert.equal(producer.notificationsCreated, 0);
  console.log(
    "[polymarket-sql-scale] PG16 actual migrations tolerate legacy rows; 100k bindings/50k markets/1k holdings/100k orders",
    JSON.stringify(plans),
  );
} finally {
  await client.query("rollback");
  client.release();
  await db.end();
}
