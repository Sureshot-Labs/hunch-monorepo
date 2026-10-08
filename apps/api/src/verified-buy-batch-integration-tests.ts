// @requires-db
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Pool } from "@hunch/infra";
import { createIntegrationTestPool } from "./test-database-target.js";
import { repairVerifiedBuys } from "./services/verified-buy.js";

type Kind = "order" | "execution";
type CapturedClaim = { kind: Kind; text: string; values: unknown[] };
type PlanNode = {
  [key: string]: unknown;
  Plans?: PlanNode[];
};
const pool = await createIntegrationTestPool({ max: 1 });
const client = await pool.connect();
const fixtureUser = randomUUID(),
  backgroundUser = randomUUID();
const tables = { order: "orders", execution: "executions" } as const;
const futureCounts = { order: 100_000, execution: 200_000 } as const;
const dueIds: Record<Kind, string[]> = { order: [], execution: [] };
const claims: CapturedClaim[] = [];
const observed: string[] = [];
const db = {
  query: async (text: string, values: unknown[] = []) => {
    if (text.includes("with due_purchase")) {
      claims.push({
        kind: text.includes("from orders") ? "order" : "execution",
        text,
        values: values.map((value) =>
          Array.isArray(value) ? [...value] : value,
        ),
      });
    }
    return client.query(text, values);
  },
} as unknown as Pick<Pool, "query">;
const policy = {
  batchSize: 50,
  concurrency: 2,
  leaseSeconds: 120,
  retrySeconds: 30,
  verifiedRecheckSeconds: 3600,
  observe: async (claim: { purchaseRef: { id: string } }) => {
    observed.push(claim.purchaseRef.id);
    return { state: "pending" as const, reason: "scale_fixture_pending" };
  },
};
function walkPlan(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(walkPlan)];
}

