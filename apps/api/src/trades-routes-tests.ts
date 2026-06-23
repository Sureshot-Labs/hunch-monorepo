#!/usr/bin/env tsx

import assert from "node:assert/strict";
import crypto from "node:crypto";

import { buildApp } from "./app.js";
import { pool } from "./db.js";

type MutablePool = {
  query: (...args: unknown[]) => Promise<unknown>;
};

function querySql(args: unknown[]): string {
  const first = args[0];
  if (typeof first === "string") return first;
  if (first && typeof first === "object" && "text" in first) {
    return String((first as { text: unknown }).text);
  }
  return "";
}

async function main() {
  const app = await buildApp();
  const mutablePool = pool as unknown as MutablePool;
  const originalQuery = mutablePool.query;
  const callOriginalQuery = originalQuery.bind(pool);
  let rawTradeQueries = 0;
  let tokenRegistryQueries = 0;

  mutablePool.query = async (...args: unknown[]) => {
    const sql = querySql(args);
    if (/from\s+unified_last_trade/i.test(sql)) {
      rawTradeQueries += 1;
      throw new Error("unknown explicit tokenIds should not query raw trades");
    }
    if (
      /from\s+unified_tokens/i.test(sql) ||
      /from\s+unified_market_tokens/i.test(sql)
    ) {
      tokenRegistryQueries += 1;
    }
    return callOriginalQuery(...args);
  };

  try {
    const tooManyTokenIds = Array.from(
      { length: 201 },
      (_, index) => `too-many-live-test-token-${index}`,
    ).join(",");
    const tooManyResponse = await app.inject({
      method: "GET",
      url: `/trades?tokenIds=${encodeURIComponent(tooManyTokenIds)}&limit=8&offset=0`,
    });
    assert.equal(tooManyResponse.statusCode, 200, tooManyResponse.body);
    assert.deepEqual(tooManyResponse.json(), {
      error: "tokenIds length exceeded",
      message: "Max 200 tokenIds allowed per request.",
    });
    assert.equal(tokenRegistryQueries, 0);
    assert.equal(rawTradeQueries, 0);

    const tokenId = `missing-live-test-token-${crypto.randomUUID()}`;
    const response = await app.inject({
      method: "GET",
      url: `/trades?tokenIds=${encodeURIComponent(tokenId)}&limit=8&offset=0`,
    });
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json<{
      trades: unknown[];
      pagination: { total: number; limit: number; offset: number };
    }>();
    assert.deepEqual(body.trades, []);
    assert.deepEqual(body.pagination, { total: 0, limit: 8, offset: 0 });
    assert.equal(tokenRegistryQueries, 1);
    assert.equal(rawTradeQueries, 0);
  } finally {
    mutablePool.query = originalQuery;
    await app.close();
  }
}

await main();
