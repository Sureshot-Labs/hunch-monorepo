import assert from "node:assert/strict";
import {
  buildPolymarketAssetContext,
  resolvePolymarketMarketAssets,
} from "@hunch/shared";
import { selectPolymarketTradeAsset } from "./services/polymarket-trade-asset-selection.js";
import { polymarketTradingExecutionTestHooks as executionHooks } from "./services/polymarket-trading-execution-service.js";
import { telegramBotTradingTestHooks as hooks } from "./services/telegram-bot-trading.js";
import { getDefaultSignalBotPolicy } from "./services/signal-bot-trading-policy.js";
import {
  buildTelegramAppHandoffV2DirectTradePlan,
  parseTelegramAppHandoffV2Plan,
} from "./services/telegram-app-handoff-v2.js";
import { marketsByTokenQuerySchema } from "./schemas/market.js";
import type { TradeQuote } from "./services/trading-types.js";
import type { JsonObject } from "./funding/domain/types.js";

// Synthetic transition: a persisted CTF YES precedes a different PM YES.
// No provider, wallet, signing or transaction execution is invoked here.
const marketId = "polymarket:telegram-generation-fixture";
const base = (1n << 248n) | (0xaan << 120n);
const conditionId = `0x${base.toString(16).padStart(64, "0")}`;
const legacy = resolvePolymarketMarketAssets({
  version: "v1",
  conditionId,
  clobTokenIds: ["7", "8"],
  outcomes: ["Yes", "No"],
  negRisk: false,
});
const context = buildPolymarketAssetContext(marketId, legacy, "7");
const noContext = buildPolymarketAssetContext(marketId, legacy, "8");
const currentTokenId = base.toString();
const selection = {
  action: "SELL" as const,
  assetContext: context,
  currentTokenId,
  marketId,
  outcomeIndex: 0 as const,
  targetTokenId: "7",
};
assert.deepEqual(selectPolymarketTradeAsset(selection), {
  tokenId: "7",
  assetContext: context,
});
for (const patch of [
  { action: "BUY" as const },
  { assetContext: undefined },
  { assetContext: { ...context, positionContract: "0xwrong" } },
  { marketId: "polymarket:another" },
  { outcomeIndex: 1 as const },
  { targetTokenId: "8" },
])
  assert.throws(() => selectPolymarketTradeAsset({ ...selection, ...patch }));
assert.deepEqual(
  selectPolymarketTradeAsset({
    action: "BUY",
    currentTokenId: "7",
    marketId,
    outcomeIndex: 0,
  }),
  { tokenId: "7" },
);

