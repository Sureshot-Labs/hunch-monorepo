import assert from "node:assert/strict";
import { Pool } from "pg";
import {
  fetchFeedEventIds,
  fetchFeedMarketsDirect,
  fetchObservedCanonicalProbabilityMarketIds,
  fetchFeedMarketIdsForProbabilityProbe,
  type FeedInputs,
} from "./repos/unified-read.js";
import { fetchProbabilityFeedEventPage } from "./probability-feed-page.js";
import { fetchPolymarketMarketInfo } from "./repos/polymarket-markets.js";

// Explicit disposable target only: never load DATABASE_URL or repository .env.
const target = process.env.FEED_NULL_TEST_DATABASE_URL;
assert.ok(
  target,
  "Set FEED_NULL_TEST_DATABASE_URL to a local disposable PostgreSQL 16 database",
);
const url = new URL(target);
assert.ok(["localhost", "127.0.0.1"].includes(url.hostname));
assert.equal(url.pathname, "/por30_mar35_disposable_20260915");
const pool = new Pool({ connectionString: target, max: 1 });
const schema = `feed_null_fixture_${process.pid}`;
let schemaCreated = false;
const base: FeedInputs = {
  limit: 2,
  offset: 0,
  minVol: 0,
  minLiquidity: 0,
  sort: "change24h",
  sortDir: "desc",
  nowParam: "2026-09-15T12:00:00Z",
  sevenDaysAgo: "2026-09-08T12:00:00Z",
  sevenDaysFromNow: "2026-09-22T12:00:00Z",
};
async function captureRankQuery(run: (capturePool: Pool) => Promise<unknown>) {
  let captured: { sql: string; params: unknown[] } | undefined;
  const stop = new Error("captured rank query");
  const query = async (sql: string, params: unknown[] = []) => {
    if (/^(begin|commit|rollback|set local)\b/i.test(sql.trim()))
      return { rows: [] };
    captured = { sql, params };
    throw stop;
  };
  await assert.rejects(
    run({
      query,
      connect: async () => ({ query, release() {} }),
    } as unknown as Pool),
    (error) => error === stop,
  );
  assert.ok(captured);
  return captured;
}
try {
  assert.equal(
    (
      await pool.query("show server_version_num")
    ).rows[0].server_version_num.slice(0, 2),
    "16",
  );
  await pool.query(`create schema ${schema}`);
  schemaCreated = true;
  await pool.query(`set search_path to ${schema}, public`);
  await pool.query(`
    create table unified_events (
      id text primary key, venue text default 'polymarket', venue_event_id text,
      status text default 'ACTIVE', start_date timestamptz default '2026-09-15T10:00:00Z',
      end_date timestamptz default '2026-09-16T12:00:00Z', category text, title text,
      volume_total numeric default 10, volume_24h numeric default 10, liquidity numeric default 10,
      open_interest numeric default 0, metadata jsonb default '{}'
    );
    create table unified_markets (
      id text primary key, event_id text references unified_events, venue text default 'polymarket',
      venue_market_id text, status text default 'ACTIVE', close_time timestamptz,
      expiration_time timestamptz, created_at timestamptz default '2026-09-15T10:00:00Z',
      updated_at timestamptz default '2026-09-15T11:59:00Z', metadata jsonb default '{}',
      volume_total numeric default 10, volume_24h numeric default 10, liquidity numeric default 10,
      open_interest numeric default 0, best_bid numeric default 0.49, best_ask numeric default 0.51,
      last_price numeric default 0.5, clob_token_ids text, condition_id text, title text,
      token_yes text, token_no text
    );
    create index on unified_markets(event_id);
    create table polymarket_markets (
      id text primary key, accepting_orders boolean default true, active boolean default true,
      closed boolean default false, archived boolean default false, condition_id text,
      clob_token_ids text, neg_risk boolean, order_price_min_tick_size numeric,
      order_min_size numeric, raw jsonb default '{}'
    );
    create table unified_tokens (token_id text, market_id text, venue text);
    create table unified_market_tokens (market_id text, outcome_side text, token_id text, updated_at timestamptz);
    create table unified_token_top_latest (token_id text primary key, best_bid numeric, best_ask numeric);
    create table unified_market_change_24h (market_id text primary key, change_24h numeric, calculation_version int);
    create table unified_event_change_24h (event_id text primary key, change_24h numeric, calculation_version int);
    create index on unified_market_change_24h(change_24h, market_id) where calculation_version = 2 and change_24h is not null;
    create index on unified_event_change_24h(change_24h, event_id) where calculation_version = 2 and change_24h is not null;
    insert into unified_events(id) select 'e' || n from generate_series(1,5) n;
    insert into unified_markets(id,event_id,venue_market_id,clob_token_ids,condition_id)
      select 'm' || n, 'e' || n, 'pm' || n, '["token' || n || '"]', 'condition' || n from generate_series(1,5) n;
    insert into polymarket_markets(id,condition_id) select 'pm' || n, 'condition' || n from generate_series(1,5) n;
    insert into unified_tokens values ('token1','m1','polymarket');
    insert into unified_token_top_latest select 'token' || n, 0.49, 0.51 from generate_series(1,5) n;
    insert into unified_market_change_24h values ('m1',0.2,2),('m2',-0.1,2),('m3',null,2),('m4',99,1);
    insert into unified_event_change_24h values ('e1',0.2,2),('e2',-0.1,2),('e3',null,2),('e4',99,1);
  `);
  for (const sortDir of ["asc", "desc"] as const) {
    const expected =
      sortDir === "asc"
        ? ["m2", "m1", "m3", "m4", "m5"]
        : ["m1", "m2", "m3", "m4", "m5"];
    for (const scope of [
      {},
      { ageSince: "2026-09-14T12:00:00Z" },
      { endWithin: "2026-09-17T12:00:00Z" },
      { marketIds: expected },
    ]) {
      for (const offset of [0, 1, 2, 3, 4, 5, 9]) {
        const result = await fetchFeedMarketIdsForProbabilityProbe(pool, {
          ...base,
          ...scope,
          sortDir,
          offset,
        });
        assert.deepEqual(
          result.marketIds,
          expected.slice(offset, offset + 2),
          JSON.stringify({ scope, sortDir, offset }),
        );
      }
    }
    for (const offset of [0, 1, 2, 3, 4, 5, 9]) {
      const result = await fetchFeedEventIds(pool, {
        ...base,
        sortDir,
        offset,
        view: "events",
      });
      assert.deepEqual(
        result.map((row) => row.id),
        expected.slice(offset, offset + 2).map((id) => id.replace("m", "e")),
      );
    }
  }
  // The route filters canonical live probability AFTER cache ranking.
  await pool.query(
    "update unified_token_top_latest set best_bid=0.89,best_ask=0.91 where token_id='token5'",
  );
  for (const sortDir of ["asc", "desc"] as const) {
    const inputs: FeedInputs = {
      ...base,
      sortDir,
      view: "events",
      limit: 10,
      venues: ["polymarket"],
      ageSince: "2026-09-14T12:00:00Z",
    };
    const result = await fetchProbabilityFeedEventPage({
      requestedLimit: 10,
      candidateWindowSize: 10,
      probabilityBatchSize: 10,
      maxCandidates: 100,
      fetchCandidateEvents: ({ limit, offset }) =>
        fetchFeedEventIds(pool, { ...inputs, limit, offset }),
      fetchBatchProbabilityMarketIds: (candidateEventIds) =>
        fetchObservedCanonicalProbabilityMarketIds(pool, {
          ...inputs,
          candidateEventIds,
          minProb: 0.4,
          maxProb: 0.6,
        }),
      fetchFilteredEvents: (marketIds) =>
        fetchFeedEventIds(pool, { ...inputs, marketIds }),
    });
    assert.deepEqual(
      result.eventRows.map((row) => row.id),
      sortDir === "asc" ? ["e2", "e1", "e3", "e4"] : ["e1", "e2", "e3", "e4"],
    );
  }
  for (const scope of [
    {},
    { ageSince: "2026-09-14T12:00:00Z" },
    { marketIds: ["m1", "m2", "m3", "m4", "m5"] },
  ]) {
    const captured = await captureRankQuery((capturePool) =>
      fetchFeedMarketsDirect(capturePool, { ...base, ...scope }),
    );
    assert.doesNotMatch(
      captured.sql,
      /unified_book_top|observed_market_change_24h/,
    );
    const plan = (
      await pool.query(
        `explain (analyze, buffers, format json) ${captured.sql}`,
        captured.params,
      )
    ).rows[0]["QUERY PLAN"][0];
    console.log(
      `rank fixture ${JSON.stringify(scope)}: ${plan["Execution Time"]} ms`,
    );
  }
  await pool.query(
    "truncate unified_market_change_24h, unified_event_change_24h",
  );
  assert.deepEqual(
    (await fetchFeedMarketIdsForProbabilityProbe(pool, base)).marketIds,
    ["m1", "m2"],
  );
  assert.deepEqual(
    (await fetchFeedEventIds(pool, { ...base, view: "events" })).map(
      (row) => row.id,
    ),
    ["e1", "e2"],
  );
  // A passed end time alone must preserve the existing six-hour sports grace.
  await pool.query(
    "update unified_events set end_date='2026-09-15T11:00:00Z' where id='e5'",
  );
  assert.deepEqual(
    (await fetchFeedMarketIdsForProbabilityProbe(pool, { ...base, limit: 10 }))
      .marketIds,
    ["m1", "m2", "m3", "m4", "m5"],
  );
  await pool.query(
    "update polymarket_markets set accepting_orders=false where id='pm5'",
  );
  assert.deepEqual(
    (await fetchFeedMarketIdsForProbabilityProbe(pool, { ...base, limit: 10 }))
      .marketIds,
    ["m1", "m2", "m3", "m4"],
  );
  for (const lookup of [
    { tokenId: "token1" },
    { tokenId: "token2" },
    { conditionId: "condition1" },
    { marketId: "m1" },
    { marketId: "pm1" },
  ]) {
    await fetchPolymarketMarketInfo(pool, lookup);
  }
  await pool.query(
    "update unified_markets set status='CLOSED' where id='m1'; update polymarket_markets set accepting_orders=false, closed=true where id='pm1'",
  );
  const closed = await fetchPolymarketMarketInfo(pool, { tokenId: "token1" });
  assert.equal(closed?.market_status, "CLOSED");
  assert.equal(closed?.closed, true);
  await pool.query(`
    insert into unified_events(id,start_date)
      select 'stress-e-' || lpad(n::text,3,'0'),
        case when n > 148 then null else '2026-09-15T11:00:00Z'::timestamptz - (n/5)*interval '1 minute' end
      from generate_series(1,150) n;
    insert into unified_markets(id,event_id,venue_market_id,liquidity)
      select 'stress-m-' || lpad(n::text,3,'0'), 'stress-e-' || lpad(n::text,3,'0'),
        'stress-pm-' || n, case when n <= 64 then 0 else 100 end from generate_series(1,150) n;
    insert into unified_markets(id,event_id,venue_market_id,liquidity)
      values ('stress-m-090b','stress-e-090','stress-pm-090b',100);
    insert into unified_market_change_24h values ('stress-m-080',0.2,2),('stress-m-120',-0.1,2);
  `);
  const allMarketIds = (
    await pool.query("select id from unified_markets")
  ).rows.map((row) => String(row.id));
  for (const sortDir of ["asc", "desc"] as const) {
    for (const offset of [0, 1, 2, 7, 30, 70, 84, 86, 100]) {
      const inputs: FeedInputs = {
        ...base,
        limit: 7,
        offset,
        sortDir,
        minLiquidity: 20,
      };
      const actual = await fetchFeedMarketIdsForProbabilityProbe(pool, inputs);
      const exact = await fetchFeedMarketIdsForProbabilityProbe(pool, {
        ...inputs,
        marketIds: allMarketIds,
      });
      assert.deepEqual(
        actual.marketIds,
        exact.marketIds,
        `expanded prefix, ties, undated events: ${sortDir}/${offset}`,
      );
    }
  }
  console.log(
    "ok - PostgreSQL 16: numeric/null/absent/old-version metrics, both directions, boundary pagination, empty caches, market-info SQL, expanded sparse prefixes and undated events",
  );
} finally {
  if (schemaCreated) await pool.query(`drop schema ${schema} cascade`);
  await pool.end();
}
