#!/usr/bin/env tsx

import assert from "node:assert/strict";

import type { Pool } from "@hunch/infra";

import {
  bestAskForToken,
  findTradeMarketByRef,
  findTradeMarketByRefForVenue,
  resolveTradeMarketByRef,
  resolveTradeMarketOutcomeIdentity,
  type ApiTradeMarket,
  venueScopedMarketContextCandidates,
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
  const queries: { sql: string; values: readonly unknown[] }[] = [];
  let queryCount = 0;
  const market = {
    id: "polymarket:561251",
    venue: "polymarket",
    venue_market_id: "561251",
  } as ApiTradeMarket;
  const pool = {
    query: async (sql: string, values: readonly unknown[]) => {
      queryCount += 1;
      queries.push({ sql, values });
      if (queryCount === 1) {
        assert.match(sql, /WHERE m\.id = \$1/i);
        return { rows: [], rowCount: 0 };
      }
      if (queryCount === 2) {
        return { rows: [{ id: market.id }], rowCount: 1 };
      }
      return { rows: [market], rowCount: 1 };
    },
  } as unknown as Pool;

  assert.equal(
    await findTradeMarketByRefForVenue(pool, "561251", "polymarket"),
    market,
  );
  assert.equal(queryCount, 3);
  assert.deepEqual(queries[1]?.values, ["561251", "polymarket"]);
  assert.match(queries[1]?.sql ?? "", /venue_market_id = \$1/i);
  assert.match(queries[1]?.sql ?? "", /venue = \$2/i);
  assert.match(queries[2]?.sql ?? "", /WHERE m\.id = \$1/i);
  assert.deepEqual(queries[2]?.values, [market.id]);
});

await test("canonical market ref uses only the indexed ID lookup", async () => {
  const market = {
    id: "polymarket:616902",
    venue: "polymarket",
    venue_market_id: "616902",
  } as ApiTradeMarket;
  const queries: string[] = [];
  const pool = {
    query: async (sql: string) => {
      queries.push(sql);
      return { rows: [market], rowCount: 1 };
    },
  } as unknown as Pool;

  assert.equal(await findTradeMarketByRef(pool, market.id), market);
  assert.equal(
    await findTradeMarketByRefForVenue(pool, market.id, "polymarket"),
    market,
  );
  assert.equal(queries.length, 2);
  for (const sql of queries) {
    assert.match(sql, /WHERE m\.id = \$1/i);
    assert.doesNotMatch(sql, /m\.venue_market_id = \$1/i);
  }
});

await test("market ref lookup resolves canonical YES and NO token IDs", async () => {
  const market = {
    id: "polymarket:616902",
    venue: "polymarket",
    venue_market_id: "616902",
  } as ApiTradeMarket;

  for (const side of ["YES", "NO"] as const) {
    const queries: string[] = [];
    const pool = {
      query: async (sql: string) => {
        queries.push(sql);
        if (/WHERE m\.id = \$1/i.test(sql) && queries.length === 1) {
          return { rows: [], rowCount: 0 };
        }
        if (/WHERE venue_market_id = \$1/i.test(sql)) {
          return { rows: [], rowCount: 0 };
        }
        if (/WHERE slug = \$1/i.test(sql)) {
          return { rows: [], rowCount: 0 };
        }
        if (
          /FROM unified_market_tokens/i.test(sql) &&
          /WHERE token_id = \$1/i.test(sql)
        ) {
          return {
            rows: [{ market_id: market.id, outcome_side: side }],
            rowCount: 1,
          };
        }
        assert.match(sql, /WHERE m\.id = \$1/i);
        return { rows: [market], rowCount: 1 };
      },
    } as unknown as Pool;

    const resolved = await resolveTradeMarketByRef(
      pool,
      `token-${side.toLowerCase()}`,
    );
    assert.equal(resolved?.market, market);
    assert.equal(resolved?.side, side);
    assert.equal(queries.length, 5);
    assert.match(queries[3] ?? "", /FROM unified_market_tokens/i);
    assert.match(queries[3] ?? "", /WHERE token_id = \$1/i);
    assert.match(queries[4] ?? "", /WHERE m\.id = \$1/i);
    for (const sql of queries) {
      assert.doesNotMatch(sql, /\bOR\b/i);
      const whereSql = sql.slice(sql.indexOf("WHERE"));
      assert.doesNotMatch(whereSql, /select umt\.token_id/i);
    }
  }
});

await test("exact market identity resolves venue-local tokens against a venue-scoped index", async () => {
  const market = {
    id: "limitless:340129",
    venue: "limitless",
    venue_market_id: "340129",
  } as ApiTradeMarket;
  const queries: { sql: string; values: readonly unknown[] }[] = [];
  const pool = {
    query: async (sql: string, values: readonly unknown[]) => {
      queries.push({ sql, values });
      if (/WHERE m\.id = \$1/i.test(sql)) {
        return { rows: [market], rowCount: 1 };
      }
      assert.match(sql, /FROM unified_market_tokens/i);
      return { rows: [{ outcome_side: "NO" }], rowCount: 1 };
    },
  } as unknown as Pool;
  const localToken =
    "17010889650761664535813980494830909251800363478221179782160919073160517899180";

  const resolved = await resolveTradeMarketOutcomeIdentity(pool, {
    venue: "limitless",
    marketId: market.id,
    marketContextId: localToken,
  });

  assert.equal(resolved?.market, market);
  assert.equal(resolved?.side, "NO");
  assert.deepEqual(queries[1]?.values, [
    market.id,
    "limitless",
    [localToken, `limitless:${localToken}`],
  ]);
  assert.match(queries[1]?.sql ?? "", /market_id = \$1/i);
  assert.match(queries[1]?.sql ?? "", /venue = \$2/i);
  assert.match(queries[1]?.sql ?? "", /token_id = ANY\(\$3::text\[\]\)/i);
});

await test("venue-scoped outcome candidates are generic and case-sensitive", async () => {
  assert.deepEqual(
    venueScopedMarketContextCandidates("future-venue", "Case:Sensitive/Token"),
    ["Case:Sensitive/Token", "future-venue:Case:Sensitive/Token"],
  );
  assert.deepEqual(
    venueScopedMarketContextCandidates(
      "future-venue",
      "future-venue:Case:Sensitive/Token",
    ),
    ["Case:Sensitive/Token", "future-venue:Case:Sensitive/Token"],
  );
});
