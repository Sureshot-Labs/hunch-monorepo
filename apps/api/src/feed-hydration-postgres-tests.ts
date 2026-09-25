#!/usr/bin/env tsx
// @integration
import assert from "node:assert/strict";
import type { Pool as InfraPool } from "@hunch/infra";
import type { FeedInputs, FeedMarketRow } from "./repos/unified-read.js";
import {
  createIntegrationTestPool,
  integrationDatabaseTargetFromEnv,
} from "./test-database-target.js";

// The shared runner supplies an explicit URL and expected database. Do not
// import API env/db before this guard, or infer a target from repository .env.
// This executable test owns only its newly created schema in the verified DB.
const target = integrationDatabaseTargetFromEnv();
const expectedDatabase = target.expectedDatabase;
const targetUrl = new URL(target.databaseUrl);
assert.ok(["localhost", "127.0.0.1"].includes(targetUrl.hostname));
assert.equal(targetUrl.search, "", "Do not supply connection-option overrides");

const database = await createIntegrationTestPool({ max: 1 });
const client = await database.connect();
const schemaName = `feed_hydration_fixture_${process.pid}_${Date.now()}`;
assert.match(schemaName, /^feed_hydration_fixture_[0-9]+_[0-9]+$/);
let schemaCreated = false;
const fixtureQuery = (sql: string, params: unknown[] = []) =>
  client.query(sql, params);
const fixturePool = {
  query: fixtureQuery,
  connect: async () => ({ query: fixtureQuery, release() {} }),
} as unknown as InfraPool;
const baseInputs: FeedInputs = {
  limit: 100,
  offset: 0,
  minVol: 0,
  minLiquidity: 0,
  view: "events",
  sort: "trending_v2",
  sortDir: "desc",
  nowParam: "2026-09-25T12:00:00Z",
  sevenDaysAgo: "2026-09-18T12:00:00Z",
  sevenDaysFromNow: "2026-10-02T12:00:00Z",
};
const selectedEvents = [
  "event-books",
  "event-large",
  "event-ties",
  "event-limitless",
  "event-search",
];
let equivalenceCases = 0;

function marketRow(rows: FeedMarketRow[], marketId: string): FeedMarketRow {
  const found = rows.find((row) => row.market_uuid === marketId);
  assert.ok(found, `Missing hydrated market ${marketId}`);
  return found;
}

function assertApprox(actual: unknown, expected: number): void {
  assert.ok(actual != null);
  assert.ok(
    Math.abs(Number(actual) - expected) < 1e-12,
    `${actual} != ${expected}`,
  );
}

