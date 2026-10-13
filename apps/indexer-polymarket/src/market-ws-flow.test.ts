import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate as yieldLoop } from "node:timers/promises";
import {
  LatestQuoteQueue,
  MarketSubscriptions,
  MarketSubscriptionShards,
  MarketEventDeduper,
  reconnectAttempt,
  mergeMarketQuote,
  type MarketQuote,
} from "./market-ws-flow.js";

test("2,000 tokens retain full coverage with one initial frame and seven dynamic chunks", async () => {
  const frames: Array<{
    type?: string;
    operation?: string;
    assets_ids: string[];
  }> = [];
  const pump = new MarketSubscriptions({
    chunkSize: 250,
    customFeature: true,
    isOpen: () => true,
    send: async (raw) => {
      frames.push(JSON.parse(raw));
    },
    onError: (error) => {
      throw error;
    },
  });
  const ids = Array.from({ length: 2000 }, (_, i) => String(i));
  pump.update(ids);
  await pump.idle();
  assert.equal(frames.length, 8);
  assert.equal(frames[0].type, "market");
  assert.ok(
    frames
      .slice(1)
      .every((frame) => frame.type == null && frame.operation === "subscribe"),
  );
  assert.deepEqual([...pump.subscribed], ids);
  pump.reset();
  await pump.idle();
  assert.equal(frames.filter((frame) => frame.type === "market").length, 1);
  assert.equal(
    frames.filter((frame) => frame.operation === "unsubscribe").length,
    8,
  );
  assert.deepEqual([...pump.subscribed], ids);
});

test("empty drain followed by same-turn update is not lost", async () => {
  const pump = new MarketSubscriptions({
    chunkSize: 2,
    customFeature: true,
    isOpen: () => true,
    send: async () => {},
    onError: (error) => {
      throw error;
    },
  });
  pump.update([]);
  pump.update(["a"]);
  await pump.idle();
  assert.deepEqual([...pump.subscribed], ["a"]);
});

