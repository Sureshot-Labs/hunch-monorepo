import assert from "node:assert/strict";
import test from "node:test";
import { buildLocalEnvironment, LOCAL_REDIS } from "./hip4-local.mjs";
import {
  parseSyncArguments,
  runLocalCatalogSync,
  validateSyncEnvironment,
} from "./hip4-local-sync.mjs";

const target = "postgresql://local:example@127.0.0.1:55436/hip4_local";
const options = (venue = "polymarket", maxPages = 3) => ({
  venue,
  databaseUrl: target,
  expectedDatabase: "hip4_local",
  redisUrl: LOCAL_REDIS,
  maxPages,
});
const environment = (value) => ({
  ...buildLocalEnvironment({}, { ...value, mode: `sync-${value.venue}` }, {}),
  HUNCH_RUNTIME_SECRETS_LOADED: "1",
});

function fixture(bootstrap, isOpen = true) {
  const calls = [];
  return {
    calls,
    modules: {
      bootstrap,
      pool: {
        async end() {
          calls.push("pool.end");
        },
      },
      redis: {
        isOpen,
        async quit() {
          calls.push("redis.quit");
        },
        async disconnect() {
          calls.push("redis.disconnect");
        },
      },
    },
  };
}

function polymarketBootstrap(overrides = {}) {
  return {
    async syncHotWindow() {
      return {
        processedEvents: 4,
        processedMarkets: 8,
        pages: 4,
        lanes: [
          { version: "v1", closed: false, result: { pages: 1 } },
          { version: "v2", closed: false, result: { pages: 1 } },
          { version: "v1", closed: true, result: { pages: 1 } },
          { version: "v2", closed: true, result: { pages: 1 } },
        ],
      };
    },
    async syncV2CatchUp() {
      return {
        checkpoint: { phase: "open", offset: 1500 },
        unfinished: true,
        offsetCapReached: false,
        pages: 3,
        received: 1500,
        processedEvents: 1500,
        processedMarkets: 3000,
        skippedEvents: 0,
      };
    },
    async syncGammaEventRepairs() {
      return {
        requested: 0,
        processed: 0,
        remaining: 0,
        missingIds: [],
        failedIds: [],
      };
    },
    ...overrides,
  };
}

test("strict sync parsing requires exact local DB, Redis and bounded catalog options", () => {
  const args = [
    "--venue",
    "polymarket",
    "--database-url",
    target,
    "--expect-database",
    "hip4_local",
    "--redis-url",
    LOCAL_REDIS,
  ];
  assert.deepEqual(parseSyncArguments(args), options("polymarket", 10));
  assert.deepEqual(
    parseSyncArguments([...args, "--max-pages", "2"]),
    options("polymarket", 2),
  );
  for (const mutated of [
    args.map((value) => (value === "polymarket" ? "unknown" : value)),
    args.map((value) =>
      value === target ? target.replace("55436", "5432") : value,
    ),
    args.map((value) =>
      value === LOCAL_REDIS ? "redis://remote:6379" : value,
    ),
    [...args, "--max-pages", "0"],
    [...args, "--venue", "limitless"],
    [...args, "--execute"],
    [...args, "--max-pages"],
  ])
    assert.throws(() => parseSyncArguments(mutated));
});

test("unsafe or unbootstrapped environment is rejected before any production module import", async () => {
  const value = options();
  validateSyncEnvironment(value, environment(value));
  for (const override of [
    { DATABASE_URL: "postgresql://remote/hunch" },
    { REDIS_URL: "redis://remote" },
    { HUNCH_RUNTIME_SECRETS_LOADED: undefined },
    { HUNCH_SECRETS_MODE: "strict" },
    { HUNCH_SECRET_BUNDLES: "aws-sm:/hunch/prod/shared" },
    { POLYMARKET_HOT_MAX_PAGES: "99999" },
  ]) {
    let loaded = false;
    await assert.rejects(
      runLocalCatalogSync(value, {
        environment: { ...environment(value), ...override },
        loadModules: async () => {
          loaded = true;
          throw new Error("must not import");
        },
      }),
      /sanitized local bootstrap/,
    );
    assert.equal(loaded, false);
  }
});

test("Polymarket uses bounded production functions and honestly reports a resumable partial checkpoint", async () => {
  const value = options();
  const phases = [];
  const base = polymarketBootstrap();
  const { modules, calls } = fixture(
    Object.fromEntries(
      Object.entries(base).map(([name, fn]) => [
        name,
        async () => {
          phases.push(name);
          return fn();
        },
      ]),
    ),
  );
  const result = await runLocalCatalogSync(value, {
    environment: environment(value),
    loadModules: async (venue) => {
      assert.equal(venue, "polymarket");
      return modules;
    },
  });
  assert.deepEqual(phases, [
    "syncHotWindow",
    "syncV2CatchUp",
    "syncGammaEventRepairs",
  ]);
  assert.equal(result.complete, false);
  assert.equal(result.partial, true);
  assert.equal(result.resumable, true);
  assert.deepEqual(result.catalog.checkpoint, { phase: "open", offset: 1500 });
  assert.deepEqual(result.pageBudget, {
    perHotLane: 3,
    hotLanes: 4,
    catalogRequests: 3,
  });
  assert.deepEqual(calls.sort(), ["pool.end", "redis.quit"]);
});

