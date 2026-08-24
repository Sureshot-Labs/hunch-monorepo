import assert from "node:assert/strict";

import {
  completeTelegramBotTradeInput,
  parseTelegramCustomBuyAmount,
  parseTelegramCustomSellAmount,
  resolveTelegramCustomSellSides,
  telegramBotTradingTestHooks,
} from "./services/telegram-bot-trading.js";
import { parseTelegramBotTradingCallbackData } from "./services/telegram-bot-trading-client.js";
import {
  clearSignalBotMenuInput,
  clearSignalBotMenuInputIfCurrent,
  readSignalBotMenuInput,
  writeSignalBotTradeMenuInput,
} from "./services/telegram-bot-menu-state.js";
import {
  readTelegramBotTradeInputContext,
  telegramBotTradeInputMessageScopeMatches,
  writeTelegramBotTradeInputContext,
  type TelegramBotTradeInputContext,
} from "./services/telegram-bot-trade-input-context.js";
import {
  beginSignalBotTradeInput,
  cancelSignalBotTradeInput,
  handleSignalBotTradeInput,
} from "./services/telegram-bot-trade-input.js";
import type { TelegramInlineKeyboard } from "./services/signal-bot-contracts.js";
import { handleTelegramBotRewardsInput } from "./services/telegram-bot-rewards-menu.js";

class FakeRedis {
  readonly values = new Map<string, string>();

  async get(key: string) {
    return this.values.get(key) ?? null;
  }

  async del(key: string) {
    return this.values.delete(key) ? 1 : 0;
  }

  async set(key: string, value: string) {
    this.values.set(key, value);
    return "OK";
  }

  async eval(script: string, options: { arguments: string[]; keys: string[] }) {
    if (script.includes("redis.call('SET'")) {
      for (const key of options.keys) {
        this.values.set(key, options.arguments[0] ?? "");
      }
      return 1;
    }
    let cleared = false;
    for (const key of options.keys) {
      const raw = this.values.get(key);
      if (!raw) continue;
      const state = JSON.parse(raw) as { stateToken?: string };
      if (state.stateToken !== options.arguments[0]) continue;
      this.values.delete(key);
      cleared = true;
    }
    return cleared ? 1 : 0;
  }
}

assert.deepEqual(parseTelegramCustomBuyAmount("$2.50"), {
  amountUsd: 2.5,
  normalized: "2.50",
});

assert.equal(
  telegramBotTradingTestHooks.isTelegramEstimatedSellProceeds({
    raw: { kind: "limitless_clob" },
    venue: "limitless",
  } as never),
  true,
  "Limitless CLOB FOK has no provider-enforced proceeds floor",
);
assert.equal(
  telegramBotTradingTestHooks.isTelegramEstimatedSellProceeds({
    raw: { kind: "limitless_amm" },
    venue: "limitless",
  } as never),
  false,
  "the exact AMM Sell transaction retains its sealed minimum receive",
);
assert.equal(
  telegramBotTradingTestHooks.isTelegramSellProceedsDisplayable(0.009),
  false,
  "a Sell that renders as $0.00 must not be advertised",
);
assert.equal(
  telegramBotTradingTestHooks.isTelegramSellProceedsDisplayable(0.01),
  true,
);
for (const value of ["0", "-1", "+1", "1.001", "1e2", "1,25", "1 usd"]) {
  assert.equal(parseTelegramCustomBuyAmount(value), null, value);
}

