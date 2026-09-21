import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { createClient } from "redis";
import { Pool } from "pg";
import {
  DEFAULT_EMBEDDING_POLICY,
  LEGACY_EMBEDDING_GENERATION,
  generationForPolicy,
  loadEmbeddingSources,
  readEmbeddingSourcePage,
  countEmbeddingSources,
  embeddingKey,
  embeddingIndex,
  readActiveGeneration,
  buildEmbeddingText,
  embeddingTextHash,
  estimateEmbeddingCostUsd,
  pinGeneration,
  acquireEmbeddingGenerationPin,
  type EmbeddingGeneration,
} from "@hunch/embeddings";
import { DEFAULT_VENUE_LIFECYCLE_POLICY } from "@hunch/shared";
import { enqueueEmbedItems } from "@hunch/infra";
import { EmbeddingEngine, initializeEmbeddingWorker } from "./engine.js";
import {
  CONTROL,
  STREAM,
  GROUP,
  DLQ,
  EmbeddingStore,
  compareStreamId,
} from "./store.js";

// Fixed dedicated disposable endpoints; never use DATABASE_URL / production .env.
// Every provider call in this suite is an in-memory fake, with no paid HTTP calls.
const db = new Pool({
  connectionString:
    "postgres://postgres:embedding_test_local@127.0.0.1:55439/embedding_test",
  max: 2,
  statement_timeout: 15000,
  connectionTimeoutMillis: 5000,
});
const redis = createClient({
  RESP: 2,
  url: "redis://127.0.0.1:56439/0",
  socket: { connectTimeout: 5000, reconnectStrategy: false },
});
redis.on("error", () => {});
let store = new EmbeddingStore(redis);
// Transition/rollback fixtures explicitly choose E5, independently of rollout defaults.
const generation = generationForPolicy({
  ...DEFAULT_EMBEDDING_POLICY,
  model: "intfloat/e5-large-v2",
});
const qwen = generationForPolicy({
  ...DEFAULT_EMBEDDING_POLICY,
  model: "qwen/qwen3-embedding-8b",
});
const legacy = LEGACY_EMBEDDING_GENERATION;
const vector = Array.from({ length: 1024 }, (_, index) =>
  index === 0 ? 1 : 0,
);
type Provider = NonNullable<
  ConstructorParameters<typeof EmbeddingEngine>[0]["provider"]
>;
let providerCalls: string[] = [];
const provider: Provider = async (options) => {
  await options.beforeAttempt?.({ attempt: 1, estimatedCostUsd: 0.00001 });
  // Only count HTTP-equivalent calls after budget admission, not vetoed attempts.
  providerCalls.push(options.generation.id);
  return {
    embeddings: options.texts.map(() => [...vector]),
    usage: { inputTokens: 10, costUsd: 0.00001 },
    attempts: 1,
  };
};
const engine = (replacement: Provider = provider) =>
  new EmbeddingEngine({
    store,
    db,
    apiKey: "fixture",
    provider: replacement,
    availableMemory: async () => 8 * 1024 ** 3,
  });
const checkpointKey = (selected: EmbeddingGeneration) =>
  `${CONTROL}state:${selected.id}`;
type Checkpoint = {
  phase: string;
  kind: string;
  after: string | null;
  eligibilityRevision: string;
  verifiedAt: string | null;
  [key: string]: unknown;
};
function checkpoint(phase = "active", overrides: Record<string, unknown> = {}) {
  return {
    scanVersion: 2,
    countsReady: true,
    probes: { event: "event:a", market: "market:a" },
    phase,
    kind: "event",
    after: null,
    coverage: {
      events: { eligible: 1, verified: 1, missing: 0 },
      markets: { eligible: 1, verified: 1, missing: 0 },
    },
    watermark: "0-0",
    overflow: "0",
    startedAt: Date.now(),
    verifiedAt: new Date().toISOString(),
    pilotStartBytes: 0,
    pilotItems: 0,
    projectedBytes: 0,
    gcCursor: "0",
    gcKind: "event",
    gcDone: true,
    eligibilityRevision: "limitless,polymarket",
    ...overrides,
  };
}
async function setPolicy(key: string, payload: unknown) {
  await db.query("delete from runtime_policies where policy_key=$1", [key]);
  await db.query(
    // PostgreSQL now() retains microseconds; the production reader's JS asOf is
    // millisecond-precision. Fixtures must already be effective, not accidentally
    // scheduled a fraction of a millisecond after an immediate subsequent read.
    "insert into runtime_policies(policy_key,payload,effective_at) values ($1,$2::jsonb,now()-interval '1 second')",
    [key, JSON.stringify(payload)],
  );
}
async function seedGeneration(selected: EmbeddingGeneration) {
  for (const kind of ["event", "market"] as const) {
    await store.ensureIndex(selected, kind);
    const sources = await loadEmbeddingSources(
      db,
      kind,
      [`${kind}:a`],
      ["polymarket"],
    );
    for (const source of sources)
      await store.commit(
        selected,
        source,
        embeddingTextHash(buildEmbeddingText(source, selected)),
        vector,
      );
  }
  await store.put(`${CONTROL}generation:${selected.id}`, selected);
}
async function serve(selected: EmbeddingGeneration = generation) {
  await seedGeneration(selected);
  await store.put(`${CONTROL}active`, selected);
  await store.put(`${CONTROL}generations`, [selected]);
  await store.put(checkpointKey(selected), checkpoint());
  if (selected.id === qwen.id)
    await setPolicy("ai_embeddings", { model: qwen.model });
}
const enqueueMarket = () =>
  redis.xAdd(STREAM, "*", { entity_type: "market", entity_id: "market:a" });
async function pendingCount() {
  return Number(
    ((await redis.sendCommand(["XPENDING", STREAM, GROUP])) as unknown[])[0],
  );
}

before(async () => {
  assert.equal(
    (await db.query("select current_database() as db")).rows[0].db,
    "embedding_test",
  );
  assert.equal(
    (
      await db.query("show server_version_num")
    ).rows[0].server_version_num.slice(0, 2),
    "16",
  );
  await db.query(`create table if not exists unified_events(id text primary key,venue text,status text,title text,description text,category text);
    create table if not exists unified_markets(id text primary key,event_id text,venue text,status text,title text,description text,category text,outcomes jsonb,market_type text);
    alter table unified_markets add column if not exists market_type text;
    create table if not exists runtime_policies(id text default 'test',policy_key text,effective_at timestamptz default now(),payload jsonb,created_by text,created_by_admin_id text,created_at timestamptz default now());`);
  await redis.connect();
});
beforeEach(async () => {
  // Only the dedicated fixtures above, not developer Redis :6380 / Postgres :5433.
  await db.query(`truncate unified_markets,unified_events,runtime_policies;
    insert into unified_events(id,venue,status,title,description,category) values
      ('event:a','polymarket','ACTIVE','Will Bitcoin exceed $100,000?','<p>Before December 31, 2026.</p>','crypto'),
      ('event:orphan','polymarket','ACTIVE','Orphan',null,null);
    insert into unified_markets(id,event_id,venue,status,title,description,category,outcomes,market_type) values
      ('market:a','event:a','polymarket','ACTIVE','Above $100,000','Not before December 31, 2026.','crypto','["Yes","No"]','binary'),
      ('market:closed','event:a','polymarket','CLOSED','Closed',null,null,null,'binary');`);
  await setPolicy("ai_embeddings", { model: generation.model });
  for (const index of (await redis.sendCommand(["FT._LIST"])) as string[])
    await redis.sendCommand(["FT.DROPINDEX", index]);
  await redis.flushDb();
  store = new EmbeddingStore(redis);
  providerCalls = [];
  assert.equal(await store.acquire(), true);
  await initializeEmbeddingWorker(store);
});
after(async () => {
  await store.release().catch(() => {});
  if (redis.isOpen) await redis.quit();
  await db.end();
});

