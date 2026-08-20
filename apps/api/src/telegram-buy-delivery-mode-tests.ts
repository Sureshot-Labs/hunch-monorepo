#!/usr/bin/env tsx

import assert from "node:assert/strict";

import {
  resolveTelegramBuyDeliveryMode,
  resolveTelegramBuyIntentMaximumAmountUsd,
  resolveTelegramBuyPresetDeliveryModes,
  resolveTelegramBuyExecutionCapability,
  telegramVenueFromSealedHandoffSnapshot,
} from "./services/telegram-bot-trading.js";
import { getDefaultSignalBotPolicy } from "./services/signal-bot-trading-policy.js";

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
    handoffContractAvailable: true,
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
    handoffContractAvailable: true,
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
      handoffContractAvailable: true,
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
    handoffContractAvailable: true,
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
    handoffContractAvailable: true,
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
    handoffContractAvailable: true,
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
  telegramVenueFromSealedHandoffSnapshot({
    trade: { venue: "polymarket" },
    version: 2,
  }),
  "polymarket",
  "v2 reads the sealed destination from its nested trade scope",
);
assert.equal(
  resolveTelegramBuyDeliveryMode({
    capability: kalshiSolana,
    commonBuySurfaceReady: true,
    handoffContractAvailable: true,
    miniAppHandoffMode: "always",
    telegramMiniAppEnabled: true,
    venueAllowedForBotSubmit: true,
  }),
  "direct_deposit_only",
  "always must never issue an unexecutable sealed handoff",
);
assert.equal(
  resolveTelegramBuyDeliveryMode({
    capability: limitlessEvm,
    commonBuySurfaceReady: true,
    handoffContractAvailable: false,
    miniAppHandoffMode: "always",
    telegramMiniAppEnabled: true,
    venueAllowedForBotSubmit: false,
  }),
  "direct_deposit_only",
  "a policy below the v2 client contract must never issue a new legacy handoff",
);

const v2Policy = {
  ...getDefaultSignalBotPolicy(),
  maxTradeAmountUsd: 100,
  miniAppHandoffContractVersion: 2 as const,
  miniAppHandoffMode: "fallback" as const,
};
const serverBotMaximum = resolveTelegramBuyIntentMaximumAmountUsd({
  authorizationMaxAmountUsd: 20,
  deliveryMode: "bot_submit",
  policy: v2Policy,
  venue: "polymarket",
});
assert.equal(
  resolveTelegramBuyIntentMaximumAmountUsd({
    authorizationMaxAmountUsd: 20,
    deliveryMode: "app_handoff",
    policy: v2Policy,
    venue: "polymarket",
  }),
  100,
  "v2 handoff may exceed the server-bot cap but never the runtime ceiling",
);
assert.equal(
  resolveTelegramBuyIntentMaximumAmountUsd({
    authorizationMaxAmountUsd: 20,
    deliveryMode: "app_handoff",
    policy: { ...v2Policy, miniAppHandoffContractVersion: 1 },
    venue: "polymarket",
  }),
  serverBotMaximum,
  "v1 must retain its existing direct-execution limit until its consumer is replaced",
);

assert.deepEqual(
  resolveTelegramBuyPresetDeliveryModes({
    directMaximumAmountUsd: 20,
    handoffAvailable: true,
    handoffContractVersion: 2,
    handoffMode: "fallback",
    initialDeliveryMode: "bot_submit",
    presetAmountsUsd: [5, 20, 25],
  }),
  [
    { amountUsd: 5, deliveryMode: "bot_submit" },
    { amountUsd: 20, deliveryMode: "bot_submit" },
    { amountUsd: 25, deliveryMode: "app_handoff" },
  ],
  "fallback keeps server-safe amounts in the bot and hands only excess to Mini App v2",
);
assert.deepEqual(
  resolveTelegramBuyPresetDeliveryModes({
    directMaximumAmountUsd: 20,
    handoffAvailable: true,
    handoffContractVersion: 2,
    handoffMode: "always",
    initialDeliveryMode: "app_handoff",
    presetAmountsUsd: [5, 25],
  }),
  [
    { amountUsd: 5, deliveryMode: "app_handoff" },
    { amountUsd: 25, deliveryMode: "app_handoff" },
  ],
  "always sends every supported amount to the sealed Mini App path",
);
assert.deepEqual(
  resolveTelegramBuyPresetDeliveryModes({
    directMaximumAmountUsd: 20,
    handoffAvailable: true,
    handoffContractVersion: 1,
    handoffMode: "fallback",
    initialDeliveryMode: "bot_submit",
    presetAmountsUsd: [5, 25],
  }),
  [{ amountUsd: 5, deliveryMode: "bot_submit" }],
  "v1 never receives an amount that exceeds the server envelope",
);

console.log("[telegram-buy-delivery-mode-tests] passed");
