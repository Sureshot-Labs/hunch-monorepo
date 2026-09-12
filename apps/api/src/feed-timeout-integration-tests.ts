#!/usr/bin/env tsx
// @integration
import assert from "node:assert/strict";
import type { Pool } from "@hunch/infra";
import { createIntegrationTestPool } from "./test-database-target.js";
import { fetchFeedEventIds, type FeedInputs } from "./repos/unified-read.js";

const db = await createIntegrationTestPool({ max: 1 });
const client = await db.connect();
// Repository transactions share this isolated fixture transaction; all tables
// are temporary and the fixture is rolled back even when an assertion fails.
const query = async (sql: string, params: unknown[] = []) => {
  if (/^\s*(BEGIN|COMMIT|ROLLBACK)\s*$/i.test(sql)) return { rows: [] };
  return client.query(sql, params);
};
const fixturePool = {
  query,
  connect: async () => ({ query, release() {} }),
} as unknown as Pool;
const now = "2026-09-12T12:00:00Z";
const base: FeedInputs = {
  limit: 50,
  offset: 0,
  minVol: 0,
  minLiquidity: 0,
  view: "events",
  venues: ["polymarket", "limitless", "kalshi"],
  nowParam: now,
  sevenDaysAgo: "2026-09-05T12:00:00Z",
  sevenDaysFromNow: "2026-09-19T12:00:00Z",
};
try {
  await client.query("BEGIN");
  await client.query("SET LOCAL statement_timeout = '10s'");
  await client.query(`
    create temporary table unified_events (
      id text primary key, venue text, venue_event_id text, status text,
      title text, category text, start_date timestamptz, end_date timestamptz,
      volume_total numeric, volume_24h numeric, liquidity numeric,
      open_interest numeric, duration_minutes integer
    ) on commit drop;
    create temporary table unified_markets (
      id text primary key, event_id text, venue text, venue_market_id text,
      status text, volume_total numeric, volume_24h numeric, liquidity numeric,
      open_interest numeric, best_bid numeric, best_ask numeric, last_price numeric,
      close_time timestamptz, expiration_time timestamptz, duration_minutes integer,
      metadata jsonb
    ) on commit drop;
    create temporary table polymarket_markets (
      id text primary key, accepting_orders boolean, active boolean,
      closed boolean, archived boolean
    ) on commit drop;
    insert into unified_events
    select 'event-' || n, case when n=9 then 'limitless' when n>=10 then 'kalshi' else 'polymarket' end,
      n::text, case when n=12 then 'CLOSED' else 'ACTIVE' end,
      'Fixture ' || n, 'politics', '2026-09-10T12:00:00Z',
      case when n=8 then '2026-09-12T01:00:00Z'::timestamptz
        when n in (5,6,7) then '2026-09-12T11:00:00Z'::timestamptz
        else '2026-09-13T12:00:00Z'::timestamptz end,
      case when n in (1,5,9,10,11) then null when n=2 then 0 else 100 end,
      0, case when n=2 then 0 else 10 end, 3, 60
    from generate_series(1,12) n;
    insert into unified_markets
    select 'market-' || e.venue_event_id || '-' || n, e.id, e.venue,
      e.venue_event_id || '-' || n, 'ACTIVE',
      case when e.id='event-1' then 20000 when e.id='event-2' then 9000 else 1000 end,
      0, case when e.id='event-2' then 200 else 20 end, 4,
      0.4, case when e.id='event-3' and n=1 then 0.8 else 0.45 end, 0.425,
      e.end_date, e.end_date, 60,
      case when e.id='event-11' then '{}'::jsonb else '{"dflowNativeAcceptingOrders":true}'::jsonb end
    from unified_events e cross join generate_series(1,2) n
    where n=1 or e.id in ('event-2','event-3','event-5');
    insert into polymarket_markets
    select venue_market_id, event_id <> 'event-6', true, false, false
    from unified_markets where venue='polymarket' and event_id <> 'event-7';
    -- Inactive/unrenderable children must not change single/grouped scope.
    insert into unified_markets
    select 'inactive-child', 'event-1', 'polymarket', 'inactive-child', 'CLOSED',
      999999,0,1,1,0.4,0.5,0.45,null,null,60,'{}'::jsonb;
    insert into unified_markets
    select 'empty-child', 'event-1', 'polymarket', 'empty-child', 'ACTIVE',
      0,0,0,0,null,null,null,null,null,60,'{}'::jsonb;
    insert into unified_events
    select 'zero-volume', 'polymarket', 'zero-volume', 'ACTIVE', 'Zero', 'politics',
      null, null, null, 0, 0, 0, 60;
    insert into unified_markets
    select 'zero-volume-market', 'zero-volume', 'polymarket', 'zero-volume-market', 'ACTIVE',
      0,0,0,0,0.4,0.5,0.45,null,null,60,'{}'::jsonb;
    -- Broad indexed availability deliberately keeps strict markets even
    -- when the PM row says false; grace still requires explicit acceptance.
    update polymarket_markets set accepting_orders=false where id='1-1';
    -- Missing event interest must fall back to its eligible children. Liquidity
    -- and spread must qualify on the same child, not two different children.
    update unified_events set open_interest=null where id='event-1';
    update unified_events set open_interest=0 where id='event-5';
    update unified_markets set liquidity=200 where id='market-3-1';
  `);
  const allMarketIds = (
    await client.query<{ id: string }>("select id from unified_markets")
  ).rows.map((row) => row.id);
  let cases = 0;
  for (const eventScope of ["single", "grouped"] as const) {
    for (const sort of [
      undefined,
      "trending",
      "totalvol",
      "liquidity",
      "openinterest",
      "time",
    ]) {
      for (const sortDir of ["asc", "desc"] as const) {
        for (const qualifiers of [
          {},
          { minLiquidity: 100, maxSpread: 0.1 },
          { minVol: 500, minLiquidity: 100, maxSpread: 0.1 },
        ]) {
          const input = { ...base, eventScope, sort, sortDir, ...qualifiers };
          const actual = await fetchFeedEventIds(fixturePool, input);
          // Supplying every fixture market forces the unchanged exact GROUP BY
          // path; this is the semantic oracle, not another copy of fast SQL.
          const expected = await fetchFeedEventIds(fixturePool, {
            ...input,
            marketIds: allMarketIds,
          });
          assert.deepEqual(actual, expected, JSON.stringify(input));
          const page = await fetchFeedEventIds(fixturePool, {
            ...input,
            limit: 1,
            offset: 1,
          });
          assert.deepEqual(
            page,
            expected.slice(1, 2),
            `pagination ${JSON.stringify(input)}`,
          );
          cases += 1;
        }
      }
    }
  }
  const singles = await fetchFeedEventIds(fixturePool, {
    ...base,
    eventScope: "single",
  });
  assert.ok(singles.some((row) => row.id === "event-1"));
  assert.ok(singles.some((row) => row.id === "zero-volume"));
  for (const excluded of [
    "event-6",
    "event-7",
    "event-8",
    "event-11",
    "event-12",
  ]) {
    assert.ok(!singles.some((row) => row.id === excluded), excluded);
  }
  console.log(
    `ok - ${cases} exact event scope/filter/sort comparisons plus pagination and lifecycle`,
  );
} finally {
  await client.query("ROLLBACK");
  client.release();
  await db.end();
}
