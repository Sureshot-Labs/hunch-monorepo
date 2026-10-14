// @requires-db
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { createIntegrationTestPool } from "../../../test-database-target.js";
import { hypercorePlanTestFixture } from "../../../funding-providers/relay/hypercore-plan-test-fixture.js";
import { buildRelayPlanningQuote } from "../../../funding-providers/relay/operation-plan.js";
import {
  claimHyperliquidFundingNonceInTransaction,
  HyperliquidNonceConflictError,
  HYPERLIQUID_FUNDING_NONCE_PAIR_SQL,
  loadValidatedHyperliquidFundingPair,
} from "../../execution/hyperliquid-nonce-claims.js";

const pool = await createIntegrationTestPool({
  max: 3,
  options: "-c statement_timeout=15000",
});
const schema = `hip4_nonce_${randomUUID().replaceAll("-", "")}`;
assert.match(schema, /^hip4_nonce_[a-f0-9]{32}$/);
const control = await pool.connect();
const first = await pool.connect();
const second = await pool.connect();
try {
  assert.equal(
    (
      await control.query("show server_version_num")
    ).rows[0].server_version_num.slice(0, 2),
    "16",
  );
  await control.query(`create schema ${schema}`);
  for (const client of [control, first, second])
    await client.query(`set search_path to ${schema}, public`);
  // Isolated schema: the production migration and repository execute unchanged.
  // No committed fixture or bulk plan data enters public financial tables.
  await control.query(`create table funding_operation_steps (
    id uuid primary key, operation_id uuid, segment_id uuid, step_kind text,
    executor_id text, action_fingerprint text, normalized_action jsonb,
    action_validation_result jsonb, depends_on_step_id uuid
  )`);
  await control.query(
    readFileSync(
      new URL(
        "../../../../../../packages/db/migrations/0288_hyperliquid_nonce_claims.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const firstPid = (await first.query("select pg_backend_pid() as pid")).rows[0]
    .pid as number;
  const secondPid = (await second.query("select pg_backend_pid() as pid"))
    .rows[0].pid as number;
  async function seed(at: Date) {
    const fixture = hypercorePlanTestFixture(at);
    const plan = await buildRelayPlanningQuote(fixture.input);
    const ids = [randomUUID(), randomUUID()];
    const operationId = randomUUID(),
      segmentId = randomUUID();
    for (const step of plan.commitPlan.steps) {
      await control.query(
        `insert into funding_operation_steps
        (id,operation_id,segment_id,step_kind,executor_id,action_fingerprint,
         normalized_action,action_validation_result,depends_on_step_id)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          ids[step.ordinal],
          operationId,
          segmentId,
          step.stepKind,
          step.executorId,
          step.actionFingerprint,
          step.normalizedAction,
          step.actionValidationResult,
          step.ordinal ? ids[0] : null,
        ],
      );
    }
    const sendId = ids[1];
    assert.ok(sendId);
    return sendId;
  }
  async function expectBlocked() {
    for (let poll = 0; poll < 80; poll++) {
      const result = await control.query(
        "select pg_blocking_pids($1) as blockers",
        [secondPid],
      );
      if ((result.rows[0].blockers as number[]).includes(firstPid)) return;
      await delay(25);
    }
    assert.fail("competing claim did not wait on the exact nonce constraint");
  }
  async function race(at: Date, winner: "commit" | "rollback") {
    const firstStep = await seed(at),
      secondStep = await seed(at);
    await first.query("begin");
    await second.query("begin");
    await claimHyperliquidFundingNonceInTransaction(first, firstStep);
    const contender = claimHyperliquidFundingNonceInTransaction(
      second,
      secondStep,
    ).then(
      () => ({ ok: true, error: null }),
      (error: unknown) => ({ ok: false, error }),
    );
    await expectBlocked();
    await first.query(winner);
    const result = await contender;
    assert.equal(result.ok, winner === "rollback");
    if (winner === "commit")
      assert.ok(result.error instanceof HyperliquidNonceConflictError);
    await second.query(result.ok ? "commit" : "rollback");
    const owner = winner === "commit" ? firstStep : secondStep;
    await claimHyperliquidFundingNonceInTransaction(control, owner);
    return owner;
  }
  const at = new Date();
  const retainedStep = await race(at, "commit");
  await race(new Date(at.getTime() + 1), "rollback");
  async function rejected(sql: string, values: unknown[], code: string) {
    await control.query("begin");
    try {
      await assert.rejects(
        control.query(sql, values),
        (error: unknown) =>
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === code,
      );
    } finally {
      await control.query("rollback");
    }
  }
  await rejected(
    "update hyperliquid_nonce_claims set nonce=nonce+1 where funding_step_id=$1",
    [retainedStep],
    "23514",
  );
  await rejected(
    "delete from hyperliquid_nonce_claims where funding_step_id=$1",
    [retainedStep],
    "23514",
  );
  await rejected(
    "delete from funding_operation_steps where id=$1",
    [retainedStep],
    "23503",
  );
  await rejected(
    `insert into hyperliquid_nonce_claims
    select environment, signer_address, nonce+1, action_fingerprint, funding_step_id, created_at
    from hyperliquid_nonce_claims where funding_step_id=$1`,
    [retainedStep],
    "23505",
  );
  await rejected(
    `insert into hyperliquid_nonce_claims
    select environment, '0x'||upper(substr(signer_address,3)), nonce+1, action_fingerprint, $2, created_at
    from hyperliquid_nonce_claims where funding_step_id=$1`,
    [retainedStep, await seed(new Date(at.getTime() + 2))],
    "23514",
  );
  // Same native nonce on a different environment is a distinct protocol key.
  const testnetStep = await seed(new Date(at.getTime() + 3));
  await control.query(
    `insert into hyperliquid_nonce_claims
    select 'testnet', signer_address, nonce, action_fingerprint, $2, created_at
    from hyperliquid_nonce_claims where funding_step_id=$1`,
    [retainedStep, testnetStep],
  );
  // Representative registry volume, including tied signer and absent owner/key.
  const retainedPair = await loadValidatedHyperliquidFundingPair(
    control,
    retainedStep,
  );
  const busySigner = retainedPair.validated.binding.owner.toLowerCase();
  await control.query(
    `with seeded_steps as (
    insert into funding_operation_steps(id)
    select gen_random_uuid() from generate_series(1,100000)
    returning id
  ) insert into hyperliquid_nonce_claims
    (environment,signer_address,nonce,action_fingerprint,funding_step_id)
    select 'mainnet', $1, row_number() over (), repeat('b',64), id
    from seeded_steps`,
    [busySigner],
  );
  await control.query("analyze hyperliquid_nonce_claims");
  await control.query("analyze funding_operation_steps");
  await control.query("set plan_cache_mode=force_generic_plan");
  await control.query(
    "prepare nonce_by_owner(uuid) as select * from hyperliquid_nonce_claims where funding_step_id=$1",
  );
  await control.query(
    "prepare nonce_by_key(text,text,bigint) as select * from hyperliquid_nonce_claims where environment=$1 and signer_address=$2 and nonce=$3",
  );
  await control.query(
    `prepare nonce_pair(uuid) as ${HYPERLIQUID_FUNDING_NONCE_PAIR_SQL}`,
  );
  const plans: { rows: number; executionMs: number; sharedBlocks: number }[] =
    [];
  for (const query of [
    `execute nonce_by_owner('${retainedStep}')`,
    `execute nonce_by_owner('${randomUUID()}')`,
    `execute nonce_by_key('mainnet','${busySigner}',99999)`,
    `execute nonce_by_key('mainnet','${busySigner}',100001)`,
  ]) {
    const explanation = (
      await control.query(`explain (analyze,buffers,format json) ${query}`)
    ).rows[0]["QUERY PLAN"][0];
    assert.equal(explanation.Plan["Node Type"], "Index Scan");
    assert.ok(explanation.Plan["Actual Rows"] <= 1);
    plans.push({
      rows: explanation.Plan["Actual Rows"],
      executionMs: explanation["Execution Time"],
      sharedBlocks:
        explanation.Plan["Shared Hit Blocks"] +
        explanation.Plan["Shared Read Blocks"],
    });
  }
  const pairPlans = [];
  for (const stepId of [retainedStep, randomUUID()]) {
    const explanation = (
      await control.query(
        `explain (analyze,buffers,format json) execute nonce_pair('${stepId}')`,
      )
    ).rows[0]["QUERY PLAN"][0];
    assert.equal(
      JSON.stringify(explanation).includes('"Node Type":"Seq Scan"'),
      false,
    );
    assert.ok(explanation.Plan["Actual Rows"] <= 2);
    pairPlans.push({
      rows: explanation.Plan["Actual Rows"],
      executionMs: explanation["Execution Time"],
      sharedBlocks:
        explanation.Plan["Shared Hit Blocks"] +
        explanation.Plan["Shared Read Blocks"],
    });
  }
  const migration = readFileSync(
    new URL(
      "../../../../../../packages/db/migrations/0289_hypercore_auth_admission.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const helper = migration.slice(
    migration.indexOf("as $$") + 5,
    migration.indexOf("$$;"),
  );
  const body = helper
    .replace(/\bcandidate_step_id\b/g, () => "$1")
    .replace(/\bcandidate_fingerprint\b/g, () => "$2")
    .replace(/\bcandidate_executor\b/g, () => "$3")
    .replace(/\bcandidate_submission\b/g, () => "$4");
  await control.query(`prepare auth_bound(uuid,text,text,jsonb) as ${body}`);
  const payload = retainedPair.auth.normalized_action.payload as Record<
    string,
    unknown
  >;
  const metadata = {
    version: 1,
    stage: "nonce_mapping",
    expiresAt: payload.expiresAt,
    pairFingerprint: retainedPair.validated.fingerprint,
    signer: busySigner,
    nonce: retainedPair.validated.binding.nonce,
  };
  const authPlans = [];
  for (const [stepId, meta, expected] of [
    [retainedPair.auth.id, metadata, true],
    [randomUUID(), metadata, false],
    [retainedPair.auth.id, { ...metadata, nonce: 100001 }, false],
    [retainedPair.auth.id, { ...metadata, nonce: "invalid" }, false],
  ] as const) {
    const command = `execute auth_bound('${stepId}','${retainedPair.auth.action_fingerprint}','${retainedPair.auth.executor_id}','${JSON.stringify(meta).replaceAll("'", "''")}')`;
    assert.equal((await control.query(command)).rows[0].coalesce, expected);
    const explanation = (
      await control.query(`explain(analyze,buffers,format json) ${command}`)
    ).rows[0]["QUERY PLAN"][0];
    assert.equal(
      JSON.stringify(explanation).includes('"Node Type":"Seq Scan"'),
      false,
    );
    const blocks =
      explanation.Plan["Shared Hit Blocks"] +
      explanation.Plan["Shared Read Blocks"];
    assert.ok(
      blocks < 100,
      "helper must not scan 100k nonce claims for one signer",
    );
    authPlans.push({
      expected,
      executionMs: explanation["Execution Time"],
      sharedBlocks: blocks,
    });
  }
  // Install only the pure auth helper in this isolated schema; no production
  // triggers are replaced. Exercise 0291 and its actual generic query body.
  await control.query(migration.slice(0, migration.indexOf("$$;") + 3));
  const sendMigration = readFileSync(
    new URL(
      "../../../../../../packages/db/migrations/0291_hypercore_send_attempt_binding.sql",
      import.meta.url,
    ),
    "utf8",
  );
  await control.query(sendMigration);
  const sendBody = sendMigration
    .slice(sendMigration.indexOf("as $$") + 5, sendMigration.indexOf("$$;"))
    .replace(/\bcandidate_step_id\b/g, () => "$1")
    .replace(/\bcandidate_fingerprint\b/g, () => "$2")
    .replace(/\bcandidate_executor\b/g, () => "$3")
    .replace(/\bcandidate_submission\b/g, () => "$4");
  await control.query(
    `prepare send_bound(uuid,text,text,jsonb) as ${sendBody}`,
  );
  const sendMeta = { ...metadata, stage: "send_asset" };
  const sendPlans = [];
  for (const [stepId, meta, expected] of [
    [retainedStep, sendMeta, true],
    [randomUUID(), sendMeta, false],
    [retainedStep, { ...sendMeta, nonce: 100001 }, false],
    [retainedStep, { ...sendMeta, stage: "nonce_mapping" }, false],
    [
      retainedStep,
      { ...sendMeta, expiresAt: "2099-01-01T00:00:00.000Z" },
      false,
    ],
  ] as const) {
    const values = [
      stepId,
      retainedPair.send.action_fingerprint,
      retainedPair.send.executor_id,
      meta,
    ];
    assert.equal(
      (
        await control.query(
          "select funding_native_send_attempt_bound($1,$2,$3,$4) as bound",
          values,
        )
      ).rows[0].bound,
      expected,
    );
    const command = `execute send_bound('${stepId}','${retainedPair.send.action_fingerprint}','${retainedPair.send.executor_id}','${JSON.stringify(meta).replaceAll("'", "''")}')`;
    assert.equal((await control.query(command)).rows[0].coalesce, expected);
    const explanation = (
      await control.query(`explain(analyze,buffers,format json) ${command}`)
    ).rows[0]["QUERY PLAN"][0];
    assert.equal(
      JSON.stringify(explanation).includes('"Node Type":"Seq Scan"'),
      false,
    );
    const blocks =
      explanation.Plan["Shared Hit Blocks"] +
      explanation.Plan["Shared Read Blocks"];
    assert.ok(
      blocks < 150,
      "exact send admission cannot scan the signer history",
    );
    sendPlans.push({
      expected,
      executionMs: explanation["Execution Time"],
      sharedBlocks: blocks,
    });
  }
  console.log(
    JSON.stringify({
      suite: "hyperliquid-nonce-pg16",
      races: 2,
      registryRows: 100003,
      plans,
      pairPlans,
      authPlans,
      sendPlans,
    }),
  );
} finally {
  // Exact generated test schema only, with an immediate read-only preflight.
  for (const client of [first, second, control]) await client.query("rollback");
  const target = await control.query(
    "select nspname from pg_namespace where nspname=$1",
    [schema],
  );
  if (target.rows[0]?.nspname === schema)
    await control.query(`drop schema ${schema} cascade`);
  first.release();
  second.release();
  control.release();
  await pool.end();
}
