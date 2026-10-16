import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import {
  readReceiveDestinationActionPage,
  destinationActionProgressSchema,
} from "../receive/receive-destination-action-scan.js";
import { relayDestinationReferenceIdentity } from "../../funding-providers/relay/destination-reference.js";
import { verifyReceiveExactDestinationEvidencePg } from "./receive-exact-role-evidence-pg.js";

/** Runs inside the existing rollback-only large action benchmark. Shadows all
 * modified relations; no public facts, provider request or financial writer. */
export async function verifyReceiveDestinationPagesPg(
  db: Pick<PoolClient, "query">,
  input: { operationId: string; segmentId: string },
) {
  const scoped =
    await db.query(`select count(*)::int as total from pg_class relation_row
    where relation_row.relnamespace=pg_my_temp_schema() and relation_row.relname in
    ('funding_operations','funding_operation_segments','funding_operation_steps','funding_operation_step_attempts')`);
  assert.equal(scoped.rows[0].total, 4);
  await db.query("savepoint receive_destination_page_semantics");
  try {
    // The large destination workload shadows these relations with a different
    // subset. Copy the exact action fixture's parent into those temp tables.
    await db.query(
      "insert into funding_operations select * from public.funding_operations where id=$1 on conflict(id) do nothing",
      [input.operationId],
    );
    await db.query(
      "insert into funding_operation_segments select * from public.funding_operation_segments where id=$1 and operation_id=$2 on conflict(id) do nothing",
      [input.segmentId, input.operationId],
    );
    const userId = (
      await db.query("select user_id from funding_operations where id=$1", [
        input.operationId,
      ])
    ).rows[0].user_id as string;
    const asset = {
      networkId: "evm:137",
      assetId: `0x${"12".repeat(20)}`,
      decimals: 6,
    };
    const event = {
      networkId: asset.networkId,
      asset,
      destinationAddress: `0x${"34".repeat(20)}`,
      sourceAddress: `0x${"56".repeat(20)}`,
      rawAmount: "1000000",
      transactionHash: `0x${"78".repeat(32)}`,
      eventIndex: "1",
      ledgerHeight: "1",
      blockHash: `0x${"90".repeat(32)}`,
      observedAt: new Date(),
    };
    await db.query(
      `update funding_operations set status='in_progress',progress_stage='source_action',completed_at=null,
      destination_target_snapshot=$2 where id=$1`,
      [
        input.operationId,
        { location: { asset, details: { address: event.destinationAddress } } },
      ],
    );
    await db.query(
      "update funding_operation_segments set provider_id='relay',raw_status='pending',support_metadata='{}',quoted_min_output=$2 where id=$1",
      [input.segmentId, { asset, raw: "1" }],
    );
    // All previous attempt refs remain present but no source movement yet. The
    // initial small fixture has two rows, so limit=1 must resume across pages.
    await db.query(
      `update funding_operation_step_attempts set outcome='succeeded',broadcast_may_have_occurred=false,finished_at=clock_timestamp()
      where step_id in(select id from funding_operation_steps where operation_id=$1)`,
      [input.operationId],
    );
    const request = {
      ...input,
      userId,
      event,
      progress: null,
      limit: 1,
      referenceCodec: { fingerprint: () => "f".repeat(64) },
    };
    const first = await readReceiveDestinationActionPage(db, request);
    assert.equal(first.kind, "continuation");
    if (first.kind !== "continuation") throw Error("missing continuation");
    assert.ok(destinationActionProgressSchema.safeParse(first).success);
    const completed = await readReceiveDestinationActionPage(db, {
      ...request,
      progress: first,
    });
    assert.equal(completed.kind, "complete");
    if (completed.kind !== "complete") throw Error("missing completion");
    assert.equal(completed.match, "unrelated");
    // Ambiguous broadcast still requires recovery, including a source approval:
    // the original destination classifier checks exposure, not verified debit.
    await db.query(
      `update funding_operation_step_attempts set outcome='ambiguous',broadcast_may_have_occurred=true
      where step_id=(select step_row.id from funding_operation_steps step_row
        join funding_operation_step_attempts attempt_row on attempt_row.step_id=step_row.id
        where step_row.operation_id=$1 order by step_row.ordinal limit 1)`,
      [input.operationId],
    );
    const pending = await readReceiveDestinationActionPage(db, {
      ...request,
      limit: 2,
    });
    assert.equal(pending.kind, "complete");
    if (pending.kind !== "complete") throw Error("missing pending");
    assert.equal(pending.match, "possible");
    // Same attempt under an unrelated leg, and then unbound, is never this
    // destination's exposure. Temp rows intentionally have no live FK writer.
    for (const segment of [randomUUID(), null]) {
      await db.query(
        "update funding_operation_steps set segment_id=$2 where operation_id=$1",
        [input.operationId, segment],
      );
      const a = await readReceiveDestinationActionPage(db, request);
      assert.equal(a.kind, "continuation");
      const b = await readReceiveDestinationActionPage(db, {
        ...request,
        progress: a,
      });
      assert.equal(b.kind, "complete");
      if (b.kind !== "complete") throw Error("missing other-leg completion");
      assert.equal(b.match, "unrelated");
    }
    // Retained exact reference is authoritative even after provider status
    // changes; no amount/threshold or attempt scan is added to its semantics.
    await db.query(
      "update funding_operation_segments set raw_status='refund',support_metadata=$2 where id=$1",
      [
        input.segmentId,
        {
          relaySuccessfulDestinationReferenceHashesV1: [
            relayDestinationReferenceIdentity(event.transactionHash),
          ],
        },
      ],
    );
    const exact = await readReceiveDestinationActionPage(db, {
      ...request,
      referenceCodec: undefined,
    });
    assert.equal(exact.kind, "complete");
    if (exact.kind !== "complete") throw Error("missing exact");
    assert.equal(exact.match, "exact");
    assert.equal(exact.referenceRetryRequired, false);
    await verifyReceiveExactDestinationEvidencePg(db, {
      ...input,
      userId,
      event,
    });
    assert.deepEqual(
      await readReceiveDestinationActionPage(db, {
        ...request,
        userId: randomUUID(),
      }),
      { kind: "unavailable" },
    );
    console.log(
      "PASS destination role pages: actual PG reader, continuation, negative facts, ambiguous exposure, unrelated/unbound legs, retained exact reference, foreign owner",
    );
  } finally {
    await db.query("rollback to savepoint receive_destination_page_semantics");
    await db.query("release savepoint receive_destination_page_semantics");
  }
}
