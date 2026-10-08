import type { DbQuery } from "../db.js";
import { getContentServiceRuntime } from "../content-service-runtime.js";
import {
  enqueueContentStorageDeletion,
  stagingDeletionAvailableAt,
} from "./content-asset-deletion.js";

/** Caller holds the user lifecycle lock. No remote calls or financial execution. */
export async function clearUserSocialData(
  db: DbQuery,
  userId: string,
): Promise<void> {
  await db.query(
    `update users set handle=null,bio=null,avatar_asset_id=null,handle_changed_at=null,
    profile_name_edited_at=null,profile_avatar_edited_at=null,social_suspended_at=null where id=$1`,
    [userId],
  );
  await db.query(
    `update user_theses set author_hidden_at=coalesce(author_hidden_at,now()),body='' where author_id=$1`,
    [userId],
  );
  await db.query(
    `update social_comments set author_hidden_at=coalesce(author_hidden_at,now()),body='' where author_id=$1`,
    [userId],
  );
  await db.query(`delete from social_likes where user_id=$1`, [userId]);
  await db.query(
    `delete from user_follows where follower_user_id=$1 or followed_user_id=$1`,
    [userId],
  );
  await db.query(
    `delete from user_blocks where blocker_user_id=$1 or blocked_user_id=$1`,
    [userId],
  );
  await db.query(
    `update social_reports set reporter_id=null where reporter_id=$1`,
    [userId],
  );
  await db.query(
    `update content_audit_events set actor_user_id=null,actor_label='deleted-user' where actor_user_id=$1`,
    [userId],
  );
  // Claimed verifications may finish remotely. Promotion rechecks status and
  // reopens target cleanup if a late copy follows this deletion. Never delete
  // remote storage inside the account transaction.
  const { rows } = await db.query<{
    id: string;
    storage_key: string;
    metadata: Record<string, unknown>;
  }>(
    `select id,storage_key,metadata from content_assets a where owner_user_id=$1 and status<>'deleted'
     and not exists(select 1 from content_asset_usages usage_row where usage_row.asset_id=a.id)
     and not exists(select 1 from users profile_row where profile_row.avatar_asset_id=a.id)
     for update`,
    [userId],
  );
  for (const asset of rows) {
    await db.query(
      `update content_assets set status='deleted',deleted_at=now() where id=$1`,
      [asset.id],
    );
    const keys = [
      asset.storage_key,
      asset.metadata?.verificationTargetKey,
    ].filter((key): key is string => typeof key === "string" && key.length > 0);
    for (const key of keys)
      await enqueueContentStorageDeletion(
        db,
        key,
        key.startsWith("content-staging/")
          ? stagingDeletionAvailableAt({
              uploadExpiresAt: asset.metadata?.uploadExpiresAt,
              uploadTtlSec: getContentServiceRuntime().assetUploadTtlSec,
            })
          : new Date(),
      );
  }
}

