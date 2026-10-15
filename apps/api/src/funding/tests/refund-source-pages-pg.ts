import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import {
  REFUND_SOURCE_FIRST_PAGE_SQL,
  REFUND_SOURCE_NEXT_PAGE_SQL,
  loadRefundSourceCandidatePage,
} from "../reconciliation/relay-refund-source-candidates.js";

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

  await db.query("set local plan_cache_mode=force_generic_plan");
  await db.query(
    `prepare refund_source_first(uuid,timestamptz,integer) as ${REFUND_SOURCE_FIRST_PAGE_SQL}`,
  );
  await db.query(
    `prepare refund_source_next(uuid,timestamptz,integer,timestamptz,uuid) as ${REFUND_SOURCE_NEXT_PAGE_SQL}`,
  );
  const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const plans: unknown[] = [];
  for (const item of [
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
  ]) {
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
          ["Index Scan", "Index Only Scan"].includes(String(node["Node Type"])),
        );
        const count =
          Number(node["Actual Rows"]) * Number(node["Actual Loops"]);
        assert.ok(
          count <= 51,
          "bounded source page must bound hydration as well",
        );
        assert.equal(node["Rows Removed by Filter"] ?? 0, 0);
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
      name: item.name,
      rows: item.expected,
      ms: explanation["Execution Time"],
      localBlocks:
        explanation.Plan["Local Hit Blocks"] +
        explanation.Plan["Local Read Blocks"],
      scans,
    });
  }
  await db.query("deallocate refund_source_first");
  await db.query("deallocate refund_source_next");
  return plans;
}
