import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { after, mock, test } from "node:test";
import {
  setImmediate as yieldLoop,
  setTimeout as delay,
} from "node:timers/promises";
import { createTopTickGate } from "@hunch/infra";

// No network, secrets, database, or Redis connection: exercise the actual
// wsMarket dispatch/gate/queues with slow writes and mixed provider frames.
const frames: Record<string, unknown>[] = [];
class Socket extends EventEmitter {
  static OPEN = 1;
  readyState = 1;
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
mock.module("ws", { defaultExport: Socket });
mock.module("@hunch/infra", {
  namedExports: {
    createTopTickGate: (options: Parameters<typeof createTopTickGate>[0]) =>
      createTopTickGate({ ...options, minIntervalMs: 100, heartbeatMs: 1000 }),
  },
});
mock.module("@hunch/db", {
  namedExports: {
    writeUnifiedBookTop: async (_db: unknown, tokenId: string) => {
      bookWrites.push(tokenId);
    },
    writeUnifiedLastTrade: async (_db: unknown, trade: { price: number }) => {
      trades.push(trade.price);
    },
    writeResolvedTerminalTokenTops: async () => ({
      tokenPrices: [{ tokenId: "a", price: 1 }],
    }),
  },
});
mock.module(new URL("./env.js", import.meta.url).href, {
  namedExports: {
    env: {
      wsUrl: "ws://fixture.invalid",
      wsSubset: 2000,
      wsSubChunkSize: 250,
      wsConcurrency: "8",
      wsCustomFeatureEnabled: true,
      wsResubscribeSec: 60,
    },
  },
});
mock.module(new URL("./redis.js", import.meta.url).href, {
  namedExports: { redis, ensureRedis: async () => {} },
});
mock.module(new URL("./log.js", import.meta.url).href, {
  namedExports: { log: { info() {}, warn() {}, err() {} } },
});
mock.module(new URL("./gammaClient.js", import.meta.url).href, {
  namedExports: {
    fetchEventsByIds: async () => [],
    fetchMarketById: async () => null,
  },
});
mock.module(new URL("./consistentUpserts.js", import.meta.url).href, {
  namedExports: {
    upsertEventsConsistently: async () => {},
    upsertMarketsConsistently: async () => {},
  },
});
mock.module(new URL("./mappers.js", import.meta.url).href, {
  namedExports: {
    mapPolymarketEventRow: () => {},
    mapPolymarketMarketRow: () => {},
    mapToUnifiedEvent: () => {},
    mapToUnifiedMarket: () => {},
  },
});
mock.module(new URL("./db.js", import.meta.url).href, {
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
const { startMarketWS } = await import("./wsMarket.js");
const socket = startMarketWS(
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
  socket.emit("open");
  await until(() => frames.length === 8);
  assert.equal(frames.filter((frame) => frame.type === "market").length, 1);
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
  socket.emit(
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
  assert.equal(bookWrites.filter((tokenId) => tokenId === "a").length, 1);
});
