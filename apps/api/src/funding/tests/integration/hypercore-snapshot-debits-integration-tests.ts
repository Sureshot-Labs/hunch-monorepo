// @requires-db — temp tables only, rolled back on the explicit disposable PG16.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createIntegrationTestPool } from "../../../test-database-target.js";
import { verifyHypercorePreparationAvailabilityPg } from "../hypercore-preparation-availability-pg.js";
import { verifyMergedSnapshotDebitsPg } from "../merged-snapshot-debits-pg.js";
import {
  FUNDING_NATIVE_SNAPSHOT_DEBITS_SQL,
  FUNDING_EVM_SNAPSHOT_DEBITS_SQL,
} from "../../../account-value/funding-movement-feed.js";

const pool = await createIntegrationTestPool({
  max: 1,
  options: "-c statement_timeout=20000",
});
const client = await pool.connect();
const owner = `0x${"ab".repeat(20)}`;
const asset = "0x6d1e7cde53ba9467b783cb7c530ce054";
const snapshot = (
  time = "2026-10-14T16:00:10Z",
  address = owner,
  component: string | null = "native-spot",
) =>
  JSON.stringify([
    {
      component_id: component,
      location_id: "spot-location",
      address,
      asset_decimals: 8,
      snapshot_at: time,
    },
  ]);
