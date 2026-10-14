// @requires-db
import assert from "node:assert/strict";
import { createIntegrationTestPool } from "./test-database-target.js";
import { loadHunchHolderPositions } from "./services/hunch-holder-positions.js";
import { loadLatestWalletPositionNowMap } from "./services/wallet-position-approx.js";
import { makeWalletPositionLedgerKey } from "./services/wallet-position-ledger.js";

const pool = await createIntegrationTestPool({
  max: 1,
  options: "-c statement_timeout=15000",
});
const db = await pool.connect();
try {
  assert.equal(
    Math.floor(
      Number(
        (await db.query("show server_version_num")).rows[0].server_version_num,
      ) / 10000,
    ),
    16,
  );
  await db.query("begin");
  await db.query(`
    create temporary table unified_events(id text primary key,end_date timestamptz);
    create temporary table unified_markets(id text primary key,event_id text,venue text,status text,
      close_time timestamptz,expiration_time timestamptz,resolution_observed_at timestamptz,
      resolved_outcome text,resolved_outcome_pct numeric,best_bid numeric,best_ask numeric,last_price numeric);
    create temporary table unified_tokens(token_id text primary key,market_id text,side text);
    create temporary table unified_token_top_latest(token_id text primary key,mid numeric,best_bid numeric,best_ask numeric,ts timestamptz);
    create temporary table wallet_position_snapshots(wallet_id uuid,venue text,market_id text,outcome_side text,
      snapshot_at timestamptz,shares numeric,size_usd numeric,price numeric,metadata jsonb);
    create temporary table wallet_activity_events(id text,wallet_id uuid,market_id text,outcome_side text,
      action text,delta_shares numeric,size_usd numeric,price numeric,occurred_at timestamptz,created_at timestamptz,
      activity_type text,source text);
    insert into unified_events values ('event','2026-10-08T16:00:00Z');
    insert into unified_markets values ('polymarket:5404885','event','polymarket','CLOSED',
      '2026-10-08T16:00:00Z',null,'2026-10-08T16:00:00Z','NO',null,null,0.001,0);
    insert into wallet_position_snapshots values
      ('f25ad810-cd02-4a7a-803c-6fb95eed01c7','polymarket','polymarket:5404885','NO','2026-10-08T15:00:00Z',24999.951542,24974.95159,0.999,'{}'),
      ('f25ad810-cd02-4a7a-803c-6fb95eed01c7','polymarket','unrelated','YES','2026-10-14T15:00:00Z',100,50,0.5,'{}');
  `);
  const wallet = "f25ad810-cd02-4a7a-803c-6fb95eed01c7";
  const market = "polymarket:5404885";
  const key = {
    walletId: wallet,
    marketId: market,
    venue: "polymarket",
    outcomeSide: "NO",
  };
  const mapKey = makeWalletPositionLedgerKey(wallet, market, "NO");
  const events = [
    [2052.138462, 1528.843154],
    [13361.87077, 9954.593724],
    [4585.94231, 3416.527021],
    [5000, 2075],
  ];
  for (const [index, [shares, dollars]] of events.entries()) {
    await db.query(
      `insert into wallet_activity_events values ($1,$2,$3,'NO','BUY',$4,$5,$6,$7,$7,'delta','snapshot_delta')`,
      [
        String(index),
        wallet,
        market,
        shares,
        dollars,
        dollars / shares,
        new Date(Date.UTC(2026, 9, 8, index * 3)),
      ],
    );
  }
  // Portfolio disappearance after settlement must not fabricate a zero-price sale.
  await db.query(
    `insert into wallet_activity_events values ('gone',$1,$2,'NO','SELL',24999.951542,0,0,
    '2026-10-08T17:00:00Z','2026-10-08T17:00:00Z','delta','snapshot_delta')`,
    [wallet, market],
  );
  const result = await loadHunchHolderPositions(db, [
    key,
    key,
    { ...key, outcomeSide: "YES" },
  ]);
  assert.equal(result.size, 2);
  const initialResult = result.get(mapKey)?.positionResult;
  assert.ok(initialResult);
  assert.ok(Math.abs(initialResult.pnlUsd - 8024.987643) < 1e-6);
  assert.equal(result.get(mapKey)?.positionSizeUsd, null);
  assert.equal(
    result.get(makeWalletPositionLedgerKey(wallet, market, "YES"))
      ?.positionResult,
    null,
  );
  assert.equal(
    (await loadLatestWalletPositionNowMap(db, [key])).has(mapKey),
    false,
    "live portfolio loader semantics stay unchanged",
  );
  await db.query("delete from wallet_position_snapshots where market_id=$1", [
    market,
  ]);
  const ledgerOnly = (await loadHunchHolderPositions(db, [key])).get(
    mapKey,
  )?.positionResult;
  assert.ok(ledgerOnly);
  assert.ok(
    Math.abs(ledgerOnly.pnlUsd - 8024.987643) < 1e-6,
    "ledger-only historical result",
  );
  await db.query(
    "update unified_markets set resolved_outcome=null,status='ACTIVE' where id=$1",
    [market],
  );
  await db.query("insert into unified_tokens values ('no-token',$1,'NO')", [
    market,
  ]);
  await db.query(
    "insert into unified_token_top_latest values ('no-token',0.8,0.79,0.81,'2026-10-14T15:00:00Z')",
  );
  const open = (await loadHunchHolderPositions(db, [key])).get(mapKey);
  assert.ok(open?.positionResult);
  assert.equal(open.positionResult?.valuation, "quote");
  assert.ok(
    Math.abs(open.positionResult.pnlUsd - (24999.951542 * 0.8 - 16974.963899)) <
      1e-6,
  );
  await db.query("rollback");
  console.log("hunch-holder-positions: PostgreSQL16 integration passed");
} finally {
  await db.query("rollback");
  db.release();
  await pool.end();
}
