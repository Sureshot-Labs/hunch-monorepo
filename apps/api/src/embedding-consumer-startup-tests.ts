import assert from "node:assert/strict";
import { mock } from "node:test";
import {
  EMBEDDING_ACTIVE_KEY,
  LEGACY_EMBEDDING_GENERATION,
  embeddingPolicySchema,
  generationForPolicy,
  type EmbeddingGeneration,
} from "@hunch/embeddings";

// Actual job entry points, with Redis, artifact input and pricing refresh mocked.
// Run with node --experimental-test-module-mocks --import tsx.
Object.assign(process.env, {
  HUNCH_RUNTIME_SECRETS_LOADED: "1",
  DATABASE_URL: "postgres://test:test@127.0.0.1:1/embedding_startup_test",
  REDIS_URL: "redis://127.0.0.1:1",
  JWT_SECRET: "embedding-startup-test",
  PRIVY_APP_ID: "embedding-startup-test",
  PRIVY_APP_SECRET: "embedding-startup-test",
  OPENROUTER_API_KEY: "not-a-provider-key",
  XAI_API_KEY: "not-a-provider-key",
  OPENROUTER_EMBED_MODEL: "deprecated/model-must-not-appear-in-start-log",
});
const generation = generationForPolicy(embeddingPolicySchema.parse({}));
let snapshotGeneration: unknown = generation;
let activeGenerationRaw: string | null = JSON.stringify(generation);
let activeGenerationError: Error | null = null;
let pinAllowed = true;
let quits = 0;
let pricingRefreshes = 0;
let activateOnPricing: EmbeddingGeneration | null = null;
const pins = new Set<string>();
const pinOwners = new Set<string>();
const commands: string[][] = [];
const fileWrites: string[] = [];
const fakeRedis = {
  withTypeMapping() {
    return this;
  },
  async get(key: string) {
    if (key === EMBEDDING_ACTIVE_KEY) {
      if (activeGenerationError) throw activeGenerationError;
      return activeGenerationRaw;
    }
    if (key.endsWith(":meta"))
      return JSON.stringify({
        generatedAt: "2026-09-21T00:00:00Z",
        embeddingGeneration: snapshotGeneration,
      });
    assert.ok(key.endsWith(":nodes"), key);
    return "[]";
  },
  async sendCommand(command: string[]) {
    commands.push(command);
    if (command[0] === "ZREM") {
      assert.ok(pins.delete(command[2]), "release must match an acquired pin");
      return 1;
    }
    assert.equal(command[0], "EVAL");
    assert.equal(
      command[9],
      "1",
      "new consumer jobs require the active generation",
    );
    const activeId = activeGenerationRaw
      ? JSON.parse(activeGenerationRaw).id
      : LEGACY_EMBEDDING_GENERATION.id;
    if (!pinAllowed || command[10] !== activeId) return 0;
    const owner = command[8];
    assert.ok(!pinOwners.has(owner), "each execution needs its own pin");
    pinOwners.add(owner);
    pins.add(owner);
    assert.ok(Number(command[7]) <= Date.now() + 300_000);
    return 1;
  },
  async quit() {
    quits += 1;
  },
};
const infra = await import("@hunch/infra");
mock.module("@hunch/infra", {
  namedExports: {
    ...infra,
    createRedisClient: () => fakeRedis,
    ensureRedis: async () => {},
  },
});
const fs = await import("fs/promises");
mock.module("fs/promises", {
  namedExports: {
    ...fs,
    readFile: async (path: string) => {
      assert.equal(path, "embedding-startup-fixture.json");
      return JSON.stringify({
        run: { runId: "fixture", mapGeneratedAt: "2026-09-21T00:00:00Z" },
        totals: {
          callsExecuted: 0,
          evidenceTotal: 0,
          estimatedTotalCostUsd: 0,
        },
        calls: [],
        evidence: [],
      });
    },
    writeFile: async (path: string) => {
      fileWrites.push(path);
    },
  },
});
const pricing = await import("./lib/ai-pricing.js");
const catalogEmbeddingPricing = { inputPerM: 0.01, outputPerM: 0 };
mock.module(new URL("./lib/ai-pricing.ts", import.meta.url).href, {
  namedExports: {
    ...pricing,
    refreshOpenRouterModelPricing: async () => {
      pricingRefreshes += 1;
      if (activateOnPricing)
        activeGenerationRaw = JSON.stringify(activateOnPricing);
    },
    getOpenRouterEmbeddingPricingPerM: (model: string) =>
      model === generation.model ? catalogEmbeddingPricing : null,
  },
});
const { runMapSearch } = await import("./ai-map-search-run.js");
const { runMapSignals } = await import("./ai-map-signals-run.js");
const { runMarketMapBuild } = await import("./ai-map-build-run.js");
const { pool } = await import("./db.js");
const originalQuery = pool.query;
pool.query = (async (query: string) => {
  assert.match(query, /runtime_policies/);
  return { rows: [] };
}) as typeof pool.query;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
  throw new Error("Network forbidden in startup fixtures");
};
try {
  for (const run of [
    (args: string[]) => runMapSearch(["--run-id", "fixture", ...args]),
    (args: string[]) =>
      runMapSignals(["--in", "embedding-startup-fixture.json", ...args]),
  ]) {
    for (const failure of ["model_mismatch", "invalid_generation"]) {
      quits = 0;
      snapshotGeneration =
        failure === "invalid_generation"
          ? { ...generation, dimensions: 768 }
          : generation;
      pinAllowed = true;
      const args = ["--dry-run"];
      if (failure === "model_mismatch")
        args.push(
          "--embed-model",
          generation.model === "qwen/qwen3-embedding-8b"
            ? "intfloat/e5-large-v2"
            : "qwen/qwen3-embedding-8b",
        );
      await assert.rejects(
        run(args),
        failure === "model_mismatch"
          ? /embedding_model_snapshot_mismatch/
          : /dimensions/,
      );
      assert.equal(quits, 1, `${failure} must close the connected client once`);
    }
    const otherGeneration = generationForPolicy(
      embeddingPolicySchema.parse({ model: "intfloat/e5-large-v2" }),
    );
    for (const fixture of [
      { snapshot: otherGeneration, active: generation, allowed: true },
      { snapshot: undefined, active: generation, allowed: true },
      { snapshot: generation, active: null, allowed: true },
      // Models still match when cleanup has claimed the generation or an
      // activation wins the atomic pin race: both must gracefully skip.
      { snapshot: generation, active: generation, allowed: false },
    ]) {
      for (const dryRun of [false, true]) {
        if (dryRun && !fixture.allowed) continue;
        snapshotGeneration = fixture.snapshot;
        activeGenerationRaw = fixture.active
          ? JSON.stringify(fixture.active)
          : null;
        pinAllowed = fixture.allowed;
        quits = 0;
        pricingRefreshes = 0;
        commands.length = 0;
        fileWrites.length = 0;
        const savedXaiKey = process.env.XAI_API_KEY;
        delete process.env.XAI_API_KEY;
        const result = await run([
          "--out",
          "embedding-startup-skipped.json",
          "--report-out",
          "embedding-startup-skipped.md",
          ...(dryRun ? ["--dry-run"] : []),
        ]);
        process.env.XAI_API_KEY = savedXaiKey;
        assert.deepEqual(result, {
          status: "skipped",
          reason: "stale_embedding_generation",
          runId: "fixture",
          embeddingGeneration:
            fixture.snapshot?.id ?? LEGACY_EMBEDDING_GENERATION.id,
        });
        assert.equal(quits, 1, "stale jobs close their Redis client");
        assert.equal(
          pricingRefreshes,
          0,
          "stale jobs skip provider/pricing work",
        );
        assert.equal(pins.size, 0, "stale jobs never retain generations");
        assert.equal(
          fileWrites.length,
          0,
          "stale jobs preserve prior artifacts",
        );
        assert.equal(commands.length, dryRun ? 0 : 1);
      }
    }
    activeGenerationRaw = JSON.stringify(generation);
    snapshotGeneration = generation;
    pinAllowed = true;
    quits = 0;
    await assert.rejects(
      run(["--embed-model", otherGeneration.model]),
      /embedding_model_snapshot_mismatch/,
    );
    assert.equal(quits, 1);
    assert.equal(pins.size, 0, "startup errors release acquired pins");
  }
  const logs: unknown[][] = [];
  const capture = mock.method(console, "log", (...args: unknown[]) =>
    logs.push(args),
  );
  for (const failure of [
    "malformed_json",
    "invalid_generation",
    "read_rejected",
  ]) {
    quits = 0;
    activeGenerationRaw =
      failure === "malformed_json"
        ? "broken"
        : JSON.stringify({ ...generation, dimensions: 768 });
    activeGenerationError =
      failure === "read_rejected"
        ? new Error("active_generation_read_rejected")
        : null;
    await assert.rejects(
      runMarketMapBuild(["--enabled=true", "--dry-run"]),
      failure === "malformed_json"
        ? SyntaxError
        : failure === "read_rejected"
          ? /active_generation_read_rejected/
          : /dimensions/,
    );
    assert.equal(
      quits,
      1,
      `map build ${failure} must close the connected client once`,
    );
  }
  activeGenerationError = null;
  activeGenerationRaw = JSON.stringify(generation);
  snapshotGeneration = generation;
  pinAllowed = false;
  quits = 0;
  await assert.rejects(
    runMarketMapBuild(["--enabled=true", "--without-ai-labels"]),
    /Embedding generation changed before map build started/,
  );
  assert.equal(quits, 1);
  assert.equal(pins.size, 0);
  pinAllowed = true;
  activateOnPricing = generationForPolicy(
    embeddingPolicySchema.parse({ model: "intfloat/e5-large-v2" }),
  );
  await runMapSignals(["--in", "embedding-startup-fixture.json"]);
  assert.equal(
    JSON.parse(activeGenerationRaw).id,
    activateOnPricing.id,
    "activation happened while the job held its captured generation",
  );
  assert.equal(pins.size, 0, "in-flight retired jobs complete and release");
  activateOnPricing = null;
  activeGenerationRaw = JSON.stringify(generation);
  pinAllowed = true;
  // A failure after acquisition must release, too (not just startup failures).
  quits = 0;
  await assert.rejects(runMapSearch(["--run-id", "fixture"]), /No root nodes/);
  assert.equal(quits, 1);
  assert.equal(pins.size, 0);
  for (const fixtureGeneration of [generation, LEGACY_EMBEDDING_GENERATION]) {
    snapshotGeneration = fixtureGeneration;
    activeGenerationRaw = fixtureGeneration.legacy
      ? null
      : JSON.stringify(fixtureGeneration);
    quits = 0;
    await runMapSignals(["--in", "embedding-startup-fixture.json"]);
    assert.equal(quits, 1);
    assert.equal(pins.size, 0, "completed jobs release their pin immediately");
  }
  activeGenerationRaw = JSON.stringify(generation);
  snapshotGeneration = generation;
  for (const fixture of [
    {
      args: [],
      inputPerM: catalogEmbeddingPricing.inputPerM,
      outputPerM: catalogEmbeddingPricing.outputPerM,
    },
    {
      args: ["--embed-price-input-per-m", "7"],
      inputPerM: 7,
      outputPerM: catalogEmbeddingPricing.outputPerM,
    },
    {
      args: ["--embed-price-output-per-m", "2"],
      inputPerM: catalogEmbeddingPricing.inputPerM,
      outputPerM: 2,
    },
    {
      args: ["--embed-price-input-per-m=0", "--embed-price-output-per-m=0"],
      inputPerM: 0,
      outputPerM: 0,
    },
  ]) {
    logs.length = 0;
    await runMapSignals([
      "--in",
      "embedding-startup-fixture.json",
      "--dry-run",
      ...fixture.args,
    ]);
    const start = logs.find(([message]) => String(message).endsWith(" start"));
    assert.ok(start);
    const details = start[1] as Record<string, unknown>;
    assert.equal(details.embedModel, generation.model);
    assert.equal(details.embeddingGeneration, generation.id);
    assert.equal(details.embedPriceInputPerM, fixture.inputPerM);
    assert.equal(details.embedPriceOutputPerM, fixture.outputPerM);
  }
  capture.mock.restore();
  console.log(
    "Embedding job stale-generation skips, lease cleanup, resolved-model diagnostics and explicit pricing overrides: passed",
  );
} finally {
  globalThis.fetch = originalFetch;
  pool.query = originalQuery;
  mock.restoreAll();
  await pool.end();
}
