// Real Redis; fixed loopback test target, unique keys, no key scans or flush.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createClient } from "redis";
import {
  TRADER_PUBLISH,
  shortlistPublication,
  TRADER_CHECKPOINT,
  TRADER_SAVE_CALC,
  TRADER_START,
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
import {
  WalletPageJournal,
  PageContinuation,
  JournalUnavailable,
  journalKey,
  SAVE_PAGE,
} from "./services/trader-collection-page-journal.js";
import { PolymarketDataApiV2Error } from "./services/polymarket-data-api-v2.js";
import type { ReadPage } from "./services/trader-collection-source.js";
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
const pages = journalKey(prefix, "test", "1", "addr", end);
assert.notEqual(pages, journalKey(prefix, "test", "1", "addr", end + 1));
assert.notEqual(pages, journalKey(prefix, "test", "2", "addr", end));
assert.equal(await redis.exists(pages), 0);
try {
  await redis.set(lock, "a");
  {
    const calcKey = prefix + "localcalc",
      nextKey = prefix + "preparing",
      expires = Math.floor(Date.now() / 1000) + 30;
    const start = (lease: string) =>
      redis.eval(TRADER_START, {
        keys: [lock, checkpoint, nextKey],
        arguments: [lease, "frozen originals", String(expires - 30), "30"],
      });
    const calc = (lease: string, until: number, value: string) =>
      redis.eval(TRADER_SAVE_CALC, {
        keys: [lock, calcKey],
        arguments: [lease, String(until), value],
      });
    try {
      assert.equal(await start("stale"), 0);
      assert.equal(await start("a"), 1);
      assert.equal(await redis.get(nextKey), String(expires - 30));
      assert.equal(await redis.get(checkpoint), "frozen originals");
      assert.equal(await calc("a", expires, "cursor+calculation"), 1);
      assert.equal(await calc("stale", expires, "bogus"), 0);
      assert.equal(await calc("a", expires - 31, "expired"), 0);
      assert.equal(await redis.get(calcKey), "cursor+calculation");
      assert.ok((await redis.ttl(calcKey)) > 0);
    } finally {
      await redis.del([calcKey, nextKey, checkpoint]);
    }
  }
  {
    const expires = Math.floor(Date.now() / 1000) + 30;
    const open = (lease = "a") =>
      new WalletPageJournal(
        {
          get: (k) => redis.hGet(pages, k),
          write: async (mode, k, v, decodedBytes) =>
            Number(
              await redis.eval(SAVE_PAGE, {
                keys: [lock, pages],
                arguments: [
                  lease,
                  String(expires),
                  mode,
                  k,
                  v,
                  String(decodedBytes),
                ],
              }),
            ),
        },
        "addr",
      );
    const signal = new AbortController().signal;
    const cutoff = Math.floor(Date.now() / 1000) - 10;
    const watermark = await open().inventoryThrough(cutoff);
    assert.ok(watermark >= cutoff);
    assert.equal(await open().inventoryThrough(cutoff), watermark);
    const j = open(),
      q = { user: "addr", start: "1" };
    let hits = 0;
    const complete: ReadPage = async () => {
      hits++;
      return {
        data: [
          {
            proxy_wallet: "addr",
            type: "TRADE",
            timestamp: 1000,
            biography: "not for checkpoint",
          },
        ],
        nextCursor: null,
      };
    };
    for (let i = 0; i < 90; i++)
      await j.page(
        complete,
        "activity",
        { ...q, start: String(i) },
        null,
        signal,
      );
    await assert.rejects(
      j.page(complete, "activity", { ...q, start: "90" }, null, signal),
      PageContinuation,
    );
    assert.equal(hits, 90);
    const resumed = open();
    for (let i = 0; i <= 90; i++) {
      const p = await resumed.page(
        complete,
        "activity",
        { ...q, start: String(i) },
        null,
        signal,
      );
      assert.equal(p.data[0].biography, undefined);
    }
    assert.equal(hits, 91);
    assert.ok((await redis.ttl(pages)) > 0);
    const invalid: ReadPage = async () => {
      throw new PolymarketDataApiV2Error(
        400,
        "invalid_request",
        false,
        null,
        null,
        "cursor",
        "invalid_cursor",
      );
    };
    const capacityBefore = await redis.hmGet(pages, [
      "bytes",
      "decoded",
      "pages",
    ]);
    await assert.rejects(
      resumed.page(invalid, "activity", q, "invalid", signal),
      PolymarketDataApiV2Error,
    );
    await open().page(complete, "activity", q, null, signal);
    await open().page(complete, "activity", { ...q, start: "2" }, null, signal);
    assert.deepEqual(
      await redis.hmGet(pages, ["bytes", "decoded", "pages"]),
      capacityBefore,
      "identical replacement page uses no additional quota",
    );
    assert.equal(hits, 92, "only the invalid cursor stream is restarted");
    await assert.rejects(
      open("stale").page(
        complete,
        "activity",
        { ...q, start: "100" },
        null,
        signal,
      ),
      JournalUnavailable,
    );
    assert.equal(await redis.hGet(pages, "pages"), "91");
    await assert.rejects(
      open().page(
        async () => ({ data: [{ proxy_wallet: "other" }], nextCursor: null }),
        "positions",
        q,
        null,
        signal,
      ),
      /owner_mismatch/,
    );
    await redis.hSet(pages, "bytes", String(4 * 1024 * 1024));
    await redis.hSet(pages, "pages", "384");
    await redis.hSet(pages, "decoded", String(24 * 1024 * 1024));
    // At all three ceilings the stale stream can still be replaced; unrelated
    // streams and their quota remain intact.
    await assert.rejects(
      open().page(invalid, "activity", q, "bad2", signal),
      PolymarketDataApiV2Error,
    );
    await open().page(complete, "activity", q, null, signal);
    assert.deepEqual(await redis.hmGet(pages, ["bytes", "decoded", "pages"]), [
      String(4 * 1024 * 1024),
      String(24 * 1024 * 1024),
      "384",
    ]);
    await assert.rejects(
      open().page(complete, "activity", { ...q, start: "100" }, null, signal),
      /wallet_page_capacity/,
    );
    assert.equal(
      await redis.eval(TRADER_CHECKPOINT, {
        keys: [lock, checkpoint, pages],
        arguments: ["stale", ""],
      }),
      0,
    );
    assert.ok(await redis.exists(pages));
    assert.equal(
      await redis.eval(TRADER_CHECKPOINT, {
        keys: [lock, checkpoint, pages],
        arguments: ["a", ""],
      }),
      1,
    );
    assert.equal(await redis.exists(pages), 0);
  }
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
  // Observing earnings ordinals 50..99 cannot overwrite a valid Streaks
  // ranking when none of its own first 50 wallets could be read.
  const larger = createSweep([...s.owners, ...s.owners], end);
  larger.evaluated[70] = { choices: emptyChoices(), rejected: {} };
  const tail = sweepSnapshots(larger, "tail-only", end);
  const retained = await read();
  const payload = collections.map((k) => shortlistPublication(tail[k]));
  assert.equal(payload[0], "");
  assert.equal(payload[2], "");
  assert.equal(
    await redis.eval(TRADER_PUBLISH, {
      keys,
      arguments: ["holder2", ...payload, "1800", ""],
    }),
    1,
  );
  const after = await read();
  assert.equal(after[0], retained[0]);
  assert.equal(after[2], retained[2]);
  assert.equal(JSON.parse(after[1] ?? "null").snapshotId, "tail-only");
  const before = await redis.mGet(keys.slice(1, 4));
  await save("holder2", "unavailable cohort");
  assert.equal(await save("holder2", ""), 1);
  assert.deepEqual(await redis.mGet(keys.slice(1, 4)), before);
  console.log(
    "OK: fenced partial publish + resume, 50 distinct wallets, stale holder, complete/failed finalization (local Redis)",
  );
} finally {
  await redis.del([...keys, pages]);
  await redis.quit();
}
