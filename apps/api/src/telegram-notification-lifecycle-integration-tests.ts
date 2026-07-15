// @api-integration

import assert from "node:assert/strict";
import crypto from "node:crypto";

import { pool } from "./db.js";
import { enqueueTelegramActivityNotifications } from "./services/telegram-notification-delivery.js";
import { ensureTelegramNotificationPreferences } from "./services/telegram-notification-preferences.js";

const userId = crypto.randomUUID();
const telegramUserId = `telegram-test-${crypto.randomUUID()}`;
const concurrentCursor = `telegram-activity-test-${crypto.randomUUID()}`;
const bootstrapCursor = `telegram-bootstrap-test-${crypto.randomUUID()}`;

try {
  await pool.query(`insert into users (id, username) values ($1::uuid, $2)`, [
    userId,
    `telegram-test-${userId}`,
  ]);
  await pool.query(
    `
      insert into user_telegram_accounts (
        user_id,
        privy_user_id,
        telegram_user_id
      )
      values ($1::uuid, $2, $3)
    `,
    [userId, `privy:${userId}`, telegramUserId],
  );

  const linked = await pool.query<{
    all_activity_topics_enabled: boolean;
    position_signals: boolean;
    reachable: boolean;
  }>(
    `
      select
        reachable,
        position_signals,
        order_filled
          and order_issues
          and position_resolved
          and deposit_received
          and bridge_updates
          and payouts_rewards as all_activity_topics_enabled
      from telegram_notification_preferences
      where user_id = $1::uuid
    `,
    [userId],
  );
  assert.deepEqual(linked.rows[0], {
    all_activity_topics_enabled: true,
    position_signals: false,
    reachable: false,
  });

  const started = await ensureTelegramNotificationPreferences({
    db: pool,
    markStarted: true,
    telegramUserId,
  });
  assert.equal(started?.reachable, true);
  assert.equal(started?.positionSignals, false);

  await pool.query(
    `
      insert into telegram_notification_cursors (
        consumer_key,
        cursor_created_at,
        cursor_id
      )
      values ($1, now(), $2::uuid)
    `,
    [concurrentCursor, "00000000-0000-0000-0000-000000000000"],
  );
  const firstNotification = await pool.query<{ id: string }>(
    `
      insert into notifications (
        user_id,
        type,
        title,
        body,
        severity,
        data,
        dedupe_key
      )
      values (
        $1::uuid,
        'order_filled',
        'Order filled',
        'Filled',
        'success',
        '{}'::jsonb,
        $2
      )
      returning id
    `,
    [userId, `telegram-test-first-${userId}`],
  );
  const firstNotificationId = firstNotification.rows[0]?.id;
  assert.ok(firstNotificationId);

  const concurrent = await Promise.all([
    enqueueTelegramActivityNotifications({
      consumerKey: concurrentCursor,
      pool,
    }),
    enqueueTelegramActivityNotifications({
      consumerKey: concurrentCursor,
      pool,
    }),
  ]);
  assert.equal(concurrent.filter((value) => value > 0).length, 1);

  const firstOutbox = await pool.query<{ count: string }>(
    `
      select count(*)::text as count
      from telegram_notification_outbox
      where user_id = $1::uuid
        and notification_id = $2::uuid
    `,
    [userId, firstNotificationId],
  );
  assert.equal(firstOutbox.rows[0]?.count, "1");

  await pool.query(
    `update notifications set read_at = now() where id = $1::uuid`,
    [firstNotificationId],
  );
  await enqueueTelegramActivityNotifications({
    consumerKey: concurrentCursor,
    pool,
  });
  const afterReadOutbox = await pool.query<{ count: string }>(
    `
      select count(*)::text as count
      from telegram_notification_outbox
      where notification_id = $1::uuid
    `,
    [firstNotificationId],
  );
  assert.equal(afterReadOutbox.rows[0]?.count, "1");
  await pool.query(
    `delete from telegram_notification_outbox where notification_id = $1::uuid`,
    [firstNotificationId],
  );
  await enqueueTelegramActivityNotifications({
    consumerKey: concurrentCursor,
    pool,
  });
  const afterRetentionOutbox = await pool.query<{ count: string }>(
    `
      select count(*)::text as count
      from telegram_notification_outbox
      where notification_id = $1::uuid
    `,
    [firstNotificationId],
  );
  assert.equal(afterRetentionOutbox.rows[0]?.count, "0");

  await pool.query(
    `
      update telegram_notification_preferences
      set order_filled = false,
          updated_at = now()
      where user_id = $1::uuid
    `,
    [userId],
  );
  const toggledNotification = await pool.query<{ id: string }>(
    `
      insert into notifications (
        user_id,
        type,
        title,
        body,
        severity,
        data,
        dedupe_key
      )
      values (
        $1::uuid,
        'order_filled',
        'Old order fill',
        'Old fill',
        'success',
        '{}'::jsonb,
        $2
      )
      returning id
    `,
    [userId, `telegram-test-toggle-${userId}`],
  );
  const toggledNotificationId = toggledNotification.rows[0]?.id;
  assert.ok(toggledNotificationId);
  await pool.query(
    `
      update telegram_notification_preferences
      set order_filled = true,
          order_filled_enabled_at = now(),
          updated_at = now()
      where user_id = $1::uuid
    `,
    [userId],
  );
  await enqueueTelegramActivityNotifications({
    consumerKey: concurrentCursor,
    pool,
  });
  const toggledOutbox = await pool.query<{ count: string }>(
    `
      select count(*)::text as count
      from telegram_notification_outbox
      where notification_id = $1::uuid
    `,
    [toggledNotificationId],
  );
  assert.equal(toggledOutbox.rows[0]?.count, "0");

  const preBootstrap = await pool.query<{ id: string }>(
    `
      insert into notifications (
        user_id,
        type,
        title,
        body,
        severity,
        data,
        dedupe_key
      )
      values (
        $1::uuid,
        'deposit_received',
        'Deposit received',
        'Deposit',
        'success',
        '{}'::jsonb,
        $2
      )
      returning id
    `,
    [userId, `telegram-test-bootstrap-${userId}`],
  );
  const preBootstrapId = preBootstrap.rows[0]?.id;
  assert.ok(preBootstrapId);
  const bootstrap = await enqueueTelegramActivityNotifications({
    consumerKey: bootstrapCursor,
    pool,
  });
  assert.equal(bootstrap, 0);
  const bootstrapOutbox = await pool.query<{ count: string }>(
    `
      select count(*)::text as count
      from telegram_notification_outbox
      where notification_id = $1::uuid
    `,
    [preBootstrapId],
  );
  assert.equal(bootstrapOutbox.rows[0]?.count, "0");

  await pool.query(
    `
      update telegram_notification_preferences
      set reachable = false,
          blocked_at = now(),
          order_filled_enabled_at = now() - interval '1 day',
          updated_at = now()
      where user_id = $1::uuid
    `,
    [userId],
  );
  const restarted = await ensureTelegramNotificationPreferences({
    db: pool,
    markStarted: true,
    telegramUserId,
  });
  assert.equal(restarted?.reachable, true);
  const recovered = await pool.query<{
    blocked_at: Date | null;
    enabled_recently: boolean;
  }>(
    `
      select
        blocked_at,
        order_filled_enabled_at >= now() - interval '1 minute'
          as enabled_recently
      from telegram_notification_preferences
      where user_id = $1::uuid
    `,
    [userId],
  );
  assert.equal(recovered.rows[0]?.blocked_at, null);
  assert.equal(recovered.rows[0]?.enabled_recently, true);

  await pool.query(
    `
      update telegram_notification_preferences
      set reachable = false,
          blocked_at = null,
          updated_at = now()
      where user_id = $1::uuid
    `,
    [userId],
  );
  await pool.query(
    `delete from user_telegram_accounts where user_id = $1::uuid`,
    [userId],
  );
  await pool.query(
    `
      insert into user_telegram_accounts (
        user_id,
        privy_user_id,
        telegram_user_id
      )
      values ($1::uuid, $2, $3)
    `,
    [userId, `privy:${userId}:relinked`, telegramUserId],
  );
  const relinked = await pool.query<{ reachable: boolean }>(
    `
      select reachable
      from telegram_notification_preferences
      where user_id = $1::uuid
    `,
    [userId],
  );
  assert.equal(relinked.rows[0]?.reachable, false);

  console.log("[telegram-notification-lifecycle-integration-tests] passed 1/1");
} finally {
  await pool
    .query(
      `delete from telegram_notification_cursors where consumer_key = any($1::text[])`,
      [[concurrentCursor, bootstrapCursor]],
    )
    .catch(() => undefined);
  await pool
    .query(`delete from users where id = $1::uuid`, [userId])
    .catch(() => undefined);
}