test("canonical SQL eligibility, stable pages and terminal rows", async () => {
  assert.deepEqual(await countEmbeddingSources(db, ["polymarket"]), {
    event: 1,
    market: 1,
  });
  assert.deepEqual(
    await readEmbeddingSourcePage(db, "event", null, ["polymarket"]),
    { ids: ["event:a"], after: "event:orphan", done: true },
  );
  assert.deepEqual(
    await readEmbeddingSourcePage(db, "market", "market:a", ["polymarket"]),
    { ids: [], after: "market:closed", done: true },
  );
  const sources = await loadEmbeddingSources(
    db,
    "market",
    ["market:a", "market:closed", "missing"],
    ["polymarket"],
  );
  assert.deepEqual(
    sources.map((source) => source.eligible),
    [true, false, false],
  );
  assert.equal(sources[0].eventTitle, "Will Bitcoin exceed $100,000?");
  assert.equal(sources[0].marketType, "binary");
});
test("stream IDs compare numerically", () =>
  assert.equal(compareStreamId("10-0", "9-100"), 1));
test("raw pages bound ineligible prefixes, preserve exact boundaries and scan each ID once", async () => {
  await db.query(`insert into unified_markets(id,venue,status,title)
    select 'a:' || lpad(fixture_no::text,6,'0'),
      case when fixture_no % 2 = 0 then 'kalshi' else 'polymarket' end,
      case when fixture_no % 2 = 0 then 'ACTIVE' else 'CLOSED' end,'Excluded'
    from generate_series(1,1000) as fixture_rows(fixture_no)`);
  const first = await readEmbeddingSourcePage(db, "market", null, [
    "polymarket",
  ]);
  assert.deepEqual(first, { ids: [], after: "a:000500", done: false });
  const second = await readEmbeddingSourcePage(db, "market", first.after, [
    "polymarket",
  ]);
  assert.deepEqual(second, { ids: [], after: "a:001000", done: false });
  const third = await readEmbeddingSourcePage(db, "market", second.after, [
    "polymarket",
  ]);
  assert.deepEqual(third, {
    ids: ["market:a"],
    after: "market:closed",
    done: true,
  });
  assert.deepEqual(await countEmbeddingSources(db, ["polymarket"]), {
    event: 1,
    market: 1,
  });
  assert.deepEqual(
    await readEmbeddingSourcePage(db, "market", third.after, ["polymarket"]),
    { ids: [], after: "market:closed", done: true },
  );
  assert.deepEqual(await readEmbeddingSourcePage(db, "market", null, []), {
    ids: [],
    after: null,
    done: true,
  });
});
test("source census is bounded, shared, restartable and required before background inference", async () => {
  await serve();
  await db.query(`insert into unified_events(id,venue,status,title)
    select 'a:' || lpad(fixture_no::text,6,'0'),'kalshi','ACTIVE','Excluded'
    from generate_series(1,1000) as fixture_rows(fixture_no)`);
  await store.put(
    checkpointKey(generation),
    checkpoint("building", {
      countsReady: false,
      gcDone: true,
      coverage: {
        events: { eligible: 0, verified: 0, missing: 0 },
        markets: { eligible: 0, verified: 0, missing: 0 },
      },
    }),
  );
  await engine().tick();
  const first = await store.get<{
    after: string;
    counts: { event: number };
    completedAt: number | null;
  }>(`${CONTROL}source-census`);
  assert.equal(first?.after, "a:000500");
  assert.equal(first?.counts.event, 0);
  assert.equal(first?.completedAt, null);
  assert.equal(
    (await store.get<Checkpoint>(checkpointKey(generation)))?.countsReady,
    false,
  );
  assert.equal(providerCalls.length, 0);
  await store.release();
  store = new EmbeddingStore(redis);
  assert.equal(await store.acquire(), true);
  await initializeEmbeddingWorker(store);
  const restarted = engine();
  await restarted.tick();
  assert.equal(
    (await store.get<{ after: string }>(`${CONTROL}source-census`))?.after,
    "a:001000",
  );
  await restarted.tick();
  await restarted.tick();
  const completed = await store.get<{ counts: unknown; completedAt: number }>(
    `${CONTROL}source-census`,
  );
  assert.deepEqual(completed?.counts, { event: 1, market: 1 });
  assert.ok(completed?.completedAt);
  assert.equal(
    (await store.get<Checkpoint>(checkpointKey(generation)))?.countsReady,
    true,
  );
  assert.equal(providerCalls.length, 0);
});
test("serving SQL timeout does not block live ACK, retry tightly or advance its cursor", async () => {
  await serve();
  let pageAttempts = 0;
  const worker = new EmbeddingEngine({
    store,
    apiKey: "fixture",
    provider,
    availableMemory: async () => 8 * 1024 ** 3,
    db: {
      async query(sql, values) {
        if (sql.includes("with embedding_page as materialized")) {
          pageAttempts++;
          throw Object.assign(
            new Error("canceling statement due to statement timeout"),
            { code: "57014" },
          );
        }
        return db.query(sql, values);
      },
    },
  });
  await enqueueMarket();
  await worker.tick();
  assert.equal(await pendingCount(), 0);
  assert.equal(pageAttempts, 1);
  assert.equal(await store.get(`${CONTROL}maintenance:${generation.id}`), null);
  await enqueueMarket();
  await worker.tick();
  assert.equal(await pendingCount(), 0);
  assert.equal(
    pageAttempts,
    1,
    "cooldown must not reissue the same failing page",
  );
  const status = await store.get<{ reason: string }>(`${CONTROL}status`);
  assert.match(
    status?.reason ?? "",
    /background_sql_retry:serving_metadata:57014/,
  );
});
test("empty verification pages do not skip later entities or weaken KNN admission", async () => {
  await seedGeneration(legacy);
  await seedGeneration(generation);
  await store.put(`${CONTROL}generations`, [legacy, generation]);
  await store.put(checkpointKey(legacy), checkpoint());
  await db.query(`insert into unified_events(id,venue,status,title)
    select 'a:' || lpad(fixture_no::text,6,'0'),'polymarket','CLOSED','Closed'
    from generate_series(1,500) as fixture_rows(fixture_no)`);
  await store.put(
    checkpointKey(generation),
    checkpoint("verifying", {
      probes: {},
      coverage: {
        events: { eligible: 1, verified: 0, missing: 0 },
        markets: { eligible: 1, verified: 0, missing: 0 },
      },
    }),
  );
  const worker = engine();
  await worker.tick();
  const first = await store.get<Checkpoint>(checkpointKey(generation));
  assert.equal(first?.kind, "event");
  assert.equal(first?.after, "a:000500");
  assert.equal(first?.phase, "verifying");
  await worker.tick();
  await worker.tick();
  const ready = await store.get<Checkpoint>(checkpointKey(generation));
  assert.equal(ready?.phase, "ready");
  assert.deepEqual(ready?.probes, { event: "event:a", market: "market:a" });
  // Force a failed real KNN admission after verified coverage; never activate.
  await redis.hDel(embeddingKey(generation, "event", "event:a"), "embedding");
  await worker.tick();
  assert.equal((await readActiveGeneration(redis)).id, legacy.id);
});
test("pre-fix ready checkpoints are reverified rather than skipping the new admission fields", async () => {
  await seedGeneration(legacy);
  await seedGeneration(generation);
  await store.put(`${CONTROL}generations`, [legacy, generation]);
  await store.put(checkpointKey(legacy), checkpoint());
  await store.put(
    checkpointKey(generation),
    checkpoint("ready", {
      scanVersion: undefined,
      countsReady: undefined,
      probes: undefined,
    }),
  );
  await engine().tick();
  assert.equal((await readActiveGeneration(redis)).id, legacy.id);
  const restarted = await store.get<Checkpoint>(checkpointKey(generation));
  assert.equal(restarted?.scanVersion, 2);
  assert.equal(restarted?.phase, "building");
  assert.equal(providerCalls.length, 0);
});
test("fence excludes second owner and stale publication after actual lease handoff", async () => {
  const stale = store,
    next = new EmbeddingStore(redis);
  assert.equal(await next.acquire(), false);
  await assert.rejects(() => next.put(`${CONTROL}status`, {}), /lease_lost/);
  await stale.release();
  assert.equal(await next.acquire(), true);
  store = next;
  await assert.rejects(() => stale.put(`${CONTROL}status`, {}), /lease_lost/);
});
test("generation build maintains legacy, verifies real KNN and activates automatically", async () => {
  const worker = engine();
  for (let count = 0; count < 30; count++) {
    await worker.tick();
    if ((await readActiveGeneration(redis)).id === generation.id) break;
  }
  assert.equal((await readActiveGeneration(redis)).id, generation.id);
  // One event and one market request in each of serving legacy and replacement.
  assert.deepEqual(
    providerCalls.sort(),
    [legacy.id, legacy.id, generation.id, generation.id].sort(),
  );
  assert.equal(
    await redis.hGet(
      embeddingKey(generation, "market", "market:a"),
      "embedding_version",
    ),
    generation.id,
  );
});
test("absent policy builds the compiled default directly and retains legacy closed seeds", async () => {
  await db.query("delete from runtime_policies where policy_key=$1", [
    "ai_embeddings",
  ]);
  const desired = generationForPolicy(DEFAULT_EMBEDDING_POLICY);
  const unused = desired.id === qwen.id ? generation : qwen;
  assert.equal((await readActiveGeneration(redis)).id, legacy.id);
  const closedSource = (
    await loadEmbeddingSources(db, "market", ["market:closed"], ["polymarket"])
  )[0];
  await store.ensureIndex(legacy, "market");
  await store.commit(
    legacy,
    { ...closedSource, eligible: true, status: "ACTIVE" },
    embeddingTextHash(buildEmbeddingText(closedSource, legacy)),
    vector,
  );
  await store.commit(legacy, closedSource, "");
  const closedKey = embeddingKey(legacy, "market", "market:closed");
  await redis.expire(closedKey, 90);
  const worker = engine();
  for (let count = 0; count < 30; count++) {
    await worker.tick();
    const active = await readActiveGeneration(redis);
    assert.ok(active.id === legacy.id || active.id === desired.id);
    if (active.id === desired.id) break;
  }
  assert.equal((await readActiveGeneration(redis)).id, desired.id);
  assert.deepEqual(
    providerCalls.sort(),
    [legacy.id, legacy.id, desired.id, desired.id].sort(),
    "only legacy maintenance and the selected default may incur inference",
  );
  assert.equal(
    (await store.get<Checkpoint>(checkpointKey(desired)))?.phase,
    "active",
  );
  assert.deepEqual(
    (await store.get<EmbeddingGeneration[]>(`${CONTROL}generations`))?.map(
      (selected) => selected.id,
    ),
    [legacy.id, desired.id],
  );
  const indexes = (await redis.sendCommand(["FT._LIST"])) as string[];
  for (const kind of ["event", "market"] as const) {
    assert.ok(indexes.includes(embeddingIndex(desired, kind)));
    assert.ok(!indexes.includes(embeddingIndex(unused, kind)));
  }
  assert.equal(await redis.hGet(closedKey, "status"), "CLOSED");
  assert.ok(
    (await redis.ttl(closedKey)) > 0 && (await redis.ttl(closedKey)) <= 90,
  );
  assert.equal(await redis.get(`${CONTROL}deleting:${legacy.id}`), null);
});
test("cache hit extends TTL and restores canonical ACTIVE without provider call", async () => {
  await seedGeneration(generation);
  const key = embeddingKey(generation, "market", "market:a");
  await redis.expire(key, 10);
  await redis.hSet(key, "status", "CLOSED");
  const source = (
    await loadEmbeddingSources(db, "market", ["market:a"], ["polymarket"])
  )[0];
  await store.commit(
    generation,
    source,
    embeddingTextHash(buildEmbeddingText(source, generation)),
  );
  assert.equal(await redis.hGet(key, "status"), "ACTIVE");
  assert.ok((await redis.ttl(key)) > 170000);
  assert.equal(providerCalls.length, 0);
});
test("terminal status keeps closed seed only for remaining TTL", async () => {
  await seedGeneration(generation);
  const key = embeddingKey(generation, "market", "market:a");
  await redis.expire(key, 90);
  const source = (
    await loadEmbeddingSources(db, "market", ["market:a"], ["polymarket"])
  )[0];
  await store.commit(
    generation,
    { ...source, status: "CLOSED", eligible: false },
    "",
  );
  assert.ok((await redis.ttl(key)) <= 90);
  assert.equal(await redis.hGet(key, "status"), "CLOSED");
});
test("reservations and page checkpoint survive worker restart", async () => {
  await seedGeneration(legacy);
  await seedGeneration(generation);
  await store.put(`${CONTROL}generations`, [legacy, generation]);
  await store.put(checkpointKey(legacy), checkpoint());
  await store.put(
    checkpointKey(generation),
    checkpoint("building", { after: "event:a" }),
  );
  await store.reserve(generation, 0.4, 1);
  await store.release();
  store = new EmbeddingStore(redis);
  assert.equal(await store.acquire(), true);
  await initializeEmbeddingWorker(store);
  await engine().tick();
  const resumed = await store.get<Checkpoint>(checkpointKey(generation));
  assert.equal(resumed?.kind, "market");
  assert.equal(resumed?.after, null);
  assert.equal(
    providerCalls.length,
    0,
    "completed page must not be billed twice",
  );
  assert.equal(await store.spent(generation), 0.4);
  await assert.rejects(
    () => store.reserve(generation, 0.7, 1),
    /budget_exhausted/,
  );
  assert.equal(await store.spent(generation), 0.4);
});
test("trim retains pending and unread stream entries", async () => {
  const first = await enqueueMarket();
  await redis.xReadGroup(
    GROUP,
    "dead-worker",
    { key: STREAM, id: ">" },
    { COUNT: 1 },
  );
  const last = await enqueueMarket();
  await store.prune();
  assert.equal((await redis.xRange(STREAM, first, first)).length, 1);
  assert.equal((await redis.xRange(STREAM, last, last)).length, 1);
  assert.equal(await pendingCount(), 1);
});
test("actual XAUTOCLAIM reclaims a dead consumer and records deleted PEL entry", async () => {
  await serve();
  const first = await enqueueMarket(),
    deleted = await enqueueMarket();
  await redis.xReadGroup(
    GROUP,
    "dead-worker",
    { key: STREAM, id: ">" },
    { COUNT: 2 },
  );
  await redis.sendCommand([
    "XCLAIM",
    STREAM,
    GROUP,
    "dead-worker",
    "0",
    first,
    deleted,
    "IDLE",
    "61000",
  ]);
  await redis.xDel(STREAM, deleted);
  await engine().tick();
  assert.equal(await pendingCount(), 0);
  assert.equal(await redis.get(`${CONTROL}lost-pending`), "1");
  assert.ok(Number(await redis.get(`${CONTROL}reconcile`)) >= 1);
  assert.equal(
    (await redis.xRange(STREAM, first, first)).length,
    1,
    "reclaim acknowledges without deleting payload",
  );
  assert.equal(providerCalls.length, 0);
});
test("in-flight canonical text changes never overwrite the previous vector hash", async () => {
  await serve();
  const key = embeddingKey(generation, "market", "market:a"),
    oldHash = await redis.hGet(key, "text_hash");
  await db.query("update unified_markets set title=$1 where id=$2", [
    "Above $110,000",
    "market:a",
  ]);
  await enqueueMarket();
  let changed = false;
  const changingProvider: Provider = async (options) => {
    if (!changed) {
      changed = true;
      await db.query("update unified_markets set title=$1 where id=$2", [
        "Above $120,000",
        "market:a",
      ]);
    }
    return provider(options);
  };
  await engine(changingProvider).tick();
  assert.equal(changed, true);
  assert.equal(await redis.hGet(key, "text_hash"), oldHash);
  assert.ok(Number(await redis.get(`${CONTROL}reconcile`)) > 0);
  assert.equal(
    await pendingCount(),
    0,
    "canonical reconciliation owns the skipped update",
  );
});
test("matching text hash without vector bytes is not a cache hit", async () => {
  await serve();
  const key = embeddingKey(generation, "market", "market:a");
  await redis.hDel(key, "embedding");
  await enqueueMarket();
  await engine().tick();
  assert.deepEqual(providerCalls, [generation.id]);
  assert.equal(
    Number(await redis.sendCommand(["HSTRLEN", key, "embedding"])),
    4096,
  );
  assert.equal(await pendingCount(), 0);
});
test("lifecycle change invalidates a ready generation before activation", async () => {
  await seedGeneration(legacy);
  await seedGeneration(generation);
  await store.put(`${CONTROL}generations`, [legacy, generation]);
  await store.put(checkpointKey(legacy), checkpoint());
  await store.put(
    checkpointKey(generation),
    checkpoint("ready", { eligibilityRevision: "polymarket" }),
  );
  await db.query(`insert into unified_events(id,venue,status,title) values ('event:limitless','limitless','ACTIVE','Newly eligible event');
    insert into unified_markets(id,event_id,venue,status,title) values ('market:limitless','event:limitless','limitless','ACTIVE','Newly eligible market');`);
  await setPolicy("venue_lifecycle", DEFAULT_VENUE_LIFECYCLE_POLICY);
  await engine().tick();
  assert.equal((await readActiveGeneration(redis)).id, legacy.id);
  const state = await store.get<Checkpoint>(checkpointKey(generation));
  assert.equal(state?.phase, "building");
  assert.equal(state?.eligibilityRevision, "limitless,polymarket");
  assert.equal(
    await redis.exists(embeddingKey(generation, "market", "market:limitless")),
    0,
  );
});
test("policy switch cannot activate old desired generation or create a third generation", async () => {
  await seedGeneration(legacy);
  await seedGeneration(generation);
  await store.put(`${CONTROL}generations`, [legacy, generation]);
  await store.put(checkpointKey(legacy), checkpoint());
  await store.put(checkpointKey(generation), checkpoint("ready"));
  await setPolicy("ai_embeddings", { model: qwen.model });
  await engine().tick();
  assert.equal((await readActiveGeneration(redis)).id, legacy.id);
  const registered = await store.get<EmbeddingGeneration[]>(
    `${CONTROL}generations`,
  );
  assert.deepEqual(
    registered?.map((selected) => selected.id),
    [legacy.id, generation.id],
  );
  assert.equal(await redis.exists(embeddingKey(qwen, "market", "market:a")), 0);
});
test("return to partially garbage-collected desired generation clears tombstone and stale checkpoint", async () => {
  await serve(qwen);
  await seedGeneration(generation);
  await setPolicy("ai_embeddings", { model: generation.model });
  await store.put(`${CONTROL}generations`, [qwen, generation]);
  await store.put(`${CONTROL}deleting:${generation.id}`, 1);
  await store.put(`${CONTROL}gc:${generation.id}`, {
    kind: "market",
    cursor: "0",
  });
  await store.put(checkpointKey(generation), checkpoint("ready"));
  await redis.sendCommand([
    "FT.DROPINDEX",
    embeddingIndex(generation, "event"),
  ]);
  await redis.del(embeddingKey(generation, "event", "event:a"));
  await engine().tick();
  assert.equal(await redis.get(`${CONTROL}deleting:${generation.id}`), null);
  assert.equal(await redis.get(`${CONTROL}gc:${generation.id}`), null);
  assert.equal((await readActiveGeneration(redis)).id, qwen.id);
  assert.equal(
    (await store.get<Checkpoint>(checkpointKey(generation)))?.phase,
    "building",
  );
  await pinGeneration(redis, generation, "fixture:gc-restarted", 60);
  assert.equal(await redis.zCard(`${CONTROL}pins:${generation.id}`), 1);
  assert.ok(
    await redis.sendCommand(["FT.INFO", embeddingIndex(generation, "event")]),
  );
});
test("serving legacy TTLs renew while provider circuit is open", async () => {
  await serve(legacy);
  await store.put(`${CONTROL}circuit`, Date.now() + 300000);
  for (const kind of ["event", "market"] as const)
    await redis.expire(embeddingKey(legacy, kind, `${kind}:a`), 10);
  const worker = engine();
  for (let count = 0; count < 3; count++) await worker.tick();
  for (const kind of ["event", "market"] as const)
    assert.ok(
      (await redis.ttl(embeddingKey(legacy, kind, `${kind}:a`))) > 170000,
    );
  assert.equal(providerCalls.length, 0);
  assert.equal((await readActiveGeneration(redis)).id, legacy.id);
});
test("serving TTLs renew while desired generation budget is exhausted", async () => {
  await serve(legacy);
  for (const kind of ["event", "market"] as const)
    await store.ensureIndex(generation, kind);
  await store.put(`${CONTROL}generations`, [legacy, generation]);
  await store.put(
    checkpointKey(generation),
    checkpoint("building", { kind: "market" }),
  );
  await store.reserve(generation, 5, 5);
  for (const kind of ["event", "market"] as const)
    await redis.expire(embeddingKey(legacy, kind, `${kind}:a`), 10);
  const worker = engine();
  for (let count = 0; count < 3; count++) await worker.tick();
  for (const kind of ["event", "market"] as const)
    assert.ok(
      (await redis.ttl(embeddingKey(legacy, kind, `${kind}:a`))) > 170000,
    );
  assert.equal(await store.spent(generation), 5);
  assert.equal(providerCalls.length, 0);
  assert.equal((await readActiveGeneration(redis)).id, legacy.id);
});
test("retired pins retain canonical ACTIVE vectors but never extend CLOSED seed allowance", async () => {
  await serve(qwen);
  await seedGeneration(generation);
  await store.put(`${CONTROL}generations`, [qwen, generation]);
  await store.put(
    `${CONTROL}retired:${generation.id}`,
    Date.now() - 60 * 3600000,
  );
  await pinGeneration(
    redis,
    generation,
    "fixture:seven-day-snapshot",
    7 * 86400,
  );
  const source = (
      await loadEmbeddingSources(db, "market", ["market:a"], ["polymarket"])
    )[0],
    closed = { ...source, id: "market:closed" };
  await store.commit(
    generation,
    closed,
    embeddingTextHash(buildEmbeddingText(closed, generation)),
    vector,
  );
  await store.commit(
    generation,
    { ...closed, status: "CLOSED", eligible: false },
    "",
  );
  const closedKey = embeddingKey(generation, "market", "market:closed");
  await redis.expire(closedKey, 90);
  for (const kind of ["event", "market"] as const)
    await redis.expire(embeddingKey(generation, kind, `${kind}:a`), 10);
  const worker = engine();
  for (let count = 0; count < 2; count++) await worker.tick();
  for (const kind of ["event", "market"] as const)
    assert.ok(
      (await redis.ttl(embeddingKey(generation, kind, `${kind}:a`))) >=
        7 * 86400,
    );
  assert.ok(
    (await redis.ttl(closedKey)) > 0 && (await redis.ttl(closedKey)) <= 90,
  );
  assert.equal(await redis.hGet(closedKey, "status"), "CLOSED");
  assert.equal(await redis.get(`${CONTROL}deleting:${generation.id}`), null);
});
test("in-flight legacy pin never blocks quiet periodic reconciliation of serving E5", async () => {
  await serve(generation);
  await seedGeneration(legacy);
  await store.put(`${CONTROL}generations`, [legacy, generation]);
  const activeKey = embeddingKey(generation, "market", "market:a");
  const legacyKey = embeddingKey(legacy, "market", "market:a");
  for (const protection of ["pin", "renewed-pin"] as const) {
    await store.put(`${CONTROL}retired:${legacy.id}`, Date.now());
    await pinGeneration(redis, legacy, "fixture:running-job", 300);
    await redis.del(activeKey);
    await store.put(
      checkpointKey(generation),
      checkpoint("active", { startedAt: Date.now() - 7 * 3600000 }),
    );
    assert.equal(await redis.xLen(STREAM), 0);
    const callsBefore = providerCalls.length;
    const worker = engine();
    for (let count = 0; count < 15; count++) {
      await worker.tick();
      if (await redis.exists(activeKey)) break;
    }
    assert.equal(
      await redis.exists(activeKey),
      1,
      `${protection}: quiet repair`,
    );
    assert.equal(providerCalls.length, callsBefore + 1);
    assert.equal(providerCalls.at(-1), generation.id);
    assert.equal((await readActiveGeneration(redis)).id, generation.id);
    assert.equal(await redis.exists(legacyKey), 1);
    assert.equal(await redis.get(`${CONTROL}deleting:${legacy.id}`), null);
    assert.equal(await redis.get(`${CONTROL}deleted:${legacy.id}`), null);
    assert.ok(
      await redis.sendCommand(["FT.INFO", embeddingIndex(legacy, "market")]),
    );
    assert.equal(
      (await store.get<EmbeddingGeneration[]>(`${CONTROL}generations`))?.length,
      2,
    );
    assert.equal(await pendingCount(), 0);
  }
});

