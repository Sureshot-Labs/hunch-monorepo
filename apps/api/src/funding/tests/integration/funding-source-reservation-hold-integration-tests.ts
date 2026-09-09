#!/usr/bin/env tsx
// @requires-db
import assert from "node:assert/strict";
import { createIntegrationTestPool } from "../../../test-database-target.js";
import { fundingReservationHoldSql } from "../../persistence/source-reservation-hold.js";

const pool = await createIntegrationTestPool({ max: 1 });
const client = await pool.connect();
try {
  await client.query("begin");
  // Temporary relations isolate predicate tests from persisted financial data.
  await client.query(`
    create temporary table funding_operation_steps (
      id text, operation_id text, segment_id text, depends_on_step_id text,
      step_kind text, action_validation_result jsonb
    ) on commit drop;
    create temporary table funding_operation_step_attempts (
      id text, step_id text, outcome text, broadcast_may_have_occurred boolean,
      actual_costs jsonb not null default '{}'
    ) on commit drop;
    create temporary table funding_step_receipt_observations (
      attempt_id text, status text, canonical boolean, action_match boolean, evidence jsonb
    ) on commit drop;
    insert into funding_operation_steps values
      ('prepare', 'op', null, null, 'venue_preparation', '{}'),
      ('sol', 'op', 'sol-lane', null, 'transaction', '{}'),
      ('base', 'op', 'base-lane', null, 'transaction', '{}');
    insert into funding_operation_step_attempts (id, step_id, outcome, broadcast_may_have_occurred) values
      ('prep-attempt', 'prepare', 'ambiguous', true),
      ('sol-attempt', 'sol', 'ambiguous', true);
    insert into funding_step_receipt_observations values
      ('prep-attempt', 'finalized', true, true, '{}');
  `);
  async function held(segment: string | null): Promise<boolean> {
    const result = await client.query<{ held: boolean }>(
      `
      select ${fundingReservationHoldSql("reservation")} as held
      from (select 'op'::text as operation_id, $1::text as segment_id,
        'subtract_available'::text as mode, now() - interval '1 second' as expires_at) reservation
    `,
      [segment],
    );
    const row = result.rows[0];
    assert.ok(row);
    return row.held;
  }
  assert.equal(
    await held("base-lane"),
    false,
    "independent completed preparation must not lock untouched Base",
  );
  assert.equal(
    await held("sol-lane"),
    true,
    "unknown Solana send remains held",
  );
  assert.equal(
    await held(null),
    true,
    "unscoped historical reservation remains conservative",
  );
  await client.query(
    "update funding_operation_steps set depends_on_step_id='prepare' where id='base'",
  );
  assert.equal(
    await held("base-lane"),
    true,
    "a real preparation ancestor retains its own lane",
  );
  await client.query(
    "update funding_operation_steps set step_kind='approval' where id='prepare'",
  );
  assert.equal(
    await held("base-lane"),
    false,
    "finalized approval alone does not retain source cash",
  );
  await client.query(
    "insert into funding_step_receipt_observations values ('sol-attempt', 'failed', true, true, '{\"failureFinalized\": true, \"signedTransactionExpired\": true}')",
  );
  assert.equal(
    await held("sol-lane"),
    false,
    "finalized non-execution releases the formerly unknown source",
  );
  await client.query("rollback");
} finally {
  client.release();
  await pool.end();
}
