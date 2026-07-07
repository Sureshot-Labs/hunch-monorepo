#!/usr/bin/env tsx

import assert from "node:assert/strict";

import {
  buildEmbeddedExecutionSingleFlightKey,
  clearEmbeddedExecutionSingleFlightState,
  EmbeddedExecutionInProgressError,
  type EmbeddedExecutionSingleFlightRedis,
  runEmbeddedExecutionSingleFlight,
} from "./services/embedded-execution-singleflight.js";

type TestCase = {
  name: string;
  run: () => void | Promise<void>;
};

class FakeRedis implements EmbeddedExecutionSingleFlightRedis {
  private readonly values = new Map<
    string,
    { value: string; expiresAt: number | null }
  >();

  private read(key: string): string | null {
    const entry = this.values.get(key);
    if (!entry) return null;
    if (entry.expiresAt != null && entry.expiresAt <= Date.now()) {
      this.values.delete(key);
      return null;
    }
    return entry.value;
  }

  async get(key: string): Promise<string | null> {
    return this.read(key);
  }

  async set(
    key: string,
    value: string,
    options?: { EX?: number; NX?: true },
  ): Promise<string | null> {
    if (options?.NX && this.read(key) != null) return null;
    this.values.set(key, {
      value,
      expiresAt: options?.EX ? Date.now() + options.EX * 1000 : null,
    });
    return "OK";
  }

  async del(key: string): Promise<number> {
    const existed = this.values.delete(key);
    return existed ? 1 : 0;
  }

  async eval(
    _script: string,
    options: { keys: string[]; arguments: string[] },
  ): Promise<unknown> {
    const [key] = options.keys;
    const [owner] = options.arguments;
    if (key && owner && this.read(key) === owner) {
      return this.del(key);
    }
    return 0;
  }

  hasSingleFlightLock(): boolean {
    for (const key of this.values.keys()) {
      if (
        key.startsWith("embedded-execution:singleflight:v1:lock:") &&
        this.read(key) != null
      ) {
        return true;
      }
    }
    return false;
  }
}

async function waitForFakeRedisLock(redis: FakeRedis): Promise<void> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (redis.hasSingleFlightLock()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Timed out waiting for fake Redis lock");
}