test("retry reservations stop before overspend and persist across a real worker restart", async () => {
  await serve(legacy);
  for (const kind of ["event", "market"] as const)
    await store.ensureIndex(generation, kind);
  await store.put(`${CONTROL}generations`, [legacy, generation]);
  await store.put(checkpointKey(generation), checkpoint("building"));
  await setPolicy("ai_embeddings", {
    model: generation.model,
    generationBudgetUsd: 0.5,
  });
  let attempted = 0;
  let admitted = 0;
  const retryingProvider: Provider = async (options) => {
    for (let attempt = 1; attempt <= 4; attempt++) {
      attempted++;
      await options.beforeAttempt?.({ attempt, estimatedCostUsd: 0.2 });
      admitted++;
    }
    throw new Error("fixture expected budget to veto the third attempt");
  };
  await engine(retryingProvider).tick();
  assert.equal(attempted, 3);
  assert.equal(admitted, 2);
  assert.equal(await store.spent(generation), 0.4);
  assert.equal(
    (await store.get<Checkpoint>(checkpointKey(generation)))?.after,
    null,
  );
  await store.release();
  store = new EmbeddingStore(redis);
  assert.equal(await store.acquire(), true);
  await initializeEmbeddingWorker(store);
  await engine(retryingProvider).tick();
  assert.equal(attempted, 4, "restart retries admission, not paid work");
  assert.equal(admitted, 2);
  assert.equal(await store.spent(generation), 0.4);
  assert.equal((await readActiveGeneration(redis)).id, legacy.id);
});
test("Qwen actual cost above its reservation persists a fail-stop before vector publication", async () => {
  await serve(legacy);
  for (const kind of ["event", "market"] as const)
    await store.ensureIndex(qwen, kind);
  await setPolicy("ai_embeddings", { model: qwen.model });
  await store.put(`${CONTROL}generations`, [legacy, qwen]);
  await store.put(checkpointKey(qwen), checkpoint("building"));
  let calls = 0;
  let estimated = 0;
  const overchargingProvider: Provider = async (options) => {
    assert.equal(options.generation.id, qwen.id);
    estimated = estimateEmbeddingCostUsd(options.texts, options.generation);
    await options.beforeAttempt?.({ attempt: 1, estimatedCostUsd: estimated });
    calls++;
    return {
      embeddings: options.texts.map(() => [...vector]),
      usage: { inputTokens: 10, costUsd: estimated * 2 },
      attempts: 1,
    };
  };
  await engine(overchargingProvider).tick();
  assert.equal(calls, 1);
  assert.ok(estimated > 0);
  const drift = await store.get<{ charged: number; reserved: number }>(
    `${CONTROL}cost-drift:${qwen.id}`,
  );
  assert.equal(drift?.reserved, estimated);
  assert.equal(drift?.charged, estimated * 2);
  assert.ok(Math.abs((await store.spent(qwen)) - estimated * 2) < 2e-9);
  assert.equal(
    await redis.hGet(embeddingKey(qwen, "event", "event:a"), "embedding"),
    null,
  );
  assert.equal((await readActiveGeneration(redis)).id, legacy.id);
  assert.equal((await store.get<Checkpoint>(checkpointKey(qwen)))?.after, null);
  // A replacement process must also observe the durable breaker before inference.
  await engine(overchargingProvider).tick();
  assert.equal(calls, 1);
  assert.equal((await readActiveGeneration(redis)).id, legacy.id);
});

