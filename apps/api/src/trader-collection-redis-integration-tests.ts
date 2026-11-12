// Real Redis; fixed loopback test target, unique keys, no key scans or flush.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createClient } from "redis";
import {
  TRADER_PUBLISH,
  TRADER_CHECKPOINT,
} from "./services/trader-collection-service.js";
import {
  createSweep,
  decodeSweep,
  encodeSweep,
  finishSlice,
  recordEvaluation,
  sweepSnapshots,
} from "./services/trader-collection-sweep.js";
import { emptyChoices } from "./services/trader-collection-ranking.js";
import { collections } from "./schemas/trader-collections.js";
const redis = createClient({
  url: "redis://127.0.0.1:6380",
  socket: { connectTimeout: 2000, reconnectStrategy: false },
});
await redis.connect();
const prefix = "trader-sweep-test:" + randomUUID() + ":",
  keys = ["lease", ...collections, "checkpoint"].map((s) => prefix + s);
const [lock, , , , checkpoint] = keys,
  saveKeys = [lock, checkpoint];
const save = (lease: string, body: string) =>
  redis.eval(TRADER_CHECKPOINT, { keys: saveKeys, arguments: [lease, body] });
const read = () => redis.mGet(keys.slice(1));
const end = 1800000000;
let s = createSweep(
  Array.from({ length: 50 }, (_, i) => ({
    id: String(i),
    family: "f" + i,
    address: "private" + i,
    name: null,
  })),
  end,
);
assert.equal(await redis.exists(keys), 0);
try {
  await redis.set(lock, "a");
  assert.equal(await save("a", encodeSweep(s)), 1);
  for (const [pass, size] of [13, 16, 21].entries()) {
    const lease = "holder" + pass;
    await redis.set(lock, lease);
    // Simulate process restart: bootstrap only from the stored progress.
    const saved = await redis.get(checkpoint);
    assert.ok(saved);
    s = decodeSweep(saved);
    for (const i of s.queue.slice(0, size)) {
      assert.equal(s.attempts[i]++, 0);
      recordEvaluation(s, i, {
        choices: emptyChoices(),
        rejected: {
          "big-moves": "too_few_closes",
          "winning-streaks": "too_few_closes",
          "top-earners-today": "too_few_closes",
        },
      });
    }
    finishSlice(s, size, []);
    s.publishedAt = end + (pass + 1) * 215;
    const out = sweepSnapshots(s, lease, s.publishedAt);
    const args = [
      ...collections.map((k) => JSON.stringify(out[k])),
      "1800",
      s.queue.length ? encodeSweep(s) : "",
    ];
    const before = await read();
    assert.equal(
      await redis.eval(TRADER_PUBLISH, { keys, arguments: ["stale", ...args] }),
      0,
    );
    assert.equal(await save("stale", ""), 0);
    assert.deepEqual(await read(), before);
    assert.equal(
      await redis.eval(TRADER_PUBLISH, { keys, arguments: [lease, ...args] }),
      1,
    );
    const values = await read();
    assert.equal(values[3], s.queue.length ? encodeSweep(s) : null);
    for (const body of values.slice(0, 3)) {
      assert.ok(body);
      const parsed = JSON.parse(body);
      assert.equal(parsed.snapshotId, lease);
      assert.equal(parsed.diagnostics.observedWallets, 50 - s.queue.length);
      assert.ok(!body.includes("private"));
    }
  }
  assert.equal(await redis.get(checkpoint), null);
  const before = await redis.mGet(keys.slice(1, 4));
  await save("holder2", "unavailable cohort");
  assert.equal(await save("holder2", ""), 1);
  assert.deepEqual(await redis.mGet(keys.slice(1, 4)), before);
  console.log(
    "OK: fenced partial publish + resume, 50 distinct wallets, stale holder, complete/failed finalization (local Redis)",
  );
} finally {
  await redis.del(keys);
  await redis.quit();
}
