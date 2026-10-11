// @requires-db
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Pool } from "@hunch/infra";
import { createIntegrationTestPool } from "./test-database-target.js";
import { repairUnrecordedCopies } from "./services/verified-copy-repair.js";
import { EvidenceBudgetExhausted } from "./services/verified-buy.js";
import type { VerifiedBuyObserverDependencies } from "./services/verified-buy-observer.js";

const pool = await createIntegrationTestPool({ max: 1 });
const client = await pool.connect();
const copier = randomUUID(),
  note = randomUUID();
let claimSql = "";
const db = {
  query: async (text: string, values: unknown[] = []) => {
    if (text.includes("with due_copy")) claimSql = text;
    return client.query(text, values);
  },
} as unknown as Pool;
const position = `0x${"1".repeat(40)}`;
const deps: VerifiedBuyObserverDependencies = {
  maxEvidenceItems: 100,
  limitlessPositionContract: position,
  limitlessExchangeAddress: position,
  solanaCollateralMint: "usd",
  readLimitlessOrder: async () => {
    throw new EvidenceBudgetExhausted(1, 0);
  },
  readEvmReceipt: async () => {
    throw new Error("Unexpected receipt read");
  },
  readPolymarketFills: async () => [],
  readDflowOrder: async () => null,
  readFinalizedSolanaTransaction: async () => null,
};
const policy = {
  batchSize: 50,
  concurrency: 2,
  leaseSeconds: 120,
  retrySeconds: 30,
  recheckSeconds: 3600,
};
type PlanNode = Record<string, unknown> & { Plans?: PlanNode[] };
const walk = (node: PlanNode): PlanNode[] => [
  node,
  ...(node.Plans ?? []).flatMap(walk),
];
try {
  assert.equal(
    Math.floor(
      Number(
        (
          await client.query(
            "select current_setting('server_version_num') as version",
          )
        ).rows[0].version,
      ) / 10000,
    ),
    16,
  );
  await client.query("begin");
  await client.query("set local statement_timeout='120s'");
  await client.query("set local lock_timeout='5s'");
  assert.equal(
    Number(
      (
        await client.query(
          "select count(*) as due_rows from copy_attributions where copier_user_id is not null and order_id is null and execution_id is null and repair_due_at<=now()",
        )
      ).rows[0].due_rows,
    ),
    0,
    "Run with no other due orphan copy fixtures",
  );
  await client.query(
    "insert into users(id,display_name) values($1,'Copy batch fixture')",
    [copier],
  );
  await client.query(
    "insert into ai_notes(id,note_key,note_type,title,description,producer_type,producer_run_id) values($1::uuid,$1::text,'signal','Copy batch fixture','Fixture','holder_research','fixture')",
    [note],
  );
  const insert = `insert into copy_attributions(copier_user_id,source_ai_note_id,source_snapshot,instrument,idempotency_key,payload_hash,prepared_fingerprint,provider_reference,repair_due_at)
    select $1,$2,'{}','{}',$3||fixture_row.ordinality,'fixture','fixture',$3||fixture_row.ordinality,
      now()+$4::int*interval '1 second' from generate_series(1,$5::int) as fixture_row(ordinality) returning id`;
  await client.query(insert, [
    copier,
    note,
    `${copier}:future:`,
    86400,
    100000,
  ]);
  const dueIds = (
    await client.query<{ id: string }>(insert, [
      copier,
      note,
      `${copier}:due:`,
      0,
      9,
    ])
  ).rows
    .map((row) => row.id)
    .sort();
  await client.query("analyze copy_attributions");
  assert.equal(
    (await repairUnrecordedCopies(db, deps, { ...policy, batchSize: 7 }))
      .checked,
    7,
  );
  assert.equal((await repairUnrecordedCopies(db, deps, policy)).checked, 2);
  assert.equal((await repairUnrecordedCopies(db, deps, policy)).checked, 0);
  // A capacity failure is temporary: prove the actual persisted retry is 30s,
  // and that a depleted chunk does not claim the other seven due rows.
  const marketId = `limitless:budget:${copier}`;
  const tokenId = `limitless:budget-token:${copier}`;
  await client.query(
    `insert into unified_events(id,venue,venue_event_id,title,status)
    values($1,'limitless',$1,'Budget fixture','ACTIVE')`,
    [marketId],
  );
  await client.query(
    `insert into unified_markets(id,venue,venue_market_id,event_id,title,status,market_type,outcomes)
    values($1,'limitless',$1,$1,'Budget fixture','ACTIVE','binary','["Yes","No"]')`,
    [marketId],
  );
  await client.query(
    `insert into unified_tokens(token_id,venue,market_id,side)
    values($1,'limitless',$2,'YES')`,
    [tokenId, marketId],
  );
  const instrument = {
    venue: "limitless",
    marketId,
    tokenId,
    outcome: "YES",
    generation: `8453:${position}:${tokenId}`,
    expiry: null,
  };
  await client.query(
    `update copy_attributions set repair_due_at=now(),instrument=$2::jsonb,
    source_snapshot=$3::jsonb,provider_reference='limitless:clob:8453:'||id::text where id=any($1::uuid[])`,
    [
      dueIds,
      JSON.stringify(instrument),
      JSON.stringify({ submission: { walletAddress: position } }),
    ],
  );
  const capacity = await repairUnrecordedCopies(db, deps, policy);
  assert.equal(capacity.checked, 2);
  assert.equal(capacity.budgetExhausted, 2);
  const delays = (
    await client.query(
      "select extract(epoch from repair_due_at-now())::int as delay_seconds,count(*)::int as row_count from copy_attributions where id=any($1::uuid[]) group by repair_due_at order by repair_due_at",
      [dueIds],
    )
  ).rows;
  assert.deepEqual(delays, [
    { delay_seconds: 0, row_count: 7 },
    { delay_seconds: 30, row_count: 2 },
  ]);
  await client.query(
    "update copy_attributions set repair_due_at=now(),repair_lease_token=null,repair_lease_until=null where id=any($1::uuid[])",
    [dueIds],
  );
  await client.query(
    `prepare verified_copy_batch(integer,integer,uuid[]) as ${claimSql}`,
  );
  for (const [scenario, excluded, expected] of [
    ["first", [] as string[], 2],
    ["resumed", dueIds.slice(0, 2), 2],
    ["empty", dueIds, 0],
  ] as const) {
    for (const generic of [false, true]) {
      await client.query("savepoint copy_batch_plan");
      await client.query(
        `set local plan_cache_mode=${generic ? "force_generic_plan" : "force_custom_plan"}`,
      );
      const literal = (
        await client.query(
          "select quote_literal($1::uuid[]) as excluded_literal",
          [excluded],
        )
      ).rows[0].excluded_literal;
      const explained = generic
        ? await client.query(
            `explain(analyze,buffers,format json) execute verified_copy_batch(2,120,${literal}::uuid[])`,
          )
        : await client.query(
            `explain(analyze,buffers,format json) ${claimSql}`,
            [2, 120, excluded],
          );
      const plan = explained.rows[0]["QUERY PLAN"][0];
      const nodes = walk(plan.Plan);
      const scan = nodes.find(
        (node) => node["Index Name"] === "copy_attributions_repair_due_idx",
      );
      assert.ok(scan);
      assert.ok(
        !nodes.some(
          (node) =>
            node["Node Type"] === "Seq Scan" &&
            node["Relation Name"] === "copy_attributions",
        ),
      );
      assert.equal(
        nodes.find((node) => node["Subplan Name"] === "CTE due_copy")?.[
          "Actual Rows"
        ],
        expected,
      );
      const visited =
        Number(scan["Actual Rows"]) +
        Number(scan["Rows Removed by Filter"] ?? 0);
      assert.ok(visited <= dueIds.length);
      if (generic)
        assert.ok(
          Number(
            (
              await client.query(
                "select generic_plans from pg_prepared_statements where name='verified_copy_batch'",
              )
            ).rows[0].generic_plans,
          ) > 0,
        );
      console.log(
        JSON.stringify({
          scenario,
          generic,
          futureRows: 100000,
          dueRows: 9,
          queueRowsExamined: visited,
          executionMs: plan["Execution Time"],
          sharedHits: plan.Plan["Shared Hit Blocks"],
          sharedReads: plan.Plan["Shared Read Blocks"],
          index: scan["Index Name"],
        }),
      );
      await client.query("rollback to savepoint copy_batch_plan");
      await client.query("release savepoint copy_batch_plan");
    }
  }
  await client.query("deallocate verified_copy_batch");
  console.log(
    "Verified copy batching PG16: 7/2/0 batches, capacity retry30s,6 custom/generic index plans over100k future copies",
  );
} finally {
  await client.query("rollback");
  client.release();
  await pool.end();
}
