#!/usr/bin/env tsx
// @requires-db
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import "../../../integration-test-database-guard.js";
import { pool } from "../../../db.js";
import { loadFundingEvidenceRepairSnapshot } from "../../persistence/funding-evidence-repair-repository.js";
import {
  FUNDING_EVIDENCE_REPAIR_REVISION,
  fundingEvidenceRepairCompatibleSql,
} from "../../reconciliation/funding-evidence-repair-state.js";

// Scaled fixtures are transaction-owned and rolled back; no migrations, new
// indexes, production facts, provider calls, or execution callbacks are used.
const client = await pool.connect();
try {
  await client.query("begin");
  await client.query("set local statement_timeout='15s'");
  await client.query("set local lock_timeout='2s'");
  const seed = (
    await client.query<{ id: string }>(
      `select operation_row.id from funding_operations operation_row
       join users user_row on user_row.id=operation_row.user_id
       where user_row.email like 'embedded-cancel-%@example.com'
         and exists(select 1 from funding_operation_steps action_row where action_row.operation_id=operation_row.id)
       order by operation_row.created_at limit 1`,
    )
  ).rows[0];
  assert.ok(
    seed,
    "run the embedded submission fixture profile before this scale profile",
  );
  await client.query(`create temporary table funding_repair_plan_ids on commit drop as
    select gen_random_uuid() as operation_id,gen_random_uuid() as quote_id,generate_series as ordinal
    from generate_series(1,10000)`);
  await client.query(
    `with cloned_rows as materialized (
    select jsonb_populate_record(null::funding_quotes,to_jsonb(quote_row)||jsonb_build_object(
      'id',fixture_row.quote_id,'consent_token_hash',repeat(md5(fixture_row.quote_id::text),2))) as cloned_row
    from funding_repair_plan_ids fixture_row cross join funding_operations operation_row
    join funding_quotes quote_row on quote_row.id=operation_row.quote_id where operation_row.id=$1)
    insert into funding_quotes select (cloned_row).* from cloned_rows`,
    [seed.id],
  );
  await client.query(
    `with cloned_rows as materialized (
    select jsonb_populate_record(null::funding_operations,to_jsonb(operation_row)||jsonb_build_object(
      'id',fixture_row.operation_id,'quote_id',fixture_row.quote_id,'idempotency_key',fixture_row.operation_id::text,
      'status',case when fixture_row.ordinal%1000=0 then 'recovery_required' else 'completed' end,
      'progress_stage',case when fixture_row.ordinal%1000=0 then 'source_action' else 'terminal' end,
      'recovery_mode',case when fixture_row.ordinal%1000=0 then 'manual_review' else null end,
      'completed_at',case when fixture_row.ordinal%1000=0 then null else now() end,
      'support_metadata','{}'::jsonb,'version',1)) as cloned_row
    from funding_repair_plan_ids fixture_row cross join funding_operations operation_row where operation_row.id=$1)
    insert into funding_operations select (cloned_row).* from cloned_rows`,
    [seed.id],
  );
  await client.query(
    `with cloned_rows as materialized (
    select jsonb_populate_record(null::funding_operation_steps,to_jsonb(action_row)||jsonb_build_object(
      'id',gen_random_uuid(),'operation_id',fixture_row.operation_id,'segment_id',null,'depends_on_step_id',null)) as cloned_row
    from funding_repair_plan_ids fixture_row cross join lateral
      (select * from funding_operation_steps where operation_id=$1 order by ordinal limit 1) action_row)
    insert into funding_operation_steps select (cloned_row).* from cloned_rows`,
    [seed.id],
  );
  await client.query(`insert into funding_reconciliation_jobs(operation_id,status,due_at,completed_at)
    select operation_id,case when ordinal=10000 then 'scheduled' when ordinal%1000=0 then 'dead_letter' else 'completed' end,
      now(),case when ordinal=10000 then null else now() end from funding_repair_plan_ids`);
  await client.query("analyze funding_operations");
  await client.query("analyze funding_operation_steps");
  await client.query("analyze funding_reconciliation_jobs");
  const at = new Date(Date.now() + 8 * 86400_000).toISOString();
  const pageFirst = (
    await client.query<{ id: string }>(
      "select id from funding_operations order by id limit 100",
    )
  ).rows.map((row) => row.id);
  const resumedAnchor = (
    await client.query<{ operation_id: string }>(
      "select operation_id from funding_repair_plan_ids where ordinal=1000",
    )
  ).rows[0];
  assert.ok(resumedAnchor);
  const pageResumed = (
    await client.query<{ id: string }>(
      "select id from funding_operations where id >= $1 order by id limit 100",
      [resumedAnchor.operation_id],
    )
  ).rows.map((row) => row.id);
  let snapshotSql = "";
  await loadFundingEvidenceRepairSnapshot(
    {
      query: async (sql: string) => {
        snapshotSql = sql;
        return { rows: [] };
      },
    } as never,
    seed.id,
  );
  const reducerSource = readFileSync(
    new URL("../../reconciliation/funding-reducer.ts", import.meta.url),
    "utf8",
  );
  const headerStart = reducerSource.indexOf(
    "`select operation_row.status, operation_row.recovery_mode, operation_row.support_metadata,",
  );
  assert.ok(headerStart >= 0);
  const headerSql = reducerSource.slice(
    headerStart + 1,
    reducerSource.indexOf("`", headerStart + 1),
  );
  const start = reducerSource.indexOf("`with source_page as materialized (");
  assert.ok(start >= 0);
  const original = reducerSource.slice(
    start + 1,
    reducerSource.indexOf("`", start + 1),
  );
  const stoppedSelector =
    original
      .slice(
        0,
        original.indexOf("     update funding_reconciliation_jobs repair_job"),
      )
      .replace(
        '${fundingEvidenceRepairCompatibleSql("funding_operations")}',
        fundingEvidenceRepairCompatibleSql("funding_operations"),
      )
      .replace("for update of repair_job skip locked", "")
      .replace(/\$(3|4)/g, (_, number: string) =>
        number === "3" ? "$2" : "$3",
      ) + "select id from repair_candidate";
  const operationSource = readFileSync(
    new URL(
      "../../persistence/funding-operation-repository.ts",
      import.meta.url,
    ),
    "utf8",
  );
  const ordinaryStart = operationSource.indexOf("with candidates as (");
  assert.ok(ordinaryStart >= 0);
  const ordinarySelector =
    operationSource
      .slice(
        ordinaryStart,
        operationSource.indexOf(
          "      update funding_reconciliation_jobs job",
          ordinaryStart,
        ),
      )
      .replace(
        '${fundingEvidenceRepairCompatibleSql("operation_row")}',
        fundingEvidenceRepairCompatibleSql("operation_row"),
      )
      .replace("for update skip locked", "")
      .replace(/\$5/g, "$3") + "select id from candidates";
  await client.query(
    `prepare funding_repair_stopped(timestamptz,uuid[],text) as ${stoppedSelector}`,
  );
  await client.query(
    `prepare funding_repair_snapshot(uuid,timestamptz) as ${snapshotSql}`,
  );
  await client.query(
    `prepare funding_repair_queue(timestamptz,int,uuid[]) as ${ordinarySelector}`,
  );
  await client.query(
    `prepare funding_repair_header(uuid,timestamptz) as ${headerSql}`,
  );
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const array = (values: string[]) =>
    quote(`{${values.join(",")}}`) + "::uuid[]";
  const summaries: unknown[] = [];
  for (const mode of ["force_custom_plan", "force_generic_plan"]) {
    await client.query(`set local plan_cache_mode=${mode}`);
    for (const [label, statement] of [
      [
        "stopped_first_page",
        `funding_repair_stopped(${quote(at)},${array(pageFirst)},${quote(FUNDING_EVIDENCE_REPAIR_REVISION)})`,
      ],
      [
        "stopped_resumed_positive",
        `funding_repair_stopped(${quote(at)},${array(pageResumed)},${quote(FUNDING_EVIDENCE_REPAIR_REVISION)})`,
      ],
      [
        "stopped_empty_tail",
        `funding_repair_stopped(${quote(at)},${array([])},${quote(FUNDING_EVIDENCE_REPAIR_REVISION)})`,
      ],
      [
        "snapshot_exact",
        `funding_repair_snapshot(${quote(seed.id)},${quote(at)})`,
      ],
      [
        "snapshot_missing",
        `funding_repair_snapshot('00000000-0000-0000-0000-000000000000',${quote(at)})`,
      ],
      ["ordinary_sparse", `funding_repair_queue(${quote(at)},25,${array([])})`],
      [
        "dispatch_header_exact",
        `funding_repair_header(${quote(seed.id)},${quote(at)})`,
      ],
      [
        "dispatch_header_missing",
        `funding_repair_header('00000000-0000-0000-0000-000000000000',${quote(at)})`,
      ],
      [
        "dispatch_header_live_consent",
        `funding_repair_header(${quote(seed.id)},'2000-01-01T00:00:00Z')`,
      ],
    ]) {
      const result = (
        await client.query(
          `explain(analyze,buffers,timing off,format json) execute ${statement}`,
        )
      ).rows[0]["QUERY PLAN"][0];
      const indexes = new Set<string>();
      let scannedRows = 0;
      const walk = (node: Record<string, unknown>) => {
        if (typeof node["Index Name"] === "string")
          indexes.add(node["Index Name"]);
        if (String(node["Node Type"]).includes("Scan"))
          scannedRows +=
            (Number(node["Actual Rows"]) +
              Number(node["Rows Removed by Filter"] ?? 0)) *
            Number(node["Actual Loops"]);
        for (const child of (node.Plans ?? []) as Record<string, unknown>[])
          walk(child);
      };
      walk(result.Plan);
      summaries.push({
        mode,
        label,
        executionMs: result["Execution Time"],
        rows: result.Plan["Actual Rows"],
        sharedHit: result.Plan["Shared Hit Blocks"],
        sharedRead: result.Plan["Shared Read Blocks"],
        scannedRows,
        indexes: [...indexes],
      });
      if (
        label === "stopped_resumed_positive" ||
        label === "snapshot_exact" ||
        label === "dispatch_header_exact" ||
        label === "dispatch_header_live_consent"
      )
        assert.equal(result.Plan["Actual Rows"], 1);
      if (
        label === "stopped_empty_tail" ||
        label === "snapshot_missing" ||
        label === "dispatch_header_missing"
      )
        assert.equal(result.Plan["Actual Rows"], 0);
      if (label.startsWith("dispatch_header"))
        assert.ok(
          scannedRows < 100,
          "an exact dispatch header must not scan unrelated operations/steps",
        );
    }
  }
  console.log(
    JSON.stringify({
      fundingEvidenceRepairScale: {
        unrelatedOperations: 10000,
        unrelatedJobs: 10000,
        unrelatedSteps: 10000,
        summaries,
      },
    }),
  );
} finally {
  await client.query("rollback");
  // Restore statistics after rolling back this test's exact fixture set.
  await client.query("analyze funding_operations");
  await client.query("analyze funding_operation_steps");
  await client.query("analyze funding_reconciliation_jobs");
  client.release();
}
