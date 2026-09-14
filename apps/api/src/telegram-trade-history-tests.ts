import assert from "node:assert/strict";

import type { Pool } from "@hunch/infra";

import {
  COMPLETED_EXECUTION_STATUSES,
  COMPLETED_ORDER_STATUSES,
} from "./services/completed-trade-semantics.js";
import { TELEGRAM_CUSTOM_EMOJI } from "./services/telegram-custom-emoji.js";
import {
  buildTelegramTradeHistorySnapshotMessage,
  loadTelegramTradeHistory,
  TELEGRAM_TRADE_HISTORY_LIMIT,
  telegramBotTradeHistoryTestHooks,
  type TelegramTradeHistoryEntry,
} from "./services/telegram-bot-trade-history.js";
import {
  TELEGRAM_MESSAGE_PAYLOAD_BUDGET,
  telegramPayloadLength,
} from "./services/telegram-bot-text-budget.js";
import { createTelegramBotTradingInternalApiClient } from "./services/telegram-bot-trading-client.js";

function trade(
  overrides: Partial<TelegramTradeHistoryEntry> = {},
): TelegramTradeHistoryEntry {
  return {
    action: "BUY",
    eventTitle: "World Cup winner",
    marketTitle: "Spain wins the World Cup",
    notionalUsd: 12.5,
    outcome: "YES",
    price: 0.5,
    shares: 25,
    tradedAt: new Date("2026-09-14T12:34:00.000Z"),
    venue: "polymarket",
    ...overrides,
  };
}

