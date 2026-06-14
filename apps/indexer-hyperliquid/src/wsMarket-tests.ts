import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { Pool } from "pg";
import type { RedisClientType } from "@hunch/infra";
import WebSocket from "ws";
import {
  buildHyperliquidWsPingMessage,
  buildHyperliquidTokenByCoin,
  createHyperliquidTopPublisher,
  isHyperliquidWsPongMessage,
  resetHyperliquidMarketWSForTest,
  shouldCloseHyperliquidHeartbeat,
  shouldReconnectClosedHyperliquidSocket,
  shouldResubscribeHyperliquidStream,
  startHyperliquidMarketWS,
  updateHyperliquidMarketWSSubscriptions,
  waitForHyperliquidWsPublishesForTest,
  type HyperliquidTopPublishPayload,
} from "./wsMarket.js";

type TestFn = () => void | Promise<void>;

const tests: Array<{ name: string; fn: TestFn }> = [];

function test(name: string, fn: TestFn): void {
  tests.push({ name, fn });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class FakeWebSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  sent: string[] = [];
  pingCount = 0;
  closeCount = 0;

  send(payload: string): void {
    this.sent.push(payload);
  }

  ping(): void {
    this.pingCount += 1;
  }

  close(): void {
    this.closeCount += 1;
    this.readyState = WebSocket.CLOSED;
    this.emit("close", 1000, Buffer.from("test close"));
  }
}

function sentSubscriptions(ws: FakeWebSocket): Array<{
  method: string;
  coin: string;
}> {
  return ws.sent.map((payload) => {
    const parsed = JSON.parse(payload) as {
      method: string;
      subscription: { coin: string };
    };
    return { method: parsed.method, coin: parsed.subscription.coin };
  });
}

function fakePoolAndRedis(): {
  pool: Pool;
  redis: RedisClientType;
  poolTokenWrites: string[];
  redisWrites: Array<{ type: "set" | "publish"; key: string; value: string }>;
} {
  const poolTokenWrites: string[] = [];
  const redisWrites: Array<{
    type: "set" | "publish";
    key: string;
    value: string;
  }> = [];
  const pool = {
    query: async (_sql: string, params?: unknown[]) => {
      if (Array.isArray(params) && typeof params[0] === "string") {
        poolTokenWrites.push(params[0]);
      }
      return { rows: [] };
    },
  } as unknown as Pool;

  const redis = {
    multi: () => {
      const multi = {
        set: (key: string, value: string) => {
          redisWrites.push({ type: "set", key, value });
          return multi;
        },
        publish: (key: string, value: string) => {
          redisWrites.push({ type: "publish", key, value });
          return multi;
        },
        exec: async () => [],
      };
      return multi;
    },
  } as unknown as RedisClientType;

  return { pool, redis, poolTokenWrites, redisWrites };
}

test("buildHyperliquidTokenByCoin reflects current subscription targets", () => {
  let map = buildHyperliquidTokenByCoin([
    { coin: "#50", tokenId: "hyperliquid:100000050" },
    { coin: "#51", tokenId: "hyperliquid:100000051" },
  ]);
  assert.equal(map.get("#50"), "hyperliquid:100000050");
  assert.equal(map.get("#51"), "hyperliquid:100000051");

  map = buildHyperliquidTokenByCoin([
    { coin: "#50", tokenId: "hyperliquid:100000150" },
  ]);
  assert.equal(map.get("#50"), "hyperliquid:100000150");
  assert.equal(map.has("#51"), false);
});

test("top publisher suppresses unchanged ticks and publishes changed ticks", async () => {
  const published: HyperliquidTopPublishPayload[] = [];
  const publisher = createHyperliquidTopPublisher({
    concurrency: 4,
    maxQueued: 100,
    gateOptions: { minIntervalMs: 0, heartbeatMs: 0 },
    publishNow: async (payload) => {
      published.push(payload);
    },
  });

  assert.equal(
    publisher.publish({
      tokenId: "hyperliquid:100000050",
      bestBid: 0.42,
      bestAsk: 0.43,
      tsMs: 1_000,
    }),
    true,
  );
  assert.equal(
    publisher.publish({
      tokenId: "hyperliquid:100000050",
      bestBid: 0.42,
      bestAsk: 0.43,
      tsMs: 1_001,
    }),
    false,
  );
  assert.equal(
    publisher.publish({
      tokenId: "hyperliquid:100000050",
      bestBid: 0.421,
      bestAsk: 0.43,
      tsMs: 1_002,
    }),
    true,
  );

  await publisher.onIdle();
  assert.deepEqual(
    published.map((payload) => payload.bestBid),
    [0.42, 0.421],
  );
});

