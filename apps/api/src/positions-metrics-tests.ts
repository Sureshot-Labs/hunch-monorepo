#!/usr/bin/env tsx

import assert from "node:assert/strict";

import {
  buildDflowFill,
  buildLimitlessFill,
} from "./services/positions-metrics.js";

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

test("buildDflowFill uses fulfilled settlement amounts", () => {
  const fill = buildDflowFill({
    side: "BUY",
    status: "fulfilled",
    input_mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    output_mint: "3Badj8WD5B3hyQkuPnEyT93WtquC8xP186oys7ZppSkp",
    amount_in: "800015",
    amount_out: "1000000",
    input_decimals: 6,
    output_decimals: 6,
    raw: {
      settlement: {
        status: "closed",
        inAmount: "791771",
        outAmount: "1000000",
      },
    },
    created_at: new Date("2026-05-17T20:50:41Z"),
  });

  assert.ok(fill);
  assert.equal(
    fill?.tokenId,
    "sol:3Badj8WD5B3hyQkuPnEyT93WtquC8xP186oys7ZppSkp",
  );
  assert.equal(fill?.shares, 1);
  assert.equal(fill?.usdc, 0.791771);
});

test("buildDflowFill ignores non-terminal executions", () => {
  const fill = buildDflowFill({
    side: "BUY",
    status: "submitted",
    input_mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    output_mint: "3Badj8WD5B3hyQkuPnEyT93WtquC8xP186oys7ZppSkp",
    amount_in: "800015",
    amount_out: "1000000",
    input_decimals: 6,
    output_decimals: 6,
    raw: null,
    created_at: new Date("2026-05-17T20:50:41Z"),
  });

  assert.equal(fill, null);
});
