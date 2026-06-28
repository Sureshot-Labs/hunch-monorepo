import assert from "node:assert/strict";

import {
  claimDueSortedSetQueueItems,
  claimDuePriceRefreshTokens,
  enqueueSortedSetQueueItems,
  enqueuePriceRefreshTokens,
  filterStalePriceRefreshTokens,
  getPriceRefreshQueueBacklog,
  getSortedSetQueueBacklog,
  inferPriceRefreshVenue,
  requeueSortedSetQueueItems,
  requeuePriceRefreshTokens,
  requestFreshMarketPrices,
  type PriceRefreshRedis,
} from "@hunch/infra";

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

class FakeRedis implements PriceRefreshRedis {
  private readonly sets = new Map<string, Map<string, number>>();

  private getSet(key: string): Map<string, number> {
    const existing = this.sets.get(key);
    if (existing) return existing;
    const created = new Map<string, number>();
    this.sets.set(key, created);
    return created;
  }

  async zAdd(
    key: string,
    members: Array<{ score: number; value: string }>,
  ): Promise<number> {
    const set = this.getSet(key);
    let added = 0;
    for (const member of members) {
      if (!set.has(member.value)) added += 1;
      set.set(member.value, member.score);
    }
    return added;
  }

  async zCard(key: string): Promise<number> {
    return this.getSet(key).size;
  }

  async zRangeByScore(
    key: string,
    min: number,
    max: number,
    options?: { LIMIT?: { offset: number; count: number } },
  ): Promise<string[]> {
    const offset = options?.LIMIT?.offset ?? 0;
    const count = options?.LIMIT?.count ?? Number.POSITIVE_INFINITY;
    return Array.from(this.getSet(key).entries())
      .filter(([, score]) => score >= min && score <= max)
      .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
      .slice(offset, offset + count)
      .map(([tokenId]) => tokenId);
  }

  async zRem(key: string, members: string[]): Promise<number> {
    const set = this.getSet(key);
    let removed = 0;
    for (const member of members) {
      if (set.delete(member)) removed += 1;
    }
    return removed;
  }

  async zRemRangeByRank(
    key: string,
    start: number,
    stop: number,
  ): Promise<number> {
    const set = this.getSet(key);
    const entries = Array.from(set.entries()).sort(
      (a, b) => a[1] - b[1] || a[0].localeCompare(b[0]),
    );
    const normalizedStop = stop < 0 ? entries.length + stop : stop;
    const slice = entries.slice(start, normalizedStop + 1);
    for (const [tokenId] of slice) set.delete(tokenId);
    return slice.length;
  }

  async eval(
    _script: string,
    options: { keys: string[]; arguments: string[] },
  ): Promise<unknown> {
    const key = options.keys[0];
    if (_script.includes("ZSCORE")) {
      const score = Number(options.arguments[0]);
      const set = this.getSet(key);
      let added = 0;
      for (const token of options.arguments.slice(1)) {
        const existing = set.get(token);
        if (existing == null) {
          added += 1;
          set.set(token, score);
        } else if (score < existing) {
          set.set(token, score);
        }
      }
      return added;
    }
    const maxScore = Number(options.arguments[0]);
    const limit = Number(options.arguments[1]);
    const side = options.arguments[2] === "newest" ? "newest" : "oldest";
    const set = this.getSet(key);
    const tokens = Array.from(set.entries())
      .filter(([, score]) => score <= maxScore)
      .sort((a, b) =>
        side === "newest"
          ? b[1] - a[1] || b[0].localeCompare(a[0])
          : a[1] - b[1] || a[0].localeCompare(b[0]),
      )
      .slice(0, limit)
      .map(([tokenId]) => tokenId);
    for (const token of tokens) set.delete(token);
    return tokens;
  }
}

class SingleClientFreshPriceDb {
  readonly queryOrder: string[] = [];
  tokenTopRows: Array<Record<string, unknown>> = [
    {
      best_ask: "0.41",
      best_bid: "0.4",
      token_id: "yes-token",
      ts: "2026-01-01T00:00:01.000Z",
    },
    {
      best_ask: "0.6",
      best_bid: "0.59",
      token_id: "no-token",
      ts: "2026-01-01T00:00:01.000Z",
    },
  ];
  private inFlight = 0;

