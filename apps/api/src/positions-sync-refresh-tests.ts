#!/usr/bin/env tsx

import assert from "node:assert/strict";

import { normalizePositionRefreshTokenIds } from "./services/positions-sync.js";

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

test("normalizes Polymarket refresh token candidates", () => {
  assert.deepEqual(
    normalizePositionRefreshTokenIds("polymarket", [
      " 123 ",
      "123",
      "abc",
      "",
      null,
      undefined,
      "456",
    ]),
    ["123", "456"],
  );
});

test("normalizes Kalshi refresh token candidates for DFlow tokens only", () => {
  assert.deepEqual(
    normalizePositionRefreshTokenIds("kalshi", [
      "sol:mint-a",
      "mint-a",
      "sol:mint-a",
      " sol:mint-b ",
    ]),
    ["sol:mint-a", "sol:mint-b"],
  );
});

test("normalizes Limitless refresh token candidates to scoped IDs", () => {
  assert.deepEqual(
    normalizePositionRefreshTokenIds("limitless", [
      "123",
      "limitless:123",
      "456:YES",
      "abc",
    ]),
    ["limitless:123", "limitless:456"],
  );
});
