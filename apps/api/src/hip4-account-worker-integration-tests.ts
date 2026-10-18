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
let failPerps = false;
let unlinkOnRole = false;
let roleStarted: (() => void) | undefined;
let holdRole: Promise<void> | undefined;
const fetcher: typeof fetch = async (url, options) => {
  assert.equal(String(url), "https://api.hyperliquid-testnet.xyz/info");
  const request = JSON.parse(String(options?.body));
  if (request.user) assert.equal(request.user, address);
  calls++;
  if (request.type === "clearinghouseState") {
    assert.equal(request.dex, "");
    if (failPerps) return new Response("error", { status: 503 });
  }
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
    clearinghouseState: {
      marginSummary: {
        accountValue: "9.962411",
        totalRawUsd: "9.962411",
        totalMarginUsed: "0",
        totalNtlPos: "0",
      },
      crossMarginSummary: {
        accountValue: "9.962411",
        totalRawUsd: "9.962411",
        totalMarginUsed: "0",
        totalNtlPos: "0",
      },
      crossMaintenanceMarginUsed: "0",
      withdrawable: "9.962411",
      assetPositions: [],
      time: Date.now(),
    },
    frontendOpenOrders: [],
    userFills: [],
    userNonFundingLedgerUpdates: [],
  };
  assert.ok(request.type in responses, `unexpected read: ${request.type}`);
  return Response.json(responses[request.type]);
};
const makeDue = async () => {
  await pool.query(
    "update hip4_account_snapshots set attempt_at=now()-interval '1 day' where account_address=$1",
    [address],
  );
  // Advancing an account to its next 60s worker interval must also advance
  // the provider's 60s rolling window. Do not simulate several minutes of
  // valid refreshes inside a single real second of shared request capacity.
  await pool.query(
    "update hip4_request_budget set admissions=jsonb_build_array(jsonb_build_object('at',extract(epoch from statement_timestamp())-61,'weight',1200)) where scope='public-info'",
  );
};
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
    [ownerId, `0x${address.slice(2).toUpperCase()}`],
  );
  await pool.query(
    "insert into hip4_account_snapshots(environment,account_address) values('testnet',$1),('testnet',$2)",
    [address, foreign],
  );
  // The effective-policy reader uses a millisecond JS Date. Make these fixture
  // revisions already effective rather than racing PostgreSQL microseconds.
  await pool.query(
    "insert into runtime_policies(id,policy_key,payload,effective_at) values($1,'hip4_read',$3,clock_timestamp()-interval '1 second'),($2,'hip4_account',$4,clock_timestamp()-interval '1 second')",
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
  const firstSnapshot = (
    await pool.query(
      "select observation, history from hip4_account_snapshots where account_address=$1",
      [address],
    )
  ).rows[0];
  assert.equal(
    firstSnapshot.history.nextBackgroundRead,
    undefined,
    "a sufficient repair quota retains combined cash/history refreshes",
  );
  const snapshot = firstSnapshot.observation;
  assert.equal(snapshot.cash.ownedCash, "12.34");
  assert.equal(snapshot.perpsCash.state, "verified");
  assert.equal(snapshot.perpsCash.availableRaw, "996241100");
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
  failPerps = true;
  await makeDue();
  assert.equal((await runHip4AccountReadPass(pool, fetcher)).updated, 1);
  const perpsFailed = (
    await pool.query(
      "select observation from hip4_account_snapshots where account_address=$1",
      [address],
    )
  ).rows[0].observation;
  assert.equal(
    perpsFailed.cash.ownedCash,
    "12.34",
    "independent failure cannot erase valid spot",
  );
  assert.equal(perpsFailed.perpsCash.state, "unavailable");
  assert.equal(
    perpsFailed.perpsCash.availableRaw,
    null,
    "no stale cash from a previous perps receipt/read",
  );
  failPerps = false;
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
  assert.equal(
    (
      await pool.query(
        "select observation from hip4_account_snapshots where account_address=$1",
        [address],
      )
    ).rows[0].observation.perpsCash.state,
    "verified",
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
  // Real row contention (not an already committed active lease): ordered
  // candidates must skip the locked first row and still find the second.
  await pool.query(
    "insert into user_wallets(user_id,wallet_address,wallet_type,is_verified) values($1,$2,'ethereum',true)",
    [ownerId, foreign],
  );
  const [oldest, next] = [address, foreign].sort();
  await pool.query(
    `update hip4_account_snapshots set attempt_at=null,lease_token=null,lease_until=null
    where environment='testnet' and account_address=any($1::text[])`,
    [[address, foreign]],
  );
  const locker = await pool.connect();
  try {
    await locker.query("begin");
    await locker.query(
      "select account_address from hip4_account_snapshots where environment='testnet' and account_address=$1 for update",
      [oldest],
    );
    const skipped = await pool.query(HIP4_CLAIM_DUE_ACCOUNT_SQL, [
      "testnet",
      60000,
      120000,
    ]);
    assert.deepEqual(
      skipped.rows.map((row) => row.account_address),
      [next],
    );
    assert.equal(
      (await pool.query(HIP4_CLAIM_DUE_ACCOUNT_SQL, ["testnet", 60000, 120000]))
        .rowCount,
      0,
    );
    assert.equal(
      (
        await locker.query(
          "select lease_token from hip4_account_snapshots where environment='testnet' and account_address=$1",
          [oldest],
        )
      ).rows[0].lease_token,
      null,
    );
  } finally {
    await locker.query("rollback");
    locker.release();
  }
  assert.deepEqual(
    (
      await pool.query(HIP4_CLAIM_DUE_ACCOUNT_SQL, ["testnet", 60000, 120000])
    ).rows.map((row) => row.account_address),
    [oldest],
  );
  await pool.query(
    "delete from user_wallets where user_id=$1 and wallet_address_norm=$2",
    [ownerId, foreign],
  );
  // Parse and execute the exact due/lease query under a generic plan too.
  const db = await pool.connect();
  try {
    await db.query("begin");
    await db.query(
      `insert into hip4_account_snapshots(environment,account_address)
      select 'testnet','0x'||md5($1::text||sample.ordinal_number::text)||'00000000'
      from generate_series(1,100000) sample(ordinal_number)`,
      [ownerId],
    );
    await db.query("analyze hip4_account_snapshots");
    await db.query(
      `prepare hip4_due_claim(text,integer,integer) as ${HIP4_CLAIM_DUE_ACCOUNT_SQL}`,
    );
    const ownedCount = Number(
      (
        await db.query(
          "select count(*) as n from user_wallets where wallet_type='ethereum' and is_verified",
        )
      ).rows[0].n,
    );
    for (const mode of ["force_custom_plan", "force_generic_plan"]) {
      await db.query(`set local plan_cache_mode=${mode}`);
      await db.query(
        "update hip4_account_snapshots set attempt_at=now()-interval '1 day',lease_token=null,lease_until=null where environment='testnet' and account_address=$1",
        [address],
      );
      for (const due of [true, false]) {
        const plan = (
          await db.query(
            "explain (analyze,buffers,format json) execute hip4_due_claim('testnet',60000,120000)",
          )
        ).rows[0]["QUERY PLAN"][0];
        assert.equal(plan.Plan["Actual Rows"], due ? 1 : 0);
        assert.ok(
          plan.Plan["Shared Hit Blocks"] < ownedCount * 10 + 1000,
          "unowned snapshot count must not multiply ownership lookups",
        );
        if (process.env.HUNCH_TEST_SHOW_QUERY_PLAN === "1")
          console.log(JSON.stringify(plan));
        console.log(
          JSON.stringify({
            mode,
            due,
            dueClaimMs: plan["Execution Time"],
            buffers: plan.Plan["Shared Hit Blocks"],
          }),
        );
      }
    }
    // A sparse unowned fixture alone does not cover a large enrolled queue.
    // All synthetic ownership and snapshots below disappear on rollback.
    await db.query(
      `create temporary table hip4_owned_queue_fixture on commit drop as
      select gen_random_uuid() as owner_id,
        '0x'||md5($1::text||sample.ordinal_number::text)||'00000000' as account_address
      from generate_series(1,10000) sample(ordinal_number)`,
      [ownerId],
    );
    await db.query(`insert into users(id,is_active)
      select owner_id,true from hip4_owned_queue_fixture`);
    await db.query(`insert into user_wallets(user_id,wallet_address,wallet_type,is_verified)
      select owner_id,account_address,'ethereum',true from hip4_owned_queue_fixture`);
    await db.query("analyze users");
    await db.query("analyze user_wallets");
    for (const mode of ["force_custom_plan", "force_generic_plan"]) {
      await db.query(`set local plan_cache_mode=${mode}`);
      for (const distribution of ["all_due", "one_due", "empty"]) {
        await db.query(
          `update hip4_account_snapshots snapshot_row
          set attempt_at=case when $1='all_due' then null else clock_timestamp() end,
            lease_token=null,lease_until=null
          from hip4_owned_queue_fixture fixture_row
          where snapshot_row.environment='testnet'
            and snapshot_row.account_address=fixture_row.account_address`,
          [distribution],
        );
        if (distribution === "one_due")
          await db.query(`update hip4_account_snapshots
            set attempt_at=null where environment='testnet' and account_address=(
              select account_address from hip4_owned_queue_fixture order by account_address desc limit 1)`);
        await db.query("analyze hip4_account_snapshots");
        const plan = (
          await db.query(
            "explain (analyze,buffers,format json) execute hip4_due_claim('testnet',60000,120000)",
          )
        ).rows[0]["QUERY PLAN"][0];
        assert.equal(
          plan.Plan["Actual Rows"],
          distribution === "empty" ? 0 : 1,
        );
        if (process.env.HUNCH_TEST_SHOW_QUERY_PLAN === "1")
          console.log(JSON.stringify(plan));
        assert.ok(
          plan.Plan["Shared Hit Blocks"] < (ownedCount + 10000) * 15,
          "dense queue must not multiply candidates by total snapshot count",
        );
        console.log(
          JSON.stringify({
            mode,
            distribution,
            owned: 10000,
            dueClaimMs: plan["Execution Time"],
            buffers: plan.Plan["Shared Hit Blocks"],
          }),
        );
      }
    }
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
