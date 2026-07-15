import assert from "node:assert/strict";

import { handleSignalBotInteractiveMenuCallback } from "./services/telegram-bot-menu-actions.js";
import {
  buildSignalBotMarketSearchScreen,
  writeSignalBotMarketSearchSession,
} from "./services/telegram-bot-menu-markets.js";
import {
  handleSignalBotMarketSearchInput,
  isDirectMarketReference,
} from "./services/telegram-bot-menu-search-input.js";
import { writeSignalBotMenuInput } from "./services/telegram-bot-menu-state.js";
import { TELEGRAM_MESSAGE_PAYLOAD_BUDGET } from "./services/telegram-bot-text-budget.js";

function redisStore() {
  const values = new Map<string, string>();
  return {
    del: async (key: string) => values.delete(key),
    get: async (key: string) => values.get(key) ?? null,
    set: async (key: string, value: string) => {
      values.set(key, value);
      return "OK";
    },
    values,
  };
}

const sampleResult = {
  eventId: "event-1",
  eventTitle: "World Cup Winner",
  lastPrice: 0.21,
  marketId: "fa929c1e-c31e-4f03-8924-2e71985a40b7",
  marketTitle: "Spain wins the World Cup",
  noAsk: 0.8,
  venue: "polymarket",
  yesAsk: 0.21,
};

