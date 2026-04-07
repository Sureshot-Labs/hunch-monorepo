import {
  parseCollectFeesArgs,
  runCollectFees,
  type CollectFeesOptions,
  type CollectFeesRunResult,
} from "../collect-fees.js";
import {
  parseReconcileFeesArgs,
  runReconcileFees,
  type ReconcileFeesOptions,
} from "../reconcile-fees.js";
import {
  parseReconcileKalshiExecutionsArgs,
  runReconcileKalshiExecutions,
  type ReconcileKalshiExecutionsOptions,
} from "../reconcile-kalshi-executions.js";
import {
  parseRewardsPayoutArgs,
  runRewardsPayout,
  type RewardsPayoutOptions,
} from "../rewards-payout.js";
import {
  parseRewardsTreasurySweepArgs,
  runRewardsTreasurySweep,
  type RewardsTreasurySweepOptions,
} from "../rewards-treasury-sweep.js";
import { runApiCacheWarm, type ApiCacheWarmJobOptions } from "../api-cache-warm-runner.js";

function mergeOptions<T extends object>(base: T, overrides?: Partial<T>): T {
  if (!overrides) return base;
  return { ...base, ...overrides };
}

export async function runFeesCollectJob(
  overrides?: Partial<CollectFeesOptions>,
): Promise<CollectFeesRunResult> {
  const defaults = parseCollectFeesArgs([]);
  return runCollectFees(
    mergeOptions(defaults, {
      archiveLegacy: true,
      ...overrides,
    }),
  );
}

export async function runFeesReconcileJob(
  overrides?: Partial<ReconcileFeesOptions>,
) {
  const defaults = parseReconcileFeesArgs([]);
  return runReconcileFees(mergeOptions(defaults, overrides));
}

export async function runKalshiExecutionReconcileJob(
  overrides?: Partial<ReconcileKalshiExecutionsOptions>,
) {
  const defaults = parseReconcileKalshiExecutionsArgs([]);
  return runReconcileKalshiExecutions(mergeOptions(defaults, overrides));
}

export async function runRewardsPayoutJob(
  overrides?: Partial<RewardsPayoutOptions>,
) {
  const defaults = parseRewardsPayoutArgs([]);
  return runRewardsPayout(mergeOptions(defaults, overrides));
}

export async function runTreasurySweepJob(
  overrides?: Partial<RewardsTreasurySweepOptions>,
) {
  const defaults = parseRewardsTreasurySweepArgs([]);
  return runRewardsTreasurySweep(mergeOptions(defaults, overrides));
}

export async function runApiCacheWarmJob(
  overrides?: Partial<ApiCacheWarmJobOptions>,
) {
  return runApiCacheWarm(overrides);
}

export type {
  ApiCacheWarmJobOptions,
  CollectFeesOptions,
  CollectFeesRunResult,
  ReconcileKalshiExecutionsOptions,
  ReconcileFeesOptions,
  RewardsPayoutOptions,
  RewardsTreasurySweepOptions,
};
