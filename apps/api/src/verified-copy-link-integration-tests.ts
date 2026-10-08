// @requires-db
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Pool } from "@hunch/infra";
import { recoverCopyPurchaseLinks } from "./services/social-copy.js";
import { createIntegrationTestPool } from "./test-database-target.js";

type PlanNode = Record<string, unknown> & { Plans?: PlanNode[] };
const walkPlan = (node: PlanNode): PlanNode[] => [
  node,
  ...(node.Plans ?? []).flatMap(walkPlan),
];
const pool = await createIntegrationTestPool({ max: 1 });
const client = await pool.connect();
const copier = randomUUID();
const otherCopier = randomUUID();
const note = randomUUID();
const order = randomUUID();
const execution = randomUUID();
const clientOrderId = randomUUID();
const transactionSignature = randomUUID();
const walletAddress = randomUUID();
const pendingIds = Array.from({ length: 8 }, () => randomUUID()).sort();
const nonmatchingRowsPerKind = 200_000;
const selectedBatches: string[][] = [];
let selectorSql = "";
const db = {
  query: async (text: string, values: unknown[] = []) => {
    const result = await client.query(text, values);
    if (
      text.includes(
        "select id,copier_user_id,provider_reference,instrument from copy_attributions",
      )
    ) {
      selectorSql = text;
      selectedBatches.push(result.rows.map((row: { id: string }) => row.id));
    }
    return result;
  },
} as unknown as Pick<Pool, "query">;

async function explainSelector(
  scenario: string,
  expected: number,
): Promise<void> {
  for (const generic of [false, true]) {
    await client.query(
      `set local plan_cache_mode=${generic ? "force_generic_plan" : "force_custom_plan"}`,
    );
    const explained = await client.query(
      "explain(analyze,buffers,format json) execute copy_purchase_link_selector(3)",
    );
    const plan = explained.rows[0]["QUERY PLAN"][0];
    const nodes = walkPlan(plan.Plan);
    const scan = nodes.find(
      (node) => node["Index Name"] === "copy_attributions_pending_link_idx",
    );
    assert.ok(scan, `${scenario}: use the exact pending-link index`);
    assert.ok(
      !nodes.some(
        (node) =>
          node["Node Type"] === "Sort" ||
          node["Node Type"] === "Seq Scan" ||
          node["Node Type"] === "Bitmap Heap Scan",
      ),
      `${scenario}: do not scan/filter/sort the nonmatching backlog`,
    );
    assert.equal(plan.Plan["Actual Rows"], expected);
    const scannedRows =
      Number(scan["Actual Rows"]) + Number(scan["Rows Removed by Filter"] ?? 0);
    assert.equal(scannedRows, expected);
    const sharedHits = Number(plan.Plan["Shared Hit Blocks"] ?? 0);
    const sharedReads = Number(plan.Plan["Shared Read Blocks"] ?? 0);
    assert.ok(
      sharedHits + sharedReads < 100,
      `${scenario}: bounded index/heap buffers despite one million nonmatches`,
    );
    const counts = (
      await client.query(
        "select custom_plans,generic_plans from pg_prepared_statements where name='copy_purchase_link_selector'",
      )
    ).rows[0];
    assert.ok(Number(generic ? counts.generic_plans : counts.custom_plans) > 0);
    console.log(
      JSON.stringify({
        scenario,
        generic,
        nonmatchingRows: nonmatchingRowsPerKind * 5,
        pendingRowsAtStart: pendingIds.length,
        scannedRows,
        executionMs: plan["Execution Time"],
        sharedHits,
        sharedReads,
        index: scan["Index Name"],
        customPlans: counts.custom_plans,
        genericPlans: counts.generic_plans,
      }),
    );
  }
}

