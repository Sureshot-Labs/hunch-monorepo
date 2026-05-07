import assert from "node:assert/strict";
import type { Pool } from "pg";
import { selectHyperliquidBookTargetsFromDb } from "./bootstrap.js";

type TestFn = () => void | Promise<void>;

const tests: Array<{ name: string; fn: TestFn }> = [];

function test(name: string, fn: TestFn): void {
  tests.push({ name, fn });
}

test("selectHyperliquidBookTargetsFromDb preserves hot-token priority before volume fallback", async () => {
  const calls: unknown[][] = [];
  const pool = {
    query: async (_sql: string, params: unknown[]) => {
      calls.push(params);
      return {
        rows: [
          { token_id: "hyperliquid:100000070", coin: "#70" },
          { token_id: "hyperliquid:100000051", coin: "#51" },
          { token_id: "hyperliquid:100000050", coin: "#50" },
        ],
      };
    },
  } as unknown as Pool;

  const targets = await selectHyperliquidBookTargetsFromDb({
    pool,
    hotTokenIds: [
      "bad-token",
      "hyperliquid:100000070",
      "hyperliquid:100000070",
    ],
    maxTokens: 3,
  });

  assert.deepEqual(calls[0], [["hyperliquid:100000070"], 3]);
  assert.deepEqual(targets, [
    { tokenId: "hyperliquid:100000070", coin: "#70" },
    { tokenId: "hyperliquid:100000051", coin: "#51" },
    { tokenId: "hyperliquid:100000050", coin: "#50" },
  ]);
});

test("selectHyperliquidBookTargetsFromDb returns no targets when disabled by maxTokens", async () => {
  let called = false;
  const pool = {
    query: async () => {
      called = true;
      return { rows: [] };
    },
  } as unknown as Pool;

  const targets = await selectHyperliquidBookTargetsFromDb({
    pool,
    hotTokenIds: ["hyperliquid:100000070"],
    maxTokens: 0,
  });

  assert.deepEqual(targets, []);
  assert.equal(called, false);
});

for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}
