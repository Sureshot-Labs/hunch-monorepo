// @requires-db
import assert from "node:assert/strict";
import { buildWalletFollowingLatestPositiveSql } from "./services/wallet-intel-helpers.js";
import { createIntegrationTestPool } from "./test-database-target.js";

const pool = await createIntegrationTestPool({ max: 1 });
const client = await pool.connect();
const walletId = "00000000-0000-0000-0000-000000000001";
try {
  await client.query("begin");
  await client.query(`
    create temporary table wallet_position_snapshots (
      wallet_id uuid, venue text, market_id text, outcome_side text,
      shares numeric, size_usd numeric, price numeric, snapshot_at timestamptz
    );
    insert into wallet_position_snapshots values
      ('${walletId}', 'polymarket', 'shared', 'YES', 10, 5, 0.5, '2026-11-18 00:00Z'),
      ('${walletId}', 'limitless', 'shared', 'YES', 20, 10, 0.5, '2026-11-19 00:00Z'),
      ('${walletId}', 'polymarket', 'shared', 'YES', 0, 100, 0.5, '2026-11-20 00:00Z'),
      ('${walletId}', 'limitless', 'shared', 'NO', 50, 25, 0.5, '2026-11-18 00:00Z'),
      ('${walletId}', 'polymarket', 'legacy', null, 15, null, null, '2026-11-18 00:00Z'),
      ('${walletId}', 'limitless', 'legacy', null, 30, null, null, '2026-11-20 00:00Z'),
      ('${walletId}', 'polymarket', 'zero', 'NO', 0, 100, 0.5, '2026-11-20 00:00Z'),
      ('${walletId}', 'limitless', 'negative', 'YES', -2, 100, 0.5, '2026-11-20 00:00Z'),
      ('00000000-0000-0000-0000-000000000002', 'polymarket', 'shared', 'YES', 40, 20, 0.5, '2026-11-22 00:00Z');
  `);
  const previous = await client.query(
    `select distinct on (ws.market_id, ws.outcome_side)
       ws.market_id, ws.outcome_side, ws.shares
     from wallet_position_snapshots ws
     where ws.wallet_id = $1::uuid and ws.shares > 0
     order by ws.market_id, ws.outcome_side, ws.snapshot_at desc`,
    [walletId],
  );
  const latest = buildWalletFollowingLatestPositiveSql("w.id");
  const current = await client.query(
    `select latest.market_id, latest.outcome_side, latest.shares
     from (select $1::uuid as id) w
     cross join lateral (${latest}) latest
     order by latest.market_id, latest.outcome_side`,
    [walletId],
  );
  assert.deepEqual(current.rows, previous.rows);
  assert.deepEqual(current.rows, [
    { market_id: "legacy", outcome_side: null, shares: "30" },
    { market_id: "shared", outcome_side: "NO", shares: "50" },
    { market_id: "shared", outcome_side: "YES", shares: "20" },
  ]);
  const empty = await client.query(
    buildWalletFollowingLatestPositiveSql("$1::uuid"),
    ["00000000-0000-0000-0000-000000000003"],
  );
  assert.deepEqual(empty.rows, []);
  console.log("wallet Following inference preserves latest positive rows");
} finally {
  await client.query("rollback").catch(() => undefined);
  client.release();
  await pool.end();
}
