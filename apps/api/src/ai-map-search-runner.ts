import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRedisClient, ensureRedis } from "@hunch/infra";
import { pool } from "./db.js";
import { env } from "./env.js";
import { runMapSearch } from "./lib/map-news/map-search-core.js";
import { marketMapActiveKey } from "./services/market-map.js";
import { resolveMapSearchPolicy } from "./services/runtime-policies.js";

const KEY_PREFIX = "ai:map_search:v1";
const LOCK_KEY = `${KEY_PREFIX}:lock`;
const RUNS_KEY = `${KEY_PREFIX}:runs`;
const STATUS_KEY = `${KEY_PREFIX}:status:last`;
const LATEST_KEY = `${KEY_PREFIX}:latest`;
const RUN_HISTORY_TTL_MS = 60 * 60 * 24 * 14 * 1_000;

function artifactKey(mapRunId: string): string {
  return `${KEY_PREFIX}:run:${mapRunId}:artifact`;
}

function runStatusKey(mapRunId: string): string {
  return `${KEY_PREFIX}:run:${mapRunId}:status`;
}

function latestSearchForMapRunKey(mapRunId: string): string {
  return `${KEY_PREFIX}:map_run:${mapRunId}:latest_search`;
}

type RunnerOptions = {
  force: boolean;
  ignorePolicyRate: boolean;
  ignorePolicyBudget: boolean;
  dryRun: boolean;
  verbose: boolean;
  passthroughArgs: string[];
};

type SearchRunnerResult = "ok" | "error" | "dry_run";

type RunEntry = {
  runnerRunId: string;
  mapRunId: string;
  ts: number;
  costUsd: number;
  estimatedCostUsd?: number;
  chargedCostUsd?: number;
  providerReportedCostUsd?: number;
  providerReportedCostCalls?: number;
  costSource?: "estimated" | "provider_reported" | "mixed";
  callsExecuted?: number;
  evidenceTotal?: number;
  result: SearchRunnerResult;
};

type SearchReportLike = {
  run?: {
    runId?: string;
  };
  totals?: {
    durationMs?: number;
    callsExecuted?: number;
    evidenceTotal?: number;
    inputTokens?: number;
    outputTokens?: number;
    toolAttempts?: number;
    estimatedTotalCostUsd?: number;
    chargedTotalCostUsd?: number;
    providerReportedCostUsd?: number;
    providerReportedCostCalls?: number;
  };
};

function hasFlag(args: string[], flag: string): boolean {
  return args.some((arg) => arg === flag);
}

function parseFlag(args: string[], flag: string): string | undefined {
  const inlinePrefix = `${flag}=`;
  const inlineValue = args.find((arg) => arg.startsWith(inlinePrefix));
  if (inlineValue) return inlineValue.slice(inlinePrefix.length);
  const idx = args.indexOf(flag);
  if (idx === -1) return undefined;
  return args[idx + 1];
}

function hasOption(args: string[], flag: string): boolean {
  return args.some((arg) => arg === flag || arg.startsWith(`${flag}=`));
}

function addArgIfMissing(args: string[], flag: string, value: string): void {
  if (hasOption(args, flag)) return;
  args.push(`${flag}=${value}`);
}

function addBoolArgIfMissing(args: string[], flag: string, value: boolean): void {
  addArgIfMissing(args, flag, value ? "true" : "false");
}

