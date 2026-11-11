import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";

Object.assign(process.env, {
  HUNCH_RUNTIME_SECRETS_LOADED: "1",
  NODE_ENV: "test",
  DATABASE_URL: "postgres://test:test@127.0.0.1:1/feed_route_test",
  REDIS_URL: "redis://127.0.0.1:1",
  JWT_SECRET: "feed-route-test",
  PRIVY_APP_ID: "feed-route-test",
  PRIVY_APP_SECRET: "feed-route-test",
  API_FEED_TTL_SEC: "60",
});
globalThis.fetch = async () => {
  throw Error("Network forbidden in feed route fixture");
};
const mockModule = async (
  relative: string,
  namedExports: Record<string, unknown>,
) => {
  const url = new URL(relative, import.meta.url).href;
  if (process.versions.bun) {
    const { mock } = await import("bun" + ":test");
    mock.module(url, () => namedExports);
  } else {
    const { mock } = await import("node:test");
    mock.module(url, { namedExports });
  }
};
await mockModule("./db.ts", {
  pool: {
    query: async () => {
      throw Error("Unmocked SQL");
    },
  },
});
const realRedis = await import("./redis.js");
const cache = new Map<string, string>();
let redisBroken = false;
const r = {
  get: async (key: string) => {
    if (redisBroken) throw Error("Redis unavailable");
    return cache.get(key) ?? null;
  },
  set: async (key: string, value: string, options: { EX: number }) => {
    assert.equal(options.EX, 60);
    if (redisBroken) throw Error("Redis unavailable");
    cache.set(key, value);
  },
  mGet: async () => {
    if (redisBroken) throw Error("Redis unavailable");
    return [];
  },
};
await mockModule("./redis.ts", {
  ...realRedis,
  getRedisStatus: async () => ({ redis: r, status: "ready" }),
  getRedis: async () => null,
});
const realRead = await import("./repos/unified-read.js");
let candidates = 0,
  hydrations = 0,
  fail = false,
  empty = false;
await mockModule("./repos/unified-read.ts", {
  ...realRead,
  fetchFeedEventIds: async (_pool: unknown, inputs: { offset: number }) => {
    candidates++;
    await new Promise<void>((done) => setImmediate(done));
    if (fail)
      throw Object.assign(Error("Fixture SQL timeout"), { code: "57014" });
    return empty ? [] : [{ id: `event-${inputs.offset}` }];
  },
  fetchFeedMarketsBatched: async (
    _pool: unknown,
    _inputs: unknown,
    eventIds: string[],
  ) => {
    hydrations++;
    return eventIds.map((event_id) => ({
      event_id,
      event_title: "Fixture",
      market_uuid: `market-${event_id}`,
      venue_market_id: `market-${event_id}`,
      venue: "polymarket",
      market_status: "ACTIVE",
      pm_accepting_orders: true,
      market_title: "Fixture market",
      market_metadata: {},
      outcomes: '["Yes","No"]',
      market_close_time: "2099-01-01T00:00:00Z",
      end_date: "2099-01-01T00:00:00Z",
    }));
  },
});
const lifecycle = await import("./services/venue-lifecycle.js");
let revision = "fixture-1";
await mockModule("./services/venue-lifecycle.ts", {
  ...lifecycle,
  filterVenuesForLifecycleCapability: async () => ({
    revision,
    venues: ["polymarket"],
  }),
});
const { feedRoutes } = await import("./routes/feed.js");
const { env } = await import("./env.js");
const app = Fastify({ logger: false });
app.setValidatorCompiler(validatorCompiler);
app.setSerializerCompiler(serializerCompiler);
await app.register(feedRoutes);
const url = "/feed?limit=100&offset=0&sort=trending_v2&sort_dir=desc";
try {
  const concurrent = await Promise.all(
    Array.from({ length: 25 }, () => app.inject({ method: "GET", url })),
  );
  assert.equal(candidates, 1);
  assert.equal(hydrations, 1);
  assert.equal(cache.size, 1);
  const first = concurrent[0];
  assert.ok(first);
  for (const response of concurrent) {
    assert.equal(response.statusCode, 200);
    assert.equal(response.body, first.body);
  }
  assert.equal(
    first.headers.etag,
    `W/"${createHash("sha1").update(first.body).digest("hex")}"`,
  );
  const cached = await app.inject({ method: "GET", url });
  assert.equal(cached.headers["x-cache"], "hit");
  assert.equal(candidates, 1);
  const notModified = await app.inject({
    method: "GET",
    url,
    headers: { "if-none-match": String(first.headers.etag) },
  });
  assert.equal(notModified.statusCode, 304);
  assert.equal(notModified.body, "");
  await app.inject({
    method: "GET",
    url: url.replace("offset=0", "offset=100"),
  });
  await app.inject({
    method: "GET",
    url: url.replace("limit=100", "limit=25"),
  });
  revision = "fixture-2";
  await app.inject({ method: "GET", url });
  assert.equal(
    candidates,
    4,
    "offset, limit and lifecycle revision are distinct keys",
  );
  cache.clear();
  fail = true;
  const failures = await Promise.all(
    Array.from({ length: 10 }, () => app.inject({ method: "GET", url })),
  );
  assert.ok(failures.every((response) => response.statusCode === 504));
  assert.equal(candidates, 5);
  assert.equal(cache.size, 0);
  fail = false;
  assert.equal((await app.inject({ method: "GET", url })).statusCode, 200);
  assert.equal(candidates, 6);
  cache.clear();
  redisBroken = true;
  const degraded = await Promise.all(
    Array.from({ length: 10 }, () => app.inject({ method: "GET", url })),
  );
  assert.ok(degraded.every((response) => response.statusCode === 200));
  assert.equal(candidates, 7);
  assert.equal(degraded[0]?.headers["x-cache-status"], "error");
  redisBroken = false;
  cache.clear();
  empty = true;
  assert.equal((await app.inject({ method: "GET", url })).json().count, 0);
  assert.equal(cache.size, 0);
  await app.inject({ method: "GET", url });
  assert.equal(
    candidates,
    9,
    "Empty pages do not become a persistent absence cache",
  );
  empty = false;
  env.feedTtlSec = 0;
  const noCache = await app.inject({ method: "GET", url });
  assert.equal(noCache.statusCode, 200);
  assert.equal(noCache.headers["cache-control"], "no-store");
  assert.equal(cache.size, 0);
  console.log(
    "ok - actual Fastify feed concurrency, ETag/304, exact keys, SQL error recovery, Redis outage and empty/disabled cache",
  );
} finally {
  await app.close();
}
