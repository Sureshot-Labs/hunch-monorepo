import assert from "node:assert/strict";
import test from "node:test";

import { telegramBotTradingRouteTestHooks } from "./routes/telegram-bot-trading.js";

await test("internal market-card route accepts observed search asks", () => {
  const result =
    telegramBotTradingRouteTestHooks.internalMarketCardBodySchema.safeParse({
      appBaseUrl: "https://app.hunch.trade",
      chatId: "123",
      context: {
        observedNoAsk: null,
        observedYesAsk: 0.98,
        origin: "search",
        returnCallbackData: "hm:v1:search_back:123456789abc",
      },
      marketRef: "polymarket:1393325",
      telegramMiniAppEnabled: true,
      telegramUserId: "456",
    });

  assert.equal(result.success, true);
  if (!result.success) return;
  assert.equal(result.data.context?.observedNoAsk, null);
  assert.equal(result.data.context?.observedYesAsk, 0.98);
});

await test("internal market-card route rejects out-of-range observed asks", () => {
  const result =
    telegramBotTradingRouteTestHooks.internalMarketCardBodySchema.safeParse({
      appBaseUrl: "https://app.hunch.trade",
      chatId: "123",
      context: {
        observedYesAsk: 1.01,
        origin: "search",
      },
      marketRef: "polymarket:1393325",
      telegramUserId: "456",
    });

  assert.equal(result.success, false);
});