function hasTruthyOverride(args: string[], flag: string): boolean {
  if (hasFlag(args, flag)) return true;
  const raw = parseFlag(args, flag);
  if (!raw) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
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

function parseRunEntries(rawMembers: string[]): RunEntry[] {
  const entries: RunEntry[] = [];
  for (const raw of rawMembers) {
    try {
      const parsed = JSON.parse(raw) as Partial<RunEntry>;
      if (
        typeof parsed.runnerRunId !== "string" ||
        typeof parsed.mapRunId !== "string" ||
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
        runnerRunId: parsed.runnerRunId,
        mapRunId: parsed.mapRunId,
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

function toDomainCsv(values: string[]): string | null {
  const normalized = (values ?? [])
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0);
  if (normalized.length === 0) return null;
  return normalized.join(",");
}

function toNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function extractSearchReport(raw: string): SearchReportLike {
  const parsed = JSON.parse(raw) as SearchReportLike;
  if (!parsed || typeof parsed !== "object") {
    throw new Error("search report is not an object");
  }
  return parsed;
}

function printHelp(): void {
  console.log(`Usage: pnpm -C hunch-monorepo -F api run ai:map-search:runner -- [options]

Options:
  --force                   Bypass policy enabled/rate/budget gates
  --ignore-policy-rate      Ignore poll/run-window/day run-count gates
  --ignore-policy-budget    Ignore budget-window/day budget gates
  --dry-run                 Forward dry-run to ai:map-search:run core
  --verbose                 Print additional debug details
  --help                    Show this help

All other args are passed through to ai:map-search:run.
`);
}

async function setStatus(
  redis: ReturnType<typeof createRedisClient>,
  ttlSec: number,
  payload: Record<string, string | number | null>,
): Promise<void> {
  const cleaned = Object.fromEntries(
    Object.entries(payload).map(([key, value]) => [key, value ?? ""]),
  );
  await redis.hSet(STATUS_KEY, cleaned);
  await redis.expire(STATUS_KEY, ttlSec);
}

async function setRunStatus(
  redis: ReturnType<typeof createRedisClient>,
  mapRunId: string,
  ttlSec: number,
  payload: Record<string, string | number | null>,
): Promise<void> {
  const key = runStatusKey(mapRunId);
  const cleaned = Object.fromEntries(
    Object.entries(payload).map(([k, v]) => [k, v ?? ""]),
  );
  await redis.hSet(key, cleaned);
  await redis.expire(key, ttlSec);
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
  const policy = await resolveMapSearchPolicy(pool);
  const config = policy.effective;

  if (!env.redisUrl) {
    throw new Error("[map-search-runner] REDIS_URL is required");
  }

  if (!config.enabled && !args.force) {
    console.log("[map-search-runner] skipped (policy disabled)");
    return;
  }

  const redis = createRedisClient({ url: env.redisUrl });
  await ensureRedis(redis, { waitForReady: true, logLabel: "map-search-runner" });
  const lockValue = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const runnerRunId = lockValue;
  const nowMs = Date.now();
  let released = false;
  let shuttingDownBySignal = false;
  let activeMapRunIdForSignal: string | null = null;
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
    console.warn(`[map-search-runner] received ${signal}, releasing lock and exiting`);
    try {
      await setStatus(redis, config.statusTtlSec, {
        state: "aborted",
        reason: `aborted_${signal.toLowerCase()}`,
        runnerRunId,
        mapRunId: activeMapRunIdForSignal ?? "",
        at: new Date().toISOString(),
      });
      if (activeMapRunIdForSignal) {
        await setRunStatus(redis, activeMapRunIdForSignal, config.statusTtlSec, {
          state: "aborted",
          reason: `aborted_${signal.toLowerCase()}`,
          runnerRunId,
          mapRunId: activeMapRunIdForSignal,
          at: new Date().toISOString(),
        });
      }
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
      console.log("[map-search-runner] skipped (lock active)");
      await setStatus(redis, config.statusTtlSec, {
        state: "skipped",
        reason: "skipped_lock_active",
        runnerRunId,
        mapRunId: "",
        at: new Date(nowMs).toISOString(),
      });
      return;
    }

    startHeartbeat();

    const requestedMapRunId = parseFlag(args.passthroughArgs, "--run-id")?.trim() || null;
    const activeMapRunId = requestedMapRunId ?? (await redis.get(marketMapActiveKey()));
    if (!activeMapRunId || activeMapRunId.trim().length === 0) {
      console.log("[map-search-runner] skipped (no active map run)");
      await setStatus(redis, config.statusTtlSec, {
        state: "skipped",
        reason: "skipped_no_active_map",
        runnerRunId,
        mapRunId: "",
        at: new Date(nowMs).toISOString(),
      });
      return;
    }
    activeMapRunIdForSignal = activeMapRunId.trim();

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
        console.log("[map-search-runner] skipped (poll interval)");
        await setStatus(redis, config.statusTtlSec, {
          state: "skipped",
          reason: "skipped_poll_interval",
          runnerRunId,
          mapRunId: activeMapRunIdForSignal,
          at: new Date(nowMs).toISOString(),
        });
        await setRunStatus(redis, activeMapRunIdForSignal, config.statusTtlSec, {
          state: "skipped",
          reason: "skipped_poll_interval",
          runnerRunId,
          mapRunId: activeMapRunIdForSignal,
          at: new Date(nowMs).toISOString(),
        });
        return;
      }
      if (runsInWindow.length >= config.maxRunsPerWindow) {
        console.log("[map-search-runner] skipped (run window cap)");
        await setStatus(redis, config.statusTtlSec, {
          state: "skipped",
          reason: "skipped_run_rate_window",
          runnerRunId,
          mapRunId: activeMapRunIdForSignal,
          at: new Date(nowMs).toISOString(),
          runsInWindow: runsInWindow.length,
          maxRunsPerWindow: config.maxRunsPerWindow,
        });
        await setRunStatus(redis, activeMapRunIdForSignal, config.statusTtlSec, {
          state: "skipped",
          reason: "skipped_run_rate_window",
          runnerRunId,
          mapRunId: activeMapRunIdForSignal,
          at: new Date(nowMs).toISOString(),
          runsInWindow: runsInWindow.length,
          maxRunsPerWindow: config.maxRunsPerWindow,
        });
        return;
      }
      if (runsInDay.length >= config.maxRunsPerDay) {
        console.log("[map-search-runner] skipped (day run cap)");
        await setStatus(redis, config.statusTtlSec, {
          state: "skipped",
          reason: "skipped_run_rate_day",
          runnerRunId,
          mapRunId: activeMapRunIdForSignal,
          at: new Date(nowMs).toISOString(),
          runsInDay: runsInDay.length,
          maxRunsPerDay: config.maxRunsPerDay,
        });
        await setRunStatus(redis, activeMapRunIdForSignal, config.statusTtlSec, {
          state: "skipped",
          reason: "skipped_run_rate_day",
          runnerRunId,
          mapRunId: activeMapRunIdForSignal,
          at: new Date(nowMs).toISOString(),
          runsInDay: runsInDay.length,
          maxRunsPerDay: config.maxRunsPerDay,
        });
        return;
      }
    }

    if (!args.ignorePolicyBudget) {
      if (budgetWindowSpentUsd + estimatedCostUsd > config.budgetWindowUsd) {
        console.log("[map-search-runner] skipped (budget window cap)");
        await setStatus(redis, config.statusTtlSec, {
          state: "skipped",
          reason: "skipped_budget_window",
          runnerRunId,
          mapRunId: activeMapRunIdForSignal,
          at: new Date(nowMs).toISOString(),
          budgetWindowSpentUsd,
          budgetWindowUsd: config.budgetWindowUsd,
          estimatedCostUsd,
        });
        await setRunStatus(redis, activeMapRunIdForSignal, config.statusTtlSec, {
          state: "skipped",
          reason: "skipped_budget_window",
          runnerRunId,
          mapRunId: activeMapRunIdForSignal,
          at: new Date(nowMs).toISOString(),
          budgetWindowSpentUsd,
          budgetWindowUsd: config.budgetWindowUsd,
          estimatedCostUsd,
        });
        return;
      }
      if (daySpentUsd + estimatedCostUsd > config.dayBudgetUsd) {
        console.log("[map-search-runner] skipped (day budget cap)");
        await setStatus(redis, config.statusTtlSec, {
          state: "skipped",
          reason: "skipped_budget_day",
          runnerRunId,
          mapRunId: activeMapRunIdForSignal,
          at: new Date(nowMs).toISOString(),
          daySpentUsd,
          dayBudgetUsd: config.dayBudgetUsd,
          estimatedCostUsd,
        });
        await setRunStatus(redis, activeMapRunIdForSignal, config.statusTtlSec, {
          state: "skipped",
          reason: "skipped_budget_day",
          runnerRunId,
          mapRunId: activeMapRunIdForSignal,
          at: new Date(nowMs).toISOString(),
          daySpentUsd,
          dayBudgetUsd: config.dayBudgetUsd,
          estimatedCostUsd,
        });
        return;
      }
    }

    if (args.verbose) {
      console.log("[map-search-runner] executing", {
        source: policy.source,
        effectiveAt: policy.effectiveAt?.toISOString() ?? null,
        mapRunId: activeMapRunIdForSignal,
        triggerMode: config.triggerMode,
        pollIntervalSec: config.pollIntervalSec,
        runWindowMinutes: config.runWindowMinutes,
        maxRunsPerWindow: config.maxRunsPerWindow,
        maxRunsPerDay: config.maxRunsPerDay,
        budgetWindowMinutes: config.budgetWindowMinutes,
        budgetWindowUsd: config.budgetWindowUsd,
        dayBudgetUsd: config.dayBudgetUsd,
        estimatedRunCostUsd: estimatedCostUsd,
        reuseMode: config.reuseMode,
        persistenceMode: config.persistenceMode,
        sameRunNoveltyAlpha: config.sameRunNoveltyAlpha,
        sameRunNoveltyFloor: config.sameRunNoveltyFloor,
        sameRunNoveltyBoost: config.sameRunNoveltyBoost,
        ignorePolicyRate: args.ignorePolicyRate,
        ignorePolicyBudget: args.ignorePolicyBudget,
      });
    }

    await setStatus(redis, config.statusTtlSec, {
      state: "running",
      reason: "started",
      runnerRunId,
      mapRunId: activeMapRunIdForSignal,
      at: new Date(nowMs).toISOString(),
    });
    await setRunStatus(redis, activeMapRunIdForSignal, config.statusTtlSec, {
      state: "running",
      reason: "started",
      runnerRunId,
      mapRunId: activeMapRunIdForSignal,
      at: new Date(nowMs).toISOString(),
    });

    const providedOutPath = parseFlag(args.passthroughArgs, "--out")?.trim() || null;
    const outPath =
      providedOutPath && providedOutPath.length > 0
        ? providedOutPath
        : join(tmpdir(), `ai-map-search-runner-${runnerRunId}.json`);
    const searchArgs = args.passthroughArgs.slice();
    addArgIfMissing(searchArgs, "--run-id", activeMapRunIdForSignal);
    addArgIfMissing(searchArgs, "--out", outPath);
    addArgIfMissing(searchArgs, "--model", config.model);
    addArgIfMissing(searchArgs, "--embed-model", config.embedModel);
    addArgIfMissing(searchArgs, "--tool-mode", config.toolMode);
    addBoolArgIfMissing(searchArgs, "--strict-schema", config.strictSchema);
    addBoolArgIfMissing(
      searchArgs,
      "--require-distinct-domains",
      config.requireDistinctDomains,
    );
    addArgIfMissing(searchArgs, "--concurrency", String(config.concurrency));
    addArgIfMissing(searchArgs, "--max-calls", String(config.maxCalls));
    addArgIfMissing(searchArgs, "--budget-usd", String(config.budgetUsd));
    addArgIfMissing(searchArgs, "--timeout-sec", String(config.timeoutSec));
    addArgIfMissing(searchArgs, "--max-retries", String(config.maxRetries));
    addArgIfMissing(searchArgs, "--retry-base-ms", String(config.retryBaseMs));
    addArgIfMissing(
      searchArgs,
      "--max-total-input-tokens",
      String(config.maxTotalInputTokens),
    );
    addArgIfMissing(
      searchArgs,
      "--max-total-output-tokens",
      String(config.maxTotalOutputTokens),
    );
    addArgIfMissing(
      searchArgs,
      "--max-total-tool-attempts",
      String(config.maxTotalToolAttempts),
    );
    addArgIfMissing(
      searchArgs,
      "--max-tool-attempts-per-call",
      String(config.maxToolAttemptsPerCall),
    );
    addArgIfMissing(
      searchArgs,
      "--max-evidence-per-call",
      String(config.maxEvidencePerCall),
    );
    addArgIfMissing(searchArgs, "--max-evidence-total", String(config.maxEvidenceTotal));
    addArgIfMissing(searchArgs, "--window-hours-l1", String(config.windowHoursL1));
    addArgIfMissing(searchArgs, "--window-hours-l2", String(config.windowHoursL2));
    addArgIfMissing(searchArgs, "--window-hours-l3", String(config.windowHoursL3));
    addArgIfMissing(searchArgs, "--recent-hours-hint", String(config.recentHoursHint));
    addArgIfMissing(searchArgs, "--top-root-count", String(config.topRootCount));
    addArgIfMissing(searchArgs, "--branch-per-call", String(config.branchPerCall));
    addArgIfMissing(searchArgs, "--event-sample-limit", String(config.eventSampleLimit));
    addArgIfMissing(searchArgs, "--child-sample-limit", String(config.childSampleLimit));
    addArgIfMissing(
      searchArgs,
      "--sibling-sample-limit",
      String(config.siblingSampleLimit),
    );
    addArgIfMissing(
      searchArgs,
      "--route-threshold-l1",
      String(config.routeThresholdL1),
    );
    addArgIfMissing(
      searchArgs,
      "--route-threshold-l2",
      String(config.routeThresholdL2),
    );
    addArgIfMissing(
      searchArgs,
      "--route-threshold-l3",
      String(config.routeThresholdL3),
    );
    addArgIfMissing(
      searchArgs,
      "--route-min-similarity",
      String(config.routeMinSimilarity),
    );
    addArgIfMissing(
      searchArgs,
      "--route-min-margin-l1",
      String(config.routeMinMarginL1),
    );
    addArgIfMissing(
      searchArgs,
      "--route-min-margin-l2",
      String(config.routeMinMarginL2),
    );
    addArgIfMissing(
      searchArgs,
      "--route-min-margin-l3",
      String(config.routeMinMarginL3),
    );
    const allowDomainsCsv = toDomainCsv(config.sourceAllowDomains);
    if (allowDomainsCsv) {
      addArgIfMissing(searchArgs, "--source-allow-domains", allowDomainsCsv);
    }
    const denyDomainsCsv = toDomainCsv(config.sourceDenyDomains);
    if (denyDomainsCsv) {
      addArgIfMissing(searchArgs, "--source-deny-domains", denyDomainsCsv);
    }
    addArgIfMissing(
      searchArgs,
      "--max-x-evidence-per-call",
      String(config.maxXEvidencePerCall),
    );
    addArgIfMissing(
      searchArgs,
      "--max-unconfirmed-evidence-per-call",
      String(config.maxUnconfirmedEvidencePerCall),
    );
    addArgIfMissing(
      searchArgs,
      "--low-yield-tool-attempt-threshold",
      String(config.lowYieldToolAttemptThreshold),
    );
    addArgIfMissing(
      searchArgs,
      "--low-yield-consecutive-threshold",
      String(config.lowYieldConsecutiveThreshold),
    );
    addBoolArgIfMissing(searchArgs, "--enforce-freshness", config.enforceFreshness);
    addArgIfMissing(searchArgs, "--report-top-leaves", String(config.reportTopLeaves));
    addArgIfMissing(
      searchArgs,
      "--report-top-evidence",
      String(config.reportTopEvidence),
    );
    addArgIfMissing(searchArgs, "--reuse-mode", config.reuseMode);
    addArgIfMissing(searchArgs, "--persistence-mode", config.persistenceMode);
    addArgIfMissing(
      searchArgs,
      "--artifact-ttl-sec",
      String(config.artifactTtlSec),
    );
    addArgIfMissing(searchArgs, "--state-ttl-sec", String(config.stateTtlSec));
    addArgIfMissing(searchArgs, "--status-ttl-sec", String(config.statusTtlSec));
    addArgIfMissing(
      searchArgs,
      "--warm-start-evidence-limit",
      String(config.warmStartEvidenceLimit),
    );
    addArgIfMissing(
      searchArgs,
      "--warm-start-min-similarity",
      String(config.warmStartMinSimilarity),
    );
    addArgIfMissing(
      searchArgs,
      "--warm-start-queue-boost",
      String(config.warmStartQueueBoost),
    );
    addArgIfMissing(
      searchArgs,
      "--same-run-novelty-alpha",
      String(config.sameRunNoveltyAlpha),
    );
    addArgIfMissing(
      searchArgs,
      "--same-run-novelty-floor",
      String(config.sameRunNoveltyFloor),
    );
    addArgIfMissing(
      searchArgs,
      "--same-run-novelty-boost",
      String(config.sameRunNoveltyBoost),
    );

    if ((args.dryRun || config.dryRun) && !hasOption(searchArgs, "--dry-run")) {
      searchArgs.push("--dry-run");
    }
    if ((args.verbose || config.verbose) && !hasOption(searchArgs, "--verbose")) {
      searchArgs.push("--verbose");
    }
    if (config.leanOutput && !hasOption(searchArgs, "--lean-output")) {
      searchArgs.push("--lean-output");
    }
    if (config.verboseOutput && !hasOption(searchArgs, "--verbose-output")) {
      searchArgs.push("--verbose-output");
    }

    try {
      await runMapSearch(searchArgs, {
        commandName: "ai:map-search:run",
        scriptTag: "ai-map-search-runner",
        qaScriptName: "ai-map-search-runner",
      });

      const outputRaw = await readFile(outPath, "utf8");
      const report = extractSearchReport(outputRaw);
      const mapRunId = report.run?.runId?.trim() || activeMapRunIdForSignal;
      const callsExecuted = Math.trunc(toNumber(report.totals?.callsExecuted));
      const evidenceTotal = Math.trunc(toNumber(report.totals?.evidenceTotal));
      const actualEstimatedCostUsd = toNumber(report.totals?.estimatedTotalCostUsd);
      const actualChargedCostUsd = toNumber(
        report.totals?.chargedTotalCostUsd,
        actualEstimatedCostUsd,
      );
      const providerReportedCostUsd = toNumber(report.totals?.providerReportedCostUsd);
      const providerReportedCostCalls = Math.trunc(
        toNumber(report.totals?.providerReportedCostCalls),
      );
      const costSource: "estimated" | "provider_reported" | "mixed" =
        providerReportedCostCalls <= 0
          ? "estimated"
          : providerReportedCostCalls >= callsExecuted
            ? "provider_reported"
            : "mixed";
      const finishedAt = Date.now();

      const runEntry: RunEntry = {
        runnerRunId,
        mapRunId,
        ts: finishedAt,
        costUsd: actualChargedCostUsd,
        estimatedCostUsd: actualEstimatedCostUsd,
        chargedCostUsd: actualChargedCostUsd,
        providerReportedCostUsd,
        providerReportedCostCalls,
        costSource,
        callsExecuted,
        evidenceTotal,
        result: hasTruthyOverride(searchArgs, "--dry-run") ? "dry_run" : "ok",
      };

      await redis.zAdd(RUNS_KEY, {
        score: finishedAt,
        value: JSON.stringify(runEntry),
      });

      await redis.set(artifactKey(mapRunId), outputRaw, {
        EX: config.artifactTtlSec,
      });
      await redis.set(LATEST_KEY, mapRunId, { EX: config.artifactTtlSec });
      await redis.set(
        latestSearchForMapRunKey(mapRunId),
        JSON.stringify({
          runnerRunId,
          mapRunId,
          completedAt: new Date(finishedAt).toISOString(),
        }),
        { EX: config.artifactTtlSec },
      );

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

      await setStatus(redis, config.statusTtlSec, {
        state: hasTruthyOverride(searchArgs, "--dry-run") ? "dry_run" : "completed",
        reason: "ok",
        runnerRunId,
        mapRunId,
        at: new Date(finishedAt).toISOString(),
        callsExecuted,
        evidenceTotal,
        estimatedCostUsd,
        actualEstimatedCostUsd,
        actualChargedCostUsd,
        providerReportedCostUsd,
        providerReportedCostCalls,
        costSource,
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
      });
      await setRunStatus(redis, mapRunId, config.statusTtlSec, {
        state: hasTruthyOverride(searchArgs, "--dry-run") ? "dry_run" : "completed",
        reason: "ok",
        runnerRunId,
        mapRunId,
        at: new Date(finishedAt).toISOString(),
        callsExecuted,
        evidenceTotal,
        actualChargedCostUsd,
        costSource,
      });

      console.log(
        `[map-search-runner] done runnerRunId=${runnerRunId} mapRunId=${mapRunId} state=${hasTruthyOverride(searchArgs, "--dry-run") ? "dry_run" : "completed"} charged_cost=${actualChargedCostUsd.toFixed(6)} source=${costSource} calls=${callsExecuted} evidence=${evidenceTotal}`,
      );
    } catch (error) {
      const finishedAt = Date.now();
      const runEntry: RunEntry = {
        runnerRunId,
        mapRunId: activeMapRunIdForSignal,
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
      const errorMessage = previewError(error);

      await setStatus(redis, config.statusTtlSec, {
        state: "failed",
        reason: "error",
        runnerRunId,
        mapRunId: activeMapRunIdForSignal,
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
        error: errorMessage,
      });
      await setRunStatus(
        redis,
        activeMapRunIdForSignal,
        config.statusTtlSec,
        {
          state: "failed",
          reason: "error",
          runnerRunId,
          mapRunId: activeMapRunIdForSignal,
          at: new Date(finishedAt).toISOString(),
          error: errorMessage,
        },
      );
      throw error;
    } finally {
      const providedOutPath = parseFlag(args.passthroughArgs, "--out")?.trim() || null;
      if (!providedOutPath) {
        const tempOut = join(tmpdir(), `ai-map-search-runner-${runnerRunId}.json`);
        await rm(tempOut, { force: true }).catch(() => undefined);
      }
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
    console.error("[map-search-runner] failed", error);
    await pool.end();
    process.exit(1);
  });
