#!/usr/bin/env node

import assert from "node:assert/strict";

process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/test";
process.env.REDIS_URL ??= "redis://localhost:6379";

const { appendUniqueTickers, shouldSkipStaleDflowNewMarketInsert } =
  await import("./bootstrap.js");

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

test("appendUniqueTickers preserves duration-first order and dedupes", () => {
  const out = ["duration-a", "duration-b"];

  appendUniqueTickers(out, ["duration-b", "hot-a", "hot-b"], 4);

  assert.deepEqual(out, ["duration-a", "duration-b", "hot-a", "hot-b"]);
});

test("appendUniqueTickers caps reserved websocket tickers", () => {
  const out: string[] = [];

  appendUniqueTickers(out, ["a", "b", "c"], 2);
  appendUniqueTickers(out, ["d"], 2);

  assert.deepEqual(out, ["a", "b"]);
});

test("stale dflow market policy only blocks new old kalshi inserts", () => {
  const dayMs = 24 * 60 * 60 * 1000;
  const nowMs = Date.UTC(2026, 5, 18);
  const existing = new Set(["kalshi:EXISTING"]);

  assert.equal(
    shouldSkipStaleDflowNewMarketInsert(
      {
        id: "kalshi:OLD",
        venue: "kalshi",
        close_time: new Date(nowMs - 91 * dayMs),
      },
      existing,
      nowMs,
    ),
    true,
  );
  assert.equal(
    shouldSkipStaleDflowNewMarketInsert(
      {
        id: "kalshi:EXISTING",
        venue: "kalshi",
        close_time: new Date(nowMs - 91 * dayMs),
      },
      existing,
      nowMs,
    ),
    false,
  );
  assert.equal(
    shouldSkipStaleDflowNewMarketInsert(
      {
        id: "kalshi:RECENT",
        venue: "kalshi",
        close_time: new Date(nowMs - 89 * dayMs),
      },
      existing,
      nowMs,
    ),
    false,
  );
  assert.equal(
    shouldSkipStaleDflowNewMarketInsert(
      {
        id: "polymarket:OLD",
        venue: "polymarket",
        close_time: new Date(nowMs - 91 * dayMs),
      },
      existing,
      nowMs,
    ),
    false,
  );
  assert.equal(
    shouldSkipStaleDflowNewMarketInsert(
      {
        id: "kalshi:EXPIRATION",
        venue: "kalshi",
        expiration_time: new Date(nowMs - 91 * dayMs),
      },
      existing,
      nowMs,
    ),
    true,
  );
});
