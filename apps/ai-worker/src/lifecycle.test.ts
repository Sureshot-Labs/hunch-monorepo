import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { EMBEDDING_REDIS_STARTUP_MS, runEmbeddingWorker } from "./lifecycle.js";

const quick = { startupMs: 1_000, redisPollMs: 1, cleanupMs: 100 };
const never = (): Promise<never> => new Promise(() => {});

function fixture() {
  const shutdown = new AbortController();
  const actions: string[] = [];
  const logs: string[] = [];
  const deps: Parameters<typeof runEmbeddingWorker>[0] = {
    redis: {
      get isOpen() {
        return actions.includes("connect") && !actions.includes("destroy");
      },
      async connect() {
        actions.push("connect");
      },
      async ping() {
        actions.push("ping");
        return "PONG";
      },
      destroy() {
        actions.push("destroy");
      },
    },
    async acquireLease() {
      actions.push("acquire");
      return true;
    },
    async renewLease() {
      actions.push("renew");
    },
    async releaseLease() {
      actions.push("release");
    },
    async closeDatabase() {
      actions.push("close-db");
    },
    async initialize() {
      actions.push("initialize");
      return async () => {
        actions.push("tick");
        shutdown.abort();
      };
    },
    log: (line) => logs.push(line),
  };
  return { shutdown, actions, logs, deps };
}

test("a cold Redis retries LOADING before acquiring the lease and resumes work", async () => {
  const { deps, actions, shutdown, logs } = fixture();
  let pings = 0;
  deps.redis.ping = async () => {
    actions.push("ping");
    if (++pings < 4) throw new Error("LOADING Redis is loading the dataset");
    return "PONG";
  };
  assert.ok(EMBEDDING_REDIS_STARTUP_MS > 5 * 60_000);
  await runEmbeddingWorker(deps, shutdown.signal, quick);
  assert.deepEqual(actions, [
    "connect",
    "ping",
    "ping",
    "ping",
    "ping",
    "acquire",
    "initialize",
    "tick",
    "release",
    "destroy",
    "close-db",
  ]);
  assert.deepEqual(logs, [
    "Waiting for Redis to finish startup",
    "generation-aware worker ready",
  ]);
});

for (const blocked of ["connect", "ping"] as const) {
  test(`a hung Redis ${blocked} is bounded and both clients are closed`, async () => {
    const { deps, actions, shutdown } = fixture();
    deps.redis[blocked] = async () => {
      actions.push(blocked);
      return never();
    };
    await assert.rejects(
      runEmbeddingWorker(deps, shutdown.signal, { ...quick, startupMs: 25 }),
      { message: "redis_startup_timeout" },
    );
    assert.deepEqual(actions, [
      "connect",
      ...(blocked === "ping" ? ["ping"] : []),
      "destroy",
      "close-db",
    ]);
  });
}

test("an exhausted LOADING wait stops polling and leaves no lease", async () => {
  const { deps, actions, shutdown } = fixture();
  deps.redis.ping = async () => {
    actions.push("ping");
    throw new Error("LOADING Redis is loading the dataset");
  };
  await assert.rejects(
    runEmbeddingWorker(deps, shutdown.signal, { ...quick, startupMs: 25 }),
    { message: "redis_startup_timeout" },
  );
  assert.ok(actions.includes("ping"));
  assert.deepEqual(actions.slice(-2), ["destroy", "close-db"]);
  assert.ok(!actions.includes("acquire"));
  const finished = actions.length;
  await sleep(10);
  assert.equal(actions.length, finished);
});

test("a permanent Redis error fails immediately without leaking its contents", async () => {
  const { deps, actions, shutdown } = fixture();
  deps.redis.ping = async () => {
    actions.push("ping");
    throw new Error("WRONGPASS fixture-secret");
  };
  await assert.rejects(runEmbeddingWorker(deps, shutdown.signal, quick), {
    message: "redis_startup_failed",
  });
  assert.deepEqual(actions, ["connect", "ping", "destroy", "close-db"]);
});

test("shutdown during startup stops cleanly without acquiring the lease", async () => {
  const { deps, actions, shutdown } = fixture();
  deps.redis.ping = async () => {
    actions.push("ping");
    shutdown.abort();
    return never();
  };
  await runEmbeddingWorker(deps, shutdown.signal, quick);
  assert.deepEqual(actions, ["connect", "ping", "destroy", "close-db"]);
});

test("shutdown while waiting for another owner's lease does not release it", async () => {
  const { deps, actions, shutdown } = fixture();
  deps.acquireLease = async () => {
    actions.push("acquire");
    shutdown.abort();
    return false;
  };
  await runEmbeddingWorker(deps, shutdown.signal, quick);
  assert.deepEqual(actions, [
    "connect",
    "ping",
    "acquire",
    "destroy",
    "close-db",
  ]);
});

test("lease renewal failure stops further processing and exits the lifecycle", async () => {
  const { deps, actions, shutdown } = fixture();
  let renewalAttempted!: () => void;
  const attempt = new Promise<void>((resolve) => {
    renewalAttempted = resolve;
  });
  deps.renewLease = async () => {
    actions.push("renew");
    renewalAttempted();
    throw new Error("embedding_lease_lost");
  };
  deps.initialize = async () => {
    actions.push("initialize");
    await attempt;
    await sleep(1);
    return async () => {
      actions.push("unexpected tick");
      shutdown.abort();
    };
  };
  await assert.rejects(
    runEmbeddingWorker(deps, shutdown.signal, { ...quick, leaseRenewMs: 1 }),
    { message: "lease_renewal_failed" },
  );
  assert.deepEqual(actions, [
    "connect",
    "ping",
    "acquire",
    "initialize",
    "renew",
    "release",
    "destroy",
    "close-db",
  ]);
});

test("hanging cleanup cannot mask a fatal processing error", async () => {
  const { deps, actions, shutdown, logs } = fixture();
  deps.initialize = async () => async () => {
    throw new Error("processing error");
  };
  deps.releaseLease = async () => {
    actions.push("release");
    return never();
  };
  deps.closeDatabase = async () => {
    actions.push("close-db");
    return never();
  };
  await assert.rejects(
    runEmbeddingWorker(deps, shutdown.signal, { ...quick, cleanupMs: 10 }),
    { message: "processing_failed" },
  );
  assert.deepEqual(actions.slice(-3), ["release", "destroy", "close-db"]);
  assert.ok(logs.some((line) => line.includes("lease; it will expire")));
});

test("fatal entrypoint exit is nonzero even with an open handle", () => {
  const source = import.meta.url.endsWith(".ts");
  const url = new URL(
    source ? "./lifecycle.ts" : "./lifecycle.js",
    import.meta.url,
  ).href;
  const code = `
    import { exitAfterEmbeddingFailure } from ${JSON.stringify(url)};
    setInterval(() => {}, 1000);
    exitAfterEmbeddingFailure(new Error("fixture-secret"));
  `;
  const args = process.versions.bun
    ? ["-e", code]
    : [
        ...(source ? ["--import", "tsx"] : []),
        "--input-type=module",
        "-e",
        code,
      ];
  const result = spawnSync(process.execPath, args, {
    cwd: new URL("../../../", import.meta.url),
    encoding: "utf8",
    timeout: 5_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /\[ai-worker\] stopped \(startup_failed\)/);
  assert.doesNotMatch(result.stderr, /fixture-secret/);
});
