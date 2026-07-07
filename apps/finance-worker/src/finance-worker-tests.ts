#!/usr/bin/env tsx

import assert from "node:assert/strict";

import { env } from "./env.js";
import { buildJobs } from "./main.js";

type TestCase = {
  name: string;
  run: () => Promise<void> | void;
};

function buildTestEnv(overrides: Partial<typeof env> = {}): typeof env {
  return {
    ...env,
    apiCacheWarmEnabled: false,
    executeEnabled: false,
    feesCollectEnabled: false,
    feesReconcileEnabled: false,
    jitterSec: 0,
    kalshiExecutionReconcileEnabled: false,
    maxRetries: 0,
    payoutPrepareEnabled: false,
    payoutSendEnabled: false,
    retryBackoffSec: 1,
    telegramTradeIntentsEnabled: true,
    telegramTradeIntentsExecutingGraceSec: 600,
    telegramTradeIntentsIntervalSec: 60,
    treasurySweepEnabled: false,
    ...overrides,
  };
}

const tests: TestCase[] = [
  {
    name: "telegram trade intent reconcile job is enabled by default",
    run: () => {
      const jobs = buildJobs(buildTestEnv());
      const job = jobs.find(
        (candidate) => candidate.name === "telegram_trade_intents_reconcile",
      );
      assert.ok(job);
      assert.equal(job.enabled, true);
      assert.equal(job.intervalSec, 60);
      assert.equal(job.timeoutSec, env.jobTimeoutSec);
      assert.equal(job.maxRetries, 0);
      assert.equal(job.retryBackoffSec, 1);
      assert.equal(job.jitterSec, 0);
    },
  },
  {
    name: "telegram trade intent reconcile does not depend on execute flag",
    run: () => {
      const disabledExecute = buildJobs(buildTestEnv({ executeEnabled: false }))
        .find(
          (candidate) =>
            candidate.name === "telegram_trade_intents_reconcile",
        );
      const enabledExecute = buildJobs(buildTestEnv({ executeEnabled: true }))
        .find(
          (candidate) =>
            candidate.name === "telegram_trade_intents_reconcile",
        );
      assert.equal(disabledExecute?.enabled, true);
      assert.equal(enabledExecute?.enabled, true);
    },
  },
  {
    name: "telegram trade intent reconcile can be disabled independently",
    run: () => {
      const jobs = buildJobs(
        buildTestEnv({ telegramTradeIntentsEnabled: false }),
      );
      const job = jobs.find(
        (candidate) => candidate.name === "telegram_trade_intents_reconcile",
      );
      assert.equal(job?.enabled, false);
    },
  },
];

let passed = 0;
for (const test of tests) {
  try {
    await test.run();
    passed += 1;
  } catch (error) {
    console.error(`[finance-worker-tests] failed: ${test.name}`);
    throw error;
  }
}

console.log(`[finance-worker-tests] passed ${passed}/${tests.length}`);
