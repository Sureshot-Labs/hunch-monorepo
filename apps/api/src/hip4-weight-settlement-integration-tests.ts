// @requires-db — disposable PostgreSQL16, isolated resource-only schema, mocked IO.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createPgPool } from "@hunch/infra";
import { hip4ReadPolicySchema } from "@hunch/shared";
import {
  createIntegrationTestPool,
  integrationDatabaseTargetFromEnv,
  verifyIntegrationDatabaseTarget,
} from "./test-database-target.js";
import {
  reserveHip4Request,
  admitHip4Request,
  HIP4_SETTLE_REQUEST_WEIGHT_SQL,
} from "./services/hip4-repository.js";
import { createHip4AccountClient } from "./services/hip4-client.js";

const control = await createIntegrationTestPool({
  max: 1,
  options: "-c statement_timeout=5000",
});
const target = integrationDatabaseTargetFromEnv();
const schemaName = `hip4_weight_${randomUUID().replaceAll("-", "")}`;
assert.match(schemaName, /^hip4_weight_[a-f0-9]{32}$/u);
const pool = createPgPool({
  connectionString: target.databaseUrl,
  max: 4,
  options: `-c search_path=${schemaName},public -c statement_timeout=5000 -c lock_timeout=3000`,
});
const policy = hip4ReadPolicySchema.parse({});
const background = {
  scope: "background_repair" as const,
  maximum: 220,
  backgroundMaximum: 300,
};
const usage = async () =>
  Number(
    (
      await pool.query(
        "select coalesce(sum((admission_row->>'weight')::int),0)::int as used_weight from hip4_request_budget cross join lateral jsonb_array_elements(admissions) admission_row",
      )
    ).rows[0].used_weight,
  );
