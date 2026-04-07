import { env } from "../env.js";
import type { ApiCacheWarmPolicy } from "./runtime-policies.js";
import type { RedisClientType as RedisClient } from "redis";

export type ApiCacheWarmGroup = "feed" | "wallet_intel";

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
    new Set(candidates.map((value) => value.trim()).filter((value) => value.length > 0)),
  );
}