const availableRaw = 1_517_448n;
assert.deepEqual(parseTelegramCustomSellAmount("1.25", availableRaw), {
  inputMode: "shares",
  normalized: "1.25",
  sellPercent: null,
  sharesRaw: 1_250_000n,
});
assert.deepEqual(parseTelegramCustomSellAmount("25%", availableRaw), {
  inputMode: "percent",
  normalized: "25%",
  sellPercent: 25,
  sharesRaw: 379_362n,
});
assert.deepEqual(parseTelegramCustomSellAmount("12.5%", availableRaw), {
  inputMode: "percent",
  normalized: "12.5%",
  sellPercent: 12.5,
  sharesRaw: 189_681n,
});
assert.deepEqual(parseTelegramCustomSellAmount("100%", availableRaw), {
  inputMode: "percent",
  normalized: "100%",
  sellPercent: 100,
  sharesRaw: availableRaw,
});
assert.deepEqual(parseTelegramCustomSellAmount("all", availableRaw), {
  inputMode: "all",
  normalized: "all",
  sellPercent: 100,
  sharesRaw: availableRaw,
});
assert.deepEqual(
  resolveTelegramCustomSellSides([
    { side: "YES", options: [] },
    { side: "NO", options: [{} as never] },
  ]),
  ["NO"],
  "dust without an executable quote must not expose Custom sell",
);
for (const value of [
  "0",
  "0%",
  "100.1%",
  "-1",
  "+1",
  "1e2",
  "1,25",
  "all shares",
  "1.517449",
]) {
  assert.equal(parseTelegramCustomSellAmount(value, availableRaw), null, value);
}

const contextId = "3e5ba516-192c-4b0b-96ff-6683399def41";
assert.deepEqual(
  parseTelegramBotTradingCallbackData(`hbt:buy_input:${contextId}`),
  { inputContextId: contextId, type: "buy_input" },
);
assert.ok(Buffer.byteLength(`hbt:sell_input:${contextId}`, "utf8") < 64);
assert.equal(
  telegramBotTradeInputMessageScopeMatches({ kind: "new_message_unbound" }, 99),
  true,
);
assert.equal(
  telegramBotTradeInputMessageScopeMatches(
    { kind: "exact_message", messageId: 12 },
    12,
  ),
  true,
);
assert.equal(
  telegramBotTradeInputMessageScopeMatches(
    { kind: "exact_message", messageId: 12 },
    13,
  ),
  false,
);

const executableSellQuote = {
  action: "SELL",
  raw: { makerAmount: "1230000" },
  venue: "polymarket",
};
assert.equal(
  telegramBotTradingTestHooks.resolveExecutablePolymarketSellSharesRaw({
    availableRaw: 1_517_448n,
    quote: executableSellQuote as never,
    requestedRaw: 1_234_567n,
  }),
  1_230_000n,
);
for (const makerAmount of [undefined, "", "0", "1234568", "1.23", "-1"]) {
  assert.equal(
    telegramBotTradingTestHooks.resolveExecutablePolymarketSellSharesRaw({
      availableRaw: 1_517_448n,
      quote: {
        action: "SELL",
        raw: makerAmount === undefined ? {} : { makerAmount },
        venue: "polymarket",
      } as never,
      requestedRaw: 1_234_567n,
    }),
    null,
    String(makerAmount),
  );
}

assert.equal(
  telegramBotTradingTestHooks.resolveExecutableTelegramSellSharesRaw({
    availableRaw: 1_517_448n,
    quote: { action: "SELL", raw: {}, venue: "limitless" } as never,
    requestedRaw: 1_234_567n,
  }),
  1_234_567n,
  "Limitless custom Sell uses the exact ready quote quantity rather than Polymarket makerAmount",
);

const sellSurfaceInput = {
  authorizationEnabled: true,
  authorizationHasPrivyWallet: true,
  authorizationVenueAllowed: true,
  authorityBound: true,
  automationAllowed: true,
  focusedPositionControlled: false,
  hasFocusedPosition: false,
  isAdminTest: false,
  marketOrderable: true,
  policyTradingEnabled: true,
  policyVenueAllowed: true,
  publicBrowseOnly: false,
  sellActionAllowed: true,
  sellLifecycleAllowed: true,
  tradingAvailable: true,
  unresolvedIntent: false,
  venue: "polymarket",
};
assert.equal(
  telegramBotTradingTestHooks.canAttemptSellSurface(sellSurfaceInput),
  true,
);
assert.equal(
  telegramBotTradingTestHooks.canAttemptSellSurface({
    ...sellSurfaceInput,
    authorizationEnabled: false,
    authorizationHasPrivyWallet: false,
    authorizationVenueAllowed: false,
    automationAllowed: false,
    policyVenueAllowed: false,
    sealedAppHandoffAvailable: true,
    venue: "limitless",
  }),
  true,
  "a sealed handoff Sell does not require server trading authority",
);
for (const unavailable of [
  { policyTradingEnabled: false },
  { sellActionAllowed: false },
  { policyVenueAllowed: false },
  { authorizationVenueAllowed: false },
  { marketOrderable: false },
  { sellLifecycleAllowed: false },
  { venue: "limitless" },
]) {
  assert.equal(
    telegramBotTradingTestHooks.canAttemptSellSurface({
      ...sellSurfaceInput,
      ...unavailable,
    }),
    false,
  );
}
assert.equal(
  telegramBotTradingTestHooks.canAttemptSellSurface({
    ...sellSurfaceInput,
    focusedPositionControlled: false,
    hasFocusedPosition: true,
  }),
  false,
);
assert.equal(
  telegramBotTradingTestHooks.canAttemptSellSurface({
    ...sellSurfaceInput,
    focusedPositionControlled: true,
    hasFocusedPosition: true,
  }),
  true,
);

