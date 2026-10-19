// @requires-db
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { nativeOnboardingDatabase } from "./native-onboarding-database-fixture.js";
import { createIntegrationTestPool } from "./test-database-target.js";
import {
  NativeNotificationPreferencesService,
  readNativePreferences,
} from "./services/native-notification-preferences.js";
import {
  enqueueNativePush,
  deliverNativePushBatch,
} from "./services/native-push-queue.js";
import {
  enqueueNativeMarketDigest,
  enqueueNativeBigMoves,
  fanoutNativePushEvent,
} from "./services/native-push-sources.js";
import {
  refreshSocialTraderStatistics,
  publishSocialTraderRanking,
  seedSocialTraderStatistics,
  seedNextSocialTraderStatisticsBatch,
  scheduleSocialTraderStatisticsPolicyRefresh,
} from "./services/social-trader-statistics.js";
import { retainNativeOnboardingData } from "./services/native-onboarding-retention.js";
import { SocialService } from "./services/social-service.js";
import { buildSocialTraderStatisticsRevision } from "./services/social-trader-statistics-policy.js";
import { DEFAULT_SOCIAL_POLICY } from "./services/social-policy.js";
import { drainPendingSocialTraderStatistics } from "./services/social-trader-statistics-pending.js";

const fixture = await nativeOnboardingDatabase(createIntegrationTestPool);
const { db } = fixture;
const id = (n: number) =>
  `a4000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const reports: object[] = [];
function literal(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (value instanceof Date) return `'${value.toISOString()}'`;
  if (Array.isArray(value)) {
    assert.ok(
      value.every(
        (item) =>
          typeof item === "string" &&
          (/^[0-9a-f-]{36}$/i.test(item) || /^\d+$/.test(item)),
      ),
    );
    return `'{${value.join(",")}}'`;
  }
  if (typeof value === "number") {
    assert.ok(Number.isFinite(value));
    return String(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  return `'${String(value).replaceAll("'", "''")}'`;
}
try {
  assert.equal(
    Math.floor(
      Number(
        (await db.query("show server_version_num")).rows[0].server_version_num,
      ) / 10000,
    ),
    16,
  );
  await db.query(
    `insert into users(id,handle) select ('a4000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'trader_'||n from generate_series(1,1000000)n`,
  );
  await db.query(
    `insert into user_sessions(id,user_id) select id,id from users where id<=$1`,
    [id(50000)],
  );
  await db.query(
    `insert into native_notification_preferences(user_id,enabled_at,new_markets_enabled_at,big_moves_enabled_at,big_moves,new_markets)
    select id,now()-interval '2 days',now()-interval '2 days',now()-interval '2 days',right(handle,2)='00',right(handle,1)='0' from users where id<=$1`,
    [id(100000)],
  );
  await db.query(
    `insert into native_push_devices(id,user_id,session_id,token,environment,authorization_status) select id,id,id,replace(id::text,'-',''),'sandbox','authorized' from users where id<=$1`,
    [id(50000)],
  );
  await db.query(
    `insert into user_follows(follower_user_id,followed_user_id,created_at) select id,$1,now()-interval '1 day' from users where id>$1 and id<=$2`,
    [id(1), id(200001)],
  );
  await db.query(
    `insert into user_follows(follower_user_id,followed_user_id,created_at) select id,$1,now()-interval '1 day' from users where id>$2 and id<=$3`,
    [id(10000), id(200001), id(400001)],
  );
  await db.query(`insert into unified_markets(id,event_id,venue,title,category,created_at,created_at_db)
    select 'kalshi:scale-'||n,'kalshi:event-'||n,'kalshi','Scale market '||n,'politics',now()-interval '12 hours',now()-interval '12 hours' from generate_series(1,100000)n`);
  await db.query(
    `insert into unified_tokens(token_id,market_id,venue,side) select 'token-'||n,'kalshi:scale-'||n,'kalshi','YES' from generate_series(1,100000)n`,
  );
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  await db.query(
    `insert into unified_markets(id,event_id,venue,title,created_at,created_at_db) values('polymarket:digest','polymarket:digest','polymarket','Daily fixture',$1,$1)`,
    [new Date(today.getTime() - 3_600_000)],
  );
  await db.query(
    `insert into unified_market_tokens(token_id,market_id,outcome_side) select token_id,market_id,'YES' from unified_tokens`,
  );
  await db.query(
    `insert into unified_token_top_latest(token_id,best_bid,best_ask) select token_id,0.69,0.71 from unified_tokens`,
  );
  await db.query(
    `insert into unified_token_change_24h(token_id,avg_mid_24h) select token_id,0.5 from unified_tokens`,
  );
  await db.query(`insert into positions(id,user_id,token_id,venue) select ('b4000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
    ('a4000000-0000-4000-8000-'||lpad((100*((n-1)%1000+1))::text,12,'0'))::uuid,'token-'||n,'kalshi' from generate_series(1,100000)n`);
  await db.query(`insert into user_theses(author_id,market_id,event_id,token_id,instrument_generation)
    select ('a4000000-0000-4000-8000-'||lpad((((n-1)%10000)+1)::text,12,'0'))::uuid,'kalshi:scale-'||n,'kalshi:event-'||n,'token-'||n,'solana:mainnet:token-'||n from generate_series(1,100000)n`);
  await db.query(
    `insert into social_trader_statistics(user_id,policy_revision,statistics,wins,losses,win_rate,computed_at,next_refresh_at)
    select id,$2,'{"wins":5,"losses":5,"winRate":"0.5","primaryCategory":"politics"}'::jsonb,5,5,0.5,now()-interval '2 hours',now()+interval '1 hour' from users where id<=$1
    on conflict(user_id) do update set policy_revision=excluded.policy_revision,statistics=excluded.statistics,wins=5,losses=5,win_rate=0.5,computed_at=now()-interval '2 hours',next_refresh_at=now()+interval '1 hour'`,
    [id(100000), buildSocialTraderStatisticsRevision(DEFAULT_SOCIAL_POLICY)],
  );
  await db.query(
    `update social_trader_statistics set win_rate=1,wins=10,losses=0,statistics='{"wins":10,"losses":0,"winRate":"1","primaryCategory":"politics"}' where user_id=$1`,
    [id(10000)],
  );
  await db.query(`insert into native_push_deliveries(device_id,user_id,device_generation,event_key,topic,occurred_at,payload)
    select d.id,d.user_id,d.generation,'scale:'||n,'market_resolution',now(),'{"aps":{"alert":{"title":"Test","body":"Fixture"}},"hunch":{}}'::jsonb
    from generate_series(1,100000)n join native_push_devices d on d.id=('a4000000-0000-4000-8000-'||lpad((((n-1)%50000)+1)::text,12,'0'))::uuid`);
  await db.query(`truncate social_trader_statistics_pending restart identity`);
  await db.query(
    `insert into social_trader_statistics_pending(user_id)
    select id from users where id<=$1`,
    [id(100000)],
  );
  for (const table of [
    "users",
    "user_sessions",
    "user_follows",
    "user_blocks",
    "native_notification_preferences",
    "native_push_devices",
    "native_push_events",
    "native_push_deliveries",
    "positions",
    "unified_markets",
    "unified_tokens",
    "unified_market_tokens",
    "unified_token_top_latest",
    "unified_token_change_24h",
    "user_theses",
    "social_trader_statistics",
    "social_trader_statistics_pending",
  ])
    await db.query(`analyze ${table}`);
  fixture.statements.clear();
  fixture.firstStatements.clear();
  await drainPendingSocialTraderStatistics(db);
  await drainPendingSocialTraderStatistics(db); // continued bounded queue page
  // Capture the statement executed inside the FK-free AFTER-trigger.
  for (const owner of [id(2), id(999999)]) {
    await db.query(
      `select 1 from users where id=$1 and is_active and social_suspended_at is null`,
      [owner],
    );
    await db.query(
      `insert into social_trader_statistics_pending(user_id) values($1)`,
      [owner],
    );
  }
  await db.query(
    `delete from social_trader_statistics_pending where user_id=$1`,
    [id(5000)],
  );
  const preferences = new NativeNotificationPreferencesService(db);
  const current = await readNativePreferences(db, id(100));
  await preferences.save(id(100), {
    ...current,
    bigMoves: false,
    expectedRevision: current.revision,
  });
  await preferences.register(id(100), id(100), id(100), {
    token: id(100).replaceAll("-", ""),
    environment: "sandbox",
    authorization: "authorized",
  });
  await enqueueNativePush(db, {
    userIds: [id(100)],
    eventKey: "scale:extra",
    topic: "market_resolution",
    occurredAt: new Date(),
    content: { title: "Fixture", body: "Fixture" },
  });
  await deliverNativePushBatch({
    db,
    send: async () => ({ status: 200, reason: null, invalidatedAt: null }),
  });
  await deliverNativePushBatch({
    db,
    send: async () => ({
      status: 503,
      reason: "Shutdown",
      invalidatedAt: null,
    }),
  });
  await deliverNativePushBatch({
    db,
    send: async () => ({
      status: 400,
      reason: "BadDeviceToken",
      invalidatedAt: null,
    }),
  });
  await fanoutNativePushEvent(db);
  const batchEnqueueStatements = [...fixture.statements].filter(
    ([sql]) =>
      sql.includes("select id from users where id=any") ||
      sql.includes("with devices as materialized"),
  );
  await fanoutNativePushEvent(db);
  await enqueueNativeMarketDigest(
    db,
    new Date(Math.max(Date.now(), today.getTime() + 13 * 3_600_000)),
  );
  await enqueueNativeBigMoves(db);
  await enqueueNativeBigMoves(db);
  await enqueueNativePush(db, {
    userIds: [id(999999)],
    eventKey: "scale:no-device",
    topic: "market_resolution",
    occurredAt: new Date(),
    content: { title: "Fixture", body: "No device" },
  });
  await db.query(
    `update native_push_worker_cursors set user_id=$1,item_id=null,available_at=now() where name='big-moves'`,
    [id(999999)],
  );
  await enqueueNativeBigMoves(db);
  await db.query(
    `update social_trader_statistics set next_refresh_at=now() where user_id=$1`,
    [id(1)],
  );
  const statisticsRevision = buildSocialTraderStatisticsRevision(
    DEFAULT_SOCIAL_POLICY,
  );
  // Policy transition: bounded first/resumed/empty pages and settled-cursor path.
  await db.query(
    `update social_trader_statistics set policy_revision='legacy-policy-hash' where user_id=$1`,
    [id(10)],
  );
  await scheduleSocialTraderStatisticsPolicyRefresh(db, statisticsRevision);
  await scheduleSocialTraderStatisticsPolicyRefresh(db, statisticsRevision);
  await db.query(
    `update native_push_worker_cursors set user_id=$1,available_at=now() where name='trader-statistics-policy'`,
    [id(999999)],
  );
  await scheduleSocialTraderStatisticsPolicyRefresh(db, statisticsRevision);
  await scheduleSocialTraderStatisticsPolicyRefresh(db, statisticsRevision);
  await scheduleSocialTraderStatisticsPolicyRefresh(
    db,
    "trader-statistics:v1:scale-policy-transition",
  );
  await scheduleSocialTraderStatisticsPolicyRefresh(db, statisticsRevision);
  await refreshSocialTraderStatistics(db, 1);
  await publishSocialTraderRanking(db);
  await publishSocialTraderRanking(db); // unchanged leaders keep their recent snapshot
  await db.query(
    `update social_trader_statistics set win_rate=0.7,wins=7,losses=3,statistics='{"wins":7,"losses":3,"winRate":"0.7","primaryCategory":"politics"}' where user_id=$1`,
    [id(1)],
  );
  await publishSocialTraderRanking(db); // changed/partially completed leaders publish immediately
  await seedSocialTraderStatistics(db, id(5000), 100);
  await seedNextSocialTraderStatisticsBatch(db);
  await db.query(
    `update native_push_worker_cursors set user_id=$1,available_at=now() where name='trader-statistics-seed'`,
    [id(999999)],
  );
  await seedNextSocialTraderStatisticsBatch(db); // empty tail resets the UUID
  await db.query(
    `update native_push_worker_cursors set available_at=now() where name='trader-statistics-seed'`,
  );
  await seedNextSocialTraderStatisticsBatch(db); // next cycle starts from null
  await retainNativeOnboardingData(db);
  const social = new SocialService(db);
  const first = await social.rankedProfiles(id(999999), { limit: 20 });
  assert.equal(first.items.length, 20);
  assert.ok(first.nextCursor);
  await social.rankedProfiles(id(999999), {
    limit: 20,
    cursor: first.nextCursor ?? undefined,
  });
  await social.listProfiles(id(999999), {
    kind: "followers",
    userId: id(1),
    limit: 20,
  });
  await preferences.unregister(id(100), id(100), id(100));
  const seen = new Set<string>();
  const captured = [
    ...fixture.firstStatements,
    ...fixture.statements,
    ...batchEnqueueStatements,
  ].filter(([sql, values]) => {
    const key = JSON.stringify([sql, values]);
    if (
      !/^(?:\s*)(?:select|with|insert|update|delete)\b/i.test(sql) ||
      seen.has(key)
    )
      return false;
    seen.add(key);
    return true;
  });
  const client = await fixture.pool.connect();
  try {
    await client.query("begin");
    await client.query(
      `insert into social_trader_statistics_pending(id,user_id) overriding system value select row_number() over(order by id),id from users where id<=$1 on conflict(id) do nothing`,
      [id(100000)],
    );
    await client.query(`analyze social_trader_statistics_pending`);
    for (const [index, [sql, values]] of captured.entries()) {
      const name = `native_scale_${index}`;
      await client.query(`prepare ${name} as ${sql}`);
      for (const mode of ["force_custom_plan", "force_generic_plan"]) {
        await client.query("savepoint explain_native");
        await client.query(`set local plan_cache_mode=${mode}`);
        if (/insert into social_trader_ranking_entries/i.test(sql)) {
          await client.query(
            `delete from social_trader_ranking_entries where snapshot_id=$1`,
            [values[0]],
          );
        }
        const execute = `execute ${name}${values.length ? `(${values.map(literal).join(",")})` : ""}`;
        const result = await client.query(
          `explain(analyze,buffers,format json) ${execute}`,
        );
        const plan = result.rows[0]["QUERY PLAN"][0];
        reports.push({
          sql,
          mode,
          executionMs: plan["Execution Time"],
          planningMs: plan["Planning Time"],
          plan: plan.Plan,
        });
        assert.ok(
          plan["Execution Time"] < 2_000,
          `bounded native SQL exceeded 2s: ${sql.slice(0, 100)}`,
        );
        await client.query("rollback to savepoint explain_native");
        await client.query("release savepoint explain_native");
      }
      await client.query(`deallocate ${name}`);
    }
    const leaderQuery = captured.find(([sql]) =>
      sql.includes(
        "select s.user_id,s.statistics from social_trader_statistics",
      ),
    );
    assert.ok(leaderQuery, "the final bounded leader query is captured");
    await client.query("savepoint sparse_rankings");
    await client.query(`update users set is_active=false where id<=$1`, [
      id(99990),
    ]);
    await client.query("analyze users");
    await client.query(`prepare sparse_ranking as ${leaderQuery[0]}`);
    for (const [scenario, revision] of [
      [
        "sparse_inactive_leaders",
        buildSocialTraderStatisticsRevision(DEFAULT_SOCIAL_POLICY),
      ],
      ["empty_policy_leaders", "trader-statistics:v1:empty-scale-policy"],
    ]) {
      for (const mode of ["force_custom_plan", "force_generic_plan"]) {
        await client.query(`set local plan_cache_mode=${mode}`);
        const result = await client.query(
          `explain(analyze,buffers,format json) execute sparse_ranking(${literal(revision)})`,
        );
        const plan = result.rows[0]["QUERY PLAN"][0];
        reports.push({
          sql: leaderQuery[0],
          scenario,
          mode,
          executionMs: plan["Execution Time"],
          planningMs: plan["Planning Time"],
          plan: plan.Plan,
        });
        assert.ok(
          plan["Execution Time"] < 2_000,
          `sparse ranking SQL exceeded 2s: ${scenario}`,
        );
      }
    }
    await client.query("deallocate sparse_ranking");
    await client.query("rollback to savepoint sparse_rankings");
    await client.query("release savepoint sparse_rankings");
    await client.query("savepoint empty_pending");
    await client.query(`delete from social_trader_statistics_pending`);
    const pendingRead = captured.find(([sql]) =>
      sql.startsWith("select id,user_id from social_trader_statistics_pending"),
    );
    assert.ok(pendingRead, "pending drain SQL is captured");
    await client.query(`prepare empty_pending_page as ${pendingRead[0]}`);
    for (const mode of ["force_custom_plan", "force_generic_plan"]) {
      await client.query(`set local plan_cache_mode=${mode}`);
      const result = await client.query(
        `explain(analyze,buffers,format json) execute empty_pending_page(100)`,
      );
      const plan = result.rows[0]["QUERY PLAN"][0];
      reports.push({
        sql: pendingRead[0],
        scenario: "empty_pending_page",
        mode,
        executionMs: plan["Execution Time"],
        planningMs: plan["Planning Time"],
        plan: plan.Plan,
      });
      assert.ok(plan["Execution Time"] < 2_000);
    }
    await client.query("deallocate empty_pending_page");
    await client.query("rollback to savepoint empty_pending");
    await client.query("release savepoint empty_pending");
    await client.query("rollback");
  } finally {
    await client.query("rollback");
    client.release();
  }
  await writeFile(
    new URL(
      "../../../docs/verification/native-onboarding-sql-scale.json",
      import.meta.url,
    ),
    JSON.stringify(
      {
        postgres: 16,
        users: 1000000,
        profiles: 100000,
        theses: 100000,
        positions: 100000,
        followers: 400000,
        devices: 50000,
        queuedDeliveries: 100000,
        pendingStatistics: 100000,
        plans: reports,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    `native onboarding scale: ${reports.length} custom/generic SQL plans checked on one million users`,
  );
} finally {
  await fixture.close();
}
