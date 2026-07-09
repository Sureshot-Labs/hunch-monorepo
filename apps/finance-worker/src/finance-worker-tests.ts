#!/usr/bin/env tsx

import assert from "node:assert/strict";

import { env } from "./env.js";
import {
  loadFinanceJobsModuleForSmoke,
  resetFinanceJobsModuleLoaderForTests,
  runTelegramTradeIntentReconcileJob,
  setFinanceJobsModuleLoaderForTests,
} from "./finance-jobs.js";
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
    telegramTradeIntentsEnabled: false,
    telegramTradeIntentsExecutingGraceSec: 600,
    telegramTradeIntentsExplicitWriteOverride: false,
    telegramTradeIntentsIntervalSec: 60,
    treasurySweepEnabled: false,
    ...overrides,
  };
}

const tests: TestCase[] = [
  {
    name: "telegram trade intent reconcile job is disabled by default when execute is false",
    run: () => {
      const jobs = buildJobs(buildTestEnv());
      const job = jobs.find(
        (candidate) => candidate.name === "telegram_trade_intents_reconcile",
      );
      assert.ok(job);
      assert.equal(job.enabled, false);
      assert.equal(job.intervalSec, 60);
      assert.equal(job.timeoutSec, env.jobTimeoutSec);
      assert.equal(job.maxRetries, 0);
      assert.equal(job.retryBackoffSec, 1);
      assert.equal(job.jitterSec, 0);
    },
  },
  {
    name: "telegram trade intent reconcile follows explicit execute-enabled env",
    run: () => {
      const disabledExecute = buildJobs(
        buildTestEnv({ executeEnabled: false }),
      ).find(
        (candidate) => candidate.name === "telegram_trade_intents_reconcile",
      );
      const enabledExecute = buildJobs(
        buildTestEnv({
          executeEnabled: true,
          telegramTradeIntentsEnabled: true,
        }),
      ).find(
        (candidate) => candidate.name === "telegram_trade_intents_reconcile",
      );
      assert.equal(disabledExecute?.enabled, false);
      assert.equal(enabledExecute?.enabled, true);
    },
  },
  {
    name: "telegram trade intent reconcile explicit override is honored and warned",
    run: () => {
      const originalWarn = console.warn;
      const warnings: unknown[] = [];
      console.warn = (message?: unknown) => {
        warnings.push(message);
      };
      try {
        const jobs = buildJobs(
          buildTestEnv({
            executeEnabled: false,
            telegramTradeIntentsEnabled: true,
            telegramTradeIntentsExplicitWriteOverride: true,
          }),
        );
        const job = jobs.find(
          (candidate) => candidate.name === "telegram_trade_intents_reconcile",
        );
        assert.equal(job?.enabled, true);
        assert.match(String(warnings[0] ?? ""), /DB writes/);
      } finally {
        console.warn = originalWarn;
      }
    },
  },
  {
    name: "finance job bridge uses injected module loader once",
    run: async () => {
      let loadCount = 0;
      let reconcileArgs: unknown = null;
      setFinanceJobsModuleLoaderForTests(async () => {
        loadCount += 1;
        return {
          runApiCacheWarmJob: async () => null,
          runFeesCollectJob: async () => ({
            collected: 0,
            dryRunCount: 0,
            skippedError: 0,
            skippedLive: 0,
            skippedNoCharge: 0,
            skippedNothing: 0,
          }),
          runFeesReconcileJob: async () => null,
          runKalshiExecutionReconcileJob: async () => null,
          runRewardsPayoutJob: async () => null,
          runTelegramTradeIntentReconcileJob: async (overrides) => {
            reconcileArgs = overrides;
            return { ok: true };
          },
          runTreasurySweepJob: async () => null,
        };
      });
      try {
        const first = await runTelegramTradeIntentReconcileJob({
          executingGraceMs: 1234,
        });
        const second = await runTelegramTradeIntentReconcileJob({
          executingGraceMs: 5678,
        });
        assert.deepEqual(first, { ok: true });
        assert.deepEqual(second, { ok: true });
        assert.equal(loadCount, 1);
        assert.deepEqual(reconcileArgs, { executingGraceMs: 5678 });
      } finally {
        resetFinanceJobsModuleLoaderForTests();
      }
    },
  },
  {
    name: "finance job bridge dynamic import exposes API jobs module",
    run: async () => {
      resetFinanceJobsModuleLoaderForTests();
      const jobs = await loadFinanceJobsModuleForSmoke();
      assert.equal(typeof jobs.runTelegramTradeIntentReconcileJob, "function");
      assert.equal(typeof jobs.runFeesCollectJob, "function");
      resetFinanceJobsModuleLoaderForTests();
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
