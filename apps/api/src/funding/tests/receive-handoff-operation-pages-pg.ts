import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import {
  FUNDING_HANDOFF_OPERATION_PAGE_SQL,
  listFundingHandoffOperationPage,
  type FundingHandoffActionCursor,
} from "../persistence/funding-evidence-repository.js";
import {
  FundingClassificationChangedError,
  readFundingClassificationRevision,
} from "../persistence/funding-classification-revisions.js";

/** Invoked inside the existing rollback-only handoff benchmark. Temp relations
 * contain 55k unrelated operations/actions/attempts. This proves page semantics
 * and plans, not committed revision races (covered by classification-revisions).
 */
export async function verifyHandoffOperationPagesPg(
  db: PoolClient,
  input: {
    userId: string;
    operationId: string;
    stepId: string;
    attemptId: string;
  },
) {
  const relations =
    await db.query(`select count(*)::int as total from pg_class relation_row
    where relation_row.relnamespace=pg_my_temp_schema() and relation_row.relname in
      ('funding_operations','funding_operation_steps','funding_operation_step_attempts','funding_step_receipt_observations')`);
  assert.equal(relations.rows[0].total, 4);
  await db.query("savepoint handoff_operation_pages");
  try {
    const facts = await readFundingClassificationRevision(db, input);
    assert.ok(facts);
    const originalOrdinal = Number(
      (
        await db.query(
          "select ordinal from funding_operation_steps where id=$1",
          [input.stepId],
        )
      ).rows[0].ordinal,
    );
    const plain = randomUUID();
    const dense = randomUUID();
    const unstarted = randomUUID();
    const bound = randomUUID();
    for (const [index, id] of [plain, dense, unstarted, bound].entries()) {
      await db.query(
        `insert into funding_operation_steps select copied_row.*
        from funding_operation_steps template_row
        cross join lateral jsonb_populate_record(null::funding_operation_steps,
          to_jsonb(template_row)||jsonb_build_object('id',$2::uuid,'ordinal',$3::integer,
            'segment_id',$4::uuid,'normalized_action',template_row.normalized_action||$5::jsonb,
            'action_fingerprint',$6::text)) copied_row
        where template_row.id=$1`,
        [
          input.stepId,
          id,
          originalOrdinal + index + 1,
          id === bound ? randomUUID() : null,
          id === plain
            ? { kind: "evm_transaction" }
            : {
                kind: "external_handoff",
                handoffKind: "polymarket_deposit_wallet_transfer",
              },
          createHash("sha256").update(id).digest("hex"),
        ],
      );
    }
    await db.query(
      `insert into funding_operation_step_attempts select copied_row.*
      from funding_operation_step_attempts template_row
      cross join generate_series(1,513) fixture_ordinal
      cross join lateral jsonb_populate_record(null::funding_operation_step_attempts,
        to_jsonb(template_row)||jsonb_build_object('id',gen_random_uuid(),'step_id',$2::uuid,
          'canonical_action_fingerprint',(select action_fingerprint from funding_operation_steps where id=$2),
          'attempt_number',fixture_ordinal,'outcome','started','finished_at',null,
          'actual_costs','{}'::jsonb,'reference_kind',null,'receipt_ref_ciphertext',null,
          'receipt_ref_lookup_hmac',null,'lookup_key_version',null,
          'broadcast_may_have_occurred',false)) copied_row
      where template_row.id=$1`,
      [input.attemptId, dense],
    );
    await db.query(
      `insert into funding_operation_step_attempts select copied_row.*
      from funding_operation_step_attempts template_row
      cross join lateral jsonb_populate_record(null::funding_operation_step_attempts,
        to_jsonb(template_row)||jsonb_build_object('id',gen_random_uuid(),'step_id',$2::uuid,'attempt_number',1,
          'canonical_action_fingerprint',(select action_fingerprint from funding_operation_steps where id=$2))) copied_row
      where template_row.id=$1`,
      [input.attemptId, bound],
    );
    await db.query(
      `update funding_operation_step_attempts set outcome='cancelled',finished_at=started_at,
      actual_costs='{"reasonCode":"cancelled_after_safe_evidence"}'::jsonb where step_id=$1 and attempt_number=1`,
      [dense],
    );
    const otherHash = `0x${"12".repeat(32)}`;
    await db.query(
      `insert into funding_step_receipt_observations
      (operation_id,step_id,attempt_id,network_id,status,canonical,action_match,first_seen_at,observed_at,evidence)
      select $1,$2,id,'evm:137','confirmed',true,true,now(),now(),
        jsonb_build_object('transactionHash',$3::text,'handoffEventIndex','3')
      from funding_operation_step_attempts where step_id=$2 and attempt_number=2`,
      [input.operationId, dense, otherHash],
    );
    let cursor: FundingHandoffActionCursor | null = null;
    const seen = new Set<string>();
    let preservedOtherHash = false;
    let boundSeen = false;
    let pages = 0;
    do {
      const page = await listFundingHandoffOperationPage(db, {
        facts,
        cursor,
        limit: 7,
      });
      for (const candidate of page.candidates) {
        assert.ok(
          !seen.has(candidate.attemptId),
          "cursor replay duplicated an attempt",
        );
        seen.add(candidate.attemptId);
        preservedOtherHash ||=
          candidate.resolvedTransactionHash === otherHash &&
          candidate.resolvedEventIndex === "3";
        boundSeen ||= candidate.stepId === bound;
      }
      cursor = page.nextCursor;
      assert.ok(
        ++pages < 80,
        "bounded operation page must make progress through dense attempts",
      );
    } while (cursor);
    assert.equal(pages, 74);
    assert.equal(seen.size, 514); // original + 512 issued dense + bound
    assert.ok(
      preservedOtherHash,
      "negative other-hash dependency must not be discarded",
    );
    assert.ok(boundSeen, "both unbound and bound steps must be scanned");
    const empty = await listFundingHandoffOperationPage(db, {
      facts,
      cursor: { stepOrdinal: 2147483647, attemptNumber: 2147483647 },
      limit: 7,
    });
    assert.deepEqual(empty, { candidates: [], nextCursor: null });
    await assert.rejects(
      listFundingHandoffOperationPage(db, {
        facts: { ...facts, userId: randomUUID() },
        cursor: null,
        limit: 7,
      }),
      FundingClassificationChangedError,
    );
    // Same-operation sparse tail: filtering kind before LIMIT would have to walk
    // all of these to claim a negative result. They must remain bounded work.
    await db.query(
      `insert into funding_operation_steps select copied_row.*
      from funding_operation_steps template_row cross join generate_series(1,10000) fixture_ordinal
      cross join lateral jsonb_populate_record(null::funding_operation_steps,
        to_jsonb(template_row)||jsonb_build_object('id',gen_random_uuid(),
          'ordinal',$2::integer+fixture_ordinal,'segment_id',null,
          'action_fingerprint',repeat(md5('sparse-'||fixture_ordinal::text),2),
          'normalized_action',template_row.normalized_action||'{"kind":"evm_transaction"}'::jsonb)) copied_row
      where template_row.id=$1`,
      [plain, originalOrdinal + 10],
    );
    // Many dense steps, not merely one dense step followed by a sparse tail.
    // A LATERAL page per step plus final LIMIT would still read ~limit squared.
    await db.query(
      `insert into funding_operation_steps select copied_row.*
      from funding_operation_steps template_row cross join generate_series(1,64) fixture_ordinal
      cross join lateral jsonb_populate_record(null::funding_operation_steps,
        to_jsonb(template_row)||jsonb_build_object('id',gen_random_uuid(),
          'ordinal',$2::integer+fixture_ordinal,'segment_id',null,
          'action_fingerprint',repeat(md5('dense-'||fixture_ordinal::text),2))) copied_row
      where template_row.id=$1`,
      [dense, originalOrdinal + 20000],
    );
    await db.query(
      `insert into funding_operation_step_attempts select copied_row.*
      from funding_operation_step_attempts template_row
      join funding_operation_steps fixture_step on fixture_step.operation_id=$2
        and fixture_step.ordinal>$3 and fixture_step.ordinal<=$3+64
      cross join generate_series(1,64) fixture_ordinal
      cross join lateral jsonb_populate_record(null::funding_operation_step_attempts,
        to_jsonb(template_row)||jsonb_build_object('id',gen_random_uuid(),'step_id',fixture_step.id,
          'attempt_number',fixture_ordinal,'canonical_action_fingerprint',fixture_step.action_fingerprint)) copied_row
      where template_row.id=$1`,
      [input.attemptId, input.operationId, originalOrdinal + 20000],
    );
    for (const table of [
      "funding_operation_steps",
      "funding_operation_step_attempts",
      "funding_step_receipt_observations",
    ])
      await db.query(`analyze ${table}`);
    await db.query(
      `prepare handoff_operation_page(uuid,uuid,integer,integer,integer) as ${FUNDING_HANDOFF_OPERATION_PAGE_SQL}`,
    );
    for (const mode of ["force_custom_plan", "force_generic_plan"]) {
      await db.query(`set local plan_cache_mode=${mode}`);
      for (const [name, ordinal, number, owner, count] of [
        ["first", -1, 0, input.userId, 51],
        ["dense-resume", originalOrdinal + 2, 200, input.userId, 51],
        ["sparse", originalOrdinal + 10, 0, input.userId, 51],
        ["many-dense", originalOrdinal + 20000, 0, input.userId, 51],
        ["many-dense-resume", originalOrdinal + 20001, 32, input.userId, 51],
        ["empty", 2147483647, 2147483647, input.userId, 0],
        ["foreign", -1, 0, randomUUID(), 0],
      ] as const) {
        const plan = (
          await db.query(
            `explain(analyze,buffers,format json) execute handoff_operation_page('${input.operationId}','${owner}',${ordinal},${number},51)`,
          )
        ).rows[0]["QUERY PLAN"][0];
        assert.equal(plan.Plan["Actual Rows"], count);
        const scans: unknown[] = [];
        const visit = (node: Record<string, unknown>) => {
          if (node["Relation Name"]) {
            if (
              Number(node["Rows Removed by Filter"] ?? 0) > 1 ||
              !["Index Scan", "Index Only Scan"].includes(
                String(node["Node Type"]),
              )
            )
              console.log(
                "[handoff-operation-unbounded-node]",
                JSON.stringify({ mode, name, node }),
              );
            assert.ok(
              ["Index Scan", "Index Only Scan"].includes(
                String(node["Node Type"]),
              ),
            );
            const rows =
              Number(node["Actual Rows"]) * Number(node["Actual Loops"]);
            assert.ok(
              rows <= 52,
              `unbounded ${node["Relation Name"]}: ${rows}`,
            );
            assert.ok(Number(node["Rows Removed by Filter"] ?? 0) <= 1);
            scans.push({
              relation: node["Relation Name"],
              rows,
              index: node["Index Name"],
            });
          }
          for (const child of (node.Plans ?? []) as Record<string, unknown>[])
            visit(child);
        };
        visit(plan.Plan);
        console.log(
          "[handoff-operation-page]",
          JSON.stringify({
            mode,
            name,
            ms: plan["Execution Time"],
            buffers:
              plan.Plan["Local Hit Blocks"] + plan.Plan["Local Read Blocks"],
            scans,
          }),
        );
      }
    }
    await db.query("deallocate handoff_operation_page");
    console.log(
      "PASS bounded handoff operation pages: unbound/bound, dense/sparse, negative references, owner and exact cursor",
    );
  } finally {
    await db.query("rollback to savepoint handoff_operation_pages");
    await db.query("release savepoint handoff_operation_pages");
  }
}
