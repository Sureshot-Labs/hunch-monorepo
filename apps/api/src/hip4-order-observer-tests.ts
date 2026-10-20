import assert from "node:assert/strict";
import { test } from "node:test";
import { hip4OrderFillRepairDue } from "./services/hip4-order-observer.js";
import { planHip4OrderFillRepair } from "./services/hip4-order-fill-repair.js";
import type { Pool, PoolClient } from "pg";
import {
  hip4OptionalObservationPool,
  waitHip4OptionalObservation,
} from "./services/hip4-optional-observation.js";

test("hot status polling does not repeat a costly fill page on every tick", () => {
  const now = Date.now();
  const repair = {
    ...planHip4OrderFillRepair(null, now - 1000, now, 32),
    lastAttemptAt: new Date(now).toISOString(),
  };
  assert.equal(hip4OrderFillRepairDue(repair, now + 5000, 15000), false);
  assert.equal(hip4OrderFillRepairDue(repair, now + 14999, 15000), false);
  assert.equal(hip4OrderFillRepairDue(repair, now + 15000, 15000), true);
  assert.equal(
    hip4OrderFillRepairDue(repair, now + 5000),
    true,
    "explicit owned repair bypasses the periodic housekeeping throttle",
  );
});

test("new, malformed, and backward-clock fill scheduling can recover", () => {
  const now = Date.now();
  const repair = {
    ...planHip4OrderFillRepair(null, now - 1000, now, 32),
    lastAttemptAt: new Date(now).toISOString(),
  };
  for (const previous of [null, {}, { lastAttemptAt: "bad" }])
    assert.equal(hip4OrderFillRepairDue(previous, now, 15000), true);
  assert.equal(hip4OrderFillRepairDue(repair, now - 1, 15000), true);
});

test("optional response races one handled observer promise without starting a retry", async () => {
  let finish: () => void = () => {};
  let completed = false;
  const observation = new Promise<void>((resolve) => {
    finish = resolve;
  }).then(() => {
    completed = true;
  });
  const started = Date.now();
  await waitHip4OptionalObservation(observation, started + 20);
  assert.equal(completed, false);
  assert.ok(Date.now() - started < 250);
  finish();
  await observation;
  assert.equal(completed, true);
  await waitHip4OptionalObservation(
    Promise.reject(new Error("optional failure")),
    Date.now() + 1000,
  );
});

test("expired optional work cannot acquire, and a late pooled connection is released without queries", async () => {
  let acquisitions = 0;
  let releases = 0;
  let queries = 0;
  let resolveConnection: (client: PoolClient) => void = () => {};
  const client = {
    release() {
      releases++;
    },
    async query() {
      queries++;
      return { rows: [], rowCount: 0 };
    },
  } as unknown as PoolClient;
  const pool = {
    connect() {
      acquisitions++;
      return new Promise<PoolClient>((resolve) => {
        resolveConnection = resolve;
      });
    },
  } as unknown as Pool;
  const expired = hip4OptionalObservationPool(pool, Date.now() - 1);
  await assert.rejects(expired.query("select 1"), /expired/u);
  assert.equal(acquisitions, 0);
  const bounded = hip4OptionalObservationPool(pool, Date.now() + 20);
  await assert.rejects(bounded.query("select 1"), /expired/u);
  assert.equal(acquisitions, 1);
  resolveConnection(client);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(releases, 1);
  assert.equal(queries, 0);
});
