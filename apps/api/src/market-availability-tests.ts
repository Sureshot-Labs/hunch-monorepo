import assert from "node:assert/strict";

import {
  buildBroadOrderableMarketSql,
  buildEventHasBroadOrderableMarketSql,
  buildOrderableMarketSql,
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

test("Polymarket accepting-orders overrides recently stale close time", () => {
  assert.equal(
    computeAcceptingOrders({
      venue: "polymarket",
      status: "ACTIVE",
      closeTime: "2026-05-20T12:00:00Z",
      expirationTime: "2026-05-20T12:00:00Z",
      pmAcceptingOrders: true,
      nowMs: Date.parse("2026-05-20T15:00:00Z"),
    }),
    true,
  );

  assert.equal(
    computeAcceptingOrders({
      venue: "polymarket",
      status: "ACTIVE",
      closeTime: "2026-05-22T12:00:00Z",
      pmAcceptingOrders: false,
      nowMs: Date.parse("2026-05-21T12:00:00Z"),
    }),
    false,
  );
});

test("Polymarket accepting-orders does not override very old close time", () => {
  assert.equal(
    computeAcceptingOrders({
      venue: "polymarket",
      status: "ACTIVE",
      closeTime: "2026-05-20T12:00:00Z",
      expirationTime: "2026-05-20T12:00:00Z",
      pmAcceptingOrders: true,
      nowMs: Date.parse("2026-05-21T12:00:00Z"),
    }),
    false,
  );
});

test("Polymarket accepting-orders uses event end time in grace window", () => {
  const nowMs = Date.parse("2026-05-20T15:00:00Z");
  assert.equal(
    computeAcceptingOrders({
      venue: "polymarket",
      status: "ACTIVE",
      eventEndTime: "2026-05-20T12:00:00Z",
      pmAcceptingOrders: true,
      nowMs,
    }),
    true,
  );

  assert.equal(
    computeAcceptingOrders({
      venue: "polymarket",
      status: "ACTIVE",
      eventEndTime: "2026-05-20T08:00:00Z",
      pmAcceptingOrders: true,
      nowMs,
    }),
    false,
  );
});

test("Polymarket accepting-orders uses earliest terminal time", () => {
  assert.equal(
    computeAcceptingOrders({
      venue: "polymarket",
      status: "ACTIVE",
      closeTime: "2026-05-22T12:00:00Z",
      expirationTime: "2026-05-22T12:00:00Z",
      eventEndTime: "2026-05-20T08:00:00Z",
      pmAcceptingOrders: true,
      nowMs: Date.parse("2026-05-20T15:00:00Z"),
    }),
    false,
  );
});

test("non-Polymarket event end time remains strict", () => {
  const nowMs = Date.parse("2026-05-20T15:00:00Z");
  assert.equal(
    computeAcceptingOrders({
      venue: "limitless",
      status: "ACTIVE",
      closeTime: "2026-05-21T12:00:00Z",
      expirationTime: "2026-05-21T12:00:00Z",
      eventEndTime: "2026-05-20T12:00:00Z",
      nowMs,
    }),
    false,
  );
});

test("orderable SQL uses Polymarket accepting-orders with grace gate", () => {
  const sql = buildOrderableMarketSql({
    marketAlias: "m",
    eventAlias: "e",
    nowParam: "$1",
    pmAlias: "pm",
  });

  assert.match(sql, /m\.venue = 'polymarket'/);
  assert.match(sql, /pm\.accepting_orders = true/);
  assert.match(sql, /coalesce\(pm\.closed, false\) = false/);
  assert.match(sql, /coalesce\(e\.end_date, 'infinity'::timestamptz\)/);
  assert.match(sql, /interval '6 hours'/);
});

test("broad orderable SQL keeps strict and Polymarket grace branches simple", () => {
  const sql = buildBroadOrderableMarketSql({
    marketAlias: "m",
    eventAlias: "e",
    nowParam: "$1",
    pmAlias: "pm",
  });

  assert.match(sql, /m\.status = 'ACTIVE'/);
  assert.match(sql, /e\.status = 'ACTIVE'/);
  assert.match(sql, /m\.venue <> 'kalshi'/);
  assert.match(sql, /m\.venue = 'polymarket'/);
  assert.match(sql, /pm\.accepting_orders = true/);
  assert.match(sql, /interval '6 hours'/);
  assert.doesNotMatch(sql, /metadata->>'acceptingOrders'/);
});

test("event broad orderable SQL isolates Polymarket join to grace branch", () => {
  const sql = buildEventHasBroadOrderableMarketSql({
    eventAlias: "e",
    nowParam: "$1",
    renderableMarketSql: "om.id is not null",
  });

  assert.match(sql, /exists \(\s*select 1\s*from unified_markets om\s*where/s);
  assert.match(sql, /or exists \(\s*select 1\s*from unified_markets om\s*join polymarket_markets pm_om/s);
  assert.match(sql, /pm_om\.accepting_orders = true/);
  assert.doesNotMatch(sql, /left join polymarket_markets/);
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