const tests: Array<{ name: string; run: () => Promise<void> | void }> = [
  {
    name: "free-text search sends progress below the input and edits the new card",
    run: async () => {
      const redis = redisStore();
      await writeSignalBotMenuInput({
        chatId: "10",
        menuMessageId: 42,
        redis,
        telegramUserId: 20,
      });
      const events: string[] = [];
      await handleSignalBotMarketSearchInput({
        beginResponse: async (message) => {
          events.push(`send:${message.text}`);
          return 99;
        },
        callbackPrefix: "hm:v1:",
        chatId: "10",
        redis,
        render: async (message, messageId) => {
          events.push(`edit:${messageId}:${message.text}`);
        },
        renderCancelled: async () => undefined,
        searchMarkets: async () => [sampleResult],
        telegramUserId: 20,
        text: "Spain",
      });
      assert.equal(events[0]?.startsWith("send:"), true);
      assert.match(events[0] ?? "", /Searching/);
      assert.equal(events[1]?.startsWith("edit:99:"), true);
      assert.match(events[1] ?? "", /Results/);
    },
  },
  {
    name: "direct market references include canonical UUIDs",
    run: () => {
      assert.equal(isDirectMarketReference(sampleResult.marketId), true);
      assert.equal(
        isDirectMarketReference(sampleResult.marketId.toUpperCase()),
        true,
      );
      assert.equal(
        isDirectMarketReference("https://polymarket.com/event/x"),
        true,
      );
      assert.equal(isDirectMarketReference("limitless:123"), true);
      assert.equal(isDirectMarketReference("123456"), true);
      assert.equal(isDirectMarketReference("world cup"), false);
    },
  },
  {
    name: "canonical UUID bypasses full-text search",
    run: async () => {
      const redis = redisStore();
      await writeSignalBotMenuInput({
        chatId: "10",
        menuMessageId: 42,
        redis,
        telegramUserId: 20,
      });
      let directCalls = 0;
      let searchCalls = 0;
      await handleSignalBotMarketSearchInput({
        callbackPrefix: "hm:v1:",
        chatId: "10",
        loadMarketCard: async () => {
          directCalls += 1;
          return { text: "Market card" };
        },
        redis,
        render: async () => undefined,
        renderCancelled: async () => undefined,
        searchMarkets: async () => {
          searchCalls += 1;
          return [];
        },
        telegramUserId: 20,
        text: sampleResult.marketId,
      });
      assert.equal(directCalls, 1);
      assert.equal(searchCalls, 0);
    },
  },
  {
    name: "search outage stays retryable and does not create an empty session",
    run: async () => {
      const redis = redisStore();
      await writeSignalBotMenuInput({
        chatId: "10",
        menuMessageId: 42,
        redis,
        telegramUserId: 20,
      });
      let rendered = "";
      await handleSignalBotMarketSearchInput({
        callbackPrefix: "hm:v1:",
        chatId: "10",
        redis,
        render: async (message) => {
          rendered = message.text;
        },
        renderCancelled: async () => undefined,
        searchMarkets: async () => {
          throw new Error("timeout");
        },
        telegramUserId: 20,
        text: "Spain",
      });
      assert.match(rendered, /temporarily unavailable/);
      assert.equal(
        Array.from(redis.values.keys()).some((key) =>
          key.includes("market_search"),
        ),
        false,
      );
    },
  },
  {
    name: "one-character text stays in input mode without searching",
    run: async () => {
      const redis = redisStore();
      await writeSignalBotMenuInput({
        chatId: "10",
        menuMessageId: 42,
        redis,
        telegramUserId: 20,
      });
      let searchCalls = 0;
      let rendered = "";
      await handleSignalBotMarketSearchInput({
        callbackPrefix: "hm:v1:",
        chatId: "10",
        redis,
        render: async (message) => {
          rendered = message.text;
        },
        renderCancelled: async () => undefined,
        searchMarkets: async () => {
          searchCalls += 1;
          return [];
        },
        telegramUserId: 20,
        text: "S",
      });
      assert.equal(searchCalls, 0);
      assert.match(rendered, /at least 2 characters/);
    },
  },
  {
    name: "genuine empty search remains active and creates a bounded session",
    run: async () => {
      const redis = redisStore();
      await writeSignalBotMenuInput({
        chatId: "10",
        menuMessageId: 42,
        redis,
        telegramUserId: 20,
      });
      let rendered = "";
      await handleSignalBotMarketSearchInput({
        callbackPrefix: "hm:v1:",
        chatId: "10",
        redis,
        render: async (message) => {
          rendered = message.text;
        },
        renderCancelled: async () => undefined,
        searchMarkets: async () => [],
        telegramUserId: 20,
        text: "No such market",
      });
      assert.match(rendered, /No active markets found/);
      assert.equal(
        Array.from(redis.values.keys()).some((key) =>
          key.includes("market_search"),
        ),
        true,
      );
    },
  },
  {
    name: "stale session result keeps Back to results",
    run: async () => {
      const redis = redisStore();
      const sessionId = await writeSignalBotMarketSearchSession({
        chatId: "10",
        query: "Spain",
        redis,
        results: [sampleResult],
        telegramUserId: 20,
      });
      const rendered: Array<{ text: string; reply_markup?: unknown }> = [];
      await handleSignalBotInteractiveMenuCallback({
        callbackPrefix: "hm:v1:",
        chatId: "10",
        loadMarketCard: async () => ({ marketFound: false, text: "gone" }),
        messageId: 42,
        redis,
        render: async (message) => {
          rendered.push(message);
        },
        renderExpiredSearch: async () => {
          throw new Error("session should still be valid");
        },
        route: { index: 0, kind: "market_search_result", sessionId },
        telegramUserId: 20,
      });
      const lastMessage = rendered.at(-1);
      assert.ok(lastMessage);
      assert.match(lastMessage.text, /no longer available/);
      assert.match(JSON.stringify(lastMessage), /Back to results/);
    },
  },
  {
    name: "long Unicode search results stay inside Telegram budgets",
    run: () => {
      const message = buildSignalBotMarketSearchScreen({
        callbackPrefix: "hm:v1:",
        query: "🏆".repeat(300),
        results: Array.from({ length: 5 }, (_, index) => ({
          ...sampleResult,
          marketId: crypto.randomUUID(),
          marketTitle: `${"👨‍👩‍👧‍👦".repeat(300)} ${index}`,
        })),
        sessionId: "123456789abc",
      });
      assert.ok(
        Array.from(message.text).length <= TELEGRAM_MESSAGE_PAYLOAD_BUDGET,
      );
      const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
      for (const row of message.reply_markup.inline_keyboard) {
        for (const button of row) {
          assert.ok(Array.from(segmenter.segment(button.text)).length <= 64);
          assert.ok(button.callback_data.length <= 64);
        }
      }
    },
  },
];

for (const test of tests) {
  try {
    await test.run();
    console.log(`✓ ${test.name}`);
  } catch (error) {
    console.error(`✗ ${test.name}`);
    throw error;
  }
}
