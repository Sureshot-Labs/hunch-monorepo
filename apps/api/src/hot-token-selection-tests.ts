import assert from "node:assert/strict";

import {
  clampHotTokenProbeLimit,
  selectRecentHotTokenIds,
  type HotTokenRedis,
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

class FakeHotTokenRedis implements HotTokenRedis {
  readonly sets = new Map<string, Map<string, number>>();
  readonly removals: Array<{ key: string; max: number; min: number }> = [];

  seed(key: string, entries: Array<[string, number]>): void {
    this.sets.set(key, new Map(entries));
  }

  async zRemRangeByScore(
    key: string,
    min: number,
    max: number,
  ): Promise<number> {
    this.removals.push({ key, min, max });
    const set = this.sets.get(key) ?? new Map<string, number>();
    let removed = 0;
    for (const [value, score] of set) {
      if (score >= min && score <= max) {
        set.delete(value);
        removed += 1;
      }
    }
    this.sets.set(key, set);
    return removed;
  }

  async zRange(
    key: string,
    start: number,
    stop: number,
    options: { REV: true },
  ): Promise<string[]> {
    assert.equal(options.REV, true);
    return Array.from(this.sets.get(key)?.entries() ?? [])
      .sort(
        (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
      )
      .slice(start, stop + 1)
      .map(([value]) => value);
  }
}

test("hot-token selector prioritizes stream tokens and deduplicates", async () => {
  const redis = new FakeHotTokenRedis();
  redis.seed("hot:tokens:stream:limitless", [
    ["shared", 9_900],
    ["stream", 9_800],
  ]);
  redis.seed("hot:tokens:limitless", [
    ["hot", 9_950],
    ["shared", 9_700],
  ]);

  assert.deepEqual(
    await selectRecentHotTokenIds(redis, {
      hotStreamTokensMax: 2,
      hotStreamTokensTtlSec: 10,
      hotTokensMax: 2,
      hotTokensTtlSec: 10,
      nowMs: 10_000,
      venue: "limitless",
    }),
    ["shared", "stream"],
  );
});

test("hot-token selector removes stale entries using independent TTLs", async () => {
  const redis = new FakeHotTokenRedis();
  redis.seed("hot:tokens:stream:dflow", [
    ["stale-stream", 7_000],
    ["fresh-stream", 9_500],
  ]);
  redis.seed("hot:tokens:dflow", [
    ["stale-hot", 4_000],
    ["fresh-hot", 8_000],
  ]);

  assert.deepEqual(
    await selectRecentHotTokenIds(redis, {
      hotStreamTokensMax: 5,
      hotStreamTokensTtlSec: 2,
      hotTokensMax: 5,
      hotTokensTtlSec: 5,
      nowMs: 10_000,
      venue: "dflow",
    }),
    ["fresh-stream", "fresh-hot"],
  );
  assert.deepEqual(redis.removals, [
    { key: "hot:tokens:stream:dflow", min: 0, max: 8_000 },
    { key: "hot:tokens:dflow", min: 0, max: 5_000 },
  ]);
});

test("hot-token selector respects requested and per-set limits", async () => {
  const redis = new FakeHotTokenRedis();
  redis.seed("hot:tokens:stream:polymarket", [
    ["stream-1", 30],
    ["stream-2", 20],
  ]);
  redis.seed("hot:tokens:polymarket", [
    ["hot-1", 40],
    ["hot-2", 10],
  ]);

  assert.deepEqual(
    await selectRecentHotTokenIds(redis, {
      hotStreamTokensMax: 1,
      hotStreamTokensTtlSec: 100,
      hotTokensMax: 3,
      hotTokensTtlSec: 100,
      limit: 2,
      nowMs: 100,
      venue: "polymarket",
    }),
    ["stream-1", "hot-1"],
  );
});

test("hot-token selector skips Redis when disabled", async () => {
  const redis = new FakeHotTokenRedis();
  assert.deepEqual(
    await selectRecentHotTokenIds(redis, {
      hotStreamTokensMax: 0,
      hotStreamTokensTtlSec: 10,
      hotTokensMax: 0,
      hotTokensTtlSec: 10,
      venue: "dflow",
    }),
    [],
  );
  assert.deepEqual(redis.removals, []);
});

test("hot-token probe clamp preserves established bounds", () => {
  assert.equal(clampHotTokenProbeLimit(10), 200);
  assert.equal(clampHotTokenProbeLimit(750.9), 750);
  assert.equal(clampHotTokenProbeLimit(5_000), 2_000);
});
