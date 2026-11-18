import assert from "node:assert/strict";
import Fastify, { type FastifyRequest } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";

Object.assign(process.env, {
  HUNCH_RUNTIME_SECRETS_LOADED: "1",
  NODE_ENV: "test",
  DATABASE_URL: "postgres://test:test@127.0.0.1:1/fixture",
  REDIS_URL: "redis://127.0.0.1:1",
  JWT_SECRET: "route-test",
  PRIVY_APP_ID: "route-test",
  PRIVY_APP_SECRET: "route-test",
  API_MARKET_MAP_TTL_SEC: "60",
  API_WALLET_INTEL_TTL_SEC: "0",
});
globalThis.fetch = async () => {
  throw Error("Network forbidden in route fixture");
};
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 30));
async function mockModule(path: string, namedExports: Record<string, unknown>) {
  const moduleUrl = new URL(path, import.meta.url).href;
  if (process.versions.bun) {
    const { mock } = await import("bun" + ":test");
    mock.module(moduleUrl, () => namedExports);
  } else {
    const { mock } = await import("node:test");
    mock.module(moduleUrl, { namedExports });
  }
}
let clients = 0,
  releases = 0,
  sidebars = 0,
  failSql = false;
const queries = { rows: [] };
await mockModule("./db.ts", {
  pool: {
    async query() {
      sidebars++;
      await pause();
      return queries;
    },
    async connect() {
      clients++;
      await pause();
      return {
        async query(sql: string) {
          if (failSql && sql.includes("wallet_follows"))
            throw Error("fixture SQL failure");
          return queries;
        },
        release() {
          releases++;
        },
      };
    },
  },
});
const auth = await import("./auth.js");
await mockModule("./auth.ts", {
  ...auth,
  createAuthMiddleware: () => async (request: FastifyRequest) => {
    const id = request.headers["x-fixture-user"];
    if (typeof id === "string") Object.assign(request, { user: { id } });
  },
});
const policies = await import("./services/runtime-policies.js");
await mockModule("./services/runtime-policies.ts", {
  ...policies,
  resolveMarketMapPolicy: async () => ({
    source: "fixture",
    effective: { enabled: true, venuesEnabled: ["polymarket", "limitless"] },
  }),
  resolveWalletIntelRefreshPolicy: async () => ({ effective: {} }),
  resolveWalletIntelSignalsPolicy: async () => ({
    effective: { windowHours: 24 },
  }),
  resolveWalletIntelAttributionPolicy: async () => ({ effective: {} }),
});
const lifecycle = await import("./services/venue-lifecycle.js");
await mockModule("./services/venue-lifecycle.ts", {
  ...lifecycle,
  filterVenuesForLifecycleCapability: async (
    _pool: unknown,
    venues: string[],
  ) => ({ venues, revision: "fixture" }),
});
const cache = new Map<string, string>();
let writes = 0,
  broken = false;
const redis = await import("./redis.js");
await mockModule("./redis.ts", {
  ...redis,
  getRedisStatus: async () => ({
    status: "ready",
    redis: {
      async get(key: string) {
        await pause();
        if (broken) throw Error("fixture Redis read");
        return cache.get(key) ?? null;
      },
      async setEx(key: string, _ttl: number, value: string) {
        writes++;
        cache.set(key, value);
      },
    },
  }),
});
const { walletIntelRoutes } = await import("./routes/wallet-intel.js");
const { marketMapRoutes } = await import("./routes/market-map.js");
const app = Fastify({ logger: false });
app.setValidatorCompiler(validatorCompiler);
app.setSerializerCompiler(serializerCompiler);
await app.register(walletIntelRoutes);
await app.register(marketMapRoutes);
try {
  const summary = (id: string, offset = 0) =>
    app.inject({
      url: `/wallets/activity/summary?scope=following&offset=${offset}`,
      headers: { "x-fixture-user": id },
    });
  const many = await Promise.all([
    summary("one"),
    summary("one"),
    summary("two"),
    summary("one", 5),
  ]);
  assert.ok(
    many.every((response) => response.statusCode === 200),
    many.map((response) => response.body).join("\n"),
  );
  assert.equal(
    clients,
    3,
    "one exact flight only; never share user or paging scope",
  );
  assert.equal(releases, 3);
  failSql = true;
  const failed = await Promise.all([summary("one"), summary("one")]);
  assert.ok(failed.every((response) => response.statusCode === 500));
  assert.equal(clients, 4);
  failSql = false;
  assert.equal((await summary("one")).statusCode, 200);
  assert.equal(clients, 5);

  const side = (venues: string, etag?: string) =>
    app.inject({
      url: `/market-map/sidebars?venues=${venues}&volumeMoversLimit=0&liquidityMoversLimit=0&topMoversLimit=0`,
      headers: etag ? { "if-none-match": etag } : {},
    });
  const ascending = "polymarket,limitless",
    descending = "limitless,polymarket";
  const cold = await Promise.all([
    side(ascending),
    side(ascending),
    side(ascending),
  ]);
  assert.ok(cold.every((response) => response.statusCode === 200));
  assert.equal(sidebars, 1);
  assert.equal(writes, 1);
  const [first, second] = await Promise.all([
    side(ascending),
    side(descending),
  ]);
  assert.deepEqual(first.json().venues, ascending.split(","));
  assert.deepEqual(second.json().venues, descending.split(","));
  assert.notEqual(first.headers.etag, second.headers.etag);
  assert.equal(
    (await side(ascending, String(first.headers.etag))).statusCode,
    304,
  );
  assert.equal(writes, 1);
  cache.clear();
  broken = true;
  const degraded = await Promise.all([side(ascending), side(ascending)]);
  assert.ok(
    degraded.every(
      (response) =>
        response.statusCode === 200 && response.headers["x-cache"] === "bypass",
    ),
  );
  assert.equal(sidebars, 2);
  assert.equal(writes, 1);
  console.log(
    "ok - wallet user and page isolation, failure recovery; sidebar SQL coalescing, venue order, ETag, and Redis outage",
  );
} finally {
  await app.close();
}
