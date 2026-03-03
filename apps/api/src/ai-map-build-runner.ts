import { randomUUID } from "node:crypto";
import { createRedisClient, ensureRedis } from "@hunch/infra";
import { pool } from "./db.js";
import { env } from "./env.js";
import { runMarketMapBuild } from "./lib/map-news/map-build-core.js";
import { resolveMarketMapPolicy } from "./services/runtime-policies.js";

const LOCK_KEY = "ai:map_build:v1:lock";
const RUNS_KEY = "ai:map_build:v1:runs";
const STATUS_KEY = "ai:map_build:v1:status:last";
const STATUS_TTL_SEC = 60 * 60 * 24 * 7;
const RUN_HISTORY_TTL_MS = 60 * 60 * 24 * 14 * 1_000;

type RunnerOptions = {
  force: boolean;
  ignorePolicyRate: boolean;
  ignorePolicyBudget: boolean;
  dryRun: boolean;
  verbose: boolean;
  passthroughArgs: string[];
};

type RunEntry = {
  runId: string;
  ts: number;
  costUsd: number;
  estimatedCostUsd?: number;
  chargedCostUsd?: number;
  providerReportedCostUsd?: number;
  providerReportedCostCalls?: number;
  costSource?: "estimated" | "provider_reported" | "mixed";
  result: "ok" | "error" | "dry_run";
};

function hasFlag(args: string[], flag: string): boolean {
  return args.some((arg) => arg === flag);
}

function parseRunnerArgs(argv: string[]): RunnerOptions {
  const passthroughArgs: string[] = [];
  let force = false;
  let ignorePolicyRate = false;
  let ignorePolicyBudget = false;
  let dryRun = false;
  let verbose = false;

  for (const arg of argv) {
    if (arg === "--help") {
      printHelp();
      process.exit(0);
    }
    if (arg === "--force") {
      force = true;
      continue;
    }
    if (arg === "--ignore-policy-rate") {
      ignorePolicyRate = true;
      continue;
    }
    if (arg === "--ignore-policy-budget") {
      ignorePolicyBudget = true;
      continue;
    }
    if (arg === "--dry-run") {
      dryRun = true;
      passthroughArgs.push(arg);
      continue;
    }
    if (arg === "--verbose") {
      verbose = true;
      continue;
    }
    passthroughArgs.push(arg);
  }

  if (force) {
    ignorePolicyRate = true;
    ignorePolicyBudget = true;
  }

  return {
    force,
    ignorePolicyRate,
    ignorePolicyBudget,
    dryRun,
    verbose,
    passthroughArgs,
  };
}

function sanitizeBuildArgs(args: string[]): string[] {
  return args.filter((arg) => {
    if (arg === "--enabled") return false;
    if (arg.startsWith("--enabled=")) return false;
    return true;
  });
}

function parseRunEntries(rawMembers: string[]): RunEntry[] {
  const entries: RunEntry[] = [];
  for (const raw of rawMembers) {
    try {
      const parsed = JSON.parse(raw) as Partial<RunEntry>;
      if (
        typeof parsed.runId !== "string" ||
        typeof parsed.ts !== "number" ||
        typeof parsed.costUsd !== "number" ||
        (parsed.result !== "ok" &&
          parsed.result !== "error" &&
          parsed.result !== "dry_run")
      ) {
        continue;
      }
      const chargedCostUsd =
        typeof parsed.chargedCostUsd === "number"
          ? parsed.chargedCostUsd
          : parsed.costUsd;
      const estimatedCostUsd =
        typeof parsed.estimatedCostUsd === "number"
          ? parsed.estimatedCostUsd
          : parsed.costUsd;
      const providerReportedCostUsd =
        typeof parsed.providerReportedCostUsd === "number"
          ? parsed.providerReportedCostUsd
          : 0;
      const providerReportedCostCalls =
        typeof parsed.providerReportedCostCalls === "number"
          ? parsed.providerReportedCostCalls
          : 0;
      const costSource =
        parsed.costSource === "estimated" ||
        parsed.costSource === "provider_reported" ||
        parsed.costSource === "mixed"
          ? parsed.costSource
          : providerReportedCostCalls > 0
            ? "provider_reported"
            : "estimated";
      entries.push({
        ...parsed,
        runId: parsed.runId,
        ts: parsed.ts,
        costUsd: parsed.costUsd,
        estimatedCostUsd,
        chargedCostUsd,
        providerReportedCostUsd,
        providerReportedCostCalls,
        costSource,
        result: parsed.result,
      });
    } catch {
      // ignore malformed entries
    }
  }
  return entries;
}

