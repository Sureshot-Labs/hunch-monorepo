#!/usr/bin/env tsx

import assert from "node:assert/strict";

import {
  resolveTelegramBuyDeliveryMode,
  resolveTelegramBuyExecutionCapability,
} from "./services/telegram-bot-trading.js";

const polymarketEvm = resolveTelegramBuyExecutionCapability({
  venue: "polymarket",
  walletChain: "ethereum",
});
const limitlessEvm = resolveTelegramBuyExecutionCapability({
  venue: "limitless",
  walletChain: "ethereum",
});
const kalshiSolana = resolveTelegramBuyExecutionCapability({
  venue: "kalshi",
  walletChain: "solana",
});

assert.equal(
  resolveTelegramBuyDeliveryMode({
    capability: polymarketEvm,
    commonBuySurfaceReady: true,
    miniAppHandoffMode: "fallback",
    telegramMiniAppEnabled: true,
    venueAllowedForBotSubmit: true,
  }),
  "bot_submit",
);
assert.equal(
  resolveTelegramBuyDeliveryMode({
    capability: limitlessEvm,
    commonBuySurfaceReady: true,
    miniAppHandoffMode: "fallback",
    telegramMiniAppEnabled: true,
    venueAllowedForBotSubmit: false,
  }),
  "app_handoff",
  "the sealed EVM handoff must not depend on the bot signer venue allowlist",
);
for (const capability of [limitlessEvm, polymarketEvm]) {
  assert.equal(
    resolveTelegramBuyDeliveryMode({
      capability,
      commonBuySurfaceReady: false,
      miniAppHandoffMode: "fallback",
      telegramMiniAppEnabled: true,
      venueAllowedForBotSubmit: true,
    }),
    "direct_deposit_only",
    "an opted-out or otherwise unauthorized user receives direct deposit only",
  );
}
assert.equal(
  resolveTelegramBuyDeliveryMode({
    capability: limitlessEvm,
    commonBuySurfaceReady: true,
    miniAppHandoffMode: "fallback",
    telegramMiniAppEnabled: false,
    venueAllowedForBotSubmit: false,
  }),
  "direct_deposit_only",
);
assert.equal(
  resolveTelegramBuyDeliveryMode({
    capability: limitlessEvm,
    commonBuySurfaceReady: true,
    miniAppHandoffMode: "off",
    telegramMiniAppEnabled: true,
    venueAllowedForBotSubmit: false,
  }),
  "direct_deposit_only",
  "off must never issue an uncommittable Mini App handoff",
);
assert.equal(
  resolveTelegramBuyDeliveryMode({
    capability: polymarketEvm,
    commonBuySurfaceReady: true,
    miniAppHandoffMode: "always",
    telegramMiniAppEnabled: true,
    venueAllowedForBotSubmit: true,
  }),
  "app_handoff",
  "always must select Hunch before direct bot submission",
);
assert.deepEqual(kalshiSolana, {
  sealedAppHandoffExact: false,
  serverBotExact: false,
});
assert.equal(
  resolveTelegramBuyDeliveryMode({
    capability: kalshiSolana,
    commonBuySurfaceReady: true,
    miniAppHandoffMode: "always",
    telegramMiniAppEnabled: true,
    venueAllowedForBotSubmit: true,
  }),
  "direct_deposit_only",
  "always must never issue an unexecutable sealed handoff",
);

console.log("[telegram-buy-delivery-mode-tests] passed");
