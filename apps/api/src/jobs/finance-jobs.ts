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
import {
  runApiCacheWarm,
  type ApiCacheWarmJobOptions,
} from "../api-cache-warm-runner.js";
import { pool, type DbQuery } from "../db.js";
import { reconcileStaleTelegramTradeIntents } from "../services/telegram-bot-trading.js";

export type ReconcileTelegramTradeIntentsOptions = {
  db?: DbQuery;
  executingGraceMs?: number;
};

export type ReconcileTelegramTradeIntentsJobSummary = {
  backfilledExecutionRefs: number;
  backfilledOrderRefs: number;
  expiredPending: number;
  failedPreSubmitExecuting: number;
  skipped?: boolean;
  skipReason?: string;
  submittedReconcileRequired: number;
  unknownSubmitReconcileRequired: number;
};

function mergeOptions<T extends object>(base: T, overrides?: Partial<T>): T {
  if (!overrides) return base;
  return { ...base, ...overrides };
}

export async function runFeesCollectJob(
  overrides?: Partial<CollectFeesOptions>,
): Promise<CollectFeesRunResult> {
  const defaults = parseCollectFeesArgs([]);
  const baseOptions = mergeOptions(defaults, {
    archiveLegacy: true,
    ...overrides,
  });

  if (overrides?.collectorVersion) {
    return runCollectFees(baseOptions);
  }

  const v2Result = await runCollectFees({
    ...baseOptions,
    collectorVersion: "v2",
  });
  const v1Result = await runCollectFees({
    ...baseOptions,
    collectorVersion: "v1",
  });

  return {
    dryRunCount: v2Result.dryRunCount + v1Result.dryRunCount,
    collected: v2Result.collected + v1Result.collected,
    skippedLive: v2Result.skippedLive + v1Result.skippedLive,
    skippedNoCharge: v2Result.skippedNoCharge + v1Result.skippedNoCharge,
    skippedNothing: v2Result.skippedNothing + v1Result.skippedNothing,
    skippedError: v2Result.skippedError + v1Result.skippedError,
  };
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

export async function isTelegramTradeIntentReconcileSchemaReady(
  db: DbQuery,
): Promise<boolean> {
  const result = await db.query<{
    has_submit_started_at: boolean;
    has_telegram_trade_intents: boolean;
  }>(
    `
      select
        exists (
          select 1
          from information_schema.tables
          where table_schema = 'public'
            and table_name = 'telegram_trade_intents'
        ) as has_telegram_trade_intents,
        exists (
          select 1
          from information_schema.columns
          where table_schema = 'public'
            and table_name = 'telegram_trade_intents'
            and column_name = 'submit_started_at'
        ) as has_submit_started_at
    `,
  );
  const row = result.rows[0];
  return Boolean(
    row?.has_telegram_trade_intents && row.has_submit_started_at,
  );
}

export async function runTelegramTradeIntentReconcileJob(
  overrides?: Partial<ReconcileTelegramTradeIntentsOptions>,
): Promise<ReconcileTelegramTradeIntentsJobSummary> {
  const db = overrides?.db ?? pool;
  if (!(await isTelegramTradeIntentReconcileSchemaReady(db))) {
    const summary = {
      backfilledExecutionRefs: 0,
      backfilledOrderRefs: 0,
      expiredPending: 0,
      failedPreSubmitExecuting: 0,
      skipped: true,
      skipReason: "telegram_trade_intents_schema_not_ready",
      submittedReconcileRequired: 0,
      unknownSubmitReconcileRequired: 0,
    } satisfies ReconcileTelegramTradeIntentsJobSummary;
    console.warn(
      "Skipping Telegram trade intents reconcile: schema is not ready.",
    );
    return summary;
  }

  const reconcileSummary = await reconcileStaleTelegramTradeIntents(db, {
    executingGraceMs: overrides?.executingGraceMs,
  });
  const summary: ReconcileTelegramTradeIntentsJobSummary = {
    ...reconcileSummary,
    skipped: false,
  };
  console.log(
    [
      "Reconcile Telegram trade intents",
      `backfilledOrderRefs=${summary.backfilledOrderRefs}`,
      `backfilledExecutionRefs=${summary.backfilledExecutionRefs}`,
      `expiredPending=${summary.expiredPending}`,
      `failedPreSubmitExecuting=${summary.failedPreSubmitExecuting}`,
      `unknownSubmitReconcileRequired=${summary.unknownSubmitReconcileRequired}`,
      `submittedReconcileRequired=${summary.submittedReconcileRequired}`,
      `skipped=${summary.skipped === true}`,
    ].join(" "),
  );
  return summary;
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
