// @requires-db
import assert from "node:assert/strict";
import { createIntegrationTestPool } from "./test-database-target.js";
import { WALLET_INTEL_AUTO_TRACKED_SQL } from "./services/wallet-intel-auto-tracked-selection.js";
import { serialQueryClient } from "./lib/serial-query-client.js";
const pool = await createIntegrationTestPool({ max: 1 });
const connection = await pool.connect();
const serial = serialQueryClient(connection);
const client = serial.client;
const at = "2026-11-02T12:00:00Z";
const protocol = "0xa5ef39c3d3e10d0b270233af41cac69796b12966";
const owner = "0x1111111111111111111111111111111111111111";
const values = (n = 20, venues = ["polymarket", "limitless"]) => [
  n,
  at,
  6,
  30,
  14,
  venues,
  [protocol],
];
try {
  assert.match(
    String((await client.query("select version()")).rows[0].version),
    /PostgreSQL 16/,
  );
  await client.query("BEGIN");
  await client.query(
    "SET LOCAL statement_timeout='15s'; SET LOCAL lock_timeout='2s'; SET LOCAL search_path=pg_temp,pg_catalog",
  );
  await client.query(`
  CREATE TEMP TABLE wallets(id uuid PRIMARY KEY,address text,chain text);
  CREATE TEMP TABLE wallet_tracking_subjects(wallet_id uuid,venue text,status text,source text,priority int,
   last_selected_at timestamptz,last_refreshed_at timestamptz,last_refresh_attempted_at timestamptz,created_at timestamptz);
  CREATE INDEX ON wallet_tracking_subjects(status,venue,priority DESC);
  INSERT INTO wallets VALUES
   ('00000000-0000-0000-0000-000000000001','${owner}','polygon'),
   ('00000000-0000-0000-0000-000000000002','${protocol.toUpperCase()}','polygon'),
   ('00000000-0000-0000-0000-000000000003','${protocol}','base');
  INSERT INTO wallet_tracking_subjects VALUES
   ('00000000-0000-0000-0000-000000000001','polymarket','active','whale',100,'${at}',NULL,NULL,'${at}'),
   ('00000000-0000-0000-0000-000000000001','polymarket','active','signal_candidate',90,'${at}',NULL,NULL,'${at}'),
   ('00000000-0000-0000-0000-000000000002','polymarket','active','whale',999,'${at}',NULL,NULL,'${at}'),
   ('00000000-0000-0000-0000-000000000003','limitless','active','whale',50,'${at}',NULL,NULL,'${at}');
 `);
  const first = await client.query(WALLET_INTEL_AUTO_TRACKED_SQL, values(1));
  assert.equal(
    first.rows[0].address,
    owner,
    "excluded infrastructure must not consume LIMIT; smart wallets still eligible",
  );
  assert.deepEqual(first.rows[0].sources, ["signal_candidate", "whale"]);
  const all = await client.query(WALLET_INTEL_AUTO_TRACKED_SQL, values());
  assert.equal(all.rows.length, 2);
  assert.equal(
    (await client.query(WALLET_INTEL_AUTO_TRACKED_SQL, values(20, []))).rows
      .length,
    0,
  );
  await client.query(
    "UPDATE wallet_tracking_subjects SET last_refresh_attempted_at=$1 WHERE venue='polymarket'",
    [at],
  );
  assert.equal(
    (await client.query(WALLET_INTEL_AUTO_TRACKED_SQL, values())).rows.length,
    1,
    "existing failure backoff retained",
  );
  await client.query(
    "UPDATE wallet_tracking_subjects SET last_refresh_attempted_at=NULL,last_selected_at='2026-10-01' WHERE venue='polymarket'",
  );
  assert.equal(
    (await client.query(WALLET_INTEL_AUTO_TRACKED_SQL, values())).rows.length,
    1,
    "existing subject TTL retained",
  );
  await client.query(
    "UPDATE wallet_tracking_subjects SET last_selected_at=$1,last_refreshed_at=$1 WHERE venue='polymarket'",
    [at],
  );
  assert.equal(
    (await client.query(WALLET_INTEL_AUTO_TRACKED_SQL, values())).rows.length,
    1,
    "fresh holdings retained",
  );
  await client.query(
    "UPDATE wallet_tracking_subjects SET last_refreshed_at=NULL WHERE venue='polymarket'",
  );
  // Scale only connection-local relations. No production-like history scan is introduced.
  await client.query(`INSERT INTO wallets SELECT md5('discovery-test-'||g)::uuid,'0x'||lpad(to_hex(g),40,'0'),'polygon' FROM generate_series(1,25000) g;
  INSERT INTO wallet_tracking_subjects SELECT id,'polymarket','inactive','whale',1,'${at}',NULL,NULL,'${at}' FROM wallets WHERE address NOT IN ('${owner}','${protocol}','${protocol.toUpperCase()}');
  ANALYZE wallets; ANALYZE wallet_tracking_subjects;`);
  await client.query(
    `PREPARE position_selection_probe(int,timestamptz,int,int,int,text[],text[]) AS ${WALLET_INTEL_AUTO_TRACKED_SQL}`,
  );
  for (const mode of ["force_custom_plan", "force_generic_plan"]) {
    await client.query(`SET LOCAL plan_cache_mode=${mode}`);
    for (const count of [1, 20, 150, 1000]) {
      const plan = await client.query(
        `EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) EXECUTE position_selection_probe(${count},'${at}',6,30,14,ARRAY['polymarket','limitless'],ARRAY['${protocol}'])`,
      );
      const payload = plan.rows[0]["QUERY PLAN"][0];
      assert.ok(payload["Execution Time"] < 1500);
      console.log("[position selection explain]", {
        mode,
        count,
        executionMs: payload["Execution Time"],
      });
    }
  }
  const parallel = await Promise.all([
    client.query("select pg_sleep(0.005),1 as ordinal"),
    client.query("select 2 as ordinal"),
  ]);
  assert.equal(parallel[1].rows[0].ordinal, 2);
  // A failed statement outside a transaction must not poison the explicit queue.
  await client.query("ROLLBACK");
  await assert.rejects(client.query("select missing_position_test_column"));
  assert.equal((await client.query("select 3 as ordinal")).rows[0].ordinal, 3);
  console.log(
    "[position selection] PG16 semantics, scale and serial queue passed",
  );
} finally {
  await serial.drain();
  await connection.query("ROLLBACK");
  connection.release();
  await pool.end();
}
