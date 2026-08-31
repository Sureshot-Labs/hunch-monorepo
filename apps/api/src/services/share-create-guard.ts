import { env } from "../env.js";
import {
  acquireDistributedSlot,
  checkRateLimit,
  releaseDistributedSlot,
} from "../lib/rate-limit.js";
import { getRedisStatus } from "../redis.js";
import type { PublicShareResponse } from "./share-snapshots.js";

export type ShareCreateKind = "portfolio_pnl" | "trade_pnl";

export type ShareCreateThrottleReason =
  | "burst_rate_limit"
  | "hour_rate_limit"
  | "user_inflight"
  | "global_inflight"
  | "guard_unavailable"
  | "request_timeout";

type GuardBackend = "redis" | "local" | "blocked";

type LocalRateBucket = {
  tokens: number;
  ts: number;
  expiresAt: number;
};

type LocalSlot = {
  count: number;
  expiresAt: number;
};

type LocalCacheEntry = {
  value: PublicShareResponse;
  expiresAt: number;
};

const SHARE_CREATE_BURST_MAX = 6;
const SHARE_CREATE_BURST_WINDOW_MS = 60 * 1000;
const SHARE_CREATE_HOURLY_MAX = 60;
const SHARE_CREATE_HOURLY_WINDOW_MS = 60 * 60 * 1000;
const SHARE_CREATE_SLOT_TTL_MS = 15 * 1000;
export const SHARE_REDIS_OPERATION_TIMEOUT_MS = 250;
export const TRADE_PNL_SHARE_REQUEST_TIMEOUT_MS = 2_500;
const TRADE_SHARE_RECENT_CACHE_TTL_SEC = 120;
const TRADE_SHARE_RECENT_CACHE_TTL_MS = TRADE_SHARE_RECENT_CACHE_TTL_SEC * 1000;

const localRateBuckets = new Map<string, LocalRateBucket>();
const localSlots = new Map<string, LocalSlot>();
const localTradeShareCache = new Map<string, LocalCacheEntry>();
const inflightTradeShareRequests = new Map<
  string,
  Promise<PublicShareResponse>
>();

const defaultShareGuardDependencies = {
  acquireDistributedSlot,
  checkRateLimit,
  getRedisStatus,
  releaseDistributedSlot,
};
let shareGuardDependencies = defaultShareGuardDependencies;

export class ShareCreateGuardError extends Error {
  readonly statusCode: 429 | 503;

  constructor(
    readonly reason: ShareCreateThrottleReason,
    readonly retryAfterSec: number,
  ) {
    super(
      reason === "request_timeout"
        ? "share_creation_timeout"
        : reason === "guard_unavailable"
          ? "share_guard_unavailable"
          : "rate_limit_exceeded",
    );
    this.name = "ShareCreateGuardError";
    this.statusCode =
      reason === "guard_unavailable" || reason === "request_timeout"
        ? 503
        : 429;
  }
}

function isProduction(): boolean {
  return env.nodeEnv === "production";
}

