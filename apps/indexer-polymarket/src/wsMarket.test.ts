import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { after, mock, test } from "node:test";
import {
  setImmediate as yieldLoop,
  setTimeout as delay,
} from "node:timers/promises";

// Bun implements its own module mocks, not node:test's mock.module API.
const bunMock = process.versions.bun
  ? createRequire(import.meta.url)("bun:test").mock
  : null;
function mockModule(
  specifier: string,
  options: { defaultExport?: unknown; namedExports?: Record<string, unknown> },
) {
  if (bunMock) {
    bunMock.module(specifier, () => ({
      ...options.namedExports,
      ...(options.defaultExport === undefined
        ? {}
        : { default: options.defaultExport }),
    }));
  } else mock.module(specifier, options);
}

// No network, secrets, database, or Redis connection: exercise the actual
// wsMarket dispatch/gate/queues with slow writes and mixed provider frames.
const frames: Record<string, unknown>[] = [];
const sockets: Socket[] = [];
class Socket extends EventEmitter {
  static OPEN = 1;
  readyState = 1;
  constructor() {
    super();
    sockets.push(this);
  }
  addEventListener(type: string, listener: (event: { data: unknown }) => void) {
    this.on(type, (data) => listener({ data }));
  }
  send(text: string, done?: (error?: Error) => void) {
    if (text !== "PING") frames.push(JSON.parse(text));
    done?.();
  }
  terminate() {
    this.readyState = 3;
    this.emit("close", 1000, Buffer.from("fixture"));
  }
}
const tops = new Map<string, { best_bid: number; ts: number }>();
const books = new Map<string, unknown>();
const trades: number[] = [];
const bookWrites: string[] = [];
const accepting: boolean[] = [];
let resolvedWrites = 0;
let redisClosed = false;
let unblockRedis: (() => void) | undefined;
let blocked = false;
const redis = {
  on() {},
  async quit() {
    redisClosed = true;
  },
  disconnect() {},
  multi() {
    const commands: Array<[string, string]> = [];
    const multi = {
      set(key: string, value: string) {
        commands.push([key, value]);
        return multi;
      },
      publish() {
        return multi;
      },
      async exec() {
        if (blocked && commands.some(([key]) => key === "top:a")) {
          blocked = false;
          await new Promise<void>((resolve) => {
            unblockRedis = resolve;
          });
        }
        assert.equal(
          redisClosed,
          false,
          "shutdown must drain lifecycle and quote writes first",
        );
        for (const [key, value] of commands) {
          if (key.startsWith("top:")) tops.set(key.slice(4), JSON.parse(value));
          if (key.startsWith("book:"))
            books.set(key.slice(5), JSON.parse(value));
        }
      },
    };
    return multi;
  },
};
mockModule("ws", { defaultExport: Socket });
mockModule("@hunch/db", {
  namedExports: {
    writeUnifiedBookTop: async (_db: unknown, tokenId: string) => {
      bookWrites.push(tokenId);
    },
    writeUnifiedLastTrade: async (_db: unknown, trade: { price: number }) => {
      trades.push(trade.price);
    },
    writeResolvedTerminalTokenTops: async () => {
      resolvedWrites++;
      return { tokenPrices: [{ tokenId: "a", price: 1 }] };
    },
  },
});
mockModule(new URL("./env.js", import.meta.url).href, {
  namedExports: {
    env: {
      wsUrl: "ws://fixture.invalid",
      wsSubset: 2000,
      wsSubChunkSize: 250,
      wsTokensPerSocket: 500,
      wsConcurrency: "8",
      wsCustomFeatureEnabled: true,
      wsResubscribeSec: 60,
    },
  },
});
mockModule(new URL("./redis.js", import.meta.url).href, {
  namedExports: { redis, ensureRedis: async () => {} },
});
mockModule(new URL("./log.js", import.meta.url).href, {
  namedExports: { log: { info() {}, warn() {}, err() {} } },
});
mockModule(new URL("./gammaClient.js", import.meta.url).href, {
  namedExports: {
    fetchEventsByIds: async () => [],
    fetchMarketById: async () => null,
  },
});
mockModule(new URL("./consistentUpserts.js", import.meta.url).href, {
  namedExports: {
    upsertEventsConsistently: async () => {},
    upsertMarketsConsistently: async () => {},
  },
});
mockModule(new URL("./mappers.js", import.meta.url).href, {
  namedExports: {
    mapPolymarketEventRow: () => {},
    mapPolymarketMarketRow: () => {},
    mapToUnifiedEvent: () => {},
    mapToUnifiedMarket: () => {},
  },
});
mockModule(new URL("./db.js", import.meta.url).href, {
  namedExports: {
    pool: {
      async query(sql: string, args: unknown[]) {
        if (sql.includes("select"))
          return {
            rows: [
              {
                market_id: "market:a",
                venue_market_id: "1",
                token_yes: "a",
                token_no: "b",
              },
            ],
          };
        if (sql.includes("accepting_orders = $2")) {
          if (args[1] === true) await yieldLoop();
          accepting.push(args[1] as boolean);
        }
        return { rows: [] };
      },
    },
  },
});
const { startMarketWS, updateMarketWSSubscriptions } =
  await import("./wsMarket.js");