const authorization = {
  id: "00000000-0000-4000-8000-000000000001",
  user_id: "00000000-0000-4000-8000-000000000002",
  telegram_user_id: "1234",
  wallet_address: "0x1111111111111111111111111111111111111111",
  wallet_chain: "ethereum",
} as Parameters<typeof hooks.buildTelegramSellTradeIntent>[0]["authorization"];
const market = {
  id: marketId,
  venue: "polymarket",
  venue_market_id: "fixture",
  event_id: "polymarket:event-fixture",
  event_title: "Event",
  title: "Market",
  token_yes: currentTokenId,
  token_no: (base | 1n).toString(),
  outcomes: '["Yes","No"]',
} as Parameters<typeof hooks.buildTelegramSellTradeIntent>[0]["market"];
const policy = getDefaultSignalBotPolicy();
const sell = hooks.buildTelegramSellTradeIntent({
  authorization,
  market,
  intentId: "00000000-0000-4000-8000-000000000003",
  side: "YES",
  sharesRaw: 2_000_000n,
  maxSlippageBps: 100,
  assetContext: context,
  tokenId: "7",
});
const quote = {
  action: "SELL",
  venue: "polymarket",
  target: sell.target,
  minimumReceiveUsd: 0.6,
  estimatedNotionalUsd: 0.6,
  estimatedShares: 2,
  price: 0.3,
  currentPrice: 0.3,
  maxSpendUsd: null,
  minReceiveShares: null,
} as TradeQuote;
const preview = hooks.buildTelegramTradeQuotePreview(quote);
const previewJson = JSON.parse(JSON.stringify(preview));
assert.deepEqual(
  hooks.readTelegramTradeQuotePreview(previewJson)?.assetContext,
  context,
);
assert.equal(
  hooks.readTelegramTradeQuotePreview({
    ...previewJson,
    tokenId: currentTokenId,
  }),
  null,
);
const intent = {
  id: sell.id,
  action: "sell",
  amount_usd: null,
  shares_raw: "2000000",
  event_id: market.event_id,
  market_id: marketId,
  market_title: "Market",
  side: "YES",
  venue: "polymarket",
  result: {},
  quote_snapshot: previewJson,
} as Parameters<typeof hooks.buildTelegramStoredTradeIntent>[0]["intent"];
const storedInput = {
  authorization,
  market,
  policy,
  intent,
  amountUsd: null,
  sharesRaw: 2_000_000n,
  side: "YES" as const,
};
const restored = hooks.buildTelegramStoredTradeIntent(storedInput);
assert.equal(restored.target.tokenId, "7");
assert.deepEqual(restored.target.assetContext, context);
const readinessInput = hooks.buildTelegramTradingReadinessInput({
  action: "SELL",
  authorization,
  market: null,
  venue: "polymarket",
  assetContext: restored.target.assetContext,
});
assert.deepEqual(readinessInput.assetContext, context);
assert.equal(
  readinessInput.target,
  null,
  "generation selection does not add a second quantity/balance gate to callback readiness",
);
const noReadiness = hooks.buildTelegramTradingReadinessInput({
  action: "BUY",
  authorization,
  market,
  venue: "polymarket",
  assetContext: noContext,
});
assert.ok(noReadiness.target);
assert.equal(
  executionHooks.resolveReadinessOutcome(
    noReadiness.target,
    noReadiness.assetContext,
  ),
  "NO",
  "market-only readiness must not default a reviewed NO to YES",
);
assert.equal(
  executionHooks.resolveReadinessOutcome({
    ...noReadiness.target,
    assetContext: noContext,
  }),
  "NO",
);
assert.equal(
  executionHooks.resolveReadinessOutcome(
    { ...noReadiness.target, outcome: "YES" },
    noContext,
  ),
  "YES",
  "an explicit contradictory side is not rewritten and must fail asset selection",
);
assert.equal(
  executionHooks.resolveReadinessOutcome(noReadiness.target),
  "YES",
  "old market-only readiness retains its default",
);
const restoredBuy = hooks.buildTelegramStoredTradeIntent({
  ...storedInput,
  intent: { ...intent, action: "buy", amount_usd: "1" },
  amountUsd: 1,
  sharesRaw: null,
});
assert.deepEqual(
  restoredBuy.target.assetContext,
  context,
  "a reviewed Buy must not silently change generations either",
);
assert.throws(() =>
  hooks.buildTelegramStoredTradeIntent({
    ...storedInput,
    intent: { ...intent, quote_snapshot: { ...previewJson, assetContext: {} } },
  }),
);
const sealedTrade = hooks.buildTelegramAppHandoffV2TradeSnapshot({
  controllerWalletAddress: authorization.wallet_address,
  intent,
  market,
  policy,
  quote: preview,
});
assert.equal(
  sealedTrade.outcomeTokenId,
  "7",
  "current market projection cannot replace a historical Sell token",
);
assert.deepEqual(sealedTrade.assetContext, context);
const plan = buildTelegramAppHandoffV2DirectTradePlan({
  controllerWalletAddress: authorization.wallet_address,
  trade: sealedTrade,
});
assert.deepEqual(
  parseTelegramAppHandoffV2Plan(plan)?.trade.assetContext,
  context,
);
const invalidPlanPatches: JsonObject[] = [
  { assetContext: { ...context, outcomeIndex: 1 } },
  { assetContext: { ...context, marketId: "other" } },
  { outcomeTokenId: "8" },
  { venue: "limitless" },
];
for (const patch of invalidPlanPatches)
  assert.throws(() =>
    parseTelegramAppHandoffV2Plan({
      ...plan,
      trade: { ...sealedTrade, ...patch },
    }),
  );
const { assetContext: _context, ...oldTrade } = sealedTrade;
assert.ok(
  parseTelegramAppHandoffV2Plan({ ...plan, trade: oldTrade }),
  "old sealed plans remain supported",
);
assert.deepEqual(
  marketsByTokenQuerySchema.parse({
    tokenIds: "7",
    venue: "polymarket",
    assetContext: JSON.stringify(context),
  }).assetContext,
  context,
);
for (const patch of [
  { tokenIds: "8" },
  { tokenIds: "7,8" },
  { venue: "limitless" },
  { assetContext: "{" },
])
  assert.equal(
    marketsByTokenQuerySchema.safeParse({
      tokenIds: "7",
      venue: "polymarket",
      assetContext: JSON.stringify(context),
      ...patch,
    }).success,
    false,
  );
console.log(
  "[polymarket-telegram-asset-context-tests] frozen preview, Buy/Sell, sealed handoff and public context passed",
);
