#!/usr/bin/env tsx

import { randomUUID } from "node:crypto";

import { createRedisClient, ensureRedis } from "@hunch/infra";

import {
  runHolderResearch,
  withPolicyOverrides,
  type HolderResearchRunArgs,
} from "./ai-holder-research-run.js";
import { pool } from "./db.js";
import { env } from "./env.js";
import { closeRedis } from "./redis.js";
import { resolveHolderResearchPolicy } from "./services/runtime-policies.js";
import {
  releaseHolderResearchRunLock,
  renewHolderResearchRunLock,
} from "./services/holder-research-run-lock.js";
import {
  budgetedHolderResearchJevCalls,
  HOLDER_RESEARCH_JEV_CALL_RESERVE_USD,
} from "./services/holder-research-jev.js";
import { HOLDER_BACKGROUND_RESERVE_USD } from "./services/holder-research-background.js";

const KEY_PREFIX = "ai:holder_research:v1";
const LOCK_KEY = `${KEY_PREFIX}:lock`;
const RUNS_KEY = `${KEY_PREFIX}:runs`;
const STATUS_KEY = `${KEY_PREFIX}:status:last`;
const RUN_HISTORY_TTL_MS = 60 * 60 * 24 * 14 * 1_000;

type RunnerArgs = HolderResearchRunArgs & {
  force: boolean;
  ignoreBudget: boolean;
};

type RunHistoryEntry = {
  runId: string;
  ts: number;
  estimatedCostUsd: number;
  chargedCostUsd: number;
  externalSearchEstimatedCostUsd: number;
  externalSearchChargedCostUsd: number;
  triageEstimatedCostUsd?: number;
  triageChargedCostUsd?: number;
  jevChargedCostUsd?: number;
  result: "ok" | "dry_run" | "skipped" | "error";
};

function hasFlag(argv: string[], flag: string): boolean {
  return argv.some((arg) => arg === flag);
}

function parseFlag(argv: string[], flag: string): string | undefined {
  const prefix = `${flag}=`;
  const inline = argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = argv.indexOf(flag);
  if (index === -1) return undefined;
  return argv[index + 1];
}

function parseBool(raw: string | undefined): boolean | null {
  if (!raw) return null;
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return null;
}

function parsePositiveInt(raw: string | undefined): number | null {
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return null;
  const asInt = Math.trunc(parsed);
  return asInt > 0 ? asInt : null;
}

function parseRunnerArgs(argv: string[]): RunnerArgs {
  return {
    force: hasFlag(argv, "--force"),
    ignoreBudget: hasFlag(argv, "--ignore-budget"),
    dryRun: hasFlag(argv, "--dry-run")
      ? true
      : hasFlag(argv, "--no-dry-run")
        ? false
        : parseBool(parseFlag(argv, "--dry-run")),
    callModel: hasFlag(argv, "--call-model"),
    externalSearch: hasFlag(argv, "--external-search")
      ? true
      : hasFlag(argv, "--no-external-search")
        ? false
        : parseBool(parseFlag(argv, "--external-search")),
    persistNotes: hasFlag(argv, "--persist")
      ? true
      : hasFlag(argv, "--no-persist")
        ? false
        : parseBool(parseFlag(argv, "--persist")),
    model: parseFlag(argv, "--model")?.trim() || null,
    triageModel: parseFlag(argv, "--triage-model")?.trim() || null,
    limit: parsePositiveInt(parseFlag(argv, "--limit")),
    maxAgentCalls: parsePositiveInt(parseFlag(argv, "--max-agent-calls")),
    maxOutputTokens: parsePositiveInt(parseFlag(argv, "--max-output-tokens")),
    outPath: parseFlag(argv, "--out")?.trim() || null,
    triageBatchSize: parsePositiveInt(parseFlag(argv, "--triage-batch-size")),
    triageMaxBatches: parsePositiveInt(parseFlag(argv, "--triage-max-batches")),
    includePerformanceReport: hasFlag(argv, "--include-performance-report"),
    verbose: hasFlag(argv, "--verbose"),
  };
}

async function readRunHistory(redis: ReturnType<typeof createRedisClient>) {
  const raw: string[] = await redis.lRange(RUNS_KEY, 0, 200);
  return raw
    .map((entry: string) => {
      try {
        return JSON.parse(entry) as RunHistoryEntry;
      } catch {
        return null;
      }
    })
    .filter(
      (entry: RunHistoryEntry | null): entry is RunHistoryEntry =>
        entry != null,
    );
}

