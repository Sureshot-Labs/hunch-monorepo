import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import {
  createVenueCoverageCache,
  type VenueCoverageRow,
} from "./services/venue-coverage-cache.js";

let now = 1_000_000,
  refreshes = 0,
  saves = 0,
  errors = 0;
let complete: (rows: VenueCoverageRow[]) => void = () => {};
let fail = false;
const rows = [
  {
    venue: "polymarket",
    active_markets: 2,
    markets_with_volume: 1,
    markets_with_liquidity: 0,
    markets_with_price: 2,
  },
];
const cache = createVenueCoverageCache({
  now: () => now,
  load: async () => null,
  save: async () => {
    saves++;
  },
  onError: () => {
    errors++;
  },
  refresh: async () => {
    refreshes++;
    if (fail) throw new Error("DB timeout");
    return new Promise((resolve) => {
      complete = resolve;
    });
  },
});
assert.deepEqual(cache.get(["polymarket"]), {
  rows: null,
  measuredAt: null,
  status: "pending",
});
await setImmediate();
for (let i = 0; i < 100; i++)
  assert.equal(cache.get(["polymarket"]).rows, null);
assert.equal(
  refreshes,
  1,
  "slow background query cannot produce a request stampede",
);
complete(rows);
await setImmediate();
assert.deepEqual(cache.get(["polymarket"]).rows, rows);
assert.equal(cache.get(["polymarket"]).status, "ready");
assert.equal(saves, 1);
now += 5 * 60_000;
fail = true;
assert.equal(cache.get(["polymarket"]).status, "stale");
await setImmediate();
assert.equal(errors, 1);
for (let i = 0; i < 100; i++)
  assert.deepEqual(cache.get(["polymarket"]).rows, rows);
assert.equal(refreshes, 2, "failure must back off, retaining measured counts");
now += 60_000;
cache.get(["polymarket"]);
await setImmediate();
assert.equal(refreshes, 3);
now += 24 * 60 * 60_000;
assert.equal(
  cache.get(["polymarket"]).rows,
  null,
  "expired snapshot is not returned forever",
);
await setImmediate();

let reads = 0;
const restored = createVenueCoverageCache({
  now: () => now,
  load: async () => {
    reads++;
    return { measuredAt: now, rows };
  },
  save: async () => {},
  onError: () => {},
  refresh: async (venues) => venues.map((venue) => ({ ...rows[0], venue })),
});
assert.equal(
  restored.get(["polymarket"]).rows,
  null,
  "cold GET does not wait even for storage",
);
await setImmediate();
assert.deepEqual(restored.get(["polymarket"]).rows, rows);
assert.equal(reads, 1);
assert.equal(
  restored.get(["limitless"]).rows,
  null,
  "snapshot cannot leak across policy venue sets",
);
await setImmediate();
assert.equal(restored.get(["limitless"]).rows?.[0].venue, "limitless");

for (const bad of [
  null,
  { measuredAt: now, rows: [{ ...rows[0], active_markets: null }] },
  { measuredAt: now, rows: [{ ...rows[0], markets_with_price: 3 }] },
  { measuredAt: now + 1, rows },
  { measuredAt: now, rows: [rows[0], rows[0]] },
]) {
  let called = 0;
  const subject = createVenueCoverageCache({
    now: () => now,
    load: async () => bad,
    save: async () => {},
    onError: () => {},
    refresh: async () => {
      called++;
      return rows;
    },
  });
  subject.get(["polymarket"]);
  await setImmediate();
  assert.equal(
    called,
    1,
    "malformed storage must not suppress the real refresh",
  );
  assert.deepEqual(subject.get(["polymarket"]).rows, rows);
}
const hungStorage = createVenueCoverageCache({
  now: () => now,
  load: () => new Promise(() => {}),
  save: async () => {},
  onError: () => {},
  refresh: async () => rows,
});
assert.equal(hungStorage.get(["polymarket"]).rows, null);
await new Promise((resolve) => setTimeout(resolve, 2100));
assert.deepEqual(
  hungStorage.get(["polymarket"]).rows,
  rows,
  "hung Redis cannot block the DB refresh forever",
);
console.log(
  "ok - coverage is nonblocking, scoped, validated, coalesced, stale-preserving and bounded",
);
