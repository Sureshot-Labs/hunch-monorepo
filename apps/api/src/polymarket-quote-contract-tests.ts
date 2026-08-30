#!/usr/bin/env tsx

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  polymarketPlaceOrderBodySchema,
  polymarketQuoteBodySchema,
} from "./schemas/polymarket-private.js";
import {
  extractPolymarketImmediateFill,
  isPolymarketTradingPausedResponse,
  resolvePolymarketStoredFillSyncStatus,
} from "./services/polymarket-order-execution.js";

const legacy = polymarketQuoteBodySchema.parse({
  tokenId: "123",
  side: "BUY",
  amountUsd: 1,
});
assert.equal(
  legacy.includeFundingPlan,
  true,
  "legacy quote clients must retain funding-plan previews",
);

const unified = polymarketQuoteBodySchema.parse({
  tokenId: "123",
  side: "BUY",
  amountUsd: 1,
  includeFundingPlan: false,
});
assert.equal(
  unified.includeFundingPlan,
  false,
  "unified funding clients must be able to skip duplicate RPC funding work",
);

console.log("ok - Polymarket quote funding-plan compatibility contract");

const limitQuote = polymarketQuoteBodySchema.parse({
  tokenId: "123",
  side: "BUY",
  amountUsd: 1,
  orderType: "GTC",
  limitPrice: 0.4,
  postOnly: true,
});
assert.equal(limitQuote.postOnly, true);
assert.equal(
  polymarketQuoteBodySchema.safeParse({
    tokenId: "123",
    side: "BUY",
    amountUsd: 1,
    orderType: "FOK",
    postOnly: true,
  }).success,
  false,
);
assert.equal(
  polymarketQuoteBodySchema.safeParse({
    tokenId: "123",
    side: "BUY",
    amountUsd: 1,
    orderType: "FAK",
  }).success,
  true,
);
assert.equal(
  polymarketQuoteBodySchema.safeParse({
    tokenId: "123",
    side: "BUY",
    amountUsd: 1,
    orderType: "FAK",
    postOnly: true,
  }).success,
  false,
);

const order = {
  salt: "1",
  maker: "0x0000000000000000000000000000000000000001",
  signer: "0x0000000000000000000000000000000000000001",
  tokenId: "123",
  makerAmount: "1000000",
  takerAmount: "2000000",
  side: "0",
  signatureType: "0",
  timestamp: "1",
  metadata: `0x${"0".repeat(64)}`,
  builder: `0x${"0".repeat(64)}`,
  signature: "0x1234",
};
assert.equal(
  polymarketPlaceOrderBodySchema.safeParse({
    order,
    orderType: "GTC",
    postOnly: true,
  }).success,
  true,
);
assert.equal(
  polymarketPlaceOrderBodySchema.safeParse({
    order,
    orderType: "FOK",
    postOnly: true,
  }).success,
  false,
);
assert.equal(
  polymarketPlaceOrderBodySchema.safeParse({
    order,
    orderType: "FAK",
  }).success,
  true,
);
assert.equal(
  polymarketPlaceOrderBodySchema.safeParse({
    order,
    orderType: "FAK",
    postOnly: true,
  }).success,
  false,
);

console.log("ok - Polymarket post-only contract is limit-order-only");

assert.equal(
  resolvePolymarketStoredFillSyncStatus({
    currentStatus: "submitted",
    filledSize: 1,
    orderSize: 2,
    orderType: "FOK",
  }),
  "matched",
);
assert.equal(
  resolvePolymarketStoredFillSyncStatus({
    currentStatus: "submitted",
    filledSize: 1,
    orderSize: 2,
    orderType: "FAK",
  }),
  "partially_filled",
);

console.log("ok - FAK preserves partial-fill status instead of FOK semantics");

