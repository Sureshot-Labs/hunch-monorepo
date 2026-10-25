import type { PoolClient } from "pg";
// @requires-db
import assert from "node:assert/strict";
import { createIntegrationTestPool } from "./test-database-target.js";
import { randomUUID } from "node:crypto";

globalThis.fetch = async () => {
  throw new Error("External network forbidden in audit");
};
const { AuthService } = await import("./auth.js");
const { moderateAdminSocialTarget } =
  await import("./services/social-moderation.js");
const pool = await createIntegrationTestPool({
  max: 4,
  options: "-c statement_timeout=5000 -c deadlock_timeout=100ms",
});
const limits = {
  pageSize: 20,
  maxPageSize: 50,
  moderationReasonMaxGraphemes: 1000,
};
const results = [];
type Outcome = {
  ok: boolean;
  value?: unknown;
  code?: string;
  message?: string;
  detail?: string;
};
const outcomes = (work: Promise<unknown>): Promise<Outcome> =>
  work.then(
    (value) => ({ ok: true, value }),
    (error) => ({
      ok: false,
      code: error.code,
      message: error.message,
      detail: error.detail,
    }),
  );
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}
try {
  assert.equal(
    (await pool.query("select current_database() db")).rows[0].db,
    process.env.HUNCH_TEST_EXPECT_DATABASE,
  );
  for (const scenario of [
    { action: "remove_avatar", withReport: true, delayBeforeResumeMs: 0 },
    { action: "remove_avatar", withReport: true, delayBeforeResumeMs: 150 },
    { action: "remove_avatar", withReport: false, delayBeforeResumeMs: 0 },
    { action: "suspend", withReport: true, delayBeforeResumeMs: 150 },
  ]) {
    const owner = randomUUID(),
      reporter = randomUUID(),
      report = randomUUID(),
      asset = randomUUID(),
      admin = randomUUID();
    const key = "content/lock-probe-" + asset + ".png",
      url = "https://images.example.test/" + key;
    let deletionClient!: PoolClient;
    let moderatorClient!: PoolClient;
    const reached = deferred(),
      resume = deferred();
    let deletion: Promise<Outcome> | undefined,
      moderation: Promise<Outcome> | undefined;
    try {
      await pool.query(
        "insert into users(id,display_name) values($1,'Deleting owner'),($2,'Reporter')",
        [owner, reporter],
      );
      await pool.query(
        `insert into content_assets(id,owner_user_id,status,kind,storage_key,public_url,original_filename,mime_type,byte_size,checksum_sha256,ready_at,metadata) values($1,$2,'ready','image',$3,$4,'avatar.png','image/png',100,repeat('a',64),now(),'{"avatarModerationConsentVersion":1}')`,
        [asset, owner, key, url],
      );
      await pool.query(
        "update users set avatar_asset_id=$2,avatar_url=$3 where id=$1",
        [owner, asset, url],
      );
      await pool.query(
        "insert into social_reports(id,reporter_id,target_profile_id,target_kind,target_id,reason) values($1,$2,$3,'user',$3,'Review avatar')",
        [report, reporter, owner],
      );
      deletionClient = await pool.connect();
      moderatorClient = await pool.connect();
      const deletingPid = Number(
        (await deletionClient.query("select pg_backend_pid() pid")).rows[0].pid,
      );
      const moderatorPid = Number(
        (await moderatorClient.query("select pg_backend_pid() pid")).rows[0]
          .pid,
      );
      await deletionClient.query("begin");
      await moderatorClient.query("begin");
      let gated = false;
      const proxy = {
        query: async (sql: string, values: unknown[]) => {
          const result = await deletionClient.query(sql, values);
          if (!gated && /select id, privy_user_id\s+from users/u.test(sql)) {
            gated = true;
            reached.resolve();
            await resume.promise;
          }
          return result;
        },
      };
      deletion = outcomes(
        (async () => {
          try {
            const result = await AuthService.deleteUser(owner, proxy as never);
            await deletionClient.query("commit");
            return result;
          } catch (error) {
            await deletionClient.query("rollback");
            throw error;
          }
        })(),
      );
      await reached.promise;
      moderation = outcomes(
        (async () => {
          try {
            const result = await moderateAdminSocialTarget(
              moderatorClient,
              {
                target: { kind: "user", id: owner },
                action: scenario.action as never,
                reason: "Review photo",
                expectedAvatarUrl: url,
                ...(scenario.withReport ? { reportId: report } : {}),
              },
              admin,
              limits,
            );
            await moderatorClient.query("commit");
            return result;
          } catch (error) {
            await moderatorClient.query("rollback");
            throw error;
          }
        })(),
      );
      let blockerObserved = false;
      for (let i = 0; i < 200; i++) {
        const row = (
          await pool.query(
            "select $1::int=any(pg_blocking_pids($2::int)) as blocked",
            [deletingPid, moderatorPid],
          )
        ).rows[0];
        if (row.blocked) {
          blockerObserved = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 10));
      }
      assert.ok(
        blockerObserved,
        "Moderator must reach the real user lock wait",
      );
      if (scenario.delayBeforeResumeMs)
        await new Promise((r) => setTimeout(r, scenario.delayBeforeResumeMs));
      resume.resolve();
      const [deleted, moderated] = await Promise.all([deletion, moderation]);
      assert.equal(deleted.ok, true);
      assert.ok(!moderated.ok && moderated.code !== "40P01");

      const post = {
        ownerExists:
          (await pool.query("select id from users where id=$1", [owner])).rows
            .length === 1,
        report: (
          await pool.query(
            "select status,target_profile_id from social_reports where id=$1",
            [report],
          )
        ).rows[0],
      };
      let recovery = null;
      if (!deleted.ok) {
        await deletionClient.query("begin");
        try {
          recovery = await AuthService.deleteUser(owner, deletionClient);
          await deletionClient.query("commit");
          assert.equal(recovery.disposition, "hard_deleted");
          assert.equal(
            (await pool.query("select id from users where id=$1", [owner])).rows
              .length,
            0,
          );
        } catch (error) {
          await deletionClient.query("rollback");
          throw error;
        }
      }
      results.push({
        scenario,
        realUserLockWaitObserved: blockerObserved,
        deletion: deleted,
        moderation: moderated,
        post,
        retryDeletionAfterContention: recovery,
      });
    } finally {
      resume.resolve();
      await Promise.allSettled([deletion, moderation].filter(Boolean));
      deletionClient?.release();
      moderatorClient?.release();
      await pool.query(
        "delete from social_moderation_events where target_id=$1",
        [owner],
      );
      await pool.query("delete from social_reports where id=$1", [report]);
      await pool.query("update users set avatar_asset_id=null where id=$1", [
        owner,
      ]);
      await pool.query("delete from content_audit_events where asset_id=$1", [
        asset,
      ]);
      await pool.query("delete from content_assets where id=$1", [asset]);
      await pool.query(
        "delete from content_storage_deletion_jobs where storage_key=$1",
        [key],
      );
      await pool.query("delete from users where id=any($1::uuid[])", [
        [owner, reporter],
      ]);
    }
  }
  console.log(
    "[social-moderation-deletion-lock] reported avatar removal and suspension serialize with deletion; no deadlocks",
  );
} finally {
  await pool.end();
  const { closeAcquiredRuntimeResources } =
    await import("./runtime-resource-cleanup.js");
  await closeAcquiredRuntimeResources();
}