test("a completed checkpoint alone cannot hide hot failures, filled budgets or pending repairs", async () => {
  const value = options();
  const completeCatalog = {
    checkpoint: { phase: "complete", offset: 5000 },
    unfinished: false,
    offsetCapReached: false,
    pages: 0,
    received: 0,
    processedEvents: 0,
    processedMarkets: 0,
    skippedEvents: 0,
  };
  for (const overrides of [
    {},
    {
      syncHotWindow: async () => ({
        processedEvents: 0,
        processedMarkets: 0,
        pages: 0,
        lanes: [
          {
            version: "v2",
            closed: false,
            error: "never-print-private-provider-error",
          },
        ],
      }),
    },
    {
      syncHotWindow: async () => ({
        processedEvents: 1,
        processedMarkets: 2,
        pages: 3,
        lanes: [{ version: "v2", closed: false, result: { pages: 3 } }],
      }),
    },
    {
      syncGammaEventRepairs: async () => ({
        requested: 1,
        processed: 0,
        remaining: 1,
        missingIds: [],
        failedIds: ["private-event-detail"],
      }),
    },
    {
      syncV2CatchUp: async () => ({
        ...completeCatalog,
        checkpoint: { phase: "catalog", offset: 100500 },
        unfinished: true,
        offsetCapReached: true,
      }),
    },
  ]) {
    const { modules } = fixture(
      polymarketBootstrap({
        syncV2CatchUp: async () => completeCatalog,
        ...overrides,
      }),
    );
    const result = await runLocalCatalogSync(value, {
      environment: environment(value),
      loadModules: async () => modules,
    });
    assert.equal(result.complete, Object.keys(overrides).length === 0);
    assert.equal(JSON.stringify(result).includes("never-print"), false);
    assert.equal(
      JSON.stringify(result).includes("private-event-detail"),
      false,
    );
    if (Object.hasOwn(overrides, "syncV2CatchUp"))
      assert.equal(result.resumable, false);
  }
});

test("Limitless preserves provider coverage facts and does not invent resumability or processing success", async () => {
  const value = options("limitless");
  const baseCoverage = {
    reportedMarkets: 4,
    reportedPages: 1,
    pagesFetched: 1,
    uniqueMarkets: 4,
    duplicates: 0,
    malformedMarkets: 0,
    failedPages: [],
    capReached: false,
    complete: true,
  };
  for (const [coverage, eventCount, expectedComplete] of [
    [baseCoverage, 4, true],
    [{ ...baseCoverage, capReached: true, complete: false }, 4, false],
    [{ ...baseCoverage, failedPages: [2], complete: false }, 4, false],
    [baseCoverage, 3, false],
  ]) {
    const { modules, calls } = fixture({
      async bootstrapLimitless() {
        return { coverage, eventCount, marketCount: 8 };
      },
    });
    const result = await runLocalCatalogSync(value, {
      environment: environment(value),
      loadModules: async () => modules,
    });
    assert.equal(result.complete, expectedComplete);
    assert.equal(result.resumable, false);
    assert.equal(result.rerunnable, true);
    assert.equal(result.processingFailedEvents, 4 - eventCount);
    assert.deepEqual(result.coverage, coverage);
    assert.deepEqual(calls.sort(), ["pool.end", "redis.quit"]);
  }
});

test("provider failure still closes both resources, and Redis quit failure has a bounded disconnect fallback", async () => {
  const value = options("limitless");
  const { modules, calls } = fixture({
    async bootstrapLimitless() {
      throw new Error("mock-provider-failure");
    },
  });
  modules.redis.quit = async () => {
    calls.push("redis.quit");
    throw new Error("mock-closed");
  };
  await assert.rejects(
    runLocalCatalogSync(value, {
      environment: environment(value),
      loadModules: async () => modules,
    }),
    /mock-provider-failure/,
  );
  assert.deepEqual(calls.sort(), [
    "pool.end",
    "redis.disconnect",
    "redis.quit",
  ]);
  const unopened = fixture(
    {
      async bootstrapLimitless() {
        throw new Error("mock-db-failure");
      },
    },
    false,
  );
  await assert.rejects(
    runLocalCatalogSync(value, {
      environment: environment(value),
      loadModules: async () => unopened.modules,
    }),
    /mock-db-failure/,
  );
  assert.deepEqual(unopened.calls, ["pool.end"]);
});
