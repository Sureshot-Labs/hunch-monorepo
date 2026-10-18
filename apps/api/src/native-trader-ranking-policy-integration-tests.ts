// @requires-db
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Pool } from "@hunch/infra";
import { nativeOnboardingDatabase } from "./native-onboarding-database-fixture.js";
import { createIntegrationTestPool } from "./test-database-target.js";
import { SocialService } from "./services/social-service.js";
import {
  publishSocialTraderRanking,
  refreshSocialTraderStatistics,
  scheduleSocialTraderStatisticsPolicyRefresh,
  seedSocialTraderStatistics,
} from "./services/social-trader-statistics.js";
import { buildSocialTraderStatisticsRevision } from "./services/social-trader-statistics-policy.js";
import {
  buildSocialPolicyRevision,
  DEFAULT_SOCIAL_POLICY,
} from "./services/social-policy.js";

const fixture = await nativeOnboardingDatabase(createIntegrationTestPool);
const { db, pool } = fixture;
const service = new SocialService(db);
const viewer = randomUUID();
const authors = [1, 2, 3].map(
  (value) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`,
);
const defaultRevision = buildSocialTraderStatisticsRevision(
  DEFAULT_SOCIAL_POLICY,
);
async function setPolicy(payload: Record<string, unknown>) {
  await db.query(`delete from runtime_policies where policy_key='social'`);
  await db.query(
    `insert into runtime_policies(policy_key,payload,effective_at) values('social',$1,now())`,
    [payload],
  );
}
async function addThesis(
  author: string,
  name: string,
  resolved: "YES" | "NO" = "YES",
  age = "0 days",
) {
  const market = `kalshi:ranking_${name}`;
  const token = `ranking_yes_${name}`;
  await db.query(
    `insert into unified_markets(id,event_id,venue,title,category,resolved_outcome) values($1,$1,'kalshi','Rank test','politics',$2)`,
    [market, resolved],
  );
  await db.query(
    `insert into unified_tokens(token_id,market_id,side,venue) values($1,$2,'YES','kalshi')`,
    [token, market],
  );
  await db.query(
    `insert into user_theses(author_id,market_id,event_id,token_id,instrument_generation,published_at) values($1,$2,$2,$3,$4,now()-$5::interval)`,
    [author, market, token, `solana:mainnet:${token}`, age],
  );
}
async function cached(author: string) {
  return (
    await db.query(`select * from social_trader_statistics where user_id=$1`, [
      author,
    ])
  ).rows[0];
}
function pauseNextStore() {
  let reached!: () => void;
  let release!: () => void;
  const paused = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const resumed = new Promise<void>((resolve) => {
    release = resolve;
  });
  let waiting = true;
  const wrapped = {
    ...db,
    async query(sql: string, values: unknown[] = []) {
      if (
        waiting &&
        sql.startsWith("update social_trader_statistics set policy_revision=")
      ) {
        waiting = false;
        reached();
        await resumed;
      }
      return db.query(sql, values);
    },
  } as unknown as Pool;
  return { db: wrapped, paused, release };
}
async function onlyDue(author: string) {
  await db.query(
    `update social_trader_statistics set next_refresh_at=now()+interval '1 hour'`,
  );
  await db.query(
    `update social_trader_statistics set next_refresh_at=now() where user_id=$1`,
    [author],
  );
}
try {
  assert.equal(
    Math.floor(
      Number(
        (await db.query(`show server_version_num`)).rows[0].server_version_num,
      ) / 10000,
    ),
    16,
  );
  await db.query(`insert into users(id,handle) values($1,'reader')`, [viewer]);
  for (const [index, author] of authors.entries()) {
    await db.query(`insert into users(id,handle) values($1,$2)`, [
      author,
      `rank_${index}`,
    ]);
    await addThesis(
      author,
      `initial_${index}`,
      index === 2 ? "NO" : "YES",
      "2 days",
    );
  }
  assert.equal(await refreshSocialTraderStatistics(db), 3);
  for (const author of authors)
    assert.deepEqual(
      (await cached(author)).statistics,
      await service.profileStatistics(author),
    );
  await publishSocialTraderRanking(db);
  const first = await service.rankedProfiles(viewer, { limit: 1 });
  assert.equal(first.items.length, 1);
  assert.ok(first.nextCursor);
  const leader = first.items[0].id;
  assert.ok(
    (await service.listProfiles(viewer, { kind: "suggestions" })).items.find(
      (row) => row.id === leader,
    )?.statistics,
  );
  await setPolicy({ commentRateLimit: 21 });
  assert.equal(
    await refreshSocialTraderStatistics(db),
    0,
    "unrelated policy does not recalculate statistics",
  );
  assert.equal(
    await publishSocialTraderRanking(db),
    null,
    "unchanged leader content retains snapshot",
  );
  assert.equal(
    (await service.rankedProfiles(viewer, { limit: 1 })).items[0]?.id,
    leader,
    "unrelated policy retains leadership",
  );
  const continuation = await service.rankedProfiles(viewer, {
    limit: 1,
    cursor: first.nextCursor ?? undefined,
  });
  assert.equal(
    continuation.items.length,
    1,
    "unrelated policy retains cursor scope",
  );
  assert.ok(
    (await service.listProfiles(viewer, { kind: "suggestions" })).items.find(
      (row) => row.id === leader,
    )?.statistics,
    "unrelated policy retains list statistics",
  );
  console.log(
    "unrelated policy preserves ranks, compact statistics and continuation",
  );

  await setPolicy({ profileStatsMinResolved: 2 });
  await assert.rejects(
    service.rankedProfiles(viewer, { cursor: first.nextCursor ?? undefined }),
    { code: "invalid_cursor" },
  );
  await publishSocialTraderRanking(db);
  assert.equal(
    (await service.rankedProfiles(viewer, {})).items.length,
    0,
    "new rules never expose old statistics",
  );
  assert.equal(
    await refreshSocialTraderStatistics(db),
    3,
    "policy mismatch bypasses ordinary due time",
  );
  for (const author of authors)
    assert.equal((await cached(author)).win_rate, null);
  assert.equal(
    (await service.listProfiles(viewer, { kind: "suggestions" })).items.find(
      (row) => row.id === leader,
    )?.statistics?.winRate,
    null,
  );
  await addThesis(authors[0], "second_win");
  assert.equal(await refreshSocialTraderStatistics(db), 1);
  assert.ok(
    await publishSocialTraderRanking(db),
    "new result replaces empty snapshot immediately",
  );
  assert.equal(
    (await service.rankedProfiles(viewer, {})).items[0]?.id,
    authors[0],
  );
  await setPolicy({ profileStatsWindowDays: 1, profileStatsMinResolved: 2 });
  assert.equal(await refreshSocialTraderStatistics(db), 3);
  await publishSocialTraderRanking(db);
  assert.equal(
    (await service.rankedProfiles(viewer, {})).items.length,
    0,
    "window excludes old groups",
  );
  assert.equal((await cached(authors[0])).statistics.totalGroups, 1);
  await setPolicy({ profileStatsWindowDays: 1 });
  assert.equal(await refreshSocialTraderStatistics(db), 3);
  await publishSocialTraderRanking(db);
  assert.equal((await service.rankedProfiles(viewer, {})).items.length, 1);
  await setPolicy({});
  assert.equal(
    await refreshSocialTraderStatistics(db),
    3,
    "reverting a completed policy scan starts immediately",
  );
  await publishSocialTraderRanking(db);
  assert.equal((await service.rankedProfiles(viewer, {})).items.length, 3);
  assert.equal(
    (await cached(authors[2])).statistics.winRate,
    "0",
    "zero win rate remains rank eligible",
  );
  console.log(
    "minimum/window changes recover promptly, including policy reversion and zero win rate",
  );

  // Real legacy rows carry the old full-policy hash, with an ordinary due time in the future.
  await db.query(
    `update social_trader_statistics set policy_revision=$1,computed_at=now()-interval '2 hours',next_refresh_at=now()+interval '1 hour'`,
    [buildSocialPolicyRevision(DEFAULT_SOCIAL_POLICY)],
  );
  await db.query(
    `delete from native_push_worker_cursors where name='trader-statistics-policy'`,
  );
  await db.query(`delete from social_trader_ranking_snapshots`);
  await publishSocialTraderRanking(db);
  assert.equal((await service.rankedProfiles(viewer, {})).items.length, 0);
  assert.equal(
    (await scheduleSocialTraderStatisticsPolicyRefresh(db, defaultRevision, 1))
      .scanned,
    1,
  );
  assert.equal(
    (await scheduleSocialTraderStatisticsPolicyRefresh(db, defaultRevision, 1))
      .scanned,
    1,
  );
  assert.equal(
    (await scheduleSocialTraderStatisticsPolicyRefresh(db, defaultRevision, 1))
      .scanned,
    1,
  );
  assert.equal(
    (await scheduleSocialTraderStatisticsPolicyRefresh(db, defaultRevision, 1))
      .scanned,
    0,
  );
  assert.equal(
    (await scheduleSocialTraderStatisticsPolicyRefresh(db, defaultRevision, 1))
      .scanned,
    0,
  );
  assert.equal(await refreshSocialTraderStatistics(db, 1), 1);
  assert.ok(await publishSocialTraderRanking(db));
  assert.equal(
    (await service.rankedProfiles(viewer, {})).items.length,
    1,
    "first partial result recovers immediately",
  );
  assert.equal(await refreshSocialTraderStatistics(db, 1), 1);
  const concurrent = await Promise.all([
    publishSocialTraderRanking(db),
    publishSocialTraderRanking(db),
  ]);
  assert.equal(
    concurrent.filter(Boolean).length,
    1,
    "concurrent publication creates one new snapshot",
  );
  assert.equal(
    (await service.rankedProfiles(viewer, {})).items.length,
    2,
    "partial snapshot grows before5min",
  );
  assert.equal(await refreshSocialTraderStatistics(db, 1), 1);
  await publishSocialTraderRanking(db);
  await db.query(
    `update social_trader_statistics set computed_at=now()-interval '2 hours'`,
  );
  assert.equal(
    (await service.rankedProfiles(viewer, {})).items.length,
    3,
    "age alone never drops compatible leaders",
  );
  console.log(
    "legacy rows, bounded first/resumed/empty scan and partial/concurrent snapshots recover",
  );

  await onlyDue(authors[0]);
  const dirtyGate = pauseNextStore();
  const dirtyRefresh = refreshSocialTraderStatistics(dirtyGate.db);
  await dirtyGate.paused;
  await addThesis(authors[0], "dirty_win");
  dirtyGate.release();
  assert.equal(await dirtyRefresh, 1);
  assert.ok(
    new Date((await cached(authors[0])).next_refresh_at).getTime() <=
      Date.now(),
    "dirty during computation stays due",
  );
  assert.equal(await refreshSocialTraderStatistics(db), 1);
  assert.deepEqual(
    (await cached(authors[0])).statistics,
    await service.profileStatistics(authors[0]),
  );

  await onlyDue(authors[0]);
  const leaseGate = pauseNextStore();
  const oldRefresh = refreshSocialTraderStatistics(leaseGate.db);
  await leaseGate.paused;
  await db.query(
    `update social_trader_statistics set lease_until=now()-interval '1 second' where user_id=$1`,
    [authors[0]],
  );
  await addThesis(authors[0], "reclaimed_win");
  assert.equal(await refreshSocialTraderStatistics(db), 1);
  const reclaimed = await cached(authors[0]);
  leaseGate.release();
  await oldRefresh;
  assert.deepEqual(
    (await cached(authors[0])).statistics,
    reclaimed.statistics,
    "late old lease never overwrites reclaimed result",
  );
  assert.equal((await cached(authors[0])).lease_id, null);
  assert.deepEqual(
    reclaimed.statistics,
    await service.profileStatistics(authors[0]),
  );
  console.log(
    "dirty refresh and reclaimed lease preserve the exact profile computation",
  );

  await onlyDue(authors[0]);
  const policyGate = pauseNextStore();
  const oldPolicyRefresh = refreshSocialTraderStatistics(policyGate.db);
  await policyGate.paused;
  await setPolicy({ profileStatsMinResolved: 999 });
  assert.equal(
    await refreshSocialTraderStatistics(db),
    2,
    "new policy does not steal an active lease",
  );
  policyGate.release();
  await oldPolicyRefresh;
  assert.ok(
    new Date((await cached(authors[0])).next_refresh_at).getTime() <=
      Date.now(),
  );
  assert.equal(
    (await service.listProfiles(viewer, { kind: "suggestions" })).items.find(
      (row) => row.id === authors[0],
    )?.statistics,
    null,
    "old policy result never passes current list fencing",
  );
  await publishSocialTraderRanking(db);
  assert.equal((await service.rankedProfiles(viewer, {})).items.length, 0);
  assert.equal(
    await refreshSocialTraderStatistics(db),
    1,
    "in-flight old policy calculation stays due for recovery",
  );
  assert.deepEqual(
    (await cached(authors[0])).statistics,
    await service.profileStatistics(authors[0]),
  );
  await setPolicy({});
  assert.equal(await refreshSocialTraderStatistics(db), 3);
  await publishSocialTraderRanking(db);
  console.log(
    "policy change during calculation fences old results and recovers",
  );

  // Live filters apply on every continuation, independently of immutable ranks.
  const visible = await service.rankedProfiles(viewer, { limit: 1 });
  assert.ok(visible.nextCursor);
  const followingPage = await service.rankedProfiles(viewer, {
    limit: 2,
    cursor: visible.nextCursor ?? undefined,
  });
  const blocked = followingPage.items[0].id;
  await db.query(
    `insert into user_blocks(blocker_user_id,blocked_user_id) values($1,$2)`,
    [viewer, blocked],
  );
  assert.ok(
    !(await service.rankedProfiles(viewer, { limit: 3 })).items.some(
      (row) => row.id === blocked,
    ),
  );
  await db.query(`update users set social_suspended_at=now() where id=$1`, [
    authors[2],
  ]);
  assert.ok(
    !(await service.rankedProfiles(viewer, { limit: 3 })).items.some(
      (row) => row.id === authors[2],
    ),
  );
  assert.ok(
    !(await service.rankedProfiles(authors[0], { limit: 3 })).items.some(
      (row) => row.id === authors[0],
    ),
  );
  await db.query(`update users set is_active=false where id=$1`, [authors[0]]);
  assert.ok(
    !(await service.rankedProfiles(viewer, { limit: 3 })).items.some(
      (row) => row.id === authors[0],
    ),
  );
  await db.query(
    `delete from social_trader_statistics where user_id=any($1::uuid[])`,
    [[authors[0], authors[2]]],
  );
  await seedSocialTraderStatistics(db);
  assert.equal(
    await cached(authors[0]),
    undefined,
    "seed never revives an inactive account cache",
  );
  assert.equal(
    await cached(authors[2]),
    undefined,
    "seed never revives a suspended account cache",
  );
  // The seeder must wait for lifecycle's user lock, recheck active state and
  // not recreate the just-cleared derived row after a concurrent soft delete.
  const lifecycle = await pool.connect();
  let seeded: Promise<unknown> | undefined;
  let publishedDuringCleanup: Promise<unknown> | undefined;
  try {
    await lifecycle.query("begin");
    const pid = (await lifecycle.query(`select pg_backend_pid() as pid`))
      .rows[0].pid;
    await lifecycle.query(`select id from users where id=$1 for update`, [
      authors[1],
    ]);
    await lifecycle.query(`update users set is_active=false where id=$1`, [
      authors[1],
    ]);
    await lifecycle.query(
      `delete from social_trader_statistics where user_id=$1`,
      [authors[1]],
    );
    await lifecycle.query(
      `delete from social_trader_ranking_entries where user_id=$1`,
      [authors[1]],
    );
    seeded = seedSocialTraderStatistics(db);
    publishedDuringCleanup = publishSocialTraderRanking(db);
    let waiting = false;
    for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
      waiting = Boolean(
        (
          await db.query(
            `select 1 from pg_stat_activity where $1::int=any(pg_blocking_pids(pid))
             and (query like '%with eligible as materialized%' or query like '%select u.id from users u where u.id=any%')`,
            [pid],
          )
        ).rows.length === 2,
      );
    }
    assert.ok(
      waiting,
      "seed and publisher reached lifecycle's user-lock barriers",
    );
    await lifecycle.query("commit");
    await seeded;
    await publishedDuringCleanup;
    assert.equal(
      (
        await db.query(
          `select 1 from social_trader_ranking_entries where user_id=$1`,
          [authors[1]],
        )
      ).rows.length,
      0,
      "publication rechecks inactive state after lifecycle commits",
    );
    assert.equal(
      await cached(authors[1]),
      undefined,
      "seed rechecks inactive state after lifecycle commits",
    );
  } finally {
    await lifecycle.query("rollback");
    lifecycle.release();
    await seeded;
    await publishedDuringCleanup;
  }
  await db.query(
    `update social_trader_ranking_snapshots set created_at=now()-interval '2 hours'`,
  );
  await assert.rejects(
    service.rankedProfiles(viewer, { cursor: visible.nextCursor ?? undefined }),
    { code: "trader_ranking_expired" },
  );
  console.log(
    "snapshot continuation/expiry and self/block/inactive/suspended filters pass",
  );
} finally {
  await fixture.close();
}
