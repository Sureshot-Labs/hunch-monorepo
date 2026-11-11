#!/usr/bin/env tsx
// @integration
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
// Reference the former wide projection and second raw-market join, rather than
// comparing two executions that both use the optimized hydration SQL.
const legacyFixtureQuery = (sql: string, params: unknown[] = []) => {
  if (sql.includes("pm_filter.accepting_orders as pm_accepting_orders")) {
    sql = sql
      .replace(
        /m\.id, m\.event_id, m\.venue,[\s\S]*?pm_filter\.accepting_orders as pm_accepting_orders,/,
        "m.*,",
      )
      .replace(
        "m.pm_accepting_orders,",
        "pm.accepting_orders as pm_accepting_orders,",
      )
      .replace(
        "join market_base m on m.event_id = e.id",
        `join market_base m on m.event_id = e.id
        left join polymarket_markets pm on pm.id = m.venue_market_id and m.venue = 'polymarket'`,
      );
    assert.ok(sql.includes("pm.accepting_orders as pm_accepting_orders"));
    assert.ok(
      !sql.includes("pm_filter.accepting_orders as pm_accepting_orders"),
    );
  }
  return fixtureQuery(sql, params);
};
const legacyFixturePool = {
  query: legacyFixtureQuery,
  connect: async () => ({ query: legacyFixtureQuery, release() {} }),
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
      venue text default 'polymarket', status text default 'ACTIVE',
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
    create table unified_event_trade_24h (
      event_id text primary key, volume_24h numeric, updated_at timestamptz
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
      , 'book-current-zero', 'book-historical-no-only'
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
      ('book-canonical', 'canonical-0-null-date', 'YES', null),
      ('book-canonical', 'canonical-no-z', 'NO', '2026-09-24T12:00:00Z'),
      ('book-canonical', 'canonical-no-a', 'NO', '2026-09-24T12:00:00Z'),
      ('book-canonical', 'canonical-no-null-date', 'NO', null);
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
    where token_id in ('canonical-no-a', 'book-shared:no', 'book-no-only:no');
    update unified_token_top_latest set best_bid = 0, best_ask = 0 where token_id = 'book-current-zero:yes';
    update unified_token_top_latest set best_bid = 1, best_ask = 1 where token_id = 'book-current-zero:no';
    delete from unified_token_change_24h where token_id = 'book-historical-no-only:yes';
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
  const { fetchFeedMarkets, fetchFeedMarketsBatched, fetchFeedEventIds } =
    await import("./repos/unified-read.js");
  async function assertEquivalent(
    label: string,
    input: FeedInputs,
    eventIds: string[],
    useCachedChange24h = false,
  ): Promise<FeedMarketRow[]> {
    const legacy = await fetchFeedMarkets(legacyFixturePool, input, eventIds, {
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
    if (new Set(eventIds).size === eventIds.length) {
      assert.equal(
        new Set(direct.map((row) => row.market_uuid)).size,
        direct.length,
        `${label}: duplicate hydrated markets`,
      );
    }
    equivalenceCases += 1;
    return defaultRows;
  }

  const metadataCases = [
    { name: "sql-null", payload: null },
    { name: "json-null", payload: "null", eventPayload: "null" },
    {
      name: "array",
      payload: '[{"venueExchange":"not-an-object"}]',
      eventPayload: "[]",
    },
    { name: "string", payload: '"scalar"', eventPayload: '"scalar"' },
    { name: "number", payload: "7", eventPayload: "7" },
    { name: "boolean", payload: "true", eventPayload: "false" },
    { name: "empty-object", payload: "{}" },
    {
      name: "strings-and-case",
      payload: JSON.stringify({
        venueExchange: "market exchange",
        venueexchange: "wrong case",
        venueAdapter: "",
        address: 'Unicode \u2603 and \\"quotes\\"',
        tradeType: "amm",
      }),
    },
    {
      name: "typed-values",
      payload: JSON.stringify({
        venueExchange: [1, "x"],
        venueAdapter: false,
        address: { nested: [1, true] },
        tradeType: 17,
      }),
    },
    {
      name: "null-fields",
      payload: JSON.stringify({
        venueExchange: null,
        venueAdapter: null,
        address: null,
        tradeType: null,
      }),
    },
  ];
  const metadataEventIds = metadataCases.map(({ name }) => `metadata-${name}`);
  for (const [fixtureIndex, fixture] of metadataCases.entries()) {
    const fixtureId = metadataEventIds[fixtureIndex];
    await client.query(
      "insert into unified_events(id, title, metadata) values ($1, $1, $2::jsonb)",
      [
        fixtureId,
        fixture.eventPayload ??
          JSON.stringify({
            venueExchange: "event exchange",
            venueAdapter: "event adapter",
          }),
      ],
    );
    await client.query(
      `insert into unified_markets(id, event_id, venue_market_id, title, metadata)
        values ($1, $1, $1, $1, $2::jsonb)`,
      [fixtureId, fixture.payload],
    );
  }
  const largeMetadataFixtures = [
    {
      id: "metadata-large-compressed",
      padding: "compressible metadata fixture ".repeat(4000),
    },
    {
      id: "metadata-large-external",
      padding: Array.from({ length: 2048 }, (_, fixtureIndex) =>
        createHash("md5").update(String(fixtureIndex)).digest("hex"),
      ).join(""),
    },
  ];
  const largeMetadataEventIds = largeMetadataFixtures.map(({ id }) => id);
  for (const fixture of largeMetadataFixtures) {
    await client.query(
      "insert into unified_events(id, title, metadata) values ($1, $1, $2::jsonb)",
      [
        fixture.id,
        JSON.stringify({
          venueExchange: "large event exchange",
          venueAdapter: "large event adapter",
          padding: fixture.padding,
        }),
      ],
    );
    await client.query(
      `insert into unified_markets(id, event_id, venue_market_id, title, metadata)
        select $1 || ':' || fixture_no, $1, $1 || ':' || fixture_no,
          'Large metadata child', $2::jsonb
        from generate_series(1, 105) fixture_children(fixture_no)`,
      [
        fixture.id,
        JSON.stringify({
          address: "large market address",
          tradeType: "clob",
          padding: fixture.padding,
        }),
      ],
    );
  }
  await client.query(
    `insert into polymarket_markets(id) select venue_market_id
      from unified_markets where event_id = any($1::text[])`,
    [[...metadataEventIds, ...largeMetadataEventIds]],
  );
  const metadataStorage = await client.query<{
    event_id: string;
    logical_bytes: number;
    stored_bytes: number;
    compressed: boolean;
  }>(
    `select event_id, max(octet_length(metadata::text)) as logical_bytes,
      max(pg_column_size(metadata)) as stored_bytes,
      bool_and(pg_column_compression(metadata) is not null) as compressed
      from unified_markets where event_id = any($1::text[]) group by event_id`,
    [largeMetadataEventIds],
  );
  assert.ok(metadataStorage.rows.every((row) => row.logical_bytes > 32_000));
  assert.equal(
    metadataStorage.rows.find(
      (row) => row.event_id === "metadata-large-compressed",
    )?.compressed,
    true,
  );
  assert.ok(
    Number(
      metadataStorage.rows.find(
        (row) => row.event_id === "metadata-large-external",
      )?.stored_bytes,
    ) > 8192,
    "The external metadata fixture must exceed one heap page",
  );
  const toastStorage = await client.query<{ has_external_values: boolean }>(
    `select pg_relation_size(reltoastrelid) > 0 as has_external_values
      from pg_class where oid = 'unified_markets'::regclass`,
  );
  assert.equal(toastStorage.rows[0].has_external_values, true);
  const metadataRows = await assertEquivalent(
    "all metadata JSON types and event fallback",
    baseInputs,
    metadataEventIds,
  );
  for (const [fixtureIndex, fixture] of metadataCases.entries()) {
    const actual = marketRow(metadataRows, metadataEventIds[fixtureIndex]);
    assert.deepEqual(
      actual.market_metadata,
      fixture.payload === null ? null : JSON.parse(fixture.payload),
      "Public metadata must remain the original JSON value",
    );
  }
  for (const page of [
    largeMetadataEventIds,
    largeMetadataEventIds.slice(1),
    [],
  ]) {
    const rows = await assertEquivalent(
      "large compressed/external metadata selected and resumed page",
      { ...baseInputs, offset: 100 },
      page,
    );
    assert.equal(rows.length, page.length * 100);
    for (const row of rows) {
      const fixture = largeMetadataFixtures.find(
        ({ id }) => id === row.event_id,
      );
      assert.ok(fixture);
      assert.deepEqual(row.market_metadata, {
        address: "large market address",
        tradeType: "clob",
        padding: fixture.padding,
      });
      assert.equal(row.venue_exchange, "large event exchange");
      assert.equal(row.venue_adapter, "large event adapter");
    }
  }
  await client.query(
    "analyze unified_events; analyze unified_markets; analyze polymarket_markets",
  );

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
  assert.equal(
    marketRow(baseline, "book-canonical").token_no,
    "canonical-no-a",
  );
  assert.equal(marketRow(baseline, "book-shared").token_yes, "canonical-a");
  assert.equal(marketRow(baseline, "book-no-map").token_yes, null);
  assert.equal(marketRow(baseline, "book-no-map").token_no, null);
  assertApprox(marketRow(baseline, "book-canonical").change_24h, 0.4);
  assertApprox(marketRow(baseline, "book-shared").change_24h, 0.4);
  assertApprox(marketRow(baseline, "book-no-only").change_24h, 0.4);
  assertApprox(marketRow(baseline, "book-old-top").change_24h, 0.2);
  assertApprox(marketRow(baseline, "book-current-zero").change_24h, -1);
  assertApprox(marketRow(baseline, "book-historical-no-only").change_24h, 0.2);
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
    ["event-books", "event-books", "event-ties"],
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

  // The first 100 ranked events have no orderable child. A smaller prefix must
  // expand, not silently become an empty/partial feed page.
  await client.query(`
    insert into unified_events(id,title,category,volume_total,liquidity)
      select 'prefix-' || lpad(child_no::text,3,'0'),'Prefix fixture','prefix-fixture',floor(child_no/2.0)+1,10
      from generate_series(0,209) children(child_no);
    insert into unified_markets(id,event_id,venue_market_id,title)
      select id || ':market',id,id || ':raw','Orderable fixture' from unified_events
      where category='prefix-fixture' and id<'prefix-100';
    insert into polymarket_markets(id) select venue_market_id from unified_markets where id like 'prefix-%';
    insert into unified_event_trade_24h(event_id,volume_24h,updated_at)
      select id,volume_total,'2026-09-25T11:00:00Z' from unified_events where category='prefix-fixture';
  `);
  const prefixCases: Array<[string, Partial<FeedInputs>]> = [
    ["sparse first", {}],
    ["resumed", { offset: 50 }],
    ["empty tail", { offset: 100 }],
    ["ascending ties", { sortDir: "asc" }],
    ["empty filter", { venues: [] }],
  ];
  for (const sort of ["trending", "trending_v2"] as const) {
    for (const [label, extra] of prefixCases) {
      // Ascending metric sort uses the existing exact fallback, outside this
      // optimization; tested separately by the pre-existing feed SQL suites.
      if (sort === "trending_v2" && "sortDir" in extra) continue;
      const input: FeedInputs = {
        ...baseInputs,
        limit: 25,
        sort,
        category: "prefix-fixture",
        ...extra,
      };
      const bounds: number[] = [];
      const prefixQuery =
        (legacy: boolean) =>
        async (sql: string, params: unknown[] = []) => {
          const boundMatch = sql.match(
            /ranked_event_candidates as materialized\s*\([\s\S]*?limit \$(\d+)/,
          );
          if (!boundMatch) return fixtureQuery(sql, params);
          const boundIndex = Number(boundMatch[1]) - 1;
          const values = [...params];
          assert.equal(typeof values[boundIndex], "number");
          if (legacy)
            values[boundIndex] = Math.max(
              1000,
              (input.limit + input.offset) * 20,
            );
          else bounds.push(Number(values[boundIndex]));
          return fixtureQuery(sql, values);
        };
      const prefixPool = (legacy: boolean) => {
        const query = prefixQuery(legacy);
        return {
          query,
          connect: async () => ({ query, release() {} }),
        } as unknown as InfraPool;
      };
      const legacy = await fetchFeedEventIds(prefixPool(true), input);
      const actual = await fetchFeedEventIds(prefixPool(false), input);
      assert.deepEqual(
        actual,
        legacy,
        `${sort} ${label}: prefix changed the ordered page`,
      );
      if (label === "sparse first") {
        assert.deepEqual(bounds, [100, 400]);
        assert.equal(actual.length, 25);
      }
      if (label.startsWith("empty")) assert.deepEqual(actual, []);
    }
  }
  console.log(
    "ok - PostgreSQL 16 event prefixes preserve sparse, resumed, empty and tied pages",
  );

  // A full event page plus unrelated catalog rows checks the parameterized
  // access paths, not just correctness on a tiny table that fits a seq scan.
  await client.query(`
    insert into unified_events(id, title) select 'batch-event-' || fixture_no, 'Batch event'
      from generate_series(1, 100) fixture_series(fixture_no);
    insert into unified_events(id, title) values ('unselected-event', 'Unselected');
    insert into unified_markets(id, event_id, venue_market_id, title)
      select 'batch-market-' || fixture_no, 'batch-event-' || (1 + (fixture_no - 1) / 10),
        'batch-market-' || fixture_no, 'Selected market'
      from generate_series(1, 1000) fixture_series(fixture_no);
    insert into unified_markets(id, event_id, venue_market_id, title)
      select 'unselected-' || fixture_no, 'unselected-event', 'unselected-' || fixture_no, 'Unselected market'
      from generate_series(1, 60000) fixture_series(fixture_no);
    insert into polymarket_markets(id) select venue_market_id from unified_markets
      where id like 'batch-market-%' or id like 'unselected-%';
    insert into unified_market_tokens(market_id, token_id, outcome_side)
      select fixture_market.id, fixture_market.id || ':' || fixture_side.side_label, fixture_side.side_label
      from unified_markets fixture_market cross join (values ('YES'), ('NO')) fixture_side(side_label)
      where fixture_market.id like 'batch-market-%' or fixture_market.id like 'unselected-%';
    insert into unified_token_top_latest(token_id, best_bid, best_ask)
      select token_id, 0.5, 0.5 from unified_market_tokens
      where market_id like 'batch-market-%' or market_id like 'unselected-%';
    insert into unified_token_change_24h(token_id, avg_mid_24h)
      select token_id, 0.5 from unified_market_tokens
      where market_id like 'batch-market-%' or market_id like 'unselected-%';
    analyze unified_events; analyze unified_markets; analyze polymarket_markets;
    analyze unified_market_tokens; analyze unified_token_top_latest; analyze unified_token_change_24h;
  `);
  const batchEvents = Array.from(
    { length: 100 },
    (_, index) => `batch-event-${index + 1}`,
  );
  const smallPlanPages = [
    batchEvents,
    batchEvents.slice(0, 20),
    batchEvents.slice(20, 40),
    ["absent-event", "batch-event-100"],
    [],
  ];
  const fanoutPage = ["unselected-event", ...batchEvents.slice(0, 99)];
  const planCases = [
    ...smallPlanPages.map((eventIds) => ({
      eventIds,
      input: baseInputs,
      expectedRows: eventIds.filter((id) => id !== "absent-event").length * 10,
      eligibleChildren:
        eventIds.filter((id) => id !== "absent-event").length * 10,
    })),
    {
      eventIds: [...batchEvents.slice(0, 98), ...largeMetadataEventIds],
      input: baseInputs,
      expectedRows: 1180,
      eligibleChildren: 1190,
    },
    {
      eventIds: batchEvents,
      input: { ...baseInputs, minLiquidity: 1000 },
      expectedRows: 0,
      eligibleChildren: 1000,
    },
    {
      eventIds: ["unselected-event"],
      input: baseInputs,
      expectedRows: 100,
      eligibleChildren: 60000,
    },
    {
      eventIds: fanoutPage,
      input: baseInputs,
      expectedRows: 1090,
      eligibleChildren: 60990,
    },
    {
      eventIds: fanoutPage,
      input: { ...baseInputs, q: "Unselected market" },
      expectedRows: 1090,
      eligibleChildren: 60990,
    },
  ];
  const sqlLiteral = (value: unknown): string => {
    if (value === null) return "null";
    if (Array.isArray(value))
      return `array[${value.map(sqlLiteral).join(",")}]::text[]`;
    if (typeof value === "number") return String(value);
    assert.equal(typeof value, "string");
    return `'${String(value).replaceAll("'", "''")}'`;
  };
  await client.query("set work_mem = '32MB'");
  await client.query("set jit = off");
  for (const { eventIds, input, expectedRows, eligibleChildren } of planCases) {
    await assertEquivalent("bounded catalog page", input, eventIds);
    for (const mode of ["force_custom_plan", "force_generic_plan"]) {
      await client.query(`set plan_cache_mode = '${mode}'`);
      const expected = await fetchFeedMarkets(fixturePool, input, eventIds);
      const actualStatements: Array<{ sql: string; params: unknown[] }> = [];
      const traceQuery = async (sql: string, params: unknown[] = []) => {
        if (sql.trim().startsWith("with "))
          actualStatements.push({ sql, params });
        return fixtureQuery(sql, params);
      };
      const tracedPool = {
        query: traceQuery,
        connect: async () => ({ query: traceQuery, release() {} }),
      } as unknown as InfraPool;
      const batched = await fetchFeedMarketsBatched(
        tracedPool,
        input,
        eventIds,
      );
      assert.deepEqual(
        batched,
        expected,
        `Complete ordered batch equivalence: ${mode}, ${eventIds.length} events`,
      );
      if (eventIds.length > 20) {
        assert.ok(actualStatements.length > 1);
        let totalRows = 0,
          totalBuffers = 0,
          totalMs = 0;
        for (const statement of actualStatements) {
          assert.ok((statement.params[0] as string[]).length <= 20);
          await client.query(
            `prepare fixture_feed_actual_batch as ${statement.sql}`,
          );
          try {
            const executed = await client.query(
              `explain(analyze,buffers,format json) execute fixture_feed_actual_batch(${statement.params.map(sqlLiteral).join(",")})`,
            );
            const result = executed.rows[0]["QUERY PLAN"][0];
            totalRows += result.Plan["Actual Rows"];
            totalBuffers +=
              result.Plan["Shared Hit Blocks"] +
              result.Plan["Shared Read Blocks"];
            totalMs += result["Execution Time"];
          } finally {
            await client.query("deallocate fixture_feed_actual_batch");
          }
        }
        assert.equal(totalRows, expected.length);
        console.log(
          JSON.stringify({
            actualHydrationBatches: actualStatements.length,
            mode,
            rows: totalRows,
            bufferBlocks: totalBuffers,
            executionMs: Math.round(totalMs * 1000) / 1000,
          }),
        );
      }
    }
    // Capture the exact application SQL, including the real cap/filter binds.
    // Empty HTTP pages deliberately short-circuit; parse an empty SQL execution
    // too by binding an empty array to the nonempty captured statement.
    let capturedSql = "";
    let capturedParams: unknown[] = [];
    const captureQuery = async (sql: string, params: unknown[] = []) => {
      if (sql.trim().startsWith("with ")) {
        capturedSql = sql;
        capturedParams = params;
      }
      return { rows: [] };
    };
    await fetchFeedMarkets(
      {
        connect: async () => ({ query: captureQuery, release() {} }),
      } as unknown as InfraPool,
      input,
      eventIds.length ? eventIds : ["absent-event"],
    );
    capturedParams[0] = eventIds;
    for (const planMode of ["force_custom_plan", "force_generic_plan"]) {
      await client.query(`set plan_cache_mode = '${planMode}'`);
      await client.query(
        `prepare fixture_feed_hydration_plan as ${capturedSql}`,
      );
      try {
        const explained = await client.query(
          `explain (analyze, buffers, verbose, format json) execute fixture_feed_hydration_plan(${capturedParams.map(sqlLiteral).join(",")})`,
        );
        const plan = explained.rows[0]["QUERY PLAN"][0].Plan;
        assert.equal(plan["Actual Rows"], expectedRows);
        let marketRowsRead = 0;
        let mappingLoops = 0;
        let metadataExtractionLoops = 0;
        let searchMatchRows = 0;
        const inspect = (
          node: Record<string, unknown>,
          insideMarketBase = false,
        ) => {
          const isMarketBase =
            insideMarketBase || node["Subplan Name"] === "CTE market_base";
          if (node["Relation Name"] === "unified_markets" && isMarketBase)
            marketRowsRead +=
              (Number(node["Actual Rows"]) +
                Number(node["Rows Removed by Filter"] ?? 0) +
                Number(node["Rows Removed by Index Recheck"] ?? 0)) *
              Number(node["Actual Loops"]);
          if (node["Relation Name"] === "unified_market_tokens")
            mappingLoops += Number(node["Actual Loops"]);
          if (node["Function Name"] === "jsonb_to_record") {
            metadataExtractionLoops += Number(node["Actual Loops"]);
            assert.equal(
              Number(node["Shared Hit Blocks"]) +
                Number(node["Shared Read Blocks"]),
              0,
              "Metadata extraction must consume the already expanded JSON, not reread TOAST",
            );
          }
          if (node["Subplan Name"] === "CTE market_base")
            assert.doesNotMatch(
              JSON.stringify(node.Output),
              /expanded_metadata/,
              "The materialized market rows must not store expanded metadata",
            );
          // Search classification has several independent, bounded consumers.
          // Here guard the ranking join specifically against one complete
          // matches scan per selected event, not those separate consumers.
          if (node["CTE Name"] === "direct_market_matches" && isMarketBase)
            searchMatchRows +=
              (Number(node["Actual Rows"]) +
                Number(node["Rows Removed by Filter"] ?? 0)) *
              Number(node["Actual Loops"]);
          if (node["Node Type"] === "Seq Scan") {
            // The common-term search intentionally matches nearly the whole
            // fixture. Its separate search CTE may correctly scan that scope
            // once; it must not become a per-event catalog scan.
            const isSearchScan =
              input.q &&
              !isMarketBase &&
              node["Relation Name"] === "unified_markets";
            if (isSearchScan && !node["Parallel Aware"])
              assert.ok(
                Number(node["Actual Loops"]) <= 1,
                `Repeated search scan: ${JSON.stringify({ loops: node["Actual Loops"], rows: node["Actual Rows"], alias: node.Alias })}`,
              );
            assert.ok(
              isSearchScan ||
                ![
                  "unified_markets",
                  "unified_market_tokens",
                  "unified_token_change_24h",
                ].includes(String(node["Relation Name"])),
              `${planMode}: unexpected catalog-wide scan of ${node["Relation Name"]}`,
            );
          }
          for (const child of (node.Plans ?? []) as Record<string, unknown>[])
            inspect(child, isMarketBase);
        };
        inspect(plan);
        if (expectedRows > 0)
          assert.ok(
            marketRowsRead > 0,
            "Expected parameterized market scan was not inspected",
          );
        assert.ok(
          marketRowsRead <= eligibleChildren + eventIds.length,
          `${planMode}: repeated market scans ${marketRowsRead} > ${eligibleChildren}`,
        );
        assert.ok(
          mappingLoops <= expectedRows,
          `${planMode}: mappings resolved before fanout cap: ${mappingLoops} > ${expectedRows}`,
        );
        assert.ok(
          metadataExtractionLoops <= expectedRows,
          `${planMode}: metadata extracted before the per-event cap: ${metadataExtractionLoops} > ${expectedRows}`,
        );
        if (expectedRows > 0) assert.ok(metadataExtractionLoops > 0);
        if (input.q)
          assert.ok(
            searchMatchRows <= eligibleChildren,
            `${planMode}: repeated full search CTE scans inside market_base: ${searchMatchRows} > ${eligibleChildren}`,
          );
        if (eligibleChildren >= 60000)
          console.log(
            JSON.stringify({
              case: input.q ? "selected fanout search" : "selected fanout",
              planMode,
              rows: plan["Actual Rows"],
              marketRowsRead,
              mappingLoops,
              searchMatchRows,
              hitBlocks: plan["Shared Hit Blocks"],
              readBlocks: plan["Shared Read Blocks"],
            }),
          );
      } finally {
        await client.query("deallocate fixture_feed_hydration_plan");
      }
    }
  }
  console.log(
    `ok - ${equivalenceCases} PostgreSQL 16 hydration equivalence cases; ${planCases.length * 2} custom/generic full, resumed, sparse, empty and selected-fanout plans use bounded lookups`,
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
