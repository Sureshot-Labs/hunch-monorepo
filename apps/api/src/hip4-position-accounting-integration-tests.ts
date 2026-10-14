// @requires-db
import assert from "node:assert/strict";
import { createIntegrationTestPool } from "./test-database-target.js";
import {
  projectHip4Account,
  projectHip4Execution,
} from "./services/hip4-account-projection.js";
import {
  claimHip4AccountRefresh,
  persistHip4AccountRefresh,
  readHip4AccountSnapshot,
} from "./services/hip4-account-repository.js";
import {
  planHip4FillRepair,
  advanceHip4FillRepair,
  planHip4LedgerRepair,
  advanceHip4LedgerRepair,
} from "./services/hip4-account-history.js";
import {
  HIP4_BASIS_FILLS_SQL,
  HIP4_BASIS_LEDGER_SQL,
} from "./services/hip4-accounting-repository.js";
import { projectHip4PortfolioPositions } from "./services/hip4-portfolio-positions.js";

const pool = await createIntegrationTestPool({
  max: 2,
  options: "-c statement_timeout=15000",
});
const address = "0x00000000000000000000000000000000000018a2";
const now = Date.now();
const at = new Date(now).toISOString();
const fill = {
  coin: "#87750",
  px: "0.4",
  sz: "10",
  side: "B",
  time: now - 3000,
  startPosition: "0",
  dir: "Buy",
  closedPnl: "999",
  hash: `0x${"a".repeat(64)}`,
  oid: 1,
  tid: 1,
  crossed: true,
  fee: "0.1",
  feeToken: "USDC",
};
const second = {
  ...fill,
  time: now - 2000,
  tid: 2,
  oid: 2,
  px: "0.6",
  startPosition: "10",
};
const sale = {
  ...fill,
  time: now - 1000,
  tid: 3,
  oid: 3,
  px: "0.8",
  startPosition: "20",
  dir: "Sell",
  side: "A",
  sz: "5",
  fee: "0.05",
};
const sources = [fill, second, sale];
const observation = projectHip4Account({
  environment: "testnet",
  observedAt: at,
  role: "user",
  mode: "disabled",
  quote: { index: 0, tokenId: "exact-quote", weiDecimals: 8 },
  state: {
    balances: [{ coin: "+87750", total: "15", hold: "0", entryNtl: "999" }],
  },
});
const history = {
  fillRepair: advanceHip4FillRepair(
    planHip4FillRepair(undefined, 60000, now, 32),
    sources,
    at,
    32,
  ),
  ledgerRepair: advanceHip4LedgerRepair(
    planHip4LedgerRepair(undefined, 60000, now, 32),
    [],
    at,
    32,
  ),
};
async function save(
  fills = sources,
  maxRows = 100,
  observed = observation,
  savedHistory: Record<string, unknown> = history,
) {
  const lease = await claimHip4AccountRefresh(
    pool,
    "testnet",
    address,
    60000,
    new Date(),
  );
  assert.ok(lease);
  assert.equal(
    await persistHip4AccountRefresh(pool, {
      environment: "testnet",
      address,
      lease,
      observation: observed,
      executions: fills.map((row) =>
        projectHip4Execution("testnet", address, row),
      ),
      executionSources: fills,
      ledger: [],
      history: savedHistory,
      error: null,
      accountingMaxRows: maxRows,
    }),
    true,
  );
  const snapshot = await readHip4AccountSnapshot(pool, "testnet", address);
  assert.ok(snapshot);
  return snapshot;
}
try {
  assert.equal(
    Math.floor(
      Number(
        (await pool.query("show server_version_num")).rows[0]
          .server_version_num,
      ) / 10000,
    ),
    16,
  );
  const first = await save();
  assert.equal(first.history.positionAccounting.positions[0].costBasis, "7.65");
  assert.equal(
    first.history.positionAccounting.positions[0].realizedSinceAnchor,
    "1.4",
  );
  const positions = projectHip4PortfolioPositions({
    userId: "synthetic",
    address,
    environment: "testnet",
    observation,
    accounting: first.history.positionAccounting,
    markets: new Map(),
    snapshotMaxAgeMs: 60000,
    now,
  });
  assert.equal(positions[0].costBasisRaw, "7.65");
  assert.equal(positions[0].averagePriceRaw, "0.51");
  assert.equal(positions[0].unrealizedPnl, null); // no market mark
  assert.equal(
    (await save()).history.positionAccounting.positions[0].costBasis,
    "7.65",
  );
  // Corrupt optional legacy evidence must not roll back new account facts.
  // This exercises a real SQL transaction/savepoint, not a mocked repository.
  await pool.query(
    `insert into hip4_account_ledger(environment,account_address,event_key,time_ms,ledger_entry)
     values('testnet',$1,'basis-test-malformed',$2,$3::jsonb)`,
    [address, now - 500, JSON.stringify({ time: now - 500, delta: null })],
  );
  const degraded = await save();
  assert.equal(degraded.observation.positions[0].quantity, "15");
  assert.equal(degraded.history.positionAccounting, null);
  assert.ok(degraded.attempt_error.includes("position_accounting_unavailable"));
  assert.equal(degraded.lease_until, null);
  await pool.query(
    `delete from hip4_account_ledger where environment='testnet'
     and account_address=$1 and event_key='basis-test-malformed'`,
    [address],
  );
  assert.equal(
    (await save()).history.positionAccounting.positions[0].costBasis,
    "7.65",
  );
  assert.equal(
    (await save(sources, 1)).history.positionAccounting.positions[0].reason,
    "history_incomplete",
  );
  assert.equal(
    (await save()).history.positionAccounting.positions[0].costBasis,
    "7.65",
  );
  // Same normalized execution, but changed source startPosition: immutable
  // original is retained and current basis cannot pretend this is verified.
  const conflict = await save([{ ...fill, startPosition: "1" }, second, sale]);
  assert.ok(conflict.attempt_error.includes("execution_accounting_conflict"));
  assert.equal(
    conflict.history.positionAccounting.positions[0].reason,
    "execution_identity_conflict",
  );
  assert.equal(
    (await save()).history.positionAccounting.positions[0].reason,
    "execution_identity_conflict",
  );
  // A new zero anchor AFTER the conflicting record automatically recovers
  // current lot accounting; no reset/delete of old financial facts is required.
  const reset = { ...fill, time: now - 100, tid: 9, oid: 9, sz: "15" };
  const newLot = await save([reset]);
  // Previous position-chain mismatch is not proof of a sale: require a new
  // unambiguous zero anchor rather than pretending old lifetime PnL is known.
  assert.equal(newLot.observation.positions[0].quantity, "15");
  assert.equal(
    newLot.history.positionAccounting.positions[0].reason,
    "verified",
  );
  assert.equal(newLot.history.positionAccounting.positions[0].costBasis, "6.1");
  const client = await pool.connect();
  try {
    await client.query("begin");
    const foreignAddress = "0x00000000000000000000000000000000000018a3";
    await client.query(
      `insert into hip4_account_snapshots(environment,account_address)
       values('testnet',$1)`,
      [foreignAddress],
    );
    // Rolled-back representative history: 10k owned + 30k foreign records.
    await client.query(
      `insert into hip4_account_executions(environment,account_address,time_ms,coin,tid,oid,canonical_market_id,execution,fingerprint,provider_fill)
       select 'testnet',case when series_row.n<=10000 then $1 else $2 end,
       $3::bigint-50000+series_row.n,'#87750',10000+series_row.n,10000+series_row.n,
       'hyperliquid:testnet:outcome:43875','{}'::jsonb,'test-basis-plan','{}'::jsonb
       from generate_series(1,40000) as series_row(n)`,
      [address, foreignAddress, now],
    );
    await client.query(
      `insert into hip4_account_ledger(environment,account_address,time_ms,event_key,ledger_entry)
       select 'testnet',case when series_row.n<=10000 then $1 else $2 end,
       $3::bigint-50000+series_row.n,'test-basis-plan-'||series_row.n,'{}'::jsonb
       from generate_series(1,40000) as series_row(n)`,
      [address, foreignAddress, now],
    );
    await client.query("analyze hip4_account_executions");
    await client.query("analyze hip4_account_ledger");
    await client.query("set local plan_cache_mode=force_generic_plan");
    await client.query(
      `prepare hip_basis_fills(text,text,bigint,bigint,int) as ${HIP4_BASIS_FILLS_SQL}`,
    );
    await client.query(
      `prepare hip_basis_ledger(text,text,bigint,bigint,int) as ${HIP4_BASIS_LEDGER_SQL}`,
    );
    for (const name of ["hip_basis_fills", "hip_basis_ledger"]) {
      for (const [range, start, end, limit] of [
        ["sentinel", now - 60000, now, 101],
        ["covered", now - 60000, now, 20001],
        ["empty", now + 1, now + 1000, 101],
      ] as const) {
        const params = `'testnet','${address}',${start},${end},${limit}`;
        const plan = await client.query(
          `explain (analyze,buffers,format json) execute ${name}(${params})`,
        );
        const result = plan.rows[0]["QUERY PLAN"][0];
        assert.ok(result.Plan);
        assert.ok(result.Plan["Actual Rows"] <= limit);
        assert.ok(
          !JSON.stringify(result.Plan).includes('"Node Type":"Seq Scan"'),
        );
        console.log(
          JSON.stringify({
            basisQuery: name,
            range,
            ms: result["Execution Time"],
            buffers: result.Plan["Shared Hit Blocks"],
            rows: result.Plan["Actual Rows"],
          }),
        );
      }
    }
  } finally {
    await client.query("rollback");
    client.release();
  }
  console.log(
    "HIP basis PG16 atomic snapshot, replay, bounded reads, source conflict, common Portfolio and generic plans PASS",
  );
} finally {
  await pool.query(
    "delete from hip4_account_executions where environment='testnet' and account_address=$1",
    [address],
  );
  await pool.query(
    "delete from hip4_account_positions where environment='testnet' and account_address=$1",
    [address],
  );
  await pool.query(
    "delete from hip4_account_ledger where environment='testnet' and account_address=$1",
    [address],
  );
  await pool.query(
    "delete from hip4_account_snapshots where environment='testnet' and account_address=$1",
    [address],
  );
  await pool.end();
}
