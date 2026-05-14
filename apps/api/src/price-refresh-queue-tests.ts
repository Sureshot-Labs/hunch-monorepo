import assert from "node:assert/strict";

import {
  claimDuePriceRefreshTokens,
  enqueuePriceRefreshTokens,
  getPriceRefreshQueueBacklog,
  inferPriceRefreshVenue,
  requeuePriceRefreshTokens,
  type PriceRefreshRedis,
} from "@hunch/infra";
import { collectPriceRefreshTokenIdsFromSources } from "./lib/price-refresh.js";

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
}

await test("inferPriceRefreshVenue recognizes active venue token shapes", () => {
  assert.equal(inferPriceRefreshVenue("12345"), "polymarket");
  assert.equal(inferPriceRefreshVenue("sol:mint"), "dflow");
  assert.equal(inferPriceRefreshVenue("limitless:abc"), "limitless");
  assert.equal(inferPriceRefreshVenue("kalshi:legacy"), null);
});

await test("collectPriceRefreshTokenIdsFromSources normalizes agent position tokens", () => {
  assert.deepEqual(
    collectPriceRefreshTokenIdsFromSources([
      { venue: "polymarket", tokenId: "12345" },
      { venue: "limitless", tokenId: "abc" },
      { venue: "limitless", tokenId: "limitless:def" },
      { venue: "kalshi", tokenId: "raw-mint" },
      { venue: "kalshi", tokenId: "sol:prefixed-mint" },
      { venue: "polymarket", tokenId: "not-a-polymarket-token" },
    ]),
    [
      "12345",
      "limitless:abc",
      "limitless:def",
      "sol:raw-mint",
      "sol:prefixed-mint",
    ],
  );
});

await test("collectPriceRefreshTokenIdsFromSources normalizes order mints and skips USDC", () => {
  assert.deepEqual(
    collectPriceRefreshTokenIdsFromSources(
      [
        {
          venue: "kalshi",
          input_mint: "USDC_MINT",
          output_mint: "outcome-mint",
        },
        {
          venue: "kalshi",
          inputMint: "sol:outcome-mint",
          outputMint: "USDC_MINT",
        },
        {
          venue: "polymarket",
          token_id: "999",
        },
      ],
      { solanaUsdcMint: "USDC_MINT" },
    ),
    ["sol:outcome-mint", "999"],
  );
});

await test("collectPriceRefreshTokenIdsFromSources does not treat non-DFlow mints as Solana tokens", () => {
  assert.deepEqual(
    collectPriceRefreshTokenIdsFromSources([
      {
        venue: "limitless",
        token_id: "limitless-token",
        input_mint: "base-usdc",
        output_mint: "base-outcome",
      },
    ]),
    ["limitless:limitless-token"],
  );
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
