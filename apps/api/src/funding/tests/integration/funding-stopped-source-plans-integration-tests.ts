// @requires-db
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createIntegrationTestPool } from "../../../test-database-target.js";
import { STOPPED_SOURCE_RESERVATIONS_SQL } from "../../reconciliation/funding-reducer.js";
import { nativeSourceDebitPendingSql } from "../../persistence/source-reservation-hold.js";

const pool = await createIntegrationTestPool({
  max: 1,
  options: "-c statement_timeout=15000",
});
const client = await pool.connect();
try {
  await client.query("begin");
  assert.equal(
    (
      await client.query("show server_version_num")
    ).rows[0].server_version_num.slice(0, 2),
    "16",
  );
  // Same relevant indexed columns as the real schema; temporary relations and
  // transaction rollback ensure no synthetic money enters the local ledger.
  await client.query(`
    create temporary table balance_reservations (
      id uuid primary key, operation_id uuid, component_id text, segment_id uuid,
      state text, mode text, expires_at timestamptz not null
    ) on commit drop;
    create unique index on balance_reservations(operation_id,component_id,mode);
    create index on balance_reservations(segment_id,state) where segment_id is not null;
    create index on balance_reservations(expires_at) where state='active';
    create temporary table funding_operation_steps (
      id uuid primary key, operation_id uuid, segment_id uuid, depends_on_step_id uuid,
      ordinal int, step_kind text, action_validation_result jsonb,
      executor_id text, action_fingerprint text, normalized_action jsonb
    ) on commit drop;
    create unique index on funding_operation_steps(operation_id,ordinal);
    create unique index on funding_operation_steps(operation_id,id);
    create temporary table funding_operation_step_attempts (
      id uuid primary key, step_id uuid, attempt_number int,
      outcome text, broadcast_may_have_occurred boolean,
      reference_kind text, receipt_ref_ciphertext text, receipt_ref_lookup_hmac text,
      lookup_key_version int, canonical_action_fingerprint text, executor_id text, actual_costs jsonb
    ) on commit drop;
    create unique index on funding_operation_step_attempts(step_id,attempt_number);
    create temporary table funding_step_receipt_observations (
      attempt_id uuid unique, status text, canonical boolean, action_match boolean, evidence jsonb
    ) on commit drop;
    create temporary table funding_observations (
      operation_id uuid, segment_id uuid, kind text, observed_at timestamptz,
      canonical boolean, finality_status text, network_id text default 'evm:8453',
      asset_id text default 'usdc-fixture', asset_decimals int default 6
    ) on commit drop;
    create index on funding_observations(operation_id,kind,observed_at);
    create temporary table source_plan_seed as select
      gen_random_uuid() as operation_id, gen_random_uuid() as segment_id,
      gen_random_uuid() as step_id, gen_random_uuid() as attempt_id
      from generate_series(1,50000);
    insert into balance_reservations
      select gen_random_uuid(),operation_id,'cash',segment_id,'active','subtract_available',now()+interval '1 hour'
      from source_plan_seed;
    insert into funding_operation_steps(id,operation_id,segment_id,depends_on_step_id,ordinal,step_kind,action_validation_result)
      select step_id,operation_id,segment_id,null,0,'transaction','{}' from source_plan_seed;
    insert into funding_operation_step_attempts(id,step_id,attempt_number,outcome,broadcast_may_have_occurred)
      select attempt_id,step_id,1,'ambiguous',true from source_plan_seed;
    insert into funding_step_receipt_observations
      select attempt_id,'pending',true,false,'{}' from source_plan_seed;
    insert into funding_observations(operation_id,segment_id,kind,observed_at,canonical,finality_status)
      select operation_id,segment_id,'source_debit',now(),false,'observed' from source_plan_seed;
  `);
  const ambiguous = (
    await client.query(
      "select operation_id,segment_id from source_plan_seed limit 1",
    )
  ).rows[0];
  await client.query(
    `insert into funding_operation_steps(id,operation_id,segment_id,depends_on_step_id,ordinal,step_kind,action_validation_result)
    values($1,$2,$3,null,1,'signature','{}')`,
    [randomUUID(), ambiguous.operation_id, ambiguous.segment_id],
  );
  const stopped = { operation: randomUUID(), segment: randomUUID() };
  const expired = { operation: randomUUID(), segment: randomUUID() };
  for (const [target, isExpired] of [
    [stopped, false],
    [expired, true],
  ] as const) {
    await client.query(
      `insert into balance_reservations values($1,$2,'cash',$3,'active','subtract_available',$4)`,
      [
        randomUUID(),
        target.operation,
        target.segment,
        new Date(Date.now() + (isExpired ? -60000 : 60000)),
      ],
    );
  }
  for (const table of [
    "balance_reservations",
    "funding_operation_steps",
    "funding_operation_step_attempts",
    "funding_step_receipt_observations",
    "funding_observations",
  ])
    await client.query(`analyze ${table}`);
  await client.query("set local plan_cache_mode=force_generic_plan");
  await client.query(
    `prepare stopped_source_plan(uuid,uuid[]) as ${STOPPED_SOURCE_RESERVATIONS_SQL}`,
  );
  const results = [];
  for (const [operation, segments, expectedRows] of [
    [ambiguous.operation_id, [ambiguous.segment_id], 0],
    [stopped.operation, [stopped.segment], 1],
    [stopped.operation, [], 0],
    [expired.operation, [], 1],
    [randomUUID(), [], 0],
  ] as const) {
    assert.match(operation, /^[a-f0-9-]{36}$/);
    for (const segment of segments) assert.match(segment, /^[a-f0-9-]{36}$/);
    const explanation = (
      await client.query(`explain(analyze,buffers,format json)
      execute stopped_source_plan('${operation}','{${segments.join(",")}}')`)
    ).rows[0]["QUERY PLAN"][0];
    assert.equal(explanation.Plan["Actual Rows"], expectedRows);
    assert.equal(
      JSON.stringify(explanation).includes('"Node Type":"Seq Scan"'),
      false,
    );
    results.push({
      rows: expectedRows,
      executionMs: explanation["Execution Time"],
      localBlocks:
        explanation.Plan["Local Hit Blocks"] +
        explanation.Plan["Local Read Blocks"],
    });
  }
  console.log(
    JSON.stringify({
      suite: "funding-stopped-source-plans-pg16",
      unrelatedRowsPerTable: 50000,
      results,
    }),
  );
  await client.query(`update funding_operation_steps set executor_id='wallet_profile_evm_v1',
    action_validation_result='{"relayNativeDestination":"hyperliquid:mainnet","relayStepKind":"deposit","postconditionEvidenceKind":"exact_erc20_source_debit_v1"}'
    where step_kind='transaction'`);
  await client.query("analyze funding_operation_steps");
  await client.query(`prepare native_inbound_release_plan(uuid) as
    select reservation.id from (
      select source_reservation.*, 'evm:8453'::text as network_id,
        'usdc-fixture'::text as asset_id, 6 as asset_decimals
      from balance_reservations source_reservation
    ) reservation where reservation.operation_id=$1 and reservation.state='active'
      and not ${nativeSourceDebitPendingSql("reservation")}`);
  const inboundResults = [];
  for (const [operationId, expectedRows] of [
    [ambiguous.operation_id, 0],
    [stopped.operation, 1],
    [randomUUID(), 0],
  ] as const) {
    assert.match(operationId, /^[a-f0-9-]{36}$/);
    const explanation = (
      await client.query(`explain(analyze,buffers,format json)
      execute native_inbound_release_plan('${operationId}')`)
    ).rows[0]["QUERY PLAN"][0];
    assert.equal(explanation.Plan["Actual Rows"], expectedRows);
    assert.equal(
      JSON.stringify(explanation).includes('"Node Type":"Seq Scan"'),
      false,
    );
    inboundResults.push({
      rows: expectedRows,
      executionMs: explanation["Execution Time"],
      localBlocks:
        explanation.Plan["Local Hit Blocks"] +
        explanation.Plan["Local Read Blocks"],
    });
  }
  console.log(
    JSON.stringify({
      suite: "native-inbound-source-release-pg16",
      unrelatedRowsPerTable: 50000,
      results: inboundResults,
    }),
  );
} finally {
  await client.query("rollback");
  client.release();
  await pool.end();
}
