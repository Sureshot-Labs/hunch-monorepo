#!/usr/bin/env tsx

import assert from "node:assert/strict";

import type { Pool } from "@hunch/infra";

import {
  bestAskForToken,
  findTradeMarketByRefForVenue,
  type ApiTradeMarket,
} from "./services/api-trading-market-repo.js";

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

await test("market ref lookup is constrained to the requested venue", async () => {
  let capturedSql = "";
  let capturedValues: readonly unknown[] = [];
  const market = {
    id: "polymarket:561251",
    venue: "polymarket",
    venue_market_id: "561251",
  } as ApiTradeMarket;
  const pool = {
    query: async (sql: string, values: readonly unknown[]) => {
      capturedSql = sql;
      capturedValues = values;
      return { rows: [market], rowCount: 1 };
    },
  } as unknown as Pool;

  assert.equal(
    await findTradeMarketByRefForVenue(pool, "561251", "polymarket"),
    market,
  );
  assert.deepEqual(capturedValues, ["561251", "polymarket"]);
  assert.match(capturedSql, /m\.venue = \$2/i);
  assert.match(capturedSql, /m\.venue_market_id = \$1/i);
});
