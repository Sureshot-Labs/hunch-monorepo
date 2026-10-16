import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { verifyHandoffOperationPagesPg } from "./receive-handoff-operation-pages-pg.js";
import { verifyReceiveExactHandoffEvidencePg } from "./receive-exact-role-evidence-pg.js";
import { verifyHandoffEventSnapshotPlansPg } from "./handoff-event-ownership-pg.js";
import {
  listPotentialPolymarketHandoffsForCanonicalEvents,
  FundingPolymarketHandoffLookupOverflowError,
  type FundingPolymarketHandoffCanonicalEventLookup,
} from "../persistence/funding-evidence-repository.js";

/** Disposable PG only, inside the caller's rollback transaction. The real
 * source query is captured, not copied into a separate benchmark query. */
export async function verifyReceiveHandoffSourcePg(
  db: PoolClient,
  input: {
    userId: string;
    operationId: string;
    stepId: string;
    attemptId: string;
    event: FundingPolymarketHandoffCanonicalEventLookup;
  },
) {
  await db.query("savepoint handoff_source_plans");
  try {
    for (const table of [
      "funding_operations",
      "funding_operation_steps",
      "funding_operation_step_attempts",
      "funding_step_receipt_observations",
    ] as const) {
      await db.query(
        `create temporary table ${table} (like public.${table} including all) on commit drop`,
      );
    }
    await db.query(
      "insert into funding_operations select * from public.funding_operations where id=$1",
      [input.operationId],
    );
    await db.query(
      "insert into funding_operation_steps select * from public.funding_operation_steps where id=$1",
      [input.stepId],
    );
    await db.query(
      "insert into funding_operation_step_attempts select * from public.funding_operation_step_attempts where id=$1",
      [input.attemptId],
    );
    await db.query(`create temporary table handoff_fixture_ids on commit drop as
      select fixture_ordinal,gen_random_uuid() as operation_id,gen_random_uuid() as step_id,
        gen_random_uuid() as attempt_id from generate_series(1,55000) fixture_ordinal`);
    await db.query(
      `insert into funding_operations select copied_row.*
      from handoff_fixture_ids fixture_row cross join funding_operations template_row
      cross join lateral jsonb_populate_record(null::funding_operations,
        to_jsonb(template_row)||jsonb_build_object('id',fixture_row.operation_id,
          'quote_id',gen_random_uuid(),'idempotency_key',fixture_row.operation_id::text,
          'user_id',case when fixture_row.fixture_ordinal<=5000 then $2::uuid else gen_random_uuid() end)) copied_row
      where template_row.id=$1`,
      [input.operationId, input.userId],
    );
    await db.query(
      `insert into funding_operation_steps select copied_row.*
      from handoff_fixture_ids fixture_row cross join funding_operation_steps template_row
      cross join lateral jsonb_populate_record(null::funding_operation_steps,
        to_jsonb(template_row)||jsonb_build_object('id',fixture_row.step_id,'operation_id',fixture_row.operation_id,
          'action_validation_result',template_row.action_validation_result||jsonb_build_object('amountRaw',(9000000+fixture_row.fixture_ordinal)::text))) copied_row
      where template_row.id=$1`,
      [input.stepId],
    );
    await db.query(
      `insert into funding_operation_step_attempts select copied_row.*
      from handoff_fixture_ids fixture_row cross join funding_operation_step_attempts template_row
      cross join lateral jsonb_populate_record(null::funding_operation_step_attempts,
        to_jsonb(template_row)||jsonb_build_object('id',fixture_row.attempt_id,'step_id',fixture_row.step_id)) copied_row
      where template_row.id=$1`,
      [input.attemptId],
    );
    for (const table of [
      "funding_operations",
      "funding_operation_steps",
      "funding_operation_step_attempts",
      "funding_step_receipt_observations",
    ] as const)
      await db.query(`analyze ${table}`);
    let sql = "";
    const actual = await listPotentialPolymarketHandoffsForCanonicalEvents(
      {
        query: async (statement: string, values: unknown[]) => {
          sql = statement;
          return db.query(statement, values);
        },
      } as never,
      {
        userId: input.userId,
        events: [input.event],
        currentLookupKeyVersion: 1,
      },
    );
    assert.equal(actual.length, 1);
    await verifyReceiveExactHandoffEvidencePg(db, input);
    await db.query("savepoint handoff_cancel_facts");
    const lookup = () =>
      listPotentialPolymarketHandoffsForCanonicalEvents(db, {
        userId: input.userId,
        events: [input.event],
        currentLookupKeyVersion: 1,
      });
    await db.query(
      `update funding_operation_step_attempts set outcome='cancelled',
      finished_at=started_at,actual_costs='{"reasonCode":"cancelled_after_safe_evidence"}'::jsonb
      where id=$1`,
      [input.attemptId],
    );
    assert.equal(
      (await lookup()).length,
      0,
      "only an exact server never-issued marker is harmless",
    );
    await db.query(
      `update funding_operation_step_attempts set actual_costs='{}'::jsonb where id=$1`,
      [input.attemptId],
    );
    assert.equal(
      (await lookup()).length,
      1,
      "ordinary client cancellation must remain possible",
    );
    await db.query(
      `update funding_operation_step_attempts set outcome='failed' where id=$1`,
      [input.attemptId],
    );
    assert.equal(
      (await lookup()).length,
      1,
      "ordinary client failure must remain possible",
    );
    await db.query(
      `insert into funding_operation_step_attempts select copied_row.*
      from funding_operation_step_attempts template_row
      cross join lateral jsonb_populate_record(null::funding_operation_step_attempts,
        to_jsonb(template_row)||jsonb_build_object('id',gen_random_uuid(),'attempt_number',2,
          'outcome','cancelled','actual_costs',jsonb_build_object('reasonCode','cancelled_after_safe_evidence'))) copied_row
      where template_row.id=$1`,
      [input.attemptId],
    );
    assert.deepEqual(
      (await lookup()).map((row) => row.attemptId),
      [input.attemptId],
      "later synthetic cancellation must not erase an earlier issued attempt",
    );
    await db.query("rollback to savepoint handoff_cancel_facts");
    await db.query("release savepoint handoff_cancel_facts");
    // Populate all lookup lanes. Empty receipt tables hide generic-plan scans.
    await db.query(
      `insert into funding_step_receipt_observations
        (operation_id,step_id,attempt_id,network_id,status,first_seen_at,observed_at,evidence)
      select operation_id,step_id,attempt_id,$1,'pending',now(),now(),
        jsonb_build_object('transactionHash','0x'||repeat(md5(attempt_id::text),2))
      from handoff_fixture_ids`,
      [input.event.networkId],
    );
    await db.query(
      `update funding_operation_step_attempts set outcome='submitted',
        broadcast_may_have_occurred=true,reference_kind='transaction',
        receipt_ref_ciphertext='fixture-only',receipt_ref_lookup_hmac=md5(id::text),
        lookup_key_version=1,finished_at=started_at where id<>$1`,
      [input.attemptId],
    );
    await db.query("analyze funding_operation_step_attempts");
    await db.query("analyze funding_step_receipt_observations");
    await verifyHandoffEventSnapshotPlansPg(db, {
      ...input,
      networkId: input.event.networkId,
    });
    const witness = (
      await db.query<{
        attempt_id: string;
        tx_hash: string;
        lookup_hmac: string;
      }>(
        `select attempt_id,'0x'||repeat(md5(attempt_id::text),2) as tx_hash,
        md5(attempt_id::text) as lookup_hmac
      from handoff_fixture_ids where fixture_ordinal=1`,
      )
    ).rows[0];
    assert.ok(witness);
    await db.query("set local plan_cache_mode=force_generic_plan");
    await db.query(
      `prepare handoff_source_plan(uuid,jsonb,text[],integer,integer) as ${sql}`,
    );
    const metrics: unknown[] = [];
    const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
    for (const [name, userId, event, key, expectedRows] of [
      ["sparse-hit", input.userId, input.event, 1, 1],
      [
        "same-user-empty",
        input.userId,
        { ...input.event, rawAmount: "0" },
        1,
        0,
      ],
      ["empty-user", randomUUID(), input.event, 1, 0],
      ["rotated-key", input.userId, input.event, 2, 1],
      [
        "reference-hit",
        input.userId,
        {
          ...input.event,
          rawAmount: "0",
          receiptRefLookupHmac: witness.lookup_hmac,
        },
        1,
        1,
      ],
      [
        "reference-miss",
        input.userId,
        { ...input.event, rawAmount: "0", receiptRefLookupHmac: "missing" },
        1,
        0,
      ],
      [
        "reference-other-user",
        randomUUID(),
        {
          ...input.event,
          rawAmount: "0",
          receiptRefLookupHmac: witness.lookup_hmac,
        },
        1,
        0,
      ],
      [
        "reference-old-key",
        input.userId,
        {
          ...input.event,
          rawAmount: "0",
          receiptRefLookupHmac: witness.lookup_hmac,
        },
        2,
        0,
      ],
      [
        "receipt-hit",
        input.userId,
        { ...input.event, rawAmount: "0", transactionHash: witness.tx_hash },
        2,
        1,
      ],
      [
        "receipt-miss",
        input.userId,
        {
          ...input.event,
          rawAmount: "0",
          transactionHash: `0x${"ff".repeat(32)}`,
        },
        2,
        0,
      ],
      [
        "receipt-other-user",
        randomUUID(),
        { ...input.event, rawAmount: "0", transactionHash: witness.tx_hash },
        2,
        0,
      ],
    ] as const) {
      const hmacs = event.receiptRefLookupHmac
        ? [event.receiptRefLookupHmac]
        : [];
      const plan = (
        await db.query(`explain(analyze,buffers,format json)
        execute handoff_source_plan(${literal(userId)},${literal(JSON.stringify([event]))},array[${hmacs.map(literal).join(",")}]::text[],${key},257)`)
      ).rows[0]["QUERY PLAN"][0];
      const nodes: Record<string, unknown>[] = [];
      const visit = (node: Record<string, unknown>) => {
        nodes.push(node);
        for (const child of (node.Plans ?? []) as Record<string, unknown>[])
          visit(child);
      };
      visit(plan.Plan);
      const localBlocks =
        Number(plan.Plan["Local Hit Blocks"] ?? 0) +
        Number(plan.Plan["Local Read Blocks"] ?? 0);
      const examinedRows = nodes
        .filter((n) => n["Relation Name"])
        .reduce(
          (total, n) =>
            total +
            (Number(n["Actual Rows"] ?? 0) +
              Number(n["Rows Removed by Filter"] ?? 0)) *
              Number(n["Actual Loops"] ?? 0),
          0,
        );
      assert.ok(
        localBlocks < 300,
        `${name}: unexpected historical buffer scan (${localBlocks})`,
      );
      assert.ok(
        examinedRows < 32,
        `${name}: unexpected historical row scan (${examinedRows})`,
      );
      assert.ok(
        !nodes.some(
          (n) => n["Node Type"] === "Seq Scan" && Number(n["Actual Loops"]) > 0,
        ),
        `${name}: sequential history scan`,
      );
      metrics.push({
        name,
        ms: plan["Execution Time"],
        localBlocks,
        examinedRows,
        indexes: nodes
          .filter((n) => n["Index Name"] && Number(n["Actual Loops"]) > 0)
          .map((n) => ({
            relation: n["Relation Name"],
            index: n["Index Name"],
            rows: n["Actual Rows"],
            loops: n["Actual Loops"],
            removed: n["Rows Removed by Filter"],
          })),
      });
      assert.equal(plan.Plan["Actual Rows"], expectedRows);
    }
    const batchRefs = (
      await db.query<{ lookup_hmac: string; tx_hash: string }>(
        `select md5(attempt_id::text) as lookup_hmac,'0x'||repeat(md5(attempt_id::text),2) as tx_hash
      from handoff_fixture_ids where fixture_ordinal<=32`,
      )
    ).rows;
    const batchEvents = batchRefs.map((row) => ({
      ...input.event,
      rawAmount: "0",
      receiptRefLookupHmac: row.lookup_hmac,
      transactionHash: row.tx_hash,
    }));
    const batchPlan = (
      await db.query(`explain(analyze,buffers,format json)
      execute handoff_source_plan(${literal(input.userId)},${literal(JSON.stringify(batchEvents))},
      array[${batchRefs.map((row) => literal(row.lookup_hmac)).join(",")}]::text[],1,257)`)
    ).rows[0]["QUERY PLAN"][0];
    const batchNodes: Record<string, unknown>[] = [];
    const visitBatch = (node: Record<string, unknown>) => {
      batchNodes.push(node);
      for (const child of (node.Plans ?? []) as Record<string, unknown>[])
        visitBatch(child);
    };
    visitBatch(batchPlan.Plan);
    const batchExamined = batchNodes
      .filter((n) => n["Relation Name"])
      .reduce(
        (total, n) =>
          total +
          (Number(n["Actual Rows"] ?? 0) +
            Number(n["Rows Removed by Filter"] ?? 0)) *
            Number(n["Actual Loops"] ?? 0),
        0,
      );
    const batchBuffers =
      Number(batchPlan.Plan["Local Hit Blocks"] ?? 0) +
      Number(batchPlan.Plan["Local Read Blocks"] ?? 0);
    assert.equal(batchPlan.Plan["Actual Rows"], 32);
    if (batchExamined >= 400 || batchBuffers >= 2000)
      console.log("[handoff-batch-unbounded-plan]", JSON.stringify(batchPlan));
    assert.ok(
      batchExamined < 400,
      `batch HMAC lane repeated whole batch: ${batchExamined}`,
    );
    assert.ok(
      batchBuffers < 2000,
      `batch HMAC lane history scan: ${batchBuffers}`,
    );
    metrics.push({
      name: "32-event-batch",
      ms: batchPlan["Execution Time"],
      localBlocks: batchBuffers,
      examinedRows: batchExamined,
    });
    await db.query("deallocate handoff_source_plan");
    await db.query("savepoint harmless_handoff_prefix");
    await db.query(
      `delete from funding_step_receipt_observations receipt_row using handoff_fixture_ids fixture_row
      where receipt_row.attempt_id=fixture_row.attempt_id and fixture_row.fixture_ordinal<=300`,
    );
    await db.query(
      `update funding_operation_step_attempts attempt_row set outcome='cancelled',broadcast_may_have_occurred=false,
        reference_kind=null,receipt_ref_ciphertext=null,receipt_ref_lookup_hmac=null,lookup_key_version=null
      from handoff_fixture_ids fixture_row
      where attempt_row.id=fixture_row.attempt_id and fixture_row.fixture_ordinal<=300`,
    );
    await db.query(
      `update funding_operation_steps step_row set action_validation_result=
        jsonb_set(step_row.action_validation_result,'{amountRaw}',to_jsonb($1::text))
      from handoff_fixture_ids fixture_row
      where step_row.id=fixture_row.step_id and fixture_row.fixture_ordinal<=300`,
      [input.event.rawAmount],
    );
    await db.query(
      `update funding_operation_step_attempts attempt_row set outcome='cancelled',
        finished_at=started_at,actual_costs='{"reasonCode":"cancelled_after_safe_evidence"}'::jsonb
      from handoff_fixture_ids fixture_row
      where attempt_row.id=fixture_row.attempt_id and fixture_row.fixture_ordinal<=300`,
    );
    assert.deepEqual(
      (await lookup()).map((row) => row.attemptId),
      [input.attemptId],
      "300 never-issued synthetic attempts cannot hide a genuine attempt behind the sentinel",
    );
    await db.query("savepoint only_harmless_handoffs");
    await db.query(
      `update funding_operation_step_attempts set outcome='cancelled',finished_at=started_at,
        actual_costs='{"reasonCode":"cancelled_after_safe_evidence"}'::jsonb where id=$1`,
      [input.attemptId],
    );
    assert.equal(
      (await lookup()).length,
      0,
      "all-harmless history must not overflow",
    );
    await db.query("rollback to savepoint only_harmless_handoffs");
    await db.query("release savepoint only_harmless_handoffs");
    await db.query(
      `update funding_operation_steps step_row set executor_id='polymarket_safe_relayer_v1',
        normalized_action=step_row.normalized_action||'{"handoffKind":"polymarket_safe_transfer"}'::jsonb
      from handoff_fixture_ids fixture_row
      where step_row.id=fixture_row.step_id and fixture_row.fixture_ordinal<=300`,
    );
    await db.query(
      `update funding_operation_step_attempts attempt_row set executor_id='polymarket_safe_relayer_v1',
        actual_costs='{"safeSubmission":{"version":1,"phase":"closed","expiresAt":"2026-10-14T12:00:00.000Z"}}'::jsonb
      from handoff_fixture_ids fixture_row
      where attempt_row.id=fixture_row.attempt_id and fixture_row.fixture_ordinal<=300`,
    );
    assert.deepEqual(
      (await lookup()).map((row) => row.attemptId),
      [input.attemptId],
      "300 closed never-admitted Safe preparations cannot hide a genuine attempt",
    );
    await db.query("savepoint only_closed_handoffs");
    await db.query(
      `update funding_operation_step_attempts set outcome='cancelled',finished_at=started_at,
        actual_costs='{"reasonCode":"cancelled_after_safe_evidence"}'::jsonb where id=$1`,
      [input.attemptId],
    );
    assert.equal(
      (await lookup()).length,
      0,
      "all closed preparations must not overflow",
    );
    await db.query("rollback to savepoint only_closed_handoffs");
    await db.query("release savepoint only_closed_handoffs");
    for (const incompleteProof of [
      { version: 1, phase: "closed", expiresAt: "2026-99-99T12:00:00.000Z" },
      {
        version: 1,
        phase: "closed",
        expiresAt: "2026-10-14T12:00:00.000Z",
        admittedAt: null,
      },
      { version: "1", phase: "closed", expiresAt: "2026-10-14T12:00:00.000Z" },
    ]) {
      await db.query(
        `update funding_operation_step_attempts attempt_row set actual_costs=jsonb_build_object('safeSubmission',$1::jsonb)
        from handoff_fixture_ids fixture_row
        where attempt_row.id=fixture_row.attempt_id and fixture_row.fixture_ordinal=1`,
        [JSON.stringify(incompleteProof)],
      );
      assert.equal(
        (await lookup()).length,
        2,
        "malformed or admitted Safe metadata is not a never-issued proof",
      );
    }
    await db.query("rollback to savepoint harmless_handoff_prefix");
    await db.query("release savepoint harmless_handoff_prefix");

    // Dense genuine uncertainty must not be converted into an external credit.
    // Current proof is re-read on every retry, including later reorg/rebinding.
    const event = { ...input.event, transactionHash: `0x${"ee".repeat(32)}` };
    const denseLookup = () =>
      listPotentialPolymarketHandoffsForCanonicalEvents(db, {
        userId: input.userId,
        events: [event],
        currentLookupKeyVersion: 2,
      });
    await db.query(
      `update funding_operation_steps step_row set action_validation_result=
        jsonb_set(step_row.action_validation_result,'{amountRaw}',to_jsonb($1::text))
      from handoff_fixture_ids fixture_row
      where step_row.id=fixture_row.step_id and fixture_row.fixture_ordinal<=300`,
      [input.event.rawAmount],
    );
    await assert.rejects(
      denseLookup(),
      FundingPolymarketHandoffLookupOverflowError,
    );
    await db.query(
      `update funding_step_receipt_observations receipt_row set status='confirmed',action_match=true,
        evidence=receipt_row.evidence||'{"handoffEventIndex":"2"}'::jsonb
      from handoff_fixture_ids fixture_row
      where receipt_row.attempt_id=fixture_row.attempt_id and fixture_row.fixture_ordinal<=300`,
    );
    assert.deepEqual(
      (await denseLookup()).map((row) => row.attemptId),
      [input.attemptId],
    );
    await db.query(
      `update funding_step_receipt_observations set status='reorged',canonical=false,reorged_at=now()
      where attempt_id=$1`,
      [witness.attempt_id],
    );
    assert.equal(
      (await denseLookup()).length,
      2,
      "reorg restores possible provenance immediately",
    );
    await db.query(
      `update funding_step_receipt_observations set status='mismatch',canonical=true,reorged_at=null,
        action_match=false,evidence=jsonb_build_object('transactionHash',$2::text)
      where attempt_id=$1`,
      [witness.attempt_id, event.transactionHash],
    );
    const rebound = (await denseLookup()).find(
      (row) => row.attemptId === witness.attempt_id,
    );
    assert.equal(rebound?.resolvedTransactionHash, event.transactionHash);
    assert.equal(rebound?.resolvedEventIndex, null);

    // A valid immutable validation snapshot must still reach the decoder even
    // if optional normalized payload fields are malformed. Oversized legacy
    // strings must not fail either index creation or a later update.
    await db.query(
      `update funding_operation_steps set normalized_action=normalized_action||'{"payload":null}'::jsonb
      where id=$1`,
      [input.stepId],
    );
    assert.ok(
      (await denseLookup()).some((row) => row.attemptId === input.attemptId),
    );
    await db.query(
      `update funding_operation_steps set action_validation_result=
        action_validation_result||jsonb_build_object('amountRaw',repeat('x',10000),'tokenAddress',null)
      where id=$1`,
      [input.stepId],
    );
    await verifyHandoffOperationPagesPg(db, input);
    return metrics;
  } finally {
    await db.query("rollback to savepoint handoff_source_plans");
    await db.query("release savepoint handoff_source_plans");
  }
}
