import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_HIP4_READ_POLICY } from "@hunch/shared";
import { createHip4ReadSchedule } from "./services/hip4-read-scheduling.js";

const policy = { ...DEFAULT_HIP4_READ_POLICY, pollMs: 60_000 };

test("HIP catalog refresh uses a start deadline while heavy repairs keep their own cadence", () => {
  const schedule = createHip4ReadSchedule();
  assert.deepEqual(schedule.start(policy, 0), { repair: true });
  schedule.complete(0, true);
  assert.equal(schedule.waitMs(policy, 8_000), 22_000);
  assert.deepEqual(schedule.start(policy, 30_000), { repair: false });
  schedule.complete(30_000, false);
  assert.equal(schedule.waitMs(policy, 38_000), 22_000);
  assert.deepEqual(schedule.start(policy, 60_000), { repair: true });
});

test("a denied metadata budget recovers at the bounded minimum without deferring repair", () => {
  const schedule = createHip4ReadSchedule();
  assert.equal(schedule.start(policy, 0).repair, true);
  schedule.complete(0, false, true);
  assert.equal(schedule.waitMs(policy, 100), 9_900);
  assert.equal(schedule.start(policy, 10_000).repair, true);
  schedule.complete(10_000, true);
  assert.equal(schedule.waitMs(policy, 10_100), 29_900);
  assert.equal(schedule.start(policy, 40_000).repair, false);
  assert.equal(schedule.start(policy, 70_000).repair, true);
});

test("rolling admission jitter cannot defer a denied pair to the expiry boundary", () => {
  const schedule = createHip4ReadSchedule();
  schedule.start(policy, 0);
  schedule.complete(0, true);
  schedule.start(policy, 30_000);
  schedule.complete(30_000, false);
  schedule.start(policy, 60_000);
  // Earlier admissions at 100ms and 30,050ms still overlap the 60s window.
  schedule.complete(60_000, false, true);
  assert.equal(schedule.waitMs(policy, 60_001), 9_999);
  schedule.start(policy, 70_000);
  schedule.complete(70_000, true);
  assert.equal(schedule.waitMs(policy, 70_001), 29_999);
});

test("slow publication skips missed slots without another full interval or catch-up storm", () => {
  const schedule = createHip4ReadSchedule();
  schedule.start(policy, 0);
  schedule.complete(0, true);
  assert.equal(schedule.waitMs(policy, 45_000), 0);
  assert.deepEqual(schedule.start(policy, 45_000), { repair: false });
  assert.equal(schedule.waitMs(policy, 46_000), 29_000);
  assert.equal(schedule.start(policy, 75_000).repair, true);
});

test("policy repairs affect the next deadline and maintenance retains its normal poll", () => {
  const schedule = createHip4ReadSchedule();
  schedule.start(policy, 0);
  assert.equal(schedule.waitMs(policy, 8_000, true), 52_000);
  assert.equal(
    schedule.waitMs({ ...policy, bookMaxAgeMs: 40_000 }, 8_000),
    12_000,
  );
  assert.equal(
    schedule.waitMs({ ...policy, minRefreshMs: 45_000 }, 8_000),
    37_000,
  );
});
