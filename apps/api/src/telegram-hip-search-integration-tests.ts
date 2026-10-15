// @requires-db
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomInt, randomUUID } from "node:crypto";
import { DEFAULT_HIP4_READ_POLICY } from "@hunch/shared";
import type { Pool } from "@hunch/infra";
import { createIntegrationTestPool } from "./test-database-target.js";
import { installHip4TestLifecycle } from "./hip4-test-lifecycle.js";
import { mapHip4Market } from "./services/hip4-mapping.js";
import { persistHip4Market } from "./services/hip4-repository.js";
import { searchTelegramMarkets } from "./services/telegram-market-search.js";
import {
  clearVenueLifecyclePolicyCache,
  VENUE_LIFECYCLE_CACHE_TTL_MS,
} from "./services/runtime-policies.js";

const target = await createIntegrationTestPool({
  max: 1,
  options: "-c statement_timeout=15000",
});
const client = await target.connect();
const originalNow = Date.now;
const originalFetch = globalThis.fetch;
let clock = originalNow();
Date.now = () => clock;
globalThis.fetch = async () => {
  throw new Error("No external requests allowed");
};
// Real SQL on one rollback-only connection. Internal BEGIN/COMMIT scopes become
// savepoints, so publication and search settings cannot commit these fixtures.
let sequence = 0;
const hydrationQueries: Array<{ sql: string; values: unknown[] }> = [];
const db = {
  query: client.query.bind(client),
  connect: async () => {
    const name = `telegram_search_scope_${sequence++}`;
    return {
      query: async (sql: string, values?: unknown[]) => {
        const command = sql.trim().toLowerCase();
        if (command === "begin") return client.query(`savepoint ${name}`);
        if (command === "commit")
          return client.query(`release savepoint ${name}`);
        if (command === "rollback")
          return client.query(`rollback to savepoint ${name}`);
        if (sql.includes("with ordinality selected(id, ord)") && values)
          hydrationQueries.push({ sql, values: [...values] });
        return client.query(sql, values);
      },
      release: () => {},
    };
  },
} as unknown as Pool;

