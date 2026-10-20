import { createHash, randomUUID } from "node:crypto";
import { tx, type Pool } from "@hunch/infra";
import { resolveSocialPolicy } from "./social-policy.js";
import { SocialService } from "./social-service.js";
import { resolveLimitlessPositionContract } from "./limitless-protocol-config.js";
import type { DbQuery } from "../db.js";
import { buildSocialTraderStatisticsRevision } from "./social-trader-statistics-policy.js";
import { drainPendingSocialTraderStatistics } from "./social-trader-statistics-pending.js";

/** Statistics use the profile's exact implementation and policy, away from list requests. */
export async function refreshSocialTraderStatistics(db: Pool, batchSize = 50) {
  const pending = await drainPendingSocialTraderStatistics(db);
  const resolved = await resolveSocialPolicy(db);
  const revision = buildSocialTraderStatisticsRevision(resolved.policy);
  const promotion = await scheduleSocialTraderStatisticsPolicyRefresh(
    db,
    revision,
  );
  const lease = randomUUID();
  const { rows } = await db.query<{ user_id: string; generation: string }>(
    `with selected as (
    select user_id from social_trader_statistics where next_refresh_at<=now()
      and (lease_until is null or lease_until<now()) order by next_refresh_at,user_id limit $1 for update skip locked
  ) update social_trader_statistics s set lease_id=$2,lease_until=now()+interval '5 minutes'
    from selected where s.user_id=selected.user_id returning s.user_id,s.generation`,
    [Math.min(50, batchSize), lease],
  );
  const service = new SocialService(db, undefined, {
    limitlessPositionContract: resolveLimitlessPositionContract(),
  });
  async function refresh(row: (typeof rows)[number]) {
    try {
      const active = await db.query(
        `update social_trader_statistics set lease_until=now()+interval '5 minutes' where user_id=$1 and lease_id=$2 and lease_until>now()
         returning user_id,(select is_agent from users where id=$1) as is_agent`,
        [row.user_id, lease],
      );
      if (!active.rows.length) return;
      const statistics = await service.profileStatistics(
        row.user_id,
        resolved.policy,
      );
      const paperPerformance = active.rows[0]?.is_agent
        ? await service.paperPerformance(row.user_id)
        : undefined;
      await db.query(
        `update social_trader_statistics set policy_revision=$3,statistics=$4,wins=$5,losses=$6,win_rate=$7,computed_at=now(),
        next_refresh_at=case when generation=$8 and not exists(
          select 1 from social_trader_statistics_pending pending where pending.user_id=$1
        ) then now()+interval '15 minutes' else now() end,lease_id=null,lease_until=null
        where user_id=$1 and lease_id=$2`,
        [
          row.user_id,
          lease,
          revision,
          JSON.stringify({
            ...statistics,
            ...(paperPerformance ? { paperPerformance } : {}),
          }),
          statistics.wins,
          statistics.losses,
          statistics.winRate,
          row.generation,
        ],
      );
    } catch {
      await db.query(
        `update social_trader_statistics set lease_id=null,lease_until=null,next_refresh_at=now()+interval '1 minute' where user_id=$1 and lease_id=$2`,
        [row.user_id, lease],
      );
    }
  }
  // Bound database concurrency without serializing the entire backlog.
  for (let index = 0; index < rows.length; index += 4)
    await Promise.all(rows.slice(index, index + 4).map(refresh));
  return pending === 100 || promotion.scanned === promotion.batchSize
    ? Math.max(rows.length, Math.min(50, batchSize))
    : rows.length;
}

/** Promote legacy/mismatched rows through a durable bounded primary-key scan.
 * No global UPDATE or synchronous HTTP backfill on policy transitions. */
export async function scheduleSocialTraderStatisticsPolicyRefresh(
  db: Pool,
  revision: string,
  requestedBatchSize = 100,
) {
  const batchSize = Math.max(1, Math.min(1000, requestedBatchSize));
  const name = "trader-statistics-policy";
  // item_id is the generic cursor's opaque cycle identity. A single cursor also
  // handles reverting to an earlier policy whose previous scan already finished.
  const fingerprint = createHash("sha256")
    .update(revision)
    .digest("hex")
    .slice(0, 32);
  const cycle = fingerprint.replace(
    /^(........)(....)(....)(....)(............)$/,
    "$1-$2-$3-$4-$5",
  );
  return tx(db, async (client) => {
    await client.query(
      `insert into native_push_worker_cursors(name,item_id) values($1,$2) on conflict do nothing`,
      [name, cycle],
    );
    const cursor = await client.query<{
      user_id: string | null;
      item_id: string | null;
      due: boolean;
    }>(
      `select user_id,item_id,available_at<=now() as due from native_push_worker_cursors where name=$1 for update skip locked`,
      [name],
    );
    const current = cursor.rows[0];
    if (!current || (current.item_id === cycle && !current.due))
      return { scanned: 0, batchSize };
    const after = current.item_id === cycle ? current.user_id : null;
    const page = await client.query<{ user_id: string }>(
      after
        ? `select user_id from social_trader_statistics where user_id>$1 order by user_id limit $2`
        : `select user_id from social_trader_statistics order by user_id limit $1`,
      after ? [after, batchSize] : [batchSize],
    );
    if (page.rows.length)
      await client.query(
        `update social_trader_statistics set next_refresh_at=least(next_refresh_at,now()),generation=generation+1
         where user_id=any($1::uuid[]) and policy_revision is distinct from $2`,
        [page.rows.map((row) => row.user_id), revision],
      );
    await client.query(
      `update native_push_worker_cursors set user_id=$2,item_id=$4,available_at=case when $3::int=0 then now()+interval '1 day' else now() end where name=$1`,
      [name, page.rows.at(-1)?.user_id ?? null, page.rows.length, cycle],
    );
    return { scanned: page.rows.length, batchSize };
  });
}