test("stale ready verification restarts before activating a generation with expired vectors", async () => {
  await seedGeneration(legacy);
  await seedGeneration(generation);
  await store.put(`${CONTROL}generations`, [legacy, generation]);
  await store.put(checkpointKey(legacy), checkpoint());
  await store.put(
    checkpointKey(generation),
    checkpoint("ready", {
      verifiedAt: new Date(Date.now() - 3 * 86400000).toISOString(),
    }),
  );
  await redis.del(embeddingKey(generation, "market", "market:a"));
  await engine().tick();
  assert.equal((await readActiveGeneration(redis)).id, legacy.id);
  assert.equal(
    (await store.get<Checkpoint>(checkpointKey(generation)))?.phase,
    "building",
  );
  assert.equal(
    providerCalls.length,
    0,
    "first resume step restarts verification without stale activation",
  );
});
test("actual producer Lua caps the queue and marks overflow without deleting unread entries", async () => {
  await enqueueEmbedItems(redis, [
    {
      entity_type: "market",
      market_id: "market:a",
      market_title: "Only the ID belongs in Redis",
      description: "Queued source text must not be retained",
    },
  ]);
  const compact = (await redis.xRange(STREAM, "-", "+", { COUNT: 1 }))[0];
  assert.deepEqual(
    { ...compact.message },
    { entity_type: "market", entity_id: "market:a" },
  );
  const length = await redis.sendCommand([
    "EVAL",
    "for i=1,tonumber(ARGV[1]) do redis.call('XADD',KEYS[1],'*','entity_type','market','entity_id','market:a') end return redis.call('XLEN',KEYS[1])",
    "1",
    STREAM,
    "199999",
  ]);
  assert.equal(Number(length), 200000);
  const first = (await redis.xRange(STREAM, "-", "+", { COUNT: 1 }))[0].id;
  const last = (await redis.xRevRange(STREAM, "+", "-", { COUNT: 1 }))[0].id;
  await enqueueEmbedItems(redis, [
    {
      entity_type: "market",
      market_id: "market:overflow-one",
      market_title: "Must not enter the queue",
    },
    {
      entity_type: "event",
      event_id: "event:overflow-two",
      description: "Must not enter the queue",
    },
  ]);
  await store.prune();
  assert.equal(await redis.xLen(STREAM), 200000);
  assert.equal(await redis.get(`${CONTROL}reconcile`), "2");
  assert.equal((await redis.xRange(STREAM, first, first)).length, 1);
  assert.equal(
    (await redis.xRevRange(STREAM, "+", "-", { COUNT: 1 }))[0].id,
    last,
  );
  assert.equal(await pendingCount(), 0);
});
test("trim respects both unread and pending floors of a second consumer group", async () => {
  await redis.sendCommand([
    "EVAL",
    "for i=1,300 do redis.call('XADD',KEYS[1],'*','entity_type','market','entity_id','market:a') end return 1",
    "1",
    STREAM,
  ]);
  await redis.xGroupCreate(STREAM, "fixture-slow-group", "0");
  const ids = (await redis.xRange(STREAM, "-", "+", { COUNT: 300 })).map(
    (message) => message.id,
  );
  await redis.xReadGroup(
    GROUP,
    "fixture-fast",
    { key: STREAM, id: ">" },
    { COUNT: 300 },
  );
  await store.ack(ids);
  await store.prune();
  assert.equal(
    await redis.xLen(STREAM),
    300,
    "the slow group's unread floor is zero",
  );
  await redis.xReadGroup(
    "fixture-slow-group",
    "fixture-slow",
    { key: STREAM, id: ">" },
    { COUNT: 1 },
  );
  await store.prune();
  assert.equal(
    await redis.xLen(STREAM),
    300,
    "the oldest pending entry belongs to the other group",
  );
  assert.equal((await redis.xRange(STREAM, ids[0], ids[0])).length, 1);
  const lastId = ids.at(-1);
  assert.ok(lastId);
  assert.equal((await redis.xRange(STREAM, lastId, lastId)).length, 1);
});
test("real pin Lua rejects both in-progress GC and completed deletion tombstones", async () => {
  await seedGeneration(generation);
  await store.put(`${CONTROL}deleting:${generation.id}`, 1);
  await assert.rejects(
    () => pinGeneration(redis, generation, "fixture:too-late", 60),
    /no longer available/,
  );
  assert.equal(await redis.zCard(`${CONTROL}pins:${generation.id}`), 0);
  await redis.del(`${CONTROL}deleting:${generation.id}`);
  await store.put(`${CONTROL}deleted:${generation.id}`, Date.now());
  await assert.rejects(
    () => pinGeneration(redis, generation, "fixture:deleted", 60),
    /no longer available/,
  );
  assert.equal(await redis.zCard(`${CONTROL}pins:${generation.id}`), 0);
});
test("retired generation is collected immediately despite published old map and snapshot pins", async () => {
  await serve(qwen);
  await seedGeneration(legacy);
  await setPolicy("ai_embeddings", { model: qwen.model });
  await store.put(`${CONTROL}generations`, [legacy, qwen]);
  await store.put(`${CONTROL}retired:${legacy.id}`, Date.now());
  await redis.set("ai:market_map:v1:active", "fixture-old-map");
  const metaKey = "ai:market_map:v1:run:fixture-old-map:meta";
  await redis.set(metaKey, JSON.stringify({ runId: "fixture-old-map" }), {
    EX: 86400,
  });
  await pinGeneration(redis, legacy, "map:fixture-old-map", 86400);
  await redis.set("fixture:unrelated", "keep");
  const worker = engine();
  for (let count = 0; count < 15; count++) {
    await worker.tick();
    if (await redis.get(`${CONTROL}deleted:${legacy.id}`)) break;
  }
  assert.ok(await redis.get(`${CONTROL}deleted:${legacy.id}`));
  assert.equal(
    await redis.exists(embeddingKey(legacy, "market", "market:a")),
    0,
  );
  assert.equal(await redis.exists(embeddingKey(qwen, "market", "market:a")), 1);
  assert.equal(await redis.zCard(`${CONTROL}pins:${legacy.id}`), 0);
  assert.ok(
    await redis.get(metaKey),
    "static map is not deleted with its vectors",
  );
  assert.equal(await redis.get("fixture:unrelated"), "keep");
  assert.equal((await readActiveGeneration(redis)).id, qwen.id);
});
test("atomic active admission, in-flight renewal and release protect jobs without snapshot retention", async () => {
  await serve(legacy);
  const pin = await acquireEmbeddingGenerationPin(
    redis,
    legacy,
    "map-search:fixture:unique",
    1,
  );
  assert.ok(pin);
  try {
    await seedGeneration(qwen);
    await store.put(`${CONTROL}active`, qwen);
    await store.put(`${CONTROL}generations`, [legacy, qwen]);
    await store.put(checkpointKey(qwen), checkpoint());
    await setPolicy("ai_embeddings", { model: qwen.model });
    await pinGeneration(redis, legacy, "map:old-static-snapshot", 86400);
    assert.equal(
      await acquireEmbeddingGenerationPin(
        redis,
        legacy,
        "map-search:new-stale-job",
      ),
      null,
    );
    const worker = engine();
    await worker.tick();
    assert.equal(
      await redis.zCard(`${CONTROL}pins:${legacy.id}`),
      1,
      "only the running job remains pinned",
    );
    await new Promise((resolve) => setTimeout(resolve, 1100));
    pin.assertHeld();
    assert.equal(await redis.get(`${CONTROL}deleting:${legacy.id}`), null);
    assert.equal(
      await redis.exists(embeddingKey(legacy, "market", "market:a")),
      1,
    );
    await pin.release();
    for (let count = 0; count < 15; count++) {
      await worker.tick();
      if (await redis.get(`${CONTROL}deleted:${legacy.id}`)) break;
    }
    assert.ok(await redis.get(`${CONTROL}deleted:${legacy.id}`));
    assert.equal(await redis.zCard(`${CONTROL}pins:${legacy.id}`), 0);
  } finally {
    await pin.release();
  }
});
test("expiry cleanup cannot erase a concurrently renewed shared request pin", async () => {
  await serve(qwen);
  await seedGeneration(legacy);
  await store.put(`${CONTROL}generations`, [legacy, qwen]);
  await setPolicy("ai_embeddings", { model: qwen.model });
  const pinsKey = `${CONTROL}pins:${legacy.id}`;
  const owner = "similar-market:market:a";
  await redis.zAdd(pinsKey, [
    { score: Date.now() - 1000, value: owner },
    { score: Date.now() - 1000, value: "fixture:expired-job" },
  ]);
  const fenced = store.fenced.bind(store);
  let renewed = false;
  store.fenced = async (script, keys = [], args = []) => {
    if (
      !renewed &&
      keys.includes(pinsKey) &&
      (script.includes("ZRANGEBYSCORE") ||
        (script.includes("ZREM") && args.includes(owner)))
    ) {
      renewed = true;
      await pinGeneration(redis, legacy, owner, 300);
    }
    return fenced(script, keys, args);
  };
  try {
    await engine().tick();
    assert.equal(renewed, true);
    assert.ok(Number(await redis.zScore(pinsKey, owner)) > Date.now());
    assert.equal(await redis.zScore(pinsKey, "fixture:expired-job"), null);
    assert.equal(await redis.get(`${CONTROL}deleting:${legacy.id}`), null);
    assert.equal(
      await redis.exists(embeddingKey(legacy, "market", "market:a")),
      1,
    );
  } finally {
    store.fenced = fenced;
  }
});
test("provider circuit does not postpone unused generation cleanup", async () => {
  await serve(qwen);
  await seedGeneration(legacy);
  await store.put(`${CONTROL}generations`, [legacy, qwen]);
  await store.put(`${CONTROL}circuit`, Date.now() + 300000);
  await setPolicy("ai_embeddings", { model: qwen.model });
  const worker = engine();
  for (let count = 0; count < 15; count++) {
    await worker.tick();
    if (await redis.get(`${CONTROL}deleted:${legacy.id}`)) break;
  }
  assert.ok(await redis.get(`${CONTROL}deleted:${legacy.id}`));
  assert.equal((await readActiveGeneration(redis)).id, qwen.id);
  assert.equal(providerCalls.length, 0);
});
test("real worker flows legacy to E5 to Qwen and safely rolls back to retained E5", async () => {
  await seedGeneration(legacy);
  const first = engine();
  for (let count = 0; count < 30; count++) {
    await first.tick();
    if ((await readActiveGeneration(redis)).id === generation.id) break;
  }
  assert.equal((await readActiveGeneration(redis)).id, generation.id);
  // A third vector space waits only for bounded GC, with no wall-clock grace.
  await setPolicy("ai_embeddings", { model: qwen.model });
  const second = engine();
  for (let count = 0; count < 35; count++) {
    await second.tick();
    if ((await readActiveGeneration(redis)).id === qwen.id) break;
  }
  assert.equal((await readActiveGeneration(redis)).id, qwen.id);
  assert.ok(await redis.get(`${CONTROL}deleted:${legacy.id}`));
  assert.equal(
    await redis.hGet(
      embeddingKey(qwen, "market", "market:a"),
      "embedding_version",
    ),
    qwen.id,
  );
  const callsBeforeRollback = providerCalls.length;
  await setPolicy("ai_embeddings", { model: generation.model });
  const rollback = engine();
  for (let count = 0; count < 20; count++) {
    await rollback.tick();
    if ((await readActiveGeneration(redis)).id === generation.id) break;
  }
  assert.equal((await readActiveGeneration(redis)).id, generation.id);
  assert.equal(
    providerCalls.length,
    callsBeforeRollback,
    "retained E5 must reverify without repayment",
  );
  assert.equal(
    (await store.get<EmbeddingGeneration[]>(`${CONTROL}generations`))?.length,
    2,
  );
  await pinGeneration(redis, generation, "fixture:rolled-back-map", 60);
});
test("DLQ uses compact diagnostics and keeps pre-retention report", async () => {
  await store.dead("market", "market:a", generation.id, "test_error", 4);
  await store.prune();
  const entries = await redis.xRevRange(DLQ, "+", "-", { COUNT: 1 });
  assert.equal(entries[0].message.error, "test_error");
  assert.equal(entries[0].message.payload, undefined);
  assert.ok(await redis.get(`${CONTROL}dlq-before-retention`));
});

