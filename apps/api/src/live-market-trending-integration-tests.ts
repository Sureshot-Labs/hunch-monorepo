// @api-integration
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Pool } from "@hunch/infra";
import { createIntegrationTestPool } from "./test-database-target.js";
import {
  fetchFeedMarketIdsForProbabilityProbe,
  type FeedInputs,
} from "./repos/unified-read.js";
import {
  buildPolymarketGraceMarketSql,
  buildStrictIndexedMarketSql,
} from "./lib/market-availability.js";
import { buildRenderableMarketSql } from "./lib/market-renderability.js";

const schema = `live_trending_test_${randomUUID().replaceAll("-", "")}`;
const db = await createIntegrationTestPool({
  max: 2,
  options: `-c search_path=${schema} -c statement_timeout=30000`,
});
const client = await db.connect();
let schemaCreated = false;
const captured: Array<{ sql: string; params: unknown[] }> = [];
const pool = {
  connect: async () => {
    const connection = await db.connect();
    return {
      release: () => connection.release(),
      query: async (sql: string, params: unknown[] = []) => {
        if (/^\s*(with|select)/i.test(sql))
          captured.push({ sql, params: [...params] });
        return connection.query(sql, params);
      },
    };
  },
} as unknown as Pool;
const now = new Date("2026-09-12T12:00:00Z");
const base: FeedInputs = {
  limit: 10,
  offset: 0,
  minVol: 0,
  minLiquidity: 0,
  view: "markets",
  sort: "trending",
  sortDir: "desc",
  venues: ["limitless"],
  nowParam: now.toISOString(),
  sevenDaysAgo: "2026-09-05T12:00:00Z",
  sevenDaysFromNow: "2026-09-19T12:00:00Z",
  endWithin: "2026-09-13T12:00:00Z",
};

