import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import {
  readReceiveExactRoleEvidence,
  RECEIVE_EXACT_HANDOFF_EVIDENCE_SQL,
  RECEIVE_EXACT_DESTINATION_EVIDENCE_SQL,
  receiveDestinationRoleKey,
} from "../receive/receive-exact-role-evidence.js";
import type { DestinationActionProgress } from "../receive/receive-destination-action-scan.js";
import type { FundingPolymarketHandoffCanonicalEventLookup } from "../persistence/funding-evidence-repository.js";
import type { OwnedRouteCanonicalDestinationEvent } from "../reconciliation/owned-route-destination-observer.js";
import { relayDestinationReferenceIdentity } from "../../funding-providers/relay/destination-reference.js";

const hmac = "e".repeat(64);
const transactionReferenceCodec = {
  keyVersion: 1,
  fingerprint: () => hmac,
  decrypt: () => {
    throw Error("not needed with exact receipt");
  },
};
const referenceCodec = { fingerprint: () => hmac };

async function exactPlans(
  db: Pick<PoolClient, "query">,
  sql: string,
  args: unknown[],
  expected: number,
  name: string,
) {
  const types =
    sql === RECEIVE_EXACT_HANDOFF_EVIDENCE_SQL
      ? "uuid,text,text,integer,text"
      : "uuid,text,text";
  await db.query(`prepare exact_role_probe(${types}) as ${sql}`);
  try {
    // Only synthetic UUIDs/fingerprints/chain IDs from this fixture enter EXECUTE.
    const values = args
      .map((value) =>
        typeof value === "number"
          ? String(value)
          : `'${String(value).replaceAll("'", "''")}'`,
      )
      .join(",");
    for (const mode of ["force_custom_plan", "force_generic_plan"] as const) {
      await db.query(`set local plan_cache_mode=${mode}`);
      const plan = (
        await db.query(
          `explain(analyze,buffers,format json) execute exact_role_probe(${values})`,
        )
      ).rows[0]["QUERY PLAN"][0];
      assert.equal(plan.Plan["Actual Rows"], expected);
      const scans: unknown[] = [];
      const visit = (node: Record<string, unknown>) => {
        if (node["Relation Name"]) {
          const examined =
            (Number(node["Actual Rows"] ?? 0) +
              Number(node["Rows Removed by Filter"] ?? 0)) *
            Number(node["Actual Loops"] ?? 0);
          if (examined > Math.max(expected * 2, 4))
            console.log(
              "[exact-role-plan-warning]",
              JSON.stringify({ name, mode, node }),
            );
          assert.ok(
            examined <= Math.max(expected * 2, 4),
            `${name} ${String(node["Relation Name"])} examined ${examined}`,
          );
          if (node["Node Type"] === "Seq Scan")
            assert.equal(
              examined,
              0,
              `${name}: nonempty historical sequential scan of ${String(node["Relation Name"])}`,
            );
          scans.push({
            relation: node["Relation Name"],
            index: node["Index Name"],
            examined,
          });
        }
        for (const child of (node.Plans ?? []) as Record<string, unknown>[])
          visit(child);
      };
      visit(plan.Plan);
      console.log(
        "[exact-role-plan]",
        JSON.stringify({
          name,
          mode,
          ms: plan["Execution Time"],
          buffers:
            plan.Plan["Local Hit Blocks"] +
            plan.Plan["Local Read Blocks"] +
            plan.Plan["Shared Hit Blocks"] +
            plan.Plan["Shared Read Blocks"],
          scans,
        }),
      );
    }
  } finally {
    await db.query("deallocate exact_role_probe");
  }
}

/** Called before mutating the large handoff fixture. All writes target its
 * temporary copies; no public data, source repair or financial writer. */
