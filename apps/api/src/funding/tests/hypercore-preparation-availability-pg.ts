import assert from "node:assert/strict";
import type { PoolClient } from "pg";
import { hypercoreSpotAccountLocation } from "../../account-value/canonical.js";
import {
  HYPERCORE_PREPARATION_AVAILABILITY_SQL,
  loadHypercorePreparationAvailability,
} from "../preparation/hypercore-availability.js";

/** Invoked inside the snapshot-debit test's rollback transaction and temp
 * relations. Provider/signing/production state is never touched. */
export async function verifyHypercorePreparationAvailabilityPg(
  client: PoolClient,
) {
  const accountId = "00000000-0000-4000-8000-000000000031";
  const operationId = "00000000-0000-4000-8000-000000000032";
  const stepId = "00000000-0000-4000-8000-000000000033";
  const attemptId = "00000000-0000-4000-8000-000000000034";
  const address = `0x${"ef".repeat(20)}`;
  const { location } = hypercoreSpotAccountLocation({
    accountId,
    address,
    controllerWalletId: "test-controller",
  });
  const observedAt = "2026-10-14T16:00:00.000Z";
  await client.query(`
    alter table balance_reservations add id uuid default gen_random_uuid(), add state text default 'active',
      add expires_at timestamptz default now()+interval '1 hour', add raw_amount text default '1';
    create index test_native_active_user on balance_reservations(user_id,component_id) where state='active';
    create index test_native_physical_source on balance_reservations(user_id,location_id,network_id,asset_id,operation_id) where mode='subtract_available';
    create index test_native_debit_operation on funding_observations(operation_id,kind,observed_at);
    create temp table funding_operation_steps(id uuid primary key, operation_id uuid, segment_id uuid,
      depends_on_step_id uuid, executor_id text, step_kind text, action_fingerprint text,
      normalized_action jsonb default '{}', action_validation_result jsonb default '{}');
    create unique index test_native_step_operation on funding_operation_steps(operation_id,id);
    create temp table funding_operation_step_attempts(id uuid primary key, step_id uuid, outcome text,
      broadcast_may_have_occurred boolean, reference_kind text, receipt_ref_ciphertext text,
      receipt_ref_lookup_hmac text, lookup_key_version integer, canonical_action_fingerprint text,
      executor_id text, actual_costs jsonb default '{}');
    create index test_native_attempt_step on funding_operation_step_attempts(step_id);
    create temp table funding_step_receipt_observations(attempt_id uuid primary key, status text,
      canonical boolean, action_match boolean, evidence jsonb default '{}');
  `);
  await client.query(
    "insert into funding_operations(id,user_id,status) values($1,$2,'action_required')",
    [operationId, accountId],
  );
  await client.query(
    `insert into balance_reservations(operation_id,user_id,component_id,location_id,network_id,asset_id,mode,asset_decimals,raw_amount,expires_at)
    values($1,$2,'historical-alias',$3,$4,$5,'subtract_available',8,'200000000',now()-interval '1 hour')`,
    [
      operationId,
      accountId,
      location.locationId,
      location.asset.networkId,
      location.asset.assetId,
    ],
  );
  const read = () =>
    loadHypercorePreparationAvailability(client, {
      accountId,
      location,
      observedAt,
    });
  assert.deepEqual(
    await read(),
    { reservedRaw: "0", submittedDebitRaw: "0" },
    "expired unstarted quote",
  );
  await client.query(
    "update balance_reservations set expires_at=now()+interval '1 hour' where operation_id=$1",
    [operationId],
  );
  assert.deepEqual(
    await read(),
    { reservedRaw: "200000000", submittedDebitRaw: "0" },
    "live quote reservation",
  );
  await client.query(
    "update balance_reservations set expires_at=now()-interval '1 hour' where operation_id=$1",
    [operationId],
  );
  await client.query(
    `insert into funding_operation_steps(id,operation_id,executor_id,step_kind)
    values($1,$2,'relay_hypercore_native_v1','external_handoff')`,
    [stepId, operationId],
  );
  await client.query(
    `insert into funding_operation_step_attempts(id,step_id,outcome,broadcast_may_have_occurred)
    values($1,$2,'ambiguous',true)`,
    [attemptId, stepId],
  );
  assert.deepEqual(
    await read(),
    { reservedRaw: "200000000", submittedDebitRaw: "0" },
    "expired ambiguous native send keeps hold",
  );
  await client.query(
    `insert into funding_observations values(900000,$1,null,$2,$3,$4,'200000000',
    '2026-10-14T16:00:01Z','2026-10-14T16:00:01Z','source_debit',true,'finalized',8)`,
    [
      operationId,
      location.asset.networkId,
      location.asset.assetId,
      address.toUpperCase().replace("0X", "0x"),
    ],
  );
  assert.deepEqual(
    await read(),
    { reservedRaw: "0", submittedDebitRaw: "200000000" },
    "active hold and canonical debit counted once",
  );
  await client.query(
    "update balance_reservations set expires_at=now()+interval '1 hour' where operation_id=$1",
    [operationId],
  );
  assert.deepEqual(
    await read(),
    { reservedRaw: "0", submittedDebitRaw: "200000000" },
    "unexpired active hold still not double counted",
  );
  assert.deepEqual(
    await loadHypercorePreparationAvailability(client, {
      accountId,
      location,
      observedAt: "2026-10-14T16:00:02Z",
    }),
    { reservedRaw: "0", submittedDebitRaw: "0" },
    "new snapshot already includes debit",
  );
  await client.query(
    "update balance_reservations set state='released' where operation_id=$1",
    [operationId],
  );
  assert.deepEqual(
    await read(),
    { reservedRaw: "0", submittedDebitRaw: "200000000" },
    "released alias does not revive old snapshot cash",
  );
  await client.query(
    "update balance_reservations set state='active',expires_at=now()-interval '1 hour' where operation_id=$1",
    [operationId],
  );
  await client.query(
    "update funding_observations set canonical=false,finality_status='reorged' where id=900000",
  );
  assert.deepEqual(
    await read(),
    { reservedRaw: "200000000", submittedDebitRaw: "0" },
    "reorg restores pending hold",
  );
  await client.query(
    `insert into funding_step_receipt_observations values($1,'failed',true,true,'{"failureFinalized":true}')`,
    [attemptId],
  );
  assert.deepEqual(
    await read(),
    { reservedRaw: "0", submittedDebitRaw: "0" },
    "canonical failed receipt proves no debit",
  );
  await client.query(
    "update funding_step_receipt_observations set canonical=false where attempt_id=$1",
    [attemptId],
  );
  assert.deepEqual(
    await read(),
    { reservedRaw: "200000000", submittedDebitRaw: "0" },
    "noncanonical failure cannot release hold",
  );
  for (const mode of ["settled_for_consumer", "advisory_destination"]) {
    await client.query(
      "update balance_reservations set mode=$2,expires_at=now()+interval '1 hour' where operation_id=$1",
      [operationId, mode],
    );
    assert.deepEqual(
      await read(),
      { reservedRaw: "200000000", submittedDebitRaw: "0" },
      `${mode}: preserve common active reservation semantics`,
    );
  }
  await client.query(
    "update balance_reservations set mode='subtract_available' where operation_id=$1",
    [operationId],
  );
  // Unrelated users and a large closed history on this owner must not require
  // a scan of all reservations. Reuse production index shapes above.
  await client.query(
    `insert into balance_reservations(operation_id,user_id,component_id,location_id,network_id,asset_id,mode,asset_decimals,state,raw_amount)
    select gen_random_uuid(),case when seq<=50000 then $1::uuid else gen_random_uuid() end,
      'noise-'||seq,'noise-'||seq,$2,$3,'subtract_available',8,
      case when seq<=50000 then 'released' else 'active' end,'1'
    from generate_series(1,100000) as noise_rows(seq)`,
    [accountId, location.asset.networkId, location.asset.assetId],
  );
  await client.query("analyze balance_reservations");
  await client.query("analyze funding_operation_steps");
  await client.query("analyze funding_operation_step_attempts");
  await client.query("analyze funding_step_receipt_observations");
  await client.query(
    `prepare native_preparation_available(uuid,jsonb) as ${HYPERCORE_PREPARATION_AVAILABILITY_SQL}`,
  );
  for (const [name, snapshot] of [
    [
      "hit",
      [
        {
          component_id: null,
          location_id: location.locationId,
          address,
          asset_decimals: 8,
          snapshot_at: observedAt,
        },
      ],
    ],
    [
      "empty-physical-location",
      [
        {
          component_id: null,
          location_id: "absent-location",
          address: `0x${"dd".repeat(20)}`,
          asset_decimals: 8,
          snapshot_at: observedAt,
        },
      ],
    ],
    ["empty-input", []],
  ] as const) {
    // Controlled fixture constants only; never provider/user SQL interpolation.
    const plan = (
      await client.query(
        `explain (analyze,buffers,format json) execute native_preparation_available('${accountId}','${JSON.stringify(snapshot)}')`,
      )
    ).rows[0]["QUERY PLAN"][0];
    const nodes: Record<string, unknown>[] = [];
    const visit = (node: Record<string, unknown>) => {
      nodes.push(node);
      for (const child of (node.Plans as
        | Record<string, unknown>[]
        | undefined) ?? [])
        visit(child);
    };
    visit(plan.Plan);
    assert.ok(
      !nodes.some(
        (node) =>
          ["funding_observations", "balance_reservations"].includes(
            String(node["Relation Name"]),
          ) && node["Node Type"] === "Seq Scan",
      ),
      name,
    );
    const blocks =
      Number(plan.Plan["Local Hit Blocks"]) +
      Number(plan.Plan["Local Read Blocks"]);
    assert.ok(blocks < 150, `${name}: ${blocks} blocks`);
    console.log(`native-preparation-${name}`, {
      ms: plan["Execution Time"],
      localBlocks: blocks,
    });
  }
  await assert.rejects(
    loadHypercorePreparationAvailability(client, {
      accountId: "foreign",
      location,
      observedAt,
    }),
  );
  console.log("native preparation availability and recovery cases passed");
}
