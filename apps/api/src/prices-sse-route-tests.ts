// Offline route integration: real preHandler/stream handler, fake Redis,
// subscriptions and writable response. No listening socket, DB or provider IO.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { DEFAULT_HIP4_READ_POLICY } from "@hunch/shared";
import { createPricesSseRoutes } from "./routes/prices-sse.js";

const token = "hyperliquid:mainnet:1230";
const legacyToken = "123456";
const policy = {
  ...DEFAULT_HIP4_READ_POLICY,
  enabled: true,
  liveEnabled: true,
  bookMaxAgeMs: 1_000,
};
type RouteHandler = (
  request: FastifyRequest,
  reply: FastifyReply,
) => Promise<unknown>;

async function stream(cached: unknown, tokens = [token, legacyToken]) {
  const writes: string[] = [];
  const subscriptions: string[][] = [];
  const hot: string[][] = [];
  const cachedKeys: string[] = [];
  let policyReads = 0;
  let allowedReads = 0;
  let releases = 0;
  let unsubscribes = 0;
  let listener: (payload: unknown) => void = () => {};
  let preHandler: RouteHandler | undefined;
  let handler: RouteHandler | undefined;
  const fakeApp = {
    withTypeProvider() {
      return this;
    },
    get(
      _path: string,
      options: { preHandler: RouteHandler },
      route: RouteHandler,
    ) {
      preHandler = options.preHandler;
      handler = route;
    },
  };
  const route = createPricesSseRoutes({
    policy: async () => {
      policyReads++;
      return { revision: "current", policy };
    },
    tokensAllowed: async () => {
      allowedReads++;
      return true;
    },
    redisStatus: async () => ({
      status: "ready",
      redis: {
        get: async (key) => {
          cachedKeys.push(key);
          if (key === `top:${token}`) return JSON.stringify(cached);
          if (key === `top:${legacyToken}`)
            return JSON.stringify({
              token_id: legacyToken,
              best_bid: 0.1,
              ts: 1,
            });
          return null;
        },
      },
    }),
    checkRateLimit: async () => true,
    acquireDistributedSlot: async () => true,
    releaseDistributedSlot: async () => {
      releases++;
    },
    markHotTokens: async ({ tokenIds }) => {
      hot.push(tokenIds as string[]);
    },
    markStreamHotTokens: async ({ tokenIds }) => {
      hot.push(tokenIds as string[]);
    },
    subscribeToPriceTicks: async (ids, callback) => {
      subscriptions.push(ids);
      listener = callback;
      return () => {
        unsubscribes++;
      };
    },
    subscribeToMarketStates: async (ids) => {
      subscriptions.push(ids);
      return () => {
        unsubscribes++;
      };
    },
    subscribeToMarketUpdates: async (ids) => {
      subscriptions.push(ids);
      return () => {
        unsubscribes++;
      };
    },
  });
  await route(fakeApp as unknown as FastifyInstance, {});
  assert.ok(preHandler && handler);
  const requestRaw = Object.assign(new EventEmitter(), { destroyed: false });
  const request = {
    raw: requestRaw,
    ip: "127.0.0.1",
    headers: {},
    query: { token_id: tokens },
    log: { warn() {} },
  } as unknown as FastifyRequest;
  const replyRaw = Object.assign(new EventEmitter(), {
    setHeader() {},
    flushHeaders() {},
    write(value: string) {
      writes.push(value);
      return true;
    },
    end() {
      requestRaw.emit("close");
    },
  });
  const reply = {
    header() {},
    raw: replyRaw,
    code() {
      throw new Error("unexpected rejected handshake");
    },
  } as unknown as FastifyReply;
  try {
    await preHandler(request, reply);
    await handler(request, reply);
  } catch (error) {
    requestRaw.emit("close");
    throw error;
  }
  return {
    publish: (payload: unknown) => listener(payload),
    ticks: () =>
      writes
        .filter((value) => value.startsWith("data: "))
        .map((value) => JSON.parse(value.slice(6)) as Record<string, unknown>),
    close: () => requestRaw.emit("close"),
    stats: () => ({
      policyReads,
      allowedReads,
      releases,
      unsubscribes,
      subscriptions,
      hot,
      cachedKeys,
    }),
  };
}

test("cached and pubsub HIP ticks share current revision/deadline validation without per-tick reads", async (t) => {
  const now = Date.now();
  let clock = now;
  t.mock.method(Date, "now", () => clock);
  const current = {
    token_id: token,
    best_bid: 0.4,
    best_ask: 0.6,
    ts: now,
    valid_until: new Date(now + 1_000).toISOString(),
    policy_revision: "current",
  };
  const old = {
    ...current,
    ts: now - 30_000,
    valid_until: new Date(now + 30_000).toISOString(),
    policy_revision: "previous",
  };
  for (const cached of [
    current,
    old,
    { ...old, policy_revision: "current" },
    { ...current, ts: now + 60_000 },
  ]) {
    const active = await stream(cached);
    try {
      assert.equal(
        active.ticks().filter((row) => row.token_id === token).length,
        cached === current ? 1 : 0,
      );
      assert.equal(
        active.ticks().filter((row) => row.token_id === legacyToken).length,
        1,
      );
      const count = active.ticks().length;
      for (const rejected of [
        old,
        { ...old, policy_revision: "current" },
        { ...current, ts: now + 60_000 },
        { ...current, valid_until: "invalid" },
      ])
        active.publish(rejected);
      assert.equal(active.ticks().length, count);
      active.publish(current);
      active.publish({ token_id: legacyToken, ts: 1, best_bid: 0.2 });
      assert.equal(active.ticks().length, count + 2);
      clock = now + 1_000;
      active.publish(current);
      assert.equal(
        active.ticks().length,
        count + 2,
        "an accepted observation is re-aged on every forward, not given a new TTL",
      );
      assert.deepEqual(
        active.stats().subscriptions,
        Array(3).fill([token, legacyToken]),
      );
      assert.deepEqual(active.stats().hot, Array(2).fill([token, legacyToken]));
      assert.equal(active.stats().cachedKeys.length, 8);
      assert.equal(active.stats().policyReads, 1);
      assert.equal(active.stats().allowedReads, 1);
    } finally {
      active.close();
    }
    assert.equal(active.stats().releases, 1);
    assert.equal(active.stats().unsubscribes, 3);
    clock = now;
  }
});

test("legacy-only streams do not read HIP policy or require HIP tick metadata", async () => {
  const active = await stream(null, [legacyToken]);
  try {
    active.publish({ token_id: legacyToken, ts: 1, best_ask: 0.7 });
    assert.equal(active.ticks().length, 2);
    assert.equal(active.stats().policyReads, 0);
    assert.equal(active.stats().allowedReads, 0);
  } finally {
    active.close();
  }
});