/** Immutable continuations; replace empty/partial snapshots as soon as the
 * bounded leader set changes, while identical results retain the 5-minute cadence. */
export async function publishSocialTraderRanking(db: Pool) {
  const { policy } = await resolveSocialPolicy(db);
  const revision = buildSocialTraderStatisticsRevision(policy);
  return tx(db, async (client) => {
    const lock = await client.query<{ locked: boolean }>(
      `select pg_try_advisory_xact_lock(hashtextextended('social-trader-ranking',0)) as locked`,
    );
    if (!lock.rows[0]?.locked) return null;
    const leaders = await client.query<{
      user_id: string;
      statistics: unknown;
    }>(
      `select s.user_id,s.statistics from social_trader_statistics s join users u on u.id=s.user_id
      where s.policy_revision=$1 and s.win_rate is not null
        and u.is_active and u.handle is not null and u.social_suspended_at is null
      order by s.win_rate desc,(s.wins+s.losses) desc,s.user_id desc limit 1000`,
      [revision],
    );
    const recent = await client.query<{ id: string }>(
      `select id from social_trader_ranking_snapshots where policy_revision=$1 and created_at>now()-interval '5 minutes' order by created_at desc,id desc limit 1`,
      [revision],
    );
    if (recent.rows[0]) {
      const published = await client.query<{
        user_id: string;
        statistics: unknown;
      }>(
        `select user_id,statistics from social_trader_ranking_entries where snapshot_id=$1 order by rank limit 1000`,
        [recent.rows[0].id],
      );
      if (JSON.stringify(leaders.rows) === JSON.stringify(published.rows))
        return null;
    }
    // Lifecycle locks users before deleting their derived rows. Acquire all
    // publication FK owners in that same UUID order before inserting entries.
    const eligible = await client.query<{ id: string }>(
      `select u.id from users u where u.id=any($1::uuid[]) and u.is_active
       and u.handle is not null and u.social_suspended_at is null order by u.id for share of u`,
      [leaders.rows.map((row) => row.user_id)],
    );
    const eligibleIds = new Set(eligible.rows.map((row) => row.id));
    const entries = leaders.rows.filter((row) => eligibleIds.has(row.user_id));
    const { rows } = await client.query<{ id: string }>(
      `insert into social_trader_ranking_snapshots(policy_revision) values($1) returning id`,
      [revision],
    );
    const id = rows[0].id;
    await client.query(
      `insert into social_trader_ranking_entries(snapshot_id,rank,user_id,statistics)
       select $1,leader.rank,(leader.value->>'user_id')::uuid,leader.value->'statistics'
       from jsonb_array_elements($2::jsonb) with ordinality as leader(value,rank)`,
      [id, JSON.stringify(entries)],
    );
    return id;
  });
}

/** Explicit resumable skip-scan for pre-existing authors; no million-row migration backfill. */
export async function seedSocialTraderStatistics(
  db: DbQuery,
  after: string | null = null,
  batchSize = 100,
) {
  const { rows } = await db.query<{ author_id: string }>(
    `with recursive authors as (
    (select author_id from user_theses where author_id is not null and ($1::uuid is null or author_id>$1) order by author_id limit 1)
    union all select next.author_id from authors previous cross join lateral (
      select author_id from user_theses where author_id>previous.author_id order by author_id limit 1
    ) next
  ) select author_id from authors limit $2`,
    [after, Math.min(1000, batchSize)],
  );
  if (rows.length)
    await db.query(
      `with eligible as materialized (
        select u.id from users u where u.id=any($1::uuid[]) and u.is_active and u.social_suspended_at is null
        order by u.id for share of u
      ) insert into social_trader_statistics(user_id) select id from eligible on conflict do nothing`,
      [rows.map((row) => row.author_id)],
    );
  return { count: rows.length, after: rows.at(-1)?.author_id ?? after };
}

export async function seedNextSocialTraderStatisticsBatch(db: Pool) {
  return tx(db, async (client) => {
    await client.query(
      `insert into native_push_worker_cursors(name) values('trader-statistics-seed') on conflict do nothing`,
    );
    const { rows } = await client.query<{ user_id: string | null }>(
      `select user_id from native_push_worker_cursors where name='trader-statistics-seed' and available_at<=now() for update skip locked`,
    );
    if (!rows[0]) return 0;
    const seeded = await seedSocialTraderStatistics(client, rows[0].user_id);
    // Restart the next daily cycle so previously suspended authors and missing
    // derived rows behind the previous cursor can recover without a thesis write.
    await client.query(
      `update native_push_worker_cursors set user_id=$1,available_at=case when $2::int=0 then now()+interval '1 day' else now() end where name='trader-statistics-seed'`,
      [seeded.count === 0 ? null : seeded.after, seeded.count],
    );
    return seeded.count;
  });
}
