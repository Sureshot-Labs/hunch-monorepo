import assert from "node:assert/strict";
import type { Pool } from "pg";
import { READ_RECEIVE_ANCHOR_HINTS_SQL } from "../receive/prepare-receive-anchors.js";
import {
  READ_PENDING_RECEIVE_ANCHOR_SQL,
  LOCK_PENDING_RECEIVE_ANCHOR_SQL,
  REPAIR_PENDING_RECEIVE_ANCHOR_SQL,
  RESET_REANCHORED_RECEIVE_SCAN_SQL,
} from "../persistence/funding-pending-receive-anchor.js";

/** Exact deployed ownership body, not an approximate app-side query. Shadow
 * relations are transaction-local and disappear on rollback. No real financial
 * tables or provider state are seeded by this representative plan fixture. */
export async function verifyPendingReceiveAnchorPlansPg(pool: Pool) {
  const db = await pool.connect();
  try {
    await db.query("begin");
    await db.query("set local statement_timeout='20s'");
    const body = (
      await db.query<{ prosrc: string }>(
        "select prosrc from pg_proc where oid='funding_receive_physical_event_is_owned(text,text,text)'::regprocedure",
      )
    ).rows[0].prosrc
      .replace(/\bphysical_network\b/gu, "$1")
      .replace(/\bphysical_transaction\b/gu, "$2")
      .replace(/\bphysical_index\b/gu, "$3");
    await db.query(`create temp table funding_observations(network_id text,tx_hash text,event_index text) on commit drop;
      create temp table funding_receive_receipts(network_id text,tx_hash text,event_index text) on commit drop;
      create temp table funding_step_receipt_observations(network_id text,evidence jsonb) on commit drop;`);
    for (const relation of [
      "funding_observations",
      "funding_receive_receipts",
    ]) {
      await db.query(
        `insert into ${relation} select 'evm:8453','0x'||repeat(md5('${relation}'||ordinal),2),'7' from generate_series(1,120000) ordinal`,
      );
      await db.query(
        `create index on ${relation}(network_id,md5(lower(tx_hash))) where tx_hash is not null`,
      );
    }
    await db.query(`insert into funding_step_receipt_observations select 'evm:8453',jsonb_build_object(
      'transactionHash','0x'||repeat(md5('step'||ordinal),2),'handoffEventIndex','8',
      'handoffOwnedPhysicalEventV1',jsonb_build_object('transactionHash','0x'||repeat(md5('retained'||ordinal),2),'handoffEventIndex','9'))
      from generate_series(1,120000) ordinal;
      create index on funding_step_receipt_observations(network_id,md5(lower(evidence->>'transactionHash')))
        where evidence->>'transactionHash' is not null;
      create index on funding_step_receipt_observations(network_id,md5(lower(evidence#>>'{handoffOwnedPhysicalEventV1,transactionHash}')))
        where evidence#>>'{handoffOwnedPhysicalEventV1,transactionHash}' is not null;
      insert into funding_step_receipt_observations values('evm:8453',jsonb_build_object('transactionHash','0X'||repeat('AB',32)));
      analyze funding_observations;analyze funding_receive_receipts;analyze funding_step_receipt_observations;`);
    const cases = [
      {
        name: "empty-tail",
        tx: "0x" + "ff".repeat(32),
        index: "7",
        owned: false,
      },
      ...["funding_observations", "funding_receive_receipts"].map(
        (relation) => ({
          name: relation,
          tx: "",
          index: "7",
          owned: true,
          sql: `'0x'||repeat(md5('${relation}120000'),2)`,
        }),
      ),
      {
        name: "outer-other-log",
        tx: "",
        sql: "'0x'||repeat(md5('step120000'),2)",
        index: "7",
        owned: false,
      },
      {
        name: "outer-exact",
        tx: "",
        sql: "'0x'||repeat(md5('step120000'),2)",
        index: "8",
        owned: true,
      },
      {
        name: "retained-marker",
        tx: "",
        sql: "'0x'||repeat(md5('retained120000'),2)",
        index: "9",
        owned: true,
      },
      {
        name: "legacy-case-missing-hint",
        tx: "0x" + "ab".repeat(32),
        index: "7",
        owned: true,
      },
    ];
    const metrics: unknown[] = [];
    const nodes = (
      root: Record<string, unknown>,
    ): Record<string, unknown>[] => [
      root,
      ...((root.Plans ?? []) as Record<string, unknown>[]).flatMap(nodes),
    ];
    for (const mode of ["force_custom_plan", "force_generic_plan"]) {
      await db.query(`set local plan_cache_mode=${mode}`);
      await db.query(
        `prepare pending_ownership_plan(text,text,text) as ${body}`,
      );
      for (const sample of cases) {
        const expression = "sql" in sample ? sample.sql : `'${sample.tx}'`;
        const query = `execute pending_ownership_plan('evm:8453',${expression},'${sample.index}')`;
        const result = (await db.query(query)).rows[0];
        assert.equal(Object.values(result)[0], sample.owned);
        const plan = (
          await db.query(`explain(analyze,buffers,format json) ${query}`)
        ).rows[0]["QUERY PLAN"][0];
        const all = nodes(plan.Plan);
        assert.ok(
          !all.some((node) => node["Node Type"] === "Seq Scan"),
          `${mode}/${sample.name} must use compact physical indexes`,
        );
        const buffers =
          Number(plan.Plan["Local Hit Blocks"] ?? 0) +
          Number(plan.Plan["Local Read Blocks"] ?? 0);
        assert.ok(
          buffers < 40,
          `${sample.name}: ${buffers} buffers on 360k rows`,
        );
        metrics.push({
          mode,
          name: sample.name,
          ms: plan["Execution Time"],
          buffers,
        });
      }
      await db.query("deallocate pending_ownership_plan");
    }
    // Existing canonical PK is the only lookup needed for hint/CAS/header
    // repair. Include exact hit/miss and a full batch under generic plans.
    await db.query(`create temp table funding_receive_canonical_events(like public.funding_receive_canonical_events including all) on commit drop;
      create temp table funding_receive_refund_scans(like public.funding_receive_refund_scans including all) on commit drop;
      insert into funding_receive_canonical_events(id,network_id,asset_id,asset_decimals,destination_address,source_address,raw_amount,
        tx_hash,event_index,ledger_height,block_hash,observed_at,allocation_status,first_observed_at,last_observed_at)
      select md5('anchor'||ordinal)::uuid,'evm:8453','0x'||repeat('ab',20),6,'0x'||repeat('cd',20),'0x'||repeat('ef',20),1000000,
        '0x'||repeat(md5('anchor'||ordinal),2),'7',100,'0x'||repeat('ab',32),now(),'pending',now(),now()
      from generate_series(1,50000) ordinal;
      insert into funding_receive_refund_scans(event_id,contract_version,user_id,receive_session_id,variant_id)
      select id,5,md5('owner')::uuid,null,null from funding_receive_canonical_events;
      analyze funding_receive_canonical_events;analyze funding_receive_refund_scans;`);
    for (const mode of ["force_custom_plan", "force_generic_plan"]) {
      await db.query(`set local plan_cache_mode=${mode}`);
      await db.query(
        `prepare pending_read_plan(uuid) as ${READ_PENDING_RECEIVE_ANCHOR_SQL}`,
      );
      await db.query(
        `prepare pending_lock_plan(uuid,jsonb) as ${LOCK_PENDING_RECEIVE_ANCHOR_SQL}`,
      );
      await db.query(
        `prepare pending_repair_plan(uuid,jsonb,text,text,jsonb) as ${REPAIR_PENDING_RECEIVE_ANCHOR_SQL}`,
      );
      await db.query(
        `prepare pending_reset_plan(uuid) as ${RESET_REANCHORED_RECEIVE_SCAN_SQL}`,
      );
      await db.query(
        `prepare pending_hints_plan(jsonb) as ${READ_RECEIVE_ANCHOR_HINTS_SQL}`,
      );
      for (const ordinal of [1, 50001]) {
        const key = `md5('anchor${ordinal}')::uuid`;
        // EXECUTE parameters cannot contain subqueries; capture exact row JSON.
        const captured =
          (
            await db.query(
              `select to_jsonb(event_row)::text as snapshot from funding_receive_canonical_events event_row where id=${key}`,
            )
          ).rows[0]?.snapshot ?? "{}";
        const literal = `'${captured.replaceAll("'", "''")}'::jsonb`;
        for (const query of [
          `execute pending_read_plan(${key})`,
          `execute pending_lock_plan(${key},${literal})`,
          `execute pending_repair_plan(${key},${literal},'101','0x${"cd".repeat(32)}','[]'::jsonb)`,
          `execute pending_reset_plan(${key})`,
          `execute pending_hints_plan('[{"network_id":"evm:8453","tx_hash":"${"0x" + "00".repeat(32)}","event_index":"7"}]')`,
          `execute pending_hints_plan((jsonb_build_array(jsonb_build_object('network_id','evm:8453','tx_hash','0x'||repeat(md5('anchor1'),2),'event_index','7'),jsonb_build_object('network_id','evm:8453','tx_hash','0x'||repeat('00',32),'event_index','7'))))`,
        ]) {
          await db.query("savepoint pending_plan");
          const plan = (
            await db.query(`explain(analyze,buffers,format json) ${query}`)
          ).rows[0]["QUERY PLAN"][0];
          const all = nodes(plan.Plan);
          assert.ok(!all.some((node) => node["Node Type"] === "Seq Scan"));
          const buffers =
            Number(plan.Plan["Local Hit Blocks"] ?? 0) +
            Number(plan.Plan["Local Read Blocks"] ?? 0);
          assert.ok(buffers < 45, `${query.slice(0, 40)} ${buffers}`);
          metrics.push({
            mode,
            name: query.slice(0, query.indexOf("(")),
            ordinal,
            ms: plan["Execution Time"],
            buffers,
          });
          await db.query("rollback to savepoint pending_plan");
        }
      }
      for (const name of [
        "pending_read_plan",
        "pending_lock_plan",
        "pending_repair_plan",
        "pending_reset_plan",
        "pending_hints_plan",
      ])
        await db.query(`deallocate ${name}`);
    }
    console.log(
      "Pending receive anchor PG16 representative plans",
      JSON.stringify(metrics),
    );
  } finally {
    await db.query("rollback");
    db.release();
  }
}