/** Existing account merge already locks both users. Economic keys never change. */
export async function mergeUserSocialData(
  db: DbQuery,
  sourceId: string,
  targetId: string,
  keepSource: boolean,
): Promise<void> {
  if (sourceId === targetId)
    throw new Error("Cannot merge a social profile into itself");
  await db.query(
    `update users target_row set social_suspended_at=coalesce(target_row.social_suspended_at,source_row.social_suspended_at)
    from users source_row where target_row.id=$2 and source_row.id=$1`,
    [sourceId, targetId],
  );
  // Exact typed targets do not change when their authors merge. Unlike follow
  // edges, likes may become self-likes and must survive that ownership transfer.
  await db.query(
    `insert into social_likes(user_id,thesis_id,ai_note_id,comment_id,created_at)
    select $2::uuid,thesis_id,ai_note_id,comment_id,created_at from social_likes where user_id=$1
    on conflict do nothing`,
    [sourceId, targetId],
  );
  await db.query(`delete from social_likes where user_id=$1`, [sourceId]);
  for (const [table, left, right] of [
    ["user_follows", "follower_user_id", "followed_user_id"],
    ["user_blocks", "blocker_user_id", "blocked_user_id"],
  ] as const) {
    await db.query(
      `insert into ${table}(${left},${right},created_at)
      select case when ${left}=$1 then $2::uuid else ${left} end,case when ${right}=$1 then $2::uuid else ${right} end,created_at
      from ${table} where (${left}=$1 or ${right}=$1)
      and (case when ${left}=$1 then $2::uuid else ${left} end)<>(case when ${right}=$1 then $2::uuid else ${right} end)
      on conflict(${left},${right}) do nothing`,
      [sourceId, targetId],
    );
    await db.query(`delete from ${table} where ${left}=$1 or ${right}=$1`, [
      sourceId,
    ]);
  }
  // A block survives merge and takes precedence over a pre-existing follow.
  await db.query(
    `delete from user_follows f where (f.follower_user_id=$1 or f.followed_user_id=$1)
    and exists(select 1 from user_blocks b where (b.blocker_user_id=f.follower_user_id and b.blocked_user_id=f.followed_user_id)
      or (b.blocker_user_id=f.followed_user_id and b.blocked_user_id=f.follower_user_id))`,
    [targetId],
  );
  for (const [table, owner] of [
    ["user_theses", "author_id"],
    ["social_comments", "author_id"],
    ["copy_attributions", "copier_user_id"],
  ] as const) {
    await db.query(
      `update ${table} source_row set idempotency_key='merged:'||$1::uuid::text||':'||source_row.id::text
      where source_row.${owner}=$1 and exists(select 1 from ${table} target_row where target_row.${owner}=$2 and target_row.idempotency_key=source_row.idempotency_key)`,
      [sourceId, targetId],
    );
    await db.query(`update ${table} set ${owner}=$2 where ${owner}=$1`, [
      sourceId,
      targetId,
    ]);
  }
  // A worker leased under the old account must not apply its stale ownership
  // observation after merge. Frozen execution facts remain unchanged.
  await db.query(
    `update copy_attributions set repair_lease_token=null,repair_lease_until=null,repair_due_at=now()
    where copier_user_id=$1`,
    [targetId],
  );
  // Keep duplicate report evidence but anonymize the redundant reporting identity.
  await db.query(
    `with mapped_reports as (
    select id,case when reporter_id=$1 then $2::uuid else reporter_id end as mapped_reporter,target_kind,
      case when target_kind='user' and target_id=$1 then $2::uuid else target_id end as mapped_target
    from social_reports where reporter_id in ($1,$2) or target_profile_id in ($1,$2)
  ), ranked_reports as (
    select id,row_number() over(partition by mapped_reporter,target_kind,mapped_target order by id) as duplicate_ordinal
    from mapped_reports where mapped_reporter is not null
  ) update social_reports r set reporter_id=null from ranked_reports ranked where r.id=ranked.id and ranked.duplicate_ordinal>1`,
    [sourceId, targetId],
  );
  await db.query(
    `update social_reports set reporter_id=case when reporter_id=$1 then $2::uuid else reporter_id end,
    target_profile_id=case when target_profile_id=$1 then $2::uuid else target_profile_id end,
    target_id=case when target_kind='user' and target_id=$1 then $2::uuid else target_id end
    where reporter_id=$1 or target_profile_id=$1`,
    [sourceId, targetId],
  );
  await db.query(
    `update content_assets set owner_user_id=$2 where owner_user_id=$1`,
    [sourceId, targetId],
  );
  await db.query(
    `update content_audit_events set actor_user_id=$2 where actor_user_id=$1`,
    [sourceId, targetId],
  );
  if (!keepSource) {
    const { rows } = await db.query<{
      handle: string | null;
      bio: string | null;
      display_name: string | null;
      avatar_url: string | null;
      avatar_asset_id: string | null;
      handle_changed_at: Date | null;
      profile_name_edited_at: Date | null;
      profile_avatar_edited_at: Date | null;
    }>(
      `select handle,bio,display_name,avatar_url,avatar_asset_id,handle_changed_at,profile_name_edited_at,profile_avatar_edited_at from users where id=$1`,
      [sourceId],
    );
    const profile = rows[0];
    await db.query(
      `update users set handle=null,avatar_asset_id=null where id=$1`,
      [sourceId],
    );
    if (profile)
      await db.query(
        `update users set handle=coalesce(handle,$2),bio=coalesce(bio,$3),
      avatar_asset_id=case when profile_avatar_edited_at is null and avatar_asset_id is null and avatar_url is null then $4 else avatar_asset_id end,
      avatar_url=case when profile_avatar_edited_at is null and avatar_asset_id is null and avatar_url is null then $9 else avatar_url end,
      handle_changed_at=case when handle is null then $5 else handle_changed_at end,
      profile_name_edited_at=case when display_name is null then $6 else profile_name_edited_at end,
      display_name=coalesce(display_name,$8),
      profile_avatar_edited_at=case when profile_avatar_edited_at is null and avatar_asset_id is null and avatar_url is null then $7 else profile_avatar_edited_at end
      where id=$1`,
        [
          targetId,
          profile.handle,
          profile.bio,
          profile.avatar_asset_id,
          profile.handle_changed_at,
          profile.profile_name_edited_at,
          profile.profile_avatar_edited_at,
          profile.display_name,
          profile.avatar_url,
        ],
      );
  } else {
    // Source credentials may survive, but moved assets must not remain attached there.
    await db.query(
      `update users set avatar_url=case when avatar_asset_id is not null then null else avatar_url end,
      profile_avatar_edited_at=case when avatar_asset_id is not null then now() else profile_avatar_edited_at end,
      avatar_asset_id=null where id=$1`,
      [sourceId],
    );
  }
}