function sumCost(entries: RunEntry[]): number {
  return entries.reduce(
    (acc, item) =>
      acc + (typeof item.chargedCostUsd === "number" ? item.chargedCostUsd : item.costUsd),
    0,
  );
}

function previewError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function printHelp(): void {
  console.log(`Usage: pnpm -C hunch-monorepo -F api run ai:map-build:runner -- [options]

Options:
  --force                   Bypass policy enabled/rate/budget gates
  --ignore-policy-rate      Ignore poll/run-window/day run-count gates
  --ignore-policy-budget    Ignore budget-window/day budget gates
  --dry-run                 Forward dry-run to market-map build (no Redis snapshot writes)
  --verbose                 Print additional debug details
  --help                    Show this help

All other args are passed through to ai:map-build:run.
`);
}

async function setStatus(
  redis: ReturnType<typeof createRedisClient>,
  payload: Record<string, string | number | null>,
): Promise<void> {
  const cleaned = Object.fromEntries(
    Object.entries(payload).map(([key, value]) => [key, value ?? ""]),
  );
  await redis.hSet(STATUS_KEY, cleaned);
  await redis.expire(STATUS_KEY, STATUS_TTL_SEC);
}

function installSignalHandlers(
  onSignal: (signal: "SIGINT" | "SIGTERM") => Promise<void>,
): () => void {
  const signals: Array<"SIGINT" | "SIGTERM"> = ["SIGINT", "SIGTERM"];
  const wrappedHandlers = new Map<
    "SIGINT" | "SIGTERM",
    (signal: NodeJS.Signals) => void
  >();

  for (const signal of signals) {
    const handler = () => {
      void onSignal(signal);
    };
    wrappedHandlers.set(signal, handler);
    process.once(signal, handler);
  }

  return () => {
    for (const signal of signals) {
      const handler = wrappedHandlers.get(signal);
      if (handler) {
        process.removeListener(signal, handler);
      }
    }
  };
}

