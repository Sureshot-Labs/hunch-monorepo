#!/usr/bin/env tsx

import assert from "node:assert/strict";

import {
  buildEmbeddedExecutionSingleFlightKey,
  clearEmbeddedExecutionSingleFlightState,
  runEmbeddedExecutionSingleFlight,
} from "./services/embedded-execution-singleflight.js";

type TestCase = {
  name: string;
  run: () => void | Promise<void>;
};

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
];

let passed = 0;
for (const test of tests) {
  await test.run();
  passed += 1;
}

console.log(
  `[embedded-execution-singleflight-tests] passed ${passed}/${tests.length}`,
);
