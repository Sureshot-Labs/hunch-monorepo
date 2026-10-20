// @requires-db — disposable PG16 resource schema only; no external transport.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createPgPool } from "@hunch/infra";
import { hip4ReadPolicySchema } from "@hunch/shared";
import {
  createIntegrationTestPool,
  integrationDatabaseTargetFromEnv,
  verifyIntegrationDatabaseTarget,
} from "./test-database-target.js";
import {
  reserveHip4Request,
  HIP4_RENEW_REQUEST_RESERVATION_SQL,
} from "./services/hip4-repository.js";
import { reserveHip4AccountCashBudget } from "./services/hip4-account-cash-budget.js";

const target = integrationDatabaseTargetFromEnv();
const control = await createIntegrationTestPool({
  max: 1,
  options: "-c statement_timeout=5000",
});
const schemaName = `hip4_cash_${randomUUID().replaceAll("-", "")}`;
assert.match(schemaName, /^hip4_cash_[a-f0-9]{32}$/u);
const pool = createPgPool({
  connectionString: target.databaseUrl,
  max: 4,
  options: `-c search_path=${schemaName},public -c statement_timeout=5000 -c lock_timeout=3000`,
});
const policy = hip4ReadPolicySchema.parse({
  enabled: true,
  requestWeightPerMinute: 1200,
  interactiveRequestWeightReserveRatio: 0.75,
});
const background = {
  scope: "background_repair" as const,
  maximum: 220,
  backgroundMaximum: 300,
};
const usage = async () =>
  Number(
    (
      await pool.query(
        `select coalesce(sum((admission_row->>'weight')::int),0)::int as used_weight
         from hip4_request_budget cross join lateral jsonb_array_elements(admissions) admission_row
         where (admission_row->>'at')::numeric>extract(epoch from clock_timestamp())-60`,
      )
    ).rows[0].used_weight,
  );
const reserve = (weight: number) =>
  reserveHip4Request(pool, "mainnet", weight, 1200, background);
const cashBudget = () =>
  reserveHip4AccountCashBudget({
    background: true,
    recheck: async () => policy,
    reserve,
  });
