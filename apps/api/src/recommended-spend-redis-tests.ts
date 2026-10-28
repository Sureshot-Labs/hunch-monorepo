// @requires-redis @isolated-process
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { env } from "./env.js";
import { checkRateLimit } from "./lib/rate-limit.js";
import { getRedisStatus, closeRedis } from "./redis.js";

const url = new URL(env.redisUrl ?? "redis://invalid");
assert.ok(["localhost", "127.0.0.1"].includes(url.hostname));
assert.equal(url.port, "6380", "only the explicitly selected local Redis");
const key = `recommended-spend-test:${randomUUID()}`;
const redisKey = `rate:v3:60000:2:${key}`;
const { redis, status } = await getRedisStatus();
assert.equal(status, "ready");
assert.ok(redis);
try {
  assert.equal(await redis.exists(redisKey), 0);
  const allowed = await Promise.all(
    Array.from({ length: 8 }, () =>
      checkRateLimit(key, 2, 60_000, { onError: "throw" }),
    ),
  );
  assert.equal(allowed.filter(Boolean).length, 2);
  assert.ok((await redis.pTTL(redisKey)) > 0);
  console.log(
    "Recommended spend existing Redis token bucket: 2/8 parallel requests admitted, bounded TTL",
  );
} finally {
  // Exact test-owned key only; never flush a shared local Redis database.
  await redis.del(redisKey);
  await closeRedis();
}