try {
  await client.query("begin");
  assert.equal(
    (
      await client.query("show server_version_num")
    ).rows[0].server_version_num.slice(0, 2),
    "16",
  );
  // Shadow only these relations in this session. Production constraints
  // are separately exercised by the common native commit/receipt integration.
  await client.query(`
    create temp table funding_operations(id uuid primary key, user_id uuid not null, status text, source_snapshot jsonb);
    create temp table funding_operation_segments(id uuid primary key, operation_id uuid, source_snapshot jsonb);
    create temp table balance_reservations(operation_id uuid, user_id uuid, segment_id uuid, component_id text, location_id text, network_id text, asset_id text, mode text, asset_decimals integer);
    create index test_native_reservation_operation on balance_reservations(operation_id, component_id, mode);
    create temp table funding_observations(id bigint, operation_id uuid, segment_id uuid, network_id text, asset_id text, from_address text, raw_amount text, observed_at timestamptz, finalized_at timestamptz, kind text, canonical boolean, finality_status text, asset_decimals integer default 8);
  `);
  const migration = readFileSync(
    new URL(
      "../../../../../../packages/db/migrations/0290_hypercore_source_snapshot_debits.sql",
      import.meta.url,
    ),
    "utf8",
  );
  // CONCURRENTLY cannot run in a rollback test; same columns/predicate/index.
  await client.query(migration.replace("concurrently if not exists", ""));
  const evmMigration = readFileSync(
    new URL(
      "../../../../../../packages/db/migrations/0292_funding_evm_source_snapshot_debits.sql",
      import.meta.url,
    ),
    "utf8",
  );
  await client.query(evmMigration.replace("concurrently if not exists", ""));
  const user = "00000000-0000-4000-8000-000000000001";
  const op = "00000000-0000-4000-8000-000000000002";
  await client.query(
    "insert into funding_operations(id,user_id,status) values($1,$2,'completed')",
    [op, user],
  );
  await client.query(
    `insert into balance_reservations values($1,$2,null,'native-spot','spot-location','hyperliquid:mainnet',$3,'subtract_available',8)`,
    [op, user, asset],
  );
  // Two copies of an alias must not fan out monetary facts.
  await client.query(
    "insert into balance_reservations select * from balance_reservations",
  );
  await client.query(
    `insert into funding_observations values
    (1,$1,null,'hyperliquid:mainnet',$2,$3,'300000000','2026-10-14T16:00:05Z','2026-10-14T16:00:05Z','source_debit',true,'finalized'),
    (2,$1,null,'hyperliquid:mainnet',$2,$3,'500000000','2026-10-14T16:00:20Z','2026-10-14T16:00:20Z','source_debit',true,'finalized'),
    (3,$1,null,'evm:8453',$2,$3,'5000000','2026-10-14T16:00:21Z','2026-10-14T16:00:21Z','destination_credit',true,'finalized'),
    (4,$1,null,'hyperliquid:mainnet',$2,$3,'500000000','2026-10-14T16:00:22Z','2026-10-14T16:00:22Z','refund_credit',true,'finalized'),
    (5,$1,null,'hyperliquid:mainnet',$2,$3,'900000000','2026-10-14T16:00:23Z',null,'source_debit',false,'reorged')`,
    [op, asset, owner.toUpperCase().replace("0X", "0x")],
  );
  let rows = (
    await client.query(FUNDING_NATIVE_SNAPSHOT_DEBITS_SQL, [user, snapshot()])
  ).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].raw_amount, "500000000");
  // A finalized debit behind another component alias still consumes this
  // physical source after its reservation was released. EXISTS avoids fanout.
  await client.query(
    "update balance_reservations set component_id='other-native-alias'",
  );
  assert.equal(
    (await client.query(FUNDING_NATIVE_SNAPSHOT_DEBITS_SQL, [user, snapshot()]))
      .rowCount,
    0,
  );
  const physicalRows = (
    await client.query(FUNDING_NATIVE_SNAPSHOT_DEBITS_SQL, [
      user,
      snapshot(undefined, owner, null),
    ])
  ).rows;
  assert.equal(physicalRows.length, 1);
  assert.equal(physicalRows[0].raw_amount, "500000000");
  await client.query(
    "update balance_reservations set component_id='native-spot'",
  );
  await client.query(
    "update funding_observations set asset_decimals=6 where id=2",
  );
  assert.equal(
    (await client.query(FUNDING_NATIVE_SNAPSHOT_DEBITS_SQL, [user, snapshot()]))
      .rowCount,
    0,
  );
  await client.query(
    "update funding_observations set asset_decimals=8 where id=2",
  );
  const mismatchedPrecision = JSON.parse(snapshot());
  mismatchedPrecision[0].asset_decimals = 6;
  assert.equal(
    (
      await client.query(FUNDING_NATIVE_SNAPSHOT_DEBITS_SQL, [
        user,
        JSON.stringify(mismatchedPrecision),
      ])
    ).rowCount,
    0,
  );
  assert.equal(rows[0].observed_at.toISOString(), "2026-10-14T16:00:20.000Z");
  await client.query(
    "update balance_reservations set asset_id=upper(asset_id) where network_id='hyperliquid:mainnet'",
  );
  assert.equal(
    (await client.query(FUNDING_NATIVE_SNAPSHOT_DEBITS_SQL, [user, snapshot()]))
      .rowCount,
    0,
    "native legacy reservation token identity remains exact, not EVM case folding",
  );
  await client.query(
    "update balance_reservations set asset_id=$1 where network_id='hyperliquid:mainnet'",
    [asset],
  );
  rows = (
    await client.query(FUNDING_NATIVE_SNAPSHOT_DEBITS_SQL, [
      user,
      snapshot("2026-10-14T16:00:00Z"),
    ])
  ).rows;
  assert.deepEqual(rows.map((row) => row.raw_amount).sort(), [
    "300000000",
    "500000000",
  ]);
  assert.equal(
    (
      await client.query(FUNDING_NATIVE_SNAPSHOT_DEBITS_SQL, [
        user,
        snapshot("2026-10-14T16:00:25Z"),
      ])
    ).rowCount,
    0,
  );
  assert.equal(
    (await client.query(FUNDING_NATIVE_SNAPSHOT_DEBITS_SQL, [op, snapshot()]))
      .rowCount,
    0,
  );
  assert.equal(
    (
      await client.query(FUNDING_NATIVE_SNAPSHOT_DEBITS_SQL, [
        user,
        snapshot(undefined, `0x${"cc".repeat(20)}`),
      ])
    ).rowCount,
    0,
  );
  assert.equal(
    (await client.query(FUNDING_NATIVE_SNAPSHOT_DEBITS_SQL, [user, "[]"]))
      .rowCount,
    0,
  );
  const baseAsset = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
  const evmSnapshot = (time = "2026-10-14T16:00:10Z", address = owner) =>
    JSON.stringify([
      {
        component_id: "base-cash",
        location_id: "base-location",
        address,
        network_id: "evm:8453",
        asset_id: baseAsset,
        asset_decimals: 6,
        snapshot_at: time,
      },
    ]);
  await client.query(
    `insert into balance_reservations values($1,$2,null,'base-cash','base-location','evm:8453',$3,'subtract_available',6)`,
    [op, user, baseAsset.toUpperCase()],
  );
  await client.query(
    `insert into balance_reservations select * from balance_reservations where component_id='base-cash'`,
  );
  await client.query(
    `insert into funding_observations values
    (6,$1,null,'evm:8453',$2,$3,'3000000','2026-10-14T16:00:05Z','2026-10-14T16:00:05Z','source_debit',true,'finalized',6),
    (7,$1,null,'evm:8453',$2,$3,'5000000','2026-10-14T16:00:20Z','2026-10-14T16:00:20Z','source_debit',true,'finalized',6),
    (8,$1,null,'evm:8453',$2,$3,'4000000','2026-10-14T16:00:22Z','2026-10-14T16:00:22Z','refund_credit',true,'finalized',6),
    (9,$1,null,'evm:8453',$2,$3,'9000000','2026-10-14T16:00:23Z',null,'source_debit',false,'reorged',6)`,
    [op, baseAsset.toUpperCase(), owner.toUpperCase()],
  );
  const evmRead = async (input = evmSnapshot(), account = user) =>
    (await client.query(FUNDING_EVM_SNAPSHOT_DEBITS_SQL, [account, input]))
      .rows;
  assert.deepEqual(
    (await evmRead()).map((row) => row.raw_amount),
    ["5000000"],
    "full terminal debit, no duplicate reservation fanout or partial refund netting",
  );
  assert.equal((await evmRead(evmSnapshot("2026-10-14T16:00:25Z"))).length, 0);
  assert.equal(
    (await evmRead(evmSnapshot(undefined, `0x${"cc".repeat(20)}`))).length,
    0,
  );
  assert.equal((await evmRead(evmSnapshot(), op)).length, 0);
  assert.equal((await evmRead("[]")).length, 0);
  for (const patch of [
    { asset_decimals: 8 },
    { asset_id: asset },
    { location_id: "wrong" },
    { component_id: "wrong" },
    { network_id: "evm:137" },
  ]) {
    assert.equal(
      (
        await evmRead(
          JSON.stringify([{ ...JSON.parse(evmSnapshot())[0], ...patch }]),
        )
      ).length,
      0,
    );
  }
  // Same owner's old history and other owners' recent activity must not be
  // scanned just because a snapshot query returns one row.
  await client.query(
    `insert into funding_observations
    select seq+10,$1,null,'hyperliquid:mainnet',$2,
      case when seq<=100000 then $3 else '0x'||lpad(to_hex(seq),40,'0') end,
      '1',case when seq<=100000 then '2025-01-01T00:00:00Z'::timestamptz else '2026-10-14T16:00:20Z'::timestamptz end,
      case when seq<=100000 then '2025-01-01T00:00:00Z'::timestamptz else '2026-10-14T16:00:20Z'::timestamptz end,
      'source_debit',true,'finalized'
    from generate_series(1,200000) as data_rows(seq)`,
    [op, asset, owner],
  );
  await client.query(
    `insert into funding_observations
    select seq+200010,$1,null,'evm:8453',$2,
      case when seq<=100000 then $3 else '0x'||lpad(to_hex(seq),40,'0') end,
      '1',case when seq<=100000 then '2025-01-01T00:00:00Z'::timestamptz else '2026-10-14T16:00:20Z'::timestamptz end,
      case when seq<=100000 then '2025-01-01T00:00:00Z'::timestamptz else '2026-10-14T16:00:20Z'::timestamptz end,
      'source_debit',true,'finalized',6
    from generate_series(1,200000) as data_rows(seq)`,
    [op, baseAsset, owner],
  );
  await client.query("analyze funding_observations");
  await client.query("analyze funding_operations");
  await client.query("analyze balance_reservations");
  await client.query("set local plan_cache_mode=force_generic_plan");
  await client.query(
    `prepare native_snapshot_tail(uuid,jsonb) as ${FUNDING_NATIVE_SNAPSHOT_DEBITS_SQL}`,
  );
  for (const [name, params] of [
    ["hit", snapshot()],
    ["physical-source-all-aliases", snapshot(undefined, owner, null)],
    ["resumed-empty", snapshot("2026-10-14T16:00:25Z")],
    ["sparse-owner", snapshot(undefined, `0x${"cc".repeat(20)}`)],
    ["empty-input", "[]"],
  ]) {
    // JSON test constants only; never interpolate user/provider data into SQL.
    const plan = (
      await client.query(
        `explain (analyze,buffers,format json) execute native_snapshot_tail('${user}', '${params}')`,
      )
    ).rows[0]["QUERY PLAN"][0];
    const nodes: Record<string, unknown>[] = [];
    const walk = (node: Record<string, unknown>) => {
      nodes.push(node);
      for (const child of (node.Plans as
        | Record<string, unknown>[]
        | undefined) ?? [])
        walk(child);
    };
    walk(plan.Plan);
    assert.ok(
      !nodes.some(
        (node) =>
          node["Relation Name"] === "funding_observations" &&
          node["Node Type"] === "Seq Scan",
      ),
      name,
    );
    assert.ok(
      nodes.some(
        (node) =>
          node["Index Name"] === "funding_observations_native_source_tail_idx",
      ),
      name,
    );
    assert.ok(
      Number(plan.Plan["Local Hit Blocks"]) +
        Number(plan.Plan["Local Read Blocks"]) <
        100,
      name,
    );
    console.log(name, {
      ms: plan["Execution Time"],
      localBlocks:
        Number(plan.Plan["Local Hit Blocks"]) +
        Number(plan.Plan["Local Read Blocks"]),
    });
  }
  console.log("native snapshot debit cases passed");
  await client.query(
    `prepare evm_snapshot_tail(uuid,jsonb) as ${FUNDING_EVM_SNAPSHOT_DEBITS_SQL}`,
  );
  for (const [name, params] of [
    ["hit", evmSnapshot()],
    ["resumed-empty", evmSnapshot("2026-10-14T16:00:25Z")],
    ["sparse-owner", evmSnapshot(undefined, `0x${"cc".repeat(20)}`)],
    ["empty-input", "[]"],
  ]) {
    const plan = (
      await client.query(
        `explain (analyze,buffers,format json) execute evm_snapshot_tail('${user}', '${params}')`,
      )
    ).rows[0]["QUERY PLAN"][0];
    const serialized = JSON.stringify(plan.Plan);
    assert.ok(
      serialized.includes("funding_observations_evm_source_tail_idx"),
      name,
    );
    const blocks =
      Number(plan.Plan["Local Hit Blocks"]) +
      Number(plan.Plan["Local Read Blocks"]);
    assert.ok(blocks < 100, `${name}: ${blocks} blocks`);
    console.log(`evm-${name}`, {
      ms: plan["Execution Time"],
      localBlocks: blocks,
    });
  }
  console.log("EVM snapshot debit cases passed");
  await verifyHypercorePreparationAvailabilityPg(client);
  await verifyMergedSnapshotDebitsPg(client);
} finally {
  await client.query("rollback");
  client.release();
  await pool.end();
}
