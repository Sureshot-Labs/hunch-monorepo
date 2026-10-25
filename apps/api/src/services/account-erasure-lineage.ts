import type { DbQuery } from "../db.js";
import { recordAccountErasure } from "./account-erasure-journal.js";

/** Must share the merge transaction and its ordered user locks. */
export async function transferAccountErasureLineage(
  db: DbQuery,
  source: string,
  target: string,
  keepSource: boolean,
) {
  await db.query(
    `update account_erasure_aliases set owner_user_id=$2 where owner_user_id=$1`,
    [source, target],
  );
  await db.query(
    `with transfer as (
    insert into account_merge_transfers(source_user_id,target_user_id,keep_source) values($1,$2,$3) returning id
  ) insert into account_erasure_aliases(transfer_id,owner_user_id) select id,$2 from transfer`,
    [source, target, keepSource],
  );
}

/** Caller holds the canonical owner's user lock through journal ACK and erase.
 * A snapshot containing a transfer already moved that source's old data; a
 * snapshot without it must replay erasure against the pre-merge identity too.
 */
export async function journalAccountErasureLineage(db: DbQuery, owner: string) {
  await recordAccountErasure(owner);
  let cursor: string | null = null;
  for (;;) {
    const {
      rows,
    }: { rows: { transfer_id: string; source_user_id: string }[] } =
      await db.query<{ transfer_id: string; source_user_id: string }>(
        `select a.transfer_id,t.source_user_id from account_erasure_aliases a
       join account_merge_transfers t on t.id=a.transfer_id
       where a.owner_user_id=$1 and a.transfer_id>coalesce($2::uuid,'00000000-0000-0000-0000-000000000000'::uuid)
       order by a.transfer_id limit 100`,
        [owner, cursor],
      );
    for (const row of rows)
      await recordAccountErasure(
        row.source_user_id,
        undefined,
        process.env,
        row.transfer_id,
      );
    if (rows.length < 100) return;
    const last = rows.at(-1);
    if (!last) return;
    cursor = last.transfer_id;
  }
}