let socket = startMarketWS(
  Array.from({ length: 2000 }, (_, i) => String(i)),
) as unknown as Socket;
after(() => {
  if (!redisClosed) process.emit("SIGTERM");
});
async function until(condition: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, "fixture did not drain");
    await yieldLoop();
  }
}

test("actual WS routing preserves trades and intra-frame lifecycle ordering alongside coalesced quotes", async () => {
  assert.equal(sockets.length, 4);
  for (const initialSocket of sockets) initialSocket.emit("open");
  await until(() => frames.length === 8);
  assert.equal(frames.filter((frame) => frame.type === "market").length, 4);
  assert.equal(new Set(frames.flatMap((frame) => frame.assets_ids)).size, 2000);
  const ts = Date.now() - 1000;
  socket.emit(
    "message",
    Buffer.from(
      JSON.stringify([
        {
          event_type: "book",
          asset_id: "c",
          timestamp: ts,
          bids: [{ price: "0.2" }],
          asks: [{ price: "0.4" }],
        },
        {
          event_type: "best_bid_ask",
          asset_id: "c",
          timestamp: ts + 1,
          best_bid: "0.3",
          best_ask: "0.4",
        },
        {
          event_type: "last_trade_price",
          asset_id: "c",
          timestamp: ts,
          price: "0.21",
        },
        {
          event_type: "last_trade_price",
          asset_id: "c",
          timestamp: ts + 1,
          price: "0.22",
        },
        {
          event_type: "state",
          asset_id: "c",
          timestamp: ts,
          accepting_orders: true,
        },
        {
          event_type: "state",
          asset_id: "c",
          timestamp: ts + 1,
          accepting_orders: false,
        },
      ]),
    ),
  );
  await until(
    () =>
      trades.length === 2 &&
      accepting.length === 2 &&
      tops.get("c")?.best_bid === 0.3,
  );
  assert.deepEqual(trades, [0.21, 0.22]);
  assert.deepEqual(accepting, [true, false]);
  assert.equal(tops.get("c")?.best_bid, 0.3);
  assert.ok(books.has("c"));
});

test("hot ingress retains the latest quote for all 2,000 subscriptions", async (t) => {
  const started = performance.now();
  const ts = Date.now() - 1000;
  for (let revision = 0; revision < 40; revision++) {
    for (let token = 0; token < 2000; token++) {
      socket.emit(
        "message",
        JSON.stringify({
          event_type: "price_change",
          timestamp: ts + revision,
          price_changes: [
            { asset_id: `burst-${token}`, best_bid: "0.1", best_ask: "0.9" },
            {
              asset_id: `burst-${token}`,
              best_bid: String((20 + revision) / 100),
              best_ask: "0.9",
            },
          ],
        }),
      );
    }
  }
  await yieldLoop();
  t.diagnostic(
    `80,000-frame ingress/drain-yield: ${(performance.now() - started).toFixed(1)}ms`,
  );
  await until(() =>
    Array.from(
      { length: 2000 },
      (_, token) => tops.get(`burst-${token}`)?.best_bid === 0.59,
    ).every(Boolean),
  );
});

