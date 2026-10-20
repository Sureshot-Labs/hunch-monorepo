import assert from "node:assert/strict";
import { test } from "node:test";
import {
  advanceHip4FillRepair,
  HIP4_FILL_PAGE_MAX,
  planHip4FillRepair,
  planHip4LedgerRepair,
  advanceHip4LedgerRepair,
} from "./services/hip4-account-history.js";
import { hip4AccountPolicySchema } from "./services/hip4-account-policy.js";
import {
  proveHip4FillTailCoverage,
  hip4FillCoveredThrough,
} from "./services/hip4-tail-history.js";

const now = 1_800_000;
const lookback = 600_000;
const at = new Date(now).toISOString();
const plan = () => planHip4FillRepair(undefined, lookback, now, 32);
const rows = (time: number, count: number) =>
  Array.from({ length: count }, (_, tid) => ({ time, tid, coin: "@107" }));

const tailFill = {
  coin: "#87750",
  px: "0.4",
  sz: "2",
  side: "B",
  time: 1500,
  startPosition: "0",
  dir: "Buy",
  closedPnl: "0",
  hash: `0x${"1".repeat(64)}`,
  oid: 1,
  tid: 1,
  crossed: true,
  fee: "0.01",
  feeToken: "USDC",
};
function tailFixture() {
  const repair = advanceHip4FillRepair(
    planHip4FillRepair(undefined, 1000, 2000, 32),
    [],
    new Date(2000).toISOString(),
    32,
  );
  return {
    environment: "mainnet" as const,
    address: "0x0000000000000000000000000000000000000001",
    request: {
      environment: "mainnet" as const,
      address: "0x0000000000000000000000000000000000000001",
      startedAt: 4100,
    },
    snapshotTime: 4000,
    receivedAt: 5000,
    lookbackMs: 1000,
    previous: repair,
    page: [
      tailFill,
      { ...tailFill, coin: "BTC", px: "60000", time: 4500, tid: 2 },
    ],
  };
}

test("a complete mixed most-recent tail bridges only an existing proven range through this exact snapshot", () => {
  const input = tailFixture();
  const before = structuredClone(input.previous);
  const proof = proveHip4FillTailCoverage(input);
  assert.ok(proof);
  assert.equal(proof.coveredThrough, 4000);
  assert.equal(
    proof.newestFillTime,
    4500,
    "newer valid rows count but cannot advance the snapshot cutoff",
  );
  assert.equal(proof.returnedRows, 2);
  assert.deepEqual(
    input.previous,
    before,
    "the ByTime cursor and its source stay immutable",
  );
  assert.equal(
    hip4FillCoveredThrough({
      environment: input.environment,
      address: input.address,
      snapshotTime: input.snapshotTime,
      repair: input.previous,
      tail: proof,
    }),
    4000,
  );
  assert.ok(
    proveHip4FillTailCoverage({
      ...input,
      page: [{ ...tailFill, time: 2000 }],
    }),
    "uncapped boundary equality is inclusive",
  );
  assert.ok(
    proveHip4FillTailCoverage({
      ...input,
      page: [{ ...tailFill, coin: "BTC", px: "60000" }],
    }),
    "an unfiltered ordinary-asset suffix can prove no new HIP fills",
  );
});

test("empty, capped, invalid mixed, future, disconnected or differently scoped tails cannot prove coverage", () => {
  const input = tailFixture();
  for (const candidate of [
    { ...input, page: [] },
    {
      ...input,
      page: Array.from({ length: HIP4_FILL_PAGE_MAX }, () => tailFill),
    },
    { ...input, page: [tailFill, { coin: "BTC", time: 4500 }] },
    { ...input, page: [tailFill, { ...tailFill, coin: "BTC", px: "-1" }] },
    { ...input, page: [tailFill, { ...tailFill, coin: "BTC", time: 5001 }] },
    { ...input, page: [{ ...tailFill, time: 2001 }] },
    { ...input, page: [tailFill, { ...tailFill, px: "0.5" }] },
    { ...input, request: { ...input.request, startedAt: 3999 } },
    { ...input, receivedAt: 4099 },
    { ...input, lookbackMs: 999 },
    { ...input, previous: { ...input.previous, coveredFrom: null } },
    { ...input, previous: { ...input.previous, coveredThrough: null } },
    {
      ...input,
      request: {
        ...input.request,
        address: "0x0000000000000000000000000000000000000002",
      },
    },
    {
      ...input,
      request: { ...input.request, environment: "testnet" as const },
    },
  ])
    assert.equal(proveHip4FillTailCoverage(candidate), null);
});