  async query<T = Record<string, unknown>>(
    sql: string,
  ): Promise<{ rows: T[] }> {
    if (this.inFlight > 0) {
      throw new Error("concurrent single-client query");
    }
    this.inFlight += 1;
    await Promise.resolve();
    try {
      if (sql.includes("from unified_market_tokens")) {
        this.queryOrder.push("market_tokens");
        return { rows: [] };
      }
      if (sql.includes("from unified_token_top_latest")) {
        this.queryOrder.push("token_tops");
        return {
          rows: this.tokenTopRows as T[],
        };
      }
      if (sql.includes("from unified_markets")) {
        this.queryOrder.push("markets");
        return {
          rows: [
            {
              best_ask: null,
              best_bid: null,
              clob_token_ids: JSON.stringify(["yes-token", "no-token"]),
              id: "polymarket:test",
              last_price: null,
              token_no: null,
              token_yes: null,
              venue: "polymarket",
            },
          ] as T[],
        };
      }
      this.queryOrder.push("unknown");
      return { rows: [] };
    } finally {
      this.inFlight -= 1;
    }
  }
}

await test("inferPriceRefreshVenue recognizes active venue token shapes", () => {
  assert.equal(inferPriceRefreshVenue("12345"), "polymarket");
  assert.equal(inferPriceRefreshVenue("sol:mint"), "dflow");
  assert.equal(inferPriceRefreshVenue("limitless:abc"), "limitless");
  assert.equal(inferPriceRefreshVenue("kalshi:legacy"), null);
});

await test("enqueuePriceRefreshTokens dedupes and groups by inferred venue", async () => {
  const redis = new FakeRedis();
  const result = await enqueuePriceRefreshTokens(redis, {
    tokenIds: ["1", "1", "sol:a", "limitless:b", "", "kalshi:old"],
    nowMs: 1000,
  });

  assert.equal(result.enqueued, 3);
  assert.equal(result.ignored, 2);
  assert.deepEqual(result.byVenue, {
    polymarket: 1,
    dflow: 1,
    limitless: 1,
  });
  assert.equal(await getPriceRefreshQueueBacklog(redis, "polymarket"), 1);
  assert.equal(await getPriceRefreshQueueBacklog(redis, "dflow"), 1);
  assert.equal(await getPriceRefreshQueueBacklog(redis, "limitless"), 1);
});

await test("claimDuePriceRefreshTokens returns due tokens and removes them", async () => {
  const redis = new FakeRedis();
  await enqueuePriceRefreshTokens(redis, {
    tokenIds: ["1", "2", "3"],
    venue: "polymarket",
    nowMs: 1000,
  });

  const claimed = await claimDuePriceRefreshTokens(redis, {
    venue: "polymarket",
    nowMs: 1000,
    limit: 2,
  });

  assert.deepEqual(claimed, ["1", "2"]);
  assert.equal(await getPriceRefreshQueueBacklog(redis, "polymarket"), 1);
});

await test("claimDuePriceRefreshTokens oldest returns earliest due tokens", async () => {
  const redis = new FakeRedis();
  await enqueuePriceRefreshTokens(redis, {
    tokenIds: ["3"],
    venue: "polymarket",
    nowMs: 3000,
  });
  await enqueuePriceRefreshTokens(redis, {
    tokenIds: ["1"],
    venue: "polymarket",
    nowMs: 1000,
  });
  await enqueuePriceRefreshTokens(redis, {
    tokenIds: ["2"],
    venue: "polymarket",
    nowMs: 2000,
  });

  const claimed = await claimDuePriceRefreshTokens(redis, {
    venue: "polymarket",
    nowMs: 3000,
    limit: 2,
    side: "oldest",
  });

  assert.deepEqual(claimed, ["1", "2"]);
});

await test("claimDuePriceRefreshTokens newest returns latest due tokens", async () => {
  const redis = new FakeRedis();
  await enqueuePriceRefreshTokens(redis, {
    tokenIds: ["1"],
    venue: "polymarket",
    nowMs: 1000,
  });
  await enqueuePriceRefreshTokens(redis, {
    tokenIds: ["2"],
    venue: "polymarket",
    nowMs: 2000,
  });
  await enqueuePriceRefreshTokens(redis, {
    tokenIds: ["3"],
    venue: "polymarket",
    nowMs: 3000,
  });

  const claimed = await claimDuePriceRefreshTokens(redis, {
    venue: "polymarket",
    nowMs: 3000,
    limit: 2,
    side: "newest",
  });

  assert.deepEqual(claimed, ["3", "2"]);
});