test("new DLQ diagnostics trim at most 1000 historical entries and prune gradually", async () => {
  // Keep fixture creation bounded too: twenty calls of one thousand small rows.
  for (let batch = 0; batch < 20; batch++) {
    await redis.eval(
      "for i=1,1000 do redis.call('XADD',KEYS[1],'*','error','historical_test_error') end return redis.call('XLEN',KEYS[1])",
      { keys: [DLQ], arguments: [] },
    );
  }
  assert.equal(await redis.xLen(DLQ), 20000);
  const errorCode = "bounded_test_error_".repeat(30);
  await store.dead("market", "market:a", generation.id, errorCode, 4);
  let length = await redis.xLen(DLQ);
  assert.ok(length >= 19001, "XADD must not discard more than 1000 rows");
  assert.ok(length < 20001, "XADD should begin gradual retention");
  const latest = (await redis.xRevRange(DLQ, "+", "-", { COUNT: 1 }))[0];
  assert.deepEqual(
    { ...latest.message },
    {
      entity_type: "market",
      entity_id: "market:a",
      generation: generation.id,
      error: errorCode.slice(0, 200),
      attempts: "4",
    },
  );
  const beforePrune = length;
  for (let pass = 0; pass < 15 && length > 10100; pass++) {
    await store.prune();
    const next = await redis.xLen(DLQ);
    // All fixture entries are recent, so only the length retention can apply.
    assert.ok(next < length, "each bounded prune should make progress");
    assert.ok(length - next <= 1000, "prune must honor its per-command cap");
    length = next;
  }
  assert.ok(
    length <= 10100,
    "repeated bounded prunes reach the approximate cap",
  );
  assert.equal((await redis.xRange(DLQ, latest.id, latest.id)).length, 1);
  const snapshot = await store.get<{ length: number }>(
    `${CONTROL}dlq-before-retention`,
  );
  assert.equal(snapshot?.length, beforePrune);
});

