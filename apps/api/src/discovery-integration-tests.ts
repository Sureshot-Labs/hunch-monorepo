// @requires-db @requires-redis
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import { createRedisClient } from "@hunch/infra";
import { createIntegrationTestPool } from "./test-database-target.js";
import {
  DiscoveryRepository,
  discoveryReadOnly,
  DISCOVERY_QUICK_POOL_SQL,
  DISCOVERY_MARKET_CARDS_SQL,
  DISCOVERY_MARKET_QUOTES_SQL,
  DISCOVERY_RESEARCH_PAGE_SQL,
  DISCOVERY_RESEARCH_CURRENT_SQL,
  DISCOVERY_WALLET_PAGE_SQL,
  DISCOVERY_SMART_INPUTS_SQL,
  DISCOVERY_OWNER_FAMILY_SQL,
  DISCOVERY_OWNER_METADATA_SQL,
} from "./repos/discovery.js";
import { DiscoveryBuilder } from "./services/discovery-builder.js";
import { DiscoveryStore } from "./services/discovery-store.js";
import { DiscoveryService } from "./services/discovery-service.js";
import { createDiscoveryRoutes } from "./routes/discovery.js";
import {
  discoveryTestNow as now,
  discoveryTestScope,
} from "./discovery-test-fixtures.js";

assert.equal(
  process.env.HUNCH_TEST_EXPECT_DATABASE,
  "hunch_discovery_test_20261025",
);
assert.equal(
  process.env.HUNCH_DISCOVERY_TEST_REDIS_URL,
  "redis://127.0.0.1:6380",
);
const pool = await createIntegrationTestPool({ max: 1 });
const redis = createRedisClient({
  url: process.env.HUNCH_DISCOVERY_TEST_REDIS_URL,
});
await redis.connect();
const prefix = `discovery-test:${randomUUID()}`,
  store = new DiscoveryStore(redis, prefix),
  repo = new DiscoveryRepository(pool),
  builder = new DiscoveryBuilder(repo, "0xctf", () => now);
const service = new DiscoveryService(
  builder,
  async () => store,
  async () => discoveryTestScope,
  () => now,
);
const app = Fastify();
app.setValidatorCompiler(validatorCompiler);
app.setSerializerCompiler(serializerCompiler);
await app.register(createDiscoveryRoutes(service));
const asOf = new Date(now).toISOString(),
  ids = Array.from({ length: 100 }, (_, i) => `limitless:${i + 1}`);