test("tail composition rejects a new snapshot or reset epoch and never clears prior cursor gaps", () => {
  const input = tailFixture();
  const pending = {
    ...input.previous,
    nextTime: 1900,
    gaps: [{ time: 1600, reason: "timestamp_saturated" as const }],
    gapCount: 1,
  };
  const proof = proveHip4FillTailCoverage({ ...input, previous: pending });
  assert.ok(proof);
  const scope = {
    environment: input.environment,
    address: input.address,
    snapshotTime: input.snapshotTime,
    repair: pending,
    tail: proof,
  };
  for (const candidate of [
    { ...scope, snapshotTime: 4001 },
    { ...scope, address: "0x0000000000000000000000000000000000000002" },
    { ...scope, environment: "testnet" as const },
    { ...scope, repair: { ...pending, lookbackMs: 999 } },
    { ...scope, repair: { ...pending, coveredFrom: 1001 } },
    { ...scope, repair: { ...pending, coveredThrough: 1999 } },
    { ...scope, tail: { ...proof, source: "hyperliquid_user_fills_by_time" } },
  ])
    assert.equal(
      hip4FillCoveredThrough(candidate),
      candidate.repair.coveredThrough,
    );
  assert.equal(hip4FillCoveredThrough(scope), 4000);
  assert.equal(pending.nextTime, 1900);
  assert.deepEqual(pending.gaps, [
    { time: 1600, reason: "timestamp_saturated" },
  ]);
  assert.equal(pending.gapCount, 1);
});

test("ledger repair resumes inclusively with its own cap and independent durable cursor", () => {
  const initial = planHip4LedgerRepair(undefined, lookback, now, 32);
  const page = Array.from({ length: 500 }, () => ({
    time: now - 100,
    hash: "test",
    delta: { type: "unknown_future_event" },
  }));
  const next = advanceHip4LedgerRepair(initial, page, at, 32);
  assert.equal(next.nextTime, now - 100);
  assert.equal(next.source, "hyperliquid_non_funding_ledger");
  const resumed = planHip4LedgerRepair(next, lookback, now + 1, 32);
  assert.equal(resumed.endTime, now);
  assert.equal(resumed.nextTime, next.nextTime);
  assert.equal(advanceHip4LedgerRepair(resumed, [], at, 32).nextTime, null);
  assert.equal(planHip4FillRepair(next, lookback, now, 32).cursorResetCount, 1);
  const saturated = advanceHip4LedgerRepair(
    initial,
    page.map((row) => ({ ...row, time: initial.startTime })),
    at,
    32,
  );
  assert.equal(saturated.gapCount, 1);
  assert.equal(saturated.nextTime, initial.startTime + 1);
  assert.throws(() =>
    advanceHip4LedgerRepair(initial, [{ time: now + 1 }], at, 32),
  );
});

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
  assert.equal(finished.coveredFrom, plan().startTime);
  assert.equal(finished.coveredThrough, now);
  const extended = planHip4FillRepair(finished, lookback, now + 60000, 32);
  assert.equal(extended.nextTime, now);
  assert.equal(extended.endTime, now + 60000);
  assert.equal(extended.lastSuccessAt, at);
  const extendedComplete = advanceHip4FillRepair(
    extended,
    [],
    new Date(now + 60000).toISOString(),
    32,
  );
  assert.equal(extendedComplete.coveredFrom, plan().startTime);
  assert.equal(extendedComplete.coveredThrough, now + 60000);
  const legacy = { ...finished, coveredFrom: null, coveredThrough: null };
  assert.equal(
    planHip4FillRepair(legacy, lookback, now, 32).nextTime,
    now - lookback,
  );
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
