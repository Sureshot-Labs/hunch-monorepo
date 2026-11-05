import assert from "node:assert/strict";
import test from "node:test";
import { DefaultCategoryCache } from "./services/default-category-cache.js";

const timeout = Object.assign(Error("fixture timeout"), { code: "57014" });
const recoverable = (error: unknown) => error === timeout;
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
function fixture() {
  let now = 1000;
  const values = new Map<string, string>();
  const redis = {
    async get(key: string) {
      return values.get(key) ?? null;
    },
    async set(key: string, body: string) {
      values.set(key, body);
      return "OK";
    },
  };
  return {
    values,
    redis,
    cache: new DefaultCategoryCache(10, 60, () => now),
    advance: (ms: number) => {
      now += ms;
    },
  };
}
test("cold concurrent readers share one complete calculation", async () => {
  const f = fixture();
  let count = 0;
  let release!: (s: string) => void;
  const compute = () => {
    count++;
    return new Promise<string>((resolve) => {
      release = resolve;
    });
  };
  const calls = Array.from({ length: 20 }, () =>
    f.cache.load("a", f.redis, compute, () => "fallback", recoverable),
  );
  await turn();
  assert.equal(count, 1);
  release("complete");
  assert.ok((await Promise.all(calls)).every((r) => r.body === "complete"));
  assert.equal(f.values.get("a:stale"), "complete");
});
test("SQL failure does not restart per reader and next normal interval recovers", async () => {
  const f = fixture();
  let count = 0,
    fail = true;
  const compute = async () => {
    count++;
    if (fail) throw timeout;
    return "recovered";
  };
  for (let i = 0; i < 20; i++)
    assert.equal(
      (await f.cache.load("a", f.redis, compute, () => "fallback", recoverable))
        .cacheStatus,
      "fallback",
    );
  assert.equal(count, 1);
  fail = false;
  f.advance(10001);
  assert.equal(
    (await f.cache.load("a", f.redis, compute, () => "fallback", recoverable))
      .body,
    "recovered",
  );
  assert.equal(count, 2);
});
test("stale reads retain last-good while one background refresh fails and recovers", async () => {
  const f = fixture();
  f.values.set("a:stale", "old");
  let calls = 0,
    fail = true;
  const compute = async () => {
    calls++;
    if (fail) throw timeout;
    return "new";
  };
  assert.equal(
    (await f.cache.load("a", f.redis, compute, () => "fallback", recoverable))
      .body,
    "old",
  );
  await turn();
  for (let i = 0; i < 10; i++)
    assert.equal(
      (await f.cache.load("a", f.redis, compute, () => "fallback", recoverable))
        .body,
      "old",
    );
  assert.equal(calls, 1);
  f.advance(10001);
  fail = false;
  await f.cache.load("a", f.redis, compute, () => "fallback", recoverable);
  await turn();
  assert.equal(
    (await f.cache.load("a", f.redis, compute, () => "fallback", recoverable))
      .body,
    "new",
  );
});
test("fresh cache reads do not postpone the existing refresh cadence", async () => {
  const f = fixture();
  let calls = 0;
  const compute = async () => String(++calls);
  await f.cache.load("a", f.redis, compute, () => "fallback", recoverable);
  f.advance(9999);
  await f.cache.load("a", f.redis, compute, () => "fallback", recoverable);
  f.values.delete("a");
  f.advance(2);
  await f.cache.load("a", f.redis, compute, () => "fallback", recoverable);
  await turn();
  assert.equal(calls, 2);
});
test("Redis failure preserves computed counts and key isolation", async () => {
  const f = fixture();
  let calls = 0;
  const bad = {
    get: async () => {
      throw Error("fixture Redis");
    },
    set: async () => {
      throw Error("fixture Redis");
    },
  };
  const computed = await f.cache.load(
    "a",
    bad,
    async () => {
      calls++;
      return "good";
    },
    () => "fallback",
    recoverable,
  );
  assert.equal(computed.body, "good");
  assert.equal(
    (
      await f.cache.load(
        "a",
        bad,
        async () => {
          calls++;
          return "wrong";
        },
        () => "fallback",
        recoverable,
      )
    ).body,
    "good",
  );
  assert.equal(calls, 1);
  assert.equal(
    (
      await f.cache.load(
        "different-revision",
        bad,
        async () => {
          throw timeout;
        },
        () => "fallback",
        recoverable,
      )
    ).body,
    "fallback",
  );
});
test("unexpected errors are not presented as fabricated successful counts", async () => {
  const f = fixture();
  let calls = 0;
  const error = Error("fixture programmer error");
  for (let i = 0; i < 2; i++)
    await assert.rejects(
      f.cache.load(
        "a",
        null,
        async () => {
          calls++;
          throw error;
        },
        () => "fallback",
        recoverable,
      ),
      (e) => e === error,
    );
  assert.equal(calls, 1);
});
