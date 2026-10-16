// @requires-db
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import type { Pool } from "@hunch/infra";
import { createIntegrationTestPool } from "./test-database-target.js";
import { OnboardingService } from "./services/onboarding-service.js";
import {
  initialOnboardingState,
  OnboardingError,
} from "./services/onboarding-state.js";
import { SocialService } from "./services/social-service.js";
import { AuthService } from "./auth.js";
import { mergeUsersById } from "./admin-merge-user-core.js";

const pool = await createIntegrationTestPool({
  max: 6,
  options: "-c statement_timeout=15000",
});
const service = new OnboardingService(pool);
const social = new SocialService(pool, async () => {});
const users: string[] = [],
  assets: string[] = [];
const selectionA = ["usElections", "politics", "trump"];
const selectionB = ["technology", "sports", "economy"];
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
  throw new Error("Network forbidden in onboarding integration tests");
};

async function user(legacy = false, privy = false) {
  const id = randomUUID();
  users.push(id);
  await pool.query(
    `insert into users(id,display_name,onboarding_version,privy_user_id) values($1,'Onboarding fixture',$2,$3)`,
    [id, legacy ? 0 : 1, privy ? `did:privy:onboarding:${id}` : null],
  );
  return id;
}
async function choose(id: string, ids = selectionA) {
  const current = await service.get(id);
  return service.setInterests(id, {
    expectedRevision: current.revision,
    outcome: "completed",
    interestIds: ids,
  });
}
async function skipAll(id: string) {
  let current = await service.get(id);
  current = await service.setInterests(id, {
    expectedRevision: current.revision,
    outcome: "skipped",
    interestIds: [],
  });
  for (const step of [
    "handle",
    "photo",
    "passkey",
    "notifications",
    "traders",
  ] as const) {
    current = await service.progress(id, {
      expectedRevision: current.revision,
      step,
      outcome: "skipped",
    });
  }
  return current;
}
async function rejected(operation: () => Promise<unknown>, code: string) {
  await assert.rejects(
    operation,
    (error: unknown) => error instanceof Error && error.message === code,
  );
}
async function asset(owner: string, ready = true) {
  const id = randomUUID();
  assets.push(id);
  await pool.query(
    `insert into content_assets(id,owner_user_id,storage_key,kind,original_filename,mime_type,status,public_url,byte_size,ready_at,checksum_sha256)
    values($1::uuid,$2,(case when $3='pending' then 'content-staging/' else '' end)||$1::uuid::text,'image','onboarding.jpg','image/jpeg',$3,$4,100,case when $3='ready' then now() else null end,repeat('a',64))`,
    [
      id,
      owner,
      ready ? "ready" : "pending",
      ready ? `https://example.test/${id}.jpg` : null,
    ],
  );
  return id;
}

async function waitForBlockedWrites(count: number) {
  const deadline = performance.now() + 5_000;
  while (performance.now() < deadline) {
    const { rows } =
      await pool.query(`select count(*)::int n from pg_stat_activity
      where datname=current_database() and wait_event_type='Lock'
      and query like '%social_suspended_at from users%for update%'
      and cardinality(pg_blocking_pids(pid))>0`);
    if (rows[0].n >= count) return;
    await delay(10);
  }
  assert.fail(
    `Expected ${count} real PostgreSQL writers waiting at the user lock`,
  );
}

async function raceAtUserLock<T>(
  id: string,
  operations: Array<() => Promise<T>>,
) {
  const gate = await pool.connect();
  let released = false;
  let pending: Promise<PromiseSettledResult<T>[]> | undefined;
  try {
    await gate.query("begin");
    await gate.query("select id from users where id=$1 for update", [id]);
    pending = Promise.allSettled(operations.map((operation) => operation()));
    await waitForBlockedWrites(operations.length);
    await gate.query("commit");
    released = true;
    return await pending;
  } finally {
    if (!released) await gate.query("rollback");
    gate.release();
    if (pending) await pending;
  }
}