try {
  await client.query("begin");
  assert.equal(
    (Number(
      (await client.query("show server_version_num")).rows[0]
        .server_version_num,
    ) /
      10000) |
      0,
    16,
  );
  const lifecycle = await installHip4TestLifecycle(client);
  await client.query(
    "update runtime_policies set effective_at=now()-interval '3 seconds' where id=$1",
    [lifecycle.id],
  );
  const policyId = randomUUID();
  await client.query(
    "insert into runtime_policies(id,policy_key,payload,effective_at) values($1,'hip4_read',$2,now())",
    [policyId, { ...DEFAULT_HIP4_READ_POLICY, environment: "mainnet" }],
  );
  const source = JSON.parse(
    readFileSync(
      new URL("./fixtures/hip4/public-reads.json", import.meta.url),
      "utf8",
    ),
  ).observations[0];
  const tag = `hiptgnav${randomUUID().replaceAll("-", "")}`;
  const outcome = randomInt(100_000_000, 800_000_000);
  const ids = new Map<string, string>();
  for (const environment of ["mainnet", "testnet"] as const) {
    const observedAt = new Date(clock).toISOString();
    const mapped = mapHip4Market({
      ...source,
      environment,
      outcome,
      settlement: null,
      fetchedAt: observedAt,
      generation: randomUUID(),
      metadata: {
        ...source.metadata,
        questions: [],
        outcomes: [
          {
            ...source.metadata.outcomes[0],
            outcome,
            name: tag,
            description: `participant:${tag}|resolutionDeadline:20990101-0000`,
          },
        ],
      },
    });
    mapped.market.volume24h = {
      usd: "123.45",
      source: "spotMetaAndAssetCtxs",
      basis: "primary_outcome",
      coin: `#${outcome}0`,
      observedAt,
      validUntil: new Date(
        clock + DEFAULT_HIP4_READ_POLICY.volumeMaxAgeMs,
      ).toISOString(),
    };
    mapped.market.sides = mapped.market.sides.map((side) => ({
      ...side,
      bid: "0.4",
      ask: side.sideIndex === 0 ? "0.6" : "0.65",
      bookAt: observedAt,
      bookState: "fresh",
    }));
    assert.equal(await persistHip4Market(db, { ...mapped, trades: [] }), true);
    ids.set(environment, mapped.market.marketId);
  }
  const search = (
    query: string | null,
    sort: "trending" | "totalvol" | "time" = "trending",
  ) =>
    searchTelegramMarkets({ pool: db, venues: ["hyperliquid"], query, sort });
  for (const query of [tag, null]) {
    for (const sort of ["trending", "time", "totalvol"] as const) {
      const result = await search(query, sort);
      if (query === null && sort === "totalvol") {
        // Preserve the ordinary feed's lifetime-volume ranking semantics. HIP
        // has no such aggregate; do not invent one to enter this ranked list.
        assert.deepEqual(result, []);
        continue;
      }
      assert.ok(
        result.some((row) => row.marketId === ids.get("mainnet")),
        `${sort}/${query ?? "browse"} contains mainnet`,
      );
      assert.ok(
        result.every((row) => !row.marketId.startsWith("hyperliquid:testnet:")),
      );
      const row = result.find((value) => value.marketId === ids.get("mainnet"));
      assert.equal(row?.yesAsk, 0.6);
      assert.equal(row?.noAsk, 0.65);
      assert.equal(row?.volumeUsd, 123.45);
      assert.equal(row?.volumePeriod, "24h");
      assert.equal(row?.lastPrice, null);
    }
  }
  // A new effective policy revision switches the network without re-serving
  // the previous cached search. The resolver's TTL path has its own unit test.
  await client.query(
    "update runtime_policies set payload=jsonb_set(payload,'{environment}','\"testnet\"') where id=$1",
    [policyId],
  );
  await client.query(
    "update runtime_policies set effective_at=now()-interval '2500 milliseconds' where id=$1",
    [lifecycle.id],
  );
  clearVenueLifecyclePolicyCache(db);
  clock += VENUE_LIFECYCLE_CACHE_TTL_MS + 1;
  assert.deepEqual(
    (await search(tag)).map((row) => row.marketId),
    [ids.get("testnet")],
  );
  await client.query(
    "update runtime_policies set payload=jsonb_set(payload,'{venues,hyperliquid,lifecycle}','\"unreleased\"'),effective_at=now()-interval '2 seconds' where id=$1",
    [lifecycle.id],
  );
  clearVenueLifecyclePolicyCache(db);
  assert.deepEqual(await search(tag), []);
  await client.query(
    "update runtime_policies set payload=jsonb_set(payload,'{venues,hyperliquid,lifecycle}','\"active\"'),effective_at=now()-interval '1 second' where id=$1",
    [lifecycle.id],
  );
  clearVenueLifecyclePolicyCache(db);
  assert.deepEqual(
    (await search(tag)).map((row) => row.marketId),
    [ids.get("testnet")],
  );
  clock +=
    Math.max(
      DEFAULT_HIP4_READ_POLICY.bookMaxAgeMs,
      DEFAULT_HIP4_READ_POLICY.volumeMaxAgeMs,
    ) + 1;
  const stale = await search(tag);
  assert.equal(stale.length, 1);
  assert.equal(stale[0].yesAsk, null);
  assert.equal(stale[0].noAsk, null);
  assert.equal(stale[0].volumeUsd, null);
  assert.equal(stale[0].lastPrice, null);
  assert.deepEqual(await search(`${tag}missing`), []);
  // Exercise the changed ID-hydration parameter shape with real generic plans
  // and unrelated ranked rows. This must remain a bounded PK lookup, not a
  // second candidate scan. All data below is rolled back with the fixture.
  await client.query(
    `insert into unified_events(id,venue,venue_event_id,title,status)
    select 'tg-plan-'||$1||'-'||entry,'polymarket','tg-plan-'||$1||'-'||entry,'Unrelated plan event','ACTIVE'
    from generate_series(1,20000) entry`,
    [tag],
  );
  await client.query(
    `insert into unified_markets(id,venue,venue_market_id,event_id,title,status,market_type,volume_total,best_ask)
    select 'tg-plan-'||$1||'-'||entry,'polymarket','tg-plan-'||$1||'-'||entry,
      'tg-plan-'||$1||'-'||entry,'Unrelated plan market','ACTIVE','binary',1000000,0.5
    from generate_series(1,20000) entry`,
    [tag],
  );
  await client.query("analyze unified_events");
  await client.query("analyze unified_markets");
  await client.query("set local plan_cache_mode=force_generic_plan");
  const hydration = hydrationQueries.at(-1);
  assert.ok(hydration);
  await client.query(`prepare telegram_hip_hydration as ${hydration.sql}`);
  const literal = (value: unknown): string => {
    if (Array.isArray(value))
      return `ARRAY[${value.map(literal).join(",")}]::text[]`;
    if (typeof value === "number" && Number.isSafeInteger(value))
      return String(value);
    assert.ok(typeof value === "string" && /^[A-Za-z0-9_:.+-]+$/.test(value));
    return `'${value}'`;
  };
  try {
    for (const [label, marketId, expected] of [
      ["first", ids.get("mainnet"), 1],
      ["next", ids.get("testnet"), 1],
      ["empty", "hyperliquid:mainnet:outcome:0", 0],
    ] as const) {
      const values: unknown[] = hydration.values.map((value) =>
        Array.isArray(value) ? [marketId] : value,
      );
      const explained = await client.query<{
        "QUERY PLAN": Array<{
          Plan: Record<string, unknown>;
          "Execution Time": number;
        }>;
      }>(
        `explain(analyze,buffers,format json) execute telegram_hip_hydration(${values.map(literal).join(",")})`,
      );
      const plan = explained.rows[0]["QUERY PLAN"][0];
      assert.equal(plan.Plan["Actual Rows"], expected);
      const visit = (node: Record<string, unknown>) => {
        if (
          ["unified_markets", "unified_events"].includes(
            String(node["Relation Name"]),
          )
        ) {
          assert.notEqual(node["Node Type"], "Seq Scan");
          assert.ok(Number(node["Actual Rows"]) <= 1);
        }
        for (const child of (node.Plans ?? []) as Array<
          Record<string, unknown>
        >)
          visit(child);
      };
      visit(plan.Plan);
      console.log(
        `[telegram-hip-hydration] ${label}: ${plan["Execution Time"]}ms, ${plan.Plan["Shared Hit Blocks"]} shared hits, ${plan.Plan["Actual Rows"]} rows`,
      );
    }
  } finally {
    await client.query("deallocate telegram_hip_hydration");
  }
  console.log(
    "[telegram-hip-search-integration-tests] real publication/search: 6 paths, network switch, visibility recovery, stale observations and empty result passed",
  );
} finally {
  Date.now = originalNow;
  globalThis.fetch = originalFetch;
  clearVenueLifecyclePolicyCache(db);
  await client.query("rollback");
  client.release();
  await target.end();
}