try {
  const version = Number(
    (
      await client.query(
        "select current_setting('server_version_num') as version",
      )
    ).rows[0].version,
  );
  assert.equal(
    Math.floor(version / 10000),
    16,
    "This fixture targets PostgreSQL 16",
  );
  await client.query("begin");
  await client.query("set local statement_timeout='120s'");
  await client.query("set local lock_timeout='5s'");
  // Exact database fencing above and this queue preflight keep the unfiltered
  // production claim query from interacting with other tests' pending work.
  for (const table of Object.values(tables)) {
    assert.equal(
      Number(
        (
          await client.query(
            `select count(*) as due_rows from ${table} where verified_buy_due_at<=now()`,
          )
        ).rows[0].due_rows,
      ),
      0,
      `Run this fixture with no other due ${table}`,
    );
  }
  await client.query(
    "insert into users(id,display_name) values($1,'Batch scale fixture'),($2,'Batch scale background')",
    [fixtureUser, backgroundUser],
  );
  for (const kind of ["order", "execution"] as const) {
    const table = tables[kind];
    // SELL avoids the BUY scheduling trigger replacing this explicitly future
    // due time. The production claim predicate does not filter on side.
    await client.query(
      `insert into ${table}(user_id,venue,side,status,verified_buy_due_at)
       select $1,'limitless','SELL','filled',now()+interval '1 day'+fixture_row.ordinality*interval '1 second'
       from generate_series(1,$2::int) as fixture_row(ordinality)`,
      [backgroundUser, futureCounts[kind]],
    );
    const due = await client.query<{ id: string }>(
      `insert into ${table}(user_id,venue,side,status)
       select $1,'limitless','BUY','filled' from generate_series(1,5) as fixture_row(ordinality)
       returning id`,
      [fixtureUser],
    );
    dueIds[kind] = due.rows.map((row) => row.id).sort();
    assert.equal(
      Number(
        (
          await client.query(
            `select count(*) as fixture_rows from ${table} where user_id=$1 and verified_buy_due_at>now()`,
            [backgroundUser],
          )
        ).rows[0].fixture_rows,
      ),
      futureCounts[kind],
    );
    await client.query(`analyze ${table}`);
  }

  // Exercise the real loop and its storage/projection query before explaining
  // captured claim SQL. Six total means two chunks from orders and one from executions.
  const first = await repairVerifiedBuys(db, { ...policy, batchSize: 6 });
  assert.equal(first.claimed, 6);
  assert.equal(first.pending, 6);
  assert.deepEqual(
    claims.map((claim) => claim.kind),
    ["order", "execution", "order"],
  );
  assert.deepEqual(
    [...(claims[2]?.values[2] as string[])].sort(),
    dueIds.order.slice(0, 2),
  );
  const remaining = await repairVerifiedBuys(db, policy);
  assert.equal(remaining.claimed, 4);
  assert.equal(new Set(observed).size, 10);
  assert.equal((await repairVerifiedBuys(db, policy)).claimed, 0);

  for (const kind of ["order", "execution"] as const) {
    const table = tables[kind];
    const statement = claims.find((claim) => claim.kind === kind);
    assert.ok(statement);
    await client.query(
      `update ${table} set verified_buy_due_at=now()-interval '1 minute',
       verified_buy_lease_token=null,verified_buy_lease_until=null where id=any($1::uuid[])`,
      [dueIds[kind]],
    );
    const preparedName = `verified_buy_batch_${kind}`;
    await client.query(
      `prepare ${preparedName}(integer,integer,uuid[]) as ${statement.text}`,
    );
    for (const scenario of [
      { name: "first", seenIds: [] as string[], claimed: 2, noDue: false },
      {
        name: "exclusion_resumed",
        seenIds: dueIds[kind].slice(0, 2),
        claimed: 2,
        noDue: false,
      },
      {
        name: "excluded_empty_tail",
        seenIds: dueIds[kind],
        claimed: 0,
        noDue: false,
      },
      {
        name: "future_only_empty_tail",
        seenIds: [] as string[],
        claimed: 0,
        noDue: true,
      },
    ]) {
      for (const generic of [false, true]) {
        await client.query("savepoint verified_buy_batch_plan");
        if (scenario.noDue) {
          await client.query(
            `update ${table} set verified_buy_due_at=now()+interval '1 hour' where id=any($1::uuid[])`,
            [dueIds[kind]],
          );
        }
        await client.query(
          `set local plan_cache_mode=${generic ? "force_generic_plan" : "force_custom_plan"}`,
        );
        const values = [2, policy.leaseSeconds, scenario.seenIds];
        const explained = generic
          ? await client.query(
              `explain (analyze,buffers,format json) execute ${preparedName}(2,${policy.leaseSeconds},${
                (
                  await client.query(
                    "select quote_literal($1::uuid[]) as seen_literal",
                    [scenario.seenIds],
                  )
                ).rows[0].seen_literal
              }::uuid[])`,
            )
          : await client.query(
              `explain (analyze,buffers,format json) ${statement.text}`,
              values,
            );
        const plan = explained.rows[0]["QUERY PLAN"][0];
        if (generic) {
          const prepared = await client.query(
            "select generic_plans from pg_prepared_statements where name=$1",
            [preparedName],
          );
          assert.ok(
            Number(prepared.rows[0].generic_plans) > 0,
            "The server used a real generic prepared plan",
          );
        }
        const nodes = walkPlan(plan.Plan);
        const queueScans = nodes.filter(
          (node) => node["Index Name"] === `${table}_verified_buy_due_idx`,
        );
        assert.ok(
          queueScans.length,
          `${kind}/${scenario.name} uses the due index`,
        );
        assert.ok(
          !nodes.some(
            (node) =>
              node["Node Type"] === "Seq Scan" &&
              node["Relation Name"] === table,
          ),
          `${kind}/${scenario.name} must not scan the unrelated future queue`,
        );
        const dueLimit = nodes.find(
          (node) => node["Subplan Name"] === "CTE due_purchase",
        );
        assert.ok(dueLimit);
        assert.equal(dueLimit["Actual Rows"], scenario.claimed);
        const scans = nodes
          .filter(
            (node) =>
              node["Relation Name"] === table &&
              String(node["Node Type"]).includes("Scan"),
          )
          .map((node) => ({
            type: node["Node Type"],
            index: node["Index Name"],
            rows: node["Actual Rows"],
            loops: node["Actual Loops"],
            filtered: node["Rows Removed by Filter"] ?? 0,
            sharedHits: node["Shared Hit Blocks"] ?? 0,
            sharedReads: node["Shared Read Blocks"] ?? 0,
          }));
        for (const scan of queueScans) {
          const visited =
            (Number(scan["Actual Rows"]) +
              Number(scan["Rows Removed by Filter"] ?? 0)) *
            Number(scan["Actual Loops"]);
          assert.ok(
            visited <= dueIds[kind].length,
            "Queue work is bounded by the few due rows, not future fixture size",
          );
        }
        console.log(
          JSON.stringify({
            scenario: `${kind}_${scenario.name}`,
            generic,
            futureRows: futureCounts[kind],
            dueRows: scenario.noDue ? 0 : dueIds[kind].length,
            excluded: scenario.seenIds.length,
            claimed: scenario.claimed,
            executionMs: plan["Execution Time"],
            sharedHits: plan.Plan["Shared Hit Blocks"],
            sharedReads: plan.Plan["Shared Read Blocks"],
            scans,
          }),
        );
        // EXPLAIN ANALYZE executes the real lease update; undo each probe so
        // custom and generic plans see exactly the same queue and exclusions.
        await client.query("rollback to savepoint verified_buy_batch_plan");
        await client.query("release savepoint verified_buy_batch_plan");
      }
    }
    await client.query(`deallocate ${preparedName}`);
  }
  console.log(
    "Verified buy batching PG16: real 6/4/0 batch consumption; 16 custom/generic claim plans over 100k orders and 200k executions",
  );
} finally {
  await client.query("rollback");
  client.release();
  await pool.end();
}
