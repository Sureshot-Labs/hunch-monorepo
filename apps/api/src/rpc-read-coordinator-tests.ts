#!/usr/bin/env tsx

import assert from "node:assert/strict";

import { RpcReadCoordinator } from "./services/rpc-read-coordinator.js";

const originalNow = Date.now;
let now = 1_000;
Date.now = () => now;

try {
  const coordinator = new RpcReadCoordinator(2);

  let concurrentLoads = 0;
  let releaseConcurrent!: (value: string) => void;
  const concurrentResult = new Promise<string>((resolve) => {
    releaseConcurrent = resolve;
  });
  const concurrentLoader = () => {
    concurrentLoads += 1;
    return concurrentResult;
  };
  const concurrent = Array.from({ length: 20 }, () =>
    coordinator.singleFlight("concurrent", concurrentLoader),
  );
  assert.equal(concurrentLoads, 1);
  releaseConcurrent("ok");
  assert.deepEqual(await Promise.all(concurrent), Array(20).fill("ok"));

  let failedLoads = 0;
  await assert.rejects(
    coordinator.singleFlight("failure", async () => {
      failedLoads += 1;
      throw new Error("temporary failure");
    }),
  );
  assert.equal(
    await coordinator.singleFlight("failure", async () => {
      failedLoads += 1;
      return "recovered";
    }),
    "recovered",
  );
  assert.equal(failedLoads, 2);

  let memoLoads = 0;
  const loadMemo = () =>
    coordinator.memo("memo-value", { ttlMs: 100 }, async () => ++memoLoads);
  assert.equal(await loadMemo(), 1);
  assert.equal(await loadMemo(), 1);
  assert.equal(memoLoads, 1);
  now += 101;
  assert.equal(await loadMemo(), 2);

  let freshLoads = 0;
  assert.deepEqual(
    await Promise.all(
      Array.from({ length: 20 }, () =>
        coordinator.memo(
          "memo-value",
          { ttlMs: 100, bypass: true },
          async () => `fresh-${++freshLoads}`,
        ),
      ),
    ),
    Array(20).fill("fresh-1"),
  );
  assert.equal(freshLoads, 1);
  assert.equal(
    await coordinator.memo(
      "memo-value",
      { ttlMs: 100 },
      async () => "unexpected",
    ),
    "fresh-1",
  );

  let nullLoads = 0;
  const loadNull = () =>
    coordinator.memo("pending-null", { ttlMs: 100 }, async () => {
      nullLoads += 1;
      return null;
    });
  assert.equal(await loadNull(), null);
  assert.equal(await loadNull(), null);
  assert.equal(nullLoads, 2);

  const bounded = new RpcReadCoordinator(2);
  await bounded.memo("a", { ttlMs: 1_000 }, async () => "a1");
  await bounded.memo("b", { ttlMs: 1_000 }, async () => "b1");
  assert.equal(
    await bounded.memo("a", { ttlMs: 1_000 }, async () => "unexpected"),
    "a1",
  );
  await bounded.memo("c", { ttlMs: 1_000 }, async () => "c1");
  assert.equal(
    await bounded.memo("b", { ttlMs: 1_000 }, async () => "b2"),
    "b2",
  );

  let sequentialLoads = 0;
  await coordinator.singleFlight("mutable", async () => ++sequentialLoads);
  await coordinator.singleFlight("mutable", async () => ++sequentialLoads);
  assert.equal(sequentialLoads, 2);
} finally {
  Date.now = originalNow;
}

console.log("rpc read coordinator tests passed");
