import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import {
  loadRefundSourceActionFacts,
  REFUND_SOURCE_ACTION_FACTS_SQL,
} from "../reconciliation/relay-refund-source-actions.js";

/** Only disposable test callers. All workload rows live in session-local temp
 * relations and the enclosing HIP suite rolls the entire transaction back. */
export async function verifyRefundSourceActionsPg(
  db: Pick<PoolClient, "query">,
  candidates: readonly { operation_id: string; segment_id: string }[],
) {
  assert.equal(candidates.length, 2);
  const operationIds = candidates.map((c) => c.operation_id);
  await db.query(`create temporary table funding_operation_steps
    (like public.funding_operation_steps including all) on commit drop`);
  await db.query(
    `insert into funding_operation_steps select * from public.funding_operation_steps where operation_id=any($1::uuid[])`,
    [operationIds],
  );
  await db.query(`create temporary table funding_operation_step_attempts
    (like public.funding_operation_step_attempts including all) on commit drop`);
  await db.query(`insert into funding_operation_step_attempts select attempt_row.*
    from public.funding_operation_step_attempts attempt_row
    join funding_operation_steps action_row on action_row.id=attempt_row.step_id`);
  await db.query(`create temporary table funding_step_receipt_observations
    (like public.funding_step_receipt_observations including all) on commit drop`);
  await db.query(`insert into funding_step_receipt_observations select receipt_row.*
    from public.funding_step_receipt_observations receipt_row
    join funding_operation_step_attempts attempt_row on attempt_row.id=receipt_row.attempt_id`);
  const first = await loadRefundSourceActionFacts(db, {
    candidate: candidates[0],
    cursor: null,
    limit: 50,
  });
  assert.equal(first.nextCursor, null);
  assert.equal(first.rows.length, 2);
  assert.ok(
    first.rows.every((r) => r.attempt_id && r.receipt_status === "finalized"),
  );
  const template = first.rows.find(
    (r) =>
      (r.action_validation_result as Record<string, unknown>).relayStepKind ===
      "deposit",
  );
  assert.ok(template);
  await db.query("savepoint refund_action_cursor_boundary");
  await db.query(
    `insert into funding_operation_steps
    select copied_row.* from generate_series(2,3) fixture_ordinal
    cross join funding_operation_steps template_row
    cross join lateral jsonb_populate_record(null::funding_operation_steps,
      to_jsonb(template_row) || jsonb_build_object('id',gen_random_uuid(),'ordinal',fixture_ordinal,
        'action_fingerprint',md5(fixture_ordinal::text))) copied_row
    where template_row.id=$1`,
    [template.step_id],
  );
  const afterExhausted = await loadRefundSourceActionFacts(db, {
    candidate: candidates[0],
    cursor: { stepOrdinal: 1, attemptNumber: 1 },
    limit: 1,
  });
  assert.equal(afterExhausted.rows[0].step_ordinal, 2);
  assert.deepEqual(afterExhausted.nextCursor, {
    stepOrdinal: 2,
    attemptNumber: 0,
  });
  const finalUnstarted = await loadRefundSourceActionFacts(db, {
    candidate: candidates[0],
    cursor: afterExhausted.nextCursor,
    limit: 1,
  });
  assert.equal(finalUnstarted.rows[0].step_ordinal, 3);
  assert.equal(finalUnstarted.nextCursor, null);
  await db.query("rollback to savepoint refund_action_cursor_boundary");
  await db.query("release savepoint refund_action_cursor_boundary");
  await db.query(`create temporary table refund_action_fixture_ids on commit drop as
    select gen_random_uuid() as operation_id,gen_random_uuid() as segment_id,
      gen_random_uuid() as step_id,gen_random_uuid() as attempt_id,gen_random_uuid() as receipt_id
    from generate_series(1,50000)`);
  await db.query(
    `insert into funding_operation_steps
    select copied_row.* from refund_action_fixture_ids fixture_row
    cross join funding_operation_steps template_row
    cross join lateral jsonb_populate_record(null::funding_operation_steps,
      to_jsonb(template_row) || jsonb_build_object('id',fixture_row.step_id,
        'operation_id',fixture_row.operation_id,'segment_id',fixture_row.segment_id)) copied_row
    where template_row.id=$1`,
    [template.step_id],
  );
  await db.query(
    `insert into funding_operation_step_attempts
    select copied_row.* from refund_action_fixture_ids fixture_row
    cross join funding_operation_step_attempts template_row
    cross join lateral jsonb_populate_record(null::funding_operation_step_attempts,
      to_jsonb(template_row) || jsonb_build_object('id',fixture_row.attempt_id,'step_id',fixture_row.step_id)) copied_row
    where template_row.id=$1`,
    [template.attempt_id],
  );
  await db.query(
    `insert into funding_step_receipt_observations
    select copied_row.* from refund_action_fixture_ids fixture_row
    cross join funding_step_receipt_observations template_row
    cross join lateral jsonb_populate_record(null::funding_step_receipt_observations,
      to_jsonb(template_row) || jsonb_build_object('id',fixture_row.receipt_id,'attempt_id',fixture_row.attempt_id)) copied_row
    where template_row.attempt_id=$1`,
    [template.attempt_id],
  );
  await db.query("analyze funding_operation_steps");
  await db.query("analyze funding_operation_step_attempts");
  await db.query("analyze funding_step_receipt_observations");
  // Dense history in ONE selected deposit catches a fanout problem that
  // unrelated-operation benchmarks cannot. No latest-attempt shortcut.
  await db.query(
    `insert into funding_operation_step_attempts
    select copied_row.* from generate_series(2,10001) fixture_ordinal
    cross join funding_operation_step_attempts template_row
    cross join lateral jsonb_populate_record(null::funding_operation_step_attempts,
      to_jsonb(template_row) || jsonb_build_object('id',gen_random_uuid(),'attempt_number',fixture_ordinal)) copied_row
    where template_row.id=$1`,
    [template.attempt_id],
  );
  await db.query("analyze funding_operation_step_attempts");
  const page = await loadRefundSourceActionFacts(db, {
    candidate: candidates[0],
    cursor: null,
    limit: 50,
  });
  assert.equal(page.rows.length, 50);
  assert.deepEqual(page.nextCursor, {
    stepOrdinal: template.step_ordinal,
    attemptNumber: 49,
  });
  const next = await loadRefundSourceActionFacts(db, {
    candidate: candidates[0],
    cursor: page.nextCursor,
    limit: 50,
  });
  assert.equal(next.rows[0].attempt_number, 50);
  assert.equal(next.rows.at(-1)?.attempt_number, 99);
  const tail = await loadRefundSourceActionFacts(db, {
    candidate: candidates[0],
    cursor: { stepOrdinal: template.step_ordinal, attemptNumber: 9999 },
    limit: 50,
  });
  assert.deepEqual(
    tail.rows.map((r) => r.attempt_number),
    [10000, 10001],
  );
  assert.equal(tail.nextCursor, null);
  await db.query("set local plan_cache_mode=force_generic_plan");
  await db.query(
    `prepare refund_source_actions(uuid,uuid,integer,integer,integer) as ${REFUND_SOURCE_ACTION_FACTS_SQL}`,
  );
  const plans: unknown[] = [];
  for (const item of [
    {
      name: "sparse-hit",
      candidate: candidates[1],
      ordinal: -1,
      attempt: 0,
      expected: 2,
    },
    {
      name: "dense-first",
      candidate: candidates[0],
      ordinal: -1,
      attempt: 0,
      expected: 51,
    },
    {
      name: "dense-next",
      candidate: candidates[0],
      ordinal: template.step_ordinal,
      attempt: 49,
      expected: 51,
    },
    {
      name: "dense-tail",
      candidate: candidates[0],
      ordinal: template.step_ordinal,
      attempt: 9999,
      expected: 2,
    },
    {
      name: "empty-tail",
      candidate: candidates[0],
      ordinal: template.step_ordinal,
      attempt: 10001,
      expected: 0,
    },
    {
      name: "missing-operation",
      candidate: { operation_id: randomUUID(), segment_id: randomUUID() },
      ordinal: -1,
      attempt: 0,
      expected: 0,
    },
    {
      name: "wrong-segment",
      candidate: { ...candidates[0], segment_id: randomUUID() },
      ordinal: -1,
      attempt: 0,
      expected: 0,
    },
  ]) {
    const param = [item.candidate.operation_id, item.candidate.segment_id]
      .map((s) => "'" + s.replaceAll("'", "''") + "'")
      .join(",");
    const explanation = (
      await db.query(
        `explain(analyze,buffers,format json) execute refund_source_actions(${param},51,${item.ordinal},${item.attempt})`,
      )
    ).rows[0]["QUERY PLAN"][0];
    assert.equal(explanation.Plan["Actual Rows"], item.expected);
    const scans: unknown[] = [];
    const visit = (node: Record<string, unknown>) => {
      if (node["Relation Name"]) {
        assert.ok(
          ["Index Scan", "Index Only Scan"].includes(String(node["Node Type"])),
          `unbounded scan: ${JSON.stringify(node)}`,
        );
        const count =
          Number(node["Actual Rows"]) * Number(node["Actual Loops"]);
        assert.ok(count <= 52, `unbounded hydration: ${count}`);
        assert.ok(
          Number(node["Rows Removed by Filter"] ?? 0) <= 2,
          "resumed page must not scan skipped attempt history",
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
      name: item.name,
      rows: item.expected,
      ms: explanation["Execution Time"],
      localBlocks:
        explanation.Plan["Local Hit Blocks"] +
        explanation.Plan["Local Read Blocks"],
      scans,
    });
  }
  await db.query("deallocate refund_source_actions");
  return plans;
}