await test("generic sorted-set queues support non-token queue items", async () => {
  const redis = new FakeRedis();
  const key = "price-refresh:http-fallback:limitless";
  const enqueued = await enqueueSortedSetQueueItems(redis, {
    key,
    items: ["limitless:1", "limitless:1", "", "limitless:2"],
    nowMs: 1000,
  });

  assert.deepEqual(enqueued, { enqueued: 2, ignored: 1 });
  assert.equal(await getSortedSetQueueBacklog(redis, key), 2);
  assert.deepEqual(
    await claimDueSortedSetQueueItems(redis, {
      key,
      limit: 10,
      nowMs: 1000,
    }),
    ["limitless:1", "limitless:2"],
  );
});

await test("generic sorted-set requeue delays failed queue items", async () => {
  const redis = new FakeRedis();
  const key = "price-refresh:http-fallback:limitless";
  await requeueSortedSetQueueItems(redis, {
    key,
    items: ["limitless:slow"],
    nowMs: 1000,
    delayMs: 60_000,
  });

  assert.deepEqual(
    await claimDueSortedSetQueueItems(redis, {
      key,
      nowMs: 1000,
      limit: 10,
    }),
    [],
  );
  assert.deepEqual(
    await claimDueSortedSetQueueItems(redis, {
      key,
      nowMs: 61_000,
      limit: 10,
    }),
    ["limitless:slow"],
  );
});

await test("high priority price refresh jumps ahead of normal queued tokens", async () => {
  const redis = new FakeRedis();
  await enqueuePriceRefreshTokens(redis, {
    tokenIds: ["normal-old"],
    venue: "polymarket",
    nowMs: 1_000,
  });
  await enqueuePriceRefreshTokens(redis, {
    tokenIds: ["normal-new"],
    venue: "polymarket",
    nowMs: 2_000,
  });
  await enqueuePriceRefreshTokens(redis, {
    tokenIds: ["system-now"],
    venue: "polymarket",
    nowMs: 3_000,
    priority: "high",
  });

  const claimed = await claimDuePriceRefreshTokens(redis, {
    venue: "polymarket",
    nowMs: 3_000,
    limit: 3,
    side: "oldest",
  });

  assert.deepEqual(claimed, ["system-now", "normal-old", "normal-new"]);
});

await test("queue trim preserves urgent high-priority tokens", async () => {
  const redis = new FakeRedis();
  await enqueuePriceRefreshTokens(redis, {
    maxQueueSize: 2,
    nowMs: 1_000,
    tokenIds: ["normal-old"],
    venue: "polymarket",
  });
  await enqueuePriceRefreshTokens(redis, {
    maxQueueSize: 2,
    nowMs: 2_000,
    tokenIds: ["normal-new"],
    venue: "polymarket",
  });
  await enqueuePriceRefreshTokens(redis, {
    maxQueueSize: 2,
    nowMs: 3_000,
    priority: "high",
    tokenIds: ["system-now"],
    venue: "polymarket",
  });

  const claimed = await claimDuePriceRefreshTokens(redis, {
    limit: 10,
    nowMs: 3_000,
    side: "oldest",
    venue: "polymarket",
  });

  assert.deepEqual(claimed, ["system-now", "normal-old"]);
});

await test("normal re-enqueue does not demote an existing high-priority token", async () => {
  const redis = new FakeRedis();
  await enqueuePriceRefreshTokens(redis, {
    tokenIds: ["system-now"],
    venue: "polymarket",
    nowMs: 3_000,
    priority: "high",
  });
  await enqueuePriceRefreshTokens(redis, {
    tokenIds: ["normal-old"],
    venue: "polymarket",
    nowMs: 1_000,
  });
  const result = await enqueuePriceRefreshTokens(redis, {
    tokenIds: ["system-now"],
    venue: "polymarket",
    nowMs: 4_000,
  });
  assert.equal(result.enqueued, 0);
  assert.equal(result.byVenue.polymarket, 0);

  const claimed = await claimDuePriceRefreshTokens(redis, {
    venue: "polymarket",
    nowMs: 4_000,
    limit: 2,
    side: "oldest",
  });

  assert.deepEqual(claimed, ["system-now", "normal-old"]);
});

