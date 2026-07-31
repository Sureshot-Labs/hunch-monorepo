#!/usr/bin/env tsx

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Pool } from "@hunch/infra";

import { env, parseFundingReferenceLookupKeyVersion } from "./env.js";
import {
  loadFinanceJobsModuleForSmoke,
  resetFinanceJobsModuleLoaderForTests,
  runTelegramTradeIntentReconcileJob,
  setFinanceJobsModuleLoaderForTests,
} from "./finance-jobs.js";
import {
  fundingReferenceProtectionConfig,
  resetFundingWorkerModuleLoaderForTests,
  relayFundingWorkerConfig,
  runFundingReconciliationJob,
  setFundingWorkerModuleLoaderForTests,
} from "./funding-reconciliation.js";
import { buildJobs } from "./main.js";

type TestCase = {
  name: string;
  run: () => Promise<void> | void;
};

const kalshiExecutionReconcileSource = readFileSync(
  new URL(
    "../../api/src/services/kalshi-execution-reconcile.ts",
    import.meta.url,
  ),
  "utf8",
);
const apiPackage = JSON.parse(
  readFileSync(new URL("../../api/package.json", import.meta.url), "utf8"),
) as {
  exports?: Record<string, string | Record<string, string>>;
};
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

function buildTestEnv(overrides: Partial<typeof env> = {}): typeof env {
  return {
    ...env,
    apiCacheWarmEnabled: false,
    executeEnabled: false,
    feesCollectEnabled: false,
    feesReconcileEnabled: false,
    jitterSec: 0,
    kalshiExecutionReconcileEnabled: false,
    kalshiExecutionReconcileMaxAgeSec: 7 * 24 * 60 * 60,
    maxRetries: 0,
    payoutPrepareEnabled: false,
    payoutSendEnabled: false,
    privyDeletionReconciliationBatchSize: 10,
    privyDeletionReconciliationEnabled: false,
    privyDeletionReconciliationIntervalSec: 60,
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
    name: "Bun development resolves the funding worker from source",
    run: () => {
      assert.deepEqual(apiPackage.exports?.["./funding-worker"], {
        source: "./src/funding/worker/funding-reconciliation-worker.ts",
        import: "./dist/funding/worker/funding-reconciliation-worker.js",
      });
    },
  },
  {
    name: "funding worker imports without API-wide required secrets",
    run: () => {
      const output = execFileSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "-e",
          'import("./apps/api/src/funding/worker/funding-reconciliation-worker.ts").then(() => process.stdout.write("ok"))',
        ],
        {
          cwd: repositoryRoot,
          encoding: "utf8",
          env: {
            HUNCH_RUNTIME_SECRETS_LOADED: "1",
            PATH: process.env.PATH,
          },
        },
      );
      assert.equal(output.trim(), "ok");
    },
  },
  {
    name: "Kalshi reconciliation stops a batch after shared RPC rate limiting",
    run: () => {
      assert.match(kalshiExecutionReconcileSource, /isRpcRateLimit\(error\)/);
      assert.match(kalshiExecutionReconcileSource, /rpcRateLimited = true/);
      assert.match(
        kalshiExecutionReconcileSource,
        /for \(const row of rpcRateLimited \? \[\] : feeBackfillRows\)/,
      );
      assert.match(
        kalshiExecutionReconcileSource,
        /reconcile deferred after RPC rate limit/,
      );
    },
  },
  {
    name: "Relay reference key version fails closed on invalid explicit input",
    run: () => {
      assert.equal(parseFundingReferenceLookupKeyVersion(undefined), 1);
      assert.equal(parseFundingReferenceLookupKeyVersion("7"), 7);
      for (const invalid of ["0", "-1", "1.5", "not-a-version"]) {
        assert.throws(() => parseFundingReferenceLookupKeyVersion(invalid));
      }
    },
  },
  {
    name: "Relay requires reference protection while receive lookup remains independent",
    run: () => {
      const complete = {
        relayApiKey: "relay-api-key",
        relayRequestTimeoutMs: 1_500,
        credentialsEncryptionKey: "credentials-key",
        fundingReferenceLookupHmacKey: "lookup-key",
        fundingReferenceLookupKeyVersion: 4,
      };
      assert.deepEqual(relayFundingWorkerConfig(complete), {
        apiKey: "relay-api-key",
        timeoutMs: 1_500,
      });
      assert.deepEqual(fundingReferenceProtectionConfig(complete), {
        credentialsEncryptionKey: "credentials-key",
        referenceLookupHmacKey: "lookup-key",
        referenceKeyVersion: 4,
      });
      assert.equal(
        fundingReferenceProtectionConfig({
          ...complete,
          fundingReferenceLookupHmacKey: undefined,
        }),
        undefined,
      );
      assert.equal(
        relayFundingWorkerConfig({
          relayApiKey: complete.relayApiKey,
          relayRequestTimeoutMs: complete.relayRequestTimeoutMs,
          credentialsEncryptionKey: undefined,
          fundingReferenceLookupHmacKey: undefined,
        }),
        undefined,
      );
      assert.equal(
        relayFundingWorkerConfig({
          ...complete,
          fundingReferenceLookupHmacKey: undefined,
        }),
        undefined,
      );
    },
  },
  {
    name: "funding reconciliation remains enabled when finance execute is false",
    run: () => {
      const job = buildJobs(
        buildTestEnv({
          databaseUrl: "postgresql://local/funding-test",
          executeEnabled: false,
          fundingReconciliationEnabled: true,
          fundingReconciliationIntervalSec: 17,
        }),
      ).find((candidate) => candidate.name === "funding_reconciliation");
      assert.ok(job);
      assert.equal(job.enabled, true);
      assert.equal(job.intervalSec, 17);
      assert.equal(job.maxRetries, 0);
      assert.equal(job.jitterSec, 0);
      assert.equal(job.isNoopResult?.({ claimed: 0 }), true);
      assert.equal(job.isNoopResult?.({ claimed: 1 }), false);
      assert.equal(
        job.isNoopResult?.({
          claimed: 0,
          receiveObservation: {
            sessionsPolled: 1,
            receiptsRecorded: 1,
            recoveriesRequired: 0,
            retryableErrors: 0,
          },
        }),
        false,
      );
      assert.equal(
        job.isNoopResult?.({
          claimed: 0,
          receiveRouting: {
            receiptsInspected: 1,
            operationsCreated: 0,
            receiptsReady: 0,
            recoveriesRequired: 0,
            reviewsRequired: 0,
            retriesScheduled: 1,
            retryableErrors: 0,
          },
        }),
        false,
      );
    },
  },
  {
    name: "funding reconciliation is disabled without sidecar database config",
    run: () => {
      const job = buildJobs(
        buildTestEnv({
          databaseUrl: undefined,
          fundingReconciliationEnabled: true,
        }),
      ).find((candidate) => candidate.name === "funding_reconciliation");
      assert.equal(job?.enabled, false);
    },
  },
  {
    name: "position resolution notification producer polls every minute behind runtime policy",
    run: () => {
      const job = buildJobs(buildTestEnv()).find(
        (candidate) => candidate.name === "position_resolution_notifications",
      );
      assert.equal(job?.enabled, true);
      assert.equal(job?.intervalSec, 60);
    },
  },
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
    name: "Privy deletion reconciliation is a durable user-requested job",
    run: () => {
      const job = buildJobs(
        buildTestEnv({
          databaseUrl: "postgresql://local/funding-test",
          executeEnabled: false,
          privyDeletionReconciliationEnabled: true,
          privyDeletionReconciliationIntervalSec: 60,
        }),
      ).find((candidate) => candidate.name === "privy_deletion_reconcile");
      assert.ok(job);
      assert.equal(job.enabled, true);
      assert.equal(job.intervalSec, 60);
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
          runPositionResolutionNotificationJob: async () => null,
          runPrivyDeletionReconcileJob: async () => null,
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
  {
    name: "funding job bridge passes sidecar-safe bounded configuration",
    run: async () => {
      const fakePool = {} as Pool;
      let observedPool: Pool | null = null;
      let observedOptions: Record<string, unknown> = {};
      setFundingWorkerModuleLoaderForTests(
        async () => ({
          runFundingReconciliationJob: async (pool, options) => {
            observedPool = pool;
            observedOptions = options;
            return {
              claimed: 0,
              completed: 0,
              requeued: 0,
              failed: 0,
              deadLettered: 0,
              operationIds: [],
            };
          },
        }),
        fakePool,
      );
      try {
        const result = await runFundingReconciliationJob();
        assert.equal(result.claimed, 0);
        assert.equal(observedPool, fakePool);
        assert.equal(observedOptions.limit, env.fundingReconciliationBatchSize);
        assert.equal(
          observedOptions.leaseSeconds,
          env.fundingReconciliationLeaseSec,
        );
        assert.equal(
          observedOptions.pollDelayMs,
          env.fundingReconciliationPollSec * 1_000,
        );
        assert.equal(
          observedOptions.idlePollDelayMs,
          env.fundingReconciliationIdlePollSec * 1_000,
        );
        assert.equal(
          observedOptions.receivePollDelayMs,
          env.fundingReceivePollSec * 1_000,
        );
        assert.equal(
          observedOptions.terminalTimeoutMs,
          env.fundingReconciliationTerminalTimeoutSec * 1_000,
        );
        assert.match(String(observedOptions.workerId), /:\d+$/);
      } finally {
        resetFundingWorkerModuleLoaderForTests();
      }
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
