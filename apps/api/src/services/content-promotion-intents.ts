import { tx, type Pool } from "@hunch/infra";
import { enqueueContentStorageDeletion } from "./content-asset-deletion.js";

/** Unacknowledged remote requests have no reliable server cancellation signal.
 * Retain their repair obligation rather than guessing a safe expiry time. Each
 * bounded page advances its due index, including ready assets and empty tails.
 */
export async function reconcileContentPromotionIntents(
  pool: Pool,
  limit: number,
) {
  return tx(pool, async (db) => {
    const { rows } = await db.query<{
      id: string;
      storage_key: string;
      live: boolean;
    }>(
      `with page as materialized (
        select id,asset_id,storage_key from content_promotion_intents
        where next_check_at<=now() order by next_check_at,id limit $1 for update skip locked
      ) select p.id,p.storage_key,exists(select 1 from content_assets a where a.id=p.asset_id
        and a.status in ('pending','ready','verifying') and (a.storage_key=p.storage_key
          or a.metadata->>'verificationTargetKey'=p.storage_key)) as live from page p`,
      [limit],
    );
    for (const row of rows) {
      if (!row.live)
        await enqueueContentStorageDeletion(db, row.storage_key, new Date(), {
          reopenAfterPossibleWrite: true,
        });
    }
    if (rows.length)
      await db.query(
        `update content_promotion_intents set next_check_at=now()+interval '5 minutes' where id=any($1::uuid[])`,
        [rows.map((row) => row.id)],
      );
    return rows.length;
  });
}