try {
  assert.match(
    String((await pool.query("select version()")).rows[0].version),
    /PostgreSQL 16/,
  );
  await pool.query(
    readFileSync(new URL("./fixtures/discovery.sql", import.meta.url), "utf8"),
  );
  await pool.query(
    "create table if not exists public.discovery_readonly_guard(id text primary key)",
  );
  const walletIds = (
    await pool.query("select id from wallets order by id")
  ).rows.map((r) => r.id as string);
  const first = await repo.query(DISCOVERY_QUICK_POOL_SQL, [
    discoveryTestScope.venues,
    null,
    null,
    asOf,
  ]);
  assert.equal(first.length, 150);
  const cards = await repo.marketCards(ids);
  assert.equal(cards.length, 200);
  const wallets = await repo.query(DISCOVERY_WALLET_PAGE_SQL, [
    asOf,
    null,
    null,
    10000,
    10000,
  ]);
  assert.equal(wallets.length, 4);
  const inputs = await repo.query(DISCOVERY_SMART_INPUTS_SQL, [
    walletIds,
    asOf,
    discoveryTestScope.venues,
  ]);
  const changes = inputs[0].changes as { net_shares: string }[];
  assert.equal(changes.length, 4);
  assert.ok(
    changes.every((c) => c.net_shares === "500"),
    "all 120 BUY observations minus absolute SELL; trades excluded",
  );
  assert.equal((inputs[0].positions as unknown[]).length, 4);
  await pool.query(
    "update wallet_position_exposure set open_positions_version=0",
  );
  const fallback = await repo.query(DISCOVERY_SMART_INPUTS_SQL, [
    walletIds,
    asOf,
    discoveryTestScope.venues,
  ]);
  assert.deepEqual(fallback[0].changes, inputs[0].changes);
  assert.equal((fallback[0].positions as unknown[]).length, 4);
  // PostgreSQL deliberately permits writes to temporary tables in READ ONLY transactions.
  await assert.rejects(
    () =>
      discoveryReadOnly(pool, (c) =>
        c.query(
          "insert into public.discovery_readonly_guard(id) values ('forbidden')",
        ),
      ),
    /read-only/,
  );
  assert.equal(
    (
      await pool.query(
        "select count(*)::int AS total from public.discovery_readonly_guard",
      )
    ).rows[0].total,
    0,
  );
  const owner = "builder";
  await store.acquire("quick-wins", owner);
  const progress = await builder.start("hidden-gems", discoveryTestScope, null);
  progress.section = "quick-wins";
  progress.phase = "cards";
  progress.eligibleIds = ids;
  progress.projectionRefreshedAt = asOf;
  const built = await builder.step(progress, discoveryTestScope);
  assert.ok(built.snapshot);
  assert.equal(built.snapshot.items.length, 100);
  await store.publish("quick-wins", owner, built.snapshot);
  await store.release("quick-wins", owner);
  await service.refresh("smart-money");
  const money = await store.current("smart-money");
  assert.equal(money?.items[0]?.reason.kind, "smart-money");
  if (money?.items[0]?.reason.kind === "smart-money")
    assert.equal(money.items[0].reason.ownerGroups, 4);
  await service.refresh("hidden-gems");
  assert.equal((await store.current("hidden-gems"))?.items.length, 1);
  // Known siblings need not pass alpha qualification to veto a hedge or offset a sale.
  const sibling = randomUUID();
  await pool.query(
    "insert into wallets select $1,'sibling','evm',null,jsonb_build_object('ownerAddress',address) from wallets where id=$2",
    [sibling, walletIds[0]],
  );
  await pool.query(
    "insert into wallet_position_snapshots values ($1,'limitless','limitless:1','NO',500,450,$2,'{}')",
    [sibling, asOf],
  );
  let moneyProgress = await builder.start(
    "smart-money",
    discoveryTestScope,
    null,
  );
  for (let i = 0; i < 30; i++) {
    const result = await builder.step(moneyProgress, discoveryTestScope);
    moneyProgress = result.progress;
    if (result.snapshot) {
      assert.equal(result.snapshot.items[0]?.reason.kind, "smart-money");
      if (result.snapshot.items[0]?.reason.kind === "smart-money")
        assert.equal(result.snapshot.items[0].reason.ownerGroups, 3);
      break;
    }
    assert.ok(i < 29, "owner-family build must complete");
  }
  const performanceReport = [];
  for (const limit of [20, 50]) {
    const times = [];
    for (let i = 0; i < 32; i++) {
      const start = performance.now();
      const response = await app.inject(`/discovery/quick-wins?limit=${limit}`);
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().items.length, limit);
      if (i > 1) times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    const p95 = times[Math.ceil(times.length * 0.95) - 1];
    performanceReport.push({
      limit,
      concurrency: 1,
      p95Ms: Number(p95.toFixed(2)),
      samples: times.length,
    });
    assert.ok(p95 < (limit === 20 ? 300 : 700), `p95 ${limit} cards: ${p95}`);
  }
  // Bounded local contention only; never run this load test against production.
  for (const limit of [20, 50]) {
    const times: number[] = [];
    for (let wave = 0; wave < 4; wave++)
      await Promise.all(
        Array.from({ length: 8 }, async () => {
          const start = performance.now();
          const response = await app.inject(
            `/discovery/quick-wins?limit=${limit}`,
          );
          assert.equal(response.statusCode, 200);
          assert.equal(response.json().items.length, limit);
          times.push(performance.now() - start);
        }),
      );
    times.sort((a, b) => a - b);
    const p95 = times[Math.ceil(times.length * 0.95) - 1];
    performanceReport.push({
      limit,
      concurrency: 8,
      p95Ms: Number(p95.toFixed(2)),
      samples: times.length,
    });
    assert.ok(
      p95 < (limit === 20 ? 300 : 700),
      `concurrent p95 ${limit} cards: ${p95}`,
    );
  }
  await pool.query("update ai_notes set status='retracted'");
  const gems = await app.inject("/discovery/hidden-gems");
  assert.equal(gems.statusCode, 200);
  assert.equal(gems.json().items.length, 0);
  const scale = Number(process.env.HUNCH_DISCOVERY_SCALE_ROWS ?? 1000);
  assert.ok(Number.isSafeInteger(scale) && scale >= 0 && scale <= 1000000);
  await pool.query(
    "insert into wallet_position_snapshots select $1,'limitless','old:'||n,'YES',1,0.5,'2025-01-01'::timestamptz+n*interval '1 second','{}' from generate_series(1,$2::int) n",
    [walletIds[0], scale],
  );
  await pool.query(
    "analyze wallet_position_snapshots; analyze unified_market_tokens; analyze unified_markets; analyze ai_notes; analyze wallet_activity_events;",
  );
  const probes: [string, string, string[], unknown[]][] = [
    [
      "pool",
      DISCOVERY_QUICK_POOL_SQL,
      ["text[]", "numeric", "text", "timestamptz"],
      [discoveryTestScope.venues, null, null, asOf],
    ],
    [
      "pool-empty",
      DISCOVERY_QUICK_POOL_SQL,
      ["text[]", "numeric", "text", "timestamptz"],
      [discoveryTestScope.venues, "0", "", asOf],
    ],
    ["cards100", DISCOVERY_MARKET_CARDS_SQL, ["text[]"], [ids]],
    ["quotes100", DISCOVERY_MARKET_QUOTES_SQL, ["text[]"], [ids]],
    ["cards-empty", DISCOVERY_MARKET_CARDS_SQL, ["text[]"], [[]]],
    [
      "research",
      DISCOVERY_RESEARCH_PAGE_SQL,
      ["timestamptz", "timestamptz", "uuid"],
      [asOf, null, null],
    ],
    [
      "research-current",
      DISCOVERY_RESEARCH_CURRENT_SQL,
      ["text[]", "timestamptz"],
      [ids, asOf],
    ],
    [
      "wallets",
      DISCOVERY_WALLET_PAGE_SQL,
      ["timestamptz", "timestamptz", "uuid", "numeric", "numeric"],
      [asOf, null, null, 10000, 10000],
    ],
    ["families", DISCOVERY_OWNER_FAMILY_SQL, ["uuid[]"], [walletIds]],
    ["owner-metadata", DISCOVERY_OWNER_METADATA_SQL, ["uuid"], [null]],
    [
      "inputs-fallback",
      DISCOVERY_SMART_INPUTS_SQL,
      ["uuid[]", "timestamptz", "text[]"],
      [walletIds, asOf, discoveryTestScope.venues],
    ],
  ];
  const plans = [];
  for (const [label, sql, types, params] of probes) {
    for (const generic of [false, true]) {
      const client = await pool.connect();
      try {
        await client.query("begin read only");
        await client.query(
          "set local statement_timeout='15s';set local lock_timeout='2s';set local jit=off",
        );
        if (generic)
          await client.query("set local plan_cache_mode='force_generic_plan'");
        const name = `probe_${randomUUID().replaceAll("-", "")}`;
        await client.query(`prepare ${name}(${types.join(",")}) as ${sql}`);
        const literal = (v: unknown): string =>
          v === null
            ? "NULL"
            : Array.isArray(v)
              ? `ARRAY[${v.map(literal).join(",")}]::${types[params.indexOf(v)]}`
              : typeof v === "number"
                ? String(v)
                : `'${String(v).replaceAll("'", "''")}'`;
        const result = await client.query(
          `explain(analyze,buffers,timing off,format json) execute ${name}(${params.map(literal).join(",")})`,
        );
        const plan = result.rows[0]["QUERY PLAN"][0];
        plans.push({
          label,
          generic,
          executionMs: plan["Execution Time"],
          planningMs: plan["Planning Time"],
        });
        await client.query(`deallocate ${name}`);
      } finally {
        await client.query("rollback");
        client.release();
      }
    }
  }
  console.log(
    JSON.stringify(
      {
        ok: true,
        postgres: "16",
        scaleHistoryRows: scale,
        apiPerformance: performanceReport,
        plans,
      },
      null,
      2,
    ),
  );
} finally {
  await service.stop();
  await app.close();
  // Exact random test namespace only; never FLUSHDB/FLUSHALL or production keys.
  const keys = await redis.keys(`${prefix}:*`);
  if (keys.length) await redis.del(keys);
  await redis.quit();
  await pool.end();
}