test("desired changes during send reconcile additions and removals, with no coverage loss", async () => {
  let release!: () => void;
  let first = true;
  const pump = new MarketSubscriptions({
    chunkSize: 2,
    customFeature: true,
    isOpen: () => true,
    send: async () => {
      if (first) {
        first = false;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
    },
    onError: (error) => {
      throw error;
    },
  });
  pump.update(["a", "b", "c", "d"]);
  pump.update(["b", "e", "f"]);
  release();
  await pump.idle();
  assert.deepEqual([...pump.subscribed].sort(), ["b", "e", "f"]);
});

test("closed connection does not mark failed subscription as sent; fresh connection covers all", async () => {
  let open = true;
  const failures: unknown[] = [];
  const pump = new MarketSubscriptions({
    chunkSize: 1,
    customFeature: true,
    isOpen: () => open,
    send: async () => {
      open = false;
      throw new Error("closed");
    },
    onError: (error) => {
      failures.push(error);
    },
  });
  pump.update(["a", "b"]);
  await pump.idle();
  assert.equal(pump.subscribed.size, 0);
  assert.equal(failures.length, 1);
});

test("200,000 quote burst coalesces to all 2,000 latest tokens with bounded concurrency", async () => {
  const seen = new Map<string, number>();
  let running = 0;
  let peak = 0;
  const queue = new LatestQuoteQueue<{ tokenId: string; tsMs: number }>(
    8,
    async (value) => {
      peak = Math.max(peak, ++running);
      await yieldLoop();
      seen.set(value.tokenId, value.tsMs);
      running--;
    },
    (error) => {
      throw error;
    },
  );
  for (let update = 0; update < 100; update++)
    for (let token = 0; token < 2000; token++)
      queue.push({ tokenId: String(token), tsMs: update });
  assert.equal(queue.metrics().pending, 2000);
  assert.equal(queue.metrics().coalesced, 198000);
  await queue.idle();
  assert.equal(seen.size, 2000);
  assert.ok([...seen.values()].every((ts) => ts === 99));
  assert.equal(peak, 8);
});

test("in-flight token serializes newer/terminal ticks and rejects older pending values", async () => {
  let release!: () => void;
  const seen: number[] = [];
  const queue = new LatestQuoteQueue<{ tokenId: string; tsMs: number }>(
    8,
    async (tick) => {
      if (tick.tsMs === 1)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      seen.push(tick.tsMs);
    },
    (error) => {
      throw error;
    },
  );
  queue.push({ tokenId: "a", tsMs: 1 });
  await yieldLoop();
  queue.push({ tokenId: "a", tsMs: 2 });
  queue.push({ tokenId: "a", tsMs: 3 });
  queue.push({ tokenId: "a", tsMs: 2 });
  release();
  await queue.idle();
  assert.deepEqual(seen, [1, 3]);
});

test("write failure releases queue and never strands the newest value", async () => {
  const errors: unknown[] = [];
  const seen: string[] = [];
  const queue = new LatestQuoteQueue<{ tokenId: string; tsMs: number }>(
    1,
    async (tick) => {
      if (tick.tokenId === "a") throw new Error("fixture");
      seen.push(tick.tokenId);
    },
    (error) => {
      errors.push(error);
    },
  );
  queue.push({ tokenId: "a", tsMs: 1 });
  queue.push({ tokenId: "b", tsMs: 2 });
  await queue.idle();
  assert.equal(errors.length, 1);
  assert.deepEqual(seen, ["b"]);
});

test("top-only coalescing retains the book snapshot; terminal ticks discard obsolete books", async () => {
  const writes: MarketQuote[] = [];
  const queue = new LatestQuoteQueue<MarketQuote>(
    1,
    async (tick) => {
      writes.push(tick);
    },
    (error) => {
      throw error;
    },
    mergeMarketQuote,
  );
  const book = { timestamp: "1", bids: [{ price: "0.3" }] };
  const base = { tokenId: "a", bestBid: 0.3, bestAsk: 0.4, tsMs: 1 };
  queue.push({ ...base, bookPayload: book });
  queue.push({ ...base, tsMs: 2, bestBid: 0.35 });
  await queue.idle();
  assert.equal(writes[0].bookPayload, book);
  assert.equal(writes[0].bestBid, 0.35);
  queue.push({ ...base, tsMs: 3, bookPayload: book });
  queue.push({
    ...base,
    tsMs: 4,
    bestBid: 1,
    bestAsk: 1,
    alreadyPersisted: true,
  });
  await queue.idle();
  assert.equal(writes[1].bookPayload, undefined);
  assert.equal(writes[1].alreadyPersisted, true);
});

test("healthy reconnect resets penalty; repeatedly failing sockets retain bounded backoff", () => {
  assert.equal(reconnectAttempt(5, 60000), 0);
  assert.equal(reconnectAttempt(5, 11000), 5);
  assert.equal(reconnectAttempt(0, 0), 1);
});

test("shards cover exactly 2,000 tokens, retain owners on reorder and fill vacancies", () => {
  const partition = new MarketSubscriptionShards(500);
  const ids = Array.from({ length: 2000 }, (_, i) => String(i));
  const original = partition.update(ids);
  assert.equal(original.size, 4);
  assert.deepEqual(
    [...original.values()],
    [
      ids.slice(0, 500),
      ids.slice(500, 1000),
      ids.slice(1000, 1500),
      ids.slice(1500),
    ],
  );
  assert.deepEqual(partition.update([...ids].reverse()), original);
  const next = partition.update([
    ...ids.slice(20),
    ...Array.from({ length: 20 }, (_, i) => `new-${i}`),
    "new-0",
  ]);
  assert.equal(next.size, 4);
  assert.ok([...next.values()].every((group) => group.length === 500));
  const union = [...next.values()].flat();
  assert.equal(new Set(union).size, 2000);
  for (const [owner, tokens] of next)
    for (const token of tokens) {
      if (!token.startsWith("new-"))
        assert.ok(original.get(owner)?.includes(token));
    }
  assert.equal(partition.update([]).size, 0);
  assert.equal([...partition.update(ids).values()].flat().length, 2000);
});

test("market-wide duplicate work shares in-flight completion; trades need not use deduper", async () => {
  const dedupe = new MarketEventDeduper();
  let writes = 0;
  let release!: () => void;
  const work = async () => {
    writes++;
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  };
  const tasks = Array.from({ length: 4 }, () =>
    dedupe.run("resolved-exact-payload", work),
  );
  await yieldLoop();
  assert.equal(writes, 1);
  release();
  await Promise.all(tasks);
  await dedupe.run("resolved-exact-payload", work);
  assert.equal(writes, 1);
});

test("lifecycle failures are not cached and bounded completion cache can expire/evict", async () => {
  const dedupe = new MarketEventDeduper(60_000, 1);
  await assert.rejects(
    dedupe.run("a", async () => {
      throw new Error("fixture");
    }),
  );
  let writes = 0;
  const work = async () => {
    writes++;
  };
  await dedupe.run("a", work);
  await dedupe.run("b", work);
  await dedupe.run("a", work);
  assert.equal(writes, 3);
  const expired = new MarketEventDeduper(0);
  await expired.run("a", work);
  await expired.run("a", work);
  assert.equal(writes, 5);
});