try {
  assert.equal(
    Math.floor(
      Number(
        (await client.query("show server_version_num")).rows[0]
          .server_version_num,
      ) / 10000,
    ),
    16,
    "This fixture targets PostgreSQL 16",
  );
  await client.query("begin");
  await client.query("set local statement_timeout='120s'");
  await client.query("set local lock_timeout='5s'");
  assert.equal(
    Number(
      (
        await client.query(
          "select count(*) as pending_rows from copy_attributions where copier_user_id is not null and state='pending' and order_id is null and execution_id is null",
        )
      ).rows[0].pending_rows,
    ),
    0,
    "Run with no other pending unlinked copy fixtures",
  );
  await client.query(
    "insert into users(id,display_name) values($1,'Copy link fixture'),($2,'Copy link decoy')",
    [copier, otherCopier],
  );
  await client.query(
    "insert into ai_notes(id,note_key,note_type,title,description,producer_type,producer_run_id) values($1::uuid,$1::text,'signal','Copy link fixture','Fixture','holder_research','fixture')",
    [note],
  );
  await client.query(
    `insert into orders(id,user_id,venue,side,status,order_payload)
    values($1,$2,'limitless','BUY','filled',jsonb_build_object('clientOrderId',$3::text)),
      (gen_random_uuid(),$4,'limitless','BUY','filled',jsonb_build_object('clientOrderId',$3::text)),
      (gen_random_uuid(),$4,'limitless','BUY','filled',jsonb_build_object('clientOrderId',$5::text))`,
    [order, copier, clientOrderId, otherCopier, pendingIds[0]],
  );
  await client.query(
    `insert into executions(id,user_id,venue,side,status,tx_signature,wallet_address)
    values($1,$2,'kalshi','BUY','fulfilled',$3,$4),
      (gen_random_uuid(),$2,'kalshi','BUY','fulfilled',$3,$5)`,
    [execution, copier, transactionSignature, walletAddress, randomUUID()],
  );
  for (const table of ["orders", "executions"]) {
    await client.query(
      `update ${table} set verified_buy_due_at=now()+interval '1 day' where user_id=any($1::uuid[])`,
      [[copier, otherCopier]],
    );
  }
  // Each predicate arm has a large older nonmatching population. Future
  // evidence-repair timestamps are deliberately irrelevant to link recovery.
  for (const kind of [
    "failed",
    "confirmed",
    "order",
    "execution",
    "anonymous",
  ]) {
    await client.query(
      `insert into copy_attributions(copier_user_id,source_ai_note_id,source_snapshot,instrument,idempotency_key,payload_hash,prepared_fingerprint,provider_reference,state,order_id,execution_id,updated_at,repair_due_at)
      select case when $3='anonymous' then null else $1::uuid end,$2,'{}','{}',
        $4||fixture_row.ordinality,'fixture','fixture',$4||fixture_row.ordinality,
        case when $3 in ('failed','confirmed') then $3 else 'pending' end,
        case when $3='order' then $5::uuid else null end,
        case when $3='execution' then $6::uuid else null end,
        now()-interval '1 year',now()+interval '1 year'
      from generate_series(1,$7::int) as fixture_row(ordinality)`,
      [
        copier,
        note,
        kind,
        `${copier}:${kind}:`,
        order,
        execution,
        nonmatchingRowsPerKind,
      ],
    );
  }
  for (const [index, id] of pendingIds.entries()) {
    const reference =
      index === 4
        ? `limitless:clob:8453:${clientOrderId}`
        : index === 5
          ? `dflow:mainnet:${transactionSignature}:${walletAddress}`
          : `limitless:clob:8453:${id}`;
    await client.query(
      `insert into copy_attributions(id,copier_user_id,source_ai_note_id,source_snapshot,instrument,idempotency_key,payload_hash,prepared_fingerprint,provider_reference,updated_at,repair_due_at)
      values($1::uuid,$2,$3,'{}','{}',$1::text,'fixture','fixture',$4,now()-interval '1 day',now()+interval '1 year')`,
      [id, copier, note, reference],
    );
  }
  await client.query("analyze copy_attributions");
  // Capture the production SQL without changing any fixture rows.
  assert.equal(await recoverCopyPurchaseLinks(db, 0), 0);
  assert.ok(selectorSql);
  await client.query(
    `prepare copy_purchase_link_selector(integer) as ${selectorSql}`,
  );
  await explainSelector("first", 3);

  assert.equal(await recoverCopyPurchaseLinks(db, 3), 0);
  assert.deepEqual(selectedBatches.at(-1), pendingIds.slice(0, 3));
  await explainSelector("after_unresolved_batch", 3);
  assert.equal(await recoverCopyPurchaseLinks(db, 3), 2);
  assert.deepEqual(selectedBatches.at(-1), pendingIds.slice(3, 6));
  await explainSelector("after_linked_batch", 3);
  assert.equal(await recoverCopyPurchaseLinks(db, 2), 0);
  assert.deepEqual(selectedBatches.at(-1), pendingIds.slice(6));
  assert.deepEqual(
    (
      await client.query(
        "select id,order_id,execution_id,state,updated_at=now() as touched,repair_due_at>now() as future_repair from copy_attributions where id=any($1::uuid[]) order by id",
        [pendingIds],
      )
    ).rows,
    pendingIds.map((id, index) => ({
      id,
      order_id: index === 4 ? order : null,
      execution_id: index === 5 ? execution : null,
      state: "pending",
      touched: true,
      future_repair: true,
    })),
    "Exact local identities link; unresolved and wrong-user identities rotate without becoming confirmed",
  );
  for (const [table, id] of [
    ["orders", order],
    ["executions", execution],
  ]) {
    assert.equal(
      (
        await client.query(
          `select verified_buy_due_at=now() as due from ${table} where id=$1`,
          [id],
        )
      ).rows[0].due,
      true,
    );
  }
  // An empty pending-link queue remains cheap despite all five large excluded
  // populations, including pending rows that already have either local link.
  await client.query(
    "update copy_attributions set state='failed' where id=any($1::uuid[]) and order_id is null and execution_id is null",
    [pendingIds],
  );
  await explainSelector("empty", 0);
  assert.equal(await recoverCopyPurchaseLinks(db, 3), 0);
  assert.deepEqual(selectedBatches.at(-1), []);
  console.log(
    "Copy link PG16: bounded actual recovery, oldest-update rotation, future repair eligibility, and exact order/execution links passed",
  );
} finally {
  await client.query("rollback");
  client.release();
  await pool.end();
}
