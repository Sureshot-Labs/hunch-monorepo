import assert from "node:assert/strict";
import test from "node:test";

import { telegramBotTradingRouteTestHooks } from "./routes/telegram-bot-trading.js";
import {
  resolveTelegramFundingPrivateIdentity,
  TelegramFundingError,
} from "./services/telegram-funding.js";

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

await test("Telegram funding schemas accept only server-owned opaque inputs", () => {
  const identity = { chatId: "123", telegramUserId: 123 };
  const mutation = {
    ...identity,
    idempotencyKey: "funding:callback:123",
    telegramMessageId: 42,
  };
  assert.equal(
    telegramBotTradingRouteTestHooks.internalFundingOpenBodySchema.safeParse({
      ...mutation,
      venue: "polymarket",
    }).success,
    true,
  );
  assert.equal(
    telegramBotTradingRouteTestHooks.internalFundingSessionBodySchema.safeParse(
      {
        ...identity,
        contextId: "123e4567-e89b-42d3-a456-426614174000",
        view: "progress",
      },
    ).success,
    true,
  );
  assert.equal(
    telegramBotTradingRouteTestHooks.internalFundingSelectTargetBodySchema.safeParse(
      {
        ...mutation,
        contextId: "123e4567-e89b-42d3-a456-426614174000",
        choiceToken: "p",
      },
    ).success,
    true,
  );
  assert.equal(
    telegramBotTradingRouteTestHooks.internalFundingCancelBodySchema.safeParse({
      ...mutation,
      contextId: "123e4567-e89b-42d3-a456-426614174000",
    }).success,
    true,
  );
  assert.equal(
    telegramBotTradingRouteTestHooks.internalFundingOpenBodySchema.safeParse({
      ...mutation,
      venue: "polymarket",
      destinationAddress: "0x1111111111111111111111111111111111111111",
    }).success,
    false,
  );
});

await test("Telegram funding API private-chat identity is fail-closed", () => {
  assert.deepEqual(
    resolveTelegramFundingPrivateIdentity({
      chatId: 123,
      telegramUserId: "123",
    }),
    { chatId: "123", telegramUserId: "123" },
  );
  assert.throws(
    () =>
      resolveTelegramFundingPrivateIdentity({
        chatId: -100123,
        telegramUserId: 123,
      }),
    (error: unknown) =>
      error instanceof TelegramFundingError &&
      error.code === "private_chat_required",
  );
});
