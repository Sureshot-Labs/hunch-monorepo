// @requires-db

import assert from "node:assert/strict";
import crypto from "node:crypto";

import "./integration-test-database-guard.js";
import { pool } from "./db.js";
import {
  cancelTelegramAppHandoff,
  claimTelegramAppHandoff,
  commitTelegramAppHandoffWithExecution,
  issueTelegramAppHandoff,
  resolveTelegramAppHandoff,
  TelegramAppHandoffError,
} from "./services/telegram-app-handoff.js";
import { reconcileStaleTelegramTradeIntents } from "./services/telegram-bot-trading.js";
import { materializeTelegramAppHandoffV2Funding } from "./services/telegram-app-handoff-v2.js";

const client = await pool.connect();

try {
  await client.query("begin");
  let savepointSequence = 0;
  const savepointPool = {
    connect: async () => {
      const savepoint = `telegram_handoff_consent_${++savepointSequence}`;
      return {
        query: async (sql: string, values?: readonly unknown[]) => {
          const transactionCommand = sql.trim().toLowerCase();
          if (transactionCommand === "begin") {
            return client.query(`savepoint ${savepoint}`);
          }
          if (transactionCommand === "commit") {
            return client.query(`release savepoint ${savepoint}`);
          }
          if (transactionCommand === "rollback") {
            await client.query(`rollback to savepoint ${savepoint}`);
            return client.query(`release savepoint ${savepoint}`);
          }
          return client.query(sql, values as never);
        },
        release: () => undefined,
      };
    },
  };

  const suffix = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const intentId = crypto.randomUUID();
  const telegramUserId = "420000000000000001";
  const eventId = `limitless:handoff-consent-event-${suffix}`;
  const marketId = `limitless:handoff-consent-market-${suffix}`;
  const planSnapshot = {
    kind: "direct_trade",
    trade: { action: "sell" },
    version: 2,
  } as const;
  const quoteSnapshot = { minimumReceiveUsd: "0.10" } as const;

  await client.query(
    `insert into users (id, privy_user_id, is_active, is_verified)
     values ($1::uuid, $2::text, true, true)`,
    [userId, `did:privy:${suffix}`],
  );
  await client.query(
    `insert into user_telegram_accounts (
       user_id, privy_user_id, telegram_user_id, username
     ) values ($1::uuid, $2::text, $3::text, 'handoff-consent')`,
    [userId, `did:privy:${suffix}`, telegramUserId],
  );
  await client.query(
    `insert into unified_events (
       id, venue, venue_event_id, title, status, end_date
     ) values (
       $1::text, 'limitless', $2::text, 'Handoff consent event',
       'ACTIVE', now() + interval '1 day'
     )`,
    [eventId, `event-${suffix}`],
  );
  await client.query(
    `insert into unified_markets (
       id, venue, venue_market_id, event_id, title, status, market_type,
       close_time, expiration_time, outcomes, clob_token_ids, metadata
     ) values (
       $1::text, 'limitless', $2::text, $3::text, 'Handoff consent market',
       'ACTIVE', 'binary', now() + interval '1 day',
       now() + interval '1 day', '["Yes","No"]'::jsonb,
       '["yes-token","no-token"]'::jsonb, '{}'::jsonb
     )`,
    [marketId, `market-${suffix}`, eventId],
  );
  await client.query(
    `insert into telegram_trade_intents (
       id, telegram_user_id, user_id, chat_id, telegram_message_id, action,
       venue, market_id, event_id, side, shares_raw, status, quote_snapshot,
       result, expires_at, idempotency_key, delivery_mode
     ) values (
       $1::uuid, $2::text, $3::uuid, $2::text, 1, 'sell', 'limitless',
       $4::text, $5::text, 'YES', '1000000', 'previewed', $6::jsonb,
       jsonb_build_object(
         'appHandoffV2', jsonb_build_object(
           'plan', $7::jsonb,
           'version', 2
         )
       ),
       now() + interval '5 minutes', $8::text, 'app_handoff'
     )`,
    [
      intentId,
      telegramUserId,
      userId,
      marketId,
      eventId,
      JSON.stringify(quoteSnapshot),
      JSON.stringify(planSnapshot),
      `handoff-consent:${suffix}`,
    ],
  );

  await assert.rejects(
    issueTelegramAppHandoff({
      authorityFingerprint: "a".repeat(64),
      db: savepointPool as never,
      planSnapshot,
      policyRevision: `policy-${suffix}`,
      quoteSnapshot: { minimumReceiveUsd: "0.11" },
      telegramUserId,
      tokenSecret: `secret-${suffix}`,
      tradeIntentId: intentId,
      userId,
    }),
    (error: unknown) =>
      error instanceof TelegramAppHandoffError && error.code === "unauthorized",
    "issue cannot seal a caller-local quote that differs from the persisted Review",
  );
  const issued = await issueTelegramAppHandoff({
    authorityFingerprint: "a".repeat(64),
    db: savepointPool as never,
    planSnapshot,
    policyRevision: `policy-${suffix}`,
    quoteSnapshot,
    telegramUserId,
    tokenSecret: `secret-${suffix}`,
    tradeIntentId: intentId,
    userId,
  });
  const claimed = await claimTelegramAppHandoff({
    db: savepointPool as never,
    telegramUserId,
    token: issued.token,
    userId,
  });
  assert.equal(claimed.state, "claimed");
  assert.deepEqual(
    (
      await client.query<{
        consent_action: string | null;
        consent_handoff_id: string | null;
        status: string;
      }>(
        `select status,
                result #>> '{appHandoffConsent,action}' as consent_action,
                result #>> '{appHandoffConsent,handoffId}' as consent_handoff_id
           from telegram_trade_intents
          where id = $1::uuid`,
        [intentId],
      )
    ).rows[0],
    {
      consent_action: "sell",
      consent_handoff_id: issued.handoff.id,
      status: "previewed",
    },
    "claim records exact Sell consent without violating the pre-commit authority state",
  );

  await client.query(
    `update telegram_trade_intents
        set expires_at = clock_timestamp() - interval '1 second'
      where id = $1::uuid`,
    [intentId],
  );
  assert.equal(
    (
      await resolveTelegramAppHandoff({
        db: savepointPool as never,
        telegramUserId,
        token: issued.token,
        userId,
      })
    ).state,
    "claimed",
    "a claimed handoff outlives the short Review quote while client execution resumes",
  );
  const staleReconciliation = await reconcileStaleTelegramTradeIntents(client, {
    now: new Date(),
    telegramUserId,
  });
  assert.equal(
    staleReconciliation.expiredPending,
    0,
    "background reconciliation cannot expire a claimed one-click handoff",
  );
  assert.equal(
    (
      await client.query<{ status: string }>(
        `select status from telegram_trade_intents where id = $1::uuid`,
        [intentId],
      )
    ).rows[0]?.status,
    "previewed",
  );

  await commitTelegramAppHandoffWithExecution({
    allowedIntentActions: ["sell"],
    allowedIntentStatuses: ["previewed", "confirming", "external_handoff"],
    commitExecution: async () => ({ kind: "direct_trade" as const }),
    committedIntentStatus: "external_handoff",
    currentAuthorityFingerprint: "a".repeat(64),
    currentPolicyRevision: `policy-${suffix}`,
    db: savepointPool as never,
    executionKind: "direct_trade",
    planFingerprint: issued.handoff.planFingerprint,
    telegramUserId,
    token: issued.token,
    userId,
  });
  assert.deepEqual(
    (
      await client.query<{
        execution_kind: string | null;
        execution_version: string | null;
        status: string;
      }>(
        `select status,
                result #>> '{appHandoffExecution,kind}' as execution_kind,
                result #>> '{appHandoffExecution,version}' as execution_version
           from telegram_trade_intents
          where id = $1::uuid`,
        [intentId],
      )
    ).rows[0],
    {
      execution_kind: "direct_trade",
      execution_version: "2",
      status: "external_handoff",
    },
    "commit attaches the marker and execution status in one constraint-valid write",
  );

  const cancelledIntentId = crypto.randomUUID();
  await client.query(
    `insert into telegram_trade_intents (
       id, telegram_user_id, user_id, chat_id, telegram_message_id, action,
       venue, market_id, event_id, side, shares_raw, status, quote_snapshot,
       result, expires_at, idempotency_key, delivery_mode
     ) select
       $1::uuid, telegram_user_id, user_id, chat_id, 2, action, venue,
       market_id, event_id, side, shares_raw, 'previewed', $2::jsonb,
       jsonb_build_object(
         'appHandoffV2', jsonb_build_object(
           'plan', $3::jsonb,
           'version', 2
         )
       ),
       now() + interval '5 minutes', $4::text, delivery_mode
     from telegram_trade_intents
     where id = $5::uuid`,
    [
      cancelledIntentId,
      JSON.stringify(quoteSnapshot),
      JSON.stringify(planSnapshot),
      `handoff-cancelled:${suffix}`,
      intentId,
    ],
  );
  const cancelledHandoff = await issueTelegramAppHandoff({
    authorityFingerprint: "a".repeat(64),
    db: savepointPool as never,
    planSnapshot,
    policyRevision: `policy-${suffix}`,
    quoteSnapshot,
    telegramUserId,
    tokenSecret: `cancelled-secret-${suffix}`,
    tradeIntentId: cancelledIntentId,
    userId,
  });
  await client.query(
    `update telegram_trade_intents
        set status = 'cancelled', updated_at = clock_timestamp()
      where id = $1::uuid`,
    [cancelledIntentId],
  );
  await client.query("savepoint cancelled_handoff_claim_case");
  await assert.rejects(
    claimTelegramAppHandoff({
      db: savepointPool as never,
      telegramUserId,
      token: cancelledHandoff.token,
      userId,
    }),
    (error: unknown) =>
      error instanceof TelegramAppHandoffError &&
      error.code === "not_claimable",
    "a stale Mini App claim observes Telegram cancellation",
  );
  assert.equal(
    (
      await client.query<{ state: string }>(
        `select state
           from telegram_app_handoffs
          where id = $1::uuid`,
        [cancelledHandoff.handoff.id],
      )
    ).rows[0]?.state,
    "cancelled",
    "terminal reconciliation commits before claim returns not_claimable",
  );
  await client.query("rollback to savepoint cancelled_handoff_claim_case");
  await client.query("release savepoint cancelled_handoff_claim_case");
  await assert.rejects(
    cancelTelegramAppHandoff({
      db: savepointPool as never,
      telegramUserId,
      token: cancelledHandoff.token,
      userId,
    }),
    (error: unknown) =>
      error instanceof TelegramAppHandoffError &&
      error.code === "not_cancellable",
    "a repeated Mini App cancel observes the already-cancelled trade",
  );
  assert.equal(
    (
      await client.query<{ state: string }>(
        `select state
           from telegram_app_handoffs
          where id = $1::uuid`,
        [cancelledHandoff.handoff.id],
      )
    ).rows[0]?.state,
    "cancelled",
    "terminal reconciliation commits before cancel returns not_cancellable",
  );
  await assert.rejects(
    materializeTelegramAppHandoffV2Funding({
      assertCurrentScope: async () => true,
      currentAuthorityFingerprint: "a".repeat(64),
      currentPolicyRevision: `policy-${suffix}`,
      db: savepointPool as never,
      planFingerprint: cancelledHandoff.handoff.planFingerprint,
      runtime: null as never,
      telegramUserId,
      token: cancelledHandoff.token,
      userId,
    }),
    (error: unknown) =>
      error instanceof TelegramAppHandoffError &&
      error.code === "not_committable",
    "the public v2 materializer preserves the cancelled commit error",
  );
  assert.equal(
    (
      await resolveTelegramAppHandoff({
        db: savepointPool as never,
        telegramUserId,
        token: cancelledHandoff.token,
        userId,
      })
    ).state,
    "cancelled",
    "an old Mini App tab observes Telegram cancellation instead of an issued loop",
  );

  const expiredIntentId = crypto.randomUUID();
  await client.query(
    `insert into telegram_trade_intents (
       id, telegram_user_id, user_id, chat_id, telegram_message_id, action,
       venue, market_id, event_id, side, shares_raw, status, quote_snapshot,
       result, expires_at, idempotency_key, delivery_mode
     ) select
       $1::uuid, telegram_user_id, user_id, chat_id, 3, action, venue,
       market_id, event_id, side, shares_raw, 'previewed', $2::jsonb,
       jsonb_build_object(
         'appHandoffV2', jsonb_build_object(
           'plan', $3::jsonb,
           'version', 2
         )
       ),
       now() + interval '5 minutes', $4::text, delivery_mode
     from telegram_trade_intents
     where id = $5::uuid`,
    [
      expiredIntentId,
      JSON.stringify(quoteSnapshot),
      JSON.stringify(planSnapshot),
      `handoff-expired:${suffix}`,
      intentId,
    ],
  );
  const expiredHandoff = await issueTelegramAppHandoff({
    authorityFingerprint: "a".repeat(64),
    db: savepointPool as never,
    planSnapshot,
    policyRevision: `policy-${suffix}`,
    quoteSnapshot,
    telegramUserId,
    tokenSecret: `expired-secret-${suffix}`,
    tradeIntentId: expiredIntentId,
    userId,
  });
  await client.query(
    `update telegram_trade_intents
        set expires_at = clock_timestamp() - interval '1 second'
      where id = $1::uuid`,
    [expiredIntentId],
  );
  await assert.rejects(
    resolveTelegramAppHandoff({
      db: savepointPool as never,
      telegramUserId,
      token: expiredHandoff.token,
      userId,
    }),
    (error: unknown) =>
      error instanceof TelegramAppHandoffError && error.code === "expired",
    "an expired Review atomically terminalizes its longer-lived handoff",
  );
  assert.deepEqual(
    (
      await client.query<{ handoff_state: string; intent_status: string }>(
        `select handoff_row.state as handoff_state,
                trade_intent.status as intent_status
           from telegram_trade_intents trade_intent
           join telegram_app_handoffs handoff_row
             on handoff_row.trade_intent_id = trade_intent.id
          where trade_intent.id = $1::uuid`,
        [expiredIntentId],
      )
    ).rows[0],
    { handoff_state: "expired", intent_status: "expired" },
  );
} finally {
  await client.query("rollback");
  client.release();
}
