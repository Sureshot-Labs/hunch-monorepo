import { randomUUID } from "node:crypto";

import { pool } from "./db.js";
import { getRedisStatus } from "./redis.js";
import {
  API_CACHE_WARM_LOCK_KEY,
  API_CACHE_WARM_STATUS_KEY,
  API_CACHE_WARM_STATUS_TTL_SEC,
  apiCacheWarmTargetStatsKey,
  readApiCacheWarmStatus,
  resolveApiCacheWarmBaseUrlCandidates,
  selectApiCacheWarmTargets,
  type ApiCacheWarmTarget,
} from "./services/api-cache-warm.js";
import { resolveApiCacheWarmPolicy } from "./services/runtime-policies.js";

type ApiCacheWarmRunnerResult =
  | "ok"
  | "partial"
  | "disabled"
  | "skipped_rate"
  | "skipped_locked"
  | "error";

type ApiCacheWarmRunResult = {
  result: ApiCacheWarmRunnerResult;
  durationMs: number;
  targetsAttempted: number;
  targetsSucceeded: number;
  targetsFailed: number;
  baseUrl: string | null;
  error: string | null;
  policyEnabled: boolean;
};

type TargetRunResult = {
  ok: boolean;
  statusCode: number | null;
  durationMs: number;
  cache: string | null;
  cacheLayer: string | null;
  cacheStatus: string | null;
  error: string | null;
};

export type ApiCacheWarmJobOptions = {
  force?: boolean;
};

function toCleanHashFields(
  payload: Record<string, string | number | null | undefined>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(payload).map(([key, value]) => [key, value == null ? "" : String(value)]),
  );
}

