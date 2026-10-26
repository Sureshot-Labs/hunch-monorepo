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
  DISCOVERY_ESTIMATE_INPUTS_SQL,
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
  const noteId = "10000000-0000-4000-8000-000000000001";
  const estimated = await repo.estimateInputs([noteId]);
  assert.equal(estimated[0].position_shares, "500");
  assert.equal(estimated[0].actual_win_rate, "0.6");
  // A historical holding is not resurrected from an earlier batch or old asset.
  await pool.query(
    "update wallet_position_snapshots set metadata='{}' where wallet_id=$1",
    [walletIds[0]],
  );
  assert.equal((await repo.estimateInputs([noteId]))[0].position_shares, null);
  for (const metadata of [
    { tokenId: "YES1" },
    { tokenId: "YES1", positionContract: "0xold" },
  ]) {
    await pool.query(
      "update wallet_position_snapshots set metadata=$2::jsonb where wallet_id=$1",
      [walletIds[0], JSON.stringify(metadata)],
    );
    assert.equal(
      (await repo.estimateInputs([noteId]))[0].position_shares,
      null,
      "Limitless requires the actual current position contract, not just a token id",
    );
  }
  await pool.query(
    "update wallet_position_snapshots set metadata=jsonb_build_object('tokenId','YES1','positionContract','0xctf') where wallet_id=$1",
    [walletIds[0]],
  );
  await pool.query(
    "insert into wallet_position_snapshots values ($1,'limitless','other:1','YES',1,1,'2026-10-25T12:01Z','{}')",
    [walletIds[0]],
  );
  assert.equal((await repo.estimateInputs([noteId]))[0].position_shares, null);
  await pool.query(
    "delete from wallet_position_snapshots where wallet_id=$1 and market_id='other:1'",
    [walletIds[0]],
  );
  await pool.query(
    "update ai_notes set model_meta=jsonb_build_object('primary_holder_credentials',jsonb_build_object('primaryHolder',jsonb_build_object('walletId',$1::text))) where id=$2",
    [walletIds[1], noteId],
  );
  assert.equal(
    (await repo.estimateInputs([noteId]))[0].wallet_id,
    null,
    "explicit representative is never silently replaced by a better wallet",
  );
  await pool.query("update ai_notes set model_meta='{}' where id=$1", [noteId]);
  const polyNote = randomUUID();
  await pool.query(
    'insert into ai_notes select $1,\'polymarket:probe\',source_kind,producer_type,note_type,status,title,description,created_at,lineage,metrics||\'{"socialInstrumentV1":{"tokenId":"new-asset","generation":"137:0xcurrent:v2"}}\'::jsonb,model_meta from ai_notes where id=$2',
    [polyNote, noteId],
  );
  await pool.query(
    "insert into ai_note_targets values ($1,'wallet',$2,10,'{\"side\":\"YES\"}')",
    [polyNote, walletIds[0]],
  );
  await pool.query(
    "insert into polymarket_asset_bindings values (137,'0xcurrent','new-asset','polymarket:probe','v2',0)",
  );
  await pool.query(
    "insert into wallet_position_snapshots values ($1,'polymarket','polymarket:probe','YES',500,250,$2,'{\"tokenId\":\"old-asset\"}')",
    [walletIds[0], asOf],
  );
  assert.equal(
    (await repo.estimateInputs([polyNote]))[0].position_shares,
    null,
  );
  await pool.query(
    "update wallet_position_snapshots set metadata='{\"tokenId\":\"new-asset\"}' where market_id='polymarket:probe'",
  );
  assert.equal(
    (await repo.estimateInputs([polyNote]))[0].position_shares,
    "500",
    "unambiguous indexed contract recovers a legacy token-only snapshot",
  );
  await pool.query(
    'update wallet_position_snapshots set metadata=\'{"tokenId":"new-asset","positionContract":"0xold"}\' where market_id=\'polymarket:probe\'',
  );
  assert.equal(
    (await repo.estimateInputs([polyNote]))[0].position_shares,
    null,
    "an explicit mismatching legacy contract cannot be overridden by a binding",
  );
  await pool.query(
    "update wallet_position_snapshots set metadata='{\"tokenId\":\"new-asset\"}' where market_id='polymarket:probe'",
  );
  await pool.query(
    "insert into polymarket_asset_bindings values (137,'0xold','new-asset','polymarket:probe','v1',0)",
  );
  assert.equal(
    (await repo.estimateInputs([polyNote]))[0].position_shares,
    null,
    "ambiguous contract cannot confirm current generation",
  );
  await pool.query(
    'update wallet_position_snapshots set metadata=\'{"tokenId":"new-asset","positionContract":"0xcurrent"}\' where market_id=\'polymarket:probe\'',
  );
  assert.equal(
    (await repo.estimateInputs([polyNote]))[0].position_shares,
    "500",
    "explicit matching flat contract is authoritative despite an older binding",
  );
  await pool.query(
    'update wallet_position_snapshots set metadata=\'{"assets":[{"tokenId":"new-asset","positionContract":"0xcurrent","shares":500}]}\' where market_id=\'polymarket:probe\'',
  );
  assert.equal(
    (await repo.estimateInputs([polyNote]))[0].position_shares,
    "500",
    "explicit current asset recovers despite an older same-id binding",
  );
  await pool.query(
    'update wallet_position_snapshots set metadata=\'{"assets":[{"tokenId":"new-asset","positionContract":"0xold","shares":500}]}\' where market_id=\'polymarket:probe\'',
  );
  assert.equal(
    (await repo.estimateInputs([polyNote]))[0].position_shares,
    null,
  );
  await pool.query("delete from ai_note_targets where note_id=$1", [polyNote]);
  await pool.query("delete from ai_notes where id=$1", [polyNote]);
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
  const liveGem = (await app.inject("/discovery/hidden-gems")).json().items[0];
  assert.equal(liveGem.estimate.status, "available");
  assert.equal(liveGem.estimate.calibrated, false);
  const smartSnapshot = await store.current("smart-money");
  assert.ok(smartSnapshot);
  const traderPage = await app.inject(
    `/discovery/smart-money/limitless:1/traders?snapshotId=${smartSnapshot.id}&limit=2`,
  );
  assert.equal(traderPage.statusCode, 200);
  assert.equal(traderPage.json().items.length, 2);
  assert.equal(traderPage.json().positioning.selected.ownerGroups, 4);
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
  // 50 distinct public notes, with existing indexed subjects and one million old position rows.
  await pool.query("update ai_notes set status='active'");
  const enrichmentIds = [noteId];
  for (let i = 1; i < 50; i++) {
    const id = randomUUID();
    enrichmentIds.push(id);
    await pool.query(
      "insert into ai_notes select $1,source_id,source_kind,producer_type,note_type,status,title,description,created_at,lineage,metrics,model_meta from ai_notes where id=$2",
      [id, noteId],
    );
    await pool.query(
      "insert into ai_note_targets values ($1,'wallet',$2,10,'{\"side\":\"YES\"}')",
      [id, walletIds[i % walletIds.length]],
    );
    const marketId = `limitless:${i + 1}`,
      token = `YES${i + 1}`;
    await pool.query(
      "update ai_notes set source_id=$2, metrics=jsonb_set(metrics,'{socialInstrumentV1}',jsonb_build_object('marketId',$2::text,'venue','limitless','tokenId',$3::text,'outcome','YES','generation','8453:0xctf:'||$3::text,'expiry','2026-10-25T13:00:00.000Z')) where id=$1",
      [id, marketId, token],
    );
    await pool.query(
      "insert into wallet_position_snapshots values ($1,'limitless',$2,'YES',500,450,$3,jsonb_build_object('tokenId',$4::text,'positionContract','0xctf'))",
      [walletIds[i % walletIds.length], marketId, asOf, token],
    );
  }
  await pool.query(
    "analyze ai_note_targets; analyze ai_notes; analyze wallet_intel_selector_snapshot",
  );
  let gemProgress = await builder.start(
    "hidden-gems",
    discoveryTestScope,
    null,
  );
  for (let step = 0; step < 10; step++) {
    const built = await builder.step(gemProgress, discoveryTestScope);
    gemProgress = built.progress;
    if (built.snapshot) {
      await store.acquire("hidden-gems", "perf");
      await store.publish("hidden-gems", "perf", built.snapshot);
      await store.release("hidden-gems", "perf");
      break;
    }
  }
  for (const limit of [20, 50]) {
    const times: number[] = [];
    for (let wave = 0; wave < 4; wave++)
      await Promise.all(
        Array.from({ length: 8 }, async () => {
          const start = performance.now(),
            response = await app.inject(
              `/discovery/hidden-gems?limit=${limit}`,
            );
          assert.equal(response.statusCode, 200);
          assert.equal(response.json().items.length, limit);
          assert.ok(
            response
              .json()
              .items.every(
                (i: { estimate: { status: string } }) =>
                  i.estimate.status === "available",
              ),
          );
          times.push(performance.now() - start);
        }),
      );
    times.sort((a, b) => a - b);
    const p95 = times[Math.ceil(times.length * 0.95) - 1];
    assert.ok(p95 < (limit === 20 ? 300 : 700));
    console.log(
      JSON.stringify({
        section: "hidden-gems",
        limit,
        concurrency: 8,
        samples: times.length,
        p95Ms: p95,
      }),
    );
  }
  const probes: [string, string, string[], unknown[]][] = [
    [
      "estimate20",
      DISCOVERY_ESTIMATE_INPUTS_SQL,
      ["uuid[]"],
      [enrichmentIds.slice(0, 20)],
    ],
    ["estimate50", DISCOVERY_ESTIMATE_INPUTS_SQL, ["uuid[]"], [enrichmentIds]],
    ["estimate-empty", DISCOVERY_ESTIMATE_INPUTS_SQL, ["uuid[]"], [[]]],
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
        const nodes: Record<string, unknown>[] = [];
        const walk = (node: Record<string, unknown>) => {
          nodes.push(node);
          for (const child of (node.Plans ?? []) as Record<string, unknown>[])
            walk(child);
        };
        walk(plan.Plan);
        if (label.startsWith("estimate"))
          assert.ok(
            !nodes.some(
              (n) =>
                n["Node Type"] === "Seq Scan" &&
                n["Relation Name"] === "wallet_position_snapshots",
            ),
            "no full position history scan",
          );
        plans.push({
          label,
          generic,
          executionMs: plan["Execution Time"],
          planningMs: plan["Planning Time"],
          sharedHits: plan.Plan["Shared Hit Blocks"],
          localHits: plan.Plan["Local Hit Blocks"],
          rowsScanned: nodes.reduce(
            (sum, n) =>
              sum +
              Number(n["Actual Rows"] ?? 0) * Number(n["Actual Loops"] ?? 0),
            0,
          ),
          indexes: [
            ...new Set(nodes.map((n) => n["Index Name"]).filter(Boolean)),
          ],
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