test("top publisher flushes throttled changes through the same queue", async () => {
  const published: HyperliquidTopPublishPayload[] = [];
  const firstPublish = deferred();
  let active = 0;
  let maxActive = 0;
  const publisher = createHyperliquidTopPublisher({
    concurrency: 1,
    maxQueued: 100,
    gateOptions: { minIntervalMs: 20, heartbeatMs: 0 },
    publishNow: async (payload) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      published.push(payload);
      if (payload.bestBid === 0.5) {
        await firstPublish.promise;
      }
      active -= 1;
    },
  });

  assert.equal(
    publisher.publish({
      tokenId: "hyperliquid:100000050",
      bestBid: 0.5,
      bestAsk: 0.51,
      tsMs: 2_000,
    }),
    true,
  );
  assert.equal(
    publisher.publish({
      tokenId: "hyperliquid:100000050",
      bestBid: 0.52,
      bestAsk: 0.53,
      tsMs: 2_001,
    }),
    false,
  );

  await delay(35);
  assert.deepEqual(publisher.stats(), {
    queued: 1,
    running: 1,
    coalesced: 0,
  });
  firstPublish.resolve();
  await publisher.onIdle();
  assert.deepEqual(
    published.map((payload) => payload.bestBid),
    [0.5, 0.52],
  );
  assert.equal(maxActive, 1);
});

test("top publisher honors the configured queue concurrency", async () => {
  let active = 0;
  let maxActive = 0;
  const publisher = createHyperliquidTopPublisher({
    concurrency: 1,
    maxQueued: 100,
    gateOptions: { minIntervalMs: 0, heartbeatMs: 0 },
    publishNow: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await delay(5);
      active -= 1;
    },
  });

  publisher.publish({
    tokenId: "hyperliquid:100000050",
    bestBid: 0.4,
    bestAsk: 0.41,
    tsMs: 3_000,
  });
  publisher.publish({
    tokenId: "hyperliquid:100000051",
    bestBid: 0.6,
    bestAsk: 0.61,
    tsMs: 3_001,
  });
  publisher.publish({
    tokenId: "hyperliquid:100000052",
    bestBid: 0.7,
    bestAsk: 0.71,
    tsMs: 3_002,
  });

  await publisher.onIdle();
  assert.equal(maxActive, 1);
});

test("top publisher coalesces latest per-token tick when queue is full", async () => {
  const firstPublish = deferred();
  const published: HyperliquidTopPublishPayload[] = [];
  const publisher = createHyperliquidTopPublisher({
    concurrency: 1,
    maxQueued: 1,
    gateOptions: { minIntervalMs: 0, heartbeatMs: 0 },
    publishNow: async (payload) => {
      published.push(payload);
      if (payload.tokenId === "hyperliquid:100000060") {
        await firstPublish.promise;
      }
    },
  });

  publisher.publish({
    tokenId: "hyperliquid:100000060",
    bestBid: 0.1,
    bestAsk: 0.11,
    tsMs: 4_000,
  });
  await delay(0);
  publisher.publish({
    tokenId: "hyperliquid:100000061",
    bestBid: 0.2,
    bestAsk: 0.21,
    tsMs: 4_001,
  });
  publisher.publish({
    tokenId: "hyperliquid:100000061",
    bestBid: 0.3,
    bestAsk: 0.31,
    tsMs: 4_002,
  });
  publisher.publish({
    tokenId: "hyperliquid:100000061",
    bestBid: 0.4,
    bestAsk: 0.41,
    tsMs: 4_003,
  });

  assert.deepEqual(publisher.stats(), {
    queued: 1,
    running: 1,
    coalesced: 1,
  });
  firstPublish.resolve();
  await publisher.onIdle();
  assert.deepEqual(
    published.map((payload) => payload.bestBid),
    [0.1, 0.2, 0.4],
  );
});

test("stale and intentionally closed sockets do not schedule reconnects", () => {
  assert.equal(
    shouldReconnectClosedHyperliquidSocket({
      isCurrentSocket: true,
      intentionallyClosed: false,
    }),
    true,
  );
  assert.equal(
    shouldReconnectClosedHyperliquidSocket({
      isCurrentSocket: true,
      intentionallyClosed: true,
    }),
    false,
  );
  assert.equal(
    shouldReconnectClosedHyperliquidSocket({
      isCurrentSocket: false,
      intentionallyClosed: false,
    }),
    false,
  );
});

test("heartbeat helpers detect pong timeout and stale stream resubscribe", () => {
  assert.equal(
    buildHyperliquidWsPingMessage(),
    JSON.stringify({ method: "ping" }),
  );
  assert.equal(isHyperliquidWsPongMessage({ channel: "pong" }), true);
  assert.equal(isHyperliquidWsPongMessage({ channel: "bbo" }), false);
  assert.equal(
    shouldCloseHyperliquidHeartbeat({
      nowMs: 70_001,
      lastPongAtMs: 10_000,
      pongTimeoutMs: 60_000,
    }),
    true,
  );
  assert.equal(
    shouldCloseHyperliquidHeartbeat({
      nowMs: 69_999,
      lastPongAtMs: 10_000,
      pongTimeoutMs: 60_000,
    }),
    false,
  );
  assert.equal(
    shouldResubscribeHyperliquidStream({
      nowMs: 130_000,
      lastMessageAtMs: 0,
      lastResubscribeAtMs: 0,
      staleMs: 120_000,
    }),
    true,
  );
  assert.equal(
    shouldResubscribeHyperliquidStream({
      nowMs: 130_000,
      lastMessageAtMs: 0,
      lastResubscribeAtMs: 20_000,
      staleMs: 120_000,
    }),
    false,
  );
});

