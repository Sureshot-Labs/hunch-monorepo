import assert from "node:assert/strict";
import { test } from "node:test";
import {
  advanceHip4FillRepair,
  HIP4_FILL_PAGE_MAX,
  planHip4FillRepair,
} from "./services/hip4-account-history.js";
import { hip4AccountPolicySchema } from "./services/hip4-account-policy.js";

const now = 1_800_000;
const lookback = 600_000;
const at = new Date(now).toISOString();
const plan = () => planHip4FillRepair(undefined, lookback, now, 32);
const rows = (time: number, count: number) =>
  Array.from({ length: count }, (_, tid) => ({ time, tid, coin: "@107" }));

test("fill repair fixes its end and resumes inclusively after the entire mixed-venue page", () => {
  const first = plan();
  const next = advanceHip4FillRepair(
    first,
    rows(now - 100, HIP4_FILL_PAGE_MAX),
    at,
    32,
  );
  assert.equal(next.nextTime, now - 100);
  const resumed = planHip4FillRepair(next, lookback, now + 60000, 32);
  assert.equal(resumed.nextTime, next.nextTime);
  assert.equal(resumed.endTime, now);
  assert.equal(resumed.startTime, first.startTime);
  assert.equal(resumed.pagesRead, 1);
});

test("empty or uncapped provider range can finish but never claims retained all-time history", () => {
  const finished = advanceHip4FillRepair(plan(), [], at, 32);
  assert.equal(finished.nextTime, null);
  assert.equal(finished.providerRetentionLimited, true);
  const extended = planHip4FillRepair(finished, lookback, now + 60000, 32);
  assert.equal(extended.nextTime, now);
  assert.equal(extended.endTime, now + 60000);
  assert.equal(extended.lastSuccessAt, at);
});

test("a full tied-timestamp page records the unpageable gap before advancing", () => {
  const initial = plan();
  const initialTime = initial.nextTime;
  assert.ok(initialTime != null);
  const next = advanceHip4FillRepair(
    initial,
    rows(initialTime, HIP4_FILL_PAGE_MAX),
    at,
    32,
  );
  assert.equal(next.nextTime, initialTime + 1);
  assert.deepEqual(next.gaps, [
    { time: initial.nextTime, reason: "timestamp_saturated" },
  ]);
  assert.equal(next.gapCount, 1);
  assert.equal(next.gapDetailsTruncated, false);
  const last = { ...plan(), nextTime: now };
  assert.equal(
    advanceHip4FillRepair(last, rows(now, HIP4_FILL_PAGE_MAX), at, 32).nextTime,
    null,
  );
});

test("gap detail bounds preserve the cumulative gap count and explicit truncation", () => {
  let state = plan();
  for (let i = 0; i < 3; i++) {
    assert.ok(state.nextTime != null);
    state = advanceHip4FillRepair(
      state,
      rows(state.nextTime, HIP4_FILL_PAGE_MAX),
      at,
      2,
    );
  }
  assert.equal(state.gapCount, 3);
  assert.equal(state.gaps.length, 2);
  assert.equal(state.gapDetailsTruncated, true);
  const smaller = planHip4FillRepair(state, lookback, now, 1);
  assert.equal(smaller.gaps.length, 1);
  assert.equal(smaller.gapCount, 3);
});

test("malformed, unordered or out-of-range pages cannot advance a saved boundary", () => {
  const state = plan();
  for (const page of [
    [{ time: state.startTime - 1, coin: "@107" }],
    [{ time: now + 1, coin: "@107" }],
    [
      { time: now, coin: "@107" },
      { time: now - 1, coin: "#87750" },
    ],
    [{ time: "100", coin: "@107" }],
    [{ time: state.startTime }],
    rows(now, HIP4_FILL_PAGE_MAX + 1),
  ])
    assert.throws(() => advanceHip4FillRepair(state, page, at, 32));
  assert.equal(state.nextTime, state.startTime);
  assert.equal(state.lastSuccessAt, null);
});

test("lookback changes rescan the requested range without forgetting recorded gaps", () => {
  const saved = advanceHip4FillRepair(
    plan(),
    rows(plan().startTime, HIP4_FILL_PAGE_MAX),
    at,
    32,
  );
  const changed = planHip4FillRepair(saved, lookback * 2, now, 32);
  assert.equal(changed.startTime, now - lookback * 2);
  assert.equal(changed.nextTime, changed.startTime);
  assert.equal(changed.gapCount, saved.gapCount);
  const repaired = planHip4FillRepair(
    { ...saved, nextTime: now + 1 },
    lookback,
    now,
    32,
  );
  assert.equal(repaired.nextTime, now - lookback);
  assert.equal(repaired.cursorResetCount, 1);
  assert.equal(repaired.gapCount, saved.gapCount);
});

test("repair policy is bounded and can pause only the extra history reads", () => {
  const defaults = hip4AccountPolicySchema.parse({});
  assert.equal(defaults.historyRepairPagesPerRefresh, 1);
  assert.equal(
    hip4AccountPolicySchema.parse({ historyRepairPagesPerRefresh: 0 })
      .historyRepairPagesPerRefresh,
    0,
  );
  assert.throws(() =>
    hip4AccountPolicySchema.parse({ historyRepairPagesPerRefresh: 5 }),
  );
  assert.throws(() =>
    hip4AccountPolicySchema.parse({ historyRepairMaxGapDetails: 0 }),
  );
});
