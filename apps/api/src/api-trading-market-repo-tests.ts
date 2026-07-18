#!/usr/bin/env tsx

import assert from "node:assert/strict";

import type { Pool } from "@hunch/infra";

import { bestAskForToken } from "./services/api-trading-market-repo.js";

async function test(name: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

await test("bestAskForToken applies strict canonical freshness", async () => {
  let row: {
    best_ask: string | null;
    best_bid: string | null;
    ts: Date | string | null;
  } = {
    best_ask: null,
    best_bid: null,
    ts: null,
  };
  let capturedSql = "";
  const pool = {
    query: async (sql: string) => {
      capturedSql = sql;
      return { rows: [row], rowCount: 1 };
    },
  } as unknown as Pool;

  row = {
    best_ask: "0.42",
    best_bid: "0.40",
    ts: new Date(),
  };
  assert.equal(await bestAskForToken(pool, "token-yes"), 0.42);

  row = { ...row, ts: new Date(Date.now() - 601_000) };
  assert.equal(await bestAskForToken(pool, "token-yes"), null);

  row = { ...row, ts: new Date(Date.now() + 1_000) };
  assert.equal(await bestAskForToken(pool, "token-yes"), null);

  row = { ...row, best_bid: "0.43", ts: new Date() };
  assert.equal(await bestAskForToken(pool, "token-yes"), null);

  assert.match(capturedSql, /select ts, best_bid, best_ask/i);
  assert.doesNotMatch(capturedSql, /interval '10 minutes'/i);
});
