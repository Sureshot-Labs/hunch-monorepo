// @requires-db
// Synthetic public responses and isolated PG16. No signer, bot or executor.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createIntegrationTestPool } from "./test-database-target.js";
import { installHip4TestLifecycle } from "./hip4-test-lifecycle.js";
import {
  runHip4AccountReadPass,
  HIP4_CLAIM_DUE_ACCOUNT_SQL,
} from "./hip4-account-worker-entry.js";
import { DEFAULT_VENUE_LIFECYCLE_POLICY } from "@hunch/shared";

const pool = await createIntegrationTestPool({
  max: 4,
  options: "-c statement_timeout=15000",
});
const ownerId = randomUUID();
const address = `0x${randomUUID().replaceAll("-", "")}00000001`;
const foreign = `0x${randomUUID().replaceAll("-", "")}00000002`;
const policies = [randomUUID(), randomUUID()];
const lifecycle = await installHip4TestLifecycle(pool);
let calls = 0;
let failRole = false;
let unlinkOnRole = false;
let roleStarted: (() => void) | undefined;
let holdRole: Promise<void> | undefined;
const fetcher: typeof fetch = async (url, options) => {
  assert.equal(String(url), "https://api.hyperliquid-testnet.xyz/info");
  const request = JSON.parse(String(options?.body));
  if (request.user) assert.equal(request.user, address);
  calls++;
  if (request.type === "userRole") {
    roleStarted?.();
    await holdRole;
    if (unlinkOnRole)
      await pool.query(
        "update user_wallets set is_verified=false where user_id=$1",
        [ownerId],
      );
    if (failRole) return new Response("error", { status: 503 });
  }
  const responses: Record<string, unknown> = {
    userRole: { role: "user" },
    userAbstraction: "disabled",
    spotMeta: {
      tokens: [
        {
          name: "USDC",
          tokenId: "0x6d1e7cde53ba9467b783cb7c530ce054",
          index: 0,
          weiDecimals: 8,
          szDecimals: 8,
        },
      ],
    },
    spotClearinghouseState: {
      balances: [
        { coin: "USDC", token: 0, total: "12.34", hold: "0", entryNtl: "0" },
      ],
    },
    frontendOpenOrders: [],
    userFills: [],
    userNonFundingLedgerUpdates: [],
  };
  assert.ok(request.type in responses, `unexpected read: ${request.type}`);
  return Response.json(responses[request.type]);
};
const makeDue = () =>
  pool.query(
    "update hip4_account_snapshots set attempt_at=now()-interval '1 day' where account_address=$1",
    [address],
  );
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
  await pool.query("delete from hip4_request_budget where scope='public-info'");
  await pool.query("insert into users(id,is_active) values($1,true)", [
    ownerId,
  ]);
  await pool.query(
    "insert into user_wallets(user_id,wallet_address,wallet_type,is_verified) values($1,$2,'ethereum',true)",
    [ownerId, address],
  );
  await pool.query(
    "insert into hip4_account_snapshots(environment,account_address) values('testnet',$1),('testnet',$2)",
    [address, foreign],
  );
  await pool.query(
    "insert into runtime_policies(id,policy_key,payload,effective_at) values($1,'hip4_read',$3,now()),($2,'hip4_account',$4,now())",
    [
      ...policies,
      { environment: "testnet", requestWeightPerMinute: 1200 },
      {
        historyRepairPagesPerRefresh: 0,
        workerBatchSize: 1,
        workerIntervalMs: 60000,
      },
    ],
  );
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    roleStarted = resolve;
  });
  holdRole = new Promise<void>((resolve) => {
    release = resolve;
  });
  const initial = runHip4AccountReadPass(pool, fetcher);
  await started;
  try {
    const concurrent = await runHip4AccountReadPass(pool, fetcher);
    assert.equal(
      concurrent.claimed,
      0,
      "active lease prevents concurrent duplicate account refresh",
    );
  } finally {
    release();
    holdRole = undefined;
    roleStarted = undefined;
  }
  const first = await initial;
  assert.equal(first.updated, 1);
  assert.equal(first.nextIntervalSeconds, 60);
  assert.equal((await runHip4AccountReadPass(pool, fetcher)).claimed, 0);
  const snapshot = (
    await pool.query(
      "select observation from hip4_account_snapshots where account_address=$1",
      [address],
    )
  ).rows[0].observation;
  assert.equal(snapshot.cash.ownedCash, "12.34");
  await makeDue();
  failRole = true;
  const failed = await runHip4AccountReadPass(pool, fetcher);
  assert.equal(failed.errors, 1);
  const stored = (
    await pool.query(
      "select observation, lease_token from hip4_account_snapshots where account_address=$1",
      [address],
    )
  ).rows[0];
  assert.equal(stored.lease_token, null);
  assert.equal(stored.observation.observedAt, snapshot.observedAt);
  failRole = false;
  await makeDue();
  assert.equal((await runHip4AccountReadPass(pool, fetcher)).updated, 1);
  await makeDue();
  await pool.query(
    "update hip4_account_snapshots set lease_token=gen_random_uuid(),lease_until=now()-interval '1 second' where account_address=$1",
    [address],
  );
  assert.equal(
    (await runHip4AccountReadPass(pool, fetcher)).updated,
    1,
    "expired worker lease recovers normally",
  );
  await makeDue();
  unlinkOnRole = true;
  const beforeUnlink = calls;
  await runHip4AccountReadPass(pool, fetcher);
  assert.equal(
    calls,
    beforeUnlink + 1,
    "no further provider calls after ownership revocation",
  );
  assert.equal((await runHip4AccountReadPass(pool, fetcher)).claimed, 0);
  unlinkOnRole = false;
  await pool.query(
    "update user_wallets set is_verified=true where user_id=$1",
    [ownerId],
  );
  await makeDue();
  await pool.query("update runtime_policies set payload=$2 where id=$1", [
    lifecycle.id,
    {
      ...DEFAULT_VENUE_LIFECYCLE_POLICY,
      venues: {
        ...DEFAULT_VENUE_LIFECYCLE_POLICY.venues,
        hyperliquid: { lifecycle: "unreleased", indexerMode: "off" },
      },
    },
  ]);
  const beforeOff = calls;
  assert.equal((await runHip4AccountReadPass(pool, fetcher)).claimed, 0);
  assert.equal(calls, beforeOff);
  // Parse and execute the exact due/lease query under a generic plan too.
  const db = await pool.connect();
  try {
    await db.query("begin");
    await db.query(
      `insert into hip4_account_snapshots(environment,account_address)
      select 'testnet','0x'||md5($1::text||sample.ordinal_number::text)||'00000000'
      from generate_series(1,10000) sample(ordinal_number)`,
      [ownerId],
    );
    await db.query("analyze hip4_account_snapshots");
    await db.query("set local plan_cache_mode=force_generic_plan");
    await db.query(
      `prepare hip4_due_claim(text,integer,integer) as ${HIP4_CLAIM_DUE_ACCOUNT_SQL}`,
    );
    const plan = (
      await db.query(
        "explain (analyze,buffers,format json) execute hip4_due_claim('testnet',60000,120000)",
      )
    ).rows[0]["QUERY PLAN"][0];
    assert.equal(plan.Plan["Actual Rows"], 1);
    console.log(
      JSON.stringify({
        dueClaimMs: plan["Execution Time"],
        buffers: plan.Plan["Shared Hit Blocks"],
      }),
    );
    await db.query("deallocate hip4_due_claim");
  } finally {
    await db.query("rollback");
    db.release();
  }
  console.log(
    "HIP account worker PG16 ordinary owner, idle refresh, concurrent lease, failure/recovery, unlink, policy-off PASS",
  );
} finally {
  await pool.query(
    "delete from hip4_account_snapshots where account_address=any($1::text[])",
    [[address, foreign]],
  );
  await pool.query("delete from user_wallets where user_id=$1", [ownerId]);
  await pool.query("delete from users where id=$1", [ownerId]);
  await pool.query("delete from runtime_policies where id=any($1::uuid[])", [
    policies,
  ]);
  await lifecycle.close();
  await pool.end();
}
