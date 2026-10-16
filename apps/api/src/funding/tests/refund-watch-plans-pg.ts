import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Pool } from "@hunch/infra";
import {
  REFUND_CANONICAL_OPERATION_SQL,
  REFUND_CANONICAL_PAGE_SQL,
  REFUND_CANONICAL_RECEIPT_SQL,
  LOCK_REFUND_CANONICAL_RECEIPT_SQL,
} from "../reconciliation/relay-refund-watch-context.js";

/** All new read/row-CAS statements on real PG16; 50k dense receipts and 50k
 * sparse same-owner operations with one receipt each. Shadows are rollback-local and
 * keep installed observation/segment indexes, not an approximate PK-only feed.
 */
export async function verifyRefundWatchPlansPg(
  pool: Pool,
  operationId: string,
) {
  const db = await pool.connect();
  try {
    await db.query("begin");
    const seed = (
      await db.query(
        `select to_jsonb(observation_row) as data from public.funding_observations observation_row
      where operation_id=$1 and kind='refund_credit' order by id limit 1`,
        [operationId],
      )
    ).rows[0]?.data;
    assert.ok(seed);
    await db.query(`create temp table funding_operations(id uuid primary key,user_id uuid,source_snapshot jsonb,support_metadata jsonb) on commit drop;
      create temp table funding_operation_segments(like public.funding_operation_segments including defaults including indexes) on commit drop;
      create temp table funding_observations(like public.funding_observations including defaults including indexes) on commit drop;
      create temp table funding_classification_revisions(like public.funding_classification_revisions including indexes) on commit drop;
      create temp table watch_plan_keys on commit drop as select gen_random_uuid() as operation_id,gen_random_uuid() as segment_id,
        gen_random_uuid() as receipt_id,series_index from generate_series(1,50000) series_index;`);
    await db.query(
      `insert into funding_operations select id,user_id,source_snapshot,support_metadata from public.funding_operations where id=$1`,
      [operationId],
    );
    await db.query(
      `insert into funding_operation_segments select * from public.funding_operation_segments where operation_id=$1`,
      [operationId],
    );
    await db.query(
      `insert into funding_classification_revisions select * from public.funding_classification_revisions where operation_id=$1`,
      [operationId],
    );
    await db.query(
      `insert into funding_observations select (jsonb_populate_record(null::funding_observations,$1::jsonb)).*`,
      [JSON.stringify(seed)],
    );
    await db.query(
      `insert into funding_operations select operation_id,$1::uuid,'{}','{}' from watch_plan_keys`,
      [
        (
          await db.query("select user_id from funding_operations where id=$1", [
            operationId,
          ])
        ).rows[0].user_id,
      ],
    );
    const segment = (
      await db.query(
        "select to_jsonb(segment_row) as data from funding_operation_segments segment_row where id=$1",
        [seed.segment_id],
      )
    ).rows[0].data;
    await db.query(
      `insert into funding_operation_segments select (populated_row.row_data).* from watch_plan_keys key_row
      cross join lateral(select jsonb_populate_record(null::funding_operation_segments,
        $1::jsonb||jsonb_build_object('id',key_row.segment_id,'operation_id',key_row.operation_id)) as row_data offset 0) populated_row`,
      [JSON.stringify(segment)],
    );
    await db.query(
      `insert into funding_classification_revisions select operation_id,7 from watch_plan_keys`,
    );
    await db.query(
      `insert into funding_observations select (populated_row.row_data).* from watch_plan_keys key_row
      cross join lateral(select jsonb_populate_record(null::funding_observations,
        $1::jsonb||jsonb_build_object('id',key_row.receipt_id,'event_index',key_row.series_index::text,
          'tx_hash','0x'||repeat(md5(key_row.receipt_id::text),2))) as row_data offset 0) populated_row`,
      [JSON.stringify(seed)],
    );
    await db.query(
      `insert into funding_observations select (populated_row.row_data).* from watch_plan_keys key_row
      cross join lateral(select jsonb_populate_record(null::funding_observations,
        $1::jsonb||jsonb_build_object('id',gen_random_uuid(),'operation_id',key_row.operation_id,
          'segment_id',key_row.segment_id,'tx_hash','0x'||repeat(md5(key_row.operation_id::text),2))) as row_data offset 0) populated_row`,
      [JSON.stringify(seed)],
    );
    await db.query(
      "analyze funding_operations;analyze funding_operation_segments;analyze funding_observations;analyze funding_classification_revisions",
    );
    const middle = (
      await db.query(
        "select id from funding_observations where operation_id=$1 order by id offset 25000 limit 1",
        [operationId],
      )
    ).rows[0].id;
    const sparse = (
      await db.query(
        "select operation_id from watch_plan_keys order by series_index limit 1",
      )
    ).rows[0].operation_id;
    const snapshot = (
      await db.query(
        "select to_jsonb(observation_row)::text as snapshot from funding_observations observation_row where id=$1",
        [seed.id],
      )
    ).rows[0].snapshot.replaceAll("'", "''");
    const metrics: unknown[] = [];
    for (const mode of ["force_custom_plan", "force_generic_plan"]) {
      await db.query(`set local plan_cache_mode=${mode}`);
      const statements = [
        [
          "watch_operation",
          "uuid",
          REFUND_CANONICAL_OPERATION_SQL,
          [`'${operationId}'`, `'${randomUUID()}'`],
        ],
        [
          "watch_page",
          "uuid,uuid,integer",
          REFUND_CANONICAL_PAGE_SQL,
          [
            `'${operationId}','00000000-0000-0000-0000-000000000000',25`,
            `'${operationId}','${middle}',25`,
            `'${operationId}','ffffffff-ffff-ffff-ffff-ffffffffffff',25`,
            `'${sparse}','00000000-0000-0000-0000-000000000000',25`,
            `'${sparse}','ffffffff-ffff-ffff-ffff-ffffffffffff',25`,
            `'${randomUUID()}','00000000-0000-0000-0000-000000000000',25`,
          ],
        ],
        ...[
          ["watch_receipt", REFUND_CANONICAL_RECEIPT_SQL],
          ["watch_receipt_lock", LOCK_REFUND_CANONICAL_RECEIPT_SQL],
        ].map(([name, sql]) => [
          name,
          "uuid,uuid,jsonb",
          sql,
          [
            `'${seed.id}','${operationId}','${snapshot}'`,
            `'${seed.id}','${operationId}','{}'`,
            `'${seed.id}','${randomUUID()}',null`,
            `'${randomUUID()}','${operationId}',null`,
          ],
        ]),
      ] as [string, string, string, string[]][];
      for (const [name, types, sql, samples] of statements) {
        await db.query(`prepare ${name}(${types}) as ${sql}`);
        try {
          for (let sample = 0; sample < samples.length; sample++) {
            const result = (
              await db.query(
                `explain(analyze,buffers,format json) execute ${name}(${samples[sample]})`,
              )
            ).rows[0]["QUERY PLAN"][0];
            const plan = result.Plan;
            const buffers = [
              "Local Hit Blocks",
              "Local Read Blocks",
              "Shared Hit Blocks",
              "Shared Read Blocks",
            ].reduce((sum, key) => sum + (plan[key] ?? 0), 0);
            let maxRowsVisited = 0;
            const inspectNode = (node: Record<string, unknown>) => {
              if (typeof node["Relation Name"] === "string")
                maxRowsVisited = Math.max(
                  maxRowsVisited,
                  Number(node["Actual Rows"] ?? 0) +
                    Number(node["Rows Removed by Filter"] ?? 0),
                );
              for (const child of (node.Plans ?? []) as Record<
                string,
                unknown
              >[])
                inspectNode(child);
            };
            inspectNode(plan);
            assert.ok(
              !JSON.stringify(plan).includes('"Node Type":"Seq Scan"'),
              JSON.stringify(result),
            );
            assert.ok(buffers < 500, JSON.stringify(result));
            assert.ok(maxRowsVisited <= 25, JSON.stringify(result));
            metrics.push({
              mode,
              name,
              sample,
              ms: result["Execution Time"],
              rows: plan["Actual Rows"],
              buffers,
              maxRowsVisited,
            });
          }
        } finally {
          await db.query(`deallocate ${name}`);
        }
      }
    }
    console.log(
      "PASS canonical watch 50k dense + 50k sparse custom/generic page, by-id, locking CAS and empty-tail plans",
      JSON.stringify(metrics),
    );
  } finally {
    await db.query("rollback");
    db.release();
  }
}
