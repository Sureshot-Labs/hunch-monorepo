#!/usr/bin/env tsx

import assert from "node:assert/strict";

import { resolveTelegramBuyDeliveryMode } from "./services/telegram-bot-trading.js";

assert.equal(
  resolveTelegramBuyDeliveryMode({
    commonBuySurfaceReady: true,
    telegramMiniAppEnabled: true,
    venue: "polymarket",
    venueAllowedForBotSubmit: true,
  }),
  "bot_submit",
);
assert.equal(
  resolveTelegramBuyDeliveryMode({
    commonBuySurfaceReady: true,
    telegramMiniAppEnabled: true,
    venue: "limitless",
    venueAllowedForBotSubmit: false,
  }),
  "app_handoff",
  "Limitless app handoff must not depend on the bot signer venue allowlist",
);
for (const venue of ["limitless", "polymarket"] as const) {
  assert.equal(
    resolveTelegramBuyDeliveryMode({
      commonBuySurfaceReady: false,
      telegramMiniAppEnabled: true,
      venue,
      venueAllowedForBotSubmit: true,
    }),
    "direct_deposit_only",
    "an opted-out or otherwise unauthorized user receives direct deposit only",
  );
}
assert.equal(
  resolveTelegramBuyDeliveryMode({
    commonBuySurfaceReady: true,
    telegramMiniAppEnabled: false,
    venue: "limitless",
    venueAllowedForBotSubmit: false,
  }),
  "direct_deposit_only",
);

console.log("[telegram-buy-delivery-mode-tests] passed");
