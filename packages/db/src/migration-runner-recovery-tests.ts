import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import test, { before, after } from "node:test";
import { Pool, type PoolClient } from "pg";

import { runConcurrentIndexStage } from "./migration-index-recovery.js";
import { runMigration } from "./migration-runner.js";

const databaseUrl = process.env.DATABASE_URL;
const expectedDatabase = process.env.HUNCH_TEST_EXPECT_DATABASE;
assert.ok(databaseUrl, "Supply the explicit disposable PG16 URL");
assert.ok(expectedDatabase, "Supply HUNCH_TEST_EXPECT_DATABASE explicitly");
const target = new URL(databaseUrl);
assert.ok(["127.0.0.1", "localhost"].includes(target.hostname));
assert.equal(target.pathname, `/${expectedDatabase}`);
assert.equal(target.search, "");
const nonce = randomUUID().replaceAll("-", "");
const schema = `migration_retry_${nonce}`;
const otherSchema = `migration_other_${nonce}`;
const pool = new Pool({ connectionString: databaseUrl, max: 6 });
const filenames: string[] = [];
let baseline: unknown[] = [];
let created = false;

before(async () => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    const identity = (
      await client.query(`SELECT current_database() AS database_name,
        current_setting('server_version_num')::integer AS version_number`)
    ).rows[0];
    assert.equal(identity.database_name, expectedDatabase);
    assert.ok(
      identity.version_number >= 160000 && identity.version_number < 170000,
    );
    baseline = (
      await client.query(
        "SELECT filename, checksum FROM public.schema_migrations ORDER BY filename",
      )
    ).rows;
    await client.query("COMMIT");
    await client.query(`CREATE SCHEMA ${schema}`);
    created = true;
    await client.query(`CREATE SCHEMA ${otherSchema}`);
  } finally {
    client.release();
  }
});

after(async () => {
  if (created) {
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool.query(`DROP SCHEMA IF EXISTS ${otherSchema} CASCADE`);
    await pool.query(
      "DELETE FROM public.schema_migrations WHERE filename = ANY($1::text[])",
      [filenames],
    );
    const afterRows = (
      await pool.query(
        "SELECT filename, checksum FROM public.schema_migrations ORDER BY filename",
      )
    ).rows;
    assert.deepEqual(
      afterRows,
      baseline,
      "all pre-existing applied checksums stay unchanged",
    );
  }
  await pool.end();
});

function migration(label: string, sql: string) {
  const filename = `test_migration_retry_${nonce}_${label}.sql`;
  filenames.push(filename);
  return { filename, sql: `/* no-transaction */\n${sql}` };
}

async function facts(client: PoolClient, indexName: string) {
  return (
    await client.query(
      `SELECT index_relation.oid::text AS index_oid,
            index_metadata.indisvalid AS is_valid,
            index_metadata.indrelid::text AS table_oid
       FROM pg_class AS index_relation
       JOIN pg_index AS index_metadata ON index_metadata.indexrelid = index_relation.oid
      WHERE index_relation.oid = to_regclass($1)`,
      [indexName],
    )
  ).rows[0];
}

test("a real two-stage no-transaction migration resumes with its first valid index preserved and second absent", async () => {
  const client = await pool.connect();
  const first = `${schema}.first_stage`;
  const second = `${schema}.second_stage`;
  const input = migration(
    "two_stage",
    `
    CREATE INDEX CONCURRENTLY first_retry_idx ON ${first} (value_id);
    CREATE INDEX CONCURRENTLY second_retry_idx ON ${second} (value_id);`,
  );
  try {
    await client.query(`CREATE TABLE ${first} (value_id integer)`);
    await assert.rejects(runMigration(client, input), /does not exist/u);
    const original = await facts(client, `${schema}.first_retry_idx`);
    assert.equal(original.is_valid, true);
    assert.equal(await facts(client, `${schema}.second_retry_idx`), undefined);
    assert.equal(
      (
        await client.query(
          "SELECT 1 FROM public.schema_migrations WHERE filename = $1",
          [input.filename],
        )
      ).rowCount,
      0,
    );
    await client.query(`CREATE TABLE ${second} (value_id integer)`);
    await runMigration(client, input);
    assert.deepEqual(
      await facts(client, `${schema}.first_retry_idx`),
      original,
    );
    assert.equal(
      (await facts(client, `${schema}.second_retry_idx`)).is_valid,
      true,
    );
    const applied = (
      await client.query(
        "SELECT checksum FROM public.schema_migrations WHERE filename = $1",
        [input.filename],
      )
    ).rows[0];
    assert.equal(
      applied.checksum,
      createHash("sha256").update(input.sql).digest("hex"),
    );
    await runMigration(client, input);
    await assert.rejects(
      runMigration(client, { ...input, sql: `${input.sql}\n-- edited` }),
      /Checksum mismatch/u,
    );
  } finally {
    client.release();
  }
});