const tests: TestCase[] = [
  {
    name: "concurrent calls with the same key share one execution",
    run: async () => {
      clearEmbeddedExecutionSingleFlightState();
      let executions = 0;
      const key = buildEmbeddedExecutionSingleFlightKey(
        "embedded-wallets",
        "ethereum",
        "0xabc",
        "transfer",
      );

      const run = () =>
        runEmbeddedExecutionSingleFlight({
          key,
          run: async () => {
            executions += 1;
            await new Promise((resolve) => setTimeout(resolve, 20));
            return { ok: true, call: executions };
          },
        });

      const [first, second] = await Promise.all([run(), run()]);

      assert.equal(executions, 1);
      assert.deepEqual(first, { ok: true, call: 1 });
      assert.deepEqual(second, { ok: true, call: 1 });
    },
  },
  {
    name: "settled results are reused for immediate retries",
    run: async () => {
      clearEmbeddedExecutionSingleFlightState();
      let executions = 0;
      const key = buildEmbeddedExecutionSingleFlightKey(
        "embedded-wallets",
        "solana",
        "wallet",
        "sell",
      );

      const first = await runEmbeddedExecutionSingleFlight({
        key,
        run: async () => {
          executions += 1;
          return { ok: true, execution: executions };
        },
      });
      const second = await runEmbeddedExecutionSingleFlight({
        key,
        run: async () => {
          executions += 1;
          return { ok: true, execution: executions };
        },
      });

      assert.equal(executions, 1);
      assert.deepEqual(first, { ok: true, execution: 1 });
      assert.deepEqual(second, { ok: true, execution: 1 });
    },
  },
  {
    name: "different keys execute independently",
    run: async () => {
      clearEmbeddedExecutionSingleFlightState();
      let executions = 0;

      const first = await runEmbeddedExecutionSingleFlight({
        key: buildEmbeddedExecutionSingleFlightKey("route", "wallet", "one"),
        run: async () => {
          executions += 1;
          return executions;
        },
      });
      const second = await runEmbeddedExecutionSingleFlight({
        key: buildEmbeddedExecutionSingleFlightKey("route", "wallet", "two"),
        run: async () => {
          executions += 1;
          return executions;
        },
      });

      assert.equal(executions, 2);
      assert.equal(first, 1);
      assert.equal(second, 2);
    },
  },
  {
    name: "failed executions do not poison the key",
    run: async () => {
      clearEmbeddedExecutionSingleFlightState();
      let shouldFail = true;
      let executions = 0;
      const key = buildEmbeddedExecutionSingleFlightKey(
        "polymarket-private",
        "embedded-ensure-ready",
        "0xabc",
      );

      await assert.rejects(() =>
        runEmbeddedExecutionSingleFlight({
          key,
          run: async () => {
            executions += 1;
            if (shouldFail) {
              throw new Error("boom");
            }
            return executions;
          },
        }),
      );

      shouldFail = false;
      const retry = await runEmbeddedExecutionSingleFlight({
        key,
        run: async () => {
          executions += 1;
          return executions;
        },
      });

      assert.equal(executions, 2);
      assert.equal(retry, 2);
    },
  },
  {
    name: "redis settled results are reused after local state is lost",
    run: async () => {
      clearEmbeddedExecutionSingleFlightState();
      const redis = new FakeRedis();
      let executions = 0;
      const key = buildEmbeddedExecutionSingleFlightKey(
        "embedded-wallets",
        "ethereum",
        "0xabc",
        "137",
        "same-request",
      );

      const first = await runEmbeddedExecutionSingleFlight({
        key,
        redis,
        run: async () => {
          executions += 1;
          return { ok: true, execution: executions };
        },
      });
      clearEmbeddedExecutionSingleFlightState();
      const second = await runEmbeddedExecutionSingleFlight({
        key,
        redis,
        run: async () => {
          executions += 1;
          return { ok: true, execution: executions };
        },
      });

      assert.equal(executions, 1);
      assert.deepEqual(first, { ok: true, execution: 1 });
      assert.deepEqual(second, { ok: true, execution: 1 });
    },
  },
  {
    name: "redis lock shares result across simulated processes",
    run: async () => {
      clearEmbeddedExecutionSingleFlightState();
      const redis = new FakeRedis();
      let executions = 0;
      const key = buildEmbeddedExecutionSingleFlightKey(
        "embedded-wallets",
        "solana",
        "wallet",
        "same-request",
      );

      const first = runEmbeddedExecutionSingleFlight({
        key,
        redis,
        redisPollMs: 1,
        redisWaitTimeoutMs: 1000,
        run: async () => {
          executions += 1;
          await new Promise((resolve) => setTimeout(resolve, 20));
          return { ok: true, execution: executions };
        },
      });
      await waitForFakeRedisLock(redis);
      clearEmbeddedExecutionSingleFlightState();
      const second = runEmbeddedExecutionSingleFlight({
        key,
        redis,
        redisPollMs: 1,
        redisWaitTimeoutMs: 1000,
        run: async () => {
          executions += 1;
          return { ok: true, execution: executions };
        },
      });

      const [firstResult, secondResult] = await Promise.all([first, second]);

      assert.equal(executions, 1);
      assert.deepEqual(firstResult, { ok: true, execution: 1 });
      assert.deepEqual(secondResult, { ok: true, execution: 1 });
    },
  },
  {
    name: "redis lock times out without running a duplicate execution",
    run: async () => {
      clearEmbeddedExecutionSingleFlightState();
      const redis = new FakeRedis();
      let executions = 0;
      let duplicateExecutions = 0;
      const key = buildEmbeddedExecutionSingleFlightKey(
        "embedded-wallets",
        "ethereum",
        "0xabc",
        "137",
        "slow-request",
      );

      const first = runEmbeddedExecutionSingleFlight({
        key,
        redis,
        redisPollMs: 1,
        redisWaitTimeoutMs: 100,
        run: async () => {
          executions += 1;
          await new Promise((resolve) => setTimeout(resolve, 40));
          return { ok: true, execution: executions };
        },
      });
      await waitForFakeRedisLock(redis);
      clearEmbeddedExecutionSingleFlightState();

      await assert.rejects(
        () =>
          runEmbeddedExecutionSingleFlight({
            key,
            redis,
            redisPollMs: 1,
            redisWaitTimeoutMs: 5,
            run: async () => {
              duplicateExecutions += 1;
              return { ok: true, duplicateExecutions };
            },
          }),
        EmbeddedExecutionInProgressError,
      );

      assert.equal(duplicateExecutions, 0);
      assert.deepEqual(await first, { ok: true, execution: 1 });
      assert.equal(executions, 1);
    },
  },
];

let passed = 0;
for (const test of tests) {
  await test.run();
  passed += 1;
}

console.log(
  `[embedded-execution-singleflight-tests] passed ${passed}/${tests.length}`,
);
