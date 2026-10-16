import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import {
  REFUND_SOURCE_FIRST_PAGE_SQL,
  REFUND_SOURCE_NEXT_PAGE_SQL,
  REFUND_SOURCE_EXACT_SQL,
  loadRefundSourceCandidate,
  loadRefundSourceCandidatePage,
} from "../reconciliation/relay-refund-source-candidates.js";
import { RECEIVE_DESTINATION_HEADER_SQL } from "../receive/receive-destination-action-scan.js";
import { relayDestinationReferenceIdentity } from "../../funding-providers/relay/destination-reference.js";

/** Called only after the HIP PG suite creates session-local copies of all three
 * relations. The outer suite rolls back everything, including this workload. */
export async function verifyRefundSourcePagesPg(
  db: Pick<PoolClient, "query">,
  input: { userId: string; templateOperationId: string },
) {
  const localTables = await db.query(
    `select count(*)::int as total from pg_class relation_row
     where relation_row.relnamespace=pg_my_temp_schema()
       and relation_row.relname in ('balance_reservations','funding_operations','funding_operation_segments')`,
  );
  assert.equal(
    localTables.rows[0].total,
    3,
    "benchmark must only write temp relations",
  );
  await db.query(
    `insert into balance_reservations
     select copied_row.* from generate_series(1,50000) fixture_ordinal
       cross join balance_reservations template_row
       cross join lateral jsonb_populate_record(null::balance_reservations,
         to_jsonb(template_row) || jsonb_build_object('id',gen_random_uuid(),
           'component_id',gen_random_uuid()::text,
           'user_id',md5('unrelated-refund-source:'||fixture_ordinal::text)::uuid)) copied_row
     where template_row.operation_id=$1`,
    [input.templateOperationId],
  );
  await db.query("analyze balance_reservations");
  const cutoff = "2100-01-01T00:00:00.000000Z";
  const first = await loadRefundSourceCandidatePage(db, {
    userId: input.userId,
    scanBefore: cutoff,
    cursor: null,
    limit: 50,
  });
  assert.equal(first.rows.length, 50);
  assert.ok(first.nextCursor);
  assert.match(first.nextCursor.createdAt, /\.\d{6}Z$/);
  const next = await loadRefundSourceCandidatePage(db, {
    userId: input.userId,
    scanBefore: cutoff,
    cursor: first.nextCursor,
    limit: 50,
  });
  assert.equal(next.rows.length, 50);
  assert.ok(next.nextCursor);
  const firstIds = new Set(first.rows.map((row) => row.reservation_id));
  assert.ok(next.rows.every((row) => !firstIds.has(row.reservation_id)));
  // All 5,000 copied same-user legs have the exact same timestamp; UUID is a
  // necessary cursor member, and the sentinel must start the following page.
  assert.equal(
    first.rows[0].reservation_created_at,
    next.rows[0].reservation_created_at,
  );
  const fullFirst = await db.query(REFUND_SOURCE_FIRST_PAGE_SQL, [
    input.userId,
    cutoff,
    51,
  ]);
  assert.equal(next.rows[0].reservation_id, fullFirst.rows[50].reservation_id);

  const exact = first.rows[0];
  assert.ok(exact.segment_id);
  const identity = {
    userId: input.userId,
    operationId: exact.operation_id,
    segmentId: exact.segment_id,
    reservationId: exact.reservation_id,
  };
  assert.deepEqual(await loadRefundSourceCandidate(db, identity), exact);
  assert.equal(exact.operation_plan_kind, "wallet_route");
  assert.ok(exact.operation_destination_target_snapshot);
  const reference = relayDestinationReferenceIdentity(`0x${"dd".repeat(32)}`);
  // Frozen-envelope fields are unchanged; only temporary provider metadata is
  // varied. Retained exact evidence survives later status changes and legacy
  // numeric JSON fingerprints preserve array_elements_text semantics.
  await db.query("savepoint destination_header_semantics");
  try {
    for (const sample of [
      {
        raw: "refund",
        metadata: { relaySuccessfulDestinationReferenceHashesV1: [reference] },
        exact: true,
        known: false,
      },
      {
        raw: "success",
        metadata: {
          relayStatusCategory: "provider_success",
          destinationTransactionReferenceCount: "01",
          relayTransactionReferenceFingerprints: [123],
        },
        exact: true,
        known: false,
      },
      {
        raw: "success",
        metadata: {
          relayStatusCategory: "provider_success",
          destinationTransactionReferenceCount: "1",
          relayTransactionReferenceFingerprints: ["different"],
        },
        exact: false,
        known: true,
      },
      {
        raw: "pending",
        metadata: { originTransactionReferenceCount: "1" },
        exact: false,
        known: false,
      },
    ]) {
      await db.query(
        "update funding_operation_segments set raw_status=$2,support_metadata=$3 where id=$1",
        [identity.segmentId, sample.raw, sample.metadata],
      );
      const row = (
        await db.query(RECEIVE_DESTINATION_HEADER_SQL, [
          identity.operationId,
          identity.userId,
          identity.segmentId,
          reference,
          "123",
        ])
      ).rows[0];
      assert.equal(row.exact_reference, sample.exact);
      assert.equal(row.destination_known, sample.known);
      assert.equal(
        row.source_may_be_moving,
        "originTransactionReferenceCount" in sample.metadata,
      );
    }
  } finally {
    await db.query("rollback to savepoint destination_header_semantics");
    await db.query("release savepoint destination_header_semantics");
  }
  await db.query(
    `prepare receive_destination_header(uuid,uuid,uuid,text,text) as ${RECEIVE_DESTINATION_HEADER_SQL}`,
  );
  for (const mode of ["force_custom_plan", "force_generic_plan"]) {
    await db.query(`set local plan_cache_mode=${mode}`);
    for (const owner of [input.userId, randomUUID()]) {
      const explanation = (
        await db.query(
          `explain(analyze,buffers,format json) execute receive_destination_header('${identity.operationId}','${owner}','${identity.segmentId}','${reference}','123')`,
        )
      ).rows[0]["QUERY PLAN"][0];
      assert.equal(
        explanation.Plan["Actual Rows"],
        owner === input.userId ? 1 : 0,
      );
      const visit = (node: Record<string, unknown>) => {
        if (node["Relation Name"]) {
          assert.ok(
            ["Index Scan", "Index Only Scan"].includes(
              String(node["Node Type"]),
            ),
          );
          assert.ok(
            Number(node["Actual Rows"]) * Number(node["Actual Loops"]) <= 1,
          );
          assert.ok(
            Number(node["Rows Removed by Filter"] ?? 0) <= 1,
            JSON.stringify({ mode, node }),
          );
        }
        for (const child of (node.Plans ?? []) as Record<string, unknown>[])
          visit(child);
      };
      visit(explanation.Plan);
      console.log(
        "[receive-destination-header]",
        JSON.stringify({
          mode,
          owner: owner === input.userId ? "own" : "foreign",
          ms: explanation["Execution Time"],
          blocks:
            explanation.Plan["Local Hit Blocks"] +
            explanation.Plan["Local Read Blocks"],
        }),
      );
    }
  }
  await db.query("deallocate receive_destination_header");
  assert.equal(
    await loadRefundSourceCandidate(db, {
      ...identity,
      segmentId: randomUUID(),
    }),
    null,
  );
  assert.equal(
    await loadRefundSourceCandidate(db, {
      ...identity,
      operationId: randomUUID(),
    }),
    null,
  );
  assert.equal(
    await loadRefundSourceCandidate(db, {
      ...identity,
      userId: randomUUID(),
    }),
    null,
  );

  await db.query(
    `prepare refund_source_first(uuid,timestamptz,integer) as ${REFUND_SOURCE_FIRST_PAGE_SQL}`,
  );
  await db.query(
    `prepare refund_source_next(uuid,timestamptz,integer,timestamptz,uuid) as ${REFUND_SOURCE_NEXT_PAGE_SQL}`,
  );
  await db.query(
    `prepare refund_source_exact(uuid,uuid) as ${REFUND_SOURCE_EXACT_SQL}`,
  );
  const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const plans: unknown[] = [];
  const cases = [
    {
      name: "exact-hit",
      prepared: "refund_source_exact",
      args: [literal(input.userId), literal(exact.reservation_id)],
      expected: 1,
    },
    {
      name: "exact-missing",
      prepared: "refund_source_exact",
      args: [literal(input.userId), literal(randomUUID())],
      expected: 0,
    },
    {
      name: "exact-foreign",
      prepared: "refund_source_exact",
      args: [literal(randomUUID()), literal(exact.reservation_id)],
      expected: 0,
    },
    {
      name: "first",
      prepared: "refund_source_first",
      args: [literal(input.userId), literal(cutoff), "51"],
      expected: 51,
    },
    {
      name: "next",
      prepared: "refund_source_next",
      args: [
        literal(input.userId),
        literal(cutoff),
        "51",
        literal(first.nextCursor.createdAt),
        literal(first.nextCursor.id),
      ],
      expected: 51,
    },
    {
      name: "empty-user",
      prepared: "refund_source_first",
      args: [literal(randomUUID()), literal(cutoff), "51"],
      expected: 0,
    },
    {
      name: "empty-tail",
      prepared: "refund_source_next",
      args: [
        literal(input.userId),
        literal(cutoff),
        "51",
        literal("1970-01-01T00:00:00.000001Z"),
        literal(randomUUID()),
      ],
      expected: 0,
    },
  ];
  for (const mode of ["force_custom_plan", "force_generic_plan"] as const) {
    await db.query(`set local plan_cache_mode=${mode}`);
    for (const item of cases) {
      const explanation = (
        await db.query(
          `explain(analyze,buffers,format json) execute ${item.prepared}(${item.args.join(",")})`,
        )
      ).rows[0]["QUERY PLAN"][0];
      assert.equal(explanation.Plan["Actual Rows"], item.expected);
      const scans: unknown[] = [];
      const visit = (node: Record<string, unknown>) => {
        if (node["Relation Name"]) {
          assert.ok(
            ["Index Scan", "Index Only Scan"].includes(
              String(node["Node Type"]),
            ),
          );
          const count =
            Number(node["Actual Rows"]) * Number(node["Actual Loops"]);
          assert.ok(
            count <= (item.prepared === "refund_source_exact" ? 1 : 51),
            "bounded source page must bound hydration as well",
          );
          assert.ok(
            Number(node["Rows Removed by Filter"] ?? 0) <=
              (item.prepared === "refund_source_exact" ? 1 : 0),
          );
          scans.push({
            relation: node["Relation Name"],
            type: node["Node Type"],
            rows: count,
            condition: node["Index Cond"],
          });
        }
        for (const child of (node.Plans ?? []) as Record<string, unknown>[])
          visit(child);
      };
      visit(explanation.Plan);
      plans.push({
        mode,
        name: item.name,
        rows: item.expected,
        ms: explanation["Execution Time"],
        localBlocks:
          explanation.Plan["Local Hit Blocks"] +
          explanation.Plan["Local Read Blocks"],
        scans,
      });
    }
  }
  await db.query("deallocate refund_source_first");
  await db.query("deallocate refund_source_next");
  await db.query("deallocate refund_source_exact");
  return plans;
}
