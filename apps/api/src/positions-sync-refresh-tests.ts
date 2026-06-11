#!/usr/bin/env tsx

import assert from "node:assert/strict";

import {
  extractLimitlessTokenBalances,
  fetchPolymarketDataApiSnapshotsForOwnersForTests,
  isLimitlessPublicPortfolioUserNotFound,
  normalizePositionRefreshTokenIds,
  resetPolymarketDataApiSnapshotCachesForTests,
} from "./services/positions-sync.js";

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

await test("normalizes Polymarket refresh token candidates", () => {
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

await test("normalizes Kalshi refresh token candidates for DFlow tokens only", () => {
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

await test("normalizes Limitless refresh token candidates to scoped IDs", () => {
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

await test("extracts Limitless public portfolio CLOB and AMM balances", () => {
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

await test("detects empty Limitless public portfolio responses", () => {
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

await test("caches aborted Polymarket Data API owner lookups as empty", async () => {
  const owner = "0xa5ef39c3d3e10d0b270233af41cac69796b12966";
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  let calls = 0;
  let warnings = 0;

  resetPolymarketDataApiSnapshotCachesForTests();
  globalThis.fetch = (async () => {
    calls += 1;
    throw new DOMException("This operation was aborted", "AbortError");
  }) as typeof fetch;
  console.warn = (...args: unknown[]) => {
    if (String(args[0]).includes("Polymarket Data API")) warnings += 1;
  };

  try {
    const first = await fetchPolymarketDataApiSnapshotsForOwnersForTests([
      owner,
    ]);
    const second = await fetchPolymarketDataApiSnapshotsForOwnersForTests([
      owner,
    ]);

    assert.equal(calls, 1);
    assert.equal(first.get(owner)?.size, 0);
    assert.equal(second.get(owner)?.size, 0);
    assert.equal(warnings, 1);
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
    resetPolymarketDataApiSnapshotCachesForTests();
  }
});

await test("caches successful Polymarket Data API owner lookups", async () => {
  const owner = "0xa5ef39c3d3e10d0b270233af41cac69796b12966";
  const originalFetch = globalThis.fetch;
  let calls = 0;

  resetPolymarketDataApiSnapshotCachesForTests();
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response(
      JSON.stringify([{ asset: "123", averagePrice: "0.42" }]),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  }) as typeof fetch;

  try {
    const first = await fetchPolymarketDataApiSnapshotsForOwnersForTests([
      owner,
    ]);
    const second = await fetchPolymarketDataApiSnapshotsForOwnersForTests([
      owner,
    ]);

    assert.equal(calls, 1);
    assert.equal(first.get(owner)?.get("123")?.averagePrice, "0.42");
    assert.equal(second.get(owner)?.get("123")?.averagePrice, "0.42");
  } finally {
    globalThis.fetch = originalFetch;
    resetPolymarketDataApiSnapshotCachesForTests();
  }
});
