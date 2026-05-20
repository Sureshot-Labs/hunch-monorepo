#!/usr/bin/env tsx

import assert from "node:assert/strict";

import {
  extractLimitlessTokenBalances,
  isLimitlessPublicPortfolioUserNotFound,
  normalizePositionRefreshTokenIds,
} from "./services/positions-sync.js";

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

test("extracts Limitless public portfolio CLOB and AMM balances", () => {
  assert.deepEqual(
    extractLimitlessTokenBalances({
      clob: [
        {
          market: {
            position_ids: ["111", "222"],
          },
          tokensBalance: {
            yes: "2500000",
            no: "0",
          },
        },
      ],
      amm: [
        {
          market: {
            position_ids: ["333", "444"],
          },
          outcomeIndex: 1,
          outcomeTokenAmount: "1750000",
        },
      ],
    }),
    [
      { tokenId: "limitless:111", size: "2.5" },
      { tokenId: "limitless:444", size: "1.75" },
    ],
  );
});

test("detects empty Limitless public portfolio responses", () => {
  assert.equal(
    isLimitlessPublicPortfolioUserNotFound({ message: "User not found" }),
    true,
  );
  assert.equal(
    isLimitlessPublicPortfolioUserNotFound({ error: "User not found" }),
    true,
  );
  assert.equal(isLimitlessPublicPortfolioUserNotFound("User not found"), true);
  assert.equal(
    isLimitlessPublicPortfolioUserNotFound({
      message: "Rate limit exceeded",
    }),
    false,
  );
});
