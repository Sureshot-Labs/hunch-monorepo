// @api-integration
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createIntegrationTestPool } from "./test-database-target.js";

const schema = `probability_index_test_${randomUUID().replaceAll("-", "")}`;
const db = await createIntegrationTestPool({
  max: 2,
  options: `-c search_path=${schema} -c statement_timeout=30000`,
});
const client = await db.connect();
const indexName = "idx_unified_token_top_latest_token_hash";
const migration = await readFile(
  new URL(
    "../../../packages/db/migrations/0257_probability_token_top_hash_index.sql",
    import.meta.url,
  ),
  "utf8",
);
assert.ok(migration.includes("/* no-transaction */"));
// Execute the real no-transaction migration just like the repository runner.
const migrationStatements = migration
  .split(";")
  .map((statement) => statement.trim())
  .filter(Boolean);
const applyMigration = async () => {
  for (const statement of migrationStatements) await client.query(statement);
};
const lookupSql = `
  select token_id, best_bid, best_ask
  from unified_token_top_latest
  where token_id = any($1::text[])
`;
const tokenId = (value: number) => String(value).padStart(77, "0");
// A real collision in PostgreSQL 16's text hash; only the first row exists.
const collisionStored = "mar1-collision-174368";
const collisionMissing = "mar1-collision-86920";
const tokens = [
  ...Array.from({ length: 100 }, (_, i) => tokenId(i + 1)),
  ...Array.from({ length: 1_000 }, (_, i) => tokenId(100_000 + i)),
  tokenId(1), // ANY must not duplicate rows for repeated input IDs.
  "TokenA",
  "tokena",
  collisionMissing,
];
const sortedRows = (rows: Array<{ token_id: string }>) =>
  [...rows].sort((a, b) => a.token_id.localeCompare(b.token_id));
let schemaCreated = false;

try {
  await client.query(`create schema ${schema}`);
  schemaCreated = true;
  await client.query(`
    create table unified_token_top_latest (
      token_id text primary key,
      best_bid numeric,
      best_ask numeric
    );
    insert into unified_token_top_latest
    select lpad(sample_row::text, 77, '0'), 0.4, 0.6
    from generate_series(1, 10_000) as generated(sample_row);
    insert into unified_token_top_latest values
      ('TokenA', null, null), ('tokena', 0.9, 0.1);
    analyze unified_token_top_latest;
  `);
  await client.query(
    "insert into unified_token_top_latest values ($1, 0.1, 0.2)",
    [collisionStored],
  );
  assert.equal(
    (
      await client.query("select hashtext($1) = hashtext($2) as equal_hash", [
        collisionStored,
        collisionMissing,
      ])
    ).rows[0].equal_hash,
    true,
  );
  const before = sortedRows((await client.query(lookupSql, [tokens])).rows);
  assert.equal(before.length, 102);

  // A pre-existing writer lets CREATE CONCURRENTLY publish its invalid
  // catalog entry, then keeps the build waiting until its timeout cancels it.
  const blocker = await db.connect();
  try {
    await blocker.query("begin");
    await blocker.query(
      "update unified_token_top_latest set best_bid=best_bid where token_id=$1",
      [tokenId(1)],
    );
    await client.query("set statement_timeout=2000");
    await assert.rejects(applyMigration, { code: "57014" });
  } finally {
    await blocker.query("rollback");
    blocker.release();
    await client.query("set statement_timeout=30000");
  }
  assert.equal(
    (
      await client.query(
        "select indisvalid from pg_index where indexrelid=$1::regclass",
        [`${schema}.${indexName}`],
      )
    ).rows[0].indisvalid,
    false,
    "exercise repair of a real cancelled concurrent build",
  );
  assert.deepEqual(
    sortedRows((await client.query(lookupSql, [tokens])).rows),
    before,
    "the primary-key fallback remains usable after cancellation",
  );
  await applyMigration();
  await applyMigration();
  const { rows: indexes } = await client.query(
    `
    select index_row.indisvalid, index_row.indisunique, access_method.amname
    from pg_index index_row
    join pg_class index_relation on index_relation.oid = index_row.indexrelid
    join pg_am access_method on access_method.oid = index_relation.relam
    where index_relation.oid = $1::regclass
  `,
    [`${schema}.${indexName}`],
  );
  assert.deepEqual(indexes, [
    { indisvalid: true, indisunique: false, amname: "hash" },
  ]);
  assert.equal(
    (
      await client.query(`
    select count(*)::int as total from pg_index
    where indrelid = 'unified_token_top_latest'::regclass and indisprimary
  `)
    ).rows[0].total,
    1,
  );

  // This hint belongs only to the small fixture: production chooses freely.
  await client.query("begin read only");
  await client.query("set local enable_seqscan=off");
  await client.query("set local jit=off");
  assert.deepEqual(
    sortedRows((await client.query(lookupSql, [tokens])).rows),
    before,
  );
  assert.deepEqual(
    (await client.query(lookupSql, [[collisionMissing]])).rows,
    [],
  );
  assert.deepEqual((await client.query(lookupSql, [[]])).rows, []);
  const plan = (
    await client.query(`explain (analyze, buffers, format json) ${lookupSql}`, [
      tokens,
    ])
  ).rows;
  assert.ok(
    JSON.stringify(plan).includes(indexName),
    "exercise the actual hash lookup/recheck path",
  );
  await client.query("commit");

  await client.query(`
    insert into unified_token_top_latest values ('new-book', 0.2, 0.4);
    insert into unified_token_top_latest values ('TokenA', 0.6, 0.8)
    on conflict (token_id) do update set best_bid=excluded.best_bid, best_ask=excluded.best_ask;
  `);
  assert.deepEqual(
    sortedRows((await client.query(lookupSql, [["new-book", "TokenA"]])).rows),
    [
      { token_id: "new-book", best_bid: "0.2", best_ask: "0.4" },
      { token_id: "TokenA", best_bid: "0.6", best_ask: "0.8" },
    ],
  );
  console.log(
    "ok - probability hash migration: cancelled concurrent build repair, replay, exact reads, real hash collision, missing/duplicate/case-sensitive IDs, empty input, inserts and ON CONFLICT",
  );
} finally {
  await client.query("rollback");
  if (schemaCreated) await client.query(`drop schema ${schema} cascade`);
  client.release();
  await db.end();
}