export async function verifyReceiveExactHandoffEvidencePg(
  db: PoolClient,
  input: {
    userId: string;
    operationId: string;
    stepId: string;
    attemptId: string;
    event: FundingPolymarketHandoffCanonicalEventLookup;
  },
) {
  assert.equal(
    (
      await db.query(
        "select 'funding_operation_steps'::regclass='pg_temp.funding_operation_steps'::regclass as isolated",
      )
    ).rows[0].isolated,
    true,
  );
  await db.query("savepoint exact_handoff_evidence");
  try {
    // Scale the joined facts table alongside the synthetic operations. Leaving
    // this on the small public test table made the planner reasonably choose a
    // full hash/seq read of ~130 rows; that is not a production-sized benchmark.
    await db.query(
      "create temporary table funding_classification_revisions (like public.funding_classification_revisions including all) on commit drop",
    );
    await db.query(
      "insert into funding_classification_revisions select * from public.funding_classification_revisions where operation_id=$1",
      [input.operationId],
    );
    // Parent facts may still be uncommitted (deferred revision=0); add one
    // temp-only positive row so hit and absent-zero exercise distinct plans.
    await db.query(
      "insert into funding_classification_revisions(operation_id,revision) values($1,7) on conflict(operation_id) do nothing",
      [input.operationId],
    );
    await db.query(
      "insert into funding_classification_revisions(operation_id,revision) select operation_id,1 from handoff_fixture_ids",
    );
    await db.query("analyze funding_classification_revisions");
    await db.query(
      "create temporary table funding_operation_segments (like public.funding_operation_segments including all) on commit drop",
    );
    // The parent fixture has55k attempts but no receipts. Populate the receipt
    // lane too: a one-row table cannot establish its exact-hash index plan.
    await db.query(`insert into funding_step_receipt_observations
      (operation_id,step_id,attempt_id,network_id,status,canonical,action_match,first_seen_at,observed_at,finalized_at,evidence)
      select fixture_row.operation_id,fixture_row.step_id,fixture_row.attempt_id,'evm:137',
        'finalized',true,true,now(),now(),now(),
        jsonb_build_object('transactionHash','0x'||md5(fixture_row.attempt_id::text)||md5(fixture_row.step_id::text),'handoffEventIndex','0')
      from handoff_fixture_ids fixture_row`);
    const event: OwnedRouteCanonicalDestinationEvent = {
      networkId: input.event.networkId,
      asset: {
        networkId: input.event.networkId,
        assetId: input.event.assetId,
        decimals: 6,
      },
      sourceAddress: input.event.sourceAddress,
      destinationAddress: input.event.destinationAddress,
      rawAmount: input.event.rawAmount,
      transactionHash: `0x${"da".repeat(32)}`,
      eventIndex: "2",
      ledgerHeight: "1",
      blockHash: `0x${"db".repeat(32)}`,
      observedAt: new Date(0),
    };
    await db.query(
      "update funding_operation_step_attempts set receipt_ref_lookup_hmac=$2,lookup_key_version=1,reference_kind='transaction' where id=$1",
      [input.attemptId, hmac],
    );
    await db.query(
      `insert into funding_step_receipt_observations(operation_id,step_id,attempt_id,network_id,status,canonical,action_match,first_seen_at,observed_at,finalized_at,evidence)
      values($1,$2,$3,$4,'finalized',true,true,now(),now(),now(),$5)
      on conflict(attempt_id) do update set status='finalized',canonical=true,action_match=true,failure_code=null,finalized_at=excluded.finalized_at,evidence=excluded.evidence`,
      [
        input.operationId,
        input.stepId,
        input.attemptId,
        event.networkId,
        {
          transactionHash: event.transactionHash,
          handoffEventIndex: event.eventIndex,
        },
      ],
    );
    const request = {
      limit: 50,
      userId: input.userId,
      event,
      transactionReferenceCodec,
      referenceCodec,
    };
    const read = () => readReceiveExactRoleEvidence(db, request);
    await db.query("analyze funding_step_receipt_observations");
    await db.query("analyze funding_operation_step_attempts");
    assert.equal((await read()).handoff.kind, "internal");
    const args = [
      input.userId,
      event.networkId,
      hmac,
      1,
      event.transactionHash,
    ];
    await exactPlans(
      db,
      RECEIVE_EXACT_HANDOFF_EVIDENCE_SQL,
      args,
      1,
      "handoff-hit",
    );
    await db.query("savepoint missing_classification_revision");
    await db.query(
      "delete from funding_classification_revisions where operation_id=$1",
      [input.operationId],
    );
    assert.equal(
      (await read()).dependencies.find(
        (value) => value.operationId === input.operationId,
      )?.revision,
      "0",
    );
    await exactPlans(
      db,
      RECEIVE_EXACT_HANDOFF_EVIDENCE_SQL,
      args,
      1,
      "handoff-missing-revision",
    );
    await db.query("rollback to savepoint missing_classification_revision");
    await exactPlans(
      db,
      RECEIVE_EXACT_HANDOFF_EVIDENCE_SQL,
      [
        input.userId,
        event.networkId,
        "f".repeat(64),
        1,
        `0x${"cc".repeat(32)}`,
      ],
      0,
      "handoff-empty",
    );
    await exactPlans(
      db,
      RECEIVE_EXACT_HANDOFF_EVIDENCE_SQL,
      [randomUUID(), ...args.slice(1)],
      0,
      "handoff-foreign",
    );

    // More than the old256 cap. Same operation, distinct attempts: every exact
    // witness participates; ordinary updated receipt facts resolve the conflict.
    await db.query(
      `insert into funding_operation_step_attempts select copied_row.*
      from funding_operation_step_attempts template_row cross join generate_series(100001,100300) fixture_ordinal
      cross join lateral jsonb_populate_record(null::funding_operation_step_attempts,to_jsonb(template_row)||
        jsonb_build_object('id',gen_random_uuid(),'attempt_number',fixture_ordinal)) copied_row where template_row.id=$1`,
      [input.attemptId],
    );
    await db.query(
      `insert into funding_step_receipt_observations(operation_id,step_id,attempt_id,network_id,status,canonical,action_match,first_seen_at,observed_at,finalized_at,evidence)
      select $1,$2,attempt_row.id,$3,'finalized',true,true,now(),now(),now(),$4
      from funding_operation_step_attempts attempt_row where attempt_row.step_id=$2 and attempt_row.attempt_number between 100001 and 100300`,
      [
        input.operationId,
        input.stepId,
        event.networkId,
        {
          transactionHash: event.transactionHash,
          handoffEventIndex: event.eventIndex,
        },
      ],
    );
    for (const table of [
      "funding_operation_step_attempts",
      "funding_step_receipt_observations",
    ])
      await db.query(`analyze ${table}`);
    const dense = await read();
    assert.equal(dense.handoff.kind, "recovery_required");
    assert.equal(dense.dependencies.length, 301);
    await exactPlans(
      db,
      RECEIVE_EXACT_HANDOFF_EVIDENCE_SQL,
      args,
      301,
      "handoff-dense-301",
    );
    await db.query(
      "update funding_step_receipt_observations set evidence=evidence||jsonb_build_object('transactionHash',$3::text) where operation_id=$1 and attempt_id<>$2",
      [input.operationId, input.attemptId, `0x${"cc".repeat(32)}`],
    );
    const recovered = await read();
    assert.equal(recovered.handoff.kind, "internal");
    assert.equal(
      recovered.dependencies.length,
      301,
      "negative other-hash references retain facts",
    );
    await db.query(
      "update funding_operation_steps set normalized_action=normalized_action||'{\"payload\":null}' where id=$1",
      [input.stepId],
    );
    assert.equal((await read()).handoff.kind, "recovery_required");
    console.log(
      "PASS exact handoff: real indexed readers, >256 witnesses, negatives, ordinary recovery, malformed legacy and foreign owner",
    );
  } finally {
    await db.query("rollback to savepoint exact_handoff_evidence");
    await db.query("release savepoint exact_handoff_evidence");
  }
}

