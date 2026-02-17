import {
  runFeesCollectJob,
  runFeesReconcileJob,
  runRewardsPayoutJob,
  runTreasurySweepJob,
} from "../../api/src/jobs/finance-jobs.js";
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

function buildJobs(): ScheduledJob[] {
  const allowExecute = env.executeEnabled;
  return [
    {
      name: "fees_collect",
      enabled: env.feesCollectEnabled,
      intervalSec: env.feesCollectIntervalSec,
      timeoutSec: env.jobTimeoutSec,
      maxRetries: env.maxRetries,
      retryBackoffSec: env.retryBackoffSec,
      jitterSec: env.jitterSec,
      run: () =>
        runFeesCollectJob({
          archiveLegacy: true,
          dryRun: env.feesCollectDryRun || env.feesCollectReadOnly || !allowExecute,
          readOnly: env.feesCollectReadOnly || !allowExecute,
        }),
    },
    {
      name: "fees_reconcile",
      enabled: env.feesReconcileEnabled,
      intervalSec: env.feesReconcileIntervalSec,
      timeoutSec: env.jobTimeoutSec,
      maxRetries: env.maxRetries,
      retryBackoffSec: env.retryBackoffSec,
      jitterSec: env.jitterSec,
      run: () =>
        runFeesReconcileJob({
          dryRun: env.feesReconcileDryRun || !allowExecute,
          limit: 25,
          minAgeSec: 60,
        }),
    },
    {
      name: "treasury_sweep",
      enabled: env.treasurySweepEnabled,
      intervalSec: env.treasurySweepIntervalSec,
      timeoutSec: env.jobTimeoutSec,
      maxRetries: env.maxRetries,
      retryBackoffSec: env.retryBackoffSec,
      jitterSec: env.jitterSec,
      lockKey: resolveFundsLockKey(env.treasurySweepChainId),
      run: () =>
        runTreasurySweepJob({
          execute: allowExecute && env.treasurySweepExecute,
          dryRun: !allowExecute || !env.treasurySweepExecute,
          chainId: env.treasurySweepChainId,
          maxUsd: env.treasurySweepMaxUsd,
        }),
    },
    {
      name: "payout_prepare",
      enabled: env.payoutPrepareEnabled,
      intervalSec: env.payoutPrepareIntervalSec,
      timeoutSec: env.jobTimeoutSec,
      maxRetries: env.maxRetries,
      retryBackoffSec: env.retryBackoffSec,
      jitterSec: env.jitterSec,
      lockKey: resolveFundsLockKey(env.payoutPrepareChainId),
      run: () =>
        runRewardsPayoutJob({
          dryRun: env.payoutPrepareDryRun || !allowExecute,
          confirmOnly: true,
          sendOnly: false,
          failPending: false,
          limit: env.payoutPrepareLimit,
          chainId: env.payoutPrepareChainId,
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
  const jobs = buildJobs();
  for (const job of jobs) {
    scheduler.schedule(job);
  }

  process.on("SIGINT", () => {
    scheduler.shutdown();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    scheduler.shutdown();
    process.exit(0);
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

main();
