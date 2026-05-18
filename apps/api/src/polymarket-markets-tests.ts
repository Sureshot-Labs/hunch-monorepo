#!/usr/bin/env tsx

import assert from "node:assert/strict";

import type { Pool } from "@hunch/infra";
import {
  fetchPolymarketMarketInfo,
  type PolymarketMarketInfoRow,
} from "./repos/polymarket-markets.js";

type MockQuery = {
  sql: string;
  params: unknown[];
};

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

function buildRow(overrides: Partial<PolymarketMarketInfoRow> = {}) {
  return {
    polymarket_id: "pm-1",
    unified_market_id: "polymarket:pm-1",
    condition_id: "0xcondition",
    clob_token_ids: '["token-1","token-2"]',
    neg_risk: false,
    order_price_min_tick_size: "0.01",
    order_min_size: "5",
    accepting_orders: true,
    taker_fee_bps: "0",
    maker_fee_bps: "0",
    ...overrides,
  } satisfies PolymarketMarketInfoRow;
}

function createPoolMock(responses: PolymarketMarketInfoRow[][]): {
  pool: Pool;
  queries: MockQuery[];
} {
  const queries: MockQuery[] = [];
  const queue = [...responses];

  const pool = {
    async query(sql: string, params: unknown[] = []) {
      queries.push({ sql, params });
      return { rows: queue.shift() ?? [] };
    },
  } as unknown as Pool;

  return { pool, queries };
}

await test("fetchPolymarketMarketInfo uses unified_tokens fast path", async () => {
  const row = buildRow();
  const { pool, queries } = createPoolMock([[row]]);

  const result = await fetchPolymarketMarketInfo(pool, {
    tokenId: " token-1 ",
  });

  assert.equal(result, row);
  assert.equal(queries.length, 1);
  assert.match(queries[0]?.sql ?? "", /from unified_tokens ut/i);
  assert.doesNotMatch(queries[0]?.sql ?? "", /clob_token_ids::jsonb/i);
  assert.deepEqual(queries[0]?.params, ["token-1"]);
});

await test("fetchPolymarketMarketInfo falls back to clob_token_ids lookup", async () => {
  const fallbackRow = buildRow({ polymarket_id: "pm-fallback" });
  const { pool, queries } = createPoolMock([[], [fallbackRow]]);

  const result = await fetchPolymarketMarketInfo(pool, { tokenId: "token-1" });

  assert.equal(result, fallbackRow);
  assert.equal(queries.length, 2);
  assert.match(queries[0]?.sql ?? "", /from unified_tokens ut/i);
  assert.match(queries[1]?.sql ?? "", /clob_token_ids::jsonb\s*\?\s*\$1/i);
});

await test("fetchPolymarketMarketInfo returns null when token is unknown", async () => {
  const { pool, queries } = createPoolMock([[], []]);

  const result = await fetchPolymarketMarketInfo(pool, { tokenId: "missing" });

  assert.equal(result, null);
  assert.equal(queries.length, 2);
});