try {
  await client.query(`create schema ${schema}`);
  schemaCreated = true;
  await client.query(`
    create table unified_events (id text primary key, venue text, status text,
      start_date timestamptz, end_date timestamptz, category text);
    create table unified_markets (id text primary key, event_id text,
      venue text, venue_market_id text, status text, duration_minutes integer,
      volume_total numeric, volume_24h numeric, liquidity numeric, open_interest numeric,
      best_bid numeric, best_ask numeric, last_price numeric,
      close_time timestamptz, expiration_time timestamptz, metadata jsonb);
    create index fixture_market_event on unified_markets(event_id);
    create table polymarket_markets (id text primary key, accepting_orders boolean,
      active boolean, closed boolean, archived boolean);
    insert into unified_events values
      ('old', 'limitless', 'ACTIVE', '2026-08-01', '2026-09-13', 'test'),
      ('new', 'limitless', 'ACTIVE', '2026-09-11', '2026-09-13', 'test'),
      ('excluded', 'limitless', 'ACTIVE', '2026-08-01', '2026-10-01', 'test');
    insert into unified_markets
    select 'l-' || lpad(sample_row::text, 6, '0'),
      case when sample_row <= 1500 then 'excluded' when sample_row % 2 = 0 then 'new' else 'old' end,
      'limitless', lpad(sample_row::text, 6, '0'), 'ACTIVE', 60,
      (20001 - sample_row) * 100, 0,
      case when sample_row % 3=0 then 0 else sample_row % 101 end,
      sample_row % 53, 0.4, 0.6, null, '2026-09-14', '2026-09-14', '{}'
    from generate_series(1,20000) as generated(sample_row);
    insert into unified_markets
    select 'p-' || lpad(sample_row::text, 6, '0'),
      case when sample_row=1001 then 'new' else 'old' end,
      'polymarket', lpad(sample_row::text, 6, '0'), 'ACTIVE', 60,
      null, 0, null, 0, 0.4, 0.6, null, '2026-09-14', '2026-09-14', '{}'
    from generate_series(1,1001) as generated(sample_row);
    insert into unified_markets
      (id,event_id,venue,venue_market_id,status,volume_total,liquidity,
       close_time,expiration_time,metadata)
    values
      ('grace-valid','old','polymarket','grace-valid','ACTIVE',4000,-10000,
       '2026-09-12T11:00:00Z','2026-09-14','{}'),
      ('grace-rejected','old','polymarket','grace-rejected','ACTIVE',1000000,0,
       '2026-09-12T11:00:00Z','2026-09-14','{}'),
      ('grace-expired','old','polymarket','grace-expired','ACTIVE',1000000,0,
       '2026-09-12T05:00:00Z','2026-09-14','{}');
    insert into polymarket_markets values
      ('grace-valid',true,true,false,false),
      ('grace-rejected',false,true,false,false),
      ('grace-expired',true,true,false,false);
    insert into unified_markets
    select 'k-' || lpad(sample_row::text, 6, '0'),
      case when sample_row=1001 then 'new' else 'old' end,
      'kalshi', case when sample_row=1001 then '000000' else lpad(sample_row::text, 6, '0') end,
      'ACTIVE', 60, case when sample_row=1 then 1125 else 625 end,
      0, 0, 0, 0.4, 0.6, null, '2026-09-14', '2026-09-14',
      '{"dflowNativeAcceptingOrders":true}'
    from generate_series(1,1001) as generated(sample_row);
    analyze unified_events;
    analyze unified_markets;
  `);
  const migration = await readFile(
    new URL(
      "../../../packages/db/migrations/0258_live_market_trending_prefix_index.sql",
      import.meta.url,
    ),
    "utf8",
  );
  assert.ok(migration.includes("/* no-transaction */"));
  const migrationStatements = migration
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
  const originalTimeout = (await client.query("show statement_timeout")).rows[0]
    .statement_timeout;
  for (let replay = 0; replay < 2; replay++) {
    const blocker = await db.connect();
    try {
      await blocker.query("begin");
      await blocker.query(
        "update unified_markets set volume_total=volume_total where id='l-000001'",
      );
      await client.query("set statement_timeout='50ms'");
      if (replay === 0) {
        const createIndex = migrationStatements.find((statement) =>
          /^CREATE INDEX CONCURRENTLY/i.test(statement),
        );
        assert.ok(createIndex);
        await assert.rejects(client.query(createIndex), { code: "57014" });
        assert.equal(
          (
            await client.query(
              "select indisvalid from pg_index where indexrelid='idx_unified_markets_live_trending_prefix'::regclass",
            )
          ).rows[0].indisvalid,
          false,
          "reproduce the cancelled production build before testing repair",
        );
      }
      await Promise.all([
        (async () => {
          for (const statement of migrationStatements) {
            await client.query(statement);
          }
        })(),
        (async () => {
          await blocker.query("select pg_sleep(0.2)");
          await blocker.query("rollback");
        })(),
      ]);
      assert.equal(
        (await client.query("show statement_timeout")).rows[0]
          .statement_timeout,
        originalTimeout,
        "the migration must restore the connection default after its build",
      );
    } finally {
      await blocker.query("rollback");
      blocker.release();
    }
  }
  for (const variant of [
    {},
    { offset: 10 },
    { offset: 20 },
    { minVol: 100 },
    { minLiquidity: 50 },
    { ageSince: "2026-09-10T00:00:00Z" },
    { venues: ["polymarket"] },
    { venues: ["polymarket"], minVol: 3000 },
    { venues: ["kalshi"], limit: 1 },
    { venues: [] },
  ]) {
    const input = { ...base, ...variant };
    captured.length = 0;
    const page = await fetchFeedMarketIdsForProbabilityProbe(pool, input);
    // Independent full scan: no score prefix, pruning, cache, or early exit.
    const expected = await client.query(
      `select m.id
      from unified_markets m join unified_events e on e.id=m.event_id
      left join polymarket_markets pm on m.venue='polymarket' and pm.id=m.venue_market_id
      where (${buildStrictIndexedMarketSql({ marketAlias: "m", eventAlias: "e", nowParam: "$1" })}
        or ${buildPolymarketGraceMarketSql({ marketAlias: "m", eventAlias: "e", nowParam: "$1", pmAlias: "pm" })})
        and ${buildRenderableMarketSql({ alias: "m" })}
        and m.venue=any($2::text[]) and e.end_date>$1::timestamptz and e.end_date<=$3::timestamptz
        and ($4::timestamptz is null or e.start_date >= $4)
        and ($5::numeric <= 0 or coalesce(nullif(m.liquidity,0),nullif(m.open_interest,0)) >= $5)
        and ($6::numeric <= 1e-9 or m.volume_total >= $6)
      order by (
        case when m.volume_total>0 then m.volume_total else 0 end * 0.4
        + coalesce(nullif(m.liquidity,0),nullif(m.open_interest,0),0) * 0.3
        + case when e.start_date >= $7::timestamptz then 200 else 0 end
        + case when e.end_date>$1::timestamptz and e.end_date<=$8::timestamptz then 50 else 0 end
      ) desc nulls last, m.venue_market_id
      limit $9 offset $10`,
      [
        input.nowParam,
        input.venues,
        input.endWithin,
        input.ageSince ?? null,
        input.minLiquidity,
        input.minVol,
        input.sevenDaysAgo,
        input.sevenDaysFromNow,
        input.limit,
        input.offset,
      ],
    );
    assert.deepEqual(
      page.marketIds,
      expected.rows.map((r) => r.id),
      JSON.stringify(variant),
    );
    if (input.venues?.length)
      assert.ok(
        captured.length >= 2,
        "the first prefix must not hide later eligible or tied winners",
      );
    assert.ok(captured[0].params.includes(1000));
    if (input.venues?.length)
      assert.ok(
        captured
          .at(-1)
          ?.params.some((value) => typeof value === "number" && value >= 4000),
      );
    if (input.venues?.[0] === "polymarket")
      assert.equal(
        page.marketIds[0],
        input.minVol === 3000 ? "grace-valid" : "p-001001",
      );
    if (input.venues?.[0] === "kalshi")
      assert.equal(page.marketIds[0], "k-001001");
    const first = captured[0];
    const plan = await client.query(
      `explain (analyze,buffers,format json) ${first.sql}`,
      first.params,
    );
    if (input.venues?.length)
      assert.ok(
        JSON.stringify(plan.rows).includes(
          "idx_unified_markets_live_trending_prefix",
        ),
        "real generated SQL must use the expression index without planner hints",
      );
    console.log(
      `ok - live trending equals full exact scan: ${JSON.stringify(variant)}`,
    );
  }
} finally {
  await client.query("rollback");
  if (schemaCreated) await client.query(`drop schema ${schema} cascade`);
  client.release();
  await db.end();
}