test("a live concurrent builder is untouched; after exact cancellation only its matching invalid artifact is rebuilt", async () => {
  const holder = await pool.connect();
  const builder = await pool.connect();
  const inspector = await pool.connect();
  const table = `${schema}.cancelled_stage`;
  const index = `${schema}.cancelled_retry_idx`;
  const statement = `CREATE INDEX CONCURRENTLY cancelled_retry_idx ON ${table} (value_id)`;
  const input = migration("cancelled", `${statement};`);
  let pending: Promise<unknown> | undefined;
  try {
    await inspector.query(`CREATE TABLE ${table} (value_id integer)`);
    await inspector.query(`INSERT INTO ${table} VALUES (1)`);
    await holder.query("BEGIN");
    await holder.query(`UPDATE ${table} SET value_id = 2`);
    await builder.query("SET statement_timeout = '15s'");
    const pid = (await builder.query("SELECT pg_backend_pid() AS backend_pid"))
      .rows[0].backend_pid;
    pending = runConcurrentIndexStage(builder, statement).then(
      () => null,
      (error: unknown) => error,
    );
    let observed: Awaited<ReturnType<typeof facts>>;
    for (let attempt = 0; attempt < 250; attempt++) {
      observed = await facts(inspector, index);
      if (
        observed &&
        (
          await inspector.query(
            "SELECT 1 FROM pg_stat_progress_create_index WHERE pid = $1 AND index_relid = $2::oid",
            [pid, observed.index_oid],
          )
        ).rowCount === 1
      )
        break;
      await delay(20);
    }
    assert.ok(observed, "exact test index entered concurrent build");
    assert.equal(observed.is_valid, false);
    await assert.rejects(
      runConcurrentIndexStage(inspector, statement),
      /Cannot resume concurrent index/u,
    );
    assert.deepEqual(await facts(inspector, index), observed);
    assert.equal(
      (
        await inspector.query("SELECT pg_cancel_backend($1) AS was_cancelled", [
          pid,
        ])
      ).rows[0].was_cancelled,
      true,
    );
    assert.equal(((await pending) as { code: string }).code, "57014");
    pending = undefined;
    await holder.query("ROLLBACK");
    const invalid = await facts(inspector, index);
    assert.equal(invalid.is_valid, false);
    await runMigration(inspector, input);
    const recovered = await facts(inspector, index);
    assert.equal(recovered.is_valid, true);
    assert.notEqual(recovered.index_oid, invalid.index_oid);
  } finally {
    await holder.query("ROLLBACK");
    if (pending) await pending;
    await builder.query("RESET statement_timeout");
    holder.release();
    builder.release();
    inspector.release();
  }
});

test("wrong definition, unrelated table, constraint-bound index and same-name non-index relation are preserved", async () => {
  const client = await pool.connect();
  try {
    await client.query(`CREATE TABLE ${schema}.expected_source (value_id integer, other_id integer UNIQUE);
      CREATE TABLE ${schema}.unrelated_source (value_id integer);
      CREATE INDEX wrong_definition_idx ON ${schema}.expected_source (other_id);
      CREATE INDEX wrong_table_idx ON ${schema}.unrelated_source (value_id);
      CREATE TABLE ${schema}.non_index_collision (value_id integer)`);
    for (const indexName of [
      "wrong_definition_idx",
      "wrong_table_idx",
      "expected_source_other_id_key",
      "non_index_collision",
    ]) {
      const original = await facts(client, `${schema}.${indexName}`);
      const relation = (
        await client.query(
          "SELECT to_regclass($1)::oid::text AS relation_oid",
          [`${schema}.${indexName}`],
        )
      ).rows[0];
      await assert.rejects(
        runConcurrentIndexStage(
          client,
          `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${indexName} ON ${schema}.expected_source (value_id)`,
        ),
        /Cannot resume concurrent index/u,
      );
      assert.deepEqual(await facts(client, `${schema}.${indexName}`), original);
      assert.deepEqual(
        (
          await client.query(
            "SELECT to_regclass($1)::oid::text AS relation_oid",
            [`${schema}.${indexName}`],
          )
        ).rows[0],
        relation,
      );
    }
  } finally {
    client.release();
  }
});

