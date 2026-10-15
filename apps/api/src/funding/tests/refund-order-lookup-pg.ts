import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { RelayReferenceCodec } from "../../funding-providers/relay/reference-codec.js";
import type { RelayRequestEvidence } from "../../funding-providers/relay/request-evidence.js";
import {
  REFUND_ORDER_LOOKUP_SQL,
  findCommittedRelayRefundCandidate,
} from "../reconciliation/relay-refund-order-lookup.js";

/** Real committed envelope, isolated shadow tables and real PG16 indexed plans.
 * No global fixtures, provider IO or mutation of the committed financial rows. */
export async function verifyRefundOrderLookupPg(
  db: Pick<PoolClient, "query">,
  input: {
    operationId: string;
    segmentId: string;
    request: RelayRequestEvidence;
    referenceCodec: RelayReferenceCodec;
  },
) {
  await db.query("savepoint refund_order_lookup");
  try {
    for (const table of ["funding_operations", "funding_operation_segments"]) {
      await db.query(
        `create temp table ${table} (like public.${table} including indexes) on commit drop`,
      );
      const columns = await db.query<{ column_name: string }>(
        "select column_name from information_schema.columns where table_schema='public' and table_name=$1 and is_nullable='NO'",
        [table],
      );
      for (const { column_name: column } of columns.rows) {
        if (column === "id") continue;
        assert.match(column, /^[a-z_][a-z0-9_]*$/u);
        await db.query(
          `alter table pg_temp.${table} alter column "${column}" drop not null`,
        );
      }
    }
    await db.query(
      "insert into pg_temp.funding_operations select * from public.funding_operations where id=$1",
      [input.operationId],
    );
    await db.query(
      "insert into pg_temp.funding_operation_segments select * from public.funding_operation_segments where id=$1",
      [input.segmentId],
    );
    const segment = (
      await db.query(
        "select provider_quote_ref_lookup_hmac,lookup_key_version,refund_location_snapshot from funding_operation_segments where id=$1",
        [input.segmentId],
      )
    ).rows[0];
    const userId = (
      await db.query("select user_id from funding_operations where id=$1", [
        input.operationId,
      ])
    ).rows[0].user_id as string;
    const find = (
      extra: Partial<
        Parameters<typeof findCommittedRelayRefundCandidate>[1]
      > = {},
    ) =>
      findCommittedRelayRefundCandidate(db, {
        userId,
        request: input.request,
        referenceCodec: input.referenceCodec,
        ...extra,
      });
    const candidate = await find();
    assert.equal(candidate.kind, "candidate");
    assert.equal(candidate.operationId, input.operationId);
    assert.equal(candidate.segmentId, input.segmentId);
    const rotated = await find({
      referenceCodec: {
        ...input.referenceCodec,
        keyVersion: input.referenceCodec.keyVersion + 1,
        fingerprint: () => "different-current-hmac",
      },
    });
    assert.equal(rotated.kind, "candidate");
    assert.equal(
      rotated.context.identity.requestFingerprint,
      segment.provider_quote_ref_lookup_hmac,
    );
    assert.equal(
      rotated.context.identity.lookupKeyVersion,
      segment.lookup_key_version,
    );
    assert.deepEqual(await find({ userId: randomUUID() }), {
      kind: "pending",
      reason: "refund_reverse_order_ambiguous",
    });
    assert.deepEqual(
      await find({
        request: { ...input.request, id: "different-refund-request" },
      }),
      { kind: "pending", reason: "refund_committed_request_mismatch" },
    );
    assert.deepEqual(
      await find({
        referenceCodec: {
          ...input.referenceCodec,
          decrypt: () => {
            throw new Error("private-key-detail");
          },
        },
      }),
      { kind: "pending", reason: "refund_committed_request_unavailable" },
    );
    assert.deepEqual(
      await find({
        request: { ...input.request, refundProjectionInvalid: true },
      }),
      { kind: "pending", reason: "refund_reverse_order_invalid" },
    );
    assert.deepEqual(
      await find({
        request: {
          ...input.request,
          protocol: { orderId: `0x${"0".repeat(64)}` },
        },
      }),
      { kind: "unmatched" },
    );

    // Terminal status and a foreign owner's duplicate must remain visible.
    await db.query(
      "update funding_operations set status='cancelled' where id=$1",
      [input.operationId],
    );
    assert.equal((await find()).kind, "candidate");
    const foreignOperationId = randomUUID(),
      duplicateId = randomUUID();
    await db.query(
      "insert into funding_operations(id,user_id,status) values($1,$2,'succeeded')",
      [foreignOperationId, randomUUID()],
    );
    await db.query(
      "insert into funding_operation_segments(id,operation_id,provider_id,refund_location_snapshot) values($1,$2,'relay',$3)",
      [duplicateId, foreignOperationId, segment.refund_location_snapshot],
    );
    assert.deepEqual(await find(), {
      kind: "pending",
      reason: "refund_reverse_order_ambiguous",
    });
    await db.query(
      "update funding_operation_segments set provider_id='different-provider' where id=$1",
      [duplicateId],
    );
    assert.equal(
      (await find()).kind,
      "candidate",
      "only Relay orders inhabit the exact namespace",
    );

    await db.query(`insert into funding_operations(id,user_id)
      select md5('reverse-order-operation-'||entry)::uuid, md5('reverse-order-user-'||entry)::uuid
      from generate_series(1,50000) entry`);
    await db.query(`insert into funding_operation_segments(id,operation_id,provider_id,refund_location_snapshot)
      select md5('reverse-order-segment-'||entry)::uuid, md5('reverse-order-operation-'||entry)::uuid,
        case when entry % 10 = 0 then 'other' else 'relay' end,
        jsonb_build_object('relayProtocolOrderId',case when entry % 100 = 0 then repeat('legacy',1000)
          else '0x'||md5('reverse-order-'||entry)||md5('reverse-order-tail-'||entry) end)
      from generate_series(1,50000) entry`);
    await db.query("analyze funding_operations");
    await db.query("analyze funding_operation_segments");
    await db.query("set local plan_cache_mode=force_generic_plan");
    await db.query(
      `prepare refund_order_probe(text) as ${REFUND_ORDER_LOOKUP_SQL}`,
    );
    const orderId = input.request.protocol?.orderId;
    assert.ok(orderId && /^0x[0-9a-f]{64}$/iu.test(orderId));
    const cases = [
      ["hit", orderId.toLowerCase(), 1],
      ["miss", `0x${"0".repeat(64)}`, 0],
      ["excluded-provider", `0x${"f".repeat(64)}`, 0],
    ] as const;
    await db.query(
      "update funding_operation_segments set refund_location_snapshot=jsonb_build_object('relayProtocolOrderId',$2::text) where id=$1",
      [duplicateId, cases[2][1]],
    );
    for (const [label, value, expectedRows] of cases) {
      const result = await db.query(
        `explain (analyze,buffers,format json) execute refund_order_probe('${value}')`,
      );
      const plan = result.rows[0]["QUERY PLAN"][0];
      assert.equal(plan.Plan["Actual Rows"], expectedRows);
      assert.doesNotMatch(JSON.stringify(plan), /Seq Scan/u);
      assert.match(JSON.stringify(plan), /Index (Only )?Scan/u);
      console.log(
        `[refund-order-lookup] ${label}: ${plan["Execution Time"]}ms, ${plan.Plan["Local Hit Blocks"]} local hits, ${plan.Plan["Actual Rows"]} rows`,
      );
    }
    await db.query(
      "update funding_operation_segments set provider_id='relay',refund_location_snapshot=$2 where id=$1",
      [duplicateId, segment.refund_location_snapshot],
    );
    const collision = await db.query(
      `explain (analyze,buffers,format json) execute refund_order_probe('${orderId.toLowerCase()}')`,
    );
    const plan = collision.rows[0]["QUERY PLAN"][0];
    assert.equal(plan.Plan["Actual Rows"], 2);
    assert.doesNotMatch(JSON.stringify(plan), /Seq Scan/u);
    console.log(
      `[refund-order-lookup] collision: ${plan["Execution Time"]}ms, ${plan.Plan["Local Hit Blocks"]} local hits, 2 rows`,
    );
    assert.deepEqual(await find(), {
      kind: "pending",
      reason: "refund_reverse_order_ambiguous",
    });
  } finally {
    await db.query("rollback to savepoint refund_order_lookup");
    await db.query("deallocate refund_order_probe").catch(() => undefined);
  }
}
