#!/usr/bin/env tsx

// @requires-db

import assert from "node:assert/strict";
import crypto from "node:crypto";

import "./integration-test-database-guard.js";
import { pool } from "./db.js";
import {
  beginSignalBotMessageDelivery,
  finishSignalBotMessageDelivery,
  recordSignalBotMessageNonDeliveryState,
  reserveSignalBotMessageDelivery,
} from "./services/signal-bot-message-delivery-ledger.js";
import { deliverTelegramBotOnboardingActions } from "./services/telegram-bot-onboarding-delivery.js";
import { deliverTelegramNotificationOutbox } from "./services/telegram-notification-delivery.js";

const suffix = crypto.randomUUID();
const userId = crypto.randomUUID();
const noteId = crypto.randomUUID();
const telegramUserId = `8${Date.now()}`;

try {
  await pool.query(
    `insert into users (id, email, is_active, is_verified)
     values ($1, $2, true, true)`,
    [userId, `telegram-delivery-${suffix}@example.com`],
  );
  const account = await pool.query<{ id: string }>(
    `insert into user_telegram_accounts (
       user_id, privy_user_id, telegram_user_id, username
     ) values ($1, $2, $3, 'delivery-safety-test')
     returning id`,
    [userId, `did:privy:${suffix}`, telegramUserId],
  );
  const telegramAccountId = account.rows[0]?.id;
  assert.ok(telegramAccountId);
  await pool.query(
    `update telegram_notification_preferences
     set reachable = true,
         deposit_received = true,
         deposit_received_enabled_at = now() - interval '1 minute'
     where user_id = $1`,
    [userId],
  );

  await pool.query(
    `update telegram_bot_action_outbox
     set status = 'sending', updated_at = now() - interval '6 minutes'
     where telegram_account_id = $1 and action = 'welcome_menu'`,
    [telegramAccountId],
  );

  const inserted = await pool.query<{
    event_key: string;
    id: string;
  }>(
    `insert into telegram_notification_outbox (
       user_id, event_key, topic, event_occurred_at, payload, status, updated_at
     ) values
       (
         $1, $2, 'deposit_received', now() - interval '10 minutes',
         $3::jsonb, 'sending', now() - interval '6 minutes'
       ),
       (
         $1, $4, 'order_filled', now(), $5::jsonb, 'pending', now()
       ),
       (
         $1, $6, 'deposit_received', now(), $7::jsonb, 'pending', now()
       )
     returning id::text, event_key`,
    [
      userId,
      `stale:${suffix}`,
      JSON.stringify({
        body: "stale",
        title: "Deposit received",
        type: "deposit_received",
      }),
      `fresh-fill:${suffix}`,
      JSON.stringify({
        data: { source: "telegram_bot" },
        title: "Order filled",
        type: "order_filled",
      }),
      `ordinary:${suffix}`,
      JSON.stringify({
        body: "2 pUSD received",
        title: "Deposit received",
        type: "deposit_received",
      }),
    ],
  );
  const ordinaryId = inserted.rows.find(
    (row) => row.event_key === `ordinary:${suffix}`,
  )?.id;
  assert.ok(ordinaryId);

  let notificationCalls = 0;
  const notificationDelivery = await deliverTelegramNotificationOutbox({
    db: pool,
    limit: 10,
    miniAppLinkBase: null,
    telegram: {
      sendMessage: async () => {
        notificationCalls += 1;
        await pool.query(
          `update telegram_notification_outbox
           set status = 'delivery_unknown', last_error = 'concurrent quarantine'
           where id = $1 and status = 'sending'`,
          [ordinaryId],
        );
        return { messageId: 700, ok: true };
      },
    },
  });
  assert.equal(notificationDelivery.quarantined, 1);
  assert.equal(notificationDelivery.claimed, 1);
  assert.equal(notificationDelivery.sent, 0);
  assert.equal(notificationCalls, 1);

  const notificationStates = await pool.query<{
    event_key: string;
    status: string;
  }>(
    `select event_key, status
     from telegram_notification_outbox
     where user_id = $1
     order by event_key`,
    [userId],
  );
  assert.deepEqual(
    Object.fromEntries(
      notificationStates.rows.map((row) => [row.event_key, row.status]),
    ),
    {
      [`fresh-fill:${suffix}`]: "pending",
      [`ordinary:${suffix}`]: "delivery_unknown",
      [`stale:${suffix}`]: "delivery_unknown",
    },
  );

  let welcomeCalls = 0;
  const welcomeDelivery = await deliverTelegramBotOnboardingActions({
    config: {
      adminUserIds: new Set<number>(),
      appBaseUrl: "https://app.hunch.trade",
      telegramMiniAppLinkBase: null,
    },
    db: pool,
    telegram: {
      sendMessage: async () => {
        welcomeCalls += 1;
        return { messageId: 701, ok: true };
      },
    },
  });
  assert.equal(welcomeDelivery.quarantined, 1);
  assert.equal(welcomeDelivery.claimed, welcomeDelivery.skipped);
  assert.equal(welcomeDelivery.sent, 0);
  assert.equal(welcomeCalls, 0);

  await pool.query(
    `insert into ai_notes (
       id, note_key, note_type, title, description, producer_type, producer_run_id
     ) values ($1, $2, 'signal', 'Delivery safety', 'Integration fixture', 'test', $3)`,
    [noteId, `delivery-safety:${suffix}`, `run:${suffix}`],
  );
  const ledgerInput = {
    baselineAt: new Date().toISOString(),
    chatId: telegramUserId,
    db: pool,
    messageKind: "initial" as const,
    noteId,
    replyToMessageId: null,
    threadRootNoteId: noteId,
  };
  const reservations = await Promise.all([
    reserveSignalBotMessageDelivery(ledgerInput),
    reserveSignalBotMessageDelivery(ledgerInput),
  ]);
  const acquired = reservations.find((value) => value.status === "acquired");
  assert.ok(acquired && acquired.status === "acquired");
  assert.equal(
    reservations.filter((value) => value.status === "acquired").length,
    1,
  );
  assert.equal(
    await beginSignalBotMessageDelivery({
      attemptId: acquired.attemptId,
      db: pool,
      deliveryRef: acquired.deliveryRef,
    }),
    true,
  );
  assert.equal(
    await recordSignalBotMessageNonDeliveryState({
      ...ledgerInput,
      metrics: { status: "compose_failed" },
      sentAt: new Date(),
    }),
    false,
  );
  const activeAttempt = await pool.query<{
    attempt_id: string | null;
    status: string | null;
  }>(
    `select
       metrics #>> '{deliveryStateV2,attemptId}' as attempt_id,
       metrics #>> '{deliveryStateV2,status}' as status
     from signal_bot_messages
     where id = $1::uuid`,
    [acquired.deliveryRef],
  );
  assert.deepEqual(activeAttempt.rows[0], {
    attempt_id: acquired.attemptId,
    status: "sending",
  });
  assert.equal(
    await finishSignalBotMessageDelivery({
      attemptId: acquired.attemptId,
      db: pool,
      deliveryRef: acquired.deliveryRef,
      errorCode: "ambiguous",
      expectedStatus: "sending",
      status: "delivery_unknown",
    }),
    true,
  );
  assert.deepEqual(await reserveSignalBotMessageDelivery(ledgerInput), {
    outcome: "delivery_unknown",
    status: "terminal",
  });

  console.log(
    "[telegram-delivery-safety-integration-tests] precedence, stale quarantine, CAS loser, and concurrent signal ledger passed",
  );
} finally {
  await pool
    .query("delete from ai_notes where id = $1", [noteId])
    .catch(() => undefined);
  await pool
    .query("delete from users where id = $1", [userId])
    .catch(() => undefined);
}