const tests: Array<{ name: string; run: () => Promise<void> | void }> = [
  {
    name: "history renders ten completed trades with semantic custom and native emoji",
    run: () => {
      const trades = Array.from({ length: 12 }, (_, index) =>
        trade({
          action: index % 2 === 0 ? "BUY" : "SELL",
          marketTitle: `Market ${index + 1}`,
          outcome: index === 1 ? "Candidate (A)" : "YES",
          venue:
            index % 3 === 0
              ? "polymarket"
              : index % 3 === 1
                ? "limitless"
                : "kalshi",
        }),
      );
      const message = buildTelegramTradeHistorySnapshotMessage({
        snapshot: { trades },
      });

      assert.match(message.text, /📜 \*Trading History\*/u);
      assert.match(message.text, /Your 10 most recent completed trades/u);
      assert.match(message.text, /🎯 \*World Cup winner\*/u);
      assert.match(message.text, /🕒 Sep 14, 2026/u);
      assert.match(message.text, /\*Market:\* Market 10/u);
      assert.match(message.text, /Candidate \\\(A\\\)/u);
      assert.doesNotMatch(message.text, /Market 11/u);
      assert.match(
        message.text,
        new RegExp(TELEGRAM_CUSTOM_EMOJI.positionBuy.id),
      );
      assert.match(
        message.text,
        new RegExp(TELEGRAM_CUSTOM_EMOJI.positionSell.id),
      );
      assert.match(
        message.text,
        new RegExp(TELEGRAM_CUSTOM_EMOJI.polymarket.id),
      );
      assert.match(
        message.text,
        new RegExp(TELEGRAM_CUSTOM_EMOJI.limitless.id),
      );
      assert.match(message.text, new RegExp(TELEGRAM_CUSTOM_EMOJI.kalshi.id));
      assert.match(message.text, new RegExp(TELEGRAM_CUSTOM_EMOJI.usdc.id));
      assert.ok(
        telegramPayloadLength(message.text) <= TELEGRAM_MESSAGE_PAYLOAD_BUDGET,
      );
      assert.deepEqual(message.reply_markup?.inline_keyboard, [
        [{ callback_data: "hm:v1:trade_history", text: "🔄 Refresh" }],
        [{ callback_data: "hm:v1:home", text: "🏠 Home" }],
      ]);
    },
  },
  {
    name: "order and swap rows normalize actual fill amounts consistently",
    run: () => {
      const order = telegramBotTradeHistoryTestHooks.mapTradeHistoryRow({
        action: "SELL",
        amount_in: null,
        amount_out: null,
        event_title: null,
        input_decimals: null,
        kind: "order",
        market_title: "Rate cut in September?",
        outcome: null,
        outcome_side: "NO",
        outcomes: '["Yes", "No"]',
        output_decimals: null,
        price: "0.625",
        shares: "4",
        traded_at: "2026-09-14T08:00:00.000Z",
        venue: "limitless",
      });
      assert.ok(order);
      assert.equal(order.action, "SELL");
      assert.equal(order.outcome, "NO");
      assert.equal(order.shares, 4);
      assert.equal(order.price, 0.625);
      assert.equal(order.notionalUsd, 2.5);

      const swap = telegramBotTradeHistoryTestHooks.mapTradeHistoryRow({
        action: "BUY",
        amount_in: "12500000",
        amount_out: "25000000",
        event_title: "Fed decision",
        input_decimals: 6,
        kind: "swap",
        market_title: "September cut",
        outcome: "YES",
        outcome_side: null,
        outcomes: '["Yes", "No"]',
        output_decimals: 6,
        price: null,
        shares: null,
        traded_at: new Date("2026-09-14T09:00:00.000Z"),
        venue: "kalshi",
      });
      assert.ok(swap);
      assert.equal(swap.shares, 25);
      assert.equal(swap.notionalUsd, 12.5);
      assert.equal(swap.price, 0.5);

      const unknownOutcome =
        telegramBotTradeHistoryTestHooks.mapTradeHistoryRow({
          action: "BUY",
          amount_in: null,
          amount_out: null,
          event_title: null,
          input_decimals: null,
          kind: "order",
          market_title: "Legacy market",
          outcome: null,
          outcome_side: null,
          outcomes: '["Yes", "No"]',
          output_decimals: null,
          price: "0.5",
          shares: "2",
          traded_at: "2026-09-14T10:00:00.000Z",
          venue: "polymarket",
        });
      assert.equal(unknownOutcome?.outcome, "Outcome unavailable");

      assert.equal(
        telegramBotTradeHistoryTestHooks.mapTradeHistoryRow({
          action: null,
          amount_in: null,
          amount_out: null,
          event_title: null,
          input_decimals: null,
          kind: "order",
          market_title: "Malformed market",
          outcome: null,
          outcome_side: "YES",
          outcomes: null,
          output_decimals: null,
          price: "0.5",
          shares: "2",
          traded_at: "2026-09-14T10:00:00.000Z",
          venue: "polymarket",
        }),
        null,
      );
      assert.equal(
        telegramBotTradeHistoryTestHooks.mapTradeHistoryRow({
          action: "BUY",
          amount_in: null,
          amount_out: null,
          event_title: null,
          input_decimals: null,
          kind: "order",
          market_title: "Malformed market",
          outcome: null,
          outcome_side: "YES",
          outcomes: null,
          output_decimals: null,
          price: "0.5",
          shares: "2",
          traded_at: null,
          venue: "polymarket",
        }),
        null,
      );
    },
  },
  {
    name: "history loader reads the linked account and limits the completed ledger to ten",
    run: async () => {
      const queries: Array<{ params: unknown[]; sql: string }> = [];
      const pool = {
        query: async (sql: string, params: unknown[] = []) => {
          queries.push({ params, sql });
          if (/from user_telegram_accounts/u.test(sql)) {
            return {
              rows: [
                {
                  link_id: "22222222-2222-4222-8222-222222222222",
                  user_id: "11111111-1111-4111-8111-111111111111",
                },
              ],
            };
          }
          return {
            rows: [
              {
                action: "BUY",
                amount_in: null,
                amount_out: null,
                event_title: null,
                input_decimals: null,
                kind: "order",
                market_title: "A filled market",
                outcome: null,
                outcome_side: "YES",
                outcomes: null,
                output_decimals: null,
                price: "0.5",
                shares: "2",
                traded_at: new Date("2026-09-14T10:00:00.000Z"),
                venue: "polymarket",
              },
            ],
          };
        },
      } as unknown as Pool;

      const loaded = await loadTelegramTradeHistory({
        pool,
        telegramUserId: 42,
      });
      assert.equal(loaded.linked, true);
      assert.equal(loaded.snapshot.trades.length, 1);
      assert.deepEqual(queries[0]?.params, ["42"]);
      assert.match(queries[0]?.sql ?? "", /join users u/u);
      assert.match(queries[0]?.sql ?? "", /coalesce\(u\.is_active, true\)/u);
      assert.deepEqual(queries[1]?.params, [
        "11111111-1111-4111-8111-111111111111",
        COMPLETED_ORDER_STATUSES,
        COMPLETED_EXECUTION_STATUSES,
        TELEGRAM_TRADE_HISTORY_LIMIT,
      ]);
      const ledgerSql = queries[1]?.sql ?? "";
      assert.match(ledgerSql, /from orders o/u);
      assert.match(ledgerSql, /coalesce\(o\.filled_size, 0\) > 0/u);
      assert.match(ledgerSql, /coalesce\(o\.average_fill_price, 0\) > 0/u);
      assert.match(ledgerSql, /from executions execution/u);
      assert.match(
        ledgerSql,
        /execution\.status, ''\)\) = any\(\$3::text\[\]\)/u,
      );
      assert.match(ledgerSql, /order by trade\.traded_at desc nulls last/u);
      assert.match(ledgerSql, /limit \$4/u);
    },
  },
  {
    name: "internal client uses the dedicated trading-history endpoint",
    run: async () => {
      const originalFetch = globalThis.fetch;
      let capturedUrl = "";
      let capturedBody: unknown = null;
      globalThis.fetch = (async (url, init) => {
        capturedUrl = String(url);
        capturedBody = JSON.parse(String(init?.body ?? "null"));
        return Response.json({ parse_mode: "MarkdownV2", text: "History" });
      }) as typeof fetch;
      try {
        const client = createTelegramBotTradingInternalApiClient({
          baseUrl: "https://internal.hunch.test/",
          token: "test-token",
        });
        const message = await client.buildTradeHistoryMessage(42);
        assert.equal(message.text, "History");
        assert.equal(
          capturedUrl,
          "https://internal.hunch.test/internal/telegram-bot/trading-history",
        );
        assert.deepEqual(capturedBody, { telegramUserId: 42 });
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  },
  {
    name: "empty history explains what will appear without exposing order failures",
    run: () => {
      const message = buildTelegramTradeHistorySnapshotMessage({
        snapshot: { trades: [] },
      });
      assert.match(message.text, /No completed trades yet/u);
      assert.match(message.text, /Filled Buy and Sell trades/u);
      assert.doesNotMatch(message.text, /failed|cancelled/iu);
    },
  },
];

let passed = 0;
for (const test of tests) {
  try {
    await test.run();
    passed += 1;
  } catch (error) {
    console.error(`[telegram-trade-history-tests] failed: ${test.name}`);
    throw error;
  }
}

console.log(`[telegram-trade-history-tests] passed ${passed}/${tests.length}`);
