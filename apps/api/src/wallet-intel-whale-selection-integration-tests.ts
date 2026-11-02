// @requires-db
import assert from "node:assert/strict";
import { createIntegrationTestPool } from "./test-database-target.js";
import { WALLET_INTEL_WHALE_MARKETS_SQL } from "./services/wallet-intel-whale-selection.js";

assert.equal(
  process.env.HUNCH_TEST_EXPECT_DATABASE,
  "hunch_wallet_selection_test_20261102",
);
const pool = await createIntegrationTestPool({ max: 1 });
const client = await pool.connect();
const at = "2026-11-02T11:00:00Z";
try {
  assert.match(
    String((await client.query("select version()")).rows[0].version),
    /PostgreSQL 16/,
  );
  await client.query("BEGIN");
  await client.query(
    "SET LOCAL statement_timeout='15s'; SET LOCAL lock_timeout='2s'",
  );
  // Connection-local relations only. No persistent tables, migrations or jobs.
  await client.query(`
    CREATE TEMP TABLE wallet_tags(id int PRIMARY KEY, slug text UNIQUE);
    CREATE TEMP TABLE wallet_tag_map(wallet_id int, tag_id int, UNIQUE(wallet_id,tag_id));
    CREATE INDEX ON wallet_tag_map(tag_id,wallet_id);
    CREATE TEMP TABLE wallet_activity_hourly(wallet_id int, market_id text, activity_type text, hour_bucket timestamptz);
    CREATE INDEX ON wallet_activity_hourly(hour_bucket DESC,wallet_id,market_id) WHERE activity_type IN ('delta','trade');
    CREATE TEMP TABLE unified_events(id text PRIMARY KEY,status text,end_date timestamptz);
    CREATE TEMP TABLE unified_markets(id text PRIMARY KEY,venue text,volume_24h numeric,event_id text,status text,
      resolved_outcome text,close_time timestamptz,expiration_time timestamptz,is_initialized boolean);
    INSERT INTO wallet_tags VALUES (1,'whale'),(2,'followed');
    INSERT INTO wallet_tag_map VALUES (1,1),(2,1),(3,2);
    INSERT INTO unified_events VALUES ('active','ACTIVE','2026-11-03'),('closed','CLOSED',NULL),
      ('expired','ACTIVE','2026-11-02T11:00:00Z');
  `);
  type Market = {
    id: string;
    venue: string;
    volume: number | null;
    event: string | null;
    status: string;
    resolved: string | null;
    close: string | null;
    expiration: string | null;
    initialized: boolean;
  };
  const market = (id: string, extra: Partial<Market> = {}): Market => ({
    id,
    venue: "polymarket",
    volume: 100,
    event: "active",
    status: "ACTIVE",
    resolved: null,
    close: "2026-11-03",
    expiration: null,
    initialized: true,
    ...extra,
  });
  const markets = [
    market("recent"),
    market("duplicate", { volume: 200 }),
    market("boundary", { volume: 150 }),
    market("null-volume", { volume: null, event: null }),
    market("no-parent", { event: "missing" }),
    market("limitless", { venue: "limitless", volume: 300 }),
    market("kalshi", { venue: "kalshi", volume: 400 }),
    market("kalshi-uninitialized", {
      venue: "kalshi",
      volume: 500,
      initialized: false,
    }),
    market("closed", { status: "CLOSED" }),
    market("resolved", { resolved: "YES" }),
    market("close-boundary", { close: at }),
    market("expiration-boundary", { expiration: at }),
    market("parent-closed", { event: "closed" }),
    market("parent-expired", { event: "expired" }),
    market("old-only"),
    market("holder-only"),
    market("not-whale"),
    market("no-activity"),
    // Many high-volume ineligible rows must not consume the final LIMIT.
    ...Array.from({ length: 250 }, (_, i) =>
      market(`closed-${i}`, { status: "CLOSED", volume: 10000 }),
    ),
  ];
  for (const m of markets)
    await client.query(
      "INSERT INTO unified_markets VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [
        m.id,
        m.venue,
        m.volume,
        m.event,
        m.status,
        m.resolved,
        m.close,
        m.expiration,
        m.initialized,
      ],
    );
  for (const m of markets.filter((m) => m.id !== "no-activity")) {
    await client.query(
      "INSERT INTO wallet_activity_hourly VALUES($1,$2,$3,$4)",
      [
        m.id === "not-whale" ? 3 : 1,
        m.id,
        m.id === "holder-only" ? "holder" : "trade",
        m.id === "old-only"
          ? "2026-10-26T10:59:59Z"
          : m.id === "boundary"
            ? "2026-10-26T11:00:00Z"
            : at,
      ],
    );
  }
  await client.query(
    "INSERT INTO wallet_activity_hourly VALUES (1,'duplicate','delta',$1),(2,'duplicate','trade',$1),(1,'missing-market','trade',$1),(1,NULL,'trade',$1)",
    [at],
  );
  await client.query(
    "ANALYZE wallet_tags; ANALYZE wallet_tag_map; ANALYZE wallet_activity_hourly; ANALYZE unified_markets; ANALYZE unified_events",
  );
  const expected = [
    "limitless",
    "duplicate",
    "boundary",
    "no-parent",
    "recent",
    "null-volume",
  ];
  const select = async (venues = ["polymarket", "limitless"], cap = 50) =>
    (await client.query(WALLET_INTEL_WHALE_MARKETS_SQL, [cap, at, venues]))
      .rows;
  assert.deepEqual(
    (await select()).map((r) => r.id),
    expected,
  );
  assert.deepEqual(
    (await select(["polymarket", "limitless"], 2)).map((r) => r.id),
    expected.slice(0, 2),
  );
  assert.deepEqual(
    (await select(["limitless"])).map((r) => r.id),
    ["limitless"],
  );
  assert.deepEqual(
    (await select(["kalshi"])).map((r) => r.id),
    ["kalshi"],
  );
  assert.deepEqual(await select([]), []);
  assert.deepEqual(await select(undefined, 0), []);
  console.log(
    "[wallet-intel-whale-selection] semantic filters, lookback, deduplication, ordering and limits passed",
  );
  await client.query(
    `PREPARE whale_selection(int,timestamptz,text[]) AS ${WALLET_INTEL_WHALE_MARKETS_SQL}`,
  );
  for (const mode of ["force_custom_plan", "force_generic_plan"]) {
    await client.query(`SET LOCAL plan_cache_mode=${mode}`);
    for (const [cap, venues] of [
      [50, ["polymarket", "limitless"]],
      [500, ["polymarket", "limitless"]],
      [50, []],
      [0, ["polymarket"]],
    ] as const) {
      const args = `${cap},'${at}',ARRAY[${venues.map((v) => `'${v}'`).join(",")}]::text[]`;
      const result = await client.query(`EXECUTE whale_selection(${args})`);
      assert.deepEqual(
        result.rows.map((r) => r.id),
        cap === 0 || venues.length === 0 ? [] : expected,
      );
      const plan = await client.query(
        `EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON,TIMING OFF) EXECUTE whale_selection(${args})`,
      );
      const root = plan.rows[0]["QUERY PLAN"][0];
      assert.equal(root.Plan["Actual Rows"], result.rows.length);
      console.log(
        `[wallet-intel-whale-selection] ${mode} cap=${cap} venues=${venues.length} executionMs=${root["Execution Time"]}`,
      );
    }
  }
  // No whale tag / no recent activity is a normal empty result.
  await client.query("DELETE FROM wallet_tag_map WHERE tag_id=1");
  assert.deepEqual(await select(), []);
  await client.query("ROLLBACK");
} finally {
  await client.query("ROLLBACK").catch(() => {});
  client.release();
  await pool.end();
}
