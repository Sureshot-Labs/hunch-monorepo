#!/usr/bin/env node

import assert from "node:assert/strict";

process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/test";
process.env.REDIS_URL ??= "redis://localhost:6379";

const { appendUniqueTickers } = await import("./bootstrap.js");

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
