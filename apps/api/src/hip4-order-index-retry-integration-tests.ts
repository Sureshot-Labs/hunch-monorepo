// @requires-db — disposable PostgreSQL16, interruption/retry of owned DDL only.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createIntegrationTestPool } from "./test-database-target.js";

async function testIndexRetry(input: {
  table: string;
  indexName: string;
  migration: string;
  insert: (schema: string) => string;
  legacyObservations?: boolean;
}) {
  const pool = await createIntegrationTestPool({
    max: 2,
    options: "-c statement_timeout=15000",
  });
  const writer = await pool.connect();
  const builder = await pool.connect();
  const schema = `hip4_index_retry_${randomUUID().replaceAll("-", "")}`;
  const { indexName } = input;
  let created = false;
  let pending: Promise<unknown> | null = null;
  try {
    assert.match(
      (await writer.query("show server_version")).rows[0].server_version,
      /^16\./u,
    );
    assert.equal(
      (
        await writer.query("select 1 from pg_namespace where nspname=$1", [
          schema,
        ])
      ).rowCount,
      0,
    );
    await writer.query(`create schema ${schema}`);
    created = true;
    await writer.query(
      `create table ${schema}.${input.table}(like public.${input.table} including defaults)`,
    );
    await builder.query(`set search_path=${schema},pg_catalog`);
    const migration = await readFile(
      new URL(
        `../../../packages/db/migrations/${input.migration}`,
        import.meta.url,
      ),
      "utf8",
    );
    assert.match(migration, /\/\* no-transaction \*\//u);
    const statements = migration
      .split(";")
      .map((statement) => statement.trim())
      .filter(Boolean);
    assert.equal(statements.length, 2);
    assert.match(
      statements[0],
      new RegExp(`drop index concurrently if exists ${indexName}$`, "u"),
    );
    assert.match(
      statements[1],
      new RegExp(`^create index concurrently ${indexName}`, "u"),
    );
    const builderPid = (await builder.query("select pg_backend_pid() as pid"))
      .rows[0].pid;
    await writer.query("begin");
    await writer.query(input.insert(schema));
    // CREATE CONCURRENTLY has committed its invalid catalog entry when it waits
    // for this writer. Cancel the exact builder backend, not another DB process.
    pending = assert.rejects(builder.query(statements[1]), { code: "57014" });
    let waiting = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      waiting = (
        await writer.query(
          "select pg_backend_pid()=any(pg_blocking_pids($1)) as waiting",
          [builderPid],
        )
      ).rows[0].waiting;
      if (waiting) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(waiting);
    const validity = () =>
      writer.query(
        "select index_row.indisvalid from pg_index index_row join pg_class relation_row on relation_row.oid=index_row.indexrelid join pg_namespace schema_row on schema_row.oid=relation_row.relnamespace where schema_row.nspname=$1 and relation_row.relname=$2",
        [schema, indexName],
      );
    assert.equal((await validity()).rows[0].indisvalid, false);
    assert.equal(
      (
        await writer.query("select pg_cancel_backend($1) as canceled", [
          builderPid,
        ])
      ).rows[0].canceled,
      true,
    );
    await pending;
    pending = null;
    await writer.query("rollback");
    assert.equal((await validity()).rows[0].indisvalid, false);
    if (input.legacyObservations) {
      // Real malformed/legacy JSON is tolerated when building the expression
      // index, including nonnumeric, fractional, unsafe and negative timestamps.
      for (const responseAt of [
        null,
        "1",
        "broken",
        -1,
        1.1,
        9007199254740992,
        1,
      ]) {
        await writer.query(input.insert(schema));
        await writer.query(
          `update ${schema}.${input.table} set order_observation=$1 where order_observation is null`,
          [
            {
              terminal: true,
              balanceBarrier: { state: "terminal_observed", responseAt },
            },
          ],
        );
      }
    }
    // Execute the exact published migration statements, twice. IF NOT EXISTS
    // alone would silently preserve the invalid index and fail this assertion.
    for (let retry = 0; retry < 2; retry++) {
      for (const statement of statements) await builder.query(statement);
      assert.equal((await validity()).rows[0].indisvalid, true);
    }
    console.log(
      `[hip4-order-index] ${input.migration}: canceled build leaves invalid index; exact migration retry repairs it`,
    );
  } finally {
    await writer.query("rollback");
    if (pending) await pending.catch(() => undefined);
    await builder.query("reset search_path");
    if (created) {
      // Narrow cleanup after validating the newly owned random schema; no CASCADE.
      const relations = (
        await writer.query(
          "select relation_row.relname,relation_row.relkind from pg_class relation_row join pg_namespace schema_row on schema_row.oid=relation_row.relnamespace where schema_row.nspname=$1 and relation_row.relkind in ('r','i')",
          [schema],
        )
      ).rows;
      assert.ok(
        relations.every(
          (row) => row.relname === input.table || row.relname === indexName,
        ),
      );
      await writer.query(`drop table if exists ${schema}.${input.table}`);
      await writer.query(`drop schema ${schema}`);
    }
    writer.release();
    builder.release();
    await pool.end();
  }
}

await testIndexRetry({
  table: "hip4_account_executions",
  indexName: "hip4_account_executions_order_idx",
  migration: "0313_hip4_execution_order_lookup.sql",
  insert: (
    schema,
  ) => `insert into ${schema}.hip4_account_executions(environment,account_address,time_ms,coin,tid,oid,canonical_market_id,execution,fingerprint)
    values('mainnet','0x0000000000000000000000000000000000000000',1,'#1',1,1,'synthetic','{}','test')`,
});
await testIndexRetry({
  table: "hip4_order_submissions",
  indexName: "hip4_order_submissions_capacity_barrier_idx",
  migration: "0315_hip4_order_capacity_barrier.sql",
  insert: (
    schema,
  ) => `insert into ${schema}.hip4_order_submissions(action_id,signature_fingerprint,admission_snapshot,signer_address,debit_asset_id,debit_decimals,debit_raw)
    values(gen_random_uuid(),repeat('a',64),'{}','0x0000000000000000000000000000000000000000','synthetic',8,'100')`,
  legacyObservations: true,
});
