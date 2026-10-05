#!/usr/bin/env tsx

import assert from "node:assert/strict";
import "./integration-test-database-guard.js";
import crypto from "node:crypto";

import { buildApp } from "./app.js";
import { pool } from "./db.js";
import { env } from "./env.js";
import {
  COUNT_TRADES_BY_TOKEN_SQL,
  RECENT_TRADES_BY_TOKEN_SQL,
} from "./routes/trades.js";

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
  assert.match(RECENT_TRADES_BY_TOKEN_SQL, /cross join lateral/i);
  assert.match(
    RECENT_TRADES_BY_TOKEN_SQL,
    /where token_trade\.token_id = requested_tokens\.token_id/i,
  );
  assert.match(
    RECENT_TRADES_BY_TOKEN_SQL,
    /order by token_trade\.ts desc\s+limit \$4/i,
  );
  assert.doesNotMatch(RECENT_TRADES_BY_TOKEN_SQL, /where token_id = any\(/i);
  assert.match(COUNT_TRADES_BY_TOKEN_SQL, /cross join lateral/i);
  assert.doesNotMatch(COUNT_TRADES_BY_TOKEN_SQL, /count_capped/i);

  const app = await buildApp();
  const originalFetch = globalThis.fetch;
  try {
    let calls = 0;
    globalThis.fetch = (async (url) => {
      const requestUrl = new URL(String(url));
      assert.equal(requestUrl.pathname, "/v2/trades");
      assert.equal(requestUrl.searchParams.get("event_id"), "123");
      assert.equal(requestUrl.searchParams.has("offset"), false);
      calls++;
      return Response.json({
        data: [
          {
            token_id: "123",
            side: "SELL",
            timestamp: 1791220000,
            price: 0.4,
            size: 2,
            transaction_hash: "0xsynthetic",
          },
        ],
        pagination: { next_cursor: calls === 1 ? "opaque+/=" : null },
      });
    }) as typeof fetch;
    const first = await app.inject({
      method: "GET",
      url: "/trades?eventId=polymarket:123&paginationMode=cursor&limit=50",
    });
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(first.json().pagination.nextCursor, "opaque+/=");
    assert.equal(first.json().pagination.total, null);
    assert.equal(
      first.json().pagination.hasMore,
      true,
      "short page with cursor is not terminal",
    );
    const second = await app.inject({
      method: "GET",
      url: "/trades?eventId=polymarket:123&paginationMode=cursor&limit=50&cursor=opaque%2B%2F%3D",
    });
    assert.equal(second.statusCode, 200, second.body);
    assert.equal(second.json().pagination.hasMore, false);
    for (const query of [
      "eventId=limitless:123&paginationMode=cursor",
      "eventId=polymarket:123&paginationMode=cursor&offset=50",
      "eventId=polymarket:123&cursor=next",
    ]) {
      const invalid = await app.inject({
        method: "GET",
        url: `/trades?${query}`,
      });
      assert.equal(invalid.statusCode, 400, invalid.body);
    }
    globalThis.fetch = (async () =>
      Response.json(
        { code: "temporary", retryable: true },
        { status: 503 },
      )) as typeof fetch;
    const failed = await app.inject({
      method: "GET",
      url: "/trades?eventId=polymarket:123&paginationMode=cursor&cursor=next",
    });
    assert.equal(failed.statusCode, 503, failed.body);
    assert.equal(
      failed.json().code,
      "polymarket_trades_unavailable",
      "no local timeline fallback after cursor failure",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  const boundedSqlTokenId = `bounded-sql-test-token-${crypto.randomUUID()}`;
  try {
    await pool.query(
      `
        insert into unified_last_trade (
          token_id, venue, ts, price, size, side, tx_hash
        )
        select
          $1,
          'limitless',
          now() - trade_ordinal * interval '1 second',
          0.5,
          1,
          'BUY',
          'bounded-sql-' || trade_ordinal::text
        from generate_series(1, 5) as trade_series(trade_ordinal)
      `,
      [boundedSqlTokenId],
    );
    const recent = await pool.query<{ token_id: string }>(
      RECENT_TRADES_BY_TOKEN_SQL,
      [[boundedSqlTokenId], 2, 1, 3],
    );
    assert.equal(recent.rows.length, 2);
    assert.equal(
      recent.rows.every((row) => row.token_id === boundedSqlTokenId),
      true,
    );
    const exactCount = await pool.query<{ total: string }>(
      COUNT_TRADES_BY_TOKEN_SQL,
      [[boundedSqlTokenId]],
    );
    assert.deepEqual(exactCount.rows[0], { total: "5" });
  } finally {
    await pool.query("delete from unified_last_trade where token_id = $1", [
      boundedSqlTokenId,
    ]);
  }

  const mutablePool = pool as unknown as MutablePool;
  const originalQuery = mutablePool.query;
  const callOriginalQuery = originalQuery.bind(pool);
  let rawTradeQueries = 0;
  let tokenRegistryQueries = 0;
  let resolvedTokenLimit: unknown = null;
  let resolvedRowsCount = 201;

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
    if (/where\s+m\.event_id\s*=\s*\$1/i.test(sql)) {
      resolvedTokenLimit = (args[1] as unknown[] | undefined)?.[1];
      return {
        rows: Array.from({ length: resolvedRowsCount }, (_, index) => ({
          token_id: `resolved-live-test-token-${index}`,
        })),
      };
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

    const resolvedTooManyResponse = await app.inject({
      method: "GET",
      url: "/trades?eventId=limitless%3Awide-live-test&limit=8&offset=0",
    });
    assert.equal(
      resolvedTooManyResponse.statusCode,
      422,
      resolvedTooManyResponse.body,
    );
    assert.deepEqual(resolvedTooManyResponse.json(), {
      error: "resolved tokenIds length exceeded",
    });
    assert.equal(resolvedTokenLimit, 201);
    assert.equal(rawTradeQueries, 0);

    resolvedRowsCount = 3;
    const excessiveWorkResponse = await app.inject({
      method: "GET",
      url: "/trades?eventId=limitless%3Awide-live-test&limit=200&offset=10000",
    });
    assert.equal(excessiveWorkResponse.statusCode, 422);
    assert.deepEqual(excessiveWorkResponse.json(), {
      error: "trades query work exceeded",
    });
    assert.equal(rawTradeQueries, 0);

    const tokenId = `missing-live-test-token-${crypto.randomUUID()}`;
    const registryQueriesBeforeMissingToken = tokenRegistryQueries;
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
    assert.deepEqual(body.pagination, {
      total: 0,
      limit: 8,
      offset: 0,
      hasMore: false,
    });
    assert.equal(tokenRegistryQueries, registryQueriesBeforeMissingToken + 1);
    assert.equal(rawTradeQueries, 0);
  } finally {
    mutablePool.query = originalQuery;
    await app.close();
  }
}

// Route fixtures must not inherit sidecars, Redis or separate content pools
// from the developer's .env. Only the guarded disposable DB is in scope.
const runtimeSettings = {
  redisUrl: env.redisUrl,
  contentEnabled: env.contentEnabled,
  telegramVenueReconcileEnabled: env.telegramVenueReconcileEnabled,
};
try {
  env.redisUrl = "";
  env.contentEnabled = false;
  env.telegramVenueReconcileEnabled = false;
  await main();
} finally {
  Object.assign(env, runtimeSettings);
}