test("trade copies are not heuristically coalesced across sockets", async () => {
  const before = trades.length;
  const raw = JSON.stringify({
    event_type: "last_trade_price",
    asset_id: "c",
    timestamp: Date.now(),
    price: "0.23",
    size: "1",
  });
  for (const active of sockets) active.emit("message", raw);
  await until(() => trades.length === before + 4);
  assert.deepEqual(trades.slice(before), [0.23, 0.23, 0.23, 0.23]);
});

test("1013 reconnect replaces only the failed shard, preserving 2,000 tokens and other sockets", async () => {
  const oldSocket = socket;
  oldSocket.readyState = 3;
  oldSocket.emit("close", 1013, Buffer.from("slow consumer: send buffer full"));
  const next = Array.from({ length: 2000 }, (_, i) =>
    i === 0 ? "new-token" : String(i),
  );
  updateMarketWSSubscriptions(next);
  assert.equal(sockets.length, 4);
  for (const healthy of sockets.slice(1, 4))
    assert.equal(healthy.readyState, 1);
  sockets[1].emit(
    "message",
    JSON.stringify({
      event_type: "best_bid_ask",
      asset_id: "healthy-shard",
      timestamp: Date.now(),
      best_bid: "0.2",
      best_ask: "0.3",
    }),
  );
  await until(() => tops.has("healthy-shard"));
  await until(() => sockets.length === 5);
  socket = sockets[4];
  const frameOffset = frames.length;
  socket.emit("open");
  await until(() => frames.length - frameOffset === 2);
  assert.deepEqual(
    frames.slice(frameOffset).flatMap((frame) => frame.assets_ids),
    [...Array.from({ length: 499 }, (_, i) => String(i + 1)), "new-token"],
  );
  oldSocket.emit(
    "message",
    JSON.stringify({
      event_type: "best_bid_ask",
      asset_id: "obsolete-socket",
      timestamp: Date.now(),
      best_bid: "0.2",
      best_ask: "0.3",
    }),
  );
  await yieldLoop();
  assert.equal(tops.has("obsolete-socket"), false);
});

test("empty desired set cancels pending reconnects and can start full coverage again", async () => {
  socket.readyState = 3;
  socket.emit("close", 1013, Buffer.from("fixture"));
  updateMarketWSSubscriptions([]);
  const count = sockets.length;
  await delay(2600);
  assert.equal(sockets.length, count);
  updateMarketWSSubscriptions(
    Array.from({ length: 2000 }, (_, i) => String(i)),
  );
  assert.equal(sockets.length, count + 4);
  socket = sockets[count];
  const offset = frames.length;
  for (const fresh of sockets.slice(count)) fresh.emit("open");
  await until(() => frames.length - offset === 8);
  assert.equal(
    new Set(frames.slice(offset).flatMap((frame) => frame.assets_ids)).size,
    2000,
  );
});

test("resolved terminal top wins over in-flight and pending quotes, including shutdown drain", async () => {
  blocked = true;
  const ts = Date.now() - 1000;
  const quote = (price: string, timestamp: number) =>
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          event_type: "best_bid_ask",
          asset_id: "a",
          timestamp,
          best_bid: price,
          best_ask: "0.9",
        }),
      ),
    );
  quote("0.4", ts);
  await until(() => !!unblockRedis);
  quote("0.5", ts + 1);
  for (const active of sockets.slice(-4))
    active.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          event_type: "market_resolved",
          assets_ids: ["a", "b"],
          winning_asset_id: "a",
          winning_outcome: "Yes",
          timestamp: ts + 2,
        }),
      ),
    );
  await until(() => accepting.length > 2);
  // Exercise the real throttle window: terminal publication must cancel the
  // pending ordinary tick, without scheduling another terminal DB write.
  await delay(150);
  process.emit("SIGTERM");
  assert.ok(unblockRedis);
  unblockRedis();
  await until(() => redisClosed);
  assert.equal(tops.get("a")?.best_bid, 1);
  assert.equal(
    resolvedWrites,
    2,
    "one market-wide resolution handles its two token refs only once across sockets",
  );
  assert.equal(bookWrites.filter((tokenId) => tokenId === "a").length, 1);
});
