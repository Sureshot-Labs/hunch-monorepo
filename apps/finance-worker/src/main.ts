import { pathToFileURL } from "node:url";

import {
  runApiCacheWarmJob,
  runFeesCollectJob,
  runFeesReconcileJob,
  runKalshiExecutionReconcileJob,
  runPositionResolutionNotificationJob,
  runRewardsPayoutJob,
  runTelegramTradeIntentReconcileJob,
  runTreasurySweepJob,
} from "./finance-jobs.js";
import {
  closeFundingReconciliationPool,
  runFundingReconciliationJob,
} from "./funding-reconciliation.js";
import { env } from "./env.js";
import { InMemoryLockManager } from "./locks.js";
import { IntervalScheduler, type ScheduledJob } from "./scheduler.js";

function log(event: string, fields?: Record<string, unknown>) {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      event,
      ...(fields ?? {}),
    }),
  );
}

function keepAliveIdle(): void {
  setInterval(() => {
    // keep process alive in disabled mode for service-style runtime
  }, 60_000);
}

function resolveFundsLockKey(chainId?: string): string {
  return chainId ? `funds:${chainId}` : "funds:all";
}

type FinanceWorkerEnv = typeof env;

export function buildJobs(workerEnv: FinanceWorkerEnv = env): ScheduledJob[] {
  const allowExecute = workerEnv.executeEnabled;
  if (workerEnv.telegramTradeIntentsExplicitWriteOverride) {
    console.warn(
      "HUNCH_FINANCE_TELEGRAM_TRADE_INTENTS_ENABLED enables DB writes while HUNCH_FINANCE_EXECUTE=false.",
    );
  }
  return [
    {
      name: "funding_reconciliation",
      enabled:
        workerEnv.fundingReconciliationEnabled &&
        Boolean(workerEnv.databaseUrl),
      intervalSec: workerEnv.fundingReconciliationIntervalSec,
      timeoutSec: workerEnv.jobTimeoutSec,
      maxRetries: 0,
      retryBackoffSec: workerEnv.retryBackoffSec,
      jitterSec: workerEnv.jitterSec,
      run: () => runFundingReconciliationJob(),
    },
    {
      name: "api_cache_warm",
      enabled: workerEnv.apiCacheWarmEnabled,
      intervalSec: workerEnv.apiCacheWarmIntervalSec,
      timeoutSec: workerEnv.jobTimeoutSec,
      maxRetries: workerEnv.maxRetries,
      retryBackoffSec: workerEnv.retryBackoffSec,
      jitterSec: workerEnv.jitterSec,
      run: () =>
        runApiCacheWarmJob({
          force: false,
        }),
    },
    {
      name: "fees_collect",
      enabled: workerEnv.feesCollectEnabled,
      intervalSec: workerEnv.feesCollectIntervalSec,
      timeoutSec: workerEnv.jobTimeoutSec,
      maxRetries: workerEnv.maxRetries,
      retryBackoffSec: workerEnv.retryBackoffSec,
      jitterSec: workerEnv.jitterSec,
      run: () =>
        runFeesCollectJob({
          archiveLegacy: true,
          dryRun:
            workerEnv.feesCollectDryRun ||
            workerEnv.feesCollectReadOnly ||
            !allowExecute,
          readOnly: workerEnv.feesCollectReadOnly || !allowExecute,
        }),
    },
    {
      name: "fees_reconcile",
      enabled: workerEnv.feesReconcileEnabled,
      intervalSec: workerEnv.feesReconcileIntervalSec,
      timeoutSec: workerEnv.jobTimeoutSec,
      maxRetries: workerEnv.maxRetries,
      retryBackoffSec: workerEnv.retryBackoffSec,
      jitterSec: workerEnv.jitterSec,
      run: () =>
        runFeesReconcileJob({
          dryRun: workerEnv.feesReconcileDryRun || !allowExecute,
          limit: 25,
          minAgeSec: 60,
        }),
    },
    {
      name: "kalshi_execution_reconcile",
      enabled: workerEnv.kalshiExecutionReconcileEnabled,
      intervalSec: workerEnv.kalshiExecutionReconcileIntervalSec,
      timeoutSec: workerEnv.jobTimeoutSec,
      maxRetries: workerEnv.maxRetries,
      retryBackoffSec: workerEnv.retryBackoffSec,
      jitterSec: workerEnv.jitterSec,
      run: () =>
        runKalshiExecutionReconcileJob({
          dryRun: workerEnv.kalshiExecutionReconcileDryRun || !allowExecute,
          limit: workerEnv.kalshiExecutionReconcileLimit,
          minAgeSec: workerEnv.kalshiExecutionReconcileMinAgeSec,
        }),
    },
    {
      name: "telegram_trade_intents_reconcile",
      enabled: workerEnv.telegramTradeIntentsEnabled,
      intervalSec: workerEnv.telegramTradeIntentsIntervalSec,
      timeoutSec: workerEnv.jobTimeoutSec,
      maxRetries: workerEnv.maxRetries,
      retryBackoffSec: workerEnv.retryBackoffSec,
      jitterSec: workerEnv.jitterSec,
      run: () =>
        runTelegramTradeIntentReconcileJob({
          executingGraceMs:
            workerEnv.telegramTradeIntentsExecutingGraceSec * 1000,
        }),
    },
    {
      name: "position_resolution_notifications",
      enabled: true,
      intervalSec: 60,
      timeoutSec: workerEnv.jobTimeoutSec,
      maxRetries: workerEnv.maxRetries,
      retryBackoffSec: workerEnv.retryBackoffSec,
      jitterSec: workerEnv.jitterSec,
      run: () => runPositionResolutionNotificationJob(),
    },
    {
      name: "treasury_sweep",
      enabled: workerEnv.treasurySweepEnabled,
      intervalSec: workerEnv.treasurySweepIntervalSec,
      timeoutSec: workerEnv.jobTimeoutSec,
      maxRetries: workerEnv.maxRetries,
      retryBackoffSec: workerEnv.retryBackoffSec,
      jitterSec: workerEnv.jitterSec,
      lockKey: resolveFundsLockKey(workerEnv.treasurySweepChainId),
      run: () =>
        runTreasurySweepJob({
          execute: allowExecute && workerEnv.treasurySweepExecute,
          dryRun: !allowExecute || !workerEnv.treasurySweepExecute,
          chainId: workerEnv.treasurySweepChainId,
          maxUsd: workerEnv.treasurySweepMaxUsd,
        }),
    },
    {
      name: "payout_prepare",
      enabled: workerEnv.payoutPrepareEnabled,
      intervalSec: workerEnv.payoutPrepareIntervalSec,
      timeoutSec: workerEnv.jobTimeoutSec,
      maxRetries: workerEnv.maxRetries,
      retryBackoffSec: workerEnv.retryBackoffSec,
      jitterSec: workerEnv.jitterSec,
      lockKey: resolveFundsLockKey(workerEnv.payoutPrepareChainId),
      run: () =>
        runRewardsPayoutJob({
          dryRun: workerEnv.payoutPrepareDryRun || !allowExecute,
          confirmOnly: true,
          sendOnly: false,
          failPending: false,
          limit: workerEnv.payoutPrepareLimit,
          chainId: workerEnv.payoutPrepareChainId,
        }),
    },
    {
      name: "payout_send",
      enabled: workerEnv.payoutSendEnabled,
      intervalSec: workerEnv.payoutSendIntervalSec,
      timeoutSec: workerEnv.jobTimeoutSec,
      maxRetries: workerEnv.maxRetries,
      retryBackoffSec: workerEnv.retryBackoffSec,
      jitterSec: workerEnv.jitterSec,
      lockKey: resolveFundsLockKey(workerEnv.payoutSendChainId),
      run: () =>
        runRewardsPayoutJob({
          dryRun: !allowExecute || !workerEnv.payoutSendExecute,
          confirmOnly: false,
          sendOnly: false,
          failPending: false,
          limit: workerEnv.payoutSendLimit,
          chainId: workerEnv.payoutSendChainId,
        }),
    },
  ];
}