await test("filterStalePriceRefreshTokens preserves order and requires recent priced tops", async () => {
  const now = new Date("2026-01-01T00:01:00.000Z");
  const db = {
    async query<T = Record<string, unknown>>() {
      return {
        rows: [
          {
            best_ask: null,
            best_bid: "0.4",
            token_id: "fresh-bid",
            ts: "2026-01-01T00:00:30.000Z",
          },
          {
            best_ask: "0.6",
            best_bid: null,
            token_id: "fresh-ask",
            ts: "2026-01-01T00:00:59.000Z",
          },
          {
            best_ask: "0.6",
            best_bid: "0.4",
            token_id: "old",
            ts: "2026-01-01T00:00:00.000Z",
          },
          {
            best_ask: null,
            best_bid: null,
            token_id: "unpriced",
            ts: "2026-01-01T00:00:59.000Z",
          },
        ] as T[],
      };
    },
  };

  const result = await filterStalePriceRefreshTokens(
    db,
    ["fresh-bid", "old", "missing", "unpriced", "fresh-ask", "fresh-bid"],
    { maxAgeMs: 45_000, now },
  );

  assert.deepEqual(result.freshTokenIds, ["fresh-bid", "fresh-ask"]);
  assert.deepEqual(result.staleTokenIds, ["old", "missing", "unpriced"]);
});

await test("requestFreshMarketPrices is safe for single-client DB callers", async () => {
  const db = new SingleClientFreshPriceDb();
  const result = await requestFreshMarketPrices({
    db,
    enqueue: false,
    marketIds: ["polymarket:test"],
    maxTokens: 2,
    minFreshAt: new Date("2026-01-01T00:00:00.000Z"),
    timeoutMs: 0,
  });

  assert.deepEqual(db.queryOrder, ["markets", "market_tokens", "token_tops"]);
  assert.deepEqual(result.requestedTokenIds, ["yes-token", "no-token"]);
  assert.equal(result.timedOut, false);
  assert.equal(result.marketStates.get("polymarket:test")?.fresh, true);
});

await test("requestFreshMarketPrices does not enqueue already-fresh tokens", async () => {
  const db = new SingleClientFreshPriceDb();
  const redis = new FakeRedis();
  const result = await requestFreshMarketPrices({
    db,
    marketIds: ["polymarket:test"],
    maxTokens: 2,
    minFreshAt: new Date("2026-01-01T00:00:00.000Z"),
    priority: "high",
    redis,
    timeoutMs: 0,
  });

  assert.equal(result.enqueued, 0);
  assert.deepEqual(result.freshTokenIds, ["yes-token", "no-token"]);
  assert.equal(await getPriceRefreshQueueBacklog(redis, "polymarket"), 0);
});

await test("requestFreshMarketPrices enqueues only stale tokens", async () => {
  const db = new SingleClientFreshPriceDb();
  db.tokenTopRows = [
    {
      best_ask: "0.41",
      best_bid: "0.4",
      token_id: "yes-token",
      ts: "2026-01-01T00:00:01.000Z",
    },
  ];
  const redis = new FakeRedis();
  const result = await requestFreshMarketPrices({
    db,
    marketIds: ["polymarket:test"],
    maxTokens: 2,
    minFreshAt: new Date("2026-01-01T00:00:00.000Z"),
    priority: "high",
    redis,
    timeoutMs: 0,
  });

  assert.equal(result.enqueued, 1);
  assert.deepEqual(result.freshTokenIds, ["yes-token"]);
  assert.equal(result.timedOut, true);
  assert.deepEqual(
    await claimDuePriceRefreshTokens(redis, {
      limit: 10,
      nowMs: Date.now(),
      venue: "polymarket",
    }),
    ["no-token"],
  );
});

await test("requestFreshMarketPrices sends only stale tokens to venue adapters", async () => {
  const db = new SingleClientFreshPriceDb();
  db.tokenTopRows = [
    {
      best_ask: "0.41",
      best_bid: "0.4",
      token_id: "yes-token",
      ts: "2026-01-01T00:00:01.000Z",
    },
  ];
  const adapterCalls: Array<{ marketIds: string[]; tokenIds: string[] }> = [];
  await requestFreshMarketPrices({
    db,
    enqueue: false,
    marketIds: ["polymarket:test"],
    maxTokens: 2,
    minFreshAt: new Date("2026-01-01T00:00:00.000Z"),
    timeoutMs: 0,
    venueAdapters: {
      polymarket: async ({ marketIds, tokenIds }) => {
        adapterCalls.push({ marketIds, tokenIds });
      },
    },
  });

  assert.deepEqual(adapterCalls, [
    { marketIds: ["polymarket:test"], tokenIds: ["no-token"] },
  ]);
});

