// @requires-db
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { nativeOnboardingDatabase } from "./native-onboarding-database-fixture.js";
import { createIntegrationTestPool } from "./test-database-target.js";
import { SocialService } from "./services/social-service.js";
import { mergeUserSocialData } from "./services/social-lifecycle.js";
import { refreshSocialTraderStatistics } from "./services/social-trader-statistics.js";
import type { DbQuery } from "./db.js";
import type { Pool } from "@hunch/infra";

const fixture = await nativeOnboardingDatabase(createIntegrationTestPool);
const { db, pool } = fixture;
const failures: string[] = [];
function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function test(name: string, body: () => Promise<void>) {
  try {
    await body();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`FAIL ${name}`, error);
  }
}
try {
  await db.query(`
    alter table users add column handle_changed_at timestamptz, add column profile_name_edited_at timestamptz, add column profile_avatar_edited_at timestamptz;
    alter table user_blocks add column created_at timestamptz default now();
    alter table user_theses add column idempotency_key text;
    alter table content_assets add column owner_user_id uuid references users(id) on delete cascade;
    create table social_comments(id uuid primary key,author_id uuid references users(id) on delete set null,idempotency_key text);
    create table social_likes(user_id uuid references users(id) on delete cascade,thesis_id uuid,ai_note_id uuid,comment_id uuid,created_at timestamptz default now());
    create table social_reports(id uuid primary key,reporter_id uuid,target_kind text,target_id uuid,target_profile_id uuid);
    create table content_audit_events(actor_user_id uuid);
    create table copy_attributions(id uuid primary key,copier_user_id uuid references users(id) on delete set null,idempotency_key text,repair_lease_token uuid,repair_lease_until timestamptz,repair_due_at timestamptz);
    insert into unified_markets(id,venue) values('kalshi:pending-proof','kalshi');
  `);

  await test("producer before drain retains its late committed invalidation", async () => {
    const writer = await pool.connect();
    let refresh: Promise<number> | undefined;
    try {
      const user = randomUUID();
      await db.query(
        `insert into users(id,handle) values($1,'pending_proof_author')`,
        [user],
      );
      const thesis = (
        await db.query<{ id: string }>(
          `insert into user_theses(author_id,market_id) values($1,'kalshi:pending-proof') returning id`,
          [user],
        )
      ).rows[0].id;
      assert.equal(
        (
          await db.query(
            `select 1 from social_trader_statistics_pending where user_id=$1`,
            [user],
          )
        ).rowCount,
        1,
      );
      assert.equal(
        (
          await db.query(
            `select 1 from social_trader_statistics where user_id=$1`,
            [user],
          )
        ).rowCount,
        0,
      );
      await writer.query("begin");
      await writer.query(
        `update user_theses set proof_invalidated_at=now() where id=$1`,
        [thesis],
      );
      // A worker may consume the older committed signal while this thesis change
      // is still invisible. The later commit must leave its own distinct signal.
      refresh = refreshSocialTraderStatistics(db);
      await refresh;
      assert.equal(
        (
          await db.query(
            `select statistics->>'invalidated' value from social_trader_statistics where user_id=$1`,
            [user],
          )
        ).rows[0].value,
        "0",
      );
      await writer.query("commit");
      assert.equal(
        (
          await db.query(
            `select 1 from social_trader_statistics_pending where user_id=$1`,
            [user],
          )
        ).rowCount,
        1,
        "committing a producer after a drain cannot discard its dirty signal",
      );
      await refreshSocialTraderStatistics(db);
      const cached = (
        await db.query(
          `select statistics from social_trader_statistics where user_id=$1`,
          [user],
        )
      ).rows[0].statistics;
      assert.deepEqual(
        cached,
        await new SocialService(db).profileStatistics(user),
      );
      assert.equal(cached.invalidated, 1);
      assert.equal(
        (
          await db.query(
            `select 1 from social_trader_statistics_pending where user_id=$1`,
            [user],
          )
        ).rowCount,
        0,
      );
    } finally {
      await writer.query("rollback");
      if (refresh) await Promise.allSettled([refresh]);
      writer.release();
    }
  });

  await test("merge collision rename and concurrent hide do not share an AFTER-trigger lock", async () => {
    const source = randomUUID(),
      target = randomUUID();
    const first = randomUUID(),
      second = randomUUID();
    await db.query(
      `insert into users(id,handle) values($1,'merge_source'),($2,'merge_target')`,
      [source, target],
    );
    await db.query(
      `insert into user_theses(id,author_id,market_id,idempotency_key) values($1,$3,'kalshi:pending-proof','collision'),($2,$3,'kalshi:pending-proof','source-only')`,
      [first, second, source],
    );
    await db.query(
      `insert into user_theses(author_id,market_id,idempotency_key) values($1,'kalshi:pending-proof','collision')`,
      [target],
    );
    await refreshSocialTraderStatistics(db);
    const lifecycle = await pool.connect();
    const writer = await pool.connect();
    const renamed = deferred(),
      resume = deferred();
    let merging: Promise<unknown> | undefined;
    let hiding: Promise<unknown> | undefined;
    try {
      await lifecycle.query("begin");
      await lifecycle.query(
        `select id from users where id=any($1::uuid[]) order by id for update`,
        [[source, target]],
      );
      const lifecyclePID = (
        await lifecycle.query(`select pg_backend_pid() pid`)
      ).rows[0].pid;
      const writerPID = (await writer.query(`select pg_backend_pid() pid`))
        .rows[0].pid;
      let used = false;
      const gated: DbQuery = {
        query: (async (sql: string, values: unknown[] = []) => {
          const result = await lifecycle.query(sql, values);
          if (
            !used &&
            sql.startsWith("update user_theses source_row set idempotency_key=")
          ) {
            used = true;
            renamed.resolve();
            await resume.promise;
          }
          return result;
        }) as DbQuery["query"],
      };
      merging = (async () => {
        try {
          await mergeUserSocialData(gated, source, target, true);
          await lifecycle.query("commit");
        } catch (error) {
          await lifecycle.query("rollback");
          throw error;
        }
      })();
      merging.catch(() => {});
      await renamed.promise;
      let completed = false;
      hiding = new SocialService({
        query: writer.query.bind(writer),
      } as unknown as Pool)
        .hideThesis(source, second)
        .finally(() => {
          completed = true;
        });
      hiding.catch(() => {});
      let observed = false;
      for (let attempt = 0; attempt < 300; attempt++) {
        const blocked = (
          await pool.query(`select $1::int=any(pg_blocking_pids($2)) blocked`, [
            lifecyclePID,
            writerPID,
          ])
        ).rows[0].blocked;
        if (completed || blocked) {
          observed = true;
          break;
        }
        await delay(5);
      }
      resume.resolve();
      const outcomes = await Promise.allSettled([merging, hiding]);
      assert.ok(
        observed,
        "hide completes or reaches the controlled shared-row barrier",
      );
      assert.ok(
        outcomes.every((outcome) => outcome.status === "fulfilled"),
        JSON.stringify(outcomes),
      );
      const moved = (
        await db.query(
          `select author_id,author_hidden_at from user_theses where id=$1`,
          [second],
        )
      ).rows[0];
      assert.equal(moved.author_id, target);
      assert.ok(moved.author_hidden_at);
    } finally {
      resume.resolve();
      await Promise.allSettled(
        [merging, hiding].filter(
          (value): value is Promise<unknown> => value !== undefined,
        ),
      );
      await lifecycle.query("rollback");
      lifecycle.release();
      writer.release();
    }
  });
  assert.deepEqual(failures, []);
  console.log(
    "Trader pending producer commit and merge/hide ordering: 2/2 passed",
  );
} finally {
  await fixture.close();
}
