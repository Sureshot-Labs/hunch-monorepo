// @requires-db
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { nativeOnboardingDatabase } from "./native-onboarding-database-fixture.js";
import { createIntegrationTestPool } from "./test-database-target.js";
import { SocialService } from "./services/social-service.js";
import { clearUserSocialData } from "./services/social-lifecycle.js";
import { buildSocialModerationMutation } from "./services/social-moderation.js";
import type { Pool, PoolClient } from "@hunch/infra";
import { drainPendingSocialTraderStatistics } from "./services/social-trader-statistics-pending.js";
import { refreshSocialTraderStatistics } from "./services/social-trader-statistics.js";

const fixture = await nativeOnboardingDatabase(createIntegrationTestPool);
const { db, pool } = fixture;
function onConnection(client: PoolClient): Pool {
  // hideThesis is a single-statement consumer. Keep its query on this real
  // connection so the lock barrier can observe the exact writer backend PID.
  return { query: client.query.bind(client) } as unknown as Pool;
}
function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function pauseAfter(prefix: string) {
  const reached = deferred();
  const resumed = deferred();
  let paused = false;
  let pid = 0;
  const wrapped = {
    ...db,
    async connect() {
      const client = await db.connect();
      pid = (await client.query(`select pg_backend_pid() pid`)).rows[0].pid;
      return {
        async query(sql: string, values: unknown[] = []) {
          const result = await client.query(sql, values);
          if (!paused && sql.startsWith(prefix)) {
            paused = true;
            reached.resolve();
            await resumed.promise;
          }
          return result;
        },
        release: () => client.release(),
      };
    },
  } as unknown as Pool;
  return {
    db: wrapped,
    reached: reached.promise,
    release: resumed.resolve,
    pid: () => pid,
  };
}
async function newAuthor() {
  const user = randomUUID();
  await db.query(`insert into users(id,handle) values($1,'pending_author')`, [
    user,
  ]);
  const thesis = (
    await db.query<{ id: string }>(
      `insert into user_theses(author_id,market_id) values($1,'kalshi:locking') returning id`,
      [user],
    )
  ).rows[0].id;
  return { user, thesis };
}
async function resetPending() {
  await db.query(`delete from social_trader_statistics_pending`);
}
try {
  await db.query(`
    alter table users add column handle_changed_at timestamptz, add column profile_name_edited_at timestamptz, add column profile_avatar_edited_at timestamptz;
    alter table content_assets add column owner_user_id uuid references users(id) on delete cascade,add column storage_key text,add column metadata jsonb,add column deleted_at timestamptz;
    create table user_onboarding_state(user_id uuid references users(id) on delete cascade);
    create table user_interests(user_id uuid references users(id) on delete cascade);
    create table social_comments(id uuid primary key,author_id uuid references users(id) on delete set null,author_hidden_at timestamptz,body text,idempotency_key text);
    create table social_likes(user_id uuid references users(id) on delete cascade);
    create table social_reports(id uuid primary key,reporter_id uuid,target_kind text,target_id uuid,target_profile_id uuid);
    create table content_audit_events(actor_user_id uuid,actor_label text);
    create table content_asset_usages(asset_id uuid);
  `);
  await db.query(
    `insert into unified_markets(id,venue) values('kalshi:locking','kalshi')`,
  );
  const failures: string[] = [];
  for (const kind of ["hide", "moderate", "proof"] as const) {
    for (const hard of [false, true]) {
      const user = randomUUID();
      await db.query(
        `insert into users(id,handle) values($1,'legacy_author')`,
        [user],
      );
      const thesis = (
        await db.query<{ id: string }>(
          `insert into user_theses(author_id,market_id) values($1,'kalshi:locking') returning id`,
          [user],
        )
      ).rows[0].id;
      await db.query(`delete from social_trader_statistics where user_id=$1`, [
        user,
      ]);
      const lifecycle = await pool.connect();
      const writer = await pool.connect();
      const label = `${kind} versus ${hard ? "hard" : "soft"} lifecycle with missing cache`;
      try {
        await lifecycle.query("begin");
        await lifecycle.query(`select id from users where id=$1 for update`, [
          user,
        ]);
        await lifecycle.query(`update users set is_active=false where id=$1`, [
          user,
        ]);
        const lifecyclePID = (
          await lifecycle.query(`select pg_backend_pid() pid`)
        ).rows[0].pid;
        const writerPID = (await writer.query(`select pg_backend_pid() pid`))
          .rows[0].pid;
        let completed = false;
        const service = new SocialService(onConnection(writer));
        const mutation = buildSocialModerationMutation(
          { kind: "thesis", id: thesis },
          "hide",
        );
        const request = (
          kind === "hide"
            ? service.hideThesis(user, thesis)
            : kind === "moderate"
              ? writer.query(mutation.text, mutation.values)
              : writer.query(
                  `update user_theses set proof_invalidated_at=now() where id=$1`,
                  [thesis],
                )
        )
          .then(
            () => ({ ok: true }),
            (error: unknown) => ({ ok: false, error }),
          )
          .finally(() => {
            completed = true;
          });
        // Observe the real user-lock wait on the old implementation; the fixed
        // writer is allowed to finish without ever requesting that user lock.
        let reached = false;
        for (let attempt = 0; attempt < 300; attempt++) {
          if (
            completed ||
            (
              await pool.query(
                `select $1::int=any(pg_blocking_pids($2)) blocked`,
                [lifecyclePID, writerPID],
              )
            ).rows[0].blocked
          ) {
            reached = true;
            break;
          }
          await delay(5);
        }
        assert.ok(
          reached,
          "writer must finish or reach the controlled lifecycle barrier",
        );
        const cleanup = (async () => {
          try {
            await clearUserSocialData(lifecycle, user);
            if (hard)
              await lifecycle.query(`delete from users where id=$1`, [user]);
            await lifecycle.query("commit");
            return { ok: true };
          } catch (error) {
            await lifecycle.query("rollback");
            return { ok: false, error };
          }
        })();
        const outcomes = await Promise.all([request, cleanup]);
        if (!outcomes.every((outcome) => outcome.ok)) {
          failures.push(label);
          console.error(`FAIL ${label}`, outcomes);
        } else {
          assert.equal(
            (
              await db.query(
                `select 1 from social_trader_statistics where user_id=$1`,
                [user],
              )
            ).rowCount,
            0,
          );
          assert.equal(
            (
              await db.query(
                `select 1 from social_trader_statistics_pending where user_id=$1`,
                [user],
              )
            ).rowCount,
            0,
          );
          console.log(`PASS ${label}`);
        }
      } finally {
        await lifecycle.query("rollback");
        lifecycle.release();
        writer.release();
      }
    }
  }
  assert.deepEqual(failures, []);
  await resetPending();
  const fresh = await newAuthor();
  assert.equal(
    (
      await db.query(
        `select 1 from social_trader_statistics where user_id=$1`,
        [fresh.user],
      )
    ).rowCount,
    0,
  );
  assert.equal(
    await refreshSocialTraderStatistics(db),
    1,
    "normal refresh promotes the new author before calculating",
  );
  assert.deepEqual(
    (
      await db.query(
        `select statistics from social_trader_statistics where user_id=$1`,
        [fresh.user],
      )
    ).rows[0].statistics,
    await new SocialService(db).profileStatistics(fresh.user),
  );
  console.log("PASS new author is promoted and computed by the normal worker");

  await resetPending();
  const unavailable = await newAuthor();
  const removed = randomUUID();
  await db.query(`update users set social_suspended_at=now() where id=$1`, [
    unavailable.user,
  ]);
  await db.query(
    `insert into social_trader_statistics_pending(user_id) values($1)`,
    [removed],
  );
  assert.equal(await drainPendingSocialTraderStatistics(db, 1), 1);
  assert.equal(await drainPendingSocialTraderStatistics(db, 1), 1);
  assert.equal(await drainPendingSocialTraderStatistics(db, 1), 0);
  assert.equal(
    (
      await db.query(
        `select 1 from social_trader_statistics where user_id=any($1::uuid[])`,
        [[unavailable.user, removed]],
      )
    ).rowCount,
    0,
  );
  console.log(
    "PASS bounded drain removes suspended and deleted owners without creating cache rows",
  );

  await resetPending();
  const concurrent = await newAuthor();
  const gate = pauseAfter("select id from users where id=any");
  const first = drainPendingSocialTraderStatistics(gate.db);
  await gate.reached;
  const second = drainPendingSocialTraderStatistics(db);
  gate.release();
  assert.deepEqual(await Promise.all([first, second]), [1, 0]);
  assert.equal(
    (
      await db.query(
        `select generation from social_trader_statistics where user_id=$1`,
        [concurrent.user],
      )
    ).rows[0].generation,
    "1",
  );
  console.log("PASS concurrent drains do not lose or double-promote a marker");

  for (const workerFirst of [false, true]) {
    await resetPending();
    const owner = await newAuthor();
    const lifecycle = await pool.connect();
    try {
      await lifecycle.query("begin");
      let pending: Promise<number>;
      let workerGate: ReturnType<typeof pauseAfter> | undefined;
      if (workerFirst) {
        workerGate = pauseAfter("select id from users where id=any");
        pending = drainPendingSocialTraderStatistics(workerGate.db);
        await workerGate.reached;
      } else {
        await lifecycle.query(`select id from users where id=$1 for update`, [
          owner.user,
        ]);
        pending = drainPendingSocialTraderStatistics(db);
      }
      const cleanup = (async () => {
        await lifecycle.query(`select id from users where id=$1 for update`, [
          owner.user,
        ]);
        await lifecycle.query(`update users set is_active=false where id=$1`, [
          owner.user,
        ]);
        await clearUserSocialData(lifecycle, owner.user);
        await lifecycle.query("commit");
      })();
      workerGate?.release();
      await Promise.all([pending, cleanup]);
      assert.equal(
        (
          await db.query(
            `select 1 from social_trader_statistics where user_id=$1`,
            [owner.user],
          )
        ).rowCount,
        0,
      );
      assert.equal(
        (
          await db.query(
            `select 1 from social_trader_statistics_pending where user_id=$1`,
            [owner.user],
          )
        ).rowCount,
        0,
      );
    } finally {
      await lifecycle.query("rollback");
      lifecycle.release();
    }
    console.log(
      `PASS pending drain/lifecycle, ${workerFirst ? "worker" : "lifecycle"} starts first`,
    );
  }

  await resetPending();
  const dirty = await newAuthor();
  const dirtyGate = pauseAfter("delete from social_trader_statistics_pending");
  const promoting = drainPendingSocialTraderStatistics(dirtyGate.db);
  await dirtyGate.reached;
  try {
    // Appending a second signal must finish even while the worker owns the old
    // signal and user lock. It remains independently visible after promotion.
    await new SocialService(db).hideThesis(dirty.user, dirty.thesis);
  } finally {
    dirtyGate.release();
  }
  await promoting;
  assert.equal(
    (
      await db.query(
        `select 1 from social_trader_statistics_pending where user_id=$1`,
        [dirty.user],
      )
    ).rowCount,
    1,
  );
  const before = (
    await db.query(
      `select generation from social_trader_statistics where user_id=$1`,
      [dirty.user],
    )
  ).rows[0].generation;
  await db.query(
    `update social_trader_statistics set next_refresh_at=now()+interval '1 hour' where user_id=$1`,
    [dirty.user],
  );
  await drainPendingSocialTraderStatistics(db);
  const after = (
    await db.query(
      `select generation,next_refresh_at<=now() due from social_trader_statistics where user_id=$1`,
      [dirty.user],
    )
  ).rows[0];
  assert.ok(
    BigInt(after.generation) > BigInt(before),
    "the concurrent mutation schedules another generation",
  );
  assert.equal(after.due, true);
  console.log(
    "PASS mutation during promotion remains due without waiting for a user FK",
  );

  await resetPending();
  const retry = await newAuthor();
  const failing = {
    ...db,
    async connect() {
      const client = await db.connect();
      return {
        async query(sql: string, values: unknown[] = []) {
          if (sql.startsWith("insert into social_trader_statistics(user_id)"))
            throw new Error("Injected cache insert failure");
          return client.query(sql, values);
        },
        release: () => client.release(),
      };
    },
  } as unknown as Pool;
  await assert.rejects(
    drainPendingSocialTraderStatistics(failing),
    /Injected cache insert failure/,
  );
  assert.equal(
    (
      await db.query(
        `select 1 from social_trader_statistics_pending where user_id=$1`,
        [retry.user],
      )
    ).rowCount,
    1,
  );
  assert.equal(await drainPendingSocialTraderStatistics(db), 1);
  assert.equal(
    (
      await db.query(
        `select 1 from social_trader_statistics where user_id=$1`,
        [retry.user],
      )
    ).rowCount,
    1,
  );
  console.log(
    "PASS failed promotion rolls back marker deletion and next worker recovers",
  );
  console.log(
    "Trader statistics lifecycle locking and pending recovery: 13/13 passed",
  );
} finally {
  await fixture.close();
}
