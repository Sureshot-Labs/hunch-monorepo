#!/usr/bin/env tsx

import assert from "node:assert/strict";

import { env } from "./env.js";
import {
  cacheTradePnlShare,
  getCachedTradePnlShare,
  resetShareCreateGuardForTests,
  setShareCreateGuardDependenciesForTests,
  settleShareDependency,
  settleRequiredShareDependency,
  ShareCreateGuardError,
  withShareCreateGuard,
  withTradePnlShareSingleflight,
} from "./services/share-create-guard.js";

function never<T>(): Promise<T> {
  return new Promise<T>(() => undefined);
}

async function expectGuardUnavailable(
  task: Promise<unknown>,
): Promise<ShareCreateGuardError> {
  try {
    await task;
  } catch (error) {
    assert.ok(error instanceof ShareCreateGuardError);
    assert.equal(error.reason, "guard_unavailable");
    assert.equal(error.statusCode, 503);
    return error;
  }
  assert.fail("expected ShareCreateGuardError");
}

const slowStartedAt = Date.now();
const slow = await settleShareDependency(
  new Promise<string>(() => undefined),
  25,
  "fallback",
);
assert.equal(slow, "fallback");
assert.ok(Date.now() - slowStartedAt < 250);

const failed = await settleShareDependency(
  Promise.reject(new Error("cache unavailable")),
  250,
  "fallback",
);
assert.equal(failed, "fallback");

const requiredStartedAt = Date.now();
await expectGuardUnavailable(settleRequiredShareDependency(never(), 25));
assert.ok(Date.now() - requiredStartedAt < 250);

const previousNodeEnv = env.nodeEnv;
const previousRedisUrl = env.redisUrl;
try {
  env.nodeEnv = "production";
  env.redisUrl = "";

  const slowRedis = {
    get: () => never<string | null>(),
    set: () => never<string | null>(),
  };
  setShareCreateGuardDependenciesForTests({
    getRedisStatus: async () => ({
      redis: slowRedis as never,
      status: "ready" as const,
    }),
  });
  const cacheReadStartedAt = Date.now();
  assert.equal(
    await getCachedTradePnlShare({
      userId: "user_slow_cache_12345678",
      positionId: "position_slow_cache_12345678",
    }),
    null,
  );
  assert.ok(Date.now() - cacheReadStartedAt < 750);

  const cacheWriteStartedAt = Date.now();
  await cacheTradePnlShare(
    {
      userId: "user_slow_cache_12345678",
      positionId: "position_slow_cache_12345678",
    },
    {
      id: "share_slow_cache_12345678",
      kind: "trade_pnl",
      createdAt: new Date(0).toISOString(),
    },
  );
  assert.ok(Date.now() - cacheWriteStartedAt < 750);

  // The share boundary sees Redis as configured while the actual rate-limit
  // dependency sees the disabled backend. Both slot and quota failures must
  // surface as retryable 503, never as a false 429.
  setShareCreateGuardDependenciesForTests({
    getRedisStatus: async () => ({
      redis: slowRedis as never,
      status: "ready" as const,
    }),
  });
  const slotStartedAt = Date.now();
  await expectGuardUnavailable(
    withShareCreateGuard(
      { userId: "user_slot_outage_12345678", kind: "trade_pnl" },
      async () => "unreachable",
    ),
  );
  assert.ok(Date.now() - slotStartedAt < 750);

  setShareCreateGuardDependenciesForTests({
    acquireDistributedSlot: async () => true,
    getRedisStatus: async () => ({
      redis: slowRedis as never,
      status: "ready" as const,
    }),
    releaseDistributedSlot: async () => undefined,
  });
  const rateStartedAt = Date.now();
  await expectGuardUnavailable(
    withShareCreateGuard(
      { userId: "user_rate_outage_12345678", kind: "trade_pnl" },
      async () => "unreachable",
    ),
  );
  assert.ok(Date.now() - rateStartedAt < 750);

  setShareCreateGuardDependenciesForTests({
    acquireDistributedSlot: async () => false,
    getRedisStatus: async () => ({
      redis: slowRedis as never,
      status: "ready" as const,
    }),
  });
  await assert.rejects(
    withShareCreateGuard(
      { userId: "user_real_limit_12345678", kind: "trade_pnl" },
      async () => "unreachable",
    ),
    (error: unknown) => {
      assert.ok(error instanceof ShareCreateGuardError);
      assert.equal(error.reason, "user_inflight");
      assert.equal(error.statusCode, 429);
      return true;
    },
  );
} finally {
  env.nodeEnv = previousNodeEnv;
  env.redisUrl = previousRedisUrl;
  resetShareCreateGuardForTests();
}

resetShareCreateGuardForTests();
let createCount = 0;
const requests = Array.from({ length: 8 }, () =>
  withTradePnlShareSingleflight(
    {
      userId: "user_share_guard_12345678",
      positionId: "position_share_guard_12345678",
      referralCode: "hunch",
    },
    async () => {
      createCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return {
        id: "trade_share_guard_12345678",
        kind: "trade_pnl" as const,
        createdAt: new Date(0).toISOString(),
      };
    },
  ),
);
const shares = await Promise.all(requests);
assert.equal(createCount, 1);
assert.equal(new Set(shares.map((share) => share.id)).size, 1);

resetShareCreateGuardForTests();
const stuckInputs = {
  userId: "user_stuck_share_guard_12345678",
  positionId: "position_stuck_share_guard_12345678",
};
const stuckStartedAt = Date.now();
await assert.rejects(
  withTradePnlShareSingleflight(stuckInputs, () => never(), Date.now() + 25),
  (error: unknown) => {
    assert.ok(error instanceof ShareCreateGuardError);
    assert.equal(error.reason, "request_timeout");
    assert.equal(error.statusCode, 503);
    assert.equal(error.message, "share_creation_timeout");
    return true;
  },
);
assert.ok(Date.now() - stuckStartedAt < 250);

// A timed-out producer must be removed from singleflight immediately. The
// retry below must execute its own producer instead of inheriting `never()`.
let retryCreateCount = 0;
const retry = await withTradePnlShareSingleflight(
  stuckInputs,
  async () => {
    retryCreateCount += 1;
    return {
      id: "trade_share_retry_after_timeout_12345678",
      kind: "trade_pnl" as const,
      createdAt: new Date(0).toISOString(),
    };
  },
  Date.now() + 250,
);
assert.equal(retryCreateCount, 1);
assert.equal(retry.id, "trade_share_retry_after_timeout_12345678");

console.log(
  "[share-create-guard-tests] ok dependency deadlines, bounded singleflight, and retry after timeout",
);
