import assert from "node:assert/strict";

import {
  claimDuePriceRefreshTokens,
  enqueuePriceRefreshTokens,
  getPriceRefreshQueueBacklog,
  inferPriceRefreshVenue,
  requeuePriceRefreshTokens,
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
  ): Promise<string[]> {
    const key = options.keys[0];
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
