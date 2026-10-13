import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createTopTickGate } from "./top-tick-gate.js";

test("hot token updates one pending value without reallocating its deadline timer", async () => {
  const ticks: Array<{ bestBid: number | null; tsMs: number }> = [];
  const gate = createTopTickGate({
    minIntervalMs: 60,
    onDeferredPublish: (tick) => ticks.push(tick),
  });
  const original = globalThis.setTimeout;
  let scheduled = 0;
  try {
    globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
      scheduled++;
      return original(...args);
    }) as typeof setTimeout;
    const now = Date.now();
    assert.ok(
      gate.shouldPublish({
        tokenId: "a",
        bestBid: 0.1,
        bestAsk: 0.9,
        tsMs: now,
        nowMs: now,
      }),
    );
    for (let i = 1; i <= 1000; i++) {
      assert.equal(
        gate.shouldPublish({
          tokenId: "a",
          bestBid: 0.2 + i / 10000,
          bestAsk: 0.9,
          tsMs: now + i,
          nowMs: now + 1,
        }),
        false,
      );
    }
    assert.equal(scheduled, 1);
    globalThis.setTimeout = original;
    await delay(90);
    assert.equal(ticks.length, 1);
    assert.equal(ticks[0].bestBid, 0.2 + 1000 / 10000);
    assert.equal(ticks[0].tsMs, now + 1000);
  } finally {
    globalThis.setTimeout = original;
    gate.clear();
  }
});

test("return to published price and authoritative terminal tick cancel deferred values", async () => {
  const ticks: unknown[] = [];
  const gate = createTopTickGate({
    minIntervalMs: 60,
    onDeferredPublish: (tick) => ticks.push(tick),
  });
  const now = Date.now();
  const emit = (
    tokenId: string,
    bestBid: number,
    revision: number,
    forcePublish = false,
  ) =>
    gate.shouldPublish({
      tokenId,
      bestBid,
      bestAsk: 0.9,
      tsMs: now + revision,
      nowMs: now + revision,
      forcePublish,
    });
  try {
    emit("a", 0.1, 0);
    emit("a", 0.2, 1);
    emit("a", 0.1, 2);
    emit("b", 0.1, 0);
    emit("b", 0.2, 1);
    assert.ok(emit("b", 1, 2, true));
    assert.equal(emit("b", 0.3, 1), false);
    await delay(90);
    assert.deepEqual(ticks, []);
  } finally {
    gate.clear();
  }
});