try {
  const identity = (
    await client.query<{ database_name: string; major_version: number }>(`
      select current_database() as database_name,
        current_setting('server_version_num')::integer / 10000 as major_version
    `)
  ).rows[0];
  assert.equal(identity.database_name, expectedDatabase);
  assert.equal(identity.major_version, 16);
  await client.query("set statement_timeout = '15s'");
  await client.query("set lock_timeout = '2s'");
  await client.query(`create schema ${schemaName}`);
  schemaCreated = true;
  // No public fallback: an omitted fixture relation must fail, never read a
  // real table. pg_catalog remains implicitly available for built-in functions.
  await client.query(`set search_path to ${schemaName}`);
  await client.query(`
    create table unified_events (
      id text primary key, title text, duration_minutes integer default 60,
      category text default 'politics', start_date timestamptz default '2026-09-24T12:00:00Z',
      end_date timestamptz default '2026-10-01T12:00:00Z', liquidity numeric,
      volume_total numeric, volume_24h numeric default 7, open_interest numeric,
      slug text, image text, icon text, metadata jsonb default '{}'
    );
    create table unified_markets (
      id text primary key, event_id text references unified_events(id),
      venue text default 'polymarket', venue_market_id text, title text,
      market_type text default 'binary', duration_minutes integer default 60,
      status text default 'ACTIVE', open_time timestamptz default '2026-09-24T12:00:00Z',
      close_time timestamptz default '2026-10-01T12:00:00Z',
      expiration_time timestamptz default '2026-10-01T12:00:00Z',
      volume_24h numeric default 3, volume_total numeric default 100,
      open_interest numeric default 0, liquidity numeric default 50,
      best_bid numeric default 0.2, best_ask numeric default 0.4,
      last_price numeric default 0.3, resolved_outcome text, resolved_outcome_pct numeric,
      outcomes text default '["Yes","No"]', clob_token_ids text, condition_id text,
      slug text, category text, image text, icon text, metadata jsonb default '{}',
      updated_at timestamptz default '2026-09-25T11:59:00Z',
      created_at timestamptz default '2026-09-24T12:00:00Z', token_yes text, token_no text
    );
    create index fixture_market_event_idx on unified_markets(event_id);
    create table polymarket_markets (
      id text primary key, accepting_orders boolean default true,
      active boolean default true, closed boolean default false, archived boolean default false
    );
    create table unified_market_tokens (
      market_id text, token_id text, outcome_side text,
      updated_at timestamptz default '2026-09-23T12:00:00Z',
      primary key (market_id, token_id)
    );
    create table unified_token_top_latest (
      token_id text primary key, ts timestamptz default '2026-09-25T11:59:00Z',
      best_bid numeric, best_ask numeric
    );
    create table unified_token_change_24h (token_id text primary key, avg_mid_24h numeric);
    create table unified_market_change_24h (
      market_id text primary key, change_24h numeric, calculation_version integer
    );

    insert into unified_events(id, title, liquidity, volume_total, open_interest)
    values
      ('event-large', 'Large fixture', 9e16, null, 0),
      ('event-ties', 'Tie fixture', null, null, null),
      ('event-books', 'Books fixture', 0, 999, 300),
      ('event-limitless', 'AMM fixture', null, null, null),
      ('event-search', 'Search fixture', null, null, null);
    insert into unified_markets(id, event_id, venue_market_id, title, volume_total, liquidity)
    select 'large-' || lpad(series_num::text, 3, '0'), 'event-large',
      'large-' || lpad(series_num::text, 3, '0'), 'Large child ' || series_num,
      1000 - series_num, 2
    from generate_series(1, 105) as fixture_series(series_num);
    insert into unified_markets(id, event_id, venue_market_id, title, volume_total, liquidity, open_interest)
    values
      ('tie-c', 'event-ties', 'tie-c', 'Tie C', 100, 10, 0),
      ('tie-b', 'event-ties', 'tie-b', 'Tie B', 100, 0, 20),
      ('tie-a', 'event-ties', 'tie-a', 'Tie A', 100, 20, 0);
    insert into unified_markets(id, event_id, venue_market_id, title, duration_minutes)
    select fixture_book.market_id, 'event-books', fixture_book.market_id,
      fixture_book.market_id, 120
    from unnest(array[
      'book-canonical', 'book-shared', 'book-no-map', 'book-missing-top',
      'book-crossed', 'book-inconsistent', 'book-no-only', 'book-old-top',
      'book-historical-null', 'book-historical-zero', 'book-historical-inconsistent',
      'book-cached-null', 'book-cached-old-version', 'book-cache-missing'
    ]) as fixture_book(market_id);
    insert into unified_markets(id, event_id, venue_market_id, title, venue, metadata, updated_at)
    values
      ('amm-stale', 'event-limitless', 'amm-stale', 'Stale AMM', 'limitless',
        '{"tradeType":"amm"}', '2026-09-25T11:44:00Z'),
      ('amm-fresh', 'event-limitless', 'amm-fresh', 'Fresh AMM', 'limitless',
        '{"tradeType":"amm"}', '2026-09-25T11:59:00Z'),
      ('amm-stale-observed', 'event-limitless', 'amm-stale-observed', 'Observed AMM', 'limitless',
        '{"tradeType":"amm"}', '2026-09-25T11:44:00Z'),
      ('clob-stale', 'event-limitless', 'clob-stale', 'Stale CLOB', 'limitless',
        '{"tradeType":"clob"}', '2026-09-25T11:44:00Z');
    insert into unified_markets(id, event_id, venue_market_id, title, volume_total)
    values
      ('search-exact', 'event-search', 'search-exact', 'Hydration exact needle', 1),
      ('search-strict', 'event-search', 'search-strict', 'Hydration exact needle extra', 100),
      ('search-unrelated', 'event-search', 'search-unrelated', 'Unrelated leaf', 1000),
      ('excluded-closed', 'event-books', 'excluded-closed', 'Closed', 999999),
      ('excluded-pm', 'event-books', 'excluded-pm', 'Rejected', 999999),
      ('excluded-empty', 'event-books', 'excluded-empty', 'Empty', 0),
      ('excluded-kalshi', 'event-books', 'excluded-kalshi', 'Native unavailable', 999999);
    update unified_markets set status = 'CLOSED' where id = 'excluded-closed';
    update unified_markets set venue = 'kalshi' where id = 'excluded-kalshi';
    update unified_markets set volume_24h = 0, liquidity = 0, open_interest = 0,
      best_bid = null, best_ask = null, last_price = null where id = 'excluded-empty';
    insert into polymarket_markets(id, accepting_orders)
    select venue_market_id, id <> 'excluded-pm' from unified_markets where venue = 'polymarket';

    insert into unified_market_tokens(market_id, token_id, outcome_side)
    select fixture_market.id, fixture_market.id || ':' || fixture_side.side_label,
      upper(fixture_side.side_label)
    from unified_markets fixture_market
    cross join (values ('yes'), ('no')) as fixture_side(side_label);
    delete from unified_market_tokens where market_id = 'book-no-map';
    -- Denormalized fields must not override the explicit canonical mapping.
    update unified_markets set token_yes = 'ignored-yes', token_no = 'ignored-no',
      clob_token_ids = '["ignored-yes","ignored-no"]' where id = 'book-no-map';
    insert into unified_market_tokens(market_id, token_id, outcome_side, updated_at)
    values
      ('book-canonical', 'canonical-z', 'YES', '2026-09-24T12:00:00Z'),
      ('book-canonical', 'canonical-a', 'YES', '2026-09-24T12:00:00Z'),
      ('book-canonical', 'canonical-0-null-date', 'YES', null);
    -- Exercise duplicate tokens across selected rows: token_set deduplication
    -- must not alter cardinality when replaced by token-keyed direct joins.
    update unified_market_tokens set token_id = 'canonical-a'
    where market_id = 'book-shared' and outcome_side = 'YES';
    insert into unified_token_top_latest(token_id, best_bid, best_ask)
    select distinct token_id,
      case when outcome_side = 'YES' then 0.59 else 0.39 end,
      case when outcome_side = 'YES' then 0.61 else 0.41 end
    from unified_market_tokens;
    insert into unified_token_change_24h(token_id, avg_mid_24h)
    select distinct token_id, 0.5 from unified_market_tokens;
    update unified_token_top_latest set best_bid = 0.69, best_ask = 0.71
    where token_id = 'canonical-a';
    update unified_token_top_latest set best_bid = 0.29, best_ask = 0.31
    where token_id in ('book-canonical:no', 'book-shared:no', 'book-no-only:no');
    delete from unified_token_top_latest
    where token_id in ('book-missing-top:yes', 'book-missing-top:no', 'book-no-only:yes',
      'amm-stale:yes', 'amm-stale:no', 'amm-fresh:yes', 'amm-fresh:no', 'clob-stale:yes', 'clob-stale:no');
    update unified_token_top_latest set best_bid = 0.8, best_ask = 0.2
    where token_id = 'book-crossed:yes';
    update unified_token_top_latest set best_bid = 0.19, best_ask = 0.21
    where token_id = 'book-inconsistent:no';
    update unified_token_top_latest set ts = '2000-01-01T00:00:00Z'
    where token_id in ('book-old-top:yes', 'book-old-top:no');
    update unified_token_change_24h set avg_mid_24h = null
    where token_id in ('book-historical-null:yes', 'book-historical-null:no');
    update unified_token_change_24h set avg_mid_24h = 0
    where token_id = 'book-historical-zero:yes';
    update unified_token_change_24h set avg_mid_24h = 1
    where token_id = 'book-historical-zero:no';
    update unified_token_change_24h set avg_mid_24h = 0.2
    where token_id = 'book-historical-inconsistent:no';
    insert into unified_market_change_24h(market_id, change_24h, calculation_version)
    select id, 1.25, 2 from unified_markets where id <> 'book-cache-missing';
    update unified_market_change_24h set change_24h = null where market_id = 'book-cached-null';
    update unified_market_change_24h set calculation_version = 1 where market_id = 'book-cached-old-version';
    analyze unified_events;
    analyze unified_markets;
    analyze polymarket_markets;
    analyze unified_market_tokens;
    analyze unified_token_top_latest;
    analyze unified_token_change_24h;
  `);

  // Dynamic import occurs only after verifying the explicit target. The repo
  // helper receives the fixture pool; runtime db.ts/app.ts are never imported.
  const { fetchFeedMarkets } = await import("./repos/unified-read.js");
  async function assertEquivalent(
    label: string,
    input: FeedInputs,
    eventIds: string[],
    useCachedChange24h = false,
  ): Promise<FeedMarketRow[]> {
    const legacy = await fetchFeedMarkets(fixturePool, input, eventIds, {
      directTokenLookup: false,
      useCachedChange24h,
    });
    const defaultRows = await fetchFeedMarkets(fixturePool, input, eventIds, {
      useCachedChange24h,
    });
    const direct = await fetchFeedMarkets(fixturePool, input, eventIds, {
      directTokenLookup: true,
      useCachedChange24h,
    });
    assert.deepEqual(
      defaultRows,
      legacy,
      `${label}: default differs from legacy`,
    );
    assert.deepEqual(
      direct,
      legacy,
      `${label}: explicit direct differs from legacy`,
    );
    assert.equal(
      new Set(direct.map((row) => row.market_uuid)).size,
      direct.length,
      `${label}: duplicate hydrated markets`,
    );
    equivalenceCases += 1;
    return defaultRows;
  }

  const baseline = await assertEquivalent(
    "trending full selected page",
    baseInputs,
    selectedEvents,
  );
  assert.deepEqual(
    [...new Set(baseline.map((row) => row.event_id))],
    selectedEvents,
  );
  const largeRows = baseline.filter((row) => row.event_id === "event-large");
  assert.equal(largeRows.length, 100);
  assert.deepEqual(
    largeRows.map((row) => row.market_uuid),
    Array.from(
      { length: 100 },
      (_, index) => `large-${String(index + 1).padStart(3, "0")}`,
    ),
  );
  assertApprox(largeRows[0].event_volume_display, 94950);
  assertApprox(largeRows[0].event_liquidity_display, 200);
  assert.equal(largeRows[0].event_liquidity, null);
  const ties = baseline.filter((row) => row.event_id === "event-ties");
  assert.deepEqual(
    ties.map((row) => row.market_uuid),
    ["tie-a", "tie-b", "tie-c"],
  );
  assertApprox(ties[0].event_volume_display, 300);
  assertApprox(ties[0].event_liquidity_display, 50);
  assertApprox(marketRow(baseline, "book-canonical").event_volume_display, 999);
  assertApprox(
    marketRow(baseline, "book-canonical").event_liquidity_display,
    300,
  );
  assert.equal(marketRow(baseline, "book-canonical").token_yes, "canonical-a");
  assert.equal(marketRow(baseline, "book-shared").token_yes, "canonical-a");
  assert.equal(marketRow(baseline, "book-no-map").token_yes, null);
  assert.equal(marketRow(baseline, "book-no-map").token_no, null);
  assertApprox(marketRow(baseline, "book-canonical").change_24h, 0.4);
  assertApprox(marketRow(baseline, "book-shared").change_24h, 0.4);
  assertApprox(marketRow(baseline, "book-no-only").change_24h, 0.4);
  assertApprox(marketRow(baseline, "book-old-top").change_24h, 0.2);
  for (const marketId of [
    "book-no-map",
    "book-missing-top",
    "book-crossed",
    "book-inconsistent",
    "book-historical-null",
    "book-historical-zero",
    "book-historical-inconsistent",
  ]) {
    assert.equal(marketRow(baseline, marketId).change_24h, null, marketId);
  }
  assert.equal(
    baseline.some((row) => row.market_uuid.startsWith("excluded-")),
    false,
  );
  for (const field of ["best_bid", "best_ask", "last_price"] as const) {
    assert.equal(marketRow(baseline, "amm-stale")[field], null);
    for (const marketId of ["amm-fresh", "amm-stale-observed", "clob-stale"]) {
      assert.ok(
        marketRow(baseline, marketId)[field] != null,
        `${marketId}.${field}`,
      );
    }
  }

  for (const sortDir of ["asc", "desc"] as const) {
    for (const useCachedChange24h of [false, true]) {
      const rows = await assertEquivalent(
        `change24h ${sortDir} cached=${useCachedChange24h}`,
        { ...baseInputs, sort: "change24h", sortDir },
        selectedEvents,
        useCachedChange24h,
      );
      assert.deepEqual(
        rows.map((row) => row.market_uuid),
        baseline.map((row) => row.market_uuid),
      );
      if (useCachedChange24h) {
        assertApprox(marketRow(rows, "book-canonical").change_24h, 1.25);
        for (const marketId of [
          "book-cached-null",
          "book-cached-old-version",
          "book-cache-missing",
        ]) {
          assert.equal(marketRow(rows, marketId).change_24h, null);
        }
      }
    }
  }
  const cachedFlagIgnored = await assertEquivalent(
    "cache option only applies to change sort",
    baseInputs,
    selectedEvents,
    true,
  );
  assert.deepEqual(cachedFlagIgnored, baseline);

  for (const selectedPage of [
    selectedEvents.slice(2, 4),
    [...selectedEvents].reverse(),
    [],
    ["absent-event"],
  ]) {
    const rows = await assertEquivalent(
      `selected page ${selectedPage.join(",")}`,
      { ...baseInputs, limit: 2, offset: 100 },
      selectedPage,
    );
    const expected = selectedPage.flatMap((eventId) =>
      baseline.filter((row) => row.event_id === eventId),
    );
    assert.deepEqual(rows, expected);
  }
  const liquidRows = await assertEquivalent(
    "liquidity qualifier",
    { ...baseInputs, minLiquidity: 15 },
    selectedEvents,
  );
  assert.deepEqual(
    liquidRows
      .filter((row) => row.event_id === "event-ties")
      .map((row) => row.market_uuid),
    ["tie-a", "tie-b"],
  );
  assert.equal(
    liquidRows.some((row) => row.event_id === "event-large"),
    false,
  );
  const probabilityRows = await assertEquivalent(
    "observed probability qualifier",
    { ...baseInputs, minProb: 0.69, maxProb: 0.71 },
    ["event-books"],
  );
  assert.deepEqual(
    probabilityRows.map((row) => row.market_uuid),
    ["book-canonical", "book-no-only", "book-shared"],
  );
  const durationRows = await assertEquivalent(
    "duration qualifier",
    { ...baseInputs, durationMinutes: [120] },
    selectedEvents,
  );
  assert.ok(durationRows.length > 0);
  assert.ok(durationRows.every((row) => row.event_id === "event-books"));
  assert.deepEqual(
    await assertEquivalent(
      "spread empty tail",
      { ...baseInputs, maxSpread: 0.1 },
      selectedEvents,
    ),
    [],
  );
  const restrictedRows = await assertEquivalent(
    "selected markets",
    { ...baseInputs, marketIds: ["large-105", "tie-c"] },
    selectedEvents,
  );
  assert.deepEqual(
    restrictedRows.map((row) => row.market_uuid),
    ["large-105", "tie-c"],
  );
  const searchRows = await assertEquivalent(
    "exact direct search outranks strict matches",
    { ...baseInputs, q: "Hydration exact needle" },
    ["event-search"],
  );
  assert.deepEqual(
    searchRows.map((row) => row.market_uuid),
    ["search-exact"],
  );
  const noDirectSearch = await assertEquivalent(
    "event-only search retains siblings",
    { ...baseInputs, q: "unmatchedzzfixture" },
    ["event-search"],
  );
  assert.deepEqual(
    noDirectSearch.map((row) => row.market_uuid),
    ["search-unrelated", "search-strict", "search-exact"],
  );
  console.log(
    `ok - ${equivalenceCases} PostgreSQL 16 feed hydration equivalence cases`,
  );
} finally {
  try {
    await client.query("rollback");
    if (schemaCreated) {
      // Verify ownership and exact target again before the bounded cleanup.
      const cleanupIdentity = await client.query<{
        database_name: string;
        schema_exists: boolean;
      }>(
        "select current_database() as database_name, exists (select 1 from pg_namespace where nspname = $1) as schema_exists",
        [schemaName],
      );
      assert.equal(cleanupIdentity.rows[0].database_name, expectedDatabase);
      assert.equal(cleanupIdentity.rows[0].schema_exists, true);
      await client.query("set search_path to pg_catalog");
      await client.query(`drop schema ${schemaName} cascade`);
    }
  } finally {
    client.release();
    await database.end();
  }
}
