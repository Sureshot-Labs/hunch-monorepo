// @requires-db
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createIntegrationTestPool } from "./test-database-target.js";

const migration = await readFile(
  new URL(
    "../../../packages/db/migrations/0287_agent_theses.sql",
    import.meta.url,
  ),
  "utf8",
);
const pool = await createIntegrationTestPool({ max: 1 });
const client = await pool.connect();
try {
  await client.query("begin");
  await client.query("set local statement_timeout='10s'");
  // Shadow only the migration's two tables on this connection. The legacy
  // reference constraint is exactly the one from migration 0272/production.
  await client.query(`
    create temporary table users(id uuid primary key);
    create temporary table user_theses(
      id bigint primary key,
      canonical_purchase_key text not null,
      order_id uuid,
      execution_id uuid,
      check (num_nonnulls(order_id,execution_id)=1)
    );
    insert into users values(gen_random_uuid());
    insert into user_theses(id,canonical_purchase_key,order_id,execution_id)
      select sample.seq,'real:'||sample.seq,
        case when sample.seq%2=0 then gen_random_uuid() end,
        case when sample.seq%2=1 then gen_random_uuid() end
      from generate_series(1,1000) sample(seq);
  `);
  assert.equal(
    (
      await client.query("select current_schemas(true)::text as schemas")
    ).rows[0].schemas.includes("pg_temp_"),
    true,
  );
  await client.query(migration);
  assert.equal(
    (await client.query("select is_agent from users")).rows[0].is_agent,
    false,
  );
  assert.deepEqual(
    (
      await client.query(
        `select purchase_mode,count(*)::int as n from user_theses
         group by purchase_mode`,
      )
    ).rows,
    [{ purchase_mode: "real", n: 1000 }],
  );
  // A legacy writer which omits purchase_mode keeps creating real theses.
  await client.query(
    `insert into user_theses(id,canonical_purchase_key,order_id)
     values(1001,'real:legacy-after-upgrade',gen_random_uuid())`,
  );
  assert.equal(
    (await client.query("select purchase_mode from user_theses where id=1001"))
      .rows[0].purchase_mode,
    "real",
  );
  await client.query(
    `insert into user_theses(id,canonical_purchase_key,purchase_mode)
     values(1002,'paper:internal','paper')`,
  );
  for (const [mode, key, orderId, executionId] of [
    ["real", "real:missing-reference", null, null],
    [
      "real",
      "real:double-reference",
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000002",
    ],
    [
      "paper",
      "paper:real-reference",
      "00000000-0000-4000-8000-000000000001",
      null,
    ],
    ["paper", "real:wrong-namespace", null, null],
    ["unknown", "paper:unknown-mode", null, null],
  ]) {
    await client.query("savepoint rejected_purchase");
    await assert.rejects(
      client.query(
        `insert into user_theses(id,canonical_purchase_key,purchase_mode,order_id,execution_id)
         values(1003,$1,$2,$3,$4)`,
        [key, mode, orderId, executionId],
      ),
      (error: unknown) => (error as { code?: string }).code === "23514",
    );
    await client.query("rollback to savepoint rejected_purchase");
    await client.query("release savepoint rejected_purchase");
  }
  console.log(
    "agent-theses migration: 1000 legacy real rows preserved; defaults and real/paper constraints passed",
  );
} finally {
  await client.query("rollback");
  client.release();
  await pool.end();
}
