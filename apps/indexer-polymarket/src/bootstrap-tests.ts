#!/usr/bin/env node

import assert from "node:assert/strict";

process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/test";
process.env.REDIS_URL ??= "redis://localhost:6379";
process.env.POLYMARKET_GAMMA_BASE ??= "https://gamma.test";

const { appendUniqueWsTokenPairs, appendUniqueWsTokens } =
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

test("appendUniqueWsTokens preserves duration-first order and dedupes", () => {
  const out = ["duration-yes", "duration-no"];

  appendUniqueWsTokens(
    out,
    ["duration-no", "hot-yes", "hot-no", "duration-yes"],
    4,
  );

  assert.deepEqual(out, ["duration-yes", "duration-no", "hot-yes", "hot-no"]);
});

test("appendUniqueWsTokens caps reserved websocket tokens", () => {
  const out: string[] = [];

  appendUniqueWsTokens(out, ["a", "b", "c"], 2);
  appendUniqueWsTokens(out, ["d"], 2);

  assert.deepEqual(out, ["a", "b"]);
});

test("appendUniqueWsTokenPairs preserves complete pairs", () => {
  const out: string[] = [];

  appendUniqueWsTokenPairs(
    out,
    [
      ["duration-a-yes", "duration-a-no"],
      ["duration-b-yes", "duration-b-no"],
    ],
    4,
  );

  assert.deepEqual(out, [
    "duration-a-yes",
    "duration-a-no",
    "duration-b-yes",
    "duration-b-no",
  ]);
});

test("appendUniqueWsTokenPairs does not split an odd-cap pair", () => {
  const out: string[] = [];

  appendUniqueWsTokenPairs(
    out,
    [
      ["duration-a-yes", "duration-a-no"],
      ["duration-b-yes", "duration-b-no"],
    ],
    3,
  );

  assert.deepEqual(out, ["duration-a-yes", "duration-a-no"]);
});

test("appendUniqueWsTokenPairs can complete an existing partial pair", () => {
  const out = ["duration-a-yes"];

  appendUniqueWsTokenPairs(out, [["duration-a-yes", "duration-a-no"]], 2);

  assert.deepEqual(out, ["duration-a-yes", "duration-a-no"]);
});