await test("requestFreshMarketPrices does not treat unpriced tops as fresh", async () => {
  const db = {
    async query<T = Record<string, unknown>>(sql: string) {
      if (sql.includes("from unified_market_tokens")) {
        return { rows: [] as T[] };
      }
      if (sql.includes("from unified_token_top_latest")) {
        return {
          rows: [
            {
              best_ask: null,
              best_bid: null,
              token_id: "yes-token",
              ts: "2026-01-01T00:00:01.000Z",
            },
            {
              best_ask: null,
              best_bid: null,
              token_id: "no-token",
              ts: "2026-01-01T00:00:01.000Z",
            },
          ] as T[],
        };
      }
      return {
        rows: [
          {
            best_ask: null,
            best_bid: null,
            clob_token_ids: JSON.stringify(["yes-token", "no-token"]),
            id: "polymarket:test",
            last_price: null,
            token_no: null,
            token_yes: null,
            venue: "polymarket",
          },
        ] as T[],
      };
    },
  };

  const result = await requestFreshMarketPrices({
    db,
    enqueue: false,
    marketIds: ["polymarket:test"],
    maxTokens: 2,
    minFreshAt: new Date("2026-01-01T00:00:00.000Z"),
    timeoutMs: 0,
  });

  assert.deepEqual(result.freshTokenIds, []);
  assert.equal(result.timedOut, true);
  assert.equal(result.marketStates.get("polymarket:test")?.fresh, false);
});

await test("parallel claimDuePriceRefreshTokens calls do not duplicate tokens", async () => {
  const redis = new FakeRedis();
  await enqueuePriceRefreshTokens(redis, {
    tokenIds: ["1", "2", "3"],
    venue: "polymarket",
    nowMs: 1000,
  });

  const [first, second] = await Promise.all([
    claimDuePriceRefreshTokens(redis, {
      venue: "polymarket",
      nowMs: 1000,
      limit: 2,
    }),
    claimDuePriceRefreshTokens(redis, {
      venue: "polymarket",
      nowMs: 1000,
      limit: 2,
    }),
  ]);

  const claimed = [...first, ...second];
  assert.equal(claimed.length, 3);
  assert.equal(new Set(claimed).size, 3);
  assert.equal(await getPriceRefreshQueueBacklog(redis, "polymarket"), 0);
});

await test("parallel oldest/newest claims drain both sides without duplicates", async () => {
  const redis = new FakeRedis();
  await enqueuePriceRefreshTokens(redis, {
    tokenIds: ["1"],
    venue: "polymarket",
    nowMs: 1000,
  });
  await enqueuePriceRefreshTokens(redis, {
    tokenIds: ["2"],
    venue: "polymarket",
    nowMs: 2000,
  });
  await enqueuePriceRefreshTokens(redis, {
    tokenIds: ["3"],
    venue: "polymarket",
    nowMs: 3000,
  });
  await enqueuePriceRefreshTokens(redis, {
    tokenIds: ["4"],
    venue: "polymarket",
    nowMs: 4000,
  });

  const [oldest, newest] = await Promise.all([
    claimDuePriceRefreshTokens(redis, {
      venue: "polymarket",
      nowMs: 4000,
      limit: 2,
      side: "oldest",
    }),
    claimDuePriceRefreshTokens(redis, {
      venue: "polymarket",
      nowMs: 4000,
      limit: 2,
      side: "newest",
    }),
  ]);

  const claimed = [...oldest, ...newest];
  assert.equal(claimed.length, 4);
  assert.equal(new Set(claimed).size, 4);
  assert.equal(await getPriceRefreshQueueBacklog(redis, "polymarket"), 0);
  assert.ok(oldest.includes("1"));
  assert.ok(newest.includes("4"));
});

await test("requeuePriceRefreshTokens delays failed tokens", async () => {
  const redis = new FakeRedis();
  await requeuePriceRefreshTokens(redis, {
    venue: "dflow",
    tokenIds: ["sol:a"],
    nowMs: 1000,
    delayMs: 60_000,
  });

  assert.deepEqual(
    await claimDuePriceRefreshTokens(redis, {
      venue: "dflow",
      nowMs: 1000,
      limit: 10,
    }),
    [],
  );
  assert.deepEqual(
    await claimDuePriceRefreshTokens(redis, {
      venue: "dflow",
      nowMs: 61_000,
      limit: 10,
    }),
    ["sol:a"],
  );
});
