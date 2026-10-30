// @requires-db @requires-redis
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import { createRedisClient, type Pool } from "@hunch/infra";
import { createIntegrationTestPool } from "./test-database-target.js";
import {
  loadIntelTags,
  INTEL_TAG_NOTES_SQL,
  INTEL_TAG_BASELINES_SQL,
} from "./services/intel-tags-loader.js";
import { classifyIntelTags } from "./services/intel-tags.js";
import { SocialService } from "./services/social-service.js";
import { socialFeedResponse } from "./schemas/social.js";
import { createHunchesRoutes } from "./routes/hunches.js";
import { intelTagFixture } from "./intel-tags-test-fixtures.js";

assert.equal(
  process.env.HUNCH_TEST_EXPECT_DATABASE,
  "hunch_intel_test_20261029",
);
assert.equal(process.env.HUNCH_INTEL_TEST_REDIS_URL, "redis://127.0.0.1:6380");
const scale = Number(process.env.INTEL_TAG_TEST_SCALE ?? 1000);
assert.ok(Number.isInteger(scale) && scale >= 0 && scale <= 1_000_000);
const pool = await createIntegrationTestPool({ max: 1 });
const client = await pool.connect();
const calls: { sql: string; values: unknown[] }[] = [];
let degraded = false;
const db = {
  query: async (sql: string, values: unknown[] = []) => {
    calls.push({ sql, values });
    if (degraded && sql === INTEL_TAG_BASELINES_SQL)
      throw Error("simulated baseline outage");
    return client.query(sql, values);
  },
} as unknown as Pool;
const f = intelTagFixture();
const redis = createRedisClient({
  url: process.env.HUNCH_INTEL_TEST_REDIS_URL,
});
const redisKey = `intel-tags-test:${randomUUID()}`;
const app = Fastify();
app.setSerializerCompiler(serializerCompiler);
app.setValidatorCompiler(validatorCompiler);
await app.register(createHunchesRoutes(db, f));
const service = new SocialService(db, async () => {}, f);
app.get(
  "/social/feed",
  { schema: { response: { 200: socialFeedResponse } } },
  async () => service.feed(null, { mode: "all", source: "hunch", limit: 20 }),
);
try {
  const version = await client.query(
    "select current_setting('server_version_num')::int as version",
  );
  assert.ok(
    version.rows[0].version >= 160000 && version.rows[0].version < 170000,
  );
  await client.query("begin");
  await client.query("set local statement_timeout='30s'");
  await client.query("set local lock_timeout='2s'");
  await client.query(`
    create temp table ai_notes(id uuid primary key, source_id text,source_kind text,producer_type text,note_type text,status text,created_at timestamptz,updated_at timestamptz,title text,description text,lineage jsonb,metrics jsonb,model_meta jsonb);
    create temp table unified_markets(id text primary key,event_id text,venue text,venue_market_id text,title text,status text,outcomes text,image text,close_time timestamptz,expiration_time timestamptz,resolved_outcome text,resolved_outcome_pct numeric,metadata jsonb,updated_at timestamptz);
    create temp table unified_tokens(token_id text primary key,market_id text,side text);
    create temp table unified_events(id text primary key,title text,status text,end_date timestamptz,image text);
    create temp table polymarket_markets(id text primary key,accepting_orders boolean);
    create temp table unified_token_top_latest(token_id text primary key,mid numeric,best_bid numeric,best_ask numeric,ts timestamptz);
    create temp table runtime_policies(policy_key text,effective_at timestamptz,created_at timestamptz,payload jsonb);
    create temp table users(id uuid primary key,is_active boolean,social_suspended_at timestamptz);
    create temp table user_blocks(blocker_user_id uuid,blocked_user_id uuid);
    create temp table social_comments(ai_note_id uuid,author_id uuid,author_hidden_at timestamptz,moderation_hidden_at timestamptz);
    create temp table social_likes(ai_note_id uuid,user_id uuid);
    create temp table copy_attributions(source_ai_note_id uuid,copier_user_id uuid,state text);
    create temp table ai_note_targets(note_id uuid,target_id text,target_kind text,target_meta jsonb,target_rank int);
    create temp table wallets(id uuid primary key,address text,chain text);
    create temp table wallet_profiles(wallet_id uuid,profile jsonb);
    create temp table wallet_intel_selector_snapshot(wallet_id uuid,metrics_as_of timestamptz,metrics_pnl_30d numeric,metrics_trades_30d int,metrics_resolved_win_rate_edge_30d numeric,metrics_resolved_edge_sample_count_30d int);
  `);
  for (const note of [f.baseline, f.note]) {
    await client.query(
      `insert into ai_notes values($1,$2,'market','holder_research',$3,$4,$5,$5,'Named outcome: No agreement','Public summary',$6,$7,$8)`,
      [
        note.id,
        note.source_id,
        note.note_type,
        note.status,
        note.created_at,
        JSON.stringify(note.lineage),
        JSON.stringify(note.metrics),
        JSON.stringify(note.model_meta),
      ],
    );
  }
  await client.query(
    "insert into unified_markets values($1,'event','limitless','fixture','No agreement','RESOLVED','[\"Yes\",\"No\"]',null,null,null,'NO',null,'{}',now())",
    [f.note.source_id],
  );
  await client.query("insert into unified_tokens values($1,$2,'NO')", [
    f.market.token_id,
    f.note.source_id,
  ]);
  await client.query(
    "insert into unified_events values('event','Specific contract','RESOLVED',null,null)",
  );
  const result = await loadIntelTags(db, [f.note.id], f);
  assert.equal(result.complete, true);
  assert.deepEqual(result.byId.get(f.note.id), classifyIntelTags(f));
  // Exercise real list/detail and mixed feed hydration; no lookup of current holder history is needed.
  const list = await app.inject(
    `/hunches?window=latest&marketId=${encodeURIComponent(f.note.source_id)}`,
  );
  const detail = await app.inject(`/hunches/${f.note.id}`);
  const social = await app.inject("/social/feed");
  for (const response of [list, detail, social])
    assert.equal(response.statusCode, 200, response.body);
  for (const item of [
    list.json().items[0],
    detail.json().item,
    social.json().items.find((item: { id: string }) => item.id === f.note.id),
  ]) {
    assert.deepEqual(item.tags, classifyIntelTags(f).tags);
    assert.equal(item.primaryTag, "winning_bet");
  }
  assert.equal(detail.json().item.headline, "Named outcome: No agreement");
  assert.equal(
    social.json().items.length,
    2,
    "tagging does not collapse historical social revisions",
  );
  const normal = await service.feed(null, {
    mode: "all",
    source: "hunch",
    limit: 1,
  });
  assert.ok(normal.nextCursor);
  const next = await service.feed(null, {
    mode: "all",
    source: "hunch",
    limit: 1,
    cursor: normal.nextCursor,
  });
  assert.equal(next.items.length, 1);
  assert.notEqual(normal.items[0].id, next.items[0].id);
  degraded = true;
  const without = await service.feed(null, {
    mode: "all",
    source: "hunch",
    limit: 1,
  });
  const strip = (item: object) =>
    Object.fromEntries(
      Object.entries(item).filter(
        ([key]) => !["tags", "primaryTag", "tagsVersion"].includes(key),
      ),
    );
  assert.deepEqual(without.items.map(strip), normal.items.map(strip));
  assert.equal(without.nextCursor, normal.nextCursor);
  degraded = false;
  assert.deepEqual(
    await service.feed(null, { mode: "all", source: "hunch", limit: 1 }),
    normal,
  );
  assert.ok(
    calls.every(
      (call) =>
        !/^\s*(insert|update|delete|create|alter|begin|commit)\b/i.test(
          call.sql,
        ),
    ),
    "read path only uses SELECT",
  );
  await redis.connect();
  await redis.set(redisKey, JSON.stringify(normal), { EX: 60 });
  const cachedPayload = await redis.get(redisKey);
  assert.ok(cachedPayload);
  assert.deepEqual(
    JSON.parse(cachedPayload),
    normal,
    "typed additive payload survives Redis serialization",
  );
  // Million unrelated notes, markets and tokens; same existing PK indexes, no tag-specific indexes.
  await client.query(
    `insert into ai_notes select md5('intel-scale:'||sample.seq)::uuid,'scale:'||sample.seq,'market','other','context','active',now(),now(),'Unrelated','Unrelated','{}','{}','{}' from generate_series(1,$1::int) sample(seq)`,
    [scale],
  );
  await client.query(
    `insert into unified_markets(id,venue,title,metadata) select 'scale:'||sample.seq,'limitless','Unrelated','{}' from generate_series(1,$1::int) sample(seq)`,
    [scale],
  );
  await client.query(
    `insert into unified_tokens select 'scale:'||sample.seq,'scale:'||sample.seq,'YES' from generate_series(1,$1::int) sample(seq)`,
    [scale],
  );
  // Real 100-card maximum, with compatible note payloads rather than repeated IDs.
  const ids = Array.from({ length: 100 }, () => randomUUID());
  for (const id of ids)
    await client.query(
      "insert into ai_notes select $1,source_id,source_kind,producer_type,note_type,status,created_at,updated_at,title,description,lineage,metrics,model_meta from ai_notes where id=$2",
      [id, f.note.id],
    );
  await client.query(
    "analyze ai_notes; analyze unified_markets; analyze unified_tokens",
  );
  for (const mode of ["force_custom_plan", "force_generic_plan"]) {
    await client.query(`set local plan_cache_mode=${mode}`);
    for (const [name, sql] of [
      ["notes", INTEL_TAG_NOTES_SQL],
      ["baselines", INTEL_TAG_BASELINES_SQL],
    ] as const) {
      await client.query(`prepare intel_${name}(uuid[]) as ${sql}`);
      for (const size of [0, 1, 20, 50, 100]) {
        const selected = ids.slice(0, size);
        // UUIDs are generated locally, validated, and interpolated only into EXPLAIN EXECUTE syntax.
        assert.ok(selected.every((id) => /^[0-9a-f-]{36}$/.test(id)));
        const parameter = selected.length
          ? `array[${selected.map((id) => `'${id}'`).join(",")}]::uuid[]`
          : "array[]::uuid[]";
        const plan = (
          await client.query(
            `explain (analyze,buffers,format json) execute intel_${name}(${parameter})`,
          )
        ).rows[0]["QUERY PLAN"][0];
        const serialized = JSON.stringify(plan.Plan);
        if (scale >= 100000)
          assert.ok(
            !serialized.includes('"Node Type":"Seq Scan"'),
            `${mode}/${name}/${size}: unexpected full scan`,
          );
        console.log(
          JSON.stringify({
            mode,
            query: name,
            size,
            scale,
            executionMs: plan["Execution Time"],
            planningMs: plan["Planning Time"],
            rows: plan.Plan["Actual Rows"],
            localHits: plan.Plan["Local Hit Blocks"],
            localReads: plan.Plan["Local Read Blocks"],
          }),
        );
      }
      await client.query(`deallocate intel_${name}`);
    }
  }
  const samples: number[] = [];
  for (let index = 0; index < 25; index++) {
    const start = performance.now();
    const loaded = await loadIntelTags(db, ids, f);
    assert.equal(loaded.byId.size, 100);
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  console.log(
    JSON.stringify({
      tagHydration100P95Ms: samples[Math.ceil(samples.length * 0.95) - 1],
      scale,
    }),
  );
  console.log(
    "Intel PG16/Redis: exact SQL, API/social parity, pagination, no writes, recovery and plans passed",
  );
} finally {
  if (redis.isOpen) {
    await redis.del(redisKey);
    await redis.quit();
  }
  await app.close();
  await client.query("rollback");
  client.release();
  await pool.end();
}
