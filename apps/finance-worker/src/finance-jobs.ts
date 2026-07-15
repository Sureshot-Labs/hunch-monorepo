type CollectFeesOptions = {
  archiveLegacy?: boolean;
  dryRun?: boolean;
  readOnly?: boolean;
};

type CollectFeesRunResult = {
  dryRunCount: number;
  collected: number;
  skippedLive: number;
  skippedNoCharge: number;
  skippedNothing: number;
  skippedError: number;
};

type ReconcileFeesOptions = {
  dryRun?: boolean;
  limit?: number;
  minAgeSec?: number;
};

type ReconcileKalshiExecutionsOptions = {
  dryRun?: boolean;
  limit?: number;
  minAgeSec?: number;
};

type ReconcileTelegramTradeIntentsOptions = {
  executingGraceMs?: number;
};

type RewardsPayoutOptions = {
  dryRun?: boolean;
  confirmOnly?: boolean;
  sendOnly?: boolean;
  failPending?: boolean;
  limit?: number;
  chainId?: string;
};

type RewardsTreasurySweepOptions = {
  execute?: boolean;
  dryRun?: boolean;
  chainId?: string;
  maxUsd?: string;
};

type ApiCacheWarmJobOptions = {
  force?: boolean;
};

type FinanceJobsModule = {
  runFeesCollectJob: (
    overrides?: Partial<CollectFeesOptions>,
  ) => Promise<CollectFeesRunResult>;
  runFeesReconcileJob: (
    overrides?: Partial<ReconcileFeesOptions>,
  ) => Promise<unknown>;
  runKalshiExecutionReconcileJob: (
    overrides?: Partial<ReconcileKalshiExecutionsOptions>,
  ) => Promise<unknown>;
  runTelegramTradeIntentReconcileJob: (
    overrides?: Partial<ReconcileTelegramTradeIntentsOptions>,
  ) => Promise<unknown>;
  runPositionResolutionNotificationJob: () => Promise<unknown>;
  runRewardsPayoutJob: (
    overrides?: Partial<RewardsPayoutOptions>,
  ) => Promise<unknown>;
  runTreasurySweepJob: (
    overrides?: Partial<RewardsTreasurySweepOptions>,
  ) => Promise<unknown>;
  runApiCacheWarmJob: (
    overrides?: Partial<ApiCacheWarmJobOptions>,
  ) => Promise<unknown>;
};

type FinanceJobsModuleLoader = () => Promise<FinanceJobsModule>;

let modulePromise: Promise<FinanceJobsModule> | null = null;
let financeJobsModuleLoader: FinanceJobsModuleLoader =
  loadFinanceJobsModuleDefault;

async function loadFinanceJobsModuleDefault(): Promise<FinanceJobsModule> {
  const isTsxRuntime = import.meta.url.endsWith(".ts");
  if (isTsxRuntime) {
    const sourceUrl = new URL(
      "../../api/src/jobs/finance-jobs.ts",
      import.meta.url,
    );
    return (await import(sourceUrl.href)) as FinanceJobsModule;
  }

  const moduleId: string = "api/jobs/finance-jobs";
  return (await import(moduleId)) as FinanceJobsModule;
}

async function getFinanceJobsModule(): Promise<FinanceJobsModule> {
  if (!modulePromise) {
    modulePromise = financeJobsModuleLoader();
  }
  return modulePromise;
}

export function setFinanceJobsModuleLoaderForTests(
  loader: FinanceJobsModuleLoader,
): void {
  modulePromise = null;
  financeJobsModuleLoader = loader;
}

export function resetFinanceJobsModuleLoaderForTests(): void {
  modulePromise = null;
  financeJobsModuleLoader = loadFinanceJobsModuleDefault;
}

export async function loadFinanceJobsModuleForSmoke(): Promise<FinanceJobsModule> {
  return getFinanceJobsModule();
}

export async function runFeesCollectJob(
  overrides?: Partial<CollectFeesOptions>,
): Promise<CollectFeesRunResult> {
  const jobs = await getFinanceJobsModule();
  return jobs.runFeesCollectJob(overrides);
}

export async function runFeesReconcileJob(
  overrides?: Partial<ReconcileFeesOptions>,
): Promise<unknown> {
  const jobs = await getFinanceJobsModule();
  return jobs.runFeesReconcileJob(overrides);
}

export async function runKalshiExecutionReconcileJob(
  overrides?: Partial<ReconcileKalshiExecutionsOptions>,
): Promise<unknown> {
  const jobs = await getFinanceJobsModule();
  return jobs.runKalshiExecutionReconcileJob(overrides);
}

export async function runTelegramTradeIntentReconcileJob(
  overrides?: Partial<ReconcileTelegramTradeIntentsOptions>,
): Promise<unknown> {
  const jobs = await getFinanceJobsModule();
  return jobs.runTelegramTradeIntentReconcileJob(overrides);
}

export async function runPositionResolutionNotificationJob(): Promise<unknown> {
  const jobs = await getFinanceJobsModule();
  return jobs.runPositionResolutionNotificationJob();
}

export async function runRewardsPayoutJob(
  overrides?: Partial<RewardsPayoutOptions>,
): Promise<unknown> {
  const jobs = await getFinanceJobsModule();
  return jobs.runRewardsPayoutJob(overrides);
}

export async function runTreasurySweepJob(
  overrides?: Partial<RewardsTreasurySweepOptions>,
): Promise<unknown> {
  const jobs = await getFinanceJobsModule();
  return jobs.runTreasurySweepJob(overrides);
}

export async function runApiCacheWarmJob(
  overrides?: Partial<ApiCacheWarmJobOptions>,
): Promise<unknown> {
  const jobs = await getFinanceJobsModule();
  return jobs.runApiCacheWarmJob(overrides);
}
