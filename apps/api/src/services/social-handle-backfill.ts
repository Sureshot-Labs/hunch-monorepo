import type { DbQuery } from "../db.js";
import { resolveSocialPolicy } from "./social-policy.js";

/** Explicit, resumable maintenance only. Never rewrites legacy username. */
export async function backfillLegacySocialHandles(
  db: DbQuery,
  input: {
    afterId?: string;
    execute?: boolean;
  },
) {
  const { policy, revision } = await resolveSocialPolicy(db);
  const page = await db.query<{ id: string; handle: string | null }>(
    `
    select legacy_user.id, case when legacy_user.handle is null and legacy_user.is_active
      and legacy_user.username ~ '^[A-Za-z0-9_]+$'
      and length(legacy_user.username) between $2 and $3
      and not exists(select 1 from users other_user where other_user.id<>legacy_user.id
        and other_user.username ~ '^[A-Za-z0-9_]+$'
        and lower(other_user.username)=lower(legacy_user.username))
      and not exists(select 1 from users claimed_user where lower(claimed_user.handle)=lower(legacy_user.username))
      then lower(legacy_user.username) else null end as handle
    from users legacy_user ${input.afterId ? "where legacy_user.id>$1::uuid" : "where $1::uuid is null"}
    order by legacy_user.id limit $4`,
    [
      input.afterId ?? null,
      policy.handleMinLength,
      policy.handleMaxLength,
      policy.repairBatchSize,
    ],
  );
  let updated = 0;
  const candidates = page.rows.filter((row) => row.handle !== null);
  if (input.execute)
    for (const row of candidates) {
      // The unique lower(handle) index arbitrates concurrent user claims. A losing
      // backfill skips the row rather than turning legacy data into an outage.
      try {
        const result = await db.query(
          `update users legacy_user set handle=$2,handle_changed_at=now()
        where legacy_user.id=$1 and legacy_user.handle is null and legacy_user.is_active
          and lower(legacy_user.username)=$2 and legacy_user.username ~ '^[A-Za-z0-9_]+$'
          and not exists(select 1 from users other_user where other_user.id<>legacy_user.id
            and other_user.username ~ '^[A-Za-z0-9_]+$' and lower(other_user.username)=$2)
        returning legacy_user.id`,
          [row.id, row.handle],
        );
        updated += result.rows.length;
      } catch (error) {
        if ((error as { code?: string }).code !== "23505") throw error;
      }
    }
  return {
    dryRun: !input.execute,
    revision,
    scanned: page.rows.length,
    eligible: candidates.length,
    updated,
    nextAfterId:
      page.rows.length === policy.repairBatchSize
        ? (page.rows.at(-1)?.id ?? null)
        : null,
  };
}
