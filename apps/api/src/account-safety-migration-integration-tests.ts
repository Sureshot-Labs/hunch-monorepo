// @requires-db
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool, type PoolClient } from "pg";
import { createIntegrationTestPool } from "./test-database-target.js";
import {
  applyOnlineMigration,
  onlineMigrationPlan,
} from "@hunch/db/migration-plan";
const admin = await createIntegrationTestPool({ max: 1 });
const name = "hunch_migration_" + randomUUID().replaceAll("-", "");
const url = new URL(
  process.env.DATABASE_URL ??
    assert.fail("Explicit disposable DATABASE_URL required"),
);
url.pathname = "/" + name;
let db: Pool | undefined;
try {
  await admin.query(`create database ${name}`);
  db = new Pool({ connectionString: url.href, max: 4 });
  await db.query(`create table schema_migrations(filename text primary key,checksum text not null);
    create table users(id integer primary key);
    insert into users select generate_series(1,1000000);
    create table social_moderation_events(id integer primary key,action text constraint social_moderation_events_action_check check(action in('hide','unhide','suspend','unsuspend','resolve_report')));
    insert into social_moderation_events select g,'hide' from generate_series(1,1000000)g;`);
  for (const filename of [
    "0288_account_age_confirmation.sql",
    "0290_avatar_moderation_action.sql",
    "0292_adult_confirmation_strict.sql",
  ]) {
    const sql = await readFile(
      new URL("../../../packages/db/migrations/" + filename, import.meta.url),
      "utf8",
    );
    const plan = onlineMigrationPlan(filename, sql);
    assert.ok(plan);
    const checksum = createHash("sha256").update(sql).digest("hex");
    if (filename === "0292_adult_confirmation_strict.sql")
      await db.query(
        "update users set adult_confirmed_at=now(),adult_confirmation_version=null where id=1",
      );
    const client = await db.connect();
    try {
      // Crash after DDL commits, before validation. Resume must skip that phase.
      const interrupted = {
        query: async (text: string, values?: unknown[]) => {
          if (text === plan.validation)
            throw new Error("Fixture interruption after committed DDL");
          return client.query(text, values);
        },
      } as unknown as PoolClient;
      await assert.rejects(
        applyOnlineMigration(interrupted, filename, checksum, plan),
        /Fixture interruption/,
      );
      assert.equal(
        (
          await db.query(
            "select checksum from schema_migrations where filename=$1",
            [filename + "#ddl"],
          )
        ).rows[0].checksum,
        checksum,
      );
      const locks: { rows: { mode: string }[] } = await db.query(
        `select mode from pg_locks where pid=$1 and relation in('users'::regclass,'social_moderation_events'::regclass)`,
        [(client as unknown as { processID: number }).processID],
      );
      assert.equal(
        locks.rows.some((row) => row.mode === "AccessExclusiveLock"),
        false,
      );
      if (filename === "0292_adult_confirmation_strict.sql") {
        await assert.rejects(
          applyOnlineMigration(client, filename, checksum, plan),
          { code: "23514" },
        );
        await db.query(
          "update users set adult_confirmed_at=null,adult_confirmation_version=null where id=1",
        );
      }
      const started = Date.now();
      await applyOnlineMigration(client, filename, checksum, plan);
      console.log(
        JSON.stringify({
          migration: filename,
          rows: 1000000,
          validationMs: Date.now() - started,
          resumed: true,
        }),
      );
      assert.equal(
        (
          await db.query(
            "select checksum from schema_migrations where filename=$1",
            [filename],
          )
        ).rows[0].checksum,
        checksum,
      );
      assert.equal(
        (
          await db.query(
            "select filename from schema_migrations where filename=$1",
            [filename + "#ddl"],
          )
        ).rows.length,
        0,
      );
    } finally {
      client.release();
    }
  }
  await assert.rejects(
    db.query("update users set adult_confirmed_at=now() where id=1"),
    { code: "23514" },
  );
  await db.query(
    "update users set adult_confirmed_at=now(),adult_confirmation_version=1 where id=1",
  );
  // Hold a real validation scan at its first existing row. A new insert that
  // does not hit the test gate must proceed while validation owns its lock.
  const gate = await db.connect(),
    migration = await db.connect(),
    writer = await db.connect();
  try {
    await db.query(
      `create function validation_gate(value integer) returns boolean language plpgsql as $$begin if value=1 then perform pg_advisory_xact_lock(74396511); end if; return true; end$$`,
    );
    const plan = {
      ddl: "alter table users add constraint online_gate_check check(validation_gate(id)) not valid",
      validation: "alter table users validate constraint online_gate_check",
    };
    await gate.query("select pg_advisory_lock(74396511)");
    const migrationPid = Number(
      (await migration.query("select pg_backend_pid() as pid")).rows[0].pid,
    );
    const work = applyOnlineMigration(
      migration,
      "fixture_online.sql",
      "fixture",
      plan,
    ).then(
      () => ({ ok: true as const }),
      (error) => ({ ok: false as const, error }),
    );
    let observed = false;
    for (let attempt = 0; attempt < 200; attempt++) {
      const result = await writer.query(
        `select exists(select 1 from pg_locks where pid=$1 and relation='users'::regclass and mode='ShareUpdateExclusiveLock' and granted) as locked`,
        [migrationPid],
      );
      if (result.rows[0].locked) {
        observed = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (!observed) {
      console.log(
        (
          await writer.query(
            "select pid,mode,relation::regclass,granted from pg_locks where pid=$1",
            [migrationPid],
          )
        ).rows,
      );
      await gate.query("select pg_advisory_unlock(74396511)");
      const outcome = await work;
      if (!outcome.ok) throw outcome.error;
    }
    assert.equal(observed, true);
    await writer.query("set statement_timeout='1s'");
    await writer.query("insert into users(id) values(1000001)");
    await gate.query("select pg_advisory_unlock(74396511)");
    const outcome = await work;
    if (!outcome.ok) throw outcome.error;
  } catch (error) {
    console.error("gate validation test failure", error);
    throw error;
  } finally {
    await gate.query("select pg_advisory_unlock_all()");
    gate.release();
    migration.release();
    writer.release();
  }
  console.log(
    "[account-safety-migration] PG16 million-row online validation, crash/resume, unchanged checksums, strict NULL pairs and concurrent writes passed",
  );
} finally {
  await db?.end();
  await admin.query(`drop database if exists ${name} with (force)`);
  await admin.end();
}