const fill = {
  coin: "#14731",
  px: "0.5",
  sz: "2",
  side: "B",
  time: 10,
  startPosition: "0",
  dir: "Buy",
  closedPnl: "0",
  hash: `0x${"cd".repeat(32)}`,
  oid: 1,
  crossed: true,
  fee: "0.0001",
  tid: 1,
  feeToken: "USDC",
  cloid: null,
};
const request = {
  type: "userFillsByTime" as const,
  user: `0x${"ab".repeat(20)}`,
  startTime: 0,
  endTime: 100,
  aggregateByTime: false as const,
};
let schemaCreated = false;
try {
  assert.match(
    (await control.query("show server_version")).rows[0].server_version,
    /^16\./u,
  );
  assert.equal(
    (
      await control.query("select to_regnamespace($1) as existing_schema", [
        schemaName,
      ])
    ).rows[0].existing_schema,
    null,
  );
  await control.query(`create schema ${schemaName}`);
  schemaCreated = true;
  await control.query(
    `create table ${schemaName}.hip4_request_budget(like public.hip4_request_budget including all)`,
  );
  await verifyIntegrationDatabaseTarget(pool, target);
  for (const weight of [0, -1, 1.5, NaN, Infinity, 1201])
    assert.equal(
      await reserveHip4Request(pool, "mainnet", weight, 1200),
      false,
    );
  assert.equal(
    (
      await pool.query(
        "select count(*)::int as row_count from hip4_request_budget",
      )
    ).rows[0].row_count,
    0,
  );

  // Four connections race on one physical rolling budget; at most one120
  // reservation can fit the220 background class before either is settled.
  const raced = await Promise.all(
    Array.from({ length: 4 }, () =>
      reserveHip4Request(pool, "mainnet", 120, 1200, background),
    ),
  );
  assert.equal(raced.filter(Boolean).length, 1);
  assert.equal(await usage(), 120);
  const receipt = raced.find((value) => value !== false);
  assert.ok(receipt);
  const original = (
    await pool.query(
      "select admissions->0 as admission_record from hip4_request_budget",
    )
  ).rows[0].admission_record;
  assert.match(original.reservationId, /^[a-f0-9-]{36}$/u);
  for (const invalid of [0, 19, -1, 1.5, NaN, Infinity, 121])
    await receipt.settle(invalid);
  assert.equal(await usage(), 120);
  await Promise.all([
    receipt.settle(21),
    receipt.settle(21),
    receipt.settle(20),
  ]);
  assert.ok([20, 21].includes(await usage()));
  const settled = (
    await pool.query(
      "select admissions->0 as admission_record from hip4_request_budget",
    )
  ).rows[0].admission_record;
  assert.equal(settled.at, original.at);
  assert.equal(settled.consumer, original.consumer);
  assert.equal(settled.reservedWeight, 120);
  const once = await usage();
  await receipt.settle(20);
  assert.equal(
    await usage(),
    once,
    "only the first successful amendment may change this reservation",
  );
  await pool.query(HIP4_SETTLE_REQUEST_WEIGHT_SQL, [
    original.reservationId,
    120,
    1,
    1000,
  ]);
  assert.equal(
    await usage(),
    once,
    "SQL itself rejects a below-base amendment",
  );
  await pool.query(HIP4_SETTLE_REQUEST_WEIGHT_SQL, [
    original.reservationId,
    119,
    20,
    1000,
  ]);
  assert.equal(
    await usage(),
    once,
    "wrong original reservation cannot amend an entry",
  );
  await pool.query(HIP4_SETTLE_REQUEST_WEIGHT_SQL, [
    randomUUID(),
    120,
    20,
    1000,
  ]);
  assert.equal(await usage(), once);

  // A new process/client can use the remaining shared capacity after each
  // fully validated small page, rather than charging120 again and starving.
  let transports = 0;
  const client = createHip4AccountClient(
    policy,
    (weight) => reserveHip4Request(pool, "mainnet", weight, 1200, background),
    async () => {
      transports++;
      return Response.json([fill, fill]);
    },
  );
  await client(request);
  await client(request);
  assert.equal(transports, 2);
  assert.equal(await usage(), once + 42);
  const reservations = (
    await pool.query("select admissions from hip4_request_budget")
  ).rows[0].admissions;
  assert.equal(
    new Set(
      reservations.map(
        (entry: { reservationId: string }) => entry.reservationId,
      ),
    ).size,
    3,
  );

  const expired = await reserveHip4Request(
    pool,
    "mainnet",
    120,
    1200,
    background,
  );
  assert.ok(expired);
  const freshEntry = (
    await pool.query(
      "select admissions->-1 as admission_record from hip4_request_budget",
    )
  ).rows[0].admission_record;
  const beforeInvalidSql = await usage();
  await pool.query(HIP4_SETTLE_REQUEST_WEIGHT_SQL, [
    freshEntry.reservationId,
    120,
    1,
    1000,
  ]);
  await pool.query(HIP4_SETTLE_REQUEST_WEIGHT_SQL, [
    freshEntry.reservationId,
    120,
    121,
    1000,
  ]);
  await pool.query(HIP4_SETTLE_REQUEST_WEIGHT_SQL, [
    freshEntry.reservationId,
    119,
    20,
    1000,
  ]);
  await pool.query(HIP4_SETTLE_REQUEST_WEIGHT_SQL, [
    randomUUID(),
    120,
    20,
    1000,
  ]);
  assert.equal(
    await usage(),
    beforeInvalidSql,
    "fresh unsettled reservations reject below-base, upward, wrong-original and unknown-ID SQL amendments",
  );
  assert.equal(
    (
      await pool.query(
        "select admissions->-1 ? 'settledWeight' as marked_settled from hip4_request_budget",
      )
    ).rows[0].marked_settled,
    false,
  );
  await pool.query(
    "update hip4_request_budget set admissions=(select jsonb_agg(admission_row||jsonb_build_object('at',extract(epoch from statement_timestamp())-61)) from jsonb_array_elements(admissions) admission_row)",
  );
  const beforeExpired = (
    await pool.query("select admissions from hip4_request_budget")
  ).rows[0].admissions;
  await expired.settle(20);
  assert.deepEqual(
    (await pool.query("select admissions from hip4_request_budget")).rows[0]
      .admissions,
    beforeExpired,
    "expired reservations are never revived or amended",
  );
  assert.equal(
    await admitHip4Request(pool, "testnet", 1200, 1200),
    true,
    "normal admission prunes the expired rolling window",
  );
  assert.equal(await reserveHip4Request(pool, "mainnet", 1, 1200), false);

  // The budget row is PK-bounded even with thousands of unrelated scopes.
  // Positive settlement uses the largest live tail fitting a120 reservation;
  // a missing ID scans the full1200-entry bound without broad-table work.
  await pool.query(
    "update hip4_request_budget set admissions=(select jsonb_agg(jsonb_build_object('at',extract(epoch from statement_timestamp()),'weight',1)) from generate_series(1,1080))",
  );
  const planId = randomUUID();
  await pool.query(
    "update hip4_request_budget set admissions=admissions||jsonb_build_array(jsonb_build_object('at',extract(epoch from statement_timestamp()),'weight',120,'reservedWeight',120,'reservationId',$1::text))",
    [planId],
  );
  await pool.query(
    "insert into hip4_request_budget(scope,admissions) select 'unrelated-'||scope_number,'[]'::jsonb from generate_series(1,5000) scope_number",
  );
  await pool.query("analyze hip4_request_budget");
  const plan = await pool.query(
    `explain(analyze,buffers,format json) ${HIP4_SETTLE_REQUEST_WEIGHT_SQL}`,
    [planId, 120, 21, 1000],
  );
  const root = plan.rows[0]["QUERY PLAN"][0];
  assert.ok(JSON.stringify(root).includes("hip4_request_budget_pkey"));
  assert.equal(await usage(), 1101);
  console.log("[hip4-weight-settlement-plan]", {
    entries: 1081,
    unrelatedScopes: 5000,
    ms: root["Execution Time"],
    buffers: root.Plan["Shared Hit Blocks"],
  });
  await pool.query(
    "update hip4_request_budget set admissions=(select jsonb_agg(jsonb_build_object('at',extract(epoch from statement_timestamp()),'weight',1)) from generate_series(1,1200)) where scope='public-info'",
  );
  const missingPlan = await pool.query(
    `explain(analyze,buffers,format json) ${HIP4_SETTLE_REQUEST_WEIGHT_SQL}`,
    [randomUUID(), 120, 21, 1000],
  );
  const missing = missingPlan.rows[0]["QUERY PLAN"][0];
  assert.ok(JSON.stringify(missing).includes("hip4_request_budget_pkey"));
  assert.equal(await usage(), 1200);
  console.log("[hip4-weight-settlement-plan]", {
    entries: 1200,
    missing: true,
    ms: missing["Execution Time"],
    buffers: missing.Plan["Shared Hit Blocks"],
  });
  await pool.query(
    "update hip4_request_budget set admissions=(select jsonb_agg(admission_row||jsonb_build_object('at',extract(epoch from statement_timestamp())-61)) from jsonb_array_elements(admissions) admission_row) where scope='public-info'",
  );
  const singlePool = createPgPool({
    connectionString: target.databaseUrl,
    max: 1,
    options: `-c search_path=${schemaName},public -c statement_timeout=5000 -c lock_timeout=3000`,
  });
  const holder = await control.connect();
  let locked = false;
  try {
    const deadline = Date.now() + 250;
    const contendedRead = createHip4AccountClient(
      policy,
      (weight) =>
        reserveHip4Request(singlePool, "mainnet", weight, 1200, background),
      async () => {
        await holder.query("begin");
        locked = true;
        await holder.query(
          `select scope from ${schemaName}.hip4_request_budget where scope='public-info' for update`,
        );
        return Response.json([fill, fill]);
      },
      { deadlineMs: deadline },
    );
    const started = Date.now();
    assert.deepEqual(await contendedRead(request), [fill, fill]);
    assert.ok(
      Date.now() - started < 1500,
      "a contended optional settlement cannot hold a valid response behind the server lock timeout",
    );
    const nextQueryStarted = Date.now();
    await singlePool.query("select 1");
    assert.ok(
      Date.now() - nextQueryStarted < 500,
      "server-side LOCAL lock_timeout releases the sole pooled connection before the external lock is released",
    );
    const lockTimeout = (await singlePool.query("show lock_timeout")).rows[0]
      .lock_timeout;
    assert.equal(
      lockTimeout,
      "3s",
      "autocommit restores the pooled connection's original timeout",
    );
    await holder.query("rollback");
    locked = false;
    assert.ok(
      (await usage()) === 120,
      "a server-cancelled optional settlement retains the entire reservation",
    );
  } finally {
    if (locked) await holder.query("rollback");
    holder.release();
    await singlePool.end();
  }
  console.log(
    "[hip4-weight-settlement] concurrent120 reservations, exact-ID/one-shot/lower-only charges, originaltime/class, clientsmallpages, expiry and bounded PK plans passed",
  );
} finally {
  await pool.end();
  if (schemaCreated) {
    const objects = await control.query(
      "select table_name from information_schema.tables where table_schema=$1",
      [schemaName],
    );
    assert.deepEqual(
      objects.rows.map((row) => row.table_name),
      ["hip4_request_budget"],
    );
    await control.query(`drop table ${schemaName}.hip4_request_budget`);
    await control.query(`drop schema ${schemaName}`);
  }
  await control.end();
}
