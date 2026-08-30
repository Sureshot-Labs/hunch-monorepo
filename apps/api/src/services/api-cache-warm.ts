import { env } from "../env.js";
import type { ApiCacheWarmPolicy } from "./runtime-policies.js";
import type { RedisClientType as RedisClient } from "redis";

export type ApiCacheWarmGroup = "feed" | "market_map" | "wallet_intel";

export const API_CACHE_WARM_FAILURE_BACKOFF_SEC = 120;

export type ApiCacheWarmGroupStats = {
  targetsAttempted: number;
  targetsSucceeded: number;
  targetsFailed: number;
  cacheHits: number;
  cacheMisses: number;
  cacheOther: number;
  durationMs: number;
};

export type ApiCacheWarmGroupStatsByGroup = Record<
  ApiCacheWarmGroup,
  ApiCacheWarmGroupStats
>;

export type ApiCacheWarmTarget = {
  id: string;
  label: string;
  group: ApiCacheWarmGroup;
  path: string;
};

export type ApiCacheWarmRunnerState = {
  lastRunAt: string | null;
  lastCompletedAt: string | null;
  lastResult: string | null;
  durationMs: number | null;
  targetsAttempted: number;
  targetsSucceeded: number;
  targetsFailed: number;
  groups: ApiCacheWarmGroupStatsByGroup;
  baseUrl: string | null;
  error: string | null;
};

export type ApiCacheWarmTargetStats = {
  id: string;
  label: string;
  group: ApiCacheWarmGroup;
  path: string;
  samples: number;
  successCount: number;
  failureCount: number;
  lastStatusCode: number | null;
  lastDurationMs: number | null;
  minDurationMs: number | null;
  maxDurationMs: number | null;
  avgDurationMs: number | null;
  lastCache: string | null;
  lastCacheLayer: string | null;
  lastCacheStatus: string | null;
  lastError: string | null;
  lastRunAt: string | null;
};

export const API_CACHE_WARM_TARGETS: ApiCacheWarmTarget[] = [
  {
    id: "feed_trending",
    label: "Feed Trending",
    group: "feed",
    path: "/feed?limit=25&offset=0&sort=trending&sort_dir=desc",
  },
  {
    id: "feed_trending_v2",
    label: "Feed Trending V2",
    group: "feed",
    path: "/feed?limit=25&offset=0&sort=trending_v2&sort_dir=desc",
  },
  {
    id: "feed_change24h",
    label: "Feed Change 24h",
    group: "feed",
    path: "/feed?limit=25&offset=0&sort=change24h&sort_dir=desc",
  },
  {
    id: "market_map_discovery_sidebars",
    label: "Market Map Discovery Sidebars",
    group: "market_map",
    path: "/market-map/sidebars?venues=polymarket,kalshi,limitless&trendingLimit=5&volumeMoversLimit=5&liquidityMoversLimit=5&topMoversLimit=5&minVolume24h=1000&volumeMoversSortBy=percent&liquidityMoversSortBy=absolute&includeVolumeSparkline=true&sparklineWindowHours=48&sparklineBucketHours=2",
  },
  {
    id: "wallet_whales_last_activity",
    label: "Wallet Whales",
    group: "wallet_intel",
    path: "/wallets/whales?limit=30&offset=0&topChanges=3&sort=last_activity&marketLimit=5&includeSummary=true&includeAttribution=true&windowDays=30&windowHours=168",
  },
  {
    id: "wallet_summary_all",
    label: "Wallet Summary",
    group: "wallet_intel",
    path: "/wallets/activity/summary?scope=all&windowHours=24&sort=last_activity&limit=60",
  },
  {
    id: "wallet_summary_stats",
    label: "Wallet Summary Stats",
    group: "wallet_intel",
    path: "/wallets/activity/summary/stats?scope=all&windowHours=24",
  },
  {
    id: "wallet_signals_all",
    label: "Wallet Signals All",
    group: "wallet_intel",
    path: "/wallets/activity/signals?scope=all&windowHours=24&limit=60&includeAttribution=true",
  },
  {
    id: "wallet_signals_active",
    label: "Wallet Signals Active",
    group: "wallet_intel",
    path: "/wallets/activity/signals?scope=active&windowHours=24&limit=60&includeAttribution=true",
  },
];

const KEY_PREFIX = "api:cache_warm:v1";
export const API_CACHE_WARM_LOCK_KEY = `${KEY_PREFIX}:lock`;
export const API_CACHE_WARM_STATUS_KEY = `${KEY_PREFIX}:status:last`;
export const API_CACHE_WARM_STATUS_TTL_SEC = 60 * 60 * 24 * 30;

function emptyGroupStats(): ApiCacheWarmGroupStats {
  return {
    targetsAttempted: 0,
    targetsSucceeded: 0,
    targetsFailed: 0,
    cacheHits: 0,
    cacheMisses: 0,
    cacheOther: 0,
    durationMs: 0,
  };
}

export function emptyApiCacheWarmGroupStats(): ApiCacheWarmGroupStatsByGroup {
  return {
    feed: emptyGroupStats(),
    market_map: emptyGroupStats(),
    wallet_intel: emptyGroupStats(),
  };
}

export function apiCacheWarmCooldownSec(input: {
  pollIntervalSec: number;
  previousResult: string | null | undefined;
}): number {
  return input.previousResult === "partial" || input.previousResult === "error"
    ? Math.max(input.pollIntervalSec, API_CACHE_WARM_FAILURE_BACKOFF_SEC)
    : input.pollIntervalSec;
}