function parseOptionalNumber(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function setRunnerStatus(
  redis: NonNullable<Awaited<ReturnType<typeof getRedisStatus>>["redis"]>,
  payload: Record<string, string | number | null | undefined>,
): Promise<void> {
  await redis.hSet(API_CACHE_WARM_STATUS_KEY, toCleanHashFields(payload));
  await redis.expire(API_CACHE_WARM_STATUS_KEY, API_CACHE_WARM_STATUS_TTL_SEC);
}

async function acquireLock(
  redis: NonNullable<Awaited<ReturnType<typeof getRedisStatus>>["redis"]>,
  token: string,
  ttlSec: number,
): Promise<boolean> {
  const result = await redis.set(API_CACHE_WARM_LOCK_KEY, token, {
    NX: true,
    EX: ttlSec,
  });
  return result === "OK";
}

async function releaseLock(
  redis: NonNullable<Awaited<ReturnType<typeof getRedisStatus>>["redis"]>,
  token: string,
): Promise<void> {
  try {
    const current = await redis.get(API_CACHE_WARM_LOCK_KEY);
    if (current === token) {
      await redis.del(API_CACHE_WARM_LOCK_KEY);
    }
  } catch {
    // ignore best-effort cleanup
  }
}

async function resolveReachableBaseUrl(
  timeoutMs: number,
): Promise<{ baseUrl: string | null; error: string | null }> {
  const candidates = resolveApiCacheWarmBaseUrlCandidates();
  let lastError: string | null = null;

  for (const baseUrl of candidates) {
    try {
      const response = await fetch(`${baseUrl}/health`, {
        method: "GET",
        signal: AbortSignal.timeout(timeoutMs),
      });
      await response.text().catch(() => "");
      if (response.ok) {
        return { baseUrl, error: null };
      }
      lastError = `${baseUrl} -> ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  return { baseUrl: null, error: lastError ?? "No reachable internal API base URL" };
}

async function runTarget(
  baseUrl: string,
  target: ApiCacheWarmTarget,
  timeoutMs: number,
): Promise<TargetRunResult> {
  const startedAt = Date.now();
  try {
    const response = await fetch(`${baseUrl}${target.path}`, {
      method: "GET",
      headers: {
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    await response.text().catch(() => "");
    return {
      ok: response.ok,
      statusCode: response.status,
      durationMs: Date.now() - startedAt,
      cache: response.headers.get("x-cache"),
      cacheLayer: response.headers.get("x-cache-layer"),
      cacheStatus: response.headers.get("x-cache-status"),
      error: response.ok ? null : `HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      ok: false,
      statusCode: null,
      durationMs: Date.now() - startedAt,
      cache: null,
      cacheLayer: null,
      cacheStatus: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function updateTargetStats(
  redis: NonNullable<Awaited<ReturnType<typeof getRedisStatus>>["redis"]>,
  target: ApiCacheWarmTarget,
  result: TargetRunResult,
): Promise<void> {
  const key = apiCacheWarmTargetStatsKey(target.id);
  const previous = await redis.hGetAll(key);
  const samples = Math.max(0, Math.trunc(parseOptionalNumber(previous.samples) ?? 0));
  const nextSamples = samples + 1;
  const previousAvg = parseOptionalNumber(previous.avgDurationMs) ?? 0;
  const minPrev = parseOptionalNumber(previous.minDurationMs);
  const maxPrev = parseOptionalNumber(previous.maxDurationMs);
  const successPrev = Math.max(
    0,
    Math.trunc(parseOptionalNumber(previous.successCount) ?? 0),
  );
  const failurePrev = Math.max(
    0,
    Math.trunc(parseOptionalNumber(previous.failureCount) ?? 0),
  );
  const avgDurationMs =
    Math.round(((previousAvg * samples + result.durationMs) / nextSamples) * 100) /
    100;

  await redis.hSet(
    key,
    toCleanHashFields({
      id: target.id,
      label: target.label,
      group: target.group,
      path: target.path,
      samples: nextSamples,
      successCount: successPrev + (result.ok ? 1 : 0),
      failureCount: failurePrev + (result.ok ? 0 : 1),
      lastStatusCode: result.statusCode,
      lastDurationMs: result.durationMs,
      minDurationMs: minPrev == null ? result.durationMs : Math.min(minPrev, result.durationMs),
      maxDurationMs: maxPrev == null ? result.durationMs : Math.max(maxPrev, result.durationMs),
      avgDurationMs,
      lastCache: result.cache,
      lastCacheLayer: result.cacheLayer,
      lastCacheStatus: result.cacheStatus,
      lastError: result.error,
      lastRunAt: new Date().toISOString(),
    }),
  );
  await redis.expire(key, API_CACHE_WARM_STATUS_TTL_SEC);
}

export async function runApiCacheWarm(
  options: ApiCacheWarmJobOptions = {},
): Promise<ApiCacheWarmRunResult> {
  const startedAt = Date.now();
  const policy = await resolveApiCacheWarmPolicy(pool);
  const effective = policy.effective;
  const { redis, status: redisStatus, error: redisError } = await getRedisStatus();

  if (!effective.enabled && !options.force) {
    return {
      result: "disabled",
      durationMs: Date.now() - startedAt,
      targetsAttempted: 0,
      targetsSucceeded: 0,
      targetsFailed: 0,
      baseUrl: null,
      error: null,
      policyEnabled: false,
    };
  }

  if (!redis) {
    return {
      result: "error",
      durationMs: Date.now() - startedAt,
      targetsAttempted: 0,
      targetsSucceeded: 0,
      targetsFailed: 0,
      baseUrl: null,
      error: redisError ?? `Redis unavailable (${redisStatus})`,
      policyEnabled: effective.enabled,
    };
  }

  if (!options.force) {
    const previous = await readApiCacheWarmStatus(redis);
    const lastCompletedAtMs = previous.runner.lastCompletedAt
      ? Date.parse(previous.runner.lastCompletedAt)
      : NaN;
    if (Number.isFinite(lastCompletedAtMs)) {
      const nextEligibleAt = lastCompletedAtMs + effective.pollIntervalSec * 1000;
      if (Date.now() < nextEligibleAt) {
        return {
          result: "skipped_rate",
          durationMs: Date.now() - startedAt,
          targetsAttempted: 0,
          targetsSucceeded: 0,
          targetsFailed: 0,
          baseUrl: previous.runner.baseUrl,
          error: null,
          policyEnabled: effective.enabled,
        };
      }
    }
  }

  const lockToken = randomUUID();
  const selectedTargets = selectApiCacheWarmTargets(effective);
  const lockTtlSec = Math.max(
    30,
    Math.ceil((effective.requestTimeoutMs * Math.max(1, selectedTargets.length)) / 1000) + 30,
  );
  const acquired = await acquireLock(redis, lockToken, lockTtlSec);
  if (!acquired) {
    return {
      result: "skipped_locked",
      durationMs: Date.now() - startedAt,
      targetsAttempted: 0,
      targetsSucceeded: 0,
      targetsFailed: 0,
      baseUrl: null,
      error: null,
      policyEnabled: effective.enabled,
    };
  }

  try {
    await setRunnerStatus(redis, {
      lastRunAt: new Date().toISOString(),
      lastResult: "running",
      durationMs: null,
      targetsAttempted: 0,
      targetsSucceeded: 0,
      targetsFailed: 0,
      baseUrl: null,
      error: null,
    });

    if (selectedTargets.length === 0) {
      const durationMs = Date.now() - startedAt;
      await setRunnerStatus(redis, {
        lastRunAt: new Date(startedAt).toISOString(),
        lastCompletedAt: new Date().toISOString(),
        lastResult: "ok",
        durationMs,
        targetsAttempted: 0,
        targetsSucceeded: 0,
        targetsFailed: 0,
        baseUrl: null,
        error: null,
      });
      return {
        result: "ok",
        durationMs,
        targetsAttempted: 0,
        targetsSucceeded: 0,
        targetsFailed: 0,
        baseUrl: null,
        error: null,
        policyEnabled: effective.enabled,
      };
    }

    const baseUrlResult = await resolveReachableBaseUrl(effective.requestTimeoutMs);
    if (!baseUrlResult.baseUrl) {
      const durationMs = Date.now() - startedAt;
      await setRunnerStatus(redis, {
        lastRunAt: new Date(startedAt).toISOString(),
        lastCompletedAt: new Date().toISOString(),
        lastResult: "error",
        durationMs,
        targetsAttempted: 0,
        targetsSucceeded: 0,
        targetsFailed: 0,
        baseUrl: null,
        error: baseUrlResult.error,
      });
      return {
        result: "error",
        durationMs,
        targetsAttempted: 0,
        targetsSucceeded: 0,
        targetsFailed: 0,
        baseUrl: null,
        error: baseUrlResult.error,
        policyEnabled: effective.enabled,
      };
    }

    let targetsSucceeded = 0;
    let targetsFailed = 0;
    for (const target of selectedTargets) {
      const targetResult = await runTarget(
        baseUrlResult.baseUrl,
        target,
        effective.requestTimeoutMs,
      );
      await updateTargetStats(redis, target, targetResult);
      if (targetResult.ok) targetsSucceeded += 1;
      else targetsFailed += 1;
    }

    const durationMs = Date.now() - startedAt;
    const result: ApiCacheWarmRunnerResult =
      targetsFailed === 0 ? "ok" : targetsSucceeded > 0 ? "partial" : "error";
    const error =
      targetsFailed > 0
        ? `${targetsFailed}/${selectedTargets.length} target(s) failed`
        : null;

    await setRunnerStatus(redis, {
      lastRunAt: new Date(startedAt).toISOString(),
      lastCompletedAt: new Date().toISOString(),
      lastResult: result,
      durationMs,
      targetsAttempted: selectedTargets.length,
      targetsSucceeded,
      targetsFailed,
      baseUrl: baseUrlResult.baseUrl,
      error,
    });

    return {
      result,
      durationMs,
      targetsAttempted: selectedTargets.length,
      targetsSucceeded,
      targetsFailed,
      baseUrl: baseUrlResult.baseUrl,
      error,
      policyEnabled: effective.enabled,
    };
  } finally {
    await releaseLock(redis, lockToken);
  }
}
