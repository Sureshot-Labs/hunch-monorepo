// @api-integration
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createIntegrationTestPool } from "./test-database-target.js";
import { findTradeMarketById } from "./services/api-trading-market-repo.js";
import { createRecommendedSpendService } from "./services/recommended-spend.js";
import type { DbQuery } from "./db.js";
import Fastify from "fastify";
import { performance } from "node:perf_hooks";
import {
  validatorCompiler,
  serializerCompiler,
} from "fastify-type-provider-zod";
import { createRecommendedSpendRoutes } from "./routes/recommended-spend.js";
import { createTradingBookCache } from "./services/trading-book-cache.js";

const db = await createIntegrationTestPool({ max: 1 });
const client = await db.connect();
const schema = `spend_test_${randomUUID().replaceAll("-", "")}`;
const queries: string[] = [];
const marketDb: DbQuery = {
  query: (async (text: string, values: unknown[]) => {
    assert.ok(
      /^SELECT\b/i.test(text.trim()),
      "recommendation must only read PostgreSQL",
    );
    queries.push(text);
    return client.query(text, values);
  }) as DbQuery["query"],
};
try {
  await client.query(`create schema ${schema}; set search_path to ${schema};
    create table unified_events(id text primary key,title text,end_date timestamptz);
    create table unified_markets(id text primary key,venue text,venue_market_id text,event_id text,title text,slug text,status text,outcomes text,metadata jsonb,is_initialized boolean,clob_token_ids text,condition_id text,close_time timestamptz,expiration_time timestamptz,best_bid numeric,best_ask numeric,last_price numeric,updated_at timestamptz);
    create table polymarket_markets(id text primary key,condition_id text,neg_risk boolean,neg_risk_request_id text,question_id text,accepting_orders boolean,neg_risk_market_id text,raw jsonb);
    create index fixture_question on polymarket_markets(question_id);
    create table unified_market_tokens(market_id text,outcome_side text,token_id text,updated_at timestamptz);
    create index fixture_canonical_token on unified_market_tokens(market_id,outcome_side,updated_at desc,token_id);
    insert into unified_events values('event','Named event',null);
    insert into unified_markets(id,venue,venue_market_id,event_id,title,slug,status,outcomes,metadata,is_initialized,updated_at)
      select 'limitless:'||seed_row,'limitless',seed_row::text,'event','Named outcome','test-slug','ACTIVE','["Home","Away"]','{}',true,now() from generate_series(1,20000) as seed_row;
    insert into unified_market_tokens select id,'YES','1',now() from unified_markets;
    insert into unified_market_tokens select id,'NO','2',now() from unified_markets;
    analyze unified_markets; analyze unified_market_tokens; analyze polymarket_markets;
    begin read only; set local statement_timeout='15s'; set local lock_timeout='2s';`);
  const now = Date.now();
  const bookCache = createTradingBookCache();
  let upstreamCalls = 0;
  const service = createRecommendedSpendService({
    market: (id) => findTradeMarketById(marketDb, id),
    orderable: async (market) => market.status === "ACTIVE",
    polyContext: async () => {
      throw Error("no Poly in fixture");
    },
    limitlessBook: (slug) =>
      bookCache.load(slug, async () => {
        upstreamCalls++;
        return { tokenId: "1", asks: [{ price: "0.5", size: "100000000" }] };
      }),
    funds: async () => {
      throw Error("no private calls");
    },
    now: () => now,
  });
  const result = await service.read({
    marketId: "limitless:100",
    tokenId: "1",
    slippageBps: 30,
  });
  assert.equal(result.market.status, "ready");
  assert.equal(result.market.maxOrderAmountUsd, "50");
  assert.equal(result.outcomeLabel, "Home");
  assert.equal(
    queries.length,
    2,
    "bounded initial/final generation reads only",
  );
  assert.equal(
    (await client.query("show transaction_read_only")).rows[0]
      .transaction_read_only,
    "on",
  );
  await client.query(`prepare recommended_market(text) as ${queries[0]}`);
  for (const mode of ["force_custom_plan", "force_generic_plan"]) {
    await client.query(`set local plan_cache_mode=${mode}`);
    for (const id of ["limitless:100", "missing"]) {
      const plan = (
        await client.query(
          `explain (analyze,buffers,format json) execute recommended_market('${id}')`,
        )
      ).rows[0]["QUERY PLAN"][0];
      const serialized = JSON.stringify(plan);
      assert.ok(
        !/"Node Type":"Seq Scan","Parallel Aware":false,"Async Capable":false,"Relation Name":"unified_(markets|market_tokens)"/.test(
          serialized,
        ),
      );
      console.log(
        `Recommended-spend PG16 ${mode} ${id}: execution=${plan["Execution Time"]}ms`,
      );
    }
  }
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(
    createRecommendedSpendRoutes(
      service,
      async () => {},
      async () => true,
    ),
  );
  try {
    const timings: number[] = [];
    for (let i = 0; i < 100; i++) {
      const started = performance.now();
      const response = await app.inject({
        url: "/markets/limitless:100/recommended-spend?tokenId=1",
      });
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().market.status, "ready");
      timings.push(performance.now() - started);
    }
    timings.sort((left, right) => left - right);
    const p95 = timings[95] ?? Infinity;
    assert.ok(p95 <= 150);
    assert.equal(
      upstreamCalls,
      1,
      "all reads reuse the same public book snapshot",
    );
    console.log(
      `Recommended spend warm local PG16 HTTP-injection n=100 p95=${p95.toFixed(2)}ms, upstream fixture fetches=${upstreamCalls}`,
    );
  } finally {
    await app.close();
  }
  await client.query("rollback");
} finally {
  await client.query("rollback");
  await client.query(
    `deallocate all; set search_path to public; drop schema if exists ${schema} cascade`,
  );
  client.release();
  await db.end();
}
console.log(
  "Recommended spend exact market SQL, read-only response, normal/generic plans passed",
);