test("invalid canonical title is quarantined without starving healthy work or passing coverage", async () => {
  await seedGeneration(legacy);
  await seedGeneration(generation);
  await store.put(`${CONTROL}generations`, [legacy, generation]);
  await store.put(checkpointKey(legacy), checkpoint());
  await store.put(
    checkpointKey(generation),
    checkpoint("verifying", {
      coverage: {
        events: { eligible: 1, verified: 0, missing: 0 },
        markets: { eligible: 1, verified: 0, missing: 0 },
      },
    }),
  );
  await db.query(
    "update unified_events set title=' <script>not meaningful</script> ' where id='event:a'",
  );
  await db.query(
    "update unified_markets set title='A revised valid market title' where id='market:a'",
  );
  await redis.xAdd(STREAM, "*", {
    entity_type: "event",
    entity_id: "event:a",
  });
  await enqueueMarket();
  const worker = engine();
  await worker.tick();
  assert.deepEqual(providerCalls.sort(), [legacy.id, generation.id].sort());
  assert.equal(await pendingCount(), 0);
  const state = await store.get<Checkpoint>(checkpointKey(generation));
  assert.equal(state?.phase, "verifying");
  assert.equal(
    (state?.coverage as { events: { missing: number } }).events.missing,
    1,
  );
  for (const selected of [legacy, generation]) {
    const failure = await store.get<{ code: string }>(
      `${CONTROL}failure:${selected.id}:event:event:a`,
    );
    assert.equal(failure?.code, "invalid_source_title");
    const source = (
      await loadEmbeddingSources(db, "market", ["market:a"], ["polymarket"])
    )[0];
    assert.equal(
      await redis.hGet(
        embeddingKey(selected, "market", "market:a"),
        "text_hash",
      ),
      embeddingTextHash(buildEmbeddingText(source, selected)),
    );
  }
  const failures = await redis.xRange(DLQ, "-", "+");
  assert.equal(failures.length, 2);
  assert.ok(
    failures.every(
      (entry) =>
        entry.message.error === "invalid_source_title" &&
        entry.message.payload === undefined &&
        !JSON.stringify(entry.message).includes("not meaningful"),
    ),
  );
  assert.ok(await redis.get(`${CONTROL}maintenance:${legacy.id}`));
  for (let count = 0; count < 4; count++) await worker.tick();
  assert.equal((await readActiveGeneration(redis)).id, legacy.id);
  assert.equal(await redis.xLen(DLQ), 2, "one diagnostic per content revision");
});

