import assert from "node:assert/strict";
import { test } from "node:test";
import type { Pool } from "pg";
import { FundingReceiveSessionObserver } from "../../receive/receive-session-observer.js";
import { CLAIM_RECEIVE_CLASSIFICATION_RETRIES_SQL } from "../../persistence/funding-receive-session-repository.js";
import { READ_PENDING_RECEIVE_ANCHOR_SQL } from "../../persistence/funding-pending-receive-anchor.js";
import { RECEIVE_REFUND_CLEANUP_PAGE_SQL } from "../../receive/receive-refund-scan.js";

function fixture(
  clock: { value: number },
  options: { cleanupMs?: number; claimMs?: number } = {},
) {
  const logical = new Date("2026-10-16T00:00:00Z");
  const rows = [1, 2, 3].map((ordinal) => ({
    id: `00000000-0000-4000-a000-${String(ordinal).padStart(12, "0")}`,
    due: logical.getTime(),
    network_id: "evm:8453",
    asset_id: `0x${"12".repeat(20)}`,
    asset_decimals: 6,
    tx_hash: `0x${String(ordinal).repeat(64)}`,
    event_index: "0",
    ledger_height: "100",
    block_hash: `0x${"34".repeat(32)}`,
    raw_amount: "1000000",
    source_address: `0x${"56".repeat(20)}`,
    destination_address: `0x${"78".repeat(20)}`,
    observed_at: logical,
    classification_lease_token: "00000000-0000-4000-a000-000000000099",
    classification_receive_session_id: null,
    classification_variant_id: null,
  }));
  const calls: { sql: string; values: unknown[] }[] = [];
  const pool = {
    query: async (sql: string, values: unknown[]) => {
      calls.push({ sql, values });
      if (sql === RECEIVE_REFUND_CLEANUP_PAGE_SQL) {
        clock.value += options.cleanupMs ?? 0;
        return { rows: [] };
      }
      if (sql === CLAIM_RECEIVE_CLASSIFICATION_RETRIES_SQL) {
        assert.equal(values[1], 1, "never bulk-postpone untouched events");
        clock.value += options.claimMs ?? 0;
        const due = rows
          .filter((row) => row.due <= (values[0] as Date).getTime())
          .sort((a, b) => a.due - b.due || a.id.localeCompare(b.id))[0];
        if (!due) return { rows: [] };
        due.due = (values[2] as Date).getTime();
        return { rows: [{ ...due }] };
      }
      if (sql === READ_PENDING_RECEIVE_ANCHOR_SQL) {
        const row = rows.find((row) => row.id === values[0]);
        return {
          rows: row
            ? [
                {
                  ...row,
                  snapshot: JSON.stringify({
                    classification_lease_token: row.classification_lease_token,
                  }),
                },
              ]
            : [],
        };
      }
      assert.fail(`unexpected target/role/publication query: ${sql}`);
    },
  } as unknown as Pool;
  return { pool, calls, logical, rows };
}

test("rolling admission rotates slow deferred A/B/C without postponing untouched rows", async (t) => {
  const clock = { value: 10000 };
  t.mock.method(Date, "now", () => clock.value);
  const data = fixture(clock, { cleanupMs: 500 });
  const inspected: string[] = [];
  const observer = new FundingReceiveSessionObserver({
    inspectCanonicalAnchor: async ({ expected, deadlineMs }) => {
      assert.equal(
        deadlineMs,
        clock.value + 100,
        "cleanup does not consume the inspection window",
      );
      inspected.push(expected.transactionHash);
      clock.value += 100;
      return { kind: "deferred", reason: "fixture_timeout" };
    },
  });
  for (let ordinal = 0; ordinal < 3; ordinal++) {
    const result = await observer.pollKnownCanonicalRetryBatch(data.pool, {
      limit: 3,
      retryDelayMs: 100,
      now: data.logical,
    });
    assert.equal(result.eventsChecked, 1);
    assert.equal(result.anchorsDeferred, 1);
    assert.equal(result.retryableErrors, 0);
    assert.equal(
      data.rows.filter((row) => row.due === data.logical.getTime()).length,
      2 - ordinal,
    );
  }
  assert.deepEqual(
    inspected,
    data.rows.map((row) => row.tx_hash),
  );
  const noDue = await observer.pollKnownCanonicalRetryBatch(data.pool, {
    limit: 3,
    retryDelayMs: 100,
    now: data.logical,
  });
  assert.equal(noDue.eventsChecked, 0);
});

test("fast deferred proofs admit up to original limit, failures do not stop other due events", async (t) => {
  const clock = { value: 10000 };
  t.mock.method(Date, "now", () => clock.value);
  const data = fixture(clock);
  let inspections = 0;
  const observer = new FundingReceiveSessionObserver({
    inspectCanonicalAnchor: async () => {
      if (++inspections === 1) throw Error("fixture transport failure");
      return { kind: "deferred", reason: "fixture_missing" };
    },
  });
  const result = await observer.pollKnownCanonicalRetryBatch(data.pool, {
    limit: 2,
    retryDelayMs: 100,
    now: data.logical,
  });
  assert.equal(result.eventsChecked, 2);
  assert.equal(inspections, 2);
  assert.equal(result.retryableErrors, 1);
  assert.equal(result.anchorsDeferred, 1);
  assert.equal(data.rows[2].due, data.logical.getTime());
});

test("expired claim budget performs no extra reads or provider inspection", async (t) => {
  const clock = { value: 10000 };
  t.mock.method(Date, "now", () => clock.value);
  const data = fixture(clock, { claimMs: 100 });
  const observer = new FundingReceiveSessionObserver({
    inspectCanonicalAnchor: async () =>
      assert.fail("no provider call after deadline"),
  });
  const result = await observer.pollKnownCanonicalRetryBatch(data.pool, {
    limit: 3,
    retryDelayMs: 100,
    now: data.logical,
  });
  assert.equal(result.eventsChecked, 1);
  assert.equal(result.anchorsDeferred, 1);
  assert.equal(
    data.calls.some((call) => call.sql === READ_PENDING_RECEIVE_ANCHOR_SQL),
    false,
  );
});

test("invalid original budgets fail before cleanup or one-at-a-time admission", async () => {
  const data = fixture({ value: 0 });
  const observer = new FundingReceiveSessionObserver();
  for (const overrides of [
    { limit: 0 },
    { limit: 2.5 },
    { limit: 2147483648 },
    { limit: NaN },
    { retryDelayMs: 0 },
    { retryDelayMs: Infinity },
    { now: new Date(NaN) },
  ])
    await assert.rejects(
      observer.pollKnownCanonicalRetryBatch(data.pool, {
        limit: 3,
        retryDelayMs: 100,
        now: data.logical,
        ...overrides,
      }),
      /invalid canonical receive retry/,
    );
  assert.equal(data.calls.length, 0);
});