export async function settleShareDependency<T>(
  task: Promise<T>,
  timeoutMs: number,
  fallback: T,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guardedTask = task.catch(() => fallback);
  const deadline = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), timeoutMs);
  });
  try {
    return await Promise.race([guardedTask, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const SHARE_DEPENDENCY_UNAVAILABLE = Symbol("share_dependency_unavailable");

export async function settleRequiredShareDependency<T>(
  task: Promise<T>,
  timeoutMs: number = SHARE_REDIS_OPERATION_TIMEOUT_MS,
): Promise<T> {
  const result = await settleShareDependency<T | symbol>(
    task,
    timeoutMs,
    SHARE_DEPENDENCY_UNAVAILABLE,
  );
  if (result === SHARE_DEPENDENCY_UNAVAILABLE) {
    throw new ShareCreateGuardError("guard_unavailable", 15);
  }
  return result as T;
}

async function boundedRedisStatus() {
  return settleShareDependency(
    shareGuardDependencies.getRedisStatus(),
    SHARE_REDIS_OPERATION_TIMEOUT_MS,
    { redis: null, status: "error" as const, error: "deadline_exceeded" },
  );
}

async function resolveGuardBackend(): Promise<GuardBackend> {
  const { redis } = await boundedRedisStatus();
  if (redis) return "redis";
  return isProduction() ? "blocked" : "local";
}

function pruneExpiredLocalEntries(nowMs: number): void {
  for (const [key, value] of localRateBuckets) {
    if (value.expiresAt <= nowMs) localRateBuckets.delete(key);
  }
  for (const [key, value] of localSlots) {
    if (value.expiresAt <= nowMs) localSlots.delete(key);
  }
  for (const [key, value] of localTradeShareCache) {
    if (value.expiresAt <= nowMs) localTradeShareCache.delete(key);
  }
}

function checkLocalRateLimit(
  key: string,
  maxRequests: number,
  windowMs: number,
): boolean {
  const nowMs = Date.now();
  pruneExpiredLocalEntries(nowMs);
  const existing = localRateBuckets.get(key);
  const refillRate = maxRequests / windowMs;
  const elapsed = existing ? Math.max(0, nowMs - existing.ts) : 0;
  const tokens = existing
    ? Math.min(maxRequests, existing.tokens + elapsed * refillRate)
    : maxRequests;
  if (tokens < 1) {
    localRateBuckets.set(key, {
      tokens,
      ts: nowMs,
      expiresAt: nowMs + windowMs * 2,
    });
    return false;
  }
  localRateBuckets.set(key, {
    tokens: tokens - 1,
    ts: nowMs,
    expiresAt: nowMs + windowMs * 2,
  });
  return true;
}

function acquireLocalSlot(
  key: string,
  maxSlots: number,
  ttlMs: number,
): boolean {
  const nowMs = Date.now();
  pruneExpiredLocalEntries(nowMs);
  const existing = localSlots.get(key);
  const count = existing?.count ?? 0;
  if (count >= maxSlots) return false;
  localSlots.set(key, { count: count + 1, expiresAt: nowMs + ttlMs });
  return true;
}

function releaseLocalSlot(key: string, ttlMs: number): void {
  const nowMs = Date.now();
  pruneExpiredLocalEntries(nowMs);
  const existing = localSlots.get(key);
  if (!existing) return;
  if (existing.count <= 1) {
    localSlots.delete(key);
    return;
  }
  localSlots.set(key, {
    count: existing.count - 1,
    expiresAt: nowMs + ttlMs,
  });
}

async function checkGuardRateLimit(
  backend: GuardBackend,
  key: string,
  maxRequests: number,
  windowMs: number,
): Promise<boolean> {
  if (backend === "local")
    return checkLocalRateLimit(key, maxRequests, windowMs);
  if (backend === "redis") {
    return settleRequiredShareDependency(
      shareGuardDependencies.checkRateLimit(key, maxRequests, windowMs, {
        // A real false means the caller exhausted its quota. Redis failure is
        // a retryable dependency outage and must not masquerade as HTTP 429.
        onError: "throw",
      }),
    );
  }
  return false;
}

async function acquireGuardSlot(
  backend: GuardBackend,
  key: string,
  maxSlots: number,
): Promise<boolean> {
  if (backend === "local") {
    return acquireLocalSlot(key, maxSlots, SHARE_CREATE_SLOT_TTL_MS);
  }
  if (backend === "redis") {
    return settleRequiredShareDependency(
      shareGuardDependencies.acquireDistributedSlot(
        key,
        maxSlots,
        SHARE_CREATE_SLOT_TTL_MS,
        {
          // Preserve the distinction between a full slot (429) and an
          // unavailable guard backend (typed retryable 503).
          onError: "throw",
        },
      ),
    );
  }
  return false;
}

async function releaseGuardSlot(
  backend: GuardBackend,
  key: string,
): Promise<void> {
  if (backend === "local") {
    releaseLocalSlot(key, SHARE_CREATE_SLOT_TTL_MS);
    return;
  }
  if (backend === "redis") {
    await settleShareDependency(
      shareGuardDependencies.releaseDistributedSlot(
        key,
        SHARE_CREATE_SLOT_TTL_MS,
      ),
      SHARE_REDIS_OPERATION_TIMEOUT_MS,
      undefined,
    );
  }
}

function normalizeReferralCacheKey(
  referralCode: string | null | undefined,
): string {
  const normalized = referralCode?.trim().toUpperCase();
  return normalized && normalized.length > 0 ? normalized : "default";
}

function tradeShareCacheKey(inputs: {
  userId: string;
  positionId: string;
  referralCode?: string | null;
}): string {
  return [
    "shares",
    "trade-pnl",
    "recent",
    inputs.userId,
    inputs.positionId,
    normalizeReferralCacheKey(inputs.referralCode),
  ].join(":");
}

function parseCachedShare(value: string | null): PublicShareResponse | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as PublicShareResponse;
  } catch {
    return null;
  }
}

export async function getCachedTradePnlShare(inputs: {
  userId: string;
  positionId: string;
  referralCode?: string | null;
}): Promise<PublicShareResponse | null> {
  const key = tradeShareCacheKey(inputs);
  const { redis } = await boundedRedisStatus();
  if (redis) {
    return parseCachedShare(
      await settleShareDependency(
        redis.get(key),
        SHARE_REDIS_OPERATION_TIMEOUT_MS,
        null,
      ),
    );
  }

  if (isProduction()) return null;

  const nowMs = Date.now();
  pruneExpiredLocalEntries(nowMs);
  return localTradeShareCache.get(key)?.value ?? null;
}

export async function cacheTradePnlShare(
  inputs: {
    userId: string;
    positionId: string;
    referralCode?: string | null;
  },
  share: PublicShareResponse,
): Promise<void> {
  const key = tradeShareCacheKey(inputs);
  const { redis } = await boundedRedisStatus();
  if (redis) {
    await settleShareDependency(
      redis
        .set(key, JSON.stringify(share), {
          EX: TRADE_SHARE_RECENT_CACHE_TTL_SEC,
        })
        .then(() => undefined),
      SHARE_REDIS_OPERATION_TIMEOUT_MS,
      undefined,
    );
    return;
  }

  if (isProduction()) return;

  const nowMs = Date.now();
  pruneExpiredLocalEntries(nowMs);
  localTradeShareCache.set(key, {
    value: share,
    expiresAt: nowMs + TRADE_SHARE_RECENT_CACHE_TTL_MS,
  });
}

export async function withTradePnlShareSingleflight(
  inputs: {
    userId: string;
    positionId: string;
    referralCode?: string | null;
  },
  fn: () => Promise<PublicShareResponse>,
  deadlineAt: number = Date.now() + TRADE_PNL_SHARE_REQUEST_TIMEOUT_MS,
): Promise<PublicShareResponse> {
  const key = tradeShareCacheKey(inputs);
  const existing = inflightTradeShareRequests.get(key);
  if (existing) return settleTradeShareBeforeDeadline(existing, deadlineAt);

  if (deadlineAt <= Date.now()) {
    throw new ShareCreateGuardError("request_timeout", 5);
  }

  // The singleflight promise itself owns the deadline. If the underlying DB
  // or cache work stops making progress, the entry is evicted when this
  // bounded promise rejects, so later retries never inherit a permanently
  // pending request.
  const pending = settleTradeShareBeforeDeadline(
    Promise.resolve().then(fn),
    deadlineAt,
  ).finally(() => {
    if (inflightTradeShareRequests.get(key) === pending) {
      inflightTradeShareRequests.delete(key);
    }
  });
  inflightTradeShareRequests.set(key, pending);
  return pending;
}

async function settleTradeShareBeforeDeadline<T>(
  task: Promise<T>,
  deadlineAt: number,
): Promise<T> {
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) {
    throw new ShareCreateGuardError("request_timeout", 5);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new ShareCreateGuardError("request_timeout", 5)),
      remainingMs,
    );
  });
  try {
    return await Promise.race([task, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function withShareCreateGuard<T>(
  inputs: { userId: string; kind: ShareCreateKind },
  fn: () => Promise<T>,
): Promise<T> {
  const backend = await resolveGuardBackend();
  if (backend === "blocked") {
    throw new ShareCreateGuardError("guard_unavailable", 15);
  }

  const userSlotKey = `shares:create:user:${inputs.userId}`;
  const globalSlotKey = "shares:create:global";
  const releaseKeys: string[] = [];

  try {
    const userSlotAcquired = await acquireGuardSlot(backend, userSlotKey, 1);
    if (!userSlotAcquired) {
      throw new ShareCreateGuardError("user_inflight", 15);
    }
    releaseKeys.push(userSlotKey);

    const globalSlotAcquired = await acquireGuardSlot(
      backend,
      globalSlotKey,
      4,
    );
    if (!globalSlotAcquired) {
      throw new ShareCreateGuardError("global_inflight", 15);
    }
    releaseKeys.push(globalSlotKey);

    const burstAllowed = await checkGuardRateLimit(
      backend,
      `shares:create:burst:${inputs.userId}`,
      SHARE_CREATE_BURST_MAX,
      SHARE_CREATE_BURST_WINDOW_MS,
    );
    if (!burstAllowed) {
      throw new ShareCreateGuardError("burst_rate_limit", 60);
    }

    const hourlyAllowed = await checkGuardRateLimit(
      backend,
      `shares:create:${inputs.userId}`,
      SHARE_CREATE_HOURLY_MAX,
      SHARE_CREATE_HOURLY_WINDOW_MS,
    );
    if (!hourlyAllowed) {
      throw new ShareCreateGuardError("hour_rate_limit", 60);
    }

    return await fn();
  } finally {
    await Promise.all(
      releaseKeys.reverse().map((key) => releaseGuardSlot(backend, key)),
    );
  }
}

export function resetShareCreateGuardForTests(): void {
  localRateBuckets.clear();
  localSlots.clear();
  localTradeShareCache.clear();
  inflightTradeShareRequests.clear();
  shareGuardDependencies = defaultShareGuardDependencies;
}

export function clearTradePnlShareSingleflightForTests(): void {
  inflightTradeShareRequests.clear();
}

export function setShareCreateGuardDependenciesForTests(
  overrides: Partial<typeof defaultShareGuardDependencies>,
): void {
  shareGuardDependencies = {
    ...defaultShareGuardDependencies,
    ...overrides,
  };
}