function main() {
  if (!env.enabled) {
    log("worker_disabled", { enabledEnv: "HUNCH_FINANCE_WORKER_ENABLED" });
    keepAliveIdle();
    return;
  }

  if (!env.executeEnabled) {
    log("worker_execute_disabled", {
      executeEnv: "HUNCH_FINANCE_EXECUTE",
      message: "state-changing finance actions are forced to dry-run/read-only",
    });
  }

  const lockManager = new InMemoryLockManager();
  const scheduler = new IntervalScheduler(log, lockManager);
  const jobs = buildJobs(env);
  for (const job of jobs) {
    scheduler.schedule(job);
  }

  process.on("SIGINT", () => {
    scheduler.shutdown();
    void closeFundingReconciliationPool().finally(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    scheduler.shutdown();
    void closeFundingReconciliationPool().finally(() => process.exit(0));
  });

  log("worker_started", {
    jobs: jobs.map((job) => ({
      name: job.name,
      enabled: job.enabled,
      intervalSec: job.intervalSec,
      lockKey: job.lockKey ?? null,
    })),
  });
}

function isDirectExecution(metaUrl: string): boolean {
  const entrypoint = process.argv[1];
  if (!entrypoint) return false;
  return pathToFileURL(entrypoint).href === metaUrl;
}

if (isDirectExecution(import.meta.url)) {
  main();
}
