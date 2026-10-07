// @requires-db
import assert from "node:assert/strict";
import { createClient } from "redis";
import {
  createPgPool,
  enqueuePriceRefreshTokens,
  claimDuePriceRefreshTokens,
  requeuePriceRefreshTokens,
  type PriceRefreshRedis,
} from "@hunch/infra";
import { fetchTradableTokenIdsForSnapshot } from "./bootstrap.js";
const databaseUrl = process.env.HUNCH_TEST_DATABASE_URL;
const expectedDatabase = process.env.HUNCH_TEST_EXPECT_DATABASE;
assert.ok(
  databaseUrl && expectedDatabase,
  "Explicit disposable DB URL/name required",
);
assert.equal(
  decodeURIComponent(new URL(databaseUrl).pathname.slice(1)),
  expectedDatabase,
);
const redisUrl = process.env.HUNCH_TEST_REDIS_URL;
assert.ok(redisUrl, "Explicit disposable Redis URL required");
assert.equal(new URL(redisUrl).hostname, "127.0.0.1");
assert.equal(new URL(redisUrl).port, "56643");
const pool = createPgPool({
  connectionString: databaseUrl,
  max: 1,
  options: "-c statement_timeout=10000",
});
const client = await pool.connect();
const redis = createClient({ url: redisUrl });
const key = "price-refresh:tokens:polymarket";
try {
  assert.equal(
    (await client.query("select current_database()")).rows[0].current_database,
    expectedDatabase,
  );
  assert.equal(
    Math.floor(
      Number(
        (await client.query("show server_version_num")).rows[0]
          .server_version_num,
      ) / 10000,
    ),
    16,
  );
  await client.query("begin");
  await client.query(`
    create temporary table unified_markets(id text primary key,venue text,venue_market_id text,status text);
    create temporary table unified_market_tokens(market_id text,token_id text,venue text);
    create temporary table unified_tokens(market_id text,token_id text,venue text);
    create temporary table polymarket_markets(id text primary key,closed boolean,archived boolean,enable_order_book boolean,accepting_orders boolean);
    insert into unified_markets values ('m','polymarket','native','ACTIVE'),('closed','polymarket','closed','CLOSED'),('disabled','polymarket','disabled','ACTIVE');
    insert into unified_market_tokens values ('m','1','polymarket'),('m','2','polymarket'),('closed','4','polymarket'),('disabled','5','polymarket');
    insert into unified_tokens values ('m','old','polymarket');
    insert into polymarket_markets values ('native',false,false,true,true),('closed',true,false,true,false),('disabled',false,false,true,false);
  `);
  let sql = "";
  let params: unknown[] = [];
  const db = {
    query: async (statement: string, values: unknown[]) => {
      sql = statement;
      params = values;
      return client.query(statement, values);
    },
  };
  const ids = ["2", "1", "old", "4", "5"];
  assert.deepEqual(
    await fetchTradableTokenIdsForSnapshot(ids, true, db as never),
    ["2", "1"],
  );
  const plan = await client.query(
    `explain (analyze,buffers,format json) ${sql}`,
    params,
  );
  assert.ok(plan.rows[0]["QUERY PLAN"][0].Plan);
  assert.deepEqual(await fetchTradableTokenIdsForSnapshot(ids, false, client), [
    "2",
    "1",
    "old",
  ]);
  assert.deepEqual(
    await fetchTradableTokenIdsForSnapshot(["absent"], true, client),
    [],
  );
  await redis.connect();
  assert.equal(await redis.zCard(key), 0, "Disposable queue must start empty");
  const queue = redis as unknown as PriceRefreshRedis;
  const now = Date.now();
  await enqueuePriceRefreshTokens(queue, {
    venue: "polymarket",
    priority: "high",
    tokenIds: ["1", "2"],
    nowMs: now,
  });
  await enqueuePriceRefreshTokens(queue, {
    venue: "polymarket",
    tokenIds: ["3"],
    nowMs: now,
  });
  assert.deepEqual(
    await claimDuePriceRefreshTokens(queue, {
      venue: "polymarket",
      priority: "normal",
      limit: 100,
      nowMs: now + 1,
    }),
    ["3"],
  );
  const high = await claimDuePriceRefreshTokens(queue, {
    venue: "polymarket",
    priority: "high",
    limit: 20,
    nowMs: now + 1,
  });
  assert.deepEqual(high, ["1", "2"]);
  await requeuePriceRefreshTokens(queue, {
    venue: "polymarket",
    tokenIds: high,
    delayMs: 0,
    nowMs: now + 2,
  });
  assert.deepEqual(
    await claimDuePriceRefreshTokens(queue, {
      venue: "polymarket",
      priority: "high",
      limit: 20,
      nowMs: now + 3,
    }),
    [],
  );
  assert.deepEqual(
    await claimDuePriceRefreshTokens(queue, {
      venue: "polymarket",
      priority: "normal",
      limit: 100,
      nowMs: now + 3,
    }),
    ["1", "2"],
  );
  await enqueuePriceRefreshTokens(queue, {
    venue: "polymarket",
    priority: "high",
    tokenIds: ["1"],
    nowMs: now + 4,
  });
  assert.deepEqual(
    await claimDuePriceRefreshTokens(queue, {
      venue: "polymarket",
      limit: 100,
      nowMs: now + 5,
    }),
    ["1"],
  );
  console.log(
    "[urgent-price-refresh-integration-tests] PG16 canonical/legacy/closed/empty SQL + real Redis Lua partition/repair/rollback passed",
  );
} finally {
  await client.query("rollback");
  client.release();
  await pool.end();
  if (redis.isOpen) {
    await redis.del(key);
    await redis.quit();
  }
}
