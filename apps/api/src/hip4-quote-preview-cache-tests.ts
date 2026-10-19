import assert from "node:assert/strict";
import { test } from "node:test";
import { createHip4QuotePreviewCache } from "./services/hip4-quote-preview-cache.js";
import { hip4ReadPolicySchema } from "@hunch/shared";

type Facts = { observedAt: number; expiresAt: number; amount: string };
const deadline = (facts: Facts) => facts.expiresAt;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

test("preview storage is runtime-bounded with a zero-off recovery switch", () => {
  assert.equal(hip4ReadPolicySchema.parse({}).quotePreviewCacheEntries, 64);
  assert.equal(
    hip4ReadPolicySchema.parse({ quotePreviewCacheEntries: 0 })
      .quotePreviewCacheEntries,
    0,
  );
  for (const quotePreviewCacheEntries of [-1, 1.5, 1001])
    assert.equal(
      hip4ReadPolicySchema.safeParse({ quotePreviewCacheEntries }).success,
      false,
    );
});

test("facts expiring while pending are never retained for another preview", async () => {
  let now = 1000;
  const cache = createHip4QuotePreviewCache<Facts>(() => now);
  const pending = deferred<Facts>();
  const first = cache.read("scope", 1, () => pending.promise, deadline);
  now = 2000;
  pending.resolve({ observedAt: 1000, expiresAt: 1500, amount: "10" });
  await first;
  let reads = 0;
  await cache.read(
    "scope",
    1,
    async () => {
      reads++;
      return { observedAt: 2000, expiresAt: 3000, amount: "20" };
    },
    deadline,
  );
  assert.equal(reads, 1);
});

test("preview successes coalesce and retain original timestamps and independent values", async () => {
  let now = 1000;
  const cache = createHip4QuotePreviewCache<Facts>(() => now);
  const pending = deferred<Facts>();
  let loads = 0;
  const load = () => {
    loads++;
    return pending.promise;
  };
  const first = cache.read("scope", 64, load, deadline);
  const second = cache.read("scope", 64, load, deadline);
  await Promise.resolve();
  assert.equal(loads, 1);
  pending.resolve({ observedAt: 1000, expiresAt: 2000, amount: "10" });
  const [one, two] = await Promise.all([first, second]);
  assert.notEqual(one, two);
  one.amount = "999";
  now = 1999;
  assert.deepEqual(await cache.read("scope", 64, load, deadline), {
    observedAt: 1000,
    expiresAt: 2000,
    amount: "10",
  });
  assert.equal(loads, 1);
  now = 2000;
  let recovered = 0;
  assert.equal(
    (
      await cache.read(
        "scope",
        64,
        async () => {
          recovered++;
          return { observedAt: now, expiresAt: 3000, amount: "20" };
        },
        deadline,
      )
    ).amount,
    "20",
  );
  assert.equal(recovered, 1);
});

test("provider failures are not cached and an ordinary retry recovers", async () => {
  const cache = createHip4QuotePreviewCache<Facts>(() => 1000);
  let loads = 0;
  const load = async () => {
    loads++;
    if (loads === 1) throw new Error("budget_exhausted");
    return { observedAt: 1000, expiresAt: 2000, amount: "10" };
  };
  await assert.rejects(
    cache.read("scope", 64, load, deadline),
    /budget_exhausted/,
  );
  assert.equal((await cache.read("scope", 64, load, deadline)).amount, "10");
  assert.equal(loads, 2);
});

test("zero policy bypasses completed and pending reads without late repopulation", async () => {
  const cache = createHip4QuotePreviewCache<Facts>(() => 1000);
  const pending = deferred<Facts>();
  let loads = 0;
  const value = { observedAt: 1000, expiresAt: 2000, amount: "10" };
  const old = cache.read("scope", 1, () => pending.promise, deadline);
  const fresh = async () => {
    loads++;
    return value;
  };
  await cache.read("scope", 0, fresh, deadline);
  await cache.read("scope", 0, fresh, deadline);
  pending.resolve(value);
  await old;
  await cache.read("scope", 1, fresh, deadline);
  assert.equal(loads, 3);
  await cache.read("scope", 0, fresh, deadline);
  assert.equal(loads, 4);
});

test("explicit clearing revokes completed and pending fact namespaces together", async () => {
  const cache = createHip4QuotePreviewCache<Facts>(() => 1000);
  const pending = deferred<Facts>();
  const value = { observedAt: 1000, expiresAt: 2000, amount: "10" };
  await cache.read("fee", 2, async () => value, deadline);
  const old = cache.read("capacity", 2, () => pending.promise, deadline);
  cache.clear();
  pending.resolve(value);
  await old;
  let loads = 0;
  for (const key of ["fee", "capacity"])
    await cache.read(
      key,
      2,
      async () => {
        loads++;
        return value;
      },
      deadline,
    );
  assert.equal(loads, 2);
});

test("late completion or failure cannot replace or erase a newer bounded entry", async () => {
  for (const failOld of [false, true]) {
    const cache = createHip4QuotePreviewCache<Facts>(() => 1000);
    const pending = deferred<Facts>();
    const value = { observedAt: 1000, expiresAt: 2000, amount: "10" };
    const old = cache.read("old", 1, () => pending.promise, deadline);
    const oldOutcome = old.catch(() => null);
    await cache.read("other", 1, async () => value, deadline);
    await cache.read(
      "old",
      1,
      async () => ({ ...value, amount: "20" }),
      deadline,
    );
    if (failOld) pending.reject(new Error("old failed"));
    else pending.resolve(value);
    await oldOutcome;
    assert.equal(
      (
        await cache.read(
          "old",
          1,
          async () => {
            throw new Error("newer value must remain cached");
          },
          deadline,
        )
      ).amount,
      "20",
    );
  }
});

test("a full pending cache never blocks another scope and lowering its bound trims hits", async () => {
  const cache = createHip4QuotePreviewCache<Facts>(() => 1000);
  const pending = deferred<Facts>();
  const value = { observedAt: 1000, expiresAt: 2000, amount: "10" };
  const old = cache.read("pending", 1, () => pending.promise, deadline);
  assert.deepEqual(
    await cache.read("second", 1, async () => value, deadline),
    value,
  );
  pending.resolve(value);
  await old;
  for (const key of ["one", "two", "three"])
    await cache.read(key, 3, async () => value, deadline);
  await cache.read(
    "two",
    1,
    async () => {
      throw new Error("the hit should remain most-recently used");
    },
    deadline,
  );
  let loads = 0;
  await cache.read(
    "three",
    1,
    async () => {
      loads++;
      return value;
    },
    deadline,
  );
  assert.equal(loads, 1, "a lower bound also takes effect on cache hits");
});
