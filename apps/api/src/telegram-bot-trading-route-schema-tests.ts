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
      appBaseUrl: "https://app.hunch.trade",
      telegramMiniAppEnabled: true,
      venue: "polymarket",
    }).success,
    true,
  );
  assert.equal(
    telegramBotTradingRouteTestHooks.internalFundingSessionBodySchema.safeParse(
      {
        ...identity,
        contextId: "123e4567-e89b-42d3-a456-426614174000",
        telegramMessageId: 42,
        view: "progress",
      },
    ).success,
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
    false,
  );
  assert.equal(
    telegramBotTradingRouteTestHooks.internalFundingSessionBodySchema.safeParse(
      {
        ...identity,
        contextId: "123e4567-e89b-42d3-a456-426614174000",
        deliveryProjection: {},
        view: "delivery",
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
    telegramBotTradingRouteTestHooks.internalFundingReviewBodySchema.safeParse({
      ...mutation,
      receiptId: "123e4567-e89b-42d3-a456-426614174000",
    }).success,
    true,
  );
  assert.equal(
    telegramBotTradingRouteTestHooks.internalFundingConfirmBodySchema.safeParse(
      {
        ...mutation,
        consentToken: `consent_${"a".repeat(43)}`,
      },
    ).success,
    true,
  );
  assert.equal(
    telegramBotTradingRouteTestHooks.internalFundingConfirmBodySchema.safeParse(
      {
        ...mutation,
        consentToken: "consent_too_short",
      },
    ).success,
    false,
  );
  assert.equal(
    telegramBotTradingRouteTestHooks.internalFundingResumeBuyBodySchema.safeParse(
      {
        ...identity,
        appBaseUrl: "https://app.hunch.trade",
        continuationToken: "AbCdEfGhIjKlMnOpQrStUv",
        idempotencyKey: "funding:resume:123",
        telegramMessageId: 42,
        telegramMiniAppEnabled: true,
      },
    ).success,
    true,
  );
  for (const forbidden of [
    { marketId: "market-1" },
    { side: "YES" },
    { amountUsd: 10 },
    { destinationOptionId: "destination-1" },
    { walletAddress: "0x1111111111111111111111111111111111111111" },
  ]) {
    assert.equal(
      telegramBotTradingRouteTestHooks.internalFundingResumeBuyBodySchema.safeParse(
        {
          ...identity,
          appBaseUrl: "https://app.hunch.trade",
          continuationToken: "AbCdEfGhIjKlMnOpQrStUv",
          idempotencyKey: "funding:resume:123",
          telegramMessageId: 42,
          ...forbidden,
        },
      ).success,
      false,
    );
  }
  assert.equal(
    telegramBotTradingRouteTestHooks.internalFundingOpenBodySchema.safeParse({
      ...mutation,
      appBaseUrl: "https://app.hunch.trade",
      venue: "polymarket",
      destinationAddress: "0x1111111111111111111111111111111111111111",
    }).success,
    false,
  );
  assert.equal(
    telegramBotTradingRouteTestHooks.internalFundingOpenBodySchema.safeParse({
      ...mutation,
      venue: "polymarket",
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

await test("Telegram custom trade input schemas accept identity and raw value only", () => {
  const contextId = "123e4567-e89b-42d3-a456-426614174000";
  assert.equal(
    telegramBotTradingRouteTestHooks.internalTradeInputParamsSchema.safeParse({
      id: contextId,
    }).success,
    true,
  );
  assert.equal(
    telegramBotTradingRouteTestHooks.internalTradeInputBeginBodySchema.safeParse(
      {
        action: "sell",
        chatId: "123",
        telegramMessageId: 42,
        telegramUserId: 123,
      },
    ).success,
    true,
  );
  assert.equal(
    telegramBotTradingRouteTestHooks.internalTradeInputCompleteBodySchema.safeParse(
      {
        appBaseUrl: "https://dev.hunch.trade",
        chatId: "123",
        telegramMessageId: 43,
        telegramMiniAppEnabled: true,
        telegramUserId: 123,
        value: "25%",
      },
    ).success,
    true,
  );
  for (const appBaseUrl of [undefined, "not-a-url"]) {
    assert.equal(
      telegramBotTradingRouteTestHooks.internalTradeInputCompleteBodySchema.safeParse(
        {
          ...(appBaseUrl === undefined ? {} : { appBaseUrl }),
          chatId: "123",
          telegramMessageId: 43,
          telegramUserId: 123,
          value: "25%",
        },
      ).success,
      false,
    );
  }
  for (const forbidden of [
    { marketId: "market-1" },
    { side: "YES" },
    { venue: "polymarket" },
    { walletAddress: "0x1111111111111111111111111111111111111111" },
    { amountUsd: 10 },
    { sharesRaw: "1000000" },
  ]) {
    assert.equal(
      telegramBotTradingRouteTestHooks.internalTradeInputCompleteBodySchema.safeParse(
        {
          appBaseUrl: "https://dev.hunch.trade",
          chatId: "123",
          telegramMessageId: 43,
          telegramUserId: 123,
          value: "1",
          ...forbidden,
        },
      ).success,
      false,
    );
  }
});
