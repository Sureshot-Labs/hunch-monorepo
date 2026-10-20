// @requires-db
import assert from "node:assert/strict";
import { tx, type Pool } from "@hunch/infra";
import { nativeOnboardingDatabase } from "./native-onboarding-database-fixture.js";
import { createIntegrationTestPool } from "./test-database-target.js";
import { seedNextSocialTraderStatisticsBatch } from "./services/social-trader-statistics.js";
import { moderateAdminSocialTarget } from "./services/social-moderation.js";

const fixture = await nativeOnboardingDatabase(createIntegrationTestPool);
const { db } = fixture;
const name = "trader-statistics-seed";
const authors = Array.from(
  { length: 102 },
  (_, index) =>
    `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
);
let passed = 0;
const failures: string[] = [];

async function cursor() {
  return (
    await db.query<{ user_id: string | null; due: boolean }>(
      "select user_id,available_at<=now() as due from native_push_worker_cursors where name=$1",
      [name],
    )
  ).rows[0];
}
async function cacheIds() {
  return (
    await db.query<{ user_id: string }>(
      "select user_id from social_trader_statistics order by user_id",
    )
  ).rows.map((row) => row.user_id);
}
async function nextDay() {
  await db.query(
    "update native_push_worker_cursors set available_at=now()-interval '1 second' where name=$1",
    [name],
  );
}
async function authorsBeforeBackfill(suspended: string[] = []) {
  await db.query(
    `insert into users(id,handle,social_suspended_at)
     select id,'trader_'||ordinal,case when id=any($2::uuid[]) then now() end
     from unnest($1::uuid[]) with ordinality as author(id,ordinal)`,
    [authors, suspended],
  );
  await db.query(
    "insert into user_theses(author_id) select unnest($1::uuid[])",
    [authors],
  );
  // Existing authors have no derived rows when the migration first starts its backfill.
  await db.query("delete from social_trader_statistics");
}
async function finishCycle() {
  assert.equal(await seedNextSocialTraderStatisticsBatch(db), 100);
  assert.equal(await seedNextSocialTraderStatisticsBatch(db), 2);
  assert.equal(await seedNextSocialTraderStatisticsBatch(db), 0);
}
async function unsuspend(userId: string) {
  await tx(db, (client) =>
    moderateAdminSocialTarget(
      client,
      {
        target: { kind: "user", id: userId },
        action: "unsuspend",
        reason: "Review complete",
      },
      authors[101],
      { pageSize: 20, maxPageSize: 50, moderationReasonMaxGraphemes: 100 },
    ),
  );
}
async function test(name: string, body: () => Promise<void>) {
  await db.query("truncate users,native_push_worker_cursors cascade");
  await db.query("truncate social_trader_statistics_pending");
  try {
    await body();
    passed++;
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`FAIL ${name}`, error);
  }
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

try {
  assert.equal(
    Math.floor(
      Number(
        (await db.query("show server_version_num")).rows[0].server_version_num,
      ) / 10000,
    ),
    16,
  );
  await db.query(`
    alter table users add column updated_at timestamptz;
    create table social_moderation_events(id uuid primary key default gen_random_uuid(),target_kind text,target_id uuid,action text,reason text,admin_id uuid,report_id uuid,created_at timestamptz default now());
  `);

  await test("empty database pauses and remains resumable", async () => {
    assert.equal(await seedNextSocialTraderStatisticsBatch(db), 0);
    assert.deepEqual(await cursor(), { user_id: null, due: false });
    assert.equal(await seedNextSocialTraderStatisticsBatch(db), 0);
    await nextDay();
    assert.equal(await seedNextSocialTraderStatisticsBatch(db), 0);
    assert.deepEqual(await cursor(), { user_id: null, due: false });
  });

  await test("first/resumed pages stay bounded and empty tail resets the next cycle", async () => {
    await authorsBeforeBackfill();
    assert.equal(await seedNextSocialTraderStatisticsBatch(db), 100);
    assert.deepEqual(await cacheIds(), authors.slice(0, 100));
    assert.deepEqual(await cursor(), { user_id: authors[99], due: true });
    assert.equal(await seedNextSocialTraderStatisticsBatch(db), 2);
    assert.deepEqual(await cacheIds(), authors);
    assert.deepEqual(await cursor(), { user_id: authors[101], due: true });
    assert.equal(await seedNextSocialTraderStatisticsBatch(db), 0);
    assert.deepEqual(await cursor(), { user_id: null, due: false });
    assert.equal(await seedNextSocialTraderStatisticsBatch(db), 0);
    await nextDay();
    assert.equal(await seedNextSocialTraderStatisticsBatch(db), 100);
    assert.deepEqual(
      await cacheIds(),
      authors,
      "revisiting creates no duplicates",
    );
  });

  await test("actual unsuspend recovers a skipped author below the old cursor", async () => {
    await authorsBeforeBackfill([authors[0]]);
    await finishCycle();
    assert.deepEqual(await cacheIds(), authors.slice(1));
    await unsuspend(authors[0]);
    assert.equal(
      (
        await db.query(
          "select action from social_moderation_events where target_id=$1",
          [authors[0]],
        )
      ).rows.at(-1)?.action,
      "unsuspend",
    );
    assert.equal(
      await seedNextSocialTraderStatisticsBatch(db),
      0,
      "completed cycle retains its ordinary pause",
    );
    await nextDay();
    assert.equal(await seedNextSocialTraderStatisticsBatch(db), 100);
    assert.deepEqual(await cacheIds(), authors);
  });

  await test("the next daily cycle repairs deleted derived rows", async () => {
    await authorsBeforeBackfill();
    await finishCycle();
    await db.query("delete from social_trader_statistics where user_id=$1", [
      authors[1],
    ]);
    assert.equal((await cacheIds()).length, 101);
    await nextDay();
    assert.equal(await seedNextSocialTraderStatisticsBatch(db), 100);
    assert.deepEqual(await cacheIds(), authors);
  });

  await test("concurrent workers serialize cursor advancement without skipping authors", async () => {
    await authorsBeforeBackfill();
    await db.query("insert into native_push_worker_cursors(name) values($1)", [
      name,
    ]);
    const reached = deferred();
    const resume = deferred();
    let paused = false;
    const gated = {
      query: db.query.bind(db),
      async connect() {
        const client = await db.connect();
        return {
          async query(sql: string, values: unknown[] = []) {
            const result = await client.query(sql, values);
            if (
              !paused &&
              sql.startsWith("select user_id from native_push_worker_cursors")
            ) {
              paused = true;
              reached.resolve();
              await resume.promise;
            }
            return result;
          },
          release: () => client.release(),
        };
      },
    } as unknown as Pool;
    const first = seedNextSocialTraderStatisticsBatch(gated);
    try {
      await reached.promise;
      assert.equal(await seedNextSocialTraderStatisticsBatch(db), 0);
    } finally {
      resume.resolve();
      assert.equal(await first, 100);
    }
    assert.equal(await seedNextSocialTraderStatisticsBatch(db), 2);
    assert.equal(await seedNextSocialTraderStatisticsBatch(db), 0);
    assert.deepEqual(await cacheIds(), authors);
    assert.deepEqual(await cursor(), { user_id: null, due: false });
  });

  await test("failed cursor store rolls back derived inserts and retry recovers the same page", async () => {
    await authorsBeforeBackfill();
    assert.equal(await seedNextSocialTraderStatisticsBatch(db), 100);
    const failing = {
      query: db.query.bind(db),
      async connect() {
        const client = await db.connect();
        return {
          async query(sql: string, values: unknown[] = []) {
            if (
              sql.startsWith("update native_push_worker_cursors set user_id=")
            )
              throw new Error("Injected seed cursor failure");
            return client.query(sql, values);
          },
          release: () => client.release(),
        };
      },
    } as unknown as Pool;
    await assert.rejects(
      seedNextSocialTraderStatisticsBatch(failing),
      /Injected seed cursor failure/,
    );
    assert.deepEqual(await cacheIds(), authors.slice(0, 100));
    assert.deepEqual(await cursor(), { user_id: authors[99], due: true });
    assert.equal(await seedNextSocialTraderStatisticsBatch(db), 2);
    assert.deepEqual(await cacheIds(), authors);
  });
} finally {
  await fixture.close();
}
assert.deepEqual(failures, [], `${failures.length} seed regressions failed`);
console.log(`Native trader seed integration: ${passed}/6 passed`);
