#!/usr/bin/env tsx
// @requires-db
import assert from "node:assert/strict";
import { createIntegrationTestPool } from "../../../test-database-target.js";
import {
  fundingReservationHoldSql,
  nativeSourceDebitPendingSql,
} from "../../persistence/source-reservation-hold.js";

const pool = await createIntegrationTestPool({ max: 1 });
const client = await pool.connect();
try {
  await client.query("begin");
  // Temporary relations isolate predicate tests from persisted financial data.
  await client.query(`
    create temporary table funding_operation_steps (
      id uuid, operation_id uuid, segment_id uuid, depends_on_step_id uuid,
      step_kind text, action_validation_result jsonb, executor_id text, action_fingerprint text, normalized_action jsonb
    ) on commit drop;
    create temporary table funding_operation_step_attempts (
      id uuid, step_id uuid, outcome text, broadcast_may_have_occurred boolean,
      reference_kind text, receipt_ref_ciphertext text, receipt_ref_lookup_hmac text, lookup_key_version int,
      canonical_action_fingerprint text, executor_id text,
      actual_costs jsonb not null default '{}'
    ) on commit drop;
    create temporary table funding_step_receipt_observations (
      attempt_id uuid, status text, canonical boolean, action_match boolean, evidence jsonb
    ) on commit drop;
    create temporary table funding_observations (
      operation_id uuid, segment_id uuid, network_id text, asset_id text,
      asset_decimals int, kind text, canonical boolean, finality_status text
    ) on commit drop;
    insert into funding_operation_steps(id,operation_id,segment_id,depends_on_step_id,step_kind,action_validation_result) values
      ('10000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000001', null, null, 'venue_preparation', '{}'),
      ('10000000-0000-4000-8000-000000000005', '10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002', null, 'transaction', '{}'),
      ('10000000-0000-4000-8000-000000000006', '10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000003', null, 'transaction', '{}');
    insert into funding_operation_step_attempts (id, step_id, outcome, broadcast_may_have_occurred) values
      ('10000000-0000-4000-8000-000000000007', '10000000-0000-4000-8000-000000000004', 'ambiguous', true),
      ('10000000-0000-4000-8000-000000000008', '10000000-0000-4000-8000-000000000005', 'ambiguous', true);
    insert into funding_step_receipt_observations values
      ('10000000-0000-4000-8000-000000000007', 'finalized', true, true, '{}');
  `);
  async function held(segment: string | null): Promise<boolean> {
    const result = await client.query<{ held: boolean }>(
      `
      select ${fundingReservationHoldSql("reservation")} as held
      from (select '10000000-0000-4000-8000-000000000001'::uuid as operation_id, $1::uuid as segment_id,
        'subtract_available'::text as mode, now() - interval '1 second' as expires_at) reservation
    `,
      [segment],
    );
    const row = result.rows[0];
    assert.ok(row);
    return row.held;
  }
  assert.equal(
    await held("10000000-0000-4000-8000-000000000003"),
    false,
    "independent completed preparation must not lock untouched Base",
  );
  assert.equal(
    await held("10000000-0000-4000-8000-000000000002"),
    true,
    "unknown Solana send remains held",
  );
  assert.equal(
    await held(null),
    true,
    "unscoped historical reservation remains conservative",
  );
  await client.query(
    "update funding_operation_steps set depends_on_step_id='10000000-0000-4000-8000-000000000004' where id='10000000-0000-4000-8000-000000000006'",
  );
  assert.equal(
    await held("10000000-0000-4000-8000-000000000003"),
    true,
    "a real preparation ancestor retains its own lane",
  );
  await client.query(
    "update funding_operation_steps set step_kind='approval' where id='10000000-0000-4000-8000-000000000004'",
  );
  assert.equal(
    await held("10000000-0000-4000-8000-000000000003"),
    false,
    "finalized approval alone does not retain source cash",
  );
  await client.query(
    "insert into funding_step_receipt_observations values ('10000000-0000-4000-8000-000000000008', 'failed', true, true, '{\"failureFinalized\": true, \"signedTransactionExpired\": true}')",
  );
  assert.equal(
    await held("10000000-0000-4000-8000-000000000002"),
    false,
    "finalized non-execution releases the formerly unknown source",
  );
  async function nativeInboundDebitPending(): Promise<boolean> {
    const result = await client.query<{ pending: boolean }>(`
      select ${nativeSourceDebitPendingSql("reservation")} as pending
      from (select '10000000-0000-4000-8000-000000000001'::uuid as operation_id,
        '10000000-0000-4000-8000-000000000003'::uuid as segment_id,
        'subtract_available'::text as mode, 'evm:8453'::text as network_id,
        'usdc-fixture'::text as asset_id, 6 as asset_decimals) reservation
    `);
    assert.ok(result.rows[0]);
    return result.rows[0].pending;
  }
  await client.query(`
    update funding_operation_steps set executor_id='wallet_profile_evm_v1',
      action_validation_result='{"relayNativeDestination":"hyperliquid:mainnet","relayStepKind":"deposit","postconditionEvidenceKind":"exact_erc20_source_debit_v1"}'
    where id='10000000-0000-4000-8000-000000000006'
  `);
  assert.equal(
    await nativeInboundDebitPending(),
    false,
    "cancelled/unstarted inbound deposit does not hold source cash",
  );
  assert.equal(
    await held("10000000-0000-4000-8000-000000000003"),
    false,
    "completed approval without a deposit attempt does not block cancellation",
  );
  await client.query(`
    insert into funding_operation_step_attempts (id, step_id, outcome, broadcast_may_have_occurred)
    values ('10000000-0000-4000-8000-000000000009', '10000000-0000-4000-8000-000000000006', 'submitted', true)
  `);
  assert.equal(await nativeInboundDebitPending(), true);
  await client.query(`
    insert into funding_step_receipt_observations values
      ('10000000-0000-4000-8000-000000000009', 'failed', true, true, '{"failureFinalized":true}')
  `);
  assert.equal(
    await nativeInboundDebitPending(),
    false,
    "finalized failed inbound deposit has no source debit to wait for",
  );
  await client.query(`
    update funding_step_receipt_observations set status='finalized', evidence='{}'
      where attempt_id='10000000-0000-4000-8000-000000000009'
  `);
  assert.equal(
    await nativeInboundDebitPending(),
    true,
    "successful transaction receipt alone is not the canonical source debit",
  );
  await client.query(`
    insert into funding_observations values
      ('10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000003',
       'evm:8453', 'usdc-fixture', 8, 'source_debit', true, 'finalized')
  `);
  assert.equal(
    await nativeInboundDebitPending(),
    true,
    "wrong precision cannot release the hold",
  );
  await client.query("update funding_observations set asset_decimals=6");
  assert.equal(
    await nativeInboundDebitPending(),
    false,
    "exact canonical debit releases the hold",
  );
  await client.query("rollback");
} finally {
  client.release();
  await pool.end();
}
