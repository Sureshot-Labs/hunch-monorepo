#!/usr/bin/env tsx

import assert from "node:assert/strict";
import { Interface } from "ethers";

import {
  extractLimitlessTokenBalances,
  fetchPolymarketDataApiSnapshotsForOwnersForTests,
  isLimitlessPublicPortfolioUserNotFound,
  normalizePositionRefreshTokenIds,
  prefetchPolymarketOwnerBalancesForWallets,
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

const testErc1155Iface = new Interface([
  "function balanceOfBatch(address[] accounts, uint256[] ids) view returns (uint256[])",
]);

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

await test("reuses run-local Polymarket ERC1155 balance cache", async () => {
  const owner = "0x0000000000000000000000000000000000000001";
  const originalFetch = globalThis.fetch;
  let rpcCalls = 0;
  resetPolymarketDataApiSnapshotCachesForTests();

  const pool = {
    query: async (sql: string) => {
      if (sql.includes("with current_funders")) {
        return { rows: [] };
      }
      if (sql.includes("with recent_order_tokens")) {
        return { rows: [{ token_id: "1" }] };
      }
      if (sql.includes("and is_hidden = true")) {
        return { rows: [] };
      }
      throw new Error(`Unexpected query in test: ${sql.slice(0, 80)}`);
    },
  } as unknown as import("@hunch/infra").Pool;

  globalThis.fetch = (async (input, init) => {
    if (input instanceof URL || String(input).includes("/positions")) {
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    const body = JSON.parse(String(init?.body ?? "{}")) as {
      params?: Array<{ data?: string } | string>;
    };
    const call = body.params?.[0];
    if (!call || typeof call === "string" || typeof call.data !== "string") {
      throw new Error("Expected ERC1155 eth_call payload");
    }
    rpcCalls += 1;
    const [_owners, ids] = testErc1155Iface.decodeFunctionData(
      "balanceOfBatch",
      call.data,
    ) as unknown as [string[], bigint[]];
    const balances = ids.map((id) => (id.toString() === "1" ? 5_000_000n : 0n));
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: testErc1155Iface.encodeFunctionResult("balanceOfBatch", [
          balances,
        ]),
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  }) as typeof fetch;

  try {
    const balanceCache = new Map<string, bigint>();
    const first = await prefetchPolymarketOwnerBalancesForWallets(pool, {
      userId: "user-1",
      walletAddresses: [owner],
      trackedTokenIds: ["2"],
      balanceCache,
    });
    const second = await prefetchPolymarketOwnerBalancesForWallets(pool, {
      userId: "user-1",
      walletAddresses: [owner],
      trackedTokenIds: ["2"],
      balanceCache,
    });

    assert.equal(rpcCalls, 1);
    assert.equal(first.rpcCallCount, 1);
    assert.equal(first.rpcBalanceCacheHits, 0);
    assert.equal(first.rpcBalanceCacheMisses, 2);
    assert.equal(second.rpcCallCount, 0);
    assert.equal(second.rpcBalanceCacheHits, 2);
    assert.equal(second.rpcBalanceCacheMisses, 0);
    assert.deepEqual(
      second.balancesByOwner.get(owner)?.map((balance) => balance.tokenId),
      ["1"],
    );
  } finally {
    globalThis.fetch = originalFetch;
    resetPolymarketDataApiSnapshotCachesForTests();
  }
});

await test("run-local Polymarket balance cache does not bypass hidden token filtering", async () => {
  const owner = "0x0000000000000000000000000000000000000001";
  const originalFetch = globalThis.fetch;
  let rpcCalls = 0;
  resetPolymarketDataApiSnapshotCachesForTests();

  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      if (sql.includes("with current_funders")) {
        return { rows: [] };
      }
      if (sql.includes("with recent_order_tokens")) {
        return { rows: [{ token_id: "1" }] };
      }
      if (sql.includes("and is_hidden = true")) {
        return {
          rows: params?.[0] === "user-2" ? [{ token_id: "1" }] : [],
        };
      }
      throw new Error(`Unexpected query in test: ${sql.slice(0, 80)}`);
    },
  } as unknown as import("@hunch/infra").Pool;

  globalThis.fetch = (async (input, init) => {
    if (input instanceof URL || String(input).includes("/positions")) {
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    const body = JSON.parse(String(init?.body ?? "{}")) as {
      params?: Array<{ data?: string } | string>;
    };
    const call = body.params?.[0];
    if (!call || typeof call === "string" || typeof call.data !== "string") {
      throw new Error("Expected ERC1155 eth_call payload");
    }
    rpcCalls += 1;
    const [_owners, ids] = testErc1155Iface.decodeFunctionData(
      "balanceOfBatch",
      call.data,
    ) as unknown as [string[], bigint[]];
    const balances = ids.map((id) => (id.toString() === "1" ? 5_000_000n : 0n));
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: testErc1155Iface.encodeFunctionResult("balanceOfBatch", [
          balances,
        ]),
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  }) as typeof fetch;

  try {
    const balanceCache = new Map<string, bigint>();
    await prefetchPolymarketOwnerBalancesForWallets(pool, {
      userId: "user-1",
      walletAddresses: [owner],
      trackedTokenIds: ["2"],
      balanceCache,
    });
    const hiddenForSecondUser = await prefetchPolymarketOwnerBalancesForWallets(
      pool,
      {
        userId: "user-2",
        walletAddresses: [owner],
        trackedTokenIds: ["2"],
        balanceCache,
      },
    );

    assert.equal(rpcCalls, 1);
    assert.deepEqual(hiddenForSecondUser.candidateTokenIds, []);
    assert.deepEqual(hiddenForSecondUser.unionTokenIds, ["2"]);
    assert.equal(hiddenForSecondUser.rpcCallCount, 0);
    assert.equal(hiddenForSecondUser.rpcBalanceCacheHits, 1);
    assert.deepEqual(hiddenForSecondUser.balancesByOwner.get(owner), []);
  } finally {
    globalThis.fetch = originalFetch;
    resetPolymarketDataApiSnapshotCachesForTests();
  }
});
