// @requires-db
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { nativeOnboardingDatabase } from "./native-onboarding-database-fixture.js";
import {
  NativeNotificationPreferencesService,
  readNativePreferences,
} from "./services/native-notification-preferences.js";
import {
  enqueueNativePush,
  deliverNativePushBatch,
} from "./services/native-push-queue.js";
import {
  fanoutNativePushEvent,
  enqueueNativeBigMoves,
  enqueueNativeMarketDigest,
} from "./services/native-push-sources.js";
import {
  refreshSocialTraderStatistics,
  publishSocialTraderRanking,
  seedSocialTraderStatistics,
} from "./services/social-trader-statistics.js";
import { SocialService } from "./services/social-service.js";
import { createIntegrationTestPool } from "./test-database-target.js";

const fixture = await nativeOnboardingDatabase(createIntegrationTestPool);
const { db } = fixture;
const service = new NativeNotificationPreferencesService(db);
const user = randomUUID(),
  other = randomUUID(),
  author = randomUUID();
const session = randomUUID(),
  otherSession = randomUUID(),
  device = randomUUID();
const token = "ab".repeat(32);
const accepted = { status: 200, reason: null, invalidatedAt: null };
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
    `insert into users(id,handle) values($1,'reader'),($2,'other'),($3,'author')`,
    [user, other, author],
  );
  await db.query(
    `insert into user_sessions(id,user_id) values($1,$2),($3,$4)`,
    [session, user, otherSession, other],
  );
  const defaults = await readNativePreferences(db, user);
  assert.equal(defaults.revision, 0);
  const preferences = await service.save(user, {
    ...defaults,
    expectedRevision: 0,
    bigMoves: true,
  });
  assert.equal(preferences.revision, 1);
  assert.equal(
    (await service.save(user, { ...preferences, expectedRevision: 0 }))
      .revision,
    1,
    "accepted retry is idempotent",
  );
  await assert.rejects(
    service.save(user, { ...preferences, enabled: false, expectedRevision: 0 }),
    { code: "notification_preferences_conflict" },
  );
  await service.register(user, session, device, {
    token,
    environment: "sandbox",
    authorization: "authorized",
  });
  // JS timestamps truncate PostgreSQL microseconds. These events are explicitly
  // after the completed preference write, rather than in its preceding fraction.
  const content = { title: "Position resolved", body: "Your market resolved" };
  await enqueueNativePush(db, {
    userIds: [user],
    eventKey: "test:one",
    topic: "market_resolution",
    occurredAt: new Date(Date.now() + 1),
    content,
  });
  await enqueueNativePush(db, {
    userIds: [user],
    eventKey: "test:one",
    topic: "market_resolution",
    occurredAt: new Date(Date.now() + 1),
    content,
  });
  let sends = 0;
  const results = await Promise.all(
    [1, 2].map(() =>
      deliverNativePushBatch({
        db,
        send: async () => {
          sends++;
          return accepted;
        },
      }),
    ),
  );
  assert.equal(sends, 1, "concurrent delivery workers claim once");
  assert.equal(
    results.reduce((sum, row) => sum + row.sent, 0),
    1,
  );

  await enqueueNativePush(db, {
    userIds: [user],
    eventKey: "test:optout",
    topic: "market_resolution",
    occurredAt: new Date(Date.now() + 1),
    content,
  });
  const saved = await service.save(user, {
    ...preferences,
    marketResolution: false,
    expectedRevision: 1,
  });
  await deliverNativePushBatch({
    db,
    send: async () => {
      throw new Error("Opted-out notification reached APNs");
    },
  });
  assert.equal(
    (
      await db.query(
        `select status from native_push_deliveries where event_key='test:optout'`,
      )
    ).rows[0].status,
    "skipped",
  );
  await service.save(user, {
    ...saved,
    marketResolution: true,
    expectedRevision: saved.revision,
  });

  await enqueueNativePush(db, {
    userIds: [user],
    eventKey: "test:reassign",
    topic: "market_resolution",
    occurredAt: new Date(Date.now() + 1),
    content,
  });
  await service.register(other, otherSession, device, {
    token,
    environment: "sandbox",
    authorization: "authorized",
  });
  const reassigned = await deliverNativePushBatch({
    db,
    send: async () => {
      throw new Error("Old account notification reached new device owner");
    },
  });
  assert.equal(reassigned.skipped, 1);
  await service.register(user, session, device, {
    token,
    environment: "sandbox",
    authorization: "authorized",
  });
  await enqueueNativePush(db, {
    userIds: [user],
    eventKey: "test:logout",
    topic: "market_resolution",
    occurredAt: new Date(Date.now() + 1),
    content,
  });
  await db.query(`update user_sessions set is_active=false where id=$1`, [
    session,
  ]);
  assert.equal(
    (await deliverNativePushBatch({ db, send: async () => accepted })).skipped,
    1,
  );
  await db.query(`update user_sessions set is_active=true where id=$1`, [
    session,
  ]);
  await enqueueNativePush(db, {
    userIds: [user],
    eventKey: "test:expired-session",
    topic: "market_resolution",
    occurredAt: new Date(Date.now() + 1),
    content,
  });
  await db.query(
    `update user_sessions set expires_at=now()-interval '1 second' where id=$1`,
    [session],
  );
  assert.equal(
    (
      await deliverNativePushBatch({
        db,
        send: async () => {
          throw new Error("Expired session reached APNs");
        },
      })
    ).skipped,
    1,
  );
  await db.query(
    `update user_sessions set expires_at=now()+interval '1 day' where id=$1`,
    [session],
  );

  await enqueueNativePush(db, {
    userIds: [user],
    eventKey: "test:retry",
    topic: "market_resolution",
    occurredAt: new Date(Date.now() + 1),
    content,
  });
  assert.equal(
    (
      await deliverNativePushBatch({
        db,
        send: async () => ({
          status: 503,
          reason: "Shutdown",
          invalidatedAt: null,
        }),
      })
    ).retry,
    1,
  );
  await db.query(
    `update native_push_deliveries set available_at=now() where event_key='test:retry'`,
  );
  assert.equal(
    (await deliverNativePushBatch({ db, send: async () => accepted })).sent,
    1,
  );

  await db.query(`insert into unified_markets(id,event_id,venue,title,category,resolved_outcome) values
    ('kalshi:test','kalshi:event','kalshi','Test market','politics','YES')`);
  await db.query(
    `insert into unified_tokens(token_id,market_id,side,venue) values('yes-test','kalshi:test','YES','kalshi')`,
  );
  await db.query(
    `insert into unified_market_tokens(token_id,market_id,outcome_side) values('yes-test','kalshi:test','YES')`,
  );
  await db.query(
    `insert into user_follows(follower_user_id,followed_user_id,created_at) values($1,$2,now()-interval '1 day')`,
    [user, author],
  );
  const thesis = randomUUID();
  await db.query(
    `insert into user_theses(id,author_id,market_id,event_id,token_id,instrument_generation) values($1,$2,'kalshi:test','kalshi:event','yes-test','solana:mainnet:yes-test')`,
    [thesis, author],
  );
  assert.equal(await fanoutNativePushEvent(db), true);
  const followed = (
    await db.query(
      `select payload from native_push_deliveries where event_key=$1`,
      [`thesis:${thesis}`],
    )
  ).rows;
  assert.equal(followed.length, 1);
  assert.equal(followed[0].payload.hunch.userId, user);
  await db.query(
    `insert into user_blocks(blocker_user_id,blocked_user_id) values($1,$2)`,
    [user, author],
  );
  assert.equal(
    (
      await deliverNativePushBatch({
        db,
        send: async () => {
          throw new Error("Blocked author reached APNs");
        },
      })
    ).skipped,
    1,
  );
  await db.query(`delete from user_blocks`);

  await db.query(
    `insert into notifications(user_id,type,title,body,data) values($1,'position_resolved','Resolved','Your result',$2)`,
    [user, JSON.stringify({ marketId: "kalshi:test" })],
  );
  assert.equal(await fanoutNativePushEvent(db), true);
  assert.equal(
    (
      await deliverNativePushBatch({
        db,
        send: async (input) => {
          assert.equal(
            (input.payload.hunch as { eventId: string }).eventId,
            "kalshi:event",
          );
          return accepted;
        },
      })
    ).sent,
    1,
  );

  await db.query(
    `insert into positions(user_id,token_id,venue) values($1,'yes-test','kalshi')`,
    [user],
  );
  await db.query(
    `insert into unified_token_top_latest(token_id,best_bid,best_ask) values('yes-test',0.69,0.71)`,
  );
  await db.query(
    `insert into unified_token_change_24h(token_id,avg_mid_24h) values('yes-test',0.5)`,
  );
  await db.query(
    `update unified_markets set resolved_outcome=null where id='kalshi:test'`,
  );
  assert.equal(await enqueueNativeBigMoves(db), true);
  assert.equal(
    (
      await db.query(
        `select count(*)::int n from native_push_deliveries where topic='big_moves'`,
      )
    ).rows[0].n,
    1,
  );
  await db.query(
    `update native_push_worker_cursors set user_id=null,item_id=null,available_at=now() where name='big-moves'`,
  );
  await enqueueNativeBigMoves(db, new Date(Date.now() + 3_600_000));
  assert.equal(
    (
      await db.query(
        `select count(*)::int n from native_push_deliveries where topic='big_moves'`,
      )
    ).rows[0].n,
    1,
    "24h cooldown survives source polling",
  );

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  await db.query(
    `update native_notification_preferences set enabled_at=$2,new_markets_enabled_at=$2 where user_id=$1`,
    [user, new Date(today.getTime() - 2 * 86_400_000)],
  );
  await db.query(
    `insert into unified_markets(id,event_id,venue,title,created_at,created_at_db) values('polymarket:new','polymarket:event','polymarket','New market',$1,$1)`,
    [new Date(today.getTime() - 3_600_000)],
  );
  const digestTime = new Date(
    Math.max(Date.now(), today.getTime() + 13 * 3_600_000),
  );
  assert.equal(
    await enqueueNativeMarketDigest(
      db,
      new Date(today.getTime() + 11 * 3_600_000),
    ),
    false,
    "daily digest waits until noon UTC",
  );
  assert.equal(await enqueueNativeMarketDigest(db, digestTime), true);
  await enqueueNativeMarketDigest(db, digestTime);
  assert.equal(
    (
      await db.query(
        `select count(*)::int n from native_push_deliveries where topic='new_markets'`,
      )
    ).rows[0].n,
    1,
  );

  await db.query(
    `update unified_markets set resolved_outcome='YES' where id='kalshi:test'`,
  );
  assert.equal((await seedSocialTraderStatistics(db)).count, 1);
  assert.equal(await refreshSocialTraderStatistics(db), 1);
  const social = new SocialService(db);
  const profile = await social.profileStatistics(author);
  assert.equal(profile.winRate, "1");
  const cache = (
    await db.query(
      `select statistics from social_trader_statistics where user_id=$1`,
      [author],
    )
  ).rows[0].statistics;
  assert.deepEqual(cache, profile);
  await publishSocialTraderRanking(db);
  const ranking = await social.rankedProfiles(user, { limit: 1 });
  assert.equal(ranking.items[0]?.id, author);
  assert.equal(ranking.items[0]?.statistics?.winRate, "1");
  const suggestions = await social.listProfiles(user, {
    kind: "followers",
    userId: author,
  });
  assert.equal(suggestions.items[0]?.id, user);
  await db.query(`update users set is_active=false where id=$1`, [author]);
  assert.equal((await social.rankedProfiles(user, {})).items.length, 0);
  await db.query(`delete from users where id=$1`, [author]);
  assert.equal(
    (
      await db.query(
        `select count(*)::int n from social_trader_statistics where user_id=$1`,
        [author],
      )
    ).rows[0].n,
    0,
    "deleting an author does not recreate their statistics",
  );
  console.log("native onboarding PostgreSQL integration: passed");
} finally {
  await fixture.close();
}
