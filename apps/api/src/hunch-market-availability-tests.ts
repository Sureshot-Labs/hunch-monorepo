import assert from "node:assert/strict";
import { publicHunchAcceptingOrders } from "./services/hunch-market-availability.js";

// Production Wales–Norway / Norway YES snapshot, October 1, 2026.
// Both venue dates equal gameStartTime while CLOB still accepts live orders.
const liveSportsMarket = {
  venue: "polymarket",
  status: "ACTIVE",
  eventStatus: "ACTIVE",
  closeTime: "2026-10-01T18:45:00Z",
  expirationTime: "2026-10-01T18:45:00Z",
  eventEndTime: "2026-10-01T18:45:00Z",
  resolvedOutcome: null,
  pmAcceptingOrders: true,
  nowMs: Date.parse("2026-10-01T18:58:33Z"),
};

for (const elapsed of [0, 2 * 60 * 60_000, 7 * 60 * 60_000]) {
  assert.equal(
    publicHunchAcceptingOrders({
      ...liveSportsMarket,
      nowMs: liveSportsMarket.nowMs + elapsed,
    }),
    true,
    "an active venue-accepted market matches the detail page after start",
  );
}
for (const patch of [
  { pmAcceptingOrders: false },
  { pmAcceptingOrders: null },
  { status: "CLOSED" },
  { status: "SETTLED" },
  { status: null },
  { eventStatus: "CLOSED" },
  { resolvedOutcome: "YES" },
  { resolvedOutcome: "NO" },
]) {
  assert.equal(
    publicHunchAcceptingOrders({ ...liveSportsMarket, ...patch }),
    false,
  );
}

const undatedMarket = {
  ...liveSportsMarket,
  closeTime: null,
  expirationTime: null,
  eventEndTime: null,
};
assert.equal(
  publicHunchAcceptingOrders({
    ...undatedMarket,
    pmAcceptingOrders: false,
  }),
  false,
  "a native refusal blocks Copy even without expired dates",
);
assert.equal(
  publicHunchAcceptingOrders({ ...undatedMarket, status: null }),
  false,
  "a missing joined market must not be treated as an active market",
);

for (const venue of ["limitless", "kalshi"]) {
  const market = { ...liveSportsMarket, venue, pmAcceptingOrders: null };
  assert.equal(
    publicHunchAcceptingOrders(market),
    false,
    "other venues keep time gates",
  );
  const openMarket = {
    ...market,
    closeTime: null,
    expirationTime: null,
    eventEndTime: null,
    dflowNativeAcceptingOrders: true,
  };
  assert.equal(publicHunchAcceptingOrders(openMarket), true);
  if (venue === "kalshi")
    assert.equal(
      publicHunchAcceptingOrders({
        ...openMarket,
        dflowNativeAcceptingOrders: false,
      }),
      false,
      "Kalshi retains its native DFlow guard",
    );
}
assert.equal(
  publicHunchAcceptingOrders({
    ...liveSportsMarket,
    closeTime: null,
    expirationTime: null,
    eventEndTime: null,
    eventStatus: null,
    pmAcceptingOrders: null,
  }),
  true,
  "missing native Polymarket data retains the shared active-time fallback",
);
console.log(
  "ok - public Hunch Copy availability matches market details without weakening execution",
);
