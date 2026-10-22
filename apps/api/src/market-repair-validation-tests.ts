import assert from "node:assert/strict";
import {
  kalshiRepairPayloadError,
  lookupLimitlessRepairMarket,
  repairValidationState,
  summarizeRepairValidations,
} from "./lib/market-repair-validation.js";
import {
  runRepairSweep,
  type RepairCursor,
} from "./lib/market-repair-sweep.js";

assert.equal(
  kalshiRepairPayloadError({ ticker: "EVENT-A", status: "active" }, "EVENT-A"),
  null,
);
assert.equal(
  kalshiRepairPayloadError(
    { ticker: "EVENT-A", status: "finalized" },
    "EVENT-A",
  ),
  null,
);
assert.equal(
  kalshiRepairPayloadError({}, "EVENT-A"),
  "kalshi_public_identity_mismatch",
);
assert.equal(
  kalshiRepairPayloadError({ ticker: "EVENT-B", status: "active" }, "EVENT-A"),
  "kalshi_public_identity_mismatch",
);
for (const status of [undefined, null, "", "unknown_new_status"])
  assert.equal(
    kalshiRepairPayloadError({ ticker: "EVENT-A", status }, "EVENT-A"),
    "kalshi_public_invalid_status",
  );

for (const reason of ["gamma_active", "limitless_active", "dflow_active"])
  assert.equal(repairValidationState(null, reason), "verified");
for (const reason of ["gamma_not_found", "limitless_not_found"])
  assert.equal(repairValidationState(null, reason), "deferred");
for (const reason of [
  "gamma_error:timeout",
  "limitless_error:429",
  "limitless_identity_mismatch",
  "validation_missing",
])
  assert.equal(repairValidationState(null, reason), "error");
assert.equal(
  repairValidationState("SETTLED", "limitless_resolved"),
  "verified",
);

const candidate = { slug: "old-slug", venue_market_id: "123" };
const calls: string[] = [];
const unwrap = (value: unknown) => value as Record<string, unknown> | null;
const found = await lookupLimitlessRepairMarket(
  candidate,
  async (ref) => {
    calls.push(ref);
    return ref === "old-slug"
      ? { ok: false, status: 404, payload: {} }
      : { ok: true, status: 200, payload: { id: 123, status: "RESOLVED" } };
  },
  unwrap,
);
assert.equal(found.kind, "found");
assert.deepEqual(calls, ["old-slug", "123"]);
for (const status of [401, 429, 500]) {
  calls.length = 0;
  const result = await lookupLimitlessRepairMarket(
    candidate,
    async (ref) => {
      calls.push(ref);
      return { ok: false, status, payload: {} };
    },
    unwrap,
  );
  assert.equal(result.kind, "error");
  assert.deepEqual(calls, ["old-slug"]); // no amplification of an outage/rate limit
}
assert.deepEqual(
  await lookupLimitlessRepairMarket(
    candidate,
    async () => ({ ok: false, status: 404, payload: {} }),
    unwrap,
  ),
  { kind: "not_found" },
);
assert.deepEqual(
  await lookupLimitlessRepairMarket(
    candidate,
    async () => ({
      ok: true,
      status: 200,
      payload: { id: 999, expired: true },
    }),
    unwrap,
  ),
  { kind: "error", reason: "limitless_identity_mismatch" },
);
assert.deepEqual(
  await lookupLimitlessRepairMarket(
    candidate,
    async () => ({ ok: true, status: 200, payload: null }),
    unwrap,
  ),
  { kind: "error", reason: "limitless_invalid_payload" },
);
await assert.rejects(
  lookupLimitlessRepairMarket(
    candidate,
    async () => {
      throw Error("timeout");
    },
    unwrap,
  ),
  /timeout/,
);
calls.length = 0;
await lookupLimitlessRepairMarket(
  { slug: "123", venue_market_id: "123" },
  async (ref) => {
    calls.push(ref);
    return { ok: false, status: 404, payload: {} };
  },
  unwrap,
);
assert.deepEqual(calls, ["123"]);

// A page of missing legacy markets must not starve the next repairable page.
// Failed providers, in contrast, must leave the checkpoint for a retry.
const rows = ["deferred", "deferred", "verified"].map(
  (validation_state, index) => ({
    market_id: String(index),
    cursor_terminal_at: "2026-01-01 00:00:00+00",
    validation_state: validation_state as "deferred" | "verified",
  }),
);
let cursor: RepairCursor | null = null;
let repaired = 0;
const sweepOptions = {
  cursor: null,
  limit: 10,
  batchSize: 2,
  load: async (after: RepairCursor | null, limit: number) =>
    rows
      .filter((row) => !after || row.market_id > after.marketId)
      .slice(0, limit),
  process: async (batch: typeof rows) => {
    repaired += summarizeRepairValidations(batch).verified;
  },
  checkpoint: async (next: RepairCursor | null) => {
    cursor = next;
  },
};
assert.equal((await runRepairSweep(sweepOptions)).complete, true);
assert.equal(repaired, 1);
assert.equal(cursor, null);
assert.deepEqual(
  summarizeRepairValidations([
    { validation_state: "verified" },
    { validation_state: "deferred" },
    { validation_state: "error" },
  ]),
  { verified: 1, deferred: 1, errors: 1 },
);
console.log("market repair validation tests passed");
