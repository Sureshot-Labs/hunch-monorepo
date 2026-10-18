// @requires-db
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
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
import { enqueueNativeBigMoves } from "./services/native-push-sources.js";
import { retainNativeOnboardingData } from "./services/native-onboarding-retention.js";
import { publishSocialTraderRanking } from "./services/social-trader-statistics.js";
import { SocialService } from "./services/social-service.js";
import { buildSocialTraderStatisticsRevision } from "./services/social-trader-statistics-policy.js";
import { DEFAULT_SOCIAL_POLICY } from "./services/social-policy.js";

const fixture = await nativeOnboardingDatabase(createIntegrationTestPool);
const { db, pool } = fixture;
const service = new NativeNotificationPreferencesService(db);
const a = randomUUID(),
  b = randomUUID(),
  sa = randomUUID(),
  sb = randomUUID(),
  renewed = randomUUID(),
  device = randomUUID();
const registration = {
  token: "ab".repeat(32),
  environment: "sandbox" as const,
  authorization: "authorized" as const,
};

async function waitForLock(blocker: number) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const result = await pool.query(
      `select 1 from pg_stat_activity where $1::int=any(pg_blocking_pids(pid))`,
      [blocker],
    );
    if (result.rows.length) return;
    await delay(10);
  }
  throw new Error("Expected concurrent request to wait on the database lock");
}

