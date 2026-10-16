import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseTelegramNativeTradeInput,
  telegramNativeInputDebitCap,
} from "./services/telegram-native-trade-input-amounts.js";
import {
  isTelegramBotTradeInputContext,
  readTelegramBotTradeInputContext,
  readTelegramBotTradeInputContextForNavigation,
  writeTelegramBotTradeInputContext,
  type TelegramNativeTradeInputContext,
} from "./services/telegram-bot-trade-input-context.js";
import { buildTelegramTradeInputPrompt } from "./services/telegram-bot-trading-presentation.js";

function validInput(action: "buy" | "sell", value: string) {
  const parsed = parseTelegramNativeTradeInput(action, value);
  assert.ok(parsed, `Expected valid ${action} input: ${value}`);
  return parsed;
}

function context(): TelegramNativeTradeInputContext {
  return {
    version: 3,
    venue: "hyperliquid",
    deliveryMode: "app_handoff",
    action: "sell",
    side: "YES",
    authority: {
      version: "hip4-controller-v1",
      userId: "00000000-0000-4000-8000-000000000001",
      telegramAccountLinkId: "00000000-0000-4000-8000-000000000002",
      controllerWalletRef: "00000000-0000-4000-8000-000000000003",
      walletAddress: `0x${"ab".repeat(20)}`,
      walletSource: "external",
      serverWalletRef: null,
    },
    id: "00000000-0000-4000-8000-000000000004",
    marketId: "hyperliquid:mainnet:outcome:11",
    eventId: "hyperliquid:mainnet:question:1",
    chatId: "42",
    telegramUserId: "42",
    controlledPositionId: null,
    funderAddress: null,
    messageScope: { kind: "exact_message", messageId: 5 },
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  };
}

test("native custom BUY preserves cash8 and normalized cents without Number rounding", () => {
  for (const value of ["2.5", "$2.50", "2.50"]) {
    assert.deepEqual(parseTelegramNativeTradeInput("buy", value), {
      mode: "usd",
      normalized: "2.50",
      scaled: 250000000n,
    });
    assert.equal(
      telegramNativeInputDebitCap(validInput("buy", value)),
      "250000000",
    );
  }
  const exact = validInput("buy", "9007199254740991.23");
  assert.equal(exact.normalized, "9007199254740991.23");
  assert.equal(exact.scaled, 900719925474099123000000n);
  for (const value of [
    "0",
    "-1",
    "01",
    "2.501",
    "1e2",
    "NaN",
    "Infinity",
    "25%",
    "all",
  ])
    assert.equal(parseTelegramNativeTradeInput("buy", value), null, value);
});

test("native custom SELL exact contracts never silently resize or accept fractional legacy shares", () => {
  for (const text of ["2", "2.0", "2.00000"]) {
    const parsed = validInput("sell", text);
    assert.equal(parsed.normalized, "2");
    assert.equal(telegramNativeInputDebitCap(parsed, 250000n), "200000");
    assert.equal(telegramNativeInputDebitCap(parsed, 199999n), null);
  }
  for (const text of ["1.25", "0.5", "0", "-1", "01", "1e3", "2.000001", "$2"])
    assert.equal(parseTelegramNativeTradeInput("sell", text), null, text);
});

test("native percent/all floors to whole lots, only inside currently available stock", () => {
  assert.equal(
    telegramNativeInputDebitCap(validInput("sell", "ALL"), 450000n),
    "400000",
  );
  assert.equal(
    telegramNativeInputDebitCap(validInput("sell", "25%"), 1050000n),
    "200000",
  );
  assert.equal(
    telegramNativeInputDebitCap(validInput("sell", "100%"), 99999n),
    null,
  );
  assert.equal(
    telegramNativeInputDebitCap(validInput("sell", "0.000001%"), 100000n),
    null,
  );
  assert.equal(
    parseTelegramNativeTradeInput("sell", "25.000000%")?.normalized,
    "25%",
  );
  for (const text of ["0%", "100.000001%", "101%", "-1%", "0.0000001%"])
    assert.equal(parseTelegramNativeTradeInput("sell", text), null, text);
});

test("native input uses an explicit external controller authority, never a fabricated bot grant", () => {
  const native = context();
  assert.equal(isTelegramBotTradeInputContext(native), true);
  for (const changed of [
    { ...native, version: 2 },
    { ...native, deliveryMode: "bot_submit" },
    { ...native, venue: "limitless" },
    { ...native, marketId: "hyperliquid:testnet:outcome:11" },
    {
      ...native,
      authority: { ...native.authority, serverWalletRef: "fake-privy-server" },
    },
    {
      ...native,
      authority: {
        authorizationId: null,
        privyWalletId: "fake",
        telegramAccountLinkId: native.authority.telegramAccountLinkId,
        userId: native.authority.userId,
        walletAddress: native.authority.walletAddress,
        walletChain: "ethereum",
      },
    },
  ])
    assert.equal(isTelegramBotTradeInputContext(changed), false);
});

test("the same Redis context store roundtrips native version and does not turn it into legacy economics", async () => {
  const values = new Map<string, string>();
  const redis = {
    get: async (key: string) => values.get(key) ?? null,
    set: async (key: string, value: string) => {
      values.set(key, value);
      return "OK";
    },
  };
  const native = context();
  assert.equal(
    await writeTelegramBotTradeInputContext({ context: native, redis }),
    true,
  );
  assert.deepEqual(
    await readTelegramBotTradeInputContext({ id: native.id, redis }),
    native,
  );
  const [key] = values.keys();
  values.set(
    key,
    JSON.stringify({
      ...native,
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    }),
  );
  assert.equal(
    await readTelegramBotTradeInputContext({ id: native.id, redis }),
    null,
  );
  assert.equal(
    (
      await readTelegramBotTradeInputContextForNavigation({
        id: native.id,
        redis,
      })
    )?.version,
    3,
  );
});

test("native Sell prompt explains whole-contract rounding; legacy prompt stays unchanged", () => {
  const native = buildTelegramTradeInputPrompt({
    action: "sell",
    id: context().id,
    venue: "hyperliquid",
  });
  assert.match(native.text, /whole contracts/u);
  assert.match(native.text, /round down/u);
  assert.doesNotMatch(native.text, /1\\\.25/u);
  assert.match(
    buildTelegramTradeInputPrompt({
      action: "sell",
      id: context().id,
      venue: "limitless",
    }).text,
    /1\\\.25/u,
  );
});
