import assert from "node:assert/strict";
import test from "node:test";
import {
  getMapSearchFailureReason,
  mapSearchStatusFields,
  restoreMapSearchValues,
} from "./ai-map-search-result.js";

test("map search clears a previous 403 on subsequent status transitions", () => {
  for (const state of [
    "running",
    "completed",
    "skipped",
    "dry_run",
    "aborted",
  ]) {
    const hash = {
      state: "failed",
      error: "map_search_failed:hard_fail_http_403",
      callsExecuted: 44,
    };
    Object.assign(hash, mapSearchStatusFields({ state, reason: "ok" }));
    assert.equal(hash.state, state);
    assert.equal(hash.error, "");
    assert.equal(hash.callsExecuted, 44);
  }
});

test("map search preserves a current failure and normalizes null fields", () => {
  assert.deepEqual(
    mapSearchStatusFields({
      state: "failed",
      error: "current_403",
      mapRunId: null,
    }),
    { state: "failed", error: "current_403", mapRunId: "" },
  );
});

test("map search reports provider permission failures", () => {
  assert.equal(
    getMapSearchFailureReason({
      callsCompact: [{ statusCode: 403, budgetStop: "hard_fail_http_403" }],
    }),
    "hard_fail_http_403",
  );
});

test("map search does not treat a successful empty result as a failure", () => {
  assert.equal(
    getMapSearchFailureReason({
      callsCompact: [{ statusCode: 200, budgetStop: null }],
    }),
    null,
  );
});

test("map search preserves transport hard-failure reasons", () => {
  assert.equal(
    getMapSearchFailureReason({
      callsCompact: [{ statusCode: null, budgetStop: "hard_fail_transport" }],
    }),
    "hard_fail_transport",
  );
});

test("failed map search restores last-good values and removes new-only values", async () => {
  const calls: unknown[] = [];
  await restoreMapSearchValues({
    store: {
      async del(key) {
        calls.push(["del", key]);
      },
      async set(key, value, options) {
        calls.push(["set", key, value, options]);
      },
    },
    ttlSec: 60,
    values: [
      { key: "artifact", value: "last-good" },
      { key: "latest", value: null },
    ],
  });
  assert.deepEqual(calls, [
    ["set", "artifact", "last-good", { EX: 60 }],
    ["del", "latest"],
  ]);
});
