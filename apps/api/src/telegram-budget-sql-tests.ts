import assert from "node:assert/strict";
import pg from "pg";
import { recordTelegramBuyBudget } from "./services/telegram-buy-budget.js";
import { refreshExpiredTelegramQuote } from "./services/telegram-quote-refresh.js";

const connectionString = process.env.TELEGRAM_BUDGET_TEST_DATABASE_URL;
assert.ok(connectionString, "Explicit disposable database URL required");
const target = new URL(connectionString);
assert.ok(["127.0.0.1", "localhost"].includes(target.hostname));
assert.equal(target.pathname, "/telegram_budget_disposable_20260915");
const db = new pg.Pool({ connectionString, max: 1, statement_timeout: 5000 });
try {
  assert.equal(
    (
      await db.query("show server_version_num")
    ).rows[0].server_version_num.slice(0, 2),
    "16",
  );
  await db.query(`create temporary table telegram_trade_intents (
    id uuid primary key default gen_random_uuid(), telegram_user_id text, user_id uuid,
    authorization_id uuid, chat_id text, telegram_message_id bigint,
    delivery_mode text, action text, venue text, market_id uuid, event_id uuid, side text,
    amount_usd numeric, sell_percent int, shares_raw text, status text,
    quote_snapshot jsonb, policy_snapshot jsonb, result jsonb,
    expires_at timestamptz, idempotency_key text unique, confirmed_at timestamptz,
    submit_started_at timestamptz, submitted_at timestamptz,
    funding_operation_id uuid, funding_reservation_id uuid, execution_id uuid, order_id uuid,
    venue_order_id text, tx_signature text, updated_at timestamptz
  );
  create temporary table telegram_app_handoffs (trade_intent_id uuid, state text);
  create temporary table telegram_bot_action_outbox (
    id uuid, trade_intent_id uuid, status text, action text, last_error text, updated_at timestamptz
  );`);
  const budget = { version: 1, amountUsd: 5 };
  const inserted = await db.query(
    `insert into telegram_trade_intents
    (telegram_user_id,chat_id,telegram_message_id,action,venue,delivery_mode,status,amount_usd,result)
    values ('tester','chat',1,'buy','polymarket','app_handoff','draft',5,$1::jsonb) returning id`,
    [JSON.stringify({ telegramBudget: budget, strictSlippage: true })],
  );
  const intentId = inserted.rows[0].id as string;
  assert.equal(
    await recordTelegramBuyBudget({
      db,
      intentId,
      budget,
      amountUsd: 4.75,
      spendLimitUsd: 5,
    }),
    true,
  );
  assert.equal(
    await recordTelegramBuyBudget({
      db,
      intentId,
      budget,
      amountUsd: 4.74,
      spendLimitUsd: 5,
    }),
    false,
  );
  assert.equal(
    (
      await db.query(
        "select amount_usd from telegram_trade_intents where id=$1",
        [intentId],
      )
    ).rows[0].amount_usd,
    "4.75",
  );
  await db.query(
    `update telegram_trade_intents set status='confirming',
    result=jsonb_build_object('telegramBudget',$2::jsonb) where id=$1`,
    [intentId, JSON.stringify(budget)],
  );
  assert.equal(
    await recordTelegramBuyBudget({
      db,
      intentId,
      budget,
      amountUsd: 4.5,
      spendLimitUsd: 5,
    }),
    false,
  );
  await db.query(
    `update telegram_trade_intents set status='expired',
    result=$2::jsonb where id=$1`,
    [
      intentId,
      JSON.stringify({
        telegramBudget: { ...budget, normalized: true },
        strictSlippage: true,
        quoteExpiredReview: true,
      }),
    ],
  );
  const fresh = await refreshExpiredTelegramQuote({
    db,
    intentId,
    telegramUserId: "tester",
    chatId: "chat",
    messageId: 1,
    ttlSec: 30,
  });
  assert.ok(fresh);
  const row = (
    await db.query("select * from telegram_trade_intents where id=$1", [
      fresh.id,
    ])
  ).rows[0];
  assert.equal(row.status, "draft");
  assert.deepEqual(row.result.telegramBudget, budget);
  assert.equal(row.result.strictSlippage, true);
  assert.equal(
    (
      await refreshExpiredTelegramQuote({
        db,
        intentId,
        telegramUserId: "tester",
        chatId: "chat",
        messageId: 1,
        ttlSec: 30,
      })
    )?.id,
    fresh.id,
  );
  await db.query(
    `update telegram_trade_intents set result='{}'::jsonb where id=$1`,
    [fresh.id],
  );
  assert.equal(
    await recordTelegramBuyBudget({
      db,
      intentId: fresh.id,
      budget,
      amountUsd: 4,
      spendLimitUsd: 5,
    }),
    false,
  );
  await db.query(
    `update telegram_trade_intents set status='expired',
    result='{"quoteExpiredReview":true}'::jsonb where id=$1`,
    [fresh.id],
  );
  const legacyRefresh = await refreshExpiredTelegramQuote({
    db,
    intentId: fresh.id,
    telegramUserId: "tester",
    chatId: "chat",
    messageId: 1,
    ttlSec: 30,
  });
  assert.ok(legacyRefresh);
  const legacyRow = (
    await db.query(
      "select amount_usd,result from telegram_trade_intents where id=$1",
      [legacyRefresh.id],
    )
  ).rows[0];
  assert.equal(legacyRow.amount_usd, "4.75");
  assert.equal(legacyRow.result.telegramBudget, undefined);
  assert.equal(legacyRow.result.strictSlippage, undefined);
  console.log(
    "PostgreSQL16: normalization CAS, confirmation fence, legacy fence, budget refresh and idempotency passed.",
  );
} finally {
  await db.end();
}
