import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { hip4Identity } from "@hunch/shared";
import {
  telegramAppHandoffNativeTradeSchema,
  parseTelegramAppHandoffNativeTrade,
  sameTelegramAppHandoffNativeTrade,
  telegramAppHandoffNativeRequestedAmounts,
} from "./services/telegram-app-handoff-native-trade.js";
import {
  isTelegramAppHandoffV2DirectTradeVenue,
  isTelegramAppHandoffV2TradeVenue,
} from "./services/telegram-app-handoff-v2-contract.js";

function fixture(side: "BUY" | "SELL" = "BUY") {
  const identity = hip4Identity("mainnet", 123);
  return telegramAppHandoffNativeTradeSchema.parse({
    version: "hip4-ioc-v1",
    environment: "mainnet",
    marketId: identity.marketId,
    outcomeTokenId: identity.sides[0].tokenId,
    outcomeSide: "YES",
    controllerWalletRef: randomUUID(),
    side,
    timeInForce: "Ioc",
    quantity: "20",
    limitPrice: "0.5",
    consentedDebitCapRaw: side === "BUY" ? "1000000000" : "2000000",
  });
}

test("native sealed terms preserve cash8, outcome5 and whole lots without full-fill promises", () => {
  for (const side of ["BUY", "SELL"] as const) {
    const native = fixture(side);
    assert.deepEqual(telegramAppHandoffNativeRequestedAmounts(native), {
      tokenRaw: 2000000n,
      grossQuoteRaw: 1000000000n,
    });
    const trade = {
      venue: "hyperliquid",
      action: side.toLowerCase(),
      marketId: native.marketId,
      outcomeTokenId: native.outcomeTokenId,
      side: native.outcomeSide,
      nativeTrade: native,
    };
    assert.deepEqual(parseTelegramAppHandoffNativeTrade(trade), native);
    for (const key of [
      "amountUsd",
      "maxSpendUsd",
      "sharesRaw",
      "minimumReceiveRaw",
      "minReceiveShares",
      "maxSlippageBps",
    ])
      assert.equal(
        parseTelegramAppHandoffNativeTrade({ ...trade, [key]: 1 }),
        null,
      );
    assert.equal(
      parseTelegramAppHandoffNativeTrade({ ...trade, side: "NO" }),
      null,
    );
    assert.equal(
      parseTelegramAppHandoffNativeTrade({
        ...trade,
        action: side === "BUY" ? "sell" : "buy",
      }),
      null,
    );
    assert.equal(
      parseTelegramAppHandoffNativeTrade({
        ...trade,
        assetContext: { protocolVersion: "v2" },
      }),
      null,
    );
  }
  assert.equal(
    isTelegramAppHandoffV2TradeVenue("hyperliquid"),
    true,
    "connected native app entry uses the existing v2 contract, not bot signing",
  );
  assert.equal(isTelegramAppHandoffV2DirectTradeVenue("hyperliquid"), true);
});

for (const [label, change] of Object.entries({
  environment: { environment: "testnet" },
  token: { outcomeTokenId: hip4Identity("mainnet", 123).sides[1].tokenId },
  otherMarket: { marketId: hip4Identity("mainnet", 124).marketId },
  side: { outcomeSide: "NO" },
  FOK: { timeInForce: "Fok" },
  GTC: { timeInForce: "Gtc" },
  fractionalLot: { quantity: "1.5" },
  zeroLot: { quantity: "0" },
  zeroPrice: { limitPrice: "0.00000" },
  onePrice: { limitPrice: "1.00000" },
  inexactPrice: { limitPrice: "0.500001" },
  cash6Cap: { consentedDebitCapRaw: "10000000" },
  invalidController: { controllerWalletRef: "wallet-id" },
  oversizedQuantity: { quantity: "1".repeat(129) },
  extra: { signature: "not-permitted" },
}))
  test(`native sealed terms reject ${label}`, () => {
    assert.equal(
      telegramAppHandoffNativeTradeSchema.safeParse({ ...fixture(), ...change })
        .success,
      false,
    );
  });

test("native economic equality tolerates decimal spelling, not identity/quantity/limit/cap changes", () => {
  const original = fixture();
  assert.equal(
    sameTelegramAppHandoffNativeTrade(original, {
      ...original,
      limitPrice: "0.50000",
    }),
    true,
  );
  for (const change of [
    { quantity: "19" },
    { limitPrice: "0.49" },
    { consentedDebitCapRaw: "1100000000" },
    { controllerWalletRef: randomUUID() },
  ])
    assert.equal(
      sameTelegramAppHandoffNativeTrade(
        original,
        telegramAppHandoffNativeTradeSchema.parse({ ...original, ...change }),
      ),
      false,
    );
});