/** Repoint social FKs before the existing exact duplicate execution is removed. */
export async function reparentMergedSocialExecutions(
  db: DbQuery,
  sourceId: string,
  targetId: string,
): Promise<void> {
  // Exact aliases can differ only in their verification cache. Do not discard the
  // source's sole verified observation when deleting its row, or revive revocation.
  // Clear in-flight leases so a pre-merge observation cannot overwrite merged facts.
  await db.query(
    `update executions target_execution set
    verified_buy_facts=case when target_execution.verified_buy_facts is null
      and target_execution.verified_buy_state='pending' and source_execution.verified_buy_state='verified'
      then source_execution.verified_buy_facts else target_execution.verified_buy_facts end,
    verified_buy_state=case when source_execution.verified_buy_state='revoked' or target_execution.verified_buy_state='revoked' then 'revoked'
      when target_execution.verified_buy_facts is null and target_execution.verified_buy_state='pending'
        and source_execution.verified_buy_state='verified' and source_execution.verified_buy_facts is not null then 'verified'
      else target_execution.verified_buy_state end,
    verified_buy_reason=case when source_execution.verified_buy_state='revoked' or target_execution.verified_buy_state='revoked'
      then 'merged_purchase_requires_review'
      when target_execution.verified_buy_facts is null and target_execution.verified_buy_state='pending'
        and source_execution.verified_buy_state='verified' and source_execution.verified_buy_facts is not null then null
      else target_execution.verified_buy_reason end,
    verified_buy_revision=greatest(target_execution.verified_buy_revision,source_execution.verified_buy_revision)+1,
    verified_buy_due_at=now(),verified_buy_lease_token=null,verified_buy_lease_until=null
    from executions source_execution where source_execution.user_id=$1 and target_execution.user_id=$2
      and source_execution.wallet_address is not distinct from target_execution.wallet_address
      and source_execution.venue=target_execution.venue and source_execution.tx_signature=target_execution.tx_signature`,
    [sourceId, targetId],
  );
  for (const table of ["user_theses", "copy_attributions"] as const)
    await db.query(
      `update ${table} ref_row set execution_id=target_execution.id
    from executions source_execution join executions target_execution on target_execution.user_id=$2
      and source_execution.wallet_address is not distinct from target_execution.wallet_address
      and source_execution.venue=target_execution.venue and source_execution.tx_signature=target_execution.tx_signature
    where source_execution.user_id=$1 and ref_row.execution_id=source_execution.id`,
      [sourceId, targetId],
    );
  for (const [table, invalidation] of [
    [
      "user_theses",
      "proof_invalidated_at=coalesce(ref_row.proof_invalidated_at,now())",
    ],
    ["copy_attributions", "state='revoked',updated_at=now()"],
  ] as const)
    await db.query(
      `update ${table} ref_row set ${invalidation}
    from executions source_execution join executions target_execution on target_execution.user_id=$2
      and source_execution.wallet_address is not distinct from target_execution.wallet_address
      and source_execution.venue=target_execution.venue and source_execution.tx_signature=target_execution.tx_signature
    where source_execution.user_id=$1 and target_execution.verified_buy_state='revoked'
      and ref_row.execution_id=target_execution.id`,
      [sourceId, targetId],
    );
}