async function main() {
  const args = parseRunnerArgs(process.argv.slice(2));
  const policy = await resolveMarketMapPolicy(pool);
  const config = policy.effective;

  if (!env.redisUrl) {
    throw new Error("[map-build-runner] REDIS_URL is required");
  }

  if (!config.enabled && !args.force) {
    console.log("[map-build-runner] skipped (policy disabled)");
    return;
  }

  const redis = createRedisClient({ url: env.redisUrl });
  await ensureRedis(redis, { waitForReady: true, logLabel: "map-build-runner" });
  const lockValue = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const runId = lockValue;
  const nowMs = Date.now();
  let released = false;
  let shuttingDownBySignal = false;
  let heartbeatTimer: NodeJS.Timeout | null = null;
  let heartbeatInFlight = false;

  const releaseLockAndRedis = async (): Promise<void> => {
    if (released) return;
    released = true;
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    try {
      const currentLockValue = await redis.get(LOCK_KEY);
      if (currentLockValue === lockValue) {
        await redis.del(LOCK_KEY);
      }
    } finally {
      await redis.quit();
    }
  };

  const detachSignalHandlers = installSignalHandlers(async (signal) => {
    if (shuttingDownBySignal) return;
    shuttingDownBySignal = true;
    console.warn(`[map-build-runner] received ${signal}, releasing lock and exiting`);
    try {
      await setStatus(redis, {
        state: "aborted",
        reason: `aborted_${signal.toLowerCase()}`,
        runId,
        at: new Date().toISOString(),
      });
    } catch {
      // best effort status update
    }
    try {
      await releaseLockAndRedis();
    } finally {
      await pool.end();
      process.exit(130);
    }
  });

  const renewLock = async (): Promise<void> => {
    if (released || heartbeatInFlight) return;
    heartbeatInFlight = true;
    try {
      const currentLockValue = await redis.get(LOCK_KEY);
      if (currentLockValue !== lockValue) {
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = null;
        }
        return;
      }
      await redis.expire(LOCK_KEY, config.lockTtlSec);
    } catch {
      // best effort renewal
    } finally {
      heartbeatInFlight = false;
    }
  };

  const startHeartbeat = () => {
    const intervalSec = Math.max(
      5,
      Math.min(config.lockHeartbeatSec, Math.max(5, Math.floor(config.lockTtlSec / 2))),
    );
    heartbeatTimer = setInterval(() => {
      void renewLock();
    }, intervalSec * 1_000);
    heartbeatTimer.unref();
  };

  try {
    const acquired = await redis.set(LOCK_KEY, lockValue, {
      NX: true,
      EX: config.lockTtlSec,
    });
    if (acquired !== "OK") {
      console.log("[map-build-runner] skipped (lock active)");
      await setStatus(redis, {
        state: "skipped",
        reason: "skipped_lock_active",
        runId,
        at: new Date(nowMs).toISOString(),
      });
      return;
    }

    startHeartbeat();

    await redis.zRemRangeByScore(RUNS_KEY, 0, nowMs - RUN_HISTORY_TTL_MS);

    const historyRaw = await redis.zRangeByScore(RUNS_KEY, nowMs - RUN_HISTORY_TTL_MS, nowMs);
    const history = parseRunEntries(historyRaw);
    const lastRunMs = history.reduce((max, item) => Math.max(max, item.ts), 0);
    const windowStartMs = nowMs - config.runWindowMinutes * 60_000;
    const dayStartMs = nowMs - 24 * 60 * 60 * 1_000;
    const budgetWindowStartMs = nowMs - config.budgetWindowMinutes * 60_000;

    const runsInWindow = history.filter((item) => item.ts >= windowStartMs);
    const runsInDay = history.filter((item) => item.ts >= dayStartMs);
    const runsInBudgetWindow = history.filter((item) => item.ts >= budgetWindowStartMs);
    const budgetWindowSpentUsd = sumCost(runsInBudgetWindow);
    const daySpentUsd = sumCost(runsInDay);
    const estimatedCostUsd = args.dryRun ? 0 : config.estimatedRunCostUsd;

    if (!args.ignorePolicyRate) {
      if (lastRunMs > 0 && nowMs - lastRunMs < config.pollIntervalSec * 1_000) {
        console.log("[map-build-runner] skipped (poll interval)");
        await setStatus(redis, {
          state: "skipped",
          reason: "skipped_poll_interval",
          runId,
          at: new Date(nowMs).toISOString(),
        });
        return;
      }
      if (runsInWindow.length >= config.maxRunsPerWindow) {
        console.log("[map-build-runner] skipped (run window cap)");
        await setStatus(redis, {
          state: "skipped",
          reason: "skipped_run_rate_window",
          runId,
          at: new Date(nowMs).toISOString(),
          runsInWindow: runsInWindow.length,
          maxRunsPerWindow: config.maxRunsPerWindow,
        });
        return;
      }
      if (runsInDay.length >= config.maxRunsPerDay) {
        console.log("[map-build-runner] skipped (day run cap)");
        await setStatus(redis, {
          state: "skipped",
          reason: "skipped_run_rate_day",
          runId,
          at: new Date(nowMs).toISOString(),
          runsInDay: runsInDay.length,
          maxRunsPerDay: config.maxRunsPerDay,
        });
        return;
      }
    }

    if (!args.ignorePolicyBudget) {
      if (budgetWindowSpentUsd + estimatedCostUsd > config.budgetWindowUsd) {
        console.log("[map-build-runner] skipped (budget window cap)");
        await setStatus(redis, {
          state: "skipped",
          reason: "skipped_budget_window",
          runId,
          at: new Date(nowMs).toISOString(),
          budgetWindowSpentUsd,
          budgetWindowUsd: config.budgetWindowUsd,
          estimatedCostUsd,
        });
        return;
      }
      if (daySpentUsd + estimatedCostUsd > config.dayBudgetUsd) {
        console.log("[map-build-runner] skipped (day budget cap)");
        await setStatus(redis, {
          state: "skipped",
          reason: "skipped_budget_day",
          runId,
          at: new Date(nowMs).toISOString(),
          daySpentUsd,
          dayBudgetUsd: config.dayBudgetUsd,
          estimatedCostUsd,
        });
        return;
      }
    }

    if (args.verbose) {
      console.log("[map-build-runner] executing", {
        source: policy.source,
        effectiveAt: policy.effectiveAt?.toISOString() ?? null,
        triggerMode: config.triggerMode,
        pollIntervalSec: config.pollIntervalSec,
        runWindowMinutes: config.runWindowMinutes,
        maxRunsPerWindow: config.maxRunsPerWindow,
        maxRunsPerDay: config.maxRunsPerDay,
        budgetWindowMinutes: config.budgetWindowMinutes,
        budgetWindowUsd: config.budgetWindowUsd,
        dayBudgetUsd: config.dayBudgetUsd,
        estimatedRunCostUsd: estimatedCostUsd,
        ignorePolicyRate: args.ignorePolicyRate,
        ignorePolicyBudget: args.ignorePolicyBudget,
      });
    }

    await setStatus(redis, {
      state: "running",
      reason: "started",
      runId,
      at: new Date(nowMs).toISOString(),
    });

    const buildArgs = sanitizeBuildArgs(args.passthroughArgs);
    buildArgs.push("--enabled=true");
    if (args.force) buildArgs.push("--force");
    if (args.dryRun && !hasFlag(buildArgs, "--dry-run")) {
      buildArgs.push("--dry-run");
    }

    try {
      const buildResult = await runMarketMapBuild(buildArgs);
      const actualEstimatedCostUsd = args.dryRun
        ? 0
        : buildResult.labelCostSummary.estimatedCostUsd;
      const actualChargedCostUsd = args.dryRun
        ? 0
        : buildResult.labelCostSummary.chargedCostUsd;
      const providerReportedCostUsd = args.dryRun
        ? 0
        : buildResult.labelCostSummary.providerReportedCostUsd;
      const providerReportedCostCalls = args.dryRun
        ? 0
        : buildResult.labelCostSummary.providerReportedCostCalls;
      const costSource: "estimated" | "provider_reported" | "mixed" = args.dryRun
        ? "estimated"
        : providerReportedCostCalls <= 0
          ? "estimated"
          : providerReportedCostCalls >= buildResult.labelCostSummary.attempted
            ? "provider_reported"
            : "mixed";
      const finishedAt = Date.now();
      const runEntry: RunEntry = {
        runId,
        ts: finishedAt,
        costUsd: actualChargedCostUsd,
        estimatedCostUsd: actualEstimatedCostUsd,
        chargedCostUsd: actualChargedCostUsd,
        providerReportedCostUsd,
        providerReportedCostCalls,
        costSource,
        result: args.dryRun ? "dry_run" : "ok",
      };
      await redis.zAdd(RUNS_KEY, {
        score: finishedAt,
        value: JSON.stringify(runEntry),
      });
      if (!args.dryRun && providerReportedCostCalls === 0) {
        console.warn(
          `[map-build-runner] warning runId=${runId} no provider-reported label cost; using estimated fallback`,
        );
      }
      const postWindowStartMs = finishedAt - config.runWindowMinutes * 60_000;
      const postDayStartMs = finishedAt - 24 * 60 * 60 * 1_000;
      const postBudgetWindowStartMs =
        finishedAt - config.budgetWindowMinutes * 60_000;
      const historyAfter = [...history, runEntry];
      const postRunsInWindow = historyAfter.filter(
        (item) => item.ts >= postWindowStartMs,
      );
      const postRunsInDay = historyAfter.filter((item) => item.ts >= postDayStartMs);
      const postRunsInBudgetWindow = historyAfter.filter(
        (item) => item.ts >= postBudgetWindowStartMs,
      );
      const postBudgetWindowSpentUsd = sumCost(postRunsInBudgetWindow);
      const postDaySpentUsd = sumCost(postRunsInDay);
      await setStatus(redis, {
        state: args.dryRun ? "dry_run" : "completed",
        reason: "ok",
        runId,
        at: new Date(finishedAt).toISOString(),
        estimatedCostUsd,
        actualEstimatedCostUsd,
        actualChargedCostUsd,
        providerReportedCostUsd,
        providerReportedCostCalls,
        costSource,
        redisRunId: buildResult.redisRunId,
        runWindowMinutes: config.runWindowMinutes,
        runsInWindow: postRunsInWindow.length,
        maxRunsPerWindow: config.maxRunsPerWindow,
        maxRunsPerDay: config.maxRunsPerDay,
        runsInDay: postRunsInDay.length,
        budgetWindowMinutes: config.budgetWindowMinutes,
        budgetWindowUsd: config.budgetWindowUsd,
        budgetWindowSpentUsd: Number(postBudgetWindowSpentUsd.toFixed(6)),
        budgetWindowRemainingUsd: Number(
          Math.max(0, config.budgetWindowUsd - postBudgetWindowSpentUsd).toFixed(6),
        ),
        dayBudgetUsd: config.dayBudgetUsd,
        daySpentUsd: Number(postDaySpentUsd.toFixed(6)),
        dayBudgetRemainingUsd: Number(
          Math.max(0, config.dayBudgetUsd - postDaySpentUsd).toFixed(6),
        ),
        providerReportedCostShare: Number(
          (buildResult.labelCostSummary.providerReportedCostShare ?? 0).toFixed(4),
        ),
        providerCostMissing:
          !args.dryRun && providerReportedCostCalls === 0 ? "true" : "false",
      });
      console.log(
        `[map-build-runner] done runId=${runId} state=${args.dryRun ? "dry_run" : "completed"} est_cost=${actualEstimatedCostUsd.toFixed(6)} charged_cost=${actualChargedCostUsd.toFixed(6)} source=${costSource}`,
      );
    } catch (error) {
      const finishedAt = Date.now();
      const runEntry: RunEntry = {
        runId,
        ts: finishedAt,
        costUsd: estimatedCostUsd,
        estimatedCostUsd,
        chargedCostUsd: estimatedCostUsd,
        providerReportedCostUsd: 0,
        providerReportedCostCalls: 0,
        costSource: "estimated",
        result: "error",
      };
      await redis.zAdd(RUNS_KEY, {
        score: finishedAt,
        value: JSON.stringify(runEntry),
      });
      const postWindowStartMs = finishedAt - config.runWindowMinutes * 60_000;
      const postDayStartMs = finishedAt - 24 * 60 * 60 * 1_000;
      const postBudgetWindowStartMs =
        finishedAt - config.budgetWindowMinutes * 60_000;
      const historyAfter = [...history, runEntry];
      const postRunsInWindow = historyAfter.filter(
        (item) => item.ts >= postWindowStartMs,
      );
      const postRunsInDay = historyAfter.filter((item) => item.ts >= postDayStartMs);
      const postRunsInBudgetWindow = historyAfter.filter(
        (item) => item.ts >= postBudgetWindowStartMs,
      );
      const postBudgetWindowSpentUsd = sumCost(postRunsInBudgetWindow);
      const postDaySpentUsd = sumCost(postRunsInDay);
      await setStatus(redis, {
        state: "failed",
        reason: "error",
        runId,
        at: new Date(finishedAt).toISOString(),
        estimatedCostUsd,
        actualEstimatedCostUsd: estimatedCostUsd,
        actualChargedCostUsd: estimatedCostUsd,
        providerReportedCostUsd: 0,
        providerReportedCostCalls: 0,
        costSource: "estimated",
        runWindowMinutes: config.runWindowMinutes,
        runsInWindow: postRunsInWindow.length,
        maxRunsPerWindow: config.maxRunsPerWindow,
        maxRunsPerDay: config.maxRunsPerDay,
        runsInDay: postRunsInDay.length,
        budgetWindowMinutes: config.budgetWindowMinutes,
        budgetWindowUsd: config.budgetWindowUsd,
        budgetWindowSpentUsd: Number(postBudgetWindowSpentUsd.toFixed(6)),
        budgetWindowRemainingUsd: Number(
          Math.max(0, config.budgetWindowUsd - postBudgetWindowSpentUsd).toFixed(6),
        ),
        dayBudgetUsd: config.dayBudgetUsd,
        daySpentUsd: Number(postDaySpentUsd.toFixed(6)),
        dayBudgetRemainingUsd: Number(
          Math.max(0, config.dayBudgetUsd - postDaySpentUsd).toFixed(6),
        ),
        error: previewError(error),
      });
      throw error;
    }
  } finally {
    detachSignalHandlers();
    try {
      await releaseLockAndRedis();
    } catch {
      // best effort cleanup
    }
  }
}

main()
  .then(async () => {
    await pool.end();
    process.exit(0);
  })
  .catch(async (error) => {
    console.error("[map-build-runner] failed", error);
    await pool.end();
    process.exit(1);
  });
