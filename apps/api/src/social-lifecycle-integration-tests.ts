// @requires-db
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolveContentRuntimeConfig } from "@hunch/config/content";
import {
  configureContentServiceRuntime,
  resetContentServiceRuntimeForTests,
} from "./content-service-runtime.js";
import type { DbQuery } from "./db.js";
import { createIntegrationTestPool } from "./test-database-target.js";
import {
  clearUserSocialData,
  mergeUserSocialData,
  reparentMergedSocialExecutions,
} from "./services/social-lifecycle.js";
import {
  enqueueContentStorageDeletion,
  stagingDeletionAvailableAt,
} from "./services/content-asset-deletion.js";

const pool = await createIntegrationTestPool({
  max: 1,
  options: "-c statement_timeout=15000",
});
const client = await pool.connect();
const db: DbQuery = { query: client.query.bind(client) as DbQuery["query"] };
configureContentServiceRuntime(
  resolveContentRuntimeConfig({ CONTENT_ASSET_UPLOAD_TTL_SEC: "600" }, "test"),
);
async function user(name: string) {
  const id = randomUUID();
  await client.query(
    `insert into users(id,handle,display_name,bio) values($1,$2,$2,'Biography')`,
    [id, `${name}_${id.slice(0, 8)}`],
  );
  return id;
}
async function asset(owner: string, key: string, metadata: object = {}) {
  const id = randomUUID();
  await client.query(
    `insert into content_assets(id,owner_user_id,storage_key,status,metadata) values($1,$2,$3,'ready',$4)`,
    [id, owner, key, metadata],
  );
  return id;
}
async function thesis(
  owner: string,
  key = randomUUID(),
  executionId: string | null = null,
) {
  const id = randomUUID();
  await client.query(
    `insert into user_theses(id,author_id,idempotency_key,canonical_purchase_key,body,execution_id) values($1::uuid,$2,$3,$1::uuid::text,'Immutable thesis',$4)`,
    [id, owner, key, executionId],
  );
  return id;
}
async function comment(owner: string, parent: string, key = randomUUID()) {
  const id = randomUUID();
  await client.query(
    `insert into social_comments(id,author_id,idempotency_key,thesis_id,body) values($1,$2,$3,$4,'Comment')`,
    [id, owner, key, parent],
  );
  return id;
}
async function copy(
  owner: string,
  parent: string,
  key = randomUUID(),
  executionId: string | null = null,
) {
  const id = randomUUID();
  await client.query(
    `insert into copy_attributions(id,copier_user_id,idempotency_key,source_thesis_id,canonical_purchase_key,execution_id) values($1::uuid,$2,$3,$4,$1::uuid::text,$5)`,
    [id, owner, key, parent, executionId],
  );
  return id;
}
async function profile(id: string) {
  return (await client.query(`select * from users where id=$1`, [id])).rows[0];
}
async function report(
  reporter: string,
  kind: "user" | "thesis" | "comment",
  target: string,
) {
  const id = randomUUID();
  await client.query(
    `insert into social_reports(id,reporter_id,target_kind,target_id,target_profile_id,thesis_id,comment_id) values($1,$2,$3,$4,$5,$6,$7)`,
    [
      id,
      reporter,
      kind,
      target,
      kind === "user" ? target : null,
      kind === "thesis" ? target : null,
      kind === "comment" ? target : null,
    ],
  );
  return id;
}
try {
  assert.equal(
    Math.floor(
      Number(
        (await client.query("show server_version_num")).rows[0]
          .server_version_num,
      ) / 10000,
    ),
    16,
  );
  await client.query("begin");
  await client.query(`
    create temporary table users(id uuid primary key,handle text unique,bio text,avatar_asset_id uuid,handle_changed_at timestamptz,profile_name_edited_at timestamptz,profile_avatar_edited_at timestamptz,social_suspended_at timestamptz,display_name text,avatar_url text);
    create temporary table executions(id uuid primary key,user_id uuid references users(id),wallet_address text,venue text,tx_signature text,
      verified_buy_facts jsonb,verified_buy_state text default 'pending',verified_buy_reason text,verified_buy_revision bigint default 0,
      verified_buy_due_at timestamptz,verified_buy_lease_token uuid,verified_buy_lease_until timestamptz);
    create temporary table content_assets(id uuid primary key,owner_user_id uuid references users(id) on delete set null,storage_key text,metadata jsonb,status text,deleted_at timestamptz);
    alter table users add constraint fixture_avatar_fk foreign key(avatar_asset_id) references content_assets(id) on delete set null;
    create temporary table content_asset_usages(asset_id uuid references content_assets(id));
    create temporary table content_audit_events(id uuid primary key default gen_random_uuid(),actor_user_id uuid references users(id) on delete set null,actor_label text);
    create temporary table content_storage_deletion_jobs(storage_key text primary key,available_at timestamptz,status text default 'pending',locked_at timestamptz,locked_by text,completed_at timestamptz,attempts integer default 0,last_error text);
    create temporary table user_follows(follower_user_id uuid references users(id) on delete cascade,followed_user_id uuid references users(id) on delete cascade,created_at timestamptz default now(),primary key(follower_user_id,followed_user_id),check(follower_user_id<>followed_user_id));
    create temporary table user_blocks(blocker_user_id uuid references users(id) on delete cascade,blocked_user_id uuid references users(id) on delete cascade,created_at timestamptz default now(),primary key(blocker_user_id,blocked_user_id),check(blocker_user_id<>blocked_user_id));
    create temporary table user_theses(id uuid primary key,author_id uuid references users(id) on delete set null,idempotency_key text,canonical_purchase_key text unique,body text,author_hidden_at timestamptz,moderation_hidden_at timestamptz,proof_invalidated_at timestamptz,execution_id uuid references executions(id) on delete restrict,unique(author_id,idempotency_key));
    create temporary table social_comments(id uuid primary key,author_id uuid references users(id) on delete set null,idempotency_key text,thesis_id uuid references user_theses(id) on delete restrict,body text,author_hidden_at timestamptz,unique(author_id,idempotency_key));
    create temporary table copy_attributions(id uuid primary key,copier_user_id uuid references users(id) on delete set null,idempotency_key text,source_thesis_id uuid references user_theses(id) on delete restrict,canonical_purchase_key text unique,execution_id uuid references executions(id) on delete restrict,state text default 'confirmed',execution_facts jsonb,repair_lease_token uuid,repair_lease_until timestamptz,repair_due_at timestamptz,updated_at timestamptz default now(),unique(copier_user_id,idempotency_key));
    create temporary table social_reports(id uuid primary key,reporter_id uuid references users(id) on delete set null,target_kind text,target_id uuid,target_profile_id uuid references users(id) on delete set null,thesis_id uuid references user_theses(id) on delete restrict,comment_id uuid references social_comments(id) on delete restrict,unique(reporter_id,target_kind,target_id));
    create temporary table social_moderation_events(id uuid primary key default gen_random_uuid(),target_id uuid,reason text);
  `);

  // Deletion clears social identity without destroying the immutable financial reference.
  const doomed = await user("delete");
  const other = await user("other");
  const ownThesis = await thesis(doomed);
  const ownComment = await comment(doomed, ownThesis);
  const ownCopy = await copy(other, ownThesis);
  const expiresAt = new Date(Date.now() + 300_000).toISOString();
  const stagingKey = `content-staging/${randomUUID()}`;
  const finalKey = `content/${randomUUID()}`;
  const upload = await asset(doomed, stagingKey, {
    uploadExpiresAt: expiresAt,
    verificationTargetKey: finalKey,
  });
  const usedByCms = await asset(doomed, `content/${randomUUID()}`);
  const usedByProfile = await asset(doomed, `content/${randomUUID()}`);
  await client.query(`insert into content_asset_usages(asset_id) values($1)`, [
    usedByCms,
  ]);
  await client.query(
    `update users set avatar_asset_id=$2,avatar_url='owned-upload',profile_avatar_edited_at=now() where id=$1`,
    [doomed, upload],
  );
  await client.query(`update users set avatar_asset_id=$2 where id=$1`, [
    other,
    usedByProfile,
  ]);
  await client.query(`insert into user_follows values($1,$2,now());`, [
    doomed,
    other,
  ]);
  await client.query(`insert into user_blocks values($1,$2,now())`, [
    other,
    doomed,
  ]);
  await client.query(
    `insert into content_audit_events(actor_user_id,actor_label) values($1,'old-identity')`,
    [doomed],
  );
  const oldReport = await report(doomed, "thesis", ownThesis);
  const profileReport = await report(other, "user", doomed);
  await client.query(
    `insert into social_moderation_events(target_id,reason) values($1,'Historical decision')`,
    [doomed],
  );
  await client.query(
    `insert into content_storage_deletion_jobs(storage_key,available_at,status,completed_at) values($1,now(),'completed',now())`,
    [stagingKey],
  );
  await clearUserSocialData(db, doomed);
  const deletedProfile = await profile(doomed);
  assert.equal(deletedProfile.handle, null);
  assert.equal(deletedProfile.bio, null);
  assert.equal(deletedProfile.avatar_asset_id, null);
  const tombstone = (
    await client.query(`select * from user_theses where id=$1`, [ownThesis])
  ).rows[0];
  assert.equal(tombstone.body, "");
  assert.ok(tombstone.author_hidden_at);
  assert.equal(tombstone.canonical_purchase_key, ownThesis);
  assert.equal(
    (
      await client.query(`select body from social_comments where id=$1`, [
        ownComment,
      ])
    ).rows[0].body,
    "",
  );
  assert.equal(
    (
      await client.query(
        `select * from user_follows where follower_user_id=$1 or followed_user_id=$1`,
        [doomed],
      )
    ).rows.length,
    0,
  );
  assert.equal(
    (
      await client.query(
        `select * from user_blocks where blocker_user_id=$1 or blocked_user_id=$1`,
        [doomed],
      )
    ).rows.length,
    0,
  );
  assert.equal(
    (
      await client.query(`select reporter_id from social_reports where id=$1`, [
        oldReport,
      ])
    ).rows[0].reporter_id,
    null,
  );
  assert.equal(
    (
      await client.query(
        `select actor_label from content_audit_events where actor_label='deleted-user'`,
      )
    ).rows.length,
    1,
  );
  const queued = (
    await client.query(
      `select * from content_storage_deletion_jobs where storage_key=$1`,
      [stagingKey],
    )
  ).rows[0];
  assert.equal(queued.status, "pending");
  assert.ok(
    new Date(queued.available_at).getTime() >= Date.parse(expiresAt) + 60_000,
  );
  assert.equal(
    (
      await client.query(`select status from content_assets where id=$1`, [
        upload,
      ])
    ).rows[0].status,
    "deleted",
  );
  for (const preserved of [usedByCms, usedByProfile])
    assert.equal(
      (
        await client.query(`select status from content_assets where id=$1`, [
          preserved,
        ])
      ).rows[0].status,
      "ready",
    );
  await clearUserSocialData(db, doomed); // idempotent cleanup, no late queue acceleration
  assert.equal(
    (
      await client.query(
        `select available_at from content_storage_deletion_jobs where storage_key=$1`,
        [stagingKey],
      )
    ).rows[0].available_at.getTime(),
    queued.available_at.getTime(),
  );
  await client.query(`delete from users where id=$1`, [doomed]);
  assert.equal(
    (
      await client.query(`select author_id from user_theses where id=$1`, [
        ownThesis,
      ])
    ).rows[0].author_id,
    null,
  );
  assert.equal(
    (
      await client.query(
        `select source_thesis_id from copy_attributions where id=$1`,
        [ownCopy],
      )
    ).rows[0].source_thesis_id,
    ownThesis,
  );
  assert.equal(
    (
      await client.query(
        `select target_profile_id,target_id from social_reports where id=$1`,
        [profileReport],
      )
    ).rows[0].target_profile_id,
    null,
  );
  assert.equal(
    (
      await client.query(
        `select count(*)::int n from social_moderation_events where target_id=$1`,
        [doomed],
      )
    ).rows[0].n,
    1,
  );

  // Merge folds edges/reports but preserves publication/economic identities and target profile.
  const source = await user("source");
  const target = await user("target");
  const third = await user("third");
  const observer = await user("observer");
  const sourceAvatar = await asset(source, `content/${randomUUID()}`);
  await client.query(
    `update users set social_suspended_at=now(),avatar_asset_id=$2,avatar_url='source-avatar',profile_avatar_edited_at=now() where id=$1`,
    [source, sourceAvatar],
  );
  await client.query(
    `update users set avatar_url='target-avatar' where id=$1`,
    [target],
  );
  const originalTarget = await profile(target);
  const originalSource = await profile(source);
  for (const [left, right] of [
    [source, target],
    [target, source],
    [source, third],
    [target, third],
    [observer, source],
  ])
    await client.query(`insert into user_follows values($1,$2,now())`, [
      left,
      right,
    ]);
  await client.query(`insert into user_blocks values($1,$2,now())`, [
    third,
    source,
  ]);
  const key = randomUUID();
  const sourceThesis = await thesis(source, key);
  const targetThesis = await thesis(target, key);
  const sourceComment = await comment(source, targetThesis, key);
  await comment(target, targetThesis, key);
  const sourceCopy = await copy(source, targetThesis, key);
  await copy(target, sourceThesis, key);
  await report(source, "thesis", targetThesis);
  await report(target, "thesis", targetThesis);
  await report(third, "user", source);
  await report(third, "user", target);
  await mergeUserSocialData(db, source, target, true);
  assert.equal((await profile(target)).handle, originalTarget.handle);
  assert.equal((await profile(target)).avatar_url, "target-avatar");
  assert.equal((await profile(target)).avatar_asset_id, null);
  assert.ok((await profile(target)).social_suspended_at);
  assert.equal((await profile(source)).handle, originalSource.handle);
  assert.equal((await profile(source)).avatar_asset_id, null);
  assert.equal((await profile(source)).avatar_url, null);
  assert.equal(
    (
      await client.query(
        `select owner_user_id from content_assets where id=$1`,
        [sourceAvatar],
      )
    ).rows[0].owner_user_id,
    target,
  );
  assert.equal(
    (
      await client.query(
        `select * from user_follows where follower_user_id=followed_user_id`,
      )
    ).rows.length,
    0,
  );
  assert.equal(
    (
      await client.query(
        `select * from user_follows where follower_user_id=$1 and followed_user_id=$2`,
        [target, third],
      )
    ).rows.length,
    0,
  );
  assert.equal(
    (
      await client.query(
        `select * from user_blocks where blocker_user_id=$1 and blocked_user_id=$2`,
        [third, target],
      )
    ).rows.length,
    1,
  );
  assert.equal(
    (
      await client.query(
        `select * from user_follows where follower_user_id=$1 and followed_user_id=$2`,
        [observer, target],
      )
    ).rows.length,
    1,
  );
  assert.equal(
    (
      await client.query(`select author_id from social_comments where id=$1`, [
        sourceComment,
      ])
    ).rows[0].author_id,
    target,
  );
  assert.equal(
    (
      await client.query(
        `select copier_user_id from copy_attributions where id=$1`,
        [sourceCopy],
      )
    ).rows[0].copier_user_id,
    target,
  );
  assert.equal(
    (
      await client.query(
        `select count(*)::int n from social_reports where reporter_id=$1 and target_kind='user' and target_id=$2`,
        [third, target],
      )
    ).rows[0].n,
    1,
  );
  // A later source publication may reuse the same request key after a keepSource merge.
  const later = await thesis(source, key);
  await comment(source, targetThesis, key);
  const laterCopy = await copy(source, targetThesis, key);
  const executionlessFacts = {
    canonicalPurchaseKey: "economic-owner:signature",
    evidenceRevision: "source-only",
  };
  await client.query(
    `update copy_attributions set execution_facts=$2,repair_lease_token=gen_random_uuid(),repair_lease_until=now()+interval '1 hour' where id=$1`,
    [laterCopy, executionlessFacts],
  );
  await mergeUserSocialData(db, source, target, true);
  const mergedCopy = (
    await client.query(`select * from copy_attributions where id=$1`, [
      laterCopy,
    ])
  ).rows[0];
  assert.deepEqual(mergedCopy.execution_facts, executionlessFacts);
  assert.equal(mergedCopy.execution_id, null);
  assert.equal(mergedCopy.repair_lease_token, null);
  assert.equal(mergedCopy.repair_lease_until, null);
  assert.ok(mergedCopy.repair_due_at);
  assert.equal(
    (
      await client.query(`select author_id from user_theses where id=$1`, [
        later,
      ])
    ).rows[0].author_id,
    target,
  );
  assert.equal(
    (
      await client.query(
        `select count(distinct idempotency_key)::int n from user_theses where author_id=$1`,
        [target],
      )
    ).rows[0].n,
    3,
  );
  await mergeUserSocialData(db, source, target, true); // repeat without new rows

  // An empty target adopts one coherent identity; an explicit avatar removal is preserved.
  const adoptSource = await user("adopt");
  const adoptTarget = await user("empty");
  const adoptAsset = await asset(adoptSource, `content/${randomUUID()}`);
  await client.query(
    `update users set avatar_asset_id=$2,avatar_url='adopt-avatar',profile_name_edited_at=now(),profile_avatar_edited_at=now() where id=$1`,
    [adoptSource, adoptAsset],
  );
  await client.query(
    `update users set handle=null,bio=null,display_name=null,avatar_url=null where id=$1`,
    [adoptTarget],
  );
  const sourceIdentity = await profile(adoptSource);
  await mergeUserSocialData(db, adoptSource, adoptTarget, false);
  const adopted = await profile(adoptTarget);
  assert.equal(adopted.handle, sourceIdentity.handle);
  assert.equal(adopted.display_name, sourceIdentity.display_name);
  assert.equal(adopted.avatar_asset_id, adoptAsset);
  assert.equal(adopted.avatar_url, "adopt-avatar");
  assert.ok(adopted.profile_avatar_edited_at);
  await client.query(`delete from users where id=$1`, [adoptSource]);
  const explicitSource = await user("explicit_source");
  const explicitTarget = await user("explicit_target");
  const explicitAsset = await asset(explicitSource, `content/${randomUUID()}`);
  await client.query(
    `update users set avatar_asset_id=$2,avatar_url='must-not-return' where id=$1`,
    [explicitSource, explicitAsset],
  );
  await client.query(
    `update users set profile_avatar_edited_at=now(),avatar_url=null,avatar_asset_id=null where id=$1`,
    [explicitTarget],
  );
  await mergeUserSocialData(db, explicitSource, explicitTarget, false);
  assert.equal((await profile(explicitTarget)).avatar_asset_id, null);
  assert.equal((await profile(explicitTarget)).avatar_url, null);

  // Exact duplicate executions must be reparented before deleting the redundant ledger row.
  const executionSource = await user("execution_source");
  const executionTarget = await user("execution_target");
  const sourceExecution = randomUUID();
  const targetExecution = randomUUID();
  await client.query(
    `insert into executions(id,user_id,wallet_address,venue,tx_signature) values($1,$2,null,'kalshi','signature'),($3,$4,null,'kalshi','signature')`,
    [sourceExecution, executionSource, targetExecution, executionTarget],
  );
  const executionThesis = await thesis(
    executionSource,
    randomUUID(),
    sourceExecution,
  );
  const executionCopy = await copy(
    executionSource,
    targetThesis,
    randomUUID(),
    sourceExecution,
  );
  const sourceFacts = {
    version: 1,
    canonicalPurchaseKey: "kalshi:signature:owner",
    evidenceRevision: "frozen-revision",
  };
  await client.query(
    `update executions set verified_buy_state='verified',verified_buy_facts=$2::jsonb,verified_buy_revision=7 where id=$1`,
    [sourceExecution, sourceFacts],
  );
  await client.query(
    `update executions set verified_buy_lease_token=gen_random_uuid(),verified_buy_lease_until=now()+interval '1 hour' where id=$1`,
    [targetExecution],
  );
  await reparentMergedSocialExecutions(db, executionSource, executionTarget);
  await client.query(`delete from executions where id=$1`, [sourceExecution]);
  assert.equal(
    (
      await client.query(`select execution_id from user_theses where id=$1`, [
        executionThesis,
      ])
    ).rows[0].execution_id,
    targetExecution,
  );
  const transferredFacts = (
    await client.query(`select * from executions where id=$1`, [
      targetExecution,
    ])
  ).rows[0];
  assert.deepEqual(transferredFacts.verified_buy_facts, sourceFacts);
  assert.equal(transferredFacts.verified_buy_state, "verified");
  assert.equal(transferredFacts.verified_buy_revision, "8");
  assert.equal(transferredFacts.verified_buy_lease_token, null);
  assert.ok(transferredFacts.verified_buy_due_at);
  // Never overwrite populated target proof, and never let a stale verified alias revive revoked evidence.
  const revokedSource = randomUUID();
  const existingTarget = randomUUID();
  const targetFacts = {
    version: 1,
    canonicalPurchaseKey: "kalshi:revoked-signature:owner",
    evidenceRevision: "target-revision",
  };
  await client.query(
    `insert into executions(id,user_id,wallet_address,venue,tx_signature,verified_buy_state,verified_buy_facts)
    values($1,$2,null,'kalshi','revoked-signature','revoked',$5),($3,$4,null,'kalshi','revoked-signature','verified',$6)`,
    [
      revokedSource,
      executionSource,
      existingTarget,
      executionTarget,
      sourceFacts,
      targetFacts,
    ],
  );
  const revokedThesis = await thesis(
    executionSource,
    randomUUID(),
    revokedSource,
  );
  const revokedCopy = await copy(
    executionSource,
    targetThesis,
    randomUUID(),
    revokedSource,
  );
  const targetCopy = await copy(
    executionTarget,
    targetThesis,
    randomUUID(),
    existingTarget,
  );
  await reparentMergedSocialExecutions(db, executionSource, executionTarget);
  const preservedFacts = (
    await client.query(`select * from executions where id=$1`, [existingTarget])
  ).rows[0];
  assert.deepEqual(preservedFacts.verified_buy_facts, targetFacts);
  assert.equal(preservedFacts.verified_buy_state, "revoked");
  assert.equal(
    preservedFacts.verified_buy_reason,
    "merged_purchase_requires_review",
  );
  const invalidatedThesis = (
    await client.query(`select * from user_theses where id=$1`, [revokedThesis])
  ).rows[0];
  assert.ok(invalidatedThesis.proof_invalidated_at);
  assert.equal(invalidatedThesis.execution_id, existingTarget);
  for (const revokedCopyId of [revokedCopy, targetCopy]) {
    const invalidatedCopy = (
      await client.query(`select * from copy_attributions where id=$1`, [
        revokedCopyId,
      ])
    ).rows[0];
    assert.equal(invalidatedCopy.state, "revoked");
    assert.equal(invalidatedCopy.execution_id, existingTarget);
  }
  assert.equal(
    (
      await client.query(
        `select proof_invalidated_at from user_theses where id=$1`,
        [executionThesis],
      )
    ).rows[0].proof_invalidated_at,
    null,
  );
  assert.equal(
    (
      await client.query(`select state from copy_attributions where id=$1`, [
        executionCopy,
      ])
    ).rows[0].state,
    "confirmed",
  );
  assert.equal(
    (
      await client.query(
        `select execution_id from copy_attributions where id=$1`,
        [executionCopy],
      )
    ).rows[0].execution_id,
    targetExecution,
  );

  const fixedNow = new Date("2026-10-08T10:00:00Z");
  assert.equal(
    stagingDeletionAvailableAt({
      now: fixedNow,
      uploadTtlSec: 600,
      uploadExpiresAt: "bad",
    }).toISOString(),
    "2026-10-08T10:11:00.000Z",
  );
  const delayedKey = `content-staging/${randomUUID()}`;
  const laterDeadline = new Date(Date.now() + 600_000);
  await enqueueContentStorageDeletion(db, delayedKey, laterDeadline);
  await enqueueContentStorageDeletion(db, delayedKey, new Date());
  assert.equal(
    (
      await client.query(
        `select available_at from content_storage_deletion_jobs where storage_key=$1`,
        [delayedKey],
      )
    ).rows[0].available_at.getTime(),
    laterDeadline.getTime(),
  );
  console.log(
    "[social-lifecycle-integration-tests] PG16 deletion, privacy, durable cleanup, merge/keepSource/idempotency, suspension, profile identity and exact execution FK reparent PASS",
  );
} finally {
  await client.query("rollback");
  client.release();
  await pool.end();
  resetContentServiceRuntimeForTests();
}