try {
  assert.equal(
    Math.floor(
      Number(
        (await pool.query("show server_version_num")).rows[0]
          .server_version_num,
      ) / 10000,
    ),
    16,
  );
  // Exercise the exact upgrade SQL with an existing row and future INSERT, in
  // an isolated transactional schema. The real DB also runs the full migrator.
  const migration = await readFile(
    new URL(
      "../../../packages/db/migrations/0281_user_onboarding.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const migrationClient = await pool.connect();
  try {
    await migrationClient.query("begin");
    const schema = `onboarding_${randomUUID().replaceAll("-", "")}`;
    await migrationClient.query(`create schema ${schema}`);
    await migrationClient.query(`set local search_path=${schema},public`);
    await migrationClient.query(
      "create table users(id uuid primary key default gen_random_uuid())",
    );
    const existing = (
      await migrationClient.query(
        "insert into users default values returning id",
      )
    ).rows[0].id;
    await migrationClient.query(migration);
    assert.equal(
      (
        await migrationClient.query(
          "select onboarding_version from users where id=$1",
          [existing],
        )
      ).rows[0].onboarding_version,
      0,
    );
    assert.equal(
      (
        await migrationClient.query(
          "insert into users default values returning onboarding_version",
        )
      ).rows[0].onboarding_version,
      1,
    );
    assert.equal(
      (
        await migrationClient.query(
          "select count(*)::int n from user_onboarding_state",
        )
      ).rows[0].n,
      0,
    );
    await assert.rejects(
      () =>
        migrationClient.query(
          `insert into user_onboarding_state(user_id,revision,status,steps)
      values($1,1,'completed',$2)`,
          [existing, JSON.stringify(initialOnboardingState(false).steps)],
        ),
      /check constraint/,
    );
  } finally {
    await migrationClient.query("rollback");
    migrationClient.release();
  }

  const id = await user(),
    other = await user(),
    legacy = await user(true);
  const initial = await service.get(id);
  assert.equal(initial.status, "not_started");
  assert.deepEqual(initial.interestIds, []);
  assert.equal(
    (
      await pool.query("select 1 from user_onboarding_state where user_id=$1", [
        id,
      ])
    ).rowCount,
    0,
    "GET is read-only",
  );
  const legacyState = await service.get(legacy);
  assert.equal(legacyState.status, "completed");
  assert.equal(legacyState.completedAt, null);
  assert.equal(legacyState.completionReason, "legacy");
  assert.equal((await service.catalog()).items.length, 9);
  for (const interestIds of [
    [],
    ["politics"],
    ["politics", "sports"],
    ["politics", "politics", "politics"],
  ]) {
    await rejected(
      () =>
        service.setInterests(id, {
          expectedRevision: 0,
          outcome: "completed",
          interestIds,
        }),
      "too_few_interests",
    );
  }
  await rejected(
    () =>
      service.setInterests(id, {
        expectedRevision: 0,
        outcome: "skipped",
        interestIds: ["politics"],
      }),
    "invalid_request",
  );
  await rejected(
    () =>
      service.setInterests(id, {
        expectedRevision: 0,
        outcome: "completed",
        interestIds: [...selectionA, "unknown"],
      }),
    "invalid_interest",
  );
  await rejected(
    () =>
      service.progress(id, {
        expectedRevision: 0,
        step: "handle",
        outcome: "skipped",
      }),
    "onboarding_incomplete",
  );
  await rejected(() => service.complete(id, 0), "onboarding_incomplete");
  assert.equal(
    (await service.get(id)).revision,
    0,
    "failed writes leave no partial state",
  );
  const selected = await service.setInterests(id, {
    expectedRevision: 0,
    outcome: "completed",
    interestIds: ["trump", "politics", "usElections", "trump"],
  });
  assert.deepEqual(selected.interestIds, selectionA);
  assert.equal(selected.nextStep, "handle");
  assert.equal(selected.revision, 1);
  assert.equal(
    (await new OnboardingService(pool).get(id)).revision,
    1,
    "another session/client sees persisted state",
  );
  assert.deepEqual((await service.get(other)).interestIds, []);
  assert.deepEqual(
    await service.setInterests(id, {
      expectedRevision: 0,
      outcome: "completed",
      interestIds: [...selectionA].reverse(),
    }),
    selected,
    "lost response can retry without bump",
  );
  await rejected(
    () =>
      service.setInterests(id, {
        expectedRevision: 999,
        outcome: "completed",
        interestIds: selectionB,
      }),
    "onboarding_revision_conflict",
  );
  const replaced = await service.setInterests(id, {
    expectedRevision: 1,
    outcome: "completed",
    interestIds: selectionB,
  });
  assert.deepEqual(replaced.interestIds, selectionB);
  await rejected(
    () =>
      service.setInterests(id, {
        expectedRevision: 0,
        outcome: "completed",
        interestIds: selectionA,
      }),
    "onboarding_revision_conflict",
  );
  await pool.query(
    "update onboarding_interests set enabled=false where id='sports'",
  );
  try {
    assert.deepEqual(
      (await service.get(id)).interestIds,
      selectionB,
      "retiring catalog entries does not erase existing choices",
    );
    await rejected(() => choose(other, selectionB), "invalid_interest");
  } finally {
    await pool.query(
      "update onboarding_interests set enabled=true where id='sports'",
    );
  }
  const skipped = await service.setInterests(id, {
    expectedRevision: 2,
    outcome: "skipped",
    interestIds: [],
  });
  assert.equal(skipped.steps.interests.status, "skipped");
  assert.deepEqual(skipped.interestIds, []);
  assert.equal(
    (await pool.query("select 1 from user_interests where user_id=$1", [id]))
      .rowCount,
    0,
  );

  // Real concurrent connections share only the users lifecycle lock.
  const duplicateUser = await user();
  const duplicate = await raceAtUserLock(
    duplicateUser,
    [0, 1].map(
      () => () =>
        service.setInterests(duplicateUser, {
          expectedRevision: 0,
          outcome: "completed",
          interestIds: selectionA,
        }),
    ),
  );
  assert.ok(
    duplicate[0].status === "fulfilled" && duplicate[1].status === "fulfilled",
  );
  assert.equal(duplicate[0].value.revision, 1);
  assert.deepEqual(duplicate[0].value, duplicate[1].value);
  const conflictUser = await user();
  const concurrent = await raceAtUserLock(
    conflictUser,
    [selectionA, selectionB].map(
      (interestIds) => () =>
        service.setInterests(conflictUser, {
          expectedRevision: 0,
          outcome: "completed",
          interestIds,
        }),
    ),
  );
  assert.equal(
    concurrent.filter((result) => result.status === "fulfilled").length,
    1,
  );
  const failure = concurrent.find((result) => result.status === "rejected");
  assert.ok(
    failure?.status === "rejected" && failure.reason instanceof OnboardingError,
  );
  assert.equal(failure.reason.code, "onboarding_revision_conflict");
  assert.equal((await service.get(conflictUser)).revision, 1);

  const profileUser = await user();
  await social.updateProfile(profileUser, {
    handle: `u_${profileUser.slice(0, 8)}`,
  });
  assert.equal(
    (await service.get(profileUser)).status,
    "not_started",
    "ordinary profile edits cannot start onboarding",
  );
  await choose(profileUser);
  await rejected(
    () =>
      service.progress(profileUser, {
        expectedRevision: 1,
        step: "photo",
        outcome: "completed",
      }),
    "onboarding_step_evidence_missing",
  );
  const readyAsset = await asset(profileUser);
  assert.equal(
    (await service.get(profileUser)).steps.photo.status,
    "pending",
    "ready upload alone is not a profile binding",
  );
  const otherAsset = await asset(other);
  await rejected(
    () => social.updateProfile(profileUser, { avatarAssetId: otherAsset }),
    "avatar_unavailable",
  );
  const pendingAsset = await asset(profileUser, false);
  await rejected(
    () => social.updateProfile(profileUser, { avatarAssetId: pendingAsset }),
    "avatar_unavailable",
  );
  assert.equal((await service.get(profileUser)).revision, 1);
  await social.updateProfile(profileUser, { avatarAssetId: readyAsset });
  assert.equal(
    (await service.get(profileUser)).steps.photo.status,
    "completed",
  );
  const oldHandle = (
    await pool.query("select handle from users where id=$1", [profileUser])
  ).rows[0].handle;
  const beforeRollback = await service.get(profileUser);
  const failingDb = {
    query: pool.query.bind(pool),
    async connect() {
      const client = await pool.connect();
      return {
        async query(text: string, values?: unknown[]) {
          if (text.toLowerCase() === "commit")
            throw new Error("forced_commit_failure");
          return client.query(text, values);
        },
        release: () => client.release(),
      };
    },
  } as unknown as Pool;
  await assert.rejects(
    () =>
      new SocialService(failingDb, async () => {}).updateProfile(profileUser, {
        handle: `rollback_${profileUser.slice(0, 8)}`,
      }),
    /forced_commit_failure/,
  );
  assert.deepEqual(
    await service.get(profileUser),
    beforeRollback,
    "progress rolls back with profile transaction",
  );
  assert.equal(
    (await pool.query("select handle from users where id=$1", [profileUser]))
      .rows[0].handle,
    oldHandle,
  );
  const profileRace = await raceAtUserLock<unknown>(profileUser, [
    () => social.updateProfile(profileUser, { handle: oldHandle }),
    () =>
      service.setInterests(profileUser, {
        expectedRevision: beforeRollback.revision,
        outcome: "completed",
        interestIds: selectionB,
      }),
  ]);
  assert.equal(profileRace[0].status, "fulfilled");
  assert.equal(
    (await service.get(profileUser)).steps.handle.status,
    "completed",
  );
  assert.ok(
    (await service.get(profileUser)).revision >= beforeRollback.revision + 1,
  );

  const finishUser = await user();
  const ready = await skipAll(finishUser);
  assert.equal(ready.status, "in_progress");
  assert.equal(ready.nextStep, null);
  const finished = await service.complete(finishUser, ready.revision);
  assert.equal(finished.status, "completed");
  assert.ok(finished.completedAt);
  assert.equal(
    (
      await pool.query(
        "select count(*)::int n from user_follows where follower_user_id=$1",
        [finishUser],
      )
    ).rows[0].n,
    0,
    "completion never follows users automatically",
  );
  assert.deepEqual(await service.complete(finishUser, 0), finished);
  await rejected(
    () =>
      service.progress(finishUser, {
        expectedRevision: 0,
        step: "passkey",
        outcome: "completed",
      }),
    "onboarding_completed",
  );
  const edited = await service.setInterests(finishUser, {
    expectedRevision: finished.revision,
    outcome: "completed",
    interestIds: selectionB,
  });
  assert.equal(edited.completedAt, finished.completedAt);
  assert.equal(edited.status, "completed");
  const legacyEdited = await choose(legacy);
  assert.equal(legacyEdited.status, "completed");
  assert.equal(legacyEdited.completedAt, null);

  const completeRaceUser = await user();
  const raceReady = await skipAll(completeRaceUser);
  const raceResults = await raceAtUserLock(completeRaceUser, [
    () => service.complete(completeRaceUser, raceReady.revision),
    () =>
      service.progress(completeRaceUser, {
        expectedRevision: raceReady.revision,
        step: "traders",
        outcome: "not_applicable",
        reason: "insufficient_suggestions",
      }),
  ]);
  assert.equal(
    raceResults.filter((result) => result.status === "fulfilled").length,
    1,
  );
  const raceCurrent = await service.get(completeRaceUser);
  const raceFinished = await service.complete(
    completeRaceUser,
    raceCurrent.revision,
  );
  assert.equal(raceFinished.status, "completed");
  assert.equal(
    (await service.complete(completeRaceUser, 0)).completedAt,
    raceFinished.completedAt,
  );
  for (const reason of [
    "insufficient_suggestions",
    "feature_unavailable",
  ] as const) {
    const optionalUser = await user();
    await choose(optionalUser);
    assert.equal(
      (
        await service.progress(optionalUser, {
          expectedRevision: 1,
          step: "traders",
          outcome: "not_applicable",
          reason,
        })
      ).steps.traders.status,
      "not_applicable",
    );
  }

  // Exercise the actual account merge entry point, including profile ownership.
  const source = await user(),
    target = await user();
  await choose(source);
  const targetBefore = await service.setInterests(target, {
    expectedRevision: 0,
    outcome: "skipped",
    interestIds: [],
  });
  await mergeUsersById(
    source,
    target,
    { dryRun: false, keepSource: false },
    pool,
  );
  assert.deepEqual((await service.get(target)).interestIds, []);
  assert.equal((await service.get(target)).steps.interests.status, "skipped");
  assert.equal(
    (await pool.query("select 1 from users where id=$1", [source])).rowCount,
    0,
  );
  assert.equal(
    (await service.get(target)).revision,
    targetBefore.revision,
    "no new preference effect needs no revision bump",
  );
  const keptSource = await user(),
    legacyTarget = await user(true);
  const keptBefore = await choose(keptSource);
  await mergeUsersById(
    keptSource,
    legacyTarget,
    { dryRun: false, keepSource: true },
    pool,
  );
  const merged = await service.get(legacyTarget);
  assert.deepEqual(merged.interestIds, selectionA);
  assert.equal(merged.status, "completed");
  assert.equal(merged.completedAt, null);
  assert.deepEqual(
    await service.get(keptSource),
    keptBefore,
    "keepSource retains independent preferences",
  );
  await mergeUsersById(
    keptSource,
    legacyTarget,
    { dryRun: false, keepSource: true },
    pool,
  );
  assert.deepEqual(
    await service.get(legacyTarget),
    merged,
    "repeat merge is idempotent",
  );
  const completeSource = await user(),
    unfinishedTarget = await user();
  const completeSourceReady = await skipAll(completeSource);
  const sourceCompletion = await service.complete(
    completeSource,
    completeSourceReady.revision,
  );
  await choose(unfinishedTarget, selectionB);
  await mergeUsersById(
    completeSource,
    unfinishedTarget,
    { dryRun: false, keepSource: false },
    pool,
  );
  const terminalMerge = await service.get(unfinishedTarget);
  assert.equal(terminalMerge.completedAt, sourceCompletion.completedAt);
  assert.deepEqual(terminalMerge.interestIds, selectionB);
  assert.equal(terminalMerge.nextStep, null);

  const inactiveSource = await user(),
    activeTarget = await user();
  await choose(inactiveSource);
  await pool.query("update users set is_active=false where id=$1", [
    inactiveSource,
  ]);
  await rejected(() => service.get(inactiveSource), "user_unavailable");
  await mergeUsersById(
    inactiveSource,
    activeTarget,
    { dryRun: false, keepSource: false },
    pool,
  );
  assert.deepEqual(
    (await service.get(activeTarget)).interestIds,
    selectionA,
    "privileged existing merge supports inactive source without enabling private writes",
  );

  const suspended = await user();
  await pool.query("update users set social_suspended_at=now() where id=$1", [
    suspended,
  ]);
  await rejected(() => choose(suspended), "social_suspended");
  assert.equal((await service.get(suspended)).status, "not_started");

  for (const retained of [false, true]) {
    const deletedUser = await user(false, retained);
    await choose(deletedUser);
    const client = await pool.connect();
    try {
      await client.query("begin");
      const deletion = await AuthService.deleteUser(deletedUser, client);
      await client.query("commit");
      assert.equal(
        deletion.disposition,
        retained ? "deactivated" : "hard_deleted",
      );
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
    assert.equal(
      (
        await pool.query("select 1 from user_interests where user_id=$1", [
          deletedUser,
        ])
      ).rowCount,
      0,
    );
    assert.equal(
      (
        await pool.query(
          "select 1 from user_onboarding_state where user_id=$1",
          [deletedUser],
        )
      ).rowCount,
      0,
    );
    await rejected(() => service.get(deletedUser), "user_unavailable");
    await rejected(
      () =>
        service.setInterests(deletedUser, {
          expectedRevision: 0,
          outcome: "completed",
          interestIds: selectionB,
        }),
      "user_unavailable",
    );
  }
  const lateUser = await user(false, true);
  const lateSelected = await choose(lateUser);
  const deleting = await pool.connect();
  await deleting.query("begin");
  await deleting.query("select id from users where id=$1 for update", [
    lateUser,
  ]);
  const lateWrite = service.setInterests(lateUser, {
    expectedRevision: lateSelected.revision,
    outcome: "completed",
    interestIds: selectionB,
  });
  const lateResult = lateWrite.then(
    () => "unexpected_success",
    (error: Error) => error.message,
  );
  try {
    await waitForBlockedWrites(1);
    await AuthService.deleteUser(lateUser, deleting);
    await deleting.query("commit");
  } catch (error) {
    await deleting.query("rollback");
    throw error;
  } finally {
    deleting.release();
  }
  assert.equal(
    await lateResult,
    "user_unavailable",
    "late writes cannot recreate deleted preferences",
  );
  console.log(
    "[onboarding-integration-tests] PG16 migration/cohorts, choices, replace/skip, profile atomicity, real races, completion, merge and deletion passed",
  );
} finally {
  globalThis.fetch = originalFetch;
  await pool.query(
    "update onboarding_interests set enabled=true where id='sports'",
  );
  await pool.query(
    "update users set avatar_asset_id=null where id=any($1::uuid[])",
    [users],
  );
  await pool.query(
    "delete from content_storage_deletion_jobs where storage_key=any($1::text[])",
    [assets],
  );
  await pool.query("delete from content_assets where id=any($1::uuid[])", [
    assets,
  ]);
  await pool.query("delete from users where id=any($1::uuid[])", [users]);
  await pool.end();
}
