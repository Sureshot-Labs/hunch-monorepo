import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import type { Pool } from "@hunch/infra";
import { runStandaloneReconciliationBatch } from "../../worker/standalone-reconciliation-worker.js";

test("standalone recovery bounds underlying reads after a timeout", async () => {
  let claims = 0;
  let releases = 0;
  let calls = 0;
  let settle: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const db = {
    query: async (sql: string) => {
      if (sql.includes("information_schema.columns"))
        return { rows: [{ ready: true }] };
      if (sql.includes("with candidate_rows")) {
        claims += 1;
        return {
          rows: [
            { id: "one", user_id: "user" },
            { id: "two", user_id: "user" },
          ],
        };
      }
      releases += 1;
      return { rows: [], rowCount: 1 };
    },
  } as unknown as Pick<Pool, "query">;
  const reconcile = async () => {
    calls += 1;
    await pending;
  };
  try {
    const result = await runStandaloneReconciliationBatch(
      db,
      {
        preparation: reconcile,
        positionAction: reconcile,
      },
      { itemTimeoutMs: 1, limit: 2 },
    );
    assert.equal(result.claimed, 4);
    assert.equal(result.timedOut, 2);
    assert.equal(
      calls,
      2,
      "no additional reads start after the first timeout in each journal",
    );
    assert.equal(
      releases,
      0,
      "timeout cannot release a lease whose evidence read is alive",
    );
    const overlapping = await runStandaloneReconciliationBatch(
      db,
      {
        preparation: reconcile,
        positionAction: reconcile,
      },
      { itemTimeoutMs: 1 },
    );
    assert.equal(overlapping.claimed, 0);
    assert.equal(
      claims,
      2,
      "a later batch must not claim more work for an occupied journal",
    );
  } finally {
    settle?.();
    await setImmediate();
  }
  assert.equal(releases, 2);
  assert.equal(calls, 2);
  const resumed = await runStandaloneReconciliationBatch(db, {
    preparation: async () => {},
    positionAction: async () => {},
  });
  assert.equal(
    resumed.reconciled,
    4,
    "both journals resume after late settlement",
  );
});

test("standalone recovery is a no-op before its additive migration", async () => {
  const db = {
    query: async () => ({ rows: [{ ready: false }] }),
  } as unknown as Pick<Pool, "query">;
  const unexpected = async () => {
    throw new Error("reconciliation must not start");
  };
  assert.deepEqual(
    await runStandaloneReconciliationBatch(db, {
      preparation: unexpected,
      positionAction: unexpected,
    }),
    {
      claimed: 0,
      reconciled: 0,
      retryableErrors: 0,
      timedOut: 0,
      skipped: "schema_not_ready",
    },
  );
});
