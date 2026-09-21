import assert from "node:assert/strict";
import { mock } from "node:test";
import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import {
  EMBEDDING_ACTIVE_KEY,
  LEGACY_EMBEDDING_GENERATION,
  embeddingCachePrefix,
  embeddingIndex,
  embeddingKey,
  embeddingPolicySchema,
  embeddingVectorBuffer,
  generationForPolicy,
  type EmbeddingGeneration,
} from "@hunch/embeddings";

// Run with node --experimental-test-module-mocks --import tsx. Real HTTP
// handlers and serializers; all infrastructure is replaced before route import.
Object.assign(process.env, {
  HUNCH_RUNTIME_SECRETS_LOADED: "1",
  DATABASE_URL: "postgres://test:test@127.0.0.1:1/embedding_routes_test",
  JWT_SECRET: "embedding-routes-test",
  PRIVY_APP_ID: "embedding-routes-test",
  PRIVY_APP_SECRET: "embedding-routes-test",
  API_SIMILAR_CACHE_TTL_SEC: "300",
});
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
  throw new Error("Network forbidden in route fixtures");
};
const e5 = generationForPolicy(
  embeddingPolicySchema.parse({ model: "intfloat/e5-large-v2" }),
);
const qwen = generationForPolicy(
  embeddingPolicySchema.parse({ model: "qwen/qwen3-embedding-8b" }),
);
let captured: EmbeddingGeneration = e5;
let active: EmbeddingGeneration = e5;
let missing = false;
let switchOnSeed = true;
let refuseAdmission = false;
let failRenewal = false;
let cacheHit = false;
let failure: "seed" | "search" | "cache" | null = null;
let beforeSeed: ((key: string) => Promise<void>) | undefined;
let beforeSearch: (() => Promise<void>) | undefined;
let interactionCount = 1;
const reads: string[] = [];
const searches: string[] = [];
const cacheWrites: string[] = [];
const owners: string[] = [];
const releases: string[] = [];
const held = new Set<string>();
let activeReads = 0;
let pins = 0;
let renewals = 0;
const vector = embeddingVectorBuffer([1, ...Array<number>(1023).fill(0)], e5);
async function seed(key: string): Promise<Buffer | null> {
  reads.push(key);
  // Activate another model between reading the seed and KNN.
  if (switchOnSeed) active = qwen;
  assert.ok(
    key.startsWith(
      embeddingKey(captured, key.includes(":market:") ? "market" : "event", ""),
    ),
  );
  await beforeSeed?.(key);
  if (failure === "seed") throw new Error("fixture_seed_failure");
  return missing ? null : vector;
}
const fakeRedis = {
  withTypeMapping() {
    return this;
  },
  async get(key: string) {
    if (key === EMBEDDING_ACTIVE_KEY) {
      activeReads += 1;
      return JSON.stringify(active);
    }
    assert.ok(key.startsWith(embeddingCachePrefix(captured)), key);
    if (failure === "cache") throw new Error("fixture_cache_failure");
    return cacheHit ? "[]" : null;
  },
  async hGet(key: string) {
    return seed(key);
  },
  async hmGet(key: string, fields: string[]) {
    const value = await seed(key);
    return fields.map((field) =>
      field === "embedding"
        ? value
        : Buffer.from(field === "text_hash" ? "text-hash" : captured.id),
    );
  },
  async set(key: string) {
    cacheWrites.push(key);
    return "OK";
  },
  async sendCommand(args: unknown[]) {
    if (args[0] === "EVAL") {
      const owner = String(args[8]);
      if (args[9] === "1") {
        pins += 1;
        if (refuseAdmission || args[10] !== active.id) return 0;
        assert.ok(!held.has(owner), "Requests must not share pin owners");
        owners.push(owner);
        held.add(owner);
      } else {
        renewals += 1;
        assert.ok(held.has(owner));
        if (failRenewal) throw new Error("fixture_renewal_failure");
      }
      return 1;
    }
    if (args[0] === "ZREM") {
      const owner = String(args[2]);
      assert.ok(
        held.delete(owner),
        "Each acquired pin must release exactly once",
      );
      releases.push(owner);
      return 1;
    }
    assert.equal(args[0], "FT.SEARCH");
    const index = String(args[1]);
    assert.ok(
      [
        embeddingIndex(captured, "market"),
        embeddingIndex(captured, "event"),
      ].includes(index),
      index,
    );
    searches.push(index);
    await beforeSearch?.();
    if (failure === "search") throw new Error("fixture_search_failure");
    return [0];
  },
};
const dbModule = await import("./db.js");
dbModule.pool.query = (async (query: string | { text: string }) => {
  const text = typeof query === "string" ? query : query.text;
  return {
    rows: text.includes("with interactions as")
      ? Array.from({ length: interactionCount }, (_, index) => ({
          market_id: "polymarket:seed",
          event_id: index ? `polymarket:event-${index}` : "polymarket:event",
          ts: new Date(),
          weight: 3,
          market_status: "ACTIVE",
          event_status: "ACTIVE",
          end_date: null,
        }))
      : [],
  };
}) as typeof dbModule.pool.query;
const redisModule = await import("./redis.js");
const lifecycleModule = await import("./services/venue-lifecycle.js");
const authModule = await import("./auth.js");
mock.module(new URL("./redis.ts", import.meta.url).href, {
  namedExports: {
    ...redisModule,
    getRedis: async () => fakeRedis,
  },
});
mock.module(new URL("./services/venue-lifecycle.ts", import.meta.url).href, {
  namedExports: {
    ...lifecycleModule,
    filterVenuesForLifecycleCapability: async () => ({
      venues: ["polymarket"],
      revision: "fixture",
    }),
  },
});
mock.module(new URL("./auth.ts", import.meta.url).href, {
  namedExports: {
    ...authModule,
    createAuthMiddleware: () => async (request: { user?: unknown }) => {
      request.user = { id: "embedding-user" };
    },
  },
});
const { marketRoutes } = await import("./routes/markets.js");
const { eventRoutes } = await import("./routes/events.js");
const { feedRoutes } = await import("./routes/feed.js");
const app = Fastify();
app.setValidatorCompiler(validatorCompiler);
app.setSerializerCompiler(serializerCompiler);
await app.register(marketRoutes);
await app.register(eventRoutes);
await app.register(feedRoutes);
await app.ready();
const urls = [
  "/markets/polymarket:seed/similar",
  "/events/polymarket:event/similar",
  "/feed/for-you",
  "/feed/for-you/status",
];
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
async function waitFor(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i += 1) await flush();
  assert.ok(check(), "Fixture did not reach the expected pending operation");
}
function reset(generation: EmbeddingGeneration = e5) {
  assert.equal(held.size, 0, "The previous request leaked a pin");
  captured = active = generation;
  missing = refuseAdmission = failRenewal = cacheHit = false;
  switchOnSeed = true;
  failure = null;
  beforeSeed = beforeSearch = undefined;
  interactionCount = 1;
  reads.length =
    searches.length =
    cacheWrites.length =
    owners.length =
    releases.length =
      0;
  activeReads = pins = renewals = 0;
}
function assertReleased() {
  assert.equal(held.size, 0);
  assert.deepEqual(releases.slice().sort(), owners.slice().sort());
}
try {
  for (const generation of [LEGACY_EMBEDDING_GENERATION, e5]) {
    for (const url of urls) {
      for (const absent of [false, true]) {
        reset(generation);
        missing = absent;
        const response = await app.inject({ method: "GET", url });
        await flush();
        assert.equal(response.statusCode, 200, `${url}: ${response.body}`);
        assert.equal(activeReads, 1, `${url} must capture generation once`);
        assert.equal(pins, 1, `${url} must pin captured generation`);
        assert.equal(owners.length, 1);
        assertReleased();
        assert.ok(reads.length > 0, url);
        if (url.endsWith("/status")) {
          assert.equal(response.json().embeddedEventCount, absent ? 0 : 1);
        } else if (absent) {
          assert.equal(
            searches.length,
            0,
            "Missing seed must not fall back to the newly active generation",
          );
        } else {
          assert.ok(searches.length > 0, `${url}: ${response.body}`);
          for (const key of cacheWrites)
            assert.ok(key.startsWith(embeddingCachePrefix(generation)), key);
          if (url.endsWith("/similar")) assert.equal(cacheWrites.length, 1);
        }
      }
    }
  }
  for (const url of urls) {
    reset();
    refuseAdmission = true;
    const refused = await app.inject({ method: "GET", url });
    await flush();
    assert.equal(refused.statusCode, 200, refused.body);
    assert.equal(activeReads, 1);
    assert.equal(pins, 1);
    assert.equal(owners.length, 0);
    assert.equal(reads.length + searches.length, 0);
    assertReleased();
    if (url.endsWith("/status"))
      assert.equal(refused.json().embeddedEventCount, 0);
    else assert.equal((refused.json().items ?? refused.json().data).length, 0);

    for (const phase of ["seed", "search", "cache"] as const) {
      if (phase === "search" && url.endsWith("/status")) continue;
      if (phase === "cache" && !url.endsWith("/similar")) continue;
      reset();
      failure = phase;
      const response = await app.inject({ method: "GET", url });
      await flush();
      assert.equal(owners.length, 1);
      assertReleased();
      if (phase === "search" && url.endsWith("/similar")) {
        assert.equal(response.statusCode, 200);
        assert.equal(response.json().cache_status, "error");
      } else {
        assert.equal(response.statusCode, 500, `${url}: ${response.body}`);
      }
    }

    if (url.endsWith("/similar")) {
      reset();
      cacheHit = true;
      const response = await app.inject({ method: "GET", url });
      await flush();
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().cache_source, "cache");
      assert.equal(searches.length, 0);
      assertReleased();
    }

    reset();
    switchOnSeed = false;
    const unblock: Array<() => void> = [];
    beforeSeed = () => new Promise<void>((resolve) => unblock.push(resolve));
    const first = app.inject({ method: "GET", url });
    const second = app.inject({ method: "GET", url });
    await waitFor(() => unblock.length === 2);
    assert.equal(
      held.size,
      2,
      `${url} must protect both simultaneous requests`,
    );
    assert.equal(new Set(owners).size, 2);
    unblock[0]();
    assert.equal((await first).statusCode, 200);
    await flush();
    assert.equal(held.size, 1, "One request must not release the other's pin");
    unblock[1]();
    assert.equal((await second).statusCode, 200);
    await flush();
    assertReleased();
  }

  // One failed status read must not release the pin while a sibling still runs.
  reset();
  interactionCount = 2;
  let completeSibling: (() => void) | undefined;
  beforeSeed = async (key) => {
    if (key.endsWith("event")) throw new Error("fixture_parallel_read_failure");
    await new Promise<void>((resolve) => {
      completeSibling = resolve;
    });
  };
  const statusRequest = app.inject({
    method: "GET",
    url: "/feed/for-you/status",
  });
  await waitFor(() => completeSibling != null);
  await flush();
  assert.equal(held.size, 1);
  assert.equal(releases.length, 0);
  assert.ok(completeSibling);
  completeSibling();
  assert.equal((await statusRequest).statusCode, 500);
  await flush();
  assertReleased();

  // Exercise actual renewal timers while a real handler's vector read is pending.
  for (const url of urls) {
    for (const losePin of [false, true]) {
      reset();
      failRenewal = losePin;
      let completeRead: (() => void) | undefined;
      beforeSeed = () =>
        new Promise<void>((resolve) => {
          completeRead = resolve;
        });
      mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
      try {
        const request = app.inject({ method: "GET", url });
        await waitFor(() => completeRead != null);
        for (let i = 0; i < 4; i += 1) {
          mock.timers.tick(100_000);
          await flush();
        }
        assert.ok(renewals > 0);
        assert.equal(held.size, 1);
        assert.ok(completeRead);
        completeRead();
        const response = await request;
        await flush();
        assert.equal(response.statusCode, losePin ? 500 : 200, response.body);
        if (losePin)
          assert.equal(searches.length, 0, "Lost pins cannot issue KNN");
        assertReleased();
      } finally {
        mock.timers.reset();
      }
    }
  }

  // A failed renewal during KNN invalidates its response before cache/comparison work.
  for (const url of urls.filter((entry) => !entry.endsWith("/status"))) {
    reset();
    failRenewal = true;
    let completeSearch: (() => void) | undefined;
    beforeSearch = () =>
      new Promise<void>((resolve) => {
        completeSearch = resolve;
      });
    mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
    try {
      const request = app.inject({ method: "GET", url });
      await waitFor(() => completeSearch != null);
      mock.timers.tick(100_000);
      await flush();
      assert.equal(renewals, 1);
      assert.ok(completeSearch);
      completeSearch();
      const response = await request;
      await flush();
      if (url.endsWith("/similar")) {
        assert.equal(response.statusCode, 200);
        assert.equal(response.json().cache_status, "error");
      } else {
        assert.equal(response.statusCode, 500);
      }
      assert.equal(cacheWrites.length, 0);
      assertReleased();
    } finally {
      mock.timers.reset();
    }
  }
  console.log(
    "✓ Real Similar/For You HTTP routes retain captured generations, release unique renewable request pins on success/early return/failure, safely refuse retired admissions, and drain concurrent vector reads",
  );
} finally {
  await app.close();
  await dbModule.pool.end();
  mock.restoreAll();
  globalThis.fetch = originalFetch;
}