const clearFixture = async () => {
  await pool.query("delete from hip4_request_budget where scope='public-info'");
};
let created = false;
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
  created = true;
  await control.query(
    `create table ${schemaName}.hip4_request_budget(like public.hip4_request_budget including all)`,
  );
  await verifyIntegrationDatabaseTarget(pool, target);

  // Reproduce the live202-weight partial prefixes without spending any more
  // provider weight. A denied complete phase performs zero transport work.
  assert.ok(await reserve(202));
  let transports = 0;
  await assert.rejects(async () => {
    const budget = await cashBudget();
    await budget.admit(60);
    transports++;
  }, /budget_exhausted/u);
  assert.equal(transports, 0);
  assert.equal(await usage(), 202);

  // Expire only this disposable resource fixture, without sleeps or touching
  // the real account/budget. The next normal attempt can complete all reads.
  await pool.query(`update hip4_request_budget set admissions=(
    select jsonb_agg(admission_row || jsonb_build_object('at',extract(epoch from clock_timestamp())-61))
    from jsonb_array_elements(admissions) admission_row) where scope='public-info'`);
  const recovered = await cashBudget();
  for (const weight of [60, 20, 20, 20, 20, 2, 20, 20]) {
    assert.equal(await recovered.admit(weight), true);
    transports++;
  }
  await recovered.settle();
  assert.equal(transports, 8);
  assert.equal(await usage(), 182);
  await assert.rejects(recovered.admit(2), /budget_exhausted/u);

  await clearFixture();
  const raced = await Promise.allSettled([cashBudget(), cashBudget()]);
  assert.equal(
    raced.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal(await usage(), 182);
  const winner = raced.find((result) => result.status === "fulfilled");
  assert.ok(winner && winner.status === "fulfilled");
  for (const weight of [60, 20, 20, 2, 2, 20]) await winner.value.admit(weight);
  await winner.value.settle();
  assert.equal(await usage(), 124, "Standard refunds only its unused58 bound");

  // A prepaid phase keeps its resource weight for60s AFTER its last attempted
  // dispatch. Renewal cannot amend another, settled or expired reservation.
  await clearFixture();
  const renewable = await reserve(182);
  assert.ok(renewable);
  const entry = (
    await pool.query(
      "select admissions->0 as admission_record from hip4_request_budget",
    )
  ).rows[0].admission_record;
  await pool.query(`update hip4_request_budget set admissions=jsonb_build_array(
    (admissions->0) || jsonb_build_object('at',extract(epoch from clock_timestamp())-59))
    where scope='public-info'`);
  assert.equal(await renewable.renew(), true);
  const renewed = (
    await pool.query(`select admissions->0 as admission_record,
      extract(epoch from clock_timestamp())-(admissions->0->>'at')::numeric as admission_age
      from hip4_request_budget where scope='public-info'`)
  ).rows[0];
  assert.ok(
    Number(renewed.admission_age) >= 0 && Number(renewed.admission_age) < 2,
  );
  assert.equal(renewed.admission_record.reservationId, entry.reservationId);
  assert.equal(renewed.admission_record.weight, 182);
  assert.equal(await reserveHip4Request(pool, "mainnet", 1019, 1200), false);
  for (const values of [
    [randomUUID(), 182, 950],
    [entry.reservationId, 181, 950],
  ])
    assert.equal(
      (await pool.query(HIP4_RENEW_REQUEST_RESERVATION_SQL, values)).rowCount,
      0,
    );
  await renewable.settle(124);
  assert.equal(await renewable.renew(), false);
  assert.equal(await usage(), 124);

  await clearFixture();
  const expired = await reserve(182);
  assert.ok(expired);
  await pool.query(`update hip4_request_budget set admissions=jsonb_build_array(
    (admissions->0) || jsonb_build_object('at',extract(epoch from clock_timestamp())-61))
    where scope='public-info'`);
  assert.equal(await expired.renew(), false);
  assert.equal(await usage(), 0);

  // A harmless tuple lock must be acquired BEFORE the volatile renewal time
  // is evaluated. Otherwise dispatch after that wait can age out too early.
  await clearFixture();
  const lockClient = await pool.connect();
  const renewalClient = await pool.connect();
  let contendedRenewal: Promise<boolean> | undefined;
  try {
    const contendedReceipt = await reserveHip4Request(
      renewalClient,
      "mainnet",
      182,
      1200,
      background,
    );
    assert.ok(contendedReceipt);
    const renewalPid = Number(
      (await renewalClient.query("select pg_backend_pid() as backend_pid"))
        .rows[0].backend_pid,
    );
    await lockClient.query("begin");
    await lockClient.query(
      "select scope from hip4_request_budget where scope='public-info' for update",
    );
    contendedRenewal = contendedReceipt.renew();
    let observedLockWait = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      observedLockWait =
        (
          await pool.query(
            "select wait_event_type='Lock' as waiting from pg_stat_activity where pid=$1",
            [renewalPid],
          )
        ).rows[0]?.waiting === true;
      if (observedLockWait) break;
      await delay(5);
    }
    assert.equal(observedLockWait, true, "renewal is genuinely lock-contended");
    await delay(500);
    await lockClient.query("rollback");
    assert.equal(await contendedRenewal, true);
    const contendedAge = Number(
      (
        await pool.query(`select extract(epoch from clock_timestamp())-
          (admissions->0->>'at')::numeric as admission_age
          from hip4_request_budget where scope='public-info'`)
      ).rows[0].admission_age,
    );
    assert.ok(
      contendedAge >= 0 && contendedAge < 0.25,
      `renewal time must follow tuple-lock wait, actual age ${contendedAge}s`,
    );
  } finally {
    await lockClient.query("rollback");
    if (contendedRenewal) await contendedRenewal;
    lockClient.release();
    renewalClient.release();
  }

  // Representative maximal array: one182-weight phase and1018 weight-one
  // requests fill the unchanged1200 cap. EXPLAIN ANALYZE writes this fixture
  // only and proves PostgreSQL parses/executes the actual renewal statement.
  await clearFixture();
  const planReceipt = await reserve(182);
  assert.ok(planReceipt);
  const planEntry = (
    await pool.query(
      "select admissions->0 as admission_record from hip4_request_budget",
    )
  ).rows[0].admission_record;
  await pool.query(`update hip4_request_budget set admissions=admissions || (
    select jsonb_agg(jsonb_build_object('at',extract(epoch from clock_timestamp()),'weight',1,'consumer',null))
    from generate_series(1,1018)) where scope='public-info'`);
  assert.equal(await usage(), 1200);
  const explained = await pool.query(
    `explain (analyze,buffers,format json) ${HIP4_RENEW_REQUEST_RESERVATION_SQL}`,
    [planEntry.reservationId, 182, 950],
  );
  const plan = explained.rows[0]["QUERY PLAN"][0];
  assert.equal(plan.Plan["Actual Rows"], 1);
  assert.equal(await usage(), 1200);
  console.log("hip4 cash budget PG16 checks passed", {
    transports,
    renewalArrayEntries: 1019,
    renewalExecutionMs: plan["Execution Time"],
    renewalSharedHitBlocks: plan.Plan["Shared Hit Blocks"],
    nodeType: plan.Plan["Node Type"],
  });
} finally {
  await pool.end();
  if (created) await control.query(`drop schema ${schemaName} cascade`);
  await control.end();
}
