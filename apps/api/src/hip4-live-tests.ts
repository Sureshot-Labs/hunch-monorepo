import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_HIP4_READ_POLICY, hip4Identity } from "@hunch/shared";
import {
  createHip4LiveBuffer,
  selectHip4HotOutcomes,
} from "./services/hip4-live.js";
import { hip4StreamTokensAllowed } from "./services/hip4-stream-access.js";
import { parseHip4TradeCursor } from "./services/hip4-history.js";

const policy = {
  ...DEFAULT_HIP4_READ_POLICY,
  enabled: true,
  outcomeAllowlist: [1, 2],
  maxLiveOutcomes: 1,
  streamQueueSize: 2,
};
test("live queue is bounded, validates identity and leaves recovery hints on overflow", () => {
  let wakes = 0;
  const buffer = createHip4LiveBuffer(policy, () => wakes++);
  buffer.select([1]);
  const trade = {
    coin: "#10",
    px: "0.5",
    sz: "1",
    time: Date.now(),
    tid: 1,
    hash: "public",
    side: "B",
  };
  buffer.data("trades", [trade, trade]);
  buffer.data("trades", [trade]);
  buffer.data("trades", [{ ...trade, coin: "#11" }]);
  buffer.data("l2Book", { coin: "#20", time: Date.now(), levels: [[], []] });
  const batch = buffer.take();
  assert.equal(batch.entries.length, 2);
  assert.equal(buffer.diagnostics.overflow, 1);
  assert.equal(buffer.diagnostics.invalid, 2);
  assert.ok(batch.gaps.includes("queue_overflow"));
  assert.equal(buffer.take().entries.length, 0);
  assert.ok(wakes > 0);
  buffer.data("trades", [trade]);
  assert.equal(buffer.take().entries.length, 1);
});
test("hot selection and access are bounded and environment/allowlist specific", () => {
  const main = hip4Identity("mainnet", 2).sides[0].tokenId;
  assert.deepEqual(selectHip4HotOutcomes(policy, [main]), [2]);
  assert.deepEqual(selectHip4HotOutcomes(policy, [], [1]), [2]);
  assert.deepEqual(selectHip4HotOutcomes(policy, [main], [1, 2]), []);
  assert.equal(hip4StreamTokensAllowed(["123", main], policy), true);
  assert.equal(
    hip4StreamTokensAllowed([main], { ...policy, enabled: false }),
    false,
  );
  assert.equal(
    hip4StreamTokensAllowed([main], { ...policy, environment: "testnet" }),
    false,
  );
  assert.equal(
    hip4StreamTokensAllowed(["hyperliquid:mainnet:21"], policy),
    true,
  );
  assert.equal(
    hip4StreamTokensAllowed(["hyperliquid:mainnet:22"], policy),
    false,
  );
  assert.equal(
    hip4StreamTokensAllowed(["123"], { ...policy, enabled: false }),
    true,
  );
});
test("a recovery buffer retains the start of the failed flush interval", () => {
  const since = Date.now() - 5000;
  const buffer = createHip4LiveBuffer(policy, () => {}, since);
  buffer.select([1]);
  buffer.gap("flush_error");
  const recovered = buffer.take();
  assert.equal(recovered.since, since);
  assert.deepEqual(recovered.gaps, ["flush_error"]);
});
test("trade cursors bind the full tuple to one market", () => {
  const cursor = Buffer.from(
    JSON.stringify({ v: 1, market: "m1", time: 1, coin: "#10", tid: 2 }),
  ).toString("base64url");
  assert.equal(parseHip4TradeCursor(cursor, "m1")?.tid, 2);
  assert.throws(() => parseHip4TradeCursor(cursor, "m2"));
  assert.throws(() => parseHip4TradeCursor("bad", "m1"));
});
test("hot rotation drains retiring outcomes before dropping their accepted data", () => {
  const buffer = createHip4LiveBuffer(policy, () => {});
  buffer.select([1]);
  buffer.data("trades", [
    {
      coin: "#10",
      px: "0.5",
      sz: "1",
      time: Date.now(),
      tid: 1,
      hash: "fixture",
      side: "B",
    },
  ]);
  buffer.select([2]);
  buffer.gap("subscription_change");
  const batch = buffer.take();
  assert.deepEqual(batch.outcomes, [1, 2]);
  assert.equal(batch.entries.length, 1);
  assert.deepEqual(batch.gaps, ["subscription_change"]);
  assert.deepEqual(buffer.take().outcomes, [2]);
});