const environmentMarketUrl = telegramBotTradingTestHooks.openMarketUrl(
  "https://staging.hunch.trade",
  {
    event_id: "event-1",
    id: "market-1",
  } as never,
);
assert.match(environmentMarketUrl, /^https:\/\/staging\.hunch\.trade\//u);
assert.doesNotMatch(environmentMarketUrl, /app\.hunch\.trade/u);
const convertUrl = new URL(environmentMarketUrl);
convertUrl.searchParams.set("deposit", "convert");
for (const [text, path] of [
  ["Open market", environmentMarketUrl],
  ["Convert", convertUrl.toString()],
] as const) {
  const button = telegramBotTradingTestHooks.buildTelegramTradingMiniAppButton({
    appBaseUrl: "https://staging.hunch.trade",
    path,
    telegramMiniAppEnabled: true,
    text,
  });
  assert.ok(button && "web_app" in button);
  if (button && "web_app" in button) {
    assert.match(button.web_app.url, /^https:\/\/staging\.hunch\.trade\//u);
    assert.doesNotMatch(button.web_app.url, /app\.hunch\.trade/u);
  }
}

const redis = new FakeRedis();
const context: TelegramBotTradeInputContext = {
  action: "sell",
  authority: {
    authorizationId: "00000000-0000-4000-8000-000000000002",
    privyWalletId: "wallet-1",
    telegramAccountLinkId: "00000000-0000-4000-8000-000000000003",
    userId: "00000000-0000-4000-8000-000000000004",
    walletAddress: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
    walletChain: "ethereum",
  },
  chatId: "42",
  controlledPositionId: null,
  createdAt: new Date().toISOString(),
  eventId: "event-1",
  expiresAt: new Date(Date.now() + 120_000).toISOString(),
  funderAddress: null,
  id: contextId,
  marketId: "market-1",
  messageScope: { kind: "exact_message", messageId: 12 },
  side: "NO",
  telegramUserId: "42",
  venue: "polymarket",
  version: 2,
};
const currentAuthority = {
  enabled: true,
  enabled_venues: ["polymarket"],
  id: context.authority.authorizationId,
  max_amount_usd: "25",
  privy_user_id: "privy-1",
  privy_wallet_id: context.authority.privyWalletId,
  telegram_account_link_id: context.authority.telegramAccountLinkId,
  telegram_user_id: context.telegramUserId,
  user_id: context.authority.userId,
  wallet_address: `0x${context.authority.walletAddress.slice(2).toUpperCase()}`,
  wallet_chain: context.authority.walletChain,
};
assert.equal(
  telegramBotTradingTestHooks.sameTelegramTradeAuthorityBinding(
    context.authority,
    currentAuthority as never,
  ),
  true,
);
assert.equal(
  telegramBotTradingTestHooks.sameTelegramTradeAuthorityBinding(
    context.authority,
    {
      ...currentAuthority,
      wallet_address: context.authority.walletAddress.toUpperCase(),
    } as never,
  ),
  false,
  "an uppercase 0X prefix is malformed and must not alias a valid EVM address",
);
for (const changed of [
  { id: "00000000-0000-4000-8000-000000000009" },
  { privy_wallet_id: "wallet-2" },
  { telegram_account_link_id: "00000000-0000-4000-8000-000000000009" },
  { user_id: "00000000-0000-4000-8000-000000000009" },
  { wallet_address: "0x0000000000000000000000000000000000000002" },
]) {
  assert.equal(
    telegramBotTradingTestHooks.sameTelegramTradeAuthorityBinding(
      context.authority,
      { ...currentAuthority, ...changed } as never,
    ),
    false,
  );
}
assert.equal(await writeTelegramBotTradeInputContext({ context, redis }), true);
assert.deepEqual(
  await readTelegramBotTradeInputContext({ id: contextId, redis }),
  context,
);
redis.values.set(
  `tg:signal_bot:v2:trade_input_context:${contextId}`,
  JSON.stringify({ ...context, version: 1 }),
);
assert.equal(
  await readTelegramBotTradeInputContext({ id: contextId, redis }),
  null,
);
assert.equal(await writeTelegramBotTradeInputContext({ context, redis }), true);

const expiredContext = {
  ...context,
  id: "ff6500e4-4115-4e9d-a77e-cdc3cb84df21",
  expiresAt: new Date(Date.now() - 1_000).toISOString(),
};
redis.values.set(
  `tg:signal_bot:v2:trade_input_context:${expiredContext.id}`,
  JSON.stringify(expiredContext),
);
assert.equal(
  await readTelegramBotTradeInputContext({
    id: expiredContext.id,
    redis,
  }),
  null,
);
redis.values.set(
  "tg:signal_bot:v2:trade_input_context:64ab553e-1b1d-4ae2-9083-bdeac5c5241c",
  "{malformed",
);
assert.equal(
  await readTelegramBotTradeInputContext({
    id: "64ab553e-1b1d-4ae2-9083-bdeac5c5241c",
    redis,
  }),
  null,
);

redis.values.set(
  "tg:signal_bot:v1:menu_input:42:42",
  JSON.stringify({
    contextId: "",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    kind: "awaiting_custom_buy_amount",
    menuMessageId: 12,
    stateToken: "not-a-uuid",
  }),
);
assert.equal(
  await readSignalBotMenuInput({ chatId: "42", redis, telegramUserId: 42 }),
  null,
);

const staleGuardState = await writeSignalBotTradeMenuInput({
  action: "buy",
  chatId: "42",
  contextId,
  expiresAt: context.expiresAt,
  menuMessageId: 22,
  redis,
  telegramUserId: 42,
});
assert.ok(staleGuardState);
assert.equal(
  JSON.parse(redis.values.get("tg:signal_bot:v1:menu_input:42:42") ?? "{}")
    .stateToken,
  JSON.parse(
    redis.values.get("tg:signal_bot:v1:trade_input_guard:42:42") ?? "{}",
  ).stateToken,
  "the atomic write must publish one generation to primary and guard keys",
);
await clearSignalBotMenuInput({ chatId: "42", redis, telegramUserId: 42 });
let staleGuardCompletionCalls = 0;
let staleGuardEditedText = "";
assert.equal(
  await handleSignalBotTradeInput({
    chatId: "42",
    complete: async () => {
      staleGuardCompletionCalls += 1;
      return { completed: true, message: { text: "must not complete" } };
    },
    redis,
    telegramUserId: 42,
    text: "5",
    transport: {
      editMessageText: async (message) => {
        staleGuardEditedText = message.text;
        return { message: "ok", messageId: 22, ok: true as const };
      },
      sendMessage: async () => ({
        message: "unexpected standalone send",
        messageId: 23,
        ok: true as const,
      }),
    },
  }),
  true,
);
assert.equal(staleGuardCompletionCalls, 0);
assert.match(staleGuardEditedText, /no longer active/u);
assert.match(
  staleGuardEditedText,
  /active\\\./u,
  "stale input copy must remain valid MarkdownV2",
);
assert.equal(
  redis.values.has("tg:signal_bot:v1:trade_input_guard:42:42"),
  false,
  "an expired custom amount must be consumed instead of becoming a market search",
);

const displacedBySearchState = await writeSignalBotTradeMenuInput({
  action: "buy",
  chatId: "42",
  contextId,
  expiresAt: context.expiresAt,
  menuMessageId: 20,
  redis,
  telegramUserId: 42,
});
assert.ok(displacedBySearchState);
await clearSignalBotMenuInput({ chatId: "42", redis, telegramUserId: 42 });
redis.values.set(
  "tg:signal_bot:v1:menu_input:42:42",
  JSON.stringify({ kind: "awaiting_market_query", menuMessageId: 30 }),
);
assert.equal(
  await handleSignalBotTradeInput({
    chatId: "42",
    complete: async () => {
      throw new Error("a displaced trade input must not complete");
    },
    redis,
    telegramUserId: 42,
    text: "5",
    transport: {
      editMessageText: async (message) => {
        void message;
        return { message: "ok", messageId: 20, ok: true as const };
      },
      sendMessage: async () => ({
        message: "unexpected standalone send",
        messageId: 31,
        ok: true as const,
      }),
    },
  }),
  false,
  "the explicit newer search input must take precedence over a stale trade guard",
);
assert.equal(
  (
    await readSignalBotMenuInput({
      chatId: "42",
      redis,
      telegramUserId: 42,
    })
  )?.kind,
  "awaiting_market_query",
  "the trade handler must preserve the newer search state",
);
assert.equal(
  redis.values.has("tg:signal_bot:v1:trade_input_guard:42:42"),
  true,
  "the newer search input must not destroy the bounded stale trade guard",
);
await clearSignalBotMenuInput({ chatId: "42", redis, telegramUserId: 42 });

const failedStaleDeliveryState = await writeSignalBotTradeMenuInput({
  action: "buy",
  chatId: "42",
  contextId,
  expiresAt: context.expiresAt,
  menuMessageId: 19,
  redis,
  telegramUserId: 42,
});
assert.ok(failedStaleDeliveryState);
await clearSignalBotMenuInput({ chatId: "42", redis, telegramUserId: 42 });
assert.equal(
  await handleSignalBotTradeInput({
    chatId: "42",
    complete: async () => {
      throw new Error("a stale trade input must not complete");
    },
    redis,
    telegramUserId: 42,
    text: "5",
    transport: {
      editMessageText: async () => ({
        error: "other" as const,
        message: "edit failed",
        ok: false as const,
      }),
      sendMessage: async () => ({
        message: "unexpected standalone send",
        messageId: 33,
        ok: true as const,
      }),
    },
  }),
  true,
);
assert.equal(
  redis.values.has("tg:signal_bot:v1:trade_input_guard:42:42"),
  true,
  "a failed stale-card edit must retain the guard",
);
assert.equal(
  await clearSignalBotMenuInputIfCurrent({
    chatId: "42",
    redis,
    stateToken: failedStaleDeliveryState.stateToken,
    telegramUserId: 42,
  }),
  true,
);

const expiredVisibleState = await writeSignalBotTradeMenuInput({
  action: "buy",
  chatId: "42",
  contextId,
  expiresAt: context.expiresAt,
  menuMessageId: 21,
  redis,
  telegramUserId: 42,
});
assert.ok(expiredVisibleState);
await clearSignalBotMenuInput({ chatId: "42", redis, telegramUserId: 42 });
const expiredVisibleGuardKey = "tg:signal_bot:v1:trade_input_guard:42:42";
const expiredVisibleGuard = JSON.parse(
  redis.values.get(expiredVisibleGuardKey) ?? "{}",
) as Record<string, unknown>;
redis.values.set(
  expiredVisibleGuardKey,
  JSON.stringify({
    ...expiredVisibleGuard,
    expiresAt: new Date(Date.now() - 1_000).toISOString(),
  }),
);
redis.values.set(
  "tg:signal_bot:v1:menu_input:42:42",
  JSON.stringify({ kind: "awaiting_market_query", menuMessageId: 32 }),
);
let replacedExpiredMessage = "";
assert.equal(
  await beginSignalBotTradeInput({
    action: "sell",
    chatId: "42",
    contextId,
    expiresAt: context.expiresAt,
    menuMessageId: 22,
    message: { text: "enter shares" },
    redis,
    telegramUserId: 42,
    transport: {
      editMessageText: async (message) => {
        if (message.message_id === 21) replacedExpiredMessage = message.text;
        return {
          message: "ok",
          messageId: message.message_id,
          ok: true as const,
        };
      },
      sendMessage: async () => ({
        message: "unexpected standalone send",
        messageId: 23,
        ok: true as const,
      }),
    },
  }),
  true,
);
assert.match(
  replacedExpiredMessage,
  /replaced by a newer trade card/u,
  "a new custom input must also disable an expired card retained by the guard",
);
assert.match(
  replacedExpiredMessage,
  /card\\\./u,
  "replacement copy must remain valid MarkdownV2",
);
await clearSignalBotMenuInput({ chatId: "42", redis, telegramUserId: 42 });

let standaloneSends = 0;
assert.equal(
  await beginSignalBotTradeInput({
    action: "sell",
    chatId: "42",
    contextId,
    expiresAt: context.expiresAt,
    menuMessageId: 12,
    message: { text: "enter shares" },
    redis,
    telegramUserId: 42,
    transport: {
      editMessageText: async () => ({
        error: "ambiguous" as const,
        message: "timeout",
        ok: false as const,
      }),
      sendMessage: async () => {
        standaloneSends += 1;
        return { message: "ok", messageId: 13, ok: true as const };
      },
    },
  }),
  true,
);
assert.equal(standaloneSends, 0);
assert.equal(
  (
    await readSignalBotMenuInput({
      chatId: "42",
      redis,
      telegramUserId: 42,
    })
  )?.kind,
  "awaiting_custom_sell_amount",
);

// Reopening the same custom-input card is an idempotent success. Telegram
// reports an unchanged edit as HTTP 400; the prompt must retain the fresh
// primary state and guard so the next amount is still consumed as trade input.
assert.equal(
  await beginSignalBotTradeInput({
    action: "sell",
    chatId: "42",
    contextId,
    expiresAt: context.expiresAt,
    menuMessageId: 12,
    message: { text: "enter shares" },
    redis,
    telegramUserId: 42,
    transport: {
      editMessageText: async () => ({
        error: "other" as const,
        message: "Bad Request: message is not modified",
        ok: false as const,
      }),
      sendMessage: async () => {
        throw new Error("an unchanged edit must not create another prompt");
      },
    },
  }),
  true,
);
const unchangedPromptState = await readSignalBotMenuInput({
  chatId: "42",
  redis,
  telegramUserId: 42,
});
assert.equal(unchangedPromptState?.kind, "awaiting_custom_sell_amount");
assert.equal(
  JSON.parse(
    redis.values.get("tg:signal_bot:v1:trade_input_guard:42:42") ?? "{}",
  ).stateToken,
  unchangedPromptState?.stateToken,
  "the unchanged prompt keeps its matching guard generation",
);

assert.equal(
  await handleTelegramBotRewardsInput({
    callbackPrefix: "hm:v1:",
    chatId: "42",
    redis,
    telegramUserId: 42,
    text: "1.25",
    transport: {
      sendMessage: async () => ({
        message: "ok",
        messageId: 13,
        ok: true as const,
      }),
    },
  }),
  false,
);

let completionCalls = 0;
let completionMiniAppEnabled: boolean | undefined;
let completionOwnerMessageId: number | undefined;
assert.equal(
  await handleSignalBotTradeInput({
    chatId: "42",
    complete: async (input) => {
      completionCalls += 1;
      completionMiniAppEnabled = input.telegramMiniAppEnabled;
      completionOwnerMessageId = input.telegramMessageId;
      return { completed: true, message: { text: "confirm sell" } };
    },
    redis,
    telegramUserId: 42,
    telegramMiniAppEnabled: true,
    text: "1.25",
    transport: {
      editMessageText: async () => ({
        message: "ok",
        messageId: 12,
        ok: true as const,
      }),
      sendMessage: async () => ({
        message: "ok",
        messageId: 13,
        ok: true as const,
      }),
    },
  }),
  true,
);
assert.equal(completionCalls, 1);
assert.equal(completionMiniAppEnabled, true);
assert.equal(completionOwnerMessageId, 12);
assert.equal(
  await readSignalBotMenuInput({ chatId: "42", redis, telegramUserId: 42 }),
  null,
);

const state = await writeSignalBotTradeMenuInput({
  action: "buy",
  chatId: "42",
  contextId,
  expiresAt: context.expiresAt,
  menuMessageId: 12,
  redis,
  telegramUserId: 42,
});
assert.ok(state);
await handleSignalBotTradeInput({
  chatId: "42",
  complete: async () => ({
    completed: false,
    message: { text: "invalid amount" },
  }),
  redis,
  telegramUserId: 42,
  text: "wrong",
  transport: {
    editMessageText: async () => ({
      message: "ok",
      messageId: 12,
      ok: true as const,
    }),
    sendMessage: async () => ({
      message: "ok",
      messageId: 13,
      ok: true as const,
    }),
  },
});
assert.equal(
  (await readSignalBotMenuInput({ chatId: "42", redis, telegramUserId: 42 }))
    ?.kind,
  "awaiting_custom_buy_amount",
);

const replacedState = await writeSignalBotTradeMenuInput({
  action: "sell",
  chatId: "42",
  contextId,
  expiresAt: context.expiresAt,
  menuMessageId: 12,
  redis,
  telegramUserId: 42,
});
assert.ok(replacedState);
assert.equal(
  await clearSignalBotMenuInputIfCurrent({
    chatId: "42",
    redis,
    stateToken: state?.stateToken ?? "",
    telegramUserId: 42,
  }),
  false,
);
assert.equal(
  (
    await readSignalBotMenuInput({
      chatId: "42",
      redis,
      telegramUserId: 42,
    })
  )?.kind,
  "awaiting_custom_sell_amount",
);

assert.deepEqual(
  parseTelegramBotTradingCallbackData(`hbt:cancel_input:${contextId}`),
  { inputContextId: contextId, type: "cancel_input" },
);
assert.equal(
  await cancelSignalBotTradeInput({
    chatId: "42",
    contextId,
    message: { text: "Back to the market" },
    redis,
    telegramUserId: 42,
    transport: {
      editMessageText: async () => ({
        error: "ambiguous" as const,
        message: "timeout",
        ok: false as const,
      }),
      sendMessage: async () => {
        throw new Error("an ambiguous edit must not create a second card");
      },
    },
  }),
  true,
);
assert.equal(
  await readSignalBotMenuInput({ chatId: "42", redis, telegramUserId: 42 }),
  null,
  "an ambiguous close must stop consuming new free-text as trade input",
);
assert.equal(
  JSON.parse(
    redis.values.get("tg:signal_bot:v1:trade_input_guard:42:42") ?? "{}",
  ).stateToken,
  replacedState.stateToken,
  "an ambiguous close must preserve the bounded stale-card guard",
);
const unclearedState = await writeSignalBotTradeMenuInput({
  action: "sell",
  chatId: "42",
  contextId,
  expiresAt: context.expiresAt,
  menuMessageId: 12,
  redis,
  telegramUserId: 42,
});
assert.ok(unclearedState);
assert.equal(
  await cancelSignalBotTradeInput({
    chatId: "42",
    contextId,
    message: { text: "Back to the market" },
    redis: {
      eval: async () => {
        throw new Error("Redis unavailable");
      },
      get: redis.get.bind(redis),
      set: redis.set.bind(redis),
    },
    telegramUserId: 42,
    transport: {
      editMessageText: async () => ({
        error: "ambiguous" as const,
        message: "timeout",
        ok: false as const,
      }),
      sendMessage: async () => {
        throw new Error("an ambiguous edit must not create a second card");
      },
    },
  }),
  false,
  "an ambiguous cancel cannot report success when its Redis state was not cleared",
);
const stateAfterFailedClear = await readSignalBotMenuInput({
  chatId: "42",
  redis,
  telegramUserId: 42,
});
assert.ok(
  stateAfterFailedClear?.kind === "awaiting_custom_sell_amount" ||
    stateAfterFailedClear?.kind === "awaiting_custom_buy_amount",
);
assert.equal(stateAfterFailedClear.stateToken, unclearedState.stateToken);
let cancelledKeyboard: TelegramInlineKeyboard["inline_keyboard"] | undefined;
assert.equal(
  await cancelSignalBotTradeInput({
    chatId: "42",
    contextId,
    message: { text: "Back to the market" },
    redis,
    telegramUserId: 42,
    transport: {
      editMessageText: async (message) => {
        cancelledKeyboard = message.reply_markup?.inline_keyboard;
        return { message: "ok", messageId: 12, ok: true as const };
      },
      sendMessage: async () => ({
        message: "unexpected standalone send",
        messageId: 13,
        ok: true as const,
      }),
    },
  }),
  true,
);
assert.equal(
  cancelledKeyboard
    ?.flat()
    .filter(
      (button) =>
        "callback_data" in button && button.callback_data === "hm:v1:home",
    ).length,
  1,
);
assert.equal(
  await readSignalBotMenuInput({ chatId: "42", redis, telegramUserId: 42 }),
  null,
);
assert.equal(
  await cancelSignalBotTradeInput({
    chatId: "42",
    contextId,
    message: { text: "must not deliver" },
    redis,
    telegramUserId: 42,
    transport: {
      sendMessage: async () => {
        throw new Error("stale cancel must not send");
      },
    },
  }),
  false,
);

const expiredInputContextId = "9330c377-ebbf-4fab-927a-df4afc91bffc";
const expiredInputIntentId = "ee7e9ee3-481d-457d-8a7e-67a1ec69ac75";
const expiredInputTelegramUserId = "expired-input-user";
const expiredInputChatId = "expired-input-chat";
const expiredInputMarketId = "polymarket:expired-input-market";
const expiredInputFingerprint =
  telegramBotTradingTestHooks.telegramTradeInputFingerprint({
    action: "buy",
    chatId: expiredInputChatId,
    contextId: expiredInputContextId,
    marketId: expiredInputMarketId,
    normalizedValue: "5.00",
    side: "YES",
    telegramUserId: expiredInputTelegramUserId,
  });
const expiredInputIntent = {
  action: "buy",
  chat_id: expiredInputChatId,
  expires_at: new Date(Date.now() - 1_000),
  id: expiredInputIntentId,
  market_id: expiredInputMarketId,
  result: {
    telegramInput: {
      contextId: expiredInputContextId,
      fingerprint: expiredInputFingerprint,
      version: 1,
    },
  },
  side: "YES",
  telegram_user_id: expiredInputTelegramUserId,
};
const expiredInputResult = await completeTelegramBotTradeInput({
  appBaseUrl: "https://app.hunch.trade",
  chatId: expiredInputChatId,
  contextId: expiredInputContextId,
  db: {
    query: async () => ({ rows: [expiredInputIntent] }),
  } as never,
  isLinkCurrent: async () => {
    throw new Error("expired input must not inspect the current link");
  },
  loadContext: async () => {
    throw new Error("expired persisted input must not load Redis context");
  },
  telegramMessageId: 1,
  telegramUserId: expiredInputTelegramUserId,
  trading: {} as never,
  value: "5",
});
assert.equal(expiredInputResult.completed, false);
assert.deepEqual(expiredInputResult.message.reply_markup?.inline_keyboard, [
  [
    {
      callback_data: `hbt:open_market:${expiredInputIntentId}`,
      text: "🎯 Open market",
    },
  ],
  [{ callback_data: "hm:v1:home", text: "🏠 Home" }],
]);

assert.ok(
  await writeSignalBotTradeMenuInput({
    action: "sell",
    chatId: "42",
    contextId,
    expiresAt: context.expiresAt,
    menuMessageId: 12,
    redis,
    telegramUserId: 42,
  }),
);

let recoveryStandaloneSends = 0;
assert.equal(
  await handleSignalBotTradeInput({
    chatId: "42",
    complete: async () => {
      throw new Error("completion timeout");
    },
    redis,
    telegramUserId: 42,
    text: "1.25",
    transport: {
      editMessageText: async () => ({
        error: "ambiguous" as const,
        message: "timeout",
        ok: false as const,
      }),
      sendMessage: async () => {
        recoveryStandaloneSends += 1;
        return { message: "ok", messageId: 14, ok: true as const };
      },
    },
  }),
  true,
);
assert.equal(recoveryStandaloneSends, 0);
assert.equal(
  (
    await readSignalBotMenuInput({
      chatId: "42",
      redis,
      telegramUserId: 42,
    })
  )?.kind,
  "awaiting_custom_sell_amount",
);

console.log("[telegram-trade-input-tests] passed");
