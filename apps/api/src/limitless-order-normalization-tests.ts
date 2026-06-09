#!/usr/bin/env tsx

import assert from "node:assert/strict";

import {
  deriveLimitlessSignedOrderSize,
  normalizeLimitlessHistoryAmount,
  normalizeLimitlessMaybeRawAmount,
} from "./services/limitless-order-normalization.js";

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

test("deriveLimitlessSignedOrderSize normalizes FOK sell raw shares", () => {
  assert.equal(
    deriveLimitlessSignedOrderSize({
      orderType: "FOK",
      side: "SELL",
      makerAmount: 970_000,
      takerAmount: 1,
    }),
    0.97,
  );
});

test("deriveLimitlessSignedOrderSize does not treat FOK buy sentinel as size", () => {
  assert.equal(
    deriveLimitlessSignedOrderSize({
      orderType: "FOK",
      side: "BUY",
      makerAmount: 1_000_000,
      takerAmount: 1,
    }),
    null,
  );
});

test("normalizeLimitlessMaybeRawAmount handles order raw and decimal values", () => {
  assert.equal(normalizeLimitlessMaybeRawAmount("1000000"), 1);
  assert.equal(normalizeLimitlessMaybeRawAmount("970000"), 0.97);
  assert.equal(normalizeLimitlessMaybeRawAmount("1.0901"), 1.0901);
});

test("normalizeLimitlessHistoryAmount treats history values as human-readable", () => {
  assert.equal(normalizeLimitlessHistoryAmount("1000"), 1000);
  assert.equal(normalizeLimitlessHistoryAmount("1000000"), 1000000);
  assert.equal(normalizeLimitlessHistoryAmount("1.0901"), 1.0901);
});