test("auto-activation disabled during KNN admission is honored before publication", async () => {
  await seedGeneration(legacy);
  await seedGeneration(generation);
  await store.put(`${CONTROL}generations`, [legacy, generation]);
  await store.put(checkpointKey(legacy), checkpoint());
  await store.put(checkpointKey(generation), checkpoint("ready"));
  const fenced = store.fenced.bind(store);
  let probes = 0;
  store.fenced = async (script, keys, args) => {
    const result = await fenced(script, keys, args);
    if (script.includes("FT.SEARCH")) {
      probes++;
      await setPolicy("ai_embeddings", {
        model: generation.model,
        autoActivate: false,
      });
    }
    return result;
  };
  try {
    await engine().tick();
  } finally {
    store.fenced = fenced;
  }
  assert.equal(probes, 2, "both real KNN probes completed");
  assert.equal((await readActiveGeneration(redis)).id, legacy.id);
  assert.equal(
    (await store.get<Checkpoint>(checkpointKey(generation)))?.phase,
    "ready",
  );
  assert.equal(await redis.get(`${CONTROL}retired:${legacy.id}`), null);
  await setPolicy("ai_embeddings", {
    model: generation.model,
    autoActivate: true,
  });
  await engine().tick();
  assert.equal((await readActiveGeneration(redis)).id, generation.id);
});

test("reconciliation change racing the final swap is atomically rejected", async () => {
  await seedGeneration(legacy);
  await seedGeneration(generation);
  await store.put(`${CONTROL}generations`, [legacy, generation]);
  await store.put(checkpointKey(legacy), checkpoint());
  await store.put(checkpointKey(generation), checkpoint("ready"));
  const activate = store.activate.bind(store);
  let attempted = false;
  store.activate = async (active, desired, expectedReconcile) => {
    attempted = true;
    assert.equal(expectedReconcile, "0");
    await redis.incr(`${CONTROL}reconcile`);
    return activate(active, desired, expectedReconcile);
  };
  try {
    await engine().tick();
  } finally {
    store.activate = activate;
  }
  assert.equal(attempted, true);
  assert.equal((await readActiveGeneration(redis)).id, legacy.id);
  assert.equal(await redis.get(`${CONTROL}retired:${legacy.id}`), null);
  assert.equal(
    (await store.get<Checkpoint>(checkpointKey(generation)))?.phase,
    "ready",
  );
  await engine().tick();
  assert.equal((await readActiveGeneration(redis)).id, legacy.id);
  assert.equal(
    (await store.get<Checkpoint>(checkpointKey(generation)))?.phase,
    "building",
  );
});
