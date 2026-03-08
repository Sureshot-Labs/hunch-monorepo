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

type FinanceJobsModule = {
  runFeesCollectJob: (
    overrides?: Partial<CollectFeesOptions>,
  ) => Promise<CollectFeesRunResult>;
  runFeesReconcileJob: (
    overrides?: Partial<ReconcileFeesOptions>,
  ) => Promise<unknown>;
  runRewardsPayoutJob: (
    overrides?: Partial<RewardsPayoutOptions>,
  ) => Promise<unknown>;
  runTreasurySweepJob: (
    overrides?: Partial<RewardsTreasurySweepOptions>,
  ) => Promise<unknown>;
};

let modulePromise: Promise<FinanceJobsModule> | null = null;

async function loadFinanceJobsModule(): Promise<FinanceJobsModule> {
  const moduleId = "api/jobs/finance-jobs";
  return (await import(moduleId)) as FinanceJobsModule;
}

async function getFinanceJobsModule(): Promise<FinanceJobsModule> {
  if (!modulePromise) {
    modulePromise = loadFinanceJobsModule();
  }
  return modulePromise;
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
