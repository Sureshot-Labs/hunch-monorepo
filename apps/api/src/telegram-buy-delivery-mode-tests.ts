#!/usr/bin/env tsx

import assert from "node:assert/strict";

import { resolveTelegramBuyDeliveryMode } from "./services/telegram-bot-trading.js";

assert.equal(
  resolveTelegramBuyDeliveryMode({
    commonBuySurfaceReady: true,
    miniAppHandoffMode: "fallback",
    telegramMiniAppEnabled: true,
    venue: "polymarket",
    venueAllowedForBotSubmit: true,
  }),
  "bot_submit",
);
assert.equal(
  resolveTelegramBuyDeliveryMode({
    commonBuySurfaceReady: true,
    miniAppHandoffMode: "fallback",
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
      miniAppHandoffMode: "fallback",
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
    miniAppHandoffMode: "fallback",
    telegramMiniAppEnabled: false,
    venue: "limitless",
    venueAllowedForBotSubmit: false,
  }),
  "direct_deposit_only",
);
assert.equal(
  resolveTelegramBuyDeliveryMode({
    commonBuySurfaceReady: true,
    miniAppHandoffMode: "off",
    telegramMiniAppEnabled: true,
    venue: "limitless",
    venueAllowedForBotSubmit: false,
  }),
  "direct_deposit_only",
  "off must never issue an uncommittable Mini App handoff",
);
assert.equal(
  resolveTelegramBuyDeliveryMode({
    commonBuySurfaceReady: true,
    miniAppHandoffMode: "always",
    telegramMiniAppEnabled: true,
    venue: "polymarket",
    venueAllowedForBotSubmit: true,
  }),
  "app_handoff",
  "always must select Hunch before direct bot submission",
);

console.log("[telegram-buy-delivery-mode-tests] passed");