/** Uses the existing50k destination/operation temp fixture and real reader. */
export async function verifyReceiveExactDestinationEvidencePg(
  db: Pick<PoolClient, "query">,
  input: {
    userId: string;
    operationId: string;
    segmentId: string;
    event: OwnedRouteCanonicalDestinationEvent;
  },
) {
  const request = {
    limit: 50,
    userId: input.userId,
    event: input.event,
    transactionReferenceCodec,
    referenceCodec,
  };
  const read = () => readReceiveExactRoleEvidence(db, request);
  const exact = await read();
  assert.equal(exact.destination.kind, "internal");
  assert.ok(
    exact.dependencies.some((row) => row.operationId === input.operationId),
  );
  const args = [
    input.userId,
    relayDestinationReferenceIdentity(input.event.transactionHash),
    hmac,
  ];
  await exactPlans(
    db,
    RECEIVE_EXACT_DESTINATION_EVIDENCE_SQL,
    args,
    1,
    "destination-retained-hit",
  );
  await exactPlans(
    db,
    RECEIVE_EXACT_DESTINATION_EVIDENCE_SQL,
    [randomUUID(), ...args.slice(1)],
    0,
    "destination-foreign",
  );
  await exactPlans(
    db,
    RECEIVE_EXACT_DESTINATION_EVIDENCE_SQL,
    [input.userId, "0".repeat(64), "0".repeat(64)],
    0,
    "destination-empty",
  );
  await db.query("savepoint exact_destination_legacy");
  try {
    await db.query(
      "update funding_operation_segments set raw_status='success',support_metadata=$2 where id=$1",
      [
        input.segmentId,
        {
          relayStatusCategory: "provider_success",
          destinationTransactionReferenceCount: "01",
          relayTransactionReferenceFingerprints: [hmac],
        },
      ],
    );
    assert.equal((await read()).destination.kind, "internal");
    await exactPlans(
      db,
      RECEIVE_EXACT_DESTINATION_EVIDENCE_SQL,
      args,
      1,
      "destination-legacy-hit",
    );
    await db.query(
      "update funding_operation_segments set raw_status='pending' where id=$1",
      [input.segmentId],
    );
    const negative = await read();
    assert.equal(negative.destination.kind, "external");
    assert.ok(
      negative.dependencies.some(
        (row) => row.operationId === input.operationId,
      ),
    );
    // No reservation-backed summary: bounded legacy continuation uses the same
    // destination page reader. An unfinished negative tail is NOT external.
    const progress = new Map<string, DestinationActionProgress>();
    let bounded = await readReceiveExactRoleEvidence(db, {
      ...request,
      limit: 1,
      destinationProgress: progress,
    });
    assert.ok(bounded.pendingDestinations.length > 0);
    assert.equal(bounded.destination.kind, "recovery_required");
    let rounds = 0;
    while (bounded.pendingDestinations.length > 0 && rounds++ < 8) {
      for (const page of bounded.pendingDestinations)
        progress.set(
          receiveDestinationRoleKey(page.facts.operationId, page.segmentId),
          page,
        );
      bounded = await readReceiveExactRoleEvidence(db, {
        ...request,
        limit: 1,
        destinationProgress: progress,
      });
    }
    assert.equal(
      bounded.pendingDestinations.length,
      0,
      "bounded continuation makes progress without rereading its prefix",
    );
    assert.equal(bounded.destination.kind, "external");
    await exactPlans(
      db,
      RECEIVE_EXACT_DESTINATION_EVIDENCE_SQL,
      args,
      1,
      "destination-legacy-negative",
    );
    await db.query(
      "update funding_operation_steps set segment_id=$2 where operation_id=$1",
      [input.operationId, input.segmentId],
    );
    assert.equal(
      (await read()).destination.kind,
      "recovery_required",
      "legacy exposed source without a source row cannot become external",
    );
    await db.query(
      "update funding_operation_segments set raw_status='success',support_metadata=$2 where id=$1",
      [
        input.segmentId,
        {
          relayStatusCategory: "provider_success",
          destinationTransactionReferenceCount: "1",
          relayTransactionReferenceFingerprints: [123],
        },
      ],
    );
    assert.equal(
      (
        await readReceiveExactRoleEvidence(db, {
          ...request,
          referenceCodec: { fingerprint: () => "123" },
        })
      ).destination.kind,
      "internal",
    );
    const leading = await readReceiveExactRoleEvidence(db, {
      ...request,
      referenceCodec: { fingerprint: () => "0123" },
    });
    assert.equal(leading.destination.kind, "external");
    assert.ok(
      leading.dependencies.some((row) => row.operationId === input.operationId),
    );
  } finally {
    await db.query("rollback to savepoint exact_destination_legacy");
    await db.query("release savepoint exact_destination_legacy");
  }
  console.log(
    "PASS exact destination: retained/legacy/numeric hints, negative same-statement facts, actual exposure and ordinary recovery",
  );
}
