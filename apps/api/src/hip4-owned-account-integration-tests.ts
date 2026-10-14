// @requires-db
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createIntegrationTestPool } from "./test-database-target.js";
import { installHip4TestLifecycle } from "./hip4-test-lifecycle.js";
import {
  claimHip4AccountRefresh,
  persistHip4AccountRefresh,
  readHip4AccountExecutions,
  readHip4AccountSnapshot,
  failHip4AccountRefresh,
  HIP4_EXECUTION_PAGE_SQL,
  HIP4_EXECUTION_MARKET_PAGE_SQL,
} from "./services/hip4-account-repository.js";
import {
  projectHip4Account,
  projectHip4Execution,
} from "./services/hip4-account-projection.js";
import { createHip4OwnedAccountService } from "./services/hip4-account-service.js";
import { hip4AccountProtectedRefsSql } from "./services/hip4-retention.js";

const pool = await createIntegrationTestPool({
  max: 4,
  options: "-c statement_timeout=15000",
});
const address = "0x0000000000000000000000000000000000000001";
const now = Date.now();
const quote = {
  tokenId: "0x6d1e7cde53ba9467b783cb7c530ce054",
  index: 0,
  weiDecimals: 8,
};
const position = { coin: "+87750", total: "20", hold: "2", entryNtl: "10" };
const fill = {
  coin: "#87750",
  px: "0.5",
  sz: "2",
  side: "B",
  time: now - 1000,
  startPosition: "0",
  dir: "Buy",
  closedPnl: "0",
  hash: `0x${"1".repeat(64)}`,
  oid: 1,
  crossed: true,
  fee: "0.01",
  tid: 1,
  feeToken: "USDC",
  builderFee: "0.01",
};
const observation = projectHip4Account({
  environment: "mainnet",
  observedAt: new Date(now).toISOString(),
  role: "user",
  mode: "disabled",
  quote,
  state: { balances: [position] },
});
const policyIds = [randomUUID(), randomUUID()];
const lifecycleFixture = await installHip4TestLifecycle(pool);
try {
  await pool.query("delete from hip4_request_budget where scope='public-info'");
  assert.equal(
    (Number(
      (await pool.query("show server_version_num")).rows[0].server_version_num,
    ) /
      10000) |
      0,
    16,
  );
  const lease = await claimHip4AccountRefresh(
    pool,
    "mainnet",
    address,
    120000,
    new Date(now),
  );
  assert.ok(lease);
  assert.equal(
    await claimHip4AccountRefresh(
      pool,
      "mainnet",
      address,
      120000,
      new Date(now),
    ),
    null,
  );
  const entries = [
    fill,
    { ...fill, tid: 2 },
    { ...fill, coin: "#87751", tid: 3 },
  ].map((row) => projectHip4Execution("mainnet", address, row));
  const save = {
    environment: "mainnet" as const,
    address,
    lease,
    observation,
    executions: entries,
    ledger: [],
    history: {},
    error: null,
  };
  assert.equal(await persistHip4AccountRefresh(pool, save), true);
  assert.equal(await persistHip4AccountRefresh(pool, save), false);
  const retry = await claimHip4AccountRefresh(
    pool,
    "mainnet",
    address,
    120000,
    new Date(now),
  );
  assert.ok(retry);
  await persistHip4AccountRefresh(pool, { ...save, lease: retry });
  const first = await readHip4AccountExecutions(pool, "mainnet", address, 1);
  assert.equal(first.items.length, 1);
  assert.ok(first.nextCursor);
  const second = await readHip4AccountExecutions(
    pool,
    "mainnet",
    address,
    10,
    first.nextCursor,
  );
  assert.equal(second.items.length, 2);
  assert.ok(second.items.every((row) => row.id !== first.items[0].id));
  assert.equal(
    (await readHip4AccountExecutions(pool, "testnet", address, 10)).items
      .length,
    0,
  );
  const state = await readHip4AccountSnapshot(pool, "mainnet", address);
  assert.deepEqual(state?.observation, observation);
  const conflictLease = await claimHip4AccountRefresh(
    pool,
    "mainnet",
    address,
    120000,
    new Date(now),
  );
  assert.ok(conflictLease);
  await persistHip4AccountRefresh(pool, {
    ...save,
    lease: conflictLease,
    executions: [{ ...entries[0], fee: "0.02" }],
  });
  assert.ok(
    (
      await readHip4AccountSnapshot(pool, "mainnet", address)
    )?.attempt_error.includes("execution_identity_conflict"),
  );
  assert.equal(
    (await readHip4AccountExecutions(pool, "mainnet", address, 10)).items.find(
      (row) => row.id === entries[0].id,
    )?.fee,
    "0.01",
  );
  const emptyLease = await claimHip4AccountRefresh(
    pool,
    "mainnet",
    address,
    120000,
    new Date(now),
  );
  assert.ok(emptyLease);
  await persistHip4AccountRefresh(pool, {
    ...save,
    lease: emptyLease,
    observation: null,
    executions: [],
    error: "timeout",
  });
  assert.equal(
    (await readHip4AccountSnapshot(pool, "mainnet", address))?.observation
      ?.positions.length,
    1,
  );
  const zeroLease = await claimHip4AccountRefresh(
    pool,
    "mainnet",
    address,
    120000,
    new Date(now),
  );
  assert.ok(zeroLease);
  await persistHip4AccountRefresh(pool, {
    ...save,
    lease: zeroLease,
    observation: { ...observation, positions: [] },
    executions: [],
  });
  assert.equal(
    (await readHip4AccountSnapshot(pool, "mainnet", address))?.observation
      ?.positions.length,
    0,
  );
  assert.equal(
    (await readHip4AccountExecutions(pool, "mainnet", address, 10)).items
      .length,
    3,
  );
  const expired = await claimHip4AccountRefresh(
    pool,
    "mainnet",
    address,
    120000,
    new Date(now),
  );
  assert.ok(expired);
  await pool.query(
    "update hip4_account_snapshots set lease_until=now()-interval '1 second' where account_address=$1",
    [address],
  );
  const next = await claimHip4AccountRefresh(
    pool,
    "mainnet",
    address,
    120000,
    new Date(now),
  );
  assert.ok(next);
  assert.equal(
    await persistHip4AccountRefresh(pool, { ...save, lease: expired }),
    false,
  );
  await failHip4AccountRefresh(
    pool,
    "mainnet",
    address,
    next,
    "synthetic_failure",
  );

  await pool.query(
    "insert into runtime_policies(id,policy_key,payload,effective_at) values($1,'hip4_read',$3,now()),($2,'hip4_account',$4,now())",
    [
      ...policyIds,
      JSON.stringify({ enabled: true, requestWeightPerMinute: 1000 }),
      JSON.stringify({ enabled: true }),
    ],
  );
  const provider = async (_url: unknown, options?: RequestInit) => {
    const body = JSON.parse(String(options?.body));
    const responses: Record<string, unknown> = {
      userRole: { role: "user" },
      userAbstraction: "disabled",
      spotMeta: { tokens: [{ name: "USDC", ...quote, szDecimals: 8 }] },
      spotClearinghouseState: { balances: [position] },
      userFills: [fill],
      userFillsByTime: [fill],
      userNonFundingLedgerUpdates: [],
      frontendOpenOrders: [],
    };
    return Response.json(responses[body.type]);
  };
  const service = createHip4OwnedAccountService(pool, provider);
  const policy = await service.policy();
  const loaded = await service.load(
    address,
    policy.readPolicy,
    policy.accountPolicy,
    policy.revision,
    true,
  );
  assert.equal(loaded.state, "fresh");
  assert.equal(loaded.observation?.positions.length, 1);
  assert.ok(loaded.history.executionsObservedAt);
  assert.equal(loaded.history.allTimeComplete, false);
  const evidence = await pool.query(
    "select provider_fill,provider_fingerprint from hip4_account_executions where environment='mainnet' and account_address=$1 and tid=1",
    [address],
  );
  assert.deepEqual(evidence.rows[0].provider_fill, fill);
  assert.match(evidence.rows[0].provider_fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(
    "provider_fill" in
      (await readHip4AccountExecutions(pool, "mainnet", address, 10)).items[0],
    false,
  );
  const partialService = createHip4OwnedAccountService(
    pool,
    async (url, options) =>
      JSON.parse(String(options?.body)).type === "userFills"
        ? new Response("unavailable", { status: 500 })
        : provider(url, options),
  );
  const partial = await partialService.load(
    address,
    policy.readPolicy,
    policy.accountPolicy,
    policy.revision,
    true,
  );
  assert.equal(partial.state, "fresh");
  assert.equal(partial.observation?.positions.length, 1);
  assert.equal(
    partial.history.executionsObservedAt,
    loaded.history.executionsObservedAt,
  );
  assert.equal(partial.refreshState, "failed");

  // Exact private keyset scans, including sparse market filters and generic plans.
  await pool.query(
    `insert into hip4_account_executions(environment,account_address,time_ms,coin,tid,oid,canonical_market_id,execution,fingerprint)
    select 'mainnet',$1,$2::bigint+fixture_row,'#87750',fixture_row+100,fixture_row+100,'hyperliquid:mainnet:outcome:8775',$3,'fixture'
    from generate_series(1,20000) fixture_row`,
    [address, now, JSON.stringify(entries[0])],
  );
  await pool.query("analyze hip4_account_executions");
  await pool.query("set plan_cache_mode=force_generic_plan");
  for (const [name, sql, parameters] of [
    [
      "account_page",
      HIP4_EXECUTION_PAGE_SQL,
      "text,text,bigint,text,bigint,bigint,int",
    ],
    [
      "account_market_page",
      HIP4_EXECUTION_MARKET_PAGE_SQL,
      "text,text,bigint,text,bigint,bigint,int,text",
    ],
  ]) {
    await pool.query(`prepare ${name}(${parameters}) as ${sql}`);
    for (const boundary of [Number.MAX_SAFE_INTEGER, now + 10000, 0]) {
      const plan = await pool.query(
        `explain (analyze,buffers,format json) execute ${name}('mainnet','${address}',${boundary},'~',9007199254740991,9007199254740991,31${name === "account_market_page" ? ",'hyperliquid:mainnet:outcome:8775'" : ""})`,
      );
      const result = plan.rows[0]["QUERY PLAN"][0];
      assert.ok(JSON.stringify(result.Plan).includes("Index"));
      assert.ok(result["Execution Time"] < 1000);
    }
  }
  await pool.query(
    "create temporary table p2_candidates(market_id text,venue text,event_id text)",
  );
  await pool.query(
    "insert into p2_candidates values('hyperliquid:mainnet:outcome:8775','hyperliquid','hip4-event')",
  );
  await pool.query(
    "create temporary table p2_tokens(market_id text,token_id text,venue text)",
  );
  const references = await pool.query(
    hip4AccountProtectedRefsSql("p2_candidates"),
  );
  assert.ok(
    references.rows.some((row) => row.reason === "hip4_account_executions"),
  );
  assert.ok(
    references.rows.some((row) => row.reason === "hip4_account_positions"),
  );
  console.log(
    "HIP4 owned account PG16: leases/replay/zero/failure/cursors/refresh/retention/generic plans PASS",
  );
} finally {
  await lifecycleFixture.close();
  await pool.query("delete from runtime_policies where id=any($1::uuid[])", [
    policyIds,
  ]);
  await pool.query(
    "delete from hip4_account_snapshots where account_address=$1",
    [address],
  );
  await pool.end();
}
