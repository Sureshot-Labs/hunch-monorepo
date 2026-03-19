#!/usr/bin/env tsx

import assert from "node:assert/strict";

import { buildLimitlessFill } from "./services/positions-metrics.js";

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

test("buildLimitlessFill ignores live orders with price and size", () => {
  const fill = buildLimitlessFill({
    token_id: "limitless:token",
    side: "BUY",
    status: "live",
    price: 0.01,
    size: 155,
    order_payload: {},
    filled_at: null,
    posted_at: new Date("2026-03-19T00:00:00Z"),
    last_update: new Date("2026-03-19T00:00:00Z"),
  });
  assert.equal(fill, null);
});

test("buildLimitlessFill keeps executed filled orders", () => {
  const fill = buildLimitlessFill({
    token_id: "limitless:token",
    side: "BUY",
    status: "filled",
    price: 0.01,
    size: 155,
    order_payload: {},
    filled_at: new Date("2026-03-19T00:00:00Z"),
    posted_at: new Date("2026-03-19T00:00:00Z"),
    last_update: new Date("2026-03-19T00:00:00Z"),
  });
  assert.ok(fill);
  assert.equal(fill?.shares, 155);
  assert.equal(fill?.usdc, 1.55);
});
