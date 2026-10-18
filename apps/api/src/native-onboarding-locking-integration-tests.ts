// @requires-db
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { Pool } from "@hunch/infra";
import { nativeOnboardingDatabase } from "./native-onboarding-database-fixture.js";
import { createIntegrationTestPool } from "./test-database-target.js";
import { NativeNotificationPreferencesService } from "./services/native-notification-preferences.js";
import {
  enqueueNativePush,
  deliverNativePushBatch,
} from "./services/native-push-queue.js";
import { enqueueNativeBigMoves } from "./services/native-push-sources.js";
import {
  clearUserSocialData,
  mergeUserSocialData,
} from "./services/social-lifecycle.js";

const fixture = await nativeOnboardingDatabase(createIntegrationTestPool);
const { db, pool } = fixture;
const service = new NativeNotificationPreferencesService(db);
let passed = 0;
const failures: string[] = [];
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function gatedDatabase(predicate: (sql: string) => boolean) {
  const reached = deferred(),
    resume = deferred();
  let pid = 0,
    used = false;
  const proxy = {
    query: db.query.bind(db),
    async connect() {
      const client = await db.connect();
      pid = Number(
        (await client.query("select pg_backend_pid() pid")).rows[0].pid,
      );
      return {
        async query(sql: string, values: unknown[] = []) {
          const result = await client.query(sql, values);
          if (!used && predicate(sql)) {
            used = true;
            reached.resolve();
            await resume.promise;
          }
          return result;
        },
        release: () => client.release(),
      };
    },
  } as unknown as Pool;
  return {
    db: proxy,
    reached: reached.promise,
    release: resume.resolve,
    pid: () => pid,
  };
}
async function waitForLock(blocker: number) {
  for (let attempt = 0; attempt < 300; attempt++) {
    const result = await pool.query(
      "select 1 from pg_stat_activity where $1::int=any(pg_blocking_pids(pid))",
      [blocker],
    );
    if (result.rows.length) return;
    await delay(10);
  }
  throw new Error(
    "Expected controlled concurrent request to wait on database lock",
  );
}
async function reset() {
  await db.query(
    "truncate users,unified_markets,native_push_worker_cursors,native_push_events cascade",
  );
}
async function actor(
  authorization: "authorized" | "denied" | null = "authorized",
) {
  const user = randomUUID(),
    session = randomUUID(),
    device = randomUUID();
  const registration = {
    token: randomUUID().replaceAll("-", "").repeat(2),
    environment: "sandbox" as const,
    authorization: authorization ?? ("authorized" as const),
  };
  await db.query("insert into users(id) values($1)", [user]);
  await db.query("insert into user_sessions(id,user_id) values($1,$2)", [
    session,
    user,
  ]);
  await db.query(
    "insert into native_notification_preferences(user_id,big_moves,enabled_at,big_moves_enabled_at,market_resolution_enabled_at) values($1,true,now()-interval '1 hour',now()-interval '1 hour',now()-interval '1 hour')",
    [user],
  );
  if (authorization)
    await service.register(user, session, device, registration);
  return { user, session, device, registration };
}
function enqueue(
  userIds: string[],
  eventKey = randomUUID(),
  target?: { marketId: string },
) {
  return {
    userIds,
    eventKey,
    topic: "market_resolution" as const,
    occurredAt: new Date(),
    content: { title: "Test", body: "Test", target },
  };
}
async function holding(user: string) {
  await db.query(
    "insert into unified_markets(id,event_id,venue,title) values('kalshi:test','kalshi:event','kalshi','Test') on conflict do nothing",
  );
  await db.query(
    "insert into unified_tokens(token_id,market_id,side,venue) values('yes-test','kalshi:test','YES','kalshi') on conflict do nothing",
  );
  await db.query(
    "insert into unified_market_tokens(token_id,market_id,outcome_side) values('yes-test','kalshi:test','YES') on conflict do nothing",
  );
  await db.query(
    "insert into unified_token_top_latest(token_id,best_bid,best_ask) values('yes-test',0.69,0.71) on conflict(token_id) do update set ts=now()",
  );
  await db.query(
    "insert into unified_token_change_24h(token_id,avg_mid_24h) values('yes-test',0.5) on conflict(token_id) do update set bucket_24h=date_trunc('hour',now()-interval '24 hours'),updated_at=now()",
  );
  await db.query(
    "insert into positions(user_id,token_id,venue) values($1,'yes-test','kalshi')",
    [user],
  );
}
async function scan(now = new Date()) {
  await db.query(
    "delete from native_push_worker_cursors where name='big-moves'",
  );
  return enqueueNativeBigMoves(db, now);
}
async function count(table: string) {
  return Number((await db.query(`select count(*) n from ${table}`)).rows[0].n);
}
async function test(name: string, body: () => Promise<void>) {
  await reset();
  try {
    await body();
    passed++;
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`FAIL ${name}`, error);
  }
}
try {
  // Empty supporting tables let the actual lifecycle owner execute all its cleanup SQL.
  await db.query(`
    alter table users add column handle_changed_at timestamptz, add column profile_name_edited_at timestamptz, add column profile_avatar_edited_at timestamptz;
    alter table user_blocks add column created_at timestamptz default now();
    alter table user_theses add column idempotency_key text;
    alter table content_assets add column owner_user_id uuid references users(id) on delete cascade,add column storage_key text,add column metadata jsonb,add column deleted_at timestamptz;
    create table user_onboarding_state(user_id uuid references users(id) on delete cascade);
    create table user_interests(user_id uuid references users(id) on delete cascade);
    create table social_comments(id uuid primary key,author_id uuid references users(id) on delete set null,author_hidden_at timestamptz,body text,idempotency_key text);
    create table social_likes(user_id uuid references users(id) on delete cascade,thesis_id uuid,ai_note_id uuid,comment_id uuid,created_at timestamptz default now());
    create table social_reports(id uuid primary key,reporter_id uuid,target_kind text,target_id uuid,target_profile_id uuid);
    create table content_audit_events(actor_user_id uuid,actor_label text);
    create table content_asset_usages(asset_id uuid);
    create table copy_attributions(id uuid primary key,copier_user_id uuid references users(id) on delete set null,idempotency_key text,repair_lease_token uuid,repair_lease_until timestamptz,repair_due_at timestamptz);
  `);
  await test("register owning user then enqueue completes without deadlock", async () => {
    const a = await actor();
    const gate = gatedDatabase(
      (sql) =>
        sql === "select id from users where id=$1 and is_active for update",
    );
    const registering = new NativeNotificationPreferencesService(
      gate.db,
    ).register(a.user, a.session, a.device, a.registration);
    await gate.reached;
    const pending = enqueueNativePush(db, enqueue([a.user]));
    pending.catch(() => {});
    await waitForLock(gate.pid());
    gate.release();
    const outcomes = await Promise.allSettled([registering, pending]);
    assert.ok(
      outcomes.every((result) => result.status === "fulfilled"),
      JSON.stringify(outcomes),
    );
    assert.equal(await count("native_push_deliveries"), 1);
  });
  await test("no device does not consume cooldown and registration recovers next scan", async () => {
    const a = await actor(null);
    await holding(a.user);
    await scan();
    assert.equal(await count("native_push_deliveries"), 0);
    assert.equal(await count("native_push_topic_cooldowns"), 0);
    await service.register(a.user, a.session, a.device, a.registration);
    await scan();
    assert.equal(await count("native_push_deliveries"), 1);
    assert.equal(await count("native_push_topic_cooldowns"), 1);
  });

  await test("enqueue owning user then register completes without deadlock", async () => {
    const a = await actor();
    const gate = gatedDatabase((sql) =>
      sql.includes("select id from users where id=any"),
    );
    const pending = enqueueNativePush(gate.db, enqueue([a.user]));
    pending.catch(() => {});
    await gate.reached;
    const registering = service.register(
      a.user,
      a.session,
      a.device,
      a.registration,
    );
    registering.catch(() => {});
    try {
      await waitForLock(gate.pid());
    } finally {
      gate.release();
    }
    await Promise.all([pending, registering]);
    assert.equal(await count("native_push_deliveries"), 1);
  });

  await test("unsuspension cannot open an unlocked eligibility gap and a fresh enqueue recovers", async () => {
    const a = await actor();
    await db.query("update users set social_suspended_at=now() where id=$1", [
      a.user,
    ]);
    const gate = gatedDatabase((sql) =>
      sql.includes("select id from users where id=any"),
    );
    const pending = enqueueNativePush(gate.db, enqueue([a.user]));
    pending.catch(() => {});
    await gate.reached;
    const unsuspending = db.query(
      "update users set social_suspended_at=null where id=$1",
      [a.user],
    );
    unsuspending.catch(() => {});
    try {
      await waitForLock(gate.pid());
    } finally {
      gate.release();
    }
    const [queued] = await Promise.all([pending, unsuspending]);
    assert.equal(
      queued,
      0,
      "eligibility stays suspended throughout the locked insertion",
    );
    assert.equal(
      await enqueueNativePush(db, enqueue([a.user])),
      1,
      "the next call sees completed unsuspension and recovers",
    );
  });

  for (const kind of ["hard", "soft", "merge"] as const) {
    for (const first of ["lifecycle", "enqueue"] as const) {
      await test(`${kind} lifecycle cleanup and enqueue, ${first} starts first`, async () => {
        const a = await actor(),
          target = await actor();
        const lifecycle = await pool.connect();
        let pending: Promise<number> | undefined;
        let finishCleanup: Promise<void> | undefined;
        const gate = gatedDatabase((sql) =>
          sql.includes("select id from users where id=any"),
        );
        try {
          await lifecycle.query("begin");
          const cleanup = async () => {
            await lifecycle.query(
              "select id from users where id=any($1::uuid[]) order by id for update",
              [kind === "merge" ? [a.user, target.user] : [a.user]],
            );
            if (kind === "merge")
              await mergeUserSocialData(lifecycle, a.user, target.user, true);
            else await clearUserSocialData(lifecycle, a.user);
            if (kind === "hard")
              await lifecycle.query("delete from users where id=$1", [a.user]);
            else if (kind === "soft")
              await lifecycle.query(
                "update users set is_active=false where id=$1",
                [a.user],
              );
            await lifecycle.query("commit");
          };
          if (first === "lifecycle") {
            await lifecycle.query(
              "select id from users where id=any($1::uuid[]) order by id for update",
              [kind === "merge" ? [a.user, target.user] : [a.user]],
            );
            const pid = Number(
              (await lifecycle.query("select pg_backend_pid() pid")).rows[0]
                .pid,
            );
            pending = enqueueNativePush(db, enqueue([a.user]));
            pending.catch(() => {});
            await waitForLock(pid);
            await cleanup();
          } else {
            pending = enqueueNativePush(gate.db, enqueue([a.user]));
            pending.catch(() => {});
            await gate.reached;
            finishCleanup = cleanup();
            finishCleanup.catch(() => {});
            try {
              await waitForLock(gate.pid());
            } finally {
              gate.release();
            }
            await finishCleanup;
          }
          await pending;
          const remaining = await db.query(
            `select
            (select count(*) from native_push_devices where user_id=$1)+
            (select count(*) from native_push_deliveries where user_id=$1)+
            (select count(*) from native_notification_preferences where user_id=$1)+
            (select count(*) from native_push_topic_cooldowns where user_id=$1) n`,
            [a.user],
          );
          assert.equal(Number(remaining.rows[0].n), 0);
          assert.equal(
            await enqueueNativePush(db, enqueue([a.user])),
            0,
            "deleted source is never resurrected",
          );
          if (kind === "merge") {
            assert.equal(
              (
                await db.query("select is_active from users where id=$1", [
                  a.user,
                ])
              ).rows[0].is_active,
              true,
              "keepSource merge retains active source credentials",
            );
            assert.equal(
              Number(
                (
                  await db.query(
                    "select count(*) n from native_push_devices where user_id=$1",
                    [target.user],
                  )
                ).rows[0].n,
              ),
              1,
              "target retains only its own device",
            );
          }
        } finally {
          gate.release();
          await lifecycle.query("rollback");
          lifecycle.release();
          await Promise.allSettled(
            [pending, finishCleanup].filter(
              (value): value is Promise<number> | Promise<void> =>
                value !== undefined,
            ),
          );
        }
      });
    }
  }

  await test("merge follow-edge FK and overlapping recipient batch use compatible ordered locks", async () => {
    const actors = await Promise.all([actor(), actor(), actor()]);
    actors.sort((left, right) => left.user.localeCompare(right.user));
    const [thirdParty, source, target] = actors;
    await db.query(
      "insert into user_follows(follower_user_id,followed_user_id) values($1,$2)",
      [source.user, thirdParty.user],
    );
    const lifecycle = await pool.connect();
    let pending: Promise<number> | undefined,
      merging: Promise<void> | undefined;
    try {
      await lifecycle.query("begin");
      await lifecycle.query(
        "select id from users where id=any($1::uuid[]) order by id for update",
        [[source.user, target.user]],
      );
      const pid = Number(
        (await lifecycle.query("select pg_backend_pid() pid")).rows[0].pid,
      );
      pending = enqueueNativePush(db, enqueue([source.user, thirdParty.user]));
      pending.catch(() => {});
      await waitForLock(pid);
      merging = mergeUserSocialData(
        lifecycle,
        source.user,
        target.user,
        true,
      ).then(
        async () => {
          await lifecycle.query("commit");
        },
        async (error: unknown) => {
          await lifecycle.query("rollback");
          throw error;
        },
      );
      merging.catch(() => {});
      const outcomes = await Promise.allSettled([pending, merging]);
      assert.ok(
        outcomes.every((outcome) => outcome.status === "fulfilled"),
        JSON.stringify(outcomes),
      );
      assert.equal(
        (
          await db.query(
            "select count(*)::int n from user_follows where follower_user_id=$1 and followed_user_id=$2",
            [target.user, thirdParty.user],
          )
        ).rows[0].n,
        1,
      );
    } finally {
      await lifecycle.query("rollback");
      lifecycle.release();
      await Promise.allSettled(
        [pending, merging].filter(
          (value): value is Promise<number> | Promise<void> =>
            value !== undefined,
        ),
      );
    }
  });

  for (const first of ["lifecycle", "source"] as const) {
    await test(`Big moves existing cooldown and actual lifecycle cleanup, ${first} starts first`, async () => {
      const a = await actor();
      await holding(a.user);
      await db.query(
        "insert into native_push_topic_cooldowns(user_id,topic,subject_key,occurred_at) values($1,'big_moves','kalshi:test',now()-interval '25 hours')",
        [a.user],
      );
      const lifecycle = await pool.connect();
      const gate = gatedDatabase((sql) =>
        sql.includes("insert into native_push_topic_cooldowns"),
      );
      let source: Promise<boolean> | undefined,
        cleaning: Promise<void> | undefined;
      try {
        await lifecycle.query("begin");
        const cleanup = async () => {
          await lifecycle.query("select id from users where id=$1 for update", [
            a.user,
          ]);
          await clearUserSocialData(lifecycle, a.user);
          await lifecycle.query(
            "update users set is_active=false where id=$1",
            [a.user],
          );
          await lifecycle.query("commit");
        };
        if (first === "lifecycle") {
          await lifecycle.query("select id from users where id=$1 for update", [
            a.user,
          ]);
          const pid = Number(
            (await lifecycle.query("select pg_backend_pid() pid")).rows[0].pid,
          );
          source = enqueueNativeBigMoves(db);
          source.catch(() => {});
          await waitForLock(pid);
          await cleanup();
        } else {
          source = enqueueNativeBigMoves(gate.db);
          source.catch(() => {});
          await gate.reached;
          cleaning = cleanup();
          cleaning.catch(() => {});
          try {
            await waitForLock(gate.pid());
          } finally {
            gate.release();
          }
          await cleaning;
        }
        await source;
        assert.equal(await count("native_push_topic_cooldowns"), 0);
        assert.equal(await count("native_push_deliveries"), 0);
        assert.equal(
          await enqueueNativeBigMoves(db),
          false,
          "empty source advances after cleanup",
        );
      } finally {
        gate.release();
        await lifecycle.query("rollback");
        lifecycle.release();
        await Promise.allSettled(
          [source, cleaning].filter(
            (value): value is Promise<boolean> | Promise<void> =>
              value !== undefined,
          ),
        );
      }
    });
  }

  await test("reversed recipient batch and token ownership transfer serialize, obsolete delivery skips", async () => {
    const a = await actor(),
      b = await actor();
    const ordered = [a.user, b.user].sort();
    const gate = gatedDatabase((sql) =>
      sql.includes("select id from users where id=any"),
    );
    const pending = enqueueNativePush(gate.db, enqueue([...ordered].reverse()));
    pending.catch(() => {});
    await gate.reached;
    const transferring = service.register(
      b.user,
      b.session,
      a.device,
      a.registration,
    );
    transferring.catch(() => {});
    try {
      await waitForLock(gate.pid());
    } finally {
      gate.release();
    }
    await Promise.all([pending, transferring]);
    assert.equal(
      (
        await db.query("select user_id from native_push_devices where id=$1", [
          a.device,
        ])
      ).rows[0].user_id,
      b.user,
    );
    const payloadOwners: string[] = [];
    const counts = await deliverNativePushBatch({
      db,
      send: async (input) => {
        payloadOwners.push(
          String((input.payload.hunch as { userId: string }).userId),
        );
        return { status: 200, reason: null, invalidatedAt: null };
      },
    });
    assert.equal(counts.skipped, 1);
    assert.equal(counts.sent, 1);
    assert.deepEqual(payloadOwners, [b.user]);
    const results = await Promise.all([
      enqueueNativePush(db, enqueue(ordered)),
      enqueueNativePush(db, enqueue([...ordered].reverse())),
    ]);
    assert.deepEqual(results, [2, 2]);
  });

  await test("token transfer owning new user before reversed batch preserves current ownership", async () => {
    const a = await actor(),
      b = await actor();
    const gate = gatedDatabase(
      (sql) =>
        sql === "select id from users where id=$1 and is_active for update",
    );
    const transfer = new NativeNotificationPreferencesService(gate.db).register(
      b.user,
      b.session,
      a.device,
      a.registration,
    );
    transfer.catch(() => {});
    await gate.reached;
    const pending = enqueueNativePush(
      db,
      enqueue([a.user, b.user].sort().reverse()),
    );
    pending.catch(() => {});
    try {
      await waitForLock(gate.pid());
    } finally {
      gate.release();
    }
    await Promise.all([transfer, pending]);
    const rows = await db.query(
      "select user_id,payload->'hunch'->>'userId' payload_owner from native_push_deliveries",
    );
    assert.equal(rows.rows.length, 2);
    assert.ok(
      rows.rows.every(
        (row) => row.user_id === b.user && row.payload_owner === b.user,
      ),
    );
  });

  for (const first of ["enqueue", "registration"] as const) {
    await test(`single-recipient enqueue and outsider token transfer with new installation, ${first} first`, async () => {
      const a = await actor(),
        b = await actor(),
        newInstallation = randomUUID();
      const gate = gatedDatabase((sql) =>
        first === "enqueue"
          ? sql.includes("insert into native_push_deliveries")
          : sql.includes("delete from native_push_devices where environment="),
      );
      let pending: Promise<number> | undefined,
        transfer: Promise<void> | undefined;
      try {
        if (first === "enqueue") {
          pending = enqueueNativePush(gate.db, enqueue([a.user]));
          pending.catch(() => {});
          await gate.reached;
          transfer = service.register(
            b.user,
            b.session,
            newInstallation,
            a.registration,
          );
          transfer.catch(() => {});
        } else {
          transfer = new NativeNotificationPreferencesService(gate.db).register(
            b.user,
            b.session,
            newInstallation,
            a.registration,
          );
          transfer.catch(() => {});
          await gate.reached;
          pending = enqueueNativePush(db, enqueue([a.user]));
          pending.catch(() => {});
        }
        try {
          await waitForLock(gate.pid());
        } finally {
          gate.release();
        }
        await Promise.all([pending, transfer]);
        assert.equal(
          (
            await db.query(
              "select count(*)::int n from native_push_devices where id=$1",
              [a.device],
            )
          ).rows[0].n,
          0,
        );
        assert.equal(
          (
            await db.query(
              "select user_id from native_push_devices where id=$1",
              [newInstallation],
            )
          ).rows[0].user_id,
          b.user,
        );
        let sends = 0;
        await deliverNativePushBatch({
          db,
          send: async () => {
            sends++;
            return { status: 200, reason: null, invalidatedAt: null };
          },
        });
        assert.equal(
          sends,
          0,
          "the old owner never sends after token reassignment",
        );
        assert.equal(await enqueueNativePush(db, enqueue([a.user])), 0);
        assert.equal(await enqueueNativePush(db, enqueue([b.user])), 2);
        const owners: string[] = [];
        await deliverNativePushBatch({
          db,
          send: async (input) => {
            owners.push(
              String((input.payload.hunch as { userId: string }).userId),
            );
            return { status: 200, reason: null, invalidatedAt: null };
          },
        });
        assert.deepEqual(
          owners,
          [b.user, b.user],
          "reassigned token remains usable only with the current recipient payload",
        );
      } finally {
        gate.release();
        await Promise.allSettled(
          [pending, transfer].filter(
            (value): value is Promise<number> | Promise<void> =>
              value !== undefined,
          ),
        );
      }
    });
  }

  for (const unavailable of ["expired session", "denied device"] as const) {
    await test(`${unavailable} does not consume cooldown and valid registration recovers`, async () => {
      const a = await actor(
        unavailable === "denied device" ? "denied" : "authorized",
      );
      await holding(a.user);
      if (unavailable === "expired session")
        await db.query(
          "update user_sessions set expires_at=now()-interval '1 second' where id=$1",
          [a.session],
        );
      await scan();
      assert.equal(await count("native_push_topic_cooldowns"), 0);
      assert.equal(await count("native_push_deliveries"), 0);
      await db.query(
        "update user_sessions set expires_at=now()+interval '1 day' where id=$1",
        [a.session],
      );
      await service.register(a.user, a.session, a.device, {
        ...a.registration,
        authorization: "authorized",
      });
      await scan();
      assert.equal(await count("native_push_topic_cooldowns"), 1);
      assert.equal(await count("native_push_deliveries"), 1);
    });
  }

  await test("no-device account advances cursor and does not starve next recipient", async () => {
    const users = [randomUUID(), randomUUID()].sort();
    for (const user of users) {
      await db.query("insert into users(id) values($1)", [user]);
      await db.query(
        "insert into native_notification_preferences(user_id,big_moves,big_moves_enabled_at) values($1,true,now()-interval '1 hour')",
        [user],
      );
      await holding(user);
    }
    const session = randomUUID();
    await db.query("insert into user_sessions(id,user_id) values($1,$2)", [
      session,
      users[1],
    ]);
    await service.register(users[1], session, randomUUID(), {
      token: "cd".repeat(32),
      environment: "sandbox",
      authorization: "authorized",
    });
    await enqueueNativeBigMoves(db);
    await enqueueNativeBigMoves(db);
    assert.deepEqual(
      (await db.query("select user_id from native_push_deliveries")).rows.map(
        (row) => row.user_id,
      ),
      [users[1]],
    );
    assert.equal(await enqueueNativeBigMoves(db), false);
  });

  await test("two workers and multiple devices create one rolling signal and preserve 24h boundary", async () => {
    const a = await actor();
    await holding(a.user);
    await service.register(a.user, a.session, randomUUID(), {
      ...a.registration,
      token: "ef".repeat(32),
    });
    await Promise.all([enqueueNativeBigMoves(db), enqueueNativeBigMoves(db)]);
    assert.equal(await count("native_push_deliveries"), 2);
    assert.equal(await count("native_push_topic_cooldowns"), 1);
    const signalTime = new Date(
      (await db.query("select occurred_at from native_push_topic_cooldowns"))
        .rows[0].occurred_at,
    );
    // Advancing the simulated scan also advances only the corresponding reference buckets.
    const before = new Date(signalTime.getTime() + 86_400_000 - 1),
      boundary = new Date(signalTime.getTime() + 86_400_000);
    for (const now of [before, boundary]) {
      await db.query(
        "update unified_token_change_24h set bucket_24h=date_trunc('hour',$1::timestamptz-interval '24 hours'),updated_at=now()",
        [now],
      );
      await scan(now);
      assert.equal(
        await count("native_push_deliveries"),
        now === before ? 2 : 4,
      );
    }
    await scan(boundary);
    assert.equal(
      await count("native_push_deliveries"),
      4,
      "repeated event key is deduplicated",
    );
    await db.query("delete from native_push_topic_cooldowns");
    await scan(boundary);
    assert.equal(
      await count("native_push_deliveries"),
      4,
      "existing event keys create no additional device delivery",
    );
    assert.equal(
      await count("native_push_topic_cooldowns"),
      0,
      "a deduplicated event does not consume another cooldown",
    );
  });

  await test("enqueue database failure rolls back cooldown and cursor, next scan recovers", async () => {
    const a = await actor();
    await holding(a.user);
    await db.query(`create function fail_native_delivery() returns trigger language plpgsql as $$begin raise exception 'injected enqueue failure';end$$;
      create trigger fail_native_delivery before insert on native_push_deliveries for each row execute function fail_native_delivery()`);
    try {
      await assert.rejects(
        enqueueNativeBigMoves(db),
        /injected enqueue failure/,
      );
      assert.equal(await count("native_push_topic_cooldowns"), 0);
      assert.equal(await count("native_push_deliveries"), 0);
      assert.equal(await count("native_push_worker_cursors"), 0);
    } finally {
      await db.query(
        "drop trigger fail_native_delivery on native_push_deliveries;drop function fail_native_delivery()",
      );
    }
    await enqueueNativeBigMoves(db);
    assert.equal(await count("native_push_deliveries"), 1);
    assert.equal(await count("native_push_topic_cooldowns"), 1);
  });

  await test("cooldown database failure rolls back already queued deliveries and cursor", async () => {
    const a = await actor();
    await holding(a.user);
    await db.query(`create function fail_native_cooldown() returns trigger language plpgsql as $$begin raise exception 'injected cooldown failure';end$$;
      create trigger fail_native_cooldown before insert on native_push_topic_cooldowns for each row execute function fail_native_cooldown()`);
    try {
      await assert.rejects(
        enqueueNativeBigMoves(db),
        /injected cooldown failure/,
      );
      assert.equal(await count("native_push_topic_cooldowns"), 0);
      assert.equal(await count("native_push_deliveries"), 0);
      assert.equal(await count("native_push_worker_cursors"), 0);
    } finally {
      await db.query(
        "drop trigger fail_native_cooldown on native_push_topic_cooldowns;drop function fail_native_cooldown()",
      );
    }
    await enqueueNativeBigMoves(db);
    assert.equal(await count("native_push_deliveries"), 1);
    assert.equal(await count("native_push_topic_cooldowns"), 1);
  });

  for (const deadline of ["close_time", "expiration_time"] as const) {
    await test(`queued Big moves skips market with past ${deadline} and future market recovers`, async () => {
      const a = await actor();
      await holding(a.user);
      const signal = () => ({
        ...enqueue([a.user], randomUUID(), { marketId: "kalshi:test" }),
        topic: "big_moves" as const,
      });
      await enqueueNativePush(db, signal());
      await db.query(
        `update unified_markets set ${deadline}=now()-interval '1 second' where id='kalshi:test'`,
      );
      let sends = 0;
      const send = async () => {
        sends++;
        return { status: 200, reason: null, invalidatedAt: null };
      };
      const expired = await deliverNativePushBatch({ db, send });
      assert.equal(expired.skipped, 1);
      assert.equal(sends, 0);
      await db.query(
        `update unified_markets set ${deadline}=now()+interval '1 day' where id='kalshi:test'`,
      );
      await enqueueNativePush(db, signal());
      const recovered = await deliverNativePushBatch({ db, send });
      assert.equal(recovered.sent, 1);
      assert.equal(sends, 1);
    });
  }

  for (const staleOutcome of ["finish", "retry", "failure"] as const) {
    await test(`expired delivery lease is reclaimed; late ${staleOutcome} cannot mutate current lease`, async () => {
      const a = await actor();
      await enqueueNativePush(db, enqueue([a.user]));
      const started = deferred(),
        resume = deferred(),
        reclaimed = deferred(),
        finishNew = deferred();
      let first: ReturnType<typeof deliverNativePushBatch> | undefined,
        second: ReturnType<typeof deliverNativePushBatch> | undefined;
      try {
        first = deliverNativePushBatch({
          db,
          send: async () => {
            started.resolve();
            await resume.promise;
            return {
              status:
                staleOutcome === "finish"
                  ? 200
                  : staleOutcome === "retry"
                    ? 503
                    : 400,
              reason: staleOutcome === "finish" ? null : "BadPayload",
              invalidatedAt: null,
            };
          },
        });
        first.catch(() => {});
        await started.promise;
        const old = (
          await db.query("select id,lease_id from native_push_deliveries")
        ).rows[0];
        await db.query(
          "update native_push_deliveries set lease_until=now()-interval '1 second',available_at=now()-interval '1 second' where id=$1",
          [old.id],
        );
        second = deliverNativePushBatch({
          db,
          send: async () => {
            reclaimed.resolve();
            await finishNew.promise;
            return { status: 200, reason: null, invalidatedAt: null };
          },
        });
        second.catch(() => {});
        await reclaimed.promise;
        const fresh = (
          await db.query(
            "select lease_id,attempts from native_push_deliveries where id=$1",
            [old.id],
          )
        ).rows[0];
        assert.notEqual(fresh.lease_id, old.lease_id);
        assert.equal(fresh.attempts, 2);
        resume.resolve();
        await first;
        const during = (
          await db.query(
            "select status,lease_id,error_code from native_push_deliveries where id=$1",
            [old.id],
          )
        ).rows[0];
        assert.equal(during.status, "sending");
        assert.equal(during.lease_id, fresh.lease_id);
        assert.equal(during.error_code, null);
        finishNew.resolve();
        await second;
        const final = (
          await db.query(
            "select status,lease_id,error_code from native_push_deliveries where id=$1",
            [old.id],
          )
        ).rows[0];
        assert.equal(final.status, "sent");
        assert.equal(final.lease_id, null);
        assert.equal(final.error_code, null);
      } finally {
        resume.resolve();
        finishNew.resolve();
        await Promise.allSettled(
          [first, second].filter(
            (value): value is ReturnType<typeof deliverNativePushBatch> =>
              value !== undefined,
          ),
        );
      }
    });
  }
} finally {
  await fixture.close();
}
console.log(
  `Native onboarding locking integration: ${passed} passed, ${failures.length} failed`,
);
assert.deepEqual(failures, []);
