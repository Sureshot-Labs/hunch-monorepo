// @requires-db — explicit disposable PG16; synthetic provider facts, no network.
import assert from "node:assert/strict";
import { randomInt, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "@hunch/infra";
import { createIntegrationTestPool } from "./test-database-target.js";
import { projectHip4Execution } from "./services/hip4-account-projection.js";
import {
  claimHip4AccountRefresh,
  persistHip4AccountRefresh,
  readHip4ProviderEvidenceStatus,
  hip4LegacyExecutionConflictTime,
} from "./services/hip4-account-repository.js";
import {
  createHip4NativeEvidenceFinalizer,
  HIP4_VERIFIED_BUY_FILLS_SQL,
} from "./services/verified-buy-observer.js";
import type { NativePurchaseEvidenceGuard } from "./services/verified-buy.js";

const pool = await createIntegrationTestPool({
  max: 4,
  options: "-c statement_timeout=15000 -c lock_timeout=10000",
});
const address = `0x${randomUUID().replaceAll("-", "")}12345678`;
const foreignAddress = `0x${randomUUID().replaceAll("-", "")}12345678`;
const fill = {
  coin: "#133430",
  px: "0.26",
  sz: "27",
  side: "B",
  time: Date.now() - 10000,
  startPosition: "0",
  dir: "Buy",
  closedPnl: "0",
  hash: `0x${"2".repeat(64)}`,
  oid: randomInt(1000000, 1000000000),
  crossed: false,
  fee: "0",
  tid: 1,
  feeToken: "USDC",
  cloid: null,
};
const unrelated = { ...fill, oid: fill.oid + 1, tid: 2 };
const finalize = createHip4NativeEvidenceFinalizer(pool);
async function input(sources: Array<typeof fill>, withSources = true) {
  const lease = await claimHip4AccountRefresh(
    pool,
    "mainnet",
    address,
    60000,
    new Date(),
  );
  assert.ok(lease);
  return {
    environment: "mainnet" as const,
    address,
    lease,
    observation: null,
    executions: sources.map((source) =>
      projectHip4Execution("mainnet", address, source),
    ),
    ...(withSources ? { executionSources: sources } : {}),
    ledger: [],
    history: {},
    error: null,
  };
}
async function save(sources: Array<typeof fill>, withSources = true) {
  assert.equal(
    await persistHip4AccountRefresh(pool, await input(sources, withSources)),
    true,
  );
}
async function evidence(orderId = fill.oid) {
  const rows = (
    await pool.query(HIP4_VERIFIED_BUY_FILLS_SQL, [
      "mainnet",
      address,
      fill.coin,
      String(orderId),
      101,
    ])
  ).rows;
  const guard: NativePurchaseEvidenceGuard = {
    kind: "hip4",
    environment: "mainnet",
    accountAddress: address,
    coin: fill.coin,
    orderId: String(orderId),
    legacyConflictTime: hip4LegacyExecutionConflictTime(
      (
        await pool.query(
          "select history from hip4_account_snapshots where environment='mainnet' and account_address=$1",
          [address],
        )
      ).rows[0]?.history,
      fill.coin,
    ),
    rows: rows.map((row) => ({
      timeMs: row.time_ms,
      tradeId: row.tid,
      revision:
        readHip4ProviderEvidenceStatus(row.provider_evidence_status)
          ?.revision ?? null,
    })),
  };
  return { rows, guard };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function borrowedPool(db: PoolClient, query = db.query.bind(db)) {
  return {
    connect: async () => ({ query, release: () => {} }),
  } as unknown as Pool;
}
try {
  assert.match(
    (await pool.query("show server_version")).rows[0].server_version,
    /^16\./u,
  );
  await save([fill, unrelated]);
  const original = await evidence();
  const originalExecution = original.rows[0].execution;
  await pool.query(
    "update hip4_account_snapshots set history=jsonb_build_object('accountingConflicts',jsonb_build_object($2::text,$3::bigint)) where environment='mainnet' and account_address=$1",
    [address, fill.coin, fill.time],
  );
  await save([fill], false);
  assert.equal((await evidence()).rows[0].provider_evidence_status, null);
  await save([fill]);
  assert.equal(
    (await evidence()).rows[0].provider_evidence_status.state,
    "matched",
  );
  await save([{ ...fill, sz: "28" }]);
  const conflict = await evidence();
  assert.deepEqual(conflict.rows[0].execution, originalExecution);
  assert.deepEqual(conflict.rows[0].provider_fill, fill);
  assert.equal(conflict.rows[0].provider_evidence_status.state, "conflicted");
  let stores = 0;
  assert.deepEqual(
    await finalize(original.guard, async () => {
      stores++;
    }),
    { stored: false },
  );
  await save([fill], false);
  await save([]);
  await save([unrelated]);
  assert.deepEqual(
    (await evidence()).rows[0].provider_evidence_status,
    conflict.rows[0].provider_evidence_status,
  );
  assert.equal(
    (await evidence(unrelated.oid)).rows[0].provider_evidence_status.state,
    "matched",
  );
  for (const variants of [
    [{ ...fill, startPosition: "1" }, fill],
    [fill, { ...fill, startPosition: "1" }],
  ]) {
    await save(variants);
    assert.equal(
      (await evidence()).rows[0].provider_evidence_status.state,
      "conflicted",
    );
  }
  const beforeRestore = await evidence();
  await save([fill]);
  const restored = await evidence();
  assert.equal(restored.rows[0].provider_evidence_status.state, "matched");
  const restoredRevision = restored.guard.rows[0].revision;
  const previousRevision = beforeRestore.guard.rows[0].revision;
  assert.ok(restoredRevision);
  assert.ok(previousRevision);
  assert.ok(BigInt(restoredRevision) > BigInt(previousRevision));
  assert.deepEqual(
    await finalize(beforeRestore.guard, async () => {
      stores++;
    }),
    { stored: false },
  );
  assert.deepEqual(
    await finalize(restored.guard, async (db) => {
      stores++;
      assert.equal(
        (
          await db.query(HIP4_VERIFIED_BUY_FILLS_SQL, [
            "mainnet",
            address,
            fill.coin,
            String(fill.oid),
            101,
          ])
        ).rows[0].provider_evidence_status.state,
        "matched",
      );
      return "matched";
    }),
    { stored: true, result: "matched" },
  );
  assert.equal(stores, 1);
  const phantom = {
    ...fill,
    time: fill.time + 1,
    tid: 3,
    sz: "2",
    startPosition: "27",
  };
  await save([phantom]);
  assert.deepEqual(
    await finalize(restored.guard, async () => {
      stores++;
    }),
    { stored: false },
  );
  assert.equal(stores, 1);

  // Actual P2 transaction owns FOR UPDATE and changes the marker before the
  // finalizer's FOR SHARE can return. Prove the lock really waited, then prove
  // the subsequent statement sees the committed new revision, not its old MVCC
  // snapshot. A single combined locking/evidence statement would fail this.
  const beforeRace = await evidence();
  const writer = await pool.connect();
  const finalClient = await pool.connect();
  const writerHeld = deferred(),
    releaseWriter = deferred();
  let writerPromise: Promise<boolean> | undefined;
  let finalPromise: ReturnType<typeof finalize> | undefined;
  try {
    const raceInput = await input([{ ...fill, fee: "0.01" }]);
    const writerQuery = (async (sql: string, args?: unknown[]) => {
      if (sql.startsWith("update hip4_account_snapshots set")) {
        writerHeld.resolve();
        await releaseWriter.promise;
      }
      return writer.query(sql, args);
    }) as typeof writer.query;
    writerPromise = persistHip4AccountRefresh(
      borrowedPool(writer, writerQuery),
      raceInput,
    );
    await Promise.race([
      writerHeld.promise,
      writerPromise.then(() => {
        throw new Error("P2 fixture finished without holding its account lock");
      }),
    ]);
    const pid = (await finalClient.query("select pg_backend_pid() as pid"))
      .rows[0].pid;
    finalPromise = createHip4NativeEvidenceFinalizer(borrowedPool(finalClient))(
      beforeRace.guard,
      async () => {
        stores++;
      },
    );
    let waited = false;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      waited =
        (
          await pool.query(
            "select wait_event_type='Lock' as waiting from pg_stat_activity where pid=$1",
            [pid],
          )
        ).rows[0]?.waiting === true;
      if (waited) break;
      await new Promise((done) => setTimeout(done, 10));
    }
    assert.equal(
      waited,
      true,
      "fixture must exercise a real blocked account-row lock",
    );
    releaseWriter.resolve();
    assert.equal(await writerPromise, true);
    assert.deepEqual(await finalPromise, { stored: false });
    assert.equal(
      stores,
      1,
      "stale original proof must not execute the stored-purchase callback",
    );
  } finally {
    releaseWriter.resolve();
    await Promise.allSettled([writerPromise, finalPromise]);
    writer.release();
    finalClient.release();
  }
  await save([fill]);
  assert.equal(
    (await evidence()).rows[0].provider_evidence_status.state,
    "matched",
  );

  // Representative owned/foreign history, same existing exact-order index.
  // Temporary table plus rollback leaves all real retained evidence untouched.
  const plans: unknown[] = [];
  const db = await pool.connect();
  try {
    await db.query("begin");
    await db.query(
      "create temp table hip4_account_executions(like public.hip4_account_executions including indexes including defaults) on commit drop",
    );
    await db.query(
      `insert into hip4_account_executions(environment,account_address,time_ms,coin,tid,oid,canonical_market_id,execution,fingerprint)
      select 'mainnet',case when series_row.n<=50000 then $1 else $2 end,series_row.n,'#133430',series_row.n,series_row.n,
      'hyperliquid:mainnet:outcome:13343','{}','fixture' from generate_series(1,100000) series_row(n)`,
      [address, foreignAddress],
    );
    await db.query(
      `insert into hip4_account_executions select * from public.hip4_account_executions where environment='mainnet' and account_address=$1`,
      [address],
    );
    await db.query("analyze hip4_account_executions");
    await db.query(
      `prepare hip4_social_guard(text,text,text,bigint,int) as ${HIP4_VERIFIED_BUY_FILLS_SQL}`,
    );
    for (const mode of ["force_custom_plan", "force_generic_plan"]) {
      await db.query(`set local plan_cache_mode=${mode}`);
      for (const orderId of [fill.oid, fill.oid + 1000000000]) {
        const plan = (
          await db.query(
            `explain(analyze,buffers,format json) execute hip4_social_guard('mainnet','${address}','#133430',${orderId},101)`,
          )
        ).rows[0]["QUERY PLAN"][0];
        const buffers =
          plan.Plan["Local Hit Blocks"] + plan.Plan["Local Read Blocks"];
        assert.ok(
          buffers < 128,
          "exact OID guard must not scan unrelated history",
        );
        assert.doesNotMatch(JSON.stringify(plan), /Seq Scan/u);
        plans.push({
          mode,
          rows: plan.Plan["Actual Rows"],
          ms: plan["Execution Time"],
          buffers,
        });
      }
    }
    const updatePlan = (
      await db.query(
        `explain(analyze,buffers,format json) update hip4_account_executions set provider_evidence_status=provider_evidence_status
      where environment='mainnet' and account_address=$1 and time_ms=$2 and coin=$3 and tid=$4 and oid=$5`,
        [address, fill.time, fill.coin, fill.tid, fill.oid],
      )
    ).rows[0]["QUERY PLAN"][0];
    assert.doesNotMatch(JSON.stringify(updatePlan), /Seq Scan/u);
    plans.push({
      updateMs: updatePlan["Execution Time"],
      buffers:
        updatePlan.Plan["Local Hit Blocks"] +
        updatePlan.Plan["Local Read Blocks"],
    });
  } finally {
    await db.query("rollback");
    db.release();
  }
  console.log(
    JSON.stringify({
      test: "hip4-execution-evidence-pg16",
      cases:
        "precise conflict, matching recovery, no source/empty/unrelated no-clear, sticky batch, full-set phantom guard, actual blocked-lock post-wait revision, 100k indexed plans",
      plans,
    }),
  );
} finally {
  await pool.query(
    "delete from hip4_account_snapshots where environment='mainnet' and account_address=$1",
    [address],
  );
  await pool.end();
}