export async function runApiCacheWarmTargetsSequentially<TResult>(
  targets: readonly ApiCacheWarmTarget[],
  runTarget: (target: ApiCacheWarmTarget) => Promise<TResult>,
): Promise<Array<{ target: ApiCacheWarmTarget; result: TResult }>> {
  const runs: Array<{ target: ApiCacheWarmTarget; result: TResult }> = [];
  for (const target of targets) {
    runs.push({ target, result: await runTarget(target) });
  }
  return runs;
}

export function summarizeApiCacheWarmGroups(
  runs: ReadonlyArray<{
    target: ApiCacheWarmTarget;
    result: { ok: boolean; durationMs: number; cache: string | null };
  }>,
): ApiCacheWarmGroupStatsByGroup {
  const groups = emptyApiCacheWarmGroupStats();
  for (const run of runs) {
    const group = groups[run.target.group];
    group.targetsAttempted += 1;
    if (run.result.ok) group.targetsSucceeded += 1;
    else group.targetsFailed += 1;
    group.durationMs += run.result.durationMs;

    const cache = run.result.cache?.trim().toLowerCase();
    if (cache === "hit") group.cacheHits += 1;
    else if (cache === "miss") group.cacheMisses += 1;
    else group.cacheOther += 1;
  }
  return groups;
}

export function apiCacheWarmTargetStatsKey(targetId: string): string {
  return `${KEY_PREFIX}:target:${targetId}`;
}

function parseOptionalNumber(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseString(value: string | undefined): string | null {
  if (!value) return null;
  return value;
}

function parseGroupStats(
  value: string | undefined,
): ApiCacheWarmGroupStatsByGroup {
  if (!value) return emptyApiCacheWarmGroupStats();
  try {
    const parsed = JSON.parse(value) as Partial<ApiCacheWarmGroupStatsByGroup>;
    const groups = emptyApiCacheWarmGroupStats();
    for (const group of Object.keys(groups) as ApiCacheWarmGroup[]) {
      const candidate = parsed[group];
      if (!candidate) continue;
      for (const key of Object.keys(groups[group]) as Array<
        keyof ApiCacheWarmGroupStats
      >) {
        const number = Number(candidate[key]);
        if (Number.isFinite(number) && number >= 0) groups[group][key] = number;
      }
    }
    return groups;
  } catch {
    return emptyApiCacheWarmGroupStats();
  }
}

function parseTargetStats(
  target: ApiCacheWarmTarget,
  hash: Record<string, string>,
): ApiCacheWarmTargetStats {
  return {
    id: target.id,
    label: target.label,
    group: target.group,
    path: target.path,
    samples: parseOptionalNumber(hash.samples) ?? 0,
    successCount: parseOptionalNumber(hash.successCount) ?? 0,
    failureCount: parseOptionalNumber(hash.failureCount) ?? 0,
    lastStatusCode: parseOptionalNumber(hash.lastStatusCode),
    lastDurationMs: parseOptionalNumber(hash.lastDurationMs),
    minDurationMs: parseOptionalNumber(hash.minDurationMs),
    maxDurationMs: parseOptionalNumber(hash.maxDurationMs),
    avgDurationMs: parseOptionalNumber(hash.avgDurationMs),
    lastCache: parseString(hash.lastCache),
    lastCacheLayer: parseString(hash.lastCacheLayer),
    lastCacheStatus: parseString(hash.lastCacheStatus),
    lastError: parseString(hash.lastError),
    lastRunAt: parseString(hash.lastRunAt),
  };
}

export async function readApiCacheWarmStatus(redis: RedisClient): Promise<{
  runner: ApiCacheWarmRunnerState;
  targets: ApiCacheWarmTargetStats[];
}> {
  const [statusHash, targetHashes] = await Promise.all([
    redis.hGetAll(API_CACHE_WARM_STATUS_KEY),
    Promise.all(
      API_CACHE_WARM_TARGETS.map((target) =>
        redis.hGetAll(apiCacheWarmTargetStatsKey(target.id)),
      ),
    ),
  ]);

  return {
    runner: {
      lastRunAt: parseString(statusHash.lastRunAt),
      lastCompletedAt: parseString(statusHash.lastCompletedAt),
      lastResult: parseString(statusHash.lastResult),
      durationMs: parseOptionalNumber(statusHash.durationMs),
      targetsAttempted: parseOptionalNumber(statusHash.targetsAttempted) ?? 0,
      targetsSucceeded: parseOptionalNumber(statusHash.targetsSucceeded) ?? 0,
      targetsFailed: parseOptionalNumber(statusHash.targetsFailed) ?? 0,
      groups: parseGroupStats(statusHash.groups),
      baseUrl: parseString(statusHash.baseUrl),
      error: parseString(statusHash.error),
    },
    targets: API_CACHE_WARM_TARGETS.map((target, index) =>
      parseTargetStats(target, targetHashes[index] ?? {}),
    ),
  };
}

export function selectApiCacheWarmTargets(
  policy: ApiCacheWarmPolicy,
): ApiCacheWarmTarget[] {
  return API_CACHE_WARM_TARGETS.filter((target) => {
    if (target.group === "feed") return policy.warmFeed;
    if (target.group === "market_map") return policy.warmMarketMap;
    if (target.group === "wallet_intel") return policy.warmWalletIntel;
    return false;
  });
}

export function resolveApiCacheWarmBaseUrlCandidates(): string[] {
  const candidates = [
    process.env.HUNCH_API_INTERNAL_BASE_URL?.trim() || "",
    `http://api:${env.port}`,
    `http://localhost:${env.port}`,
  ];
  return Array.from(
    new Set(
      candidates
        .map((value) => value.trim())
        .filter((value) => value.length > 0),
    ),
  );
}