test("websocket subscriptions update active coins through runtime API", () => {
  resetHyperliquidMarketWSForTest();
  const ws = new FakeWebSocket();
  const { pool, redis } = fakePoolAndRedis();
  try {
    startHyperliquidMarketWS({
      wsUrl: "wss://example.invalid",
      pool,
      redis,
      targets: [
        { coin: "#50", tokenId: "hyperliquid:100000050" },
        { coin: "#51", tokenId: "hyperliquid:100000051" },
      ],
      createWebSocket: () => ws as unknown as WebSocket,
    });
    ws.emit("open");
    updateHyperliquidMarketWSSubscriptions([
      { coin: "#51", tokenId: "hyperliquid:100000051" },
      { coin: "#52", tokenId: "hyperliquid:100000052" },
    ]);

    assert.deepEqual(sentSubscriptions(ws), [
      { method: "subscribe", coin: "#50" },
      { method: "subscribe", coin: "#51" },
      { method: "unsubscribe", coin: "#50" },
      { method: "subscribe", coin: "#52" },
    ]);
  } finally {
    resetHyperliquidMarketWSForTest();
  }
});

test("websocket message routing uses updated target map and writes book snapshots", async () => {
  resetHyperliquidMarketWSForTest();
  const ws = new FakeWebSocket();
  const { pool, redis, poolTokenWrites, redisWrites } = fakePoolAndRedis();
  try {
    startHyperliquidMarketWS({
      wsUrl: "wss://example.invalid",
      pool,
      redis,
      targets: [{ coin: "#50", tokenId: "hyperliquid:100000050" }],
      createWebSocket: () => ws as unknown as WebSocket,
    });
    ws.emit("open");
    updateHyperliquidMarketWSSubscriptions([
      { coin: "#51", tokenId: "hyperliquid:100000051" },
    ]);

    ws.emit(
      "message",
      JSON.stringify({
        channel: "bbo",
        data: {
          coin: "#50",
          time: 5_000,
          bbo: [
            { px: "0.1", sz: "10", n: 1 },
            { px: "0.2", sz: "11", n: 1 },
          ],
        },
      }),
    );
    ws.emit(
      "message",
      JSON.stringify({
        channel: "bbo",
        data: {
          coin: "#51",
          time: 5_001,
          bbo: [
            { px: "0.3", sz: "12", n: 1 },
            { px: "0.4", sz: "13", n: 1 },
          ],
        },
      }),
    );

    await waitForHyperliquidWsPublishesForTest();
    assert.deepEqual(Array.from(new Set(poolTokenWrites)), [
      "hyperliquid:100000051",
    ]);
    assert.equal(
      redisWrites.some(
        (write) =>
          write.type === "set" && write.key === "book:hyperliquid:100000051",
      ),
      true,
    );
    assert.equal(
      redisWrites.some(
        (write) =>
          write.type === "set" && write.key === "top:hyperliquid:100000051",
      ),
      true,
    );
  } finally {
    resetHyperliquidMarketWSForTest();
  }
});

test("replacing a websocket clears old subscriptions and ignores stale messages", async () => {
  resetHyperliquidMarketWSForTest();
  const oldWs = new FakeWebSocket();
  const newWs = new FakeWebSocket();
  const { pool, redis, poolTokenWrites } = fakePoolAndRedis();
  try {
    startHyperliquidMarketWS({
      wsUrl: "wss://example.invalid",
      pool,
      redis,
      targets: [{ coin: "#60", tokenId: "hyperliquid:100000060" }],
      createWebSocket: () => oldWs as unknown as WebSocket,
    });
    oldWs.emit("open");
    startHyperliquidMarketWS({
      wsUrl: "wss://example.invalid",
      pool,
      redis,
      targets: [{ coin: "#61", tokenId: "hyperliquid:100000061" }],
      createWebSocket: () => newWs as unknown as WebSocket,
    });
    newWs.emit("open");

    oldWs.emit(
      "message",
      JSON.stringify({
        channel: "bbo",
        data: {
          coin: "#60",
          time: 6_000,
          bbo: [
            { px: "0.1", sz: "10", n: 1 },
            { px: "0.2", sz: "11", n: 1 },
          ],
        },
      }),
    );
    newWs.emit(
      "message",
      JSON.stringify({
        channel: "bbo",
        data: {
          coin: "#61",
          time: 6_001,
          bbo: [
            { px: "0.3", sz: "12", n: 1 },
            { px: "0.4", sz: "13", n: 1 },
          ],
        },
      }),
    );

    await waitForHyperliquidWsPublishesForTest();
    assert.equal(oldWs.closeCount, 1);
    assert.deepEqual(sentSubscriptions(newWs), [
      { method: "subscribe", coin: "#61" },
    ]);
    assert.deepEqual(Array.from(new Set(poolTokenWrites)), [
      "hyperliquid:100000061",
    ]);
  } finally {
    resetHyperliquidMarketWSForTest();
  }
});

for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}
