import { tx, type Pool } from "@hunch/infra";

/** Thesis writers only append FK-free invalidation signals. Acquire user locks
 * before locking/removing those markers or inserting the derived cache rows. */
export async function drainPendingSocialTraderStatistics(
  db: Pool,
  requestedBatchSize = 100,
) {
  const batchSize = Math.max(1, Math.min(1000, requestedBatchSize));
  return tx(db, async (client) => {
    const page = await client.query<{ id: string; user_id: string }>(
      `select id,user_id from social_trader_statistics_pending order by id limit $1`,
      [batchSize],
    );
    if (!page.rows.length) return 0;
    const ids = [...new Set(page.rows.map((row) => row.user_id))];
    // Include unavailable owners in this lock statement; eligibility is read
    // again after a concurrent lifecycle/unsuspension transaction commits.
    await client.query(
      `select id from users where id=any($1::uuid[]) order by id for no key update`,
      [ids],
    );
    const pending = await client.query<{ user_id: string }>(
      `delete from social_trader_statistics_pending where id=any($1::bigint[]) returning user_id`,
      [page.rows.map((row) => row.id)],
    );
    if (!pending.rows.length) return 0;
    await client.query(
      `insert into social_trader_statistics(user_id)
       select id from users where id=any($1::uuid[]) and is_active and social_suspended_at is null
       order by id on conflict(user_id) do update set
       next_refresh_at=least(social_trader_statistics.next_refresh_at,now()),
       generation=social_trader_statistics.generation+1`,
      [pending.rows.map((row) => row.user_id)],
    );
    return pending.rows.length;
  });
}