try {
  await db.query(
    `insert into users(id,handle) values($1,'reader_a'),($2,'reader_b')`,
    [a, b],
  );
  await db.query(
    `insert into user_sessions(id,user_id) values($1,$2),($3,$4),($5,$2)`,
    [sa, a, sb, b, renewed],
  );
  for (const userId of [a, b]) {
    const defaults = await readNativePreferences(db, userId);
    await service.save(userId, {
      ...defaults,
      expectedRevision: 0,
      bigMoves: true,
    });
  }
  await service.register(a, sa, device, registration);

  // The request has passed middleware but is waiting for an account write.
  const blocker = await pool.connect();
  try {
    await blocker.query("begin");
    await blocker.query(`select id from users where id=$1 for update`, [a]);
    const pid = Number(
      (await blocker.query(`select pg_backend_pid() pid`)).rows[0].pid,
    );
    const stale = service.register(a, sa, device, registration).then(
      () => null,
      (error: unknown) => error,
    );
    await waitForLock(pid);
    await db.query(`update user_sessions set is_active=false where id=$1`, [
      sa,
    ]);
    await service.register(b, sb, device, registration);
    await blocker.query("commit");
    assert.equal(((await stale) as { statusCode: number }).statusCode, 401);
    assert.equal(
      (
        await db.query(`select user_id from native_push_devices where id=$1`, [
          device,
        ])
      ).rows[0].user_id,
      b,
    );
  } finally {
    await blocker.query("rollback");
    blocker.release();
  }

  // Logout already owns the session row. Registration must recheck after waiting.
  const logout = await pool.connect();
  try {
    await logout.query("begin");
    await logout.query(`update user_sessions set is_active=false where id=$1`, [
      renewed,
    ]);
    const pid = Number(
      (await logout.query(`select pg_backend_pid() pid`)).rows[0].pid,
    );
    const stale = service.register(a, renewed, device, registration).then(
      () => null,
      (error: unknown) => error,
    );
    await waitForLock(pid);
    await logout.query("commit");
    assert.equal(((await stale) as { statusCode: number }).statusCode, 401);
  } finally {
    await logout.query("rollback");
    logout.release();
  }
  await db.query(
    `update user_sessions set is_active=true where id=any($1::uuid[])`,
    [[sa, renewed]],
  );
  await service.register(a, renewed, device, registration);
  await service.unregister(a, sa, device);
  assert.equal(
    (
      await db.query(`select active from native_push_devices where id=$1`, [
        device,
      ])
    ).rows[0].active,
    true,
    "a delayed DELETE from an older session cannot disable the renewed registration",
  );
  await service.unregister(a, renewed, device);
  assert.equal(
    (
      await db.query(`select active from native_push_devices where id=$1`, [
        device,
      ])
    ).rows[0].active,
    false,
  );
  await service.register(a, renewed, device, registration);
  await db.query(
    `update user_sessions set expires_at=now()-interval '1 second' where id=$1`,
    [sa],
  );
  await assert.rejects(service.register(a, sa, device, registration), {
    statusCode: 401,
  });
  await assert.rejects(service.unregister(a, sa, device), { statusCode: 401 });
  await db.query(
    `update user_sessions set expires_at=now()+interval '1 day' where id=$1`,
    [sa],
  );

  const tokenBlocker = await pool.connect();
  try {
    await tokenBlocker.query("begin");
    await tokenBlocker.query(
      `select pg_advisory_xact_lock(hashtextextended($1,0))`,
      [`native-push:${registration.environment}:${registration.token}`],
    );
    const pid = Number(
      (await tokenBlocker.query(`select pg_backend_pid() pid`)).rows[0].pid,
    );
    await db.query(
      `update user_sessions set expires_at=clock_timestamp()+interval '2 seconds' where id=$1`,
      [sa],
    );
    const expiring = service.register(a, sa, device, registration).then(
      () => null,
      (error: unknown) => error,
    );
    await waitForLock(pid);
    let expired = false;
    for (let attempt = 0; attempt < 500; attempt++) {
      expired = (
        await db.query(
          `select expires_at<=clock_timestamp() expired from user_sessions where id=$1`,
          [sa],
        )
      ).rows[0].expired;
      if (expired) break;
      await delay(10);
    }
    assert.equal(expired, true);
    await tokenBlocker.query("commit");
    assert.equal(((await expiring) as { statusCode: number }).statusCode, 401);
    assert.equal(
      (
        await db.query(
          `select session_id from native_push_devices where id=$1`,
          [device],
        )
      ).rows[0].session_id,
      renewed,
      "a registration that expires waiting for the token lock rolls back the attempted reassignment",
    );
  } finally {
    await tokenBlocker.query("rollback");
    tokenBlocker.release();
  }
  await db.query(
    `update user_sessions set expires_at=now()+interval '1 day' where id=$1`,
    [sa],
  );

  for (const recreate of [true, false]) {
    await service.register(a, sa, device, registration);
    await enqueueNativePush(db, {
      userIds: [a],
      eventKey: `race:invalid:${recreate}`,
      topic: "market_resolution",
      occurredAt: new Date(),
      content: { title: "Review", body: "Review" },
    });
    let started: () => void = () => {};
    const sending = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release: () => void = () => {};
    const response = new Promise<void>((resolve) => {
      release = resolve;
    });
    const delivery = deliverNativePushBatch({
      db,
      send: async () => {
        started();
        await response;
        return { status: 400, reason: "BadDeviceToken", invalidatedAt: null };
      },
    });
    await sending;
    if (recreate)
      await db.query(`delete from native_push_devices where id=$1`, [device]);
    const owner = recreate ? b : a;
    await service.register(
      owner,
      recreate ? sb : sa,
      device,
      recreate ? { ...registration, token: "cd".repeat(32) } : registration,
    );
    release();
    await delivery;
    const row = (
      await db.query(
        `select user_id,active from native_push_devices where id=$1`,
        [device],
      )
    ).rows[0];
    assert.equal(row.user_id, owner);
    assert.equal(
      row.active,
      true,
      "a late invalid-device response cannot disable a subsequent registration",
    );
  }

  await enqueueNativePush(db, {
    userIds: [a],
    eventKey: "race:current-invalid",
    topic: "market_resolution",
    occurredAt: new Date(),
    content: { title: "Review", body: "Review" },
  });
  await deliverNativePushBatch({
    db,
    send: async () => ({
      status: 400,
      reason: "BadDeviceToken",
      invalidatedAt: null,
    }),
  });
  assert.equal(
    (
      await db.query(`select active from native_push_devices where id=$1`, [
        device,
      ])
    ).rows[0].active,
    false,
    "an invalid token still disables its own current registration",
  );
  await service.register(a, sa, device, registration);
  assert.equal(
    (
      await db.query(`select active from native_push_devices where id=$1`, [
        device,
      ])
    ).rows[0].active,
    true,
    "a corrected registration recovers after a genuine invalid-device response",
  );

  const renewal = await pool.connect();
  try {
    await db.query(
      `insert into native_push_topic_cooldowns values($1,'big_moves','race:market',now()-interval '31 days')`,
      [a],
    );
    await renewal.query("begin");
    await renewal.query(
      `update native_push_topic_cooldowns set occurred_at=now() where user_id=$1`,
      [a],
    );
    // Must finish while the renewing transaction still holds its row lock.
    const cleanup = await pool.connect();
    try {
      await cleanup.query(`set statement_timeout='2s'`);
      await retainNativeOnboardingData(cleanup);
    } finally {
      cleanup.release();
    }
    await renewal.query("commit");
    assert.equal(
      (
        await db.query(
          `select count(*)::int n from native_push_topic_cooldowns where user_id=$1`,
          [a],
        )
      ).rows[0].n,
      1,
    );
    const duplicate = await db.query(
      `insert into native_push_topic_cooldowns values($1,'big_moves','race:market',now()+interval '1 hour')
      on conflict(user_id,topic,subject_key) do update set occurred_at=excluded.occurred_at
      where native_push_topic_cooldowns.occurred_at<=excluded.occurred_at-interval '24 hours' returning user_id`,
      [a],
    );
    assert.equal(
      duplicate.rows.length,
      0,
      "renewed cooldown still rejects another move inside 24 hours",
    );
  } finally {
    await renewal.query("rollback");
    renewal.release();
  }

  await service.register(a, sa, device, registration);
  await db.query(
    `insert into unified_markets(id,event_id,venue,title) values('kalshi:race','kalshi:event','kalshi','Race market')`,
  );
  await db.query(
    `insert into unified_tokens(token_id,market_id,side,venue) values('race-yes','kalshi:race','YES','kalshi')`,
  );
  await db.query(
    `insert into unified_market_tokens(token_id,market_id,outcome_side) values('race-yes','kalshi:race','YES')`,
  );
  await db.query(
    `insert into positions(user_id,token_id,venue) values($1,'race-yes','kalshi')`,
    [a],
  );
  await db.query(
    `insert into unified_token_top_latest(token_id,best_bid,best_ask) values('race-yes',0.69,0.71)`,
  );
  await db.query(
    `insert into unified_token_change_24h(token_id,avg_mid_24h,bucket_24h) values('race-yes',0.5,now()-interval '7 days')`,
  );
  for (let page = 0; page < 3; page++) await enqueueNativeBigMoves(db);
  assert.equal(
    (
      await db.query(
        `select count(*)::int n from native_push_deliveries where topic='big_moves'`,
      )
    ).rows[0].n,
    0,
    "a fresh cache timestamp cannot make a week-old baseline eligible",
  );
  await db.query(
    `update unified_token_change_24h set bucket_24h=date_trunc('hour',now()-interval '24 hours')`,
  );
  await db.query(
    `update native_push_worker_cursors set user_id=null,item_id=null,available_at=now() where name='big-moves'`,
  );
  for (let page = 0; page < 3; page++) await enqueueNativeBigMoves(db);
  assert.equal(
    (
      await db.query(
        `select count(*)::int n from native_push_deliveries where topic='big_moves'`,
      )
    ).rows[0].n,
    1,
    "restored 24h history recovers delivery",
  );

  await db.query(
    `insert into users(handle) select 'backlog_'||n from generate_series(1,10000)n`,
  );
  await db.query(
    `insert into social_trader_statistics(user_id,policy_revision,statistics,wins,losses,win_rate,computed_at,next_refresh_at)
    select id,$1,jsonb_build_object('wins',5,'losses',5,'winRate','0.5','primaryCategory','politics'),5,5,0.5,now()-interval '2 hours',now()-interval '1 hour' from users`,
    [buildSocialTraderStatisticsRevision(DEFAULT_SOCIAL_POLICY)],
  );
  await db.query(
    `update social_trader_statistics set wins=10,losses=0,win_rate=1,
    statistics='{"wins":10,"losses":0,"winRate":"1","primaryCategory":"politics"}' where user_id=$1`,
    [a],
  );
  const before = (
    await db.query(
      `select next_refresh_at from social_trader_statistics where user_id=$1`,
      [a],
    )
  ).rows[0].next_refresh_at;
  await db.query(
    `insert into user_theses(author_id,market_id) values($1,'kalshi:race')`,
    [a],
  );
  const after = (
    await db.query(
      `select next_refresh_at from social_trader_statistics where user_id=$1`,
      [a],
    )
  ).rows[0].next_refresh_at;
  assert.equal(
    after.getTime(),
    before.getTime(),
    "new Hunches do not move overdue authors to the back of the queue",
  );
  await publishSocialTraderRanking(db);
  const ranked = await new SocialService(db).rankedProfiles(b, { limit: 1 });
  assert.equal(
    ranked.items[0]?.id,
    a,
    "the best known author stays ranked while a 10k-author refresh backlog drains",
  );
  console.log(
    "native onboarding races: session fencing, APNs registration identity, cooldown renewal, stale history and ranking backlog passed",
  );
} finally {
  await fixture.close();
}