test("canonical expression/INCLUDE/predicate/operator/collation/options compare survives dropped-column attnum gaps", async () => {
  const client = await pool.connect();
  try {
    await client.query(`CREATE TABLE ${schema}.canonical_source (removed_column text, label_text text, value_id integer);
      ALTER TABLE ${schema}.canonical_source DROP COLUMN removed_column`);
    const statement = `CREATE INDEX CONCURRENTLY canonical_retry_idx ON ${schema}.canonical_source
      (lower(label_text) COLLATE "C" text_pattern_ops DESC NULLS FIRST) INCLUDE (value_id)
      WITH (fillfactor = 80) WHERE value_id > 0`;
    await runConcurrentIndexStage(client, statement);
    const original = await facts(client, `${schema}.canonical_retry_idx`);
    await runConcurrentIndexStage(client, statement);
    assert.deepEqual(
      await facts(client, `${schema}.canonical_retry_idx`),
      original,
    );
    for (const changed of [
      statement.replace("value_id > 0", "value_id > 1"),
      statement.replace("fillfactor = 80", "fillfactor = 70"),
      statement.replace("text_pattern_ops", "text_ops"),
      statement.replace("NULLS FIRST", "NULLS LAST"),
      statement.replace("INCLUDE (value_id)", ""),
      statement.replace("lower(label_text)", "upper(label_text)"),
      statement.replace('COLLATE "C"', 'COLLATE "POSIX"'),
      statement.replace("CREATE INDEX", "CREATE UNIQUE INDEX"),
    ]) {
      await assert.rejects(
        runConcurrentIndexStage(client, changed),
        /Cannot resume concurrent index/u,
      );
      assert.deepEqual(
        await facts(client, `${schema}.canonical_retry_idx`),
        original,
      );
    }
  } finally {
    client.release();
  }
});

test("schema-qualified and search-path-resolved sources preserve only their own exact index", async () => {
  const client = await pool.connect();
  try {
    await client.query(`CREATE TABLE ${schema}.scoped_source (value_id integer);
      CREATE TABLE ${otherSchema}.scoped_source (value_id integer);
      CREATE INDEX scoped_retry_idx ON ${schema}.scoped_source (value_id);
      CREATE INDEX scoped_retry_idx ON ${otherSchema}.scoped_source (value_id)`);
    const first = await facts(client, `${schema}.scoped_retry_idx`);
    const second = await facts(client, `${otherSchema}.scoped_retry_idx`);
    await client.query(`SET search_path = ${otherSchema}, ${schema}, public`);
    await runConcurrentIndexStage(
      client,
      `CREATE INDEX CONCURRENTLY scoped_retry_idx ON ${schema}.scoped_source (value_id)`,
    );
    await runConcurrentIndexStage(
      client,
      "CREATE INDEX CONCURRENTLY scoped_retry_idx ON scoped_source (value_id)",
    );
    assert.deepEqual(await facts(client, `${schema}.scoped_retry_idx`), first);
    assert.deepEqual(
      await facts(client, `${otherSchema}.scoped_retry_idx`),
      second,
    );
  } finally {
    await client.query("RESET search_path");
    client.release();
  }
});

test("an invalid wrong-definition artifact remains untouched, including replacement between inspection and drop", async () => {
  const client = await pool.connect();
  const replacer = await pool.connect();
  const table = `${schema}.replacement_source`;
  const index = `${schema}.replacement_retry_idx`;
  try {
    await client.query(`CREATE TABLE ${table} (value_id integer, other_id integer);
      INSERT INTO ${table} VALUES (1, 2), (1, 3)`);
    await assert.rejects(
      client.query(
        `CREATE UNIQUE INDEX CONCURRENTLY replacement_retry_idx ON ${table} (value_id)`,
      ),
      { code: "23505" },
    );
    const invalid = await facts(client, index);
    assert.equal(invalid.is_valid, false);
    await assert.rejects(
      runConcurrentIndexStage(
        client,
        `CREATE INDEX CONCURRENTLY replacement_retry_idx ON ${table} (other_id)`,
      ),
      /Cannot resume concurrent index/u,
    );
    assert.deepEqual(await facts(client, index), invalid);

    let replaced = false;
    const racingClient = new Proxy(client, {
      get(connection, property, receiver) {
        if (property !== "query")
          return Reflect.get(connection, property, receiver);
        return async (sql: string, values?: unknown[]) => {
          const result = await connection.query(sql, values);
          if (sql.startsWith("DROP TABLE IF EXISTS pg_temp.") && !replaced) {
            replaced = true;
            await replacer.query(`DROP INDEX ${index}`);
            await replacer.query(
              `CREATE INDEX replacement_retry_idx ON ${table} (other_id)`,
            );
          }
          return result;
        };
      },
    });
    await assert.rejects(
      runConcurrentIndexStage(
        racingClient,
        `CREATE UNIQUE INDEX CONCURRENTLY replacement_retry_idx ON ${table} (value_id)`,
      ),
      /Cannot resume concurrent index/u,
    );
    assert.equal(replaced, true);
    const replacement = await facts(client, index);
    assert.notEqual(replacement.index_oid, invalid.index_oid);
    assert.equal(replacement.is_valid, true);
    assert.match(
      (
        await client.query(
          "SELECT pg_get_indexdef($1::oid) AS index_definition",
          [replacement.index_oid],
        )
      ).rows[0].index_definition,
      /\(other_id\)/u,
    );
  } finally {
    client.release();
    replacer.release();
  }
});
