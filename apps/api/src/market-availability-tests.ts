import assert from "node:assert/strict";

import {
  computeAcceptingOrders,
  readDflowNativeAcceptingOrders,
} from "./lib/market-availability.js";

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

test("Kalshi requires DFlow-native accepting-orders flag", () => {
  const nowMs = Date.parse("2026-05-20T12:00:00Z");
  const base = {
    venue: "kalshi",
    status: "ACTIVE",
    closeTime: "2026-05-21T12:00:00Z",
    expirationTime: "2026-05-21T12:00:00Z",
    nowMs,
  };

  assert.equal(
    computeAcceptingOrders({
      ...base,
      dflowNativeAcceptingOrders: true,
    }),
    true,
  );
  assert.equal(
    computeAcceptingOrders({
      ...base,
      dflowNativeAcceptingOrders: false,
    }),
    false,
  );
  assert.equal(computeAcceptingOrders(base), false);
});

test("Kalshi finalized status remains non-accepting even with native flag", () => {
  assert.equal(
    computeAcceptingOrders({
      venue: "kalshi",
      status: "SETTLED",
      dflowNativeAcceptingOrders: true,
    }),
    false,
  );
});

test("Hyperliquid remains non-accepting while trading is unsupported", () => {
  assert.equal(
    computeAcceptingOrders({
      venue: "hyperliquid",
      status: "ACTIVE",
      closeTime: "2026-05-21T12:00:00Z",
      expirationTime: "2026-05-21T12:00:00Z",
      nowMs: Date.parse("2026-05-20T12:00:00Z"),
    }),
    false,
  );
});

test("reads DFlow-native accepting-orders from metadata", () => {
  assert.equal(
    readDflowNativeAcceptingOrders({ dflowNativeAcceptingOrders: true }),
    true,
  );
  assert.equal(
    readDflowNativeAcceptingOrders(
      JSON.stringify({ dflowNativeAcceptingOrders: false }),
    ),
    false,
  );
  assert.equal(readDflowNativeAcceptingOrders({}), null);
});