export async function runHolderResearchRunner(
  args: RunnerArgs = parseRunnerArgs(process.argv.slice(2)),
): Promise<void> {
  if (!env.redisUrl) {
    throw new Error("[holder-research-runner] REDIS_URL is required");
  }
  const redis = createRedisClient({ url: env.redisUrl });
  await ensureRedis(redis, {
    waitForReady: true,
    logLabel: "holder-research-runner",
  });
  let lockValue: string | null = null;
  let heartbeatTimer: NodeJS.Timeout | null = null;
  try {
    const policyResult = await resolveHolderResearchPolicy(pool);
    const policy = withPolicyOverrides(policyResult.effective, args);

    if (!policy.enabled && !args.force) {
      const payload = {
        result: "skipped",
        reason: "policy_disabled",
        at: new Date().toISOString(),
      };
      await redis.set(STATUS_KEY, JSON.stringify(payload), {
        PX: RUN_HISTORY_TTL_MS,
      });
      console.log(JSON.stringify(payload, null, 2));
      return;
    }

    const modelCallsEstimate = args.callModel
      ? policy.maxAgentCallsPerRun * policy.estimatedCallCostUsd
      : 0;
    const triageEstimate =
      args.callModel && policy.triageEnabled
        ? policy.triageMaxBatchesPerRun * policy.estimatedTriageCallCostUsd
        : 0;
    const externalSearchEstimate =
      (args.externalSearch ?? policy.externalSearchEnabled)
        ? policy.maxExternalSearchCallsPerRun *
          policy.estimatedExternalSearchCostUsd
        : 0;
    const estimate =
      modelCallsEstimate + triageEstimate + externalSearchEstimate;
    let jevBudgetAvailable = true;
    let jevMaxCalls = policy.maxCandidatesPerRun;
    let backgroundBudgetAvailable = true;
    if (!args.ignoreBudget) {
      const now = Date.now();
      const history = (await readRunHistory(redis)).filter(
        (entry: RunHistoryEntry) => now - entry.ts <= 24 * 60 * 60 * 1_000,
      );
      const spent = history.reduce(
        (sum: number, entry: RunHistoryEntry) =>
          sum +
          entry.chargedCostUsd +
          entry.externalSearchChargedCostUsd +
          (entry.triageChargedCostUsd ?? 0) +
          (entry.jevChargedCostUsd ?? 0),
        0,
      );
      if (history.length >= policy.maxRunsPerDay) {
        const payload = {
          result: "skipped",
          reason: "max_runs_per_day",
          runsToday: history.length,
          at: new Date().toISOString(),
        };
        await redis.set(STATUS_KEY, JSON.stringify(payload), {
          PX: RUN_HISTORY_TTL_MS,
        });
        console.log(JSON.stringify(payload, null, 2));
        return;
      }
      if (spent + estimate > policy.dayBudgetUsd) {
        const payload = {
          result: "skipped",
          reason: "day_budget",
          spent,
          estimate,
          dayBudgetUsd: policy.dayBudgetUsd,
          at: new Date().toISOString(),
        };
        await redis.set(STATUS_KEY, JSON.stringify(payload), {
          PX: RUN_HISTORY_TTL_MS,
        });
        console.log(JSON.stringify(payload, null, 2));
        return;
      }
      jevMaxCalls = budgetedHolderResearchJevCalls({
        spentUsd: spent,
        baseEstimateUsd: estimate,
        dayBudgetUsd: policy.dayBudgetUsd,
        maxCalls: policy.maxCandidatesPerRun,
      });
      jevBudgetAvailable = jevMaxCalls > 0;
      backgroundBudgetAvailable =
        spent +
          estimate +
          (policy.jevPreTriageEnabled && jevBudgetAvailable
            ? jevMaxCalls * HOLDER_RESEARCH_JEV_CALL_RESERVE_USD
            : 0) +
          Math.min(8, policy.maxCandidatesPerRun) *
            HOLDER_BACKGROUND_RESERVE_USD <=
        policy.dayBudgetUsd;
    }

    lockValue = `${process.pid}:${randomUUID()}`;
    const owner = lockValue;
    const lockTtlMs = policy.maxRuntimeSeconds * 1_000;
    const locked = await redis.set(LOCK_KEY, lockValue, {
      PX: lockTtlMs,
      NX: true,
    });
    if (locked !== "OK") {
      const payload = {
        result: "skipped",
        reason: "lock_held",
        at: new Date().toISOString(),
      };
      await redis.set(STATUS_KEY, JSON.stringify(payload), {
        PX: RUN_HISTORY_TTL_MS,
      });
      console.log(JSON.stringify(payload, null, 2));
      return;
    }

    let lockLost = false;
    let heartbeatRenewal: Promise<void> | null = null;
    heartbeatTimer = setInterval(
      () => {
        if (heartbeatRenewal || lockLost) return;
        heartbeatRenewal = renewHolderResearchRunLock({
          redis,
          key: LOCK_KEY,
          owner,
          ttlMs: lockTtlMs,
        })
          .then((renewed) => {
            if (renewed) return;
            lockLost = true;
            if (heartbeatTimer) clearInterval(heartbeatTimer);
            console.error("[holder-research-runner] lock ownership lost");
          })
          .catch((error) => {
            console.warn("[holder-research-runner] lock renewal failed", {
              error: error instanceof Error ? error.message : String(error),
            });
          })
          .finally(() => {
            heartbeatRenewal = null;
          });
      },
      Math.max(250, Math.min(30_000, Math.floor(lockTtlMs / 3))),
    );
    heartbeatTimer.unref();

    let jevChargedCostUsd = 0;
    let externalSearchChargedCostUsd = 0;
    try {
      const report = await runHolderResearch(args, {
        decisionCacheRedis: redis,
        priceRefreshRedis: redis,
        backgroundRedis: redis,
        jevBudgetAvailable,
        jevMaxCalls,
        backgroundBudgetAvailable,
        assertCanPersist: async () => {
          if (lockLost) throw new Error("holder_research_lock_lost");
          const renewed = await renewHolderResearchRunLock({
            redis,
            key: LOCK_KEY,
            owner,
            ttlMs: lockTtlMs,
          });
          if (!renewed) {
            lockLost = true;
            throw new Error("holder_research_lock_lost");
          }
        },
        onJevCost: (costUsd) => {
          jevChargedCostUsd = costUsd;
        },
        onExternalSearchCost: (costUsd) => {
          externalSearchChargedCostUsd = costUsd;
        },
      });
      const entry: RunHistoryEntry = {
        runId: report.runId,
        ts: Date.now(),
        estimatedCostUsd: report.totals.estimatedCostUsd,
        chargedCostUsd: report.totals.chargedCostUsd,
        externalSearchEstimatedCostUsd:
          report.totals.externalSearchEstimatedCostUsd,
        externalSearchChargedCostUsd:
          report.totals.externalSearchChargedCostUsd,
        triageEstimatedCostUsd: report.totals.triageEstimatedCostUsd,
        triageChargedCostUsd: report.totals.triageChargedCostUsd,
        jevChargedCostUsd: report.totals.jevChargedCostUsd,
        result: report.dryRun ? "dry_run" : "ok",
      };
      await redis
        .multi()
        .lPush(RUNS_KEY, JSON.stringify(entry))
        .lTrim(RUNS_KEY, 0, 200)
        .pExpire(RUNS_KEY, RUN_HISTORY_TTL_MS)
        .set(STATUS_KEY, JSON.stringify(entry), { PX: RUN_HISTORY_TTL_MS })
        .exec();
    } catch (error) {
      const entry: RunHistoryEntry = {
        runId: `error:${randomUUID()}`,
        ts: Date.now(),
        estimatedCostUsd: 0,
        chargedCostUsd: 0,
        externalSearchEstimatedCostUsd: 0,
        externalSearchChargedCostUsd,
        jevChargedCostUsd,
        result: "error",
      };
      if (jevChargedCostUsd > 0 || externalSearchChargedCostUsd > 0) {
        await redis
          .multi()
          .lPush(RUNS_KEY, JSON.stringify(entry))
          .lTrim(RUNS_KEY, 0, 200)
          .pExpire(RUNS_KEY, RUN_HISTORY_TTL_MS)
          .exec();
      }
      await redis.set(
        STATUS_KEY,
        JSON.stringify({
          ...entry,
          error: error instanceof Error ? error.message : String(error),
        }),
        { PX: RUN_HISTORY_TTL_MS },
      );
      throw error;
    } finally {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      await heartbeatRenewal;
      if (lockValue) {
        await releaseHolderResearchRunLock({
          redis,
          key: LOCK_KEY,
          owner: lockValue,
        });
      }
    }
  } finally {
    await redis.quit().catch(() => undefined);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    await runHolderResearchRunner();
  } finally {
    await closeRedis();
    await pool.end();
  }
}
