// @requires-db
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createIntegrationTestPool } from "./test-database-target.js";
import { createClient } from "redis";
import {
  discoverBackgroundPolymarketPositions as discover,
  type PositionDiscoveryStore,
} from "./services/polymarket-background-positions.js";
const guardedPool = await createIntegrationTestPool({ max: 1 });
await guardedPool.end();
const redisUrl =
  process.env.HUNCH_WALLET_INTEL_TEST_REDIS_URL || "redis://127.0.0.1:6380";
const redisTarget = new URL(redisUrl);
assert.ok(
  ["127.0.0.1", "localhost", "[::1]"].includes(redisTarget.hostname),
  "checkpoint fixtures require a local Redis",
);
const redis = createClient({
  url: redisUrl,
  socket: { connectTimeout: 2000, reconnectStrategy: false },
});
assert.ok(redis);
redis.on("error", () => {});
await redis.connect();
const prefix = `wallet-position-test:${randomUUID()}:`;
const keys = new Set<string>();
const keyFor = (key: string) => {
  assert.match(key, /^wallet-intel:poly-positions:v1:[a-f0-9]{64}$/);
  const scoped = prefix + key;
  keys.add(scoped);
  return scoped;
};
const store: PositionDiscoveryStore = {
  get: (key) => redis.get(keyFor(key)),
  set: (key, value, options) => redis.set(keyFor(key), value, options),
  del: (key) => redis.del(keyFor(key)),
};
const owner = "0x1111111111111111111111111111111111111111";
const cursorCalls: (string | null)[] = [];
const fetchImpl = (async (input: URL | string | Request) => {
  const cursor = new URL(String(input)).searchParams.get("cursor");
  cursorCalls.push(cursor);
  return Response.json({
    data: [
      {
        token_id: cursor ? "2" : "1",
        proxy_wallet: owner,
        condition_id: `0x${"11".repeat(32)}`,
        current_size: 1,
        avg_price: 0.4,
        outcome_index: 0,
        redeemable: false,
      },
    ],
    pagination: { next_cursor: cursor ? null : "opaque" },
  });
}) as typeof fetch;
const input = {
  owner,
  baseUrl: "https://checkpoint.example.invalid",
  store,
  fetchImpl,
};
try {
  const first = await discover({ ...input, config: { pagesPerSlice: 1 } });
  assert.equal(first.status, "deferred");
  assert.equal(first.reason, "page_budget");
  assert.equal(first.pages, 1);
  assert.equal(first.checkpointAvailable, true);
  const [key] = keys;
  assert.ok(key);
  assert.ok((await redis.pTTL(key)) > 0);
  // An independent reader/process resumes the opaque cursor and completes the inventory.
  const second = await discover({ ...input, store: { ...store } });
  assert.equal(second.status, "complete");
  assert.equal(second.resumed, true);
  assert.equal(second.tokens.length, 2);
  assert.deepEqual(cursorCalls, [null, "opaque"]);
  assert.equal(await redis.exists(key), 0);
  await discover({ ...input, config: { pagesPerSlice: 1 } });
  await redis.pExpire(key, 1);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const afterExpiry = await discover({
    ...input,
    config: { pagesPerSlice: 1 },
  });
  assert.equal(afterExpiry.resumed, false);
  assert.equal(cursorCalls.at(-1), null);
  // Temporary checkpoint failure never authorizes a partial portfolio; reconnect can recover.
  const unavailable = await discover({
    ...input,
    store: {
      get: async () => {
        throw Error("offline");
      },
      set: async () => {
        throw Error("offline");
      },
      del: async () => {
        throw Error("offline");
      },
    },
    config: { pagesPerSlice: 1 },
  });
  assert.equal(unavailable.status, "deferred");
  assert.equal(unavailable.checkpointAvailable, false);
  assert.deepEqual(unavailable.tokens, []);
  const recovery = await discover(input);
  assert.equal(recovery.status, "complete");
  assert.equal(recovery.resumed, true);
  console.log(
    "[position checkpoints] real Redis resume/expiry/outage/recovery passed",
  );
} finally {
  // Exact generated test keys only: never FLUSHDB or pattern deletion.
  for (const key of keys) {
    assert.ok(key.startsWith(prefix));
    await redis.del(key);
  }
  await redis.quit();
}