assert.deepEqual(
  extractPolymarketImmediateFill({
    fallbackPrice: 0.5,
    fallbackSize: 10,
    payload: {
      order: { side: "BUY" },
      status: "matched",
      makingAmount: "750000",
      takingAmount: "2000000",
    },
    side: "BUY",
    status: "matched",
  }),
  { shares: 2, notionalUsd: 0.75, fromPayload: true },
  "a partial FAK BUY must use the V2 response amounts, not its full signed fallback",
);
assert.deepEqual(
  extractPolymarketImmediateFill({
    fallbackPrice: 0.5,
    fallbackSize: 10,
    payload: {
      status: "matched",
      makingAmount: "2000000",
      takingAmount: "750000",
    },
    side: "SELL",
    status: "matched",
  }),
  { shares: 2, notionalUsd: 0.75, fromPayload: true },
  "a partial FAK SELL must map maker shares and taker USDC correctly",
);

console.log("ok - CLOB V2 immediate fills use actual making/taking amounts");

assert.equal(
  isPolymarketTradingPausedResponse({
    status: 503,
    message: "trading is disabled",
  }),
  true,
);
assert.equal(
  isPolymarketTradingPausedResponse({
    status: 503,
    message: "upstream timeout",
  }),
  false,
  "an unknown 503 must retain ambiguous submission handling",
);
assert.equal(
  isPolymarketTradingPausedResponse({
    status: 502,
    message: "trading is disabled",
  }),
  false,
  "the semantic exception is intentionally scoped to Polymarket's 503 contract",
);

console.log("ok - explicit trading pause is distinct from an unknown 5xx");

const clientSource = readFileSync(
  new URL("./services/polymarket-client.ts", import.meta.url),
  "utf8",
);
assert.doesNotMatch(
  clientSource,
  /AbortSignal\.timeout/,
  "shared Polymarket client must not crash Bun through an unhandled TimeoutError",
);

const executionSource = readFileSync(
  new URL(
    "./services/polymarket-trading-execution-service.ts",
    import.meta.url,
  ),
  "utf8",
);
assert.match(
  executionSource,
  /withinPolymarketInteractiveQuoteDeadline\(\s*quotePolymarketOrder\(/,
  "interactive quote timeout must remain inside the handled route contract",
);
assert.match(
  executionSource,
  /const definitiveRejection = tradingPaused \|\| upstream\.status < 500/,
  "an explicit trading pause must take the definitive rejection path",
);
assert.match(
  executionSource,
  /errorCode: tradingPaused[\s\S]*?POLYMARKET_TRADING_PAUSED_CODE[\s\S]*?broadcastMayHaveOccurred: !tradingPaused/,
  "a paused venue must release funded orders without recording an ambiguous broadcast",
);
assert.match(
  executionSource,
  /handoffFailure:[\s\S]*?code: POLYMARKET_TRADING_PAUSED_CODE[\s\S]*?message: POLYMARKET_TRADING_PAUSED_MESSAGE/,
  "a funded Telegram handoff must receive the same definitive pause reason",
);
assert.match(
  executionSource,
  /calculatePolymarketSignedBuyRequiredSpendRaw\([\s\S]*?orderType,[\s\S]*?postOnly:/,
  "final funded submit must recompute the same order-type-aware collateral bound",
);
assert.match(
  executionSource,
  /input\.body\.postOnly === true \? \{ postOnly: true \} : \{\}/,
  "postOnly must be forwarded to the Polymarket order endpoint",
);
assert.doesNotMatch(
  executionSource,
  /normalized === "FAK"\) return "FOK"/,
  "FAK must not be normalized into all-or-nothing FOK semantics",
);
assert.match(
  executionSource,
  /normalized === "FAK"[\s\S]*?return normalized;/,
  "FAK must remain a distinct venue order type through final submission",
);
assert.match(
  executionSource,
  /\(orderType === "FOK" \|\| orderType === "FAK"\)[\s\S]*?isImmediateExecutionStatus/,
  "FAK must use the immediate-execution confirmation path without becoming FOK",
);
assert.match(
  executionSource,
  /canonicalFingerprint = canonicalJsonHash\(\{[\s\S]*?orderType,[\s\S]*?postOnly: input\.body\.postOnly === true,/,
  "postOnly must be part of the exact funded Polymarket trade identity",
);

console.log("ok - Polymarket quote timeout stays route-scoped");
