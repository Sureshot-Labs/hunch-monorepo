#!/usr/bin/env node

import assert from "node:assert/strict";

process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/test";
process.env.REDIS_URL ??= "redis://localhost:6379";

const {
  appendUniqueTickers,
  shouldBlockDflowNewMarketInsert,
  shouldSkipStaleDflowNewMarketInsert,
} = await import("./bootstrap.js");
const { clearDflowRuntimeModeLastKnownGood, resolveDflowRuntimeMode } =
  await import("./runtime-mode.js");

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

async function asyncTest(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

test("appendUniqueTickers preserves duration-first order and dedupes", () => {
  const out = ["duration-a", "duration-b"];

  appendUniqueTickers(out, ["duration-b", "hot-a", "hot-b"], 4);

  assert.deepEqual(out, ["duration-a", "duration-b", "hot-a", "hot-b"]);
});

test("appendUniqueTickers caps reserved websocket tickers", () => {
  const out: string[] = [];

  appendUniqueTickers(out, ["a", "b", "c"], 2);
  appendUniqueTickers(out, ["d"], 2);

  assert.deepEqual(out, ["a", "b"]);
});

test("stale dflow market policy only blocks new old kalshi inserts", () => {
  const dayMs = 24 * 60 * 60 * 1000;
  const nowMs = Date.UTC(2026, 5, 18);
  const existing = new Set(["kalshi:EXISTING"]);

  assert.equal(
    shouldSkipStaleDflowNewMarketInsert(
      {
        id: "kalshi:OLD",
        venue: "kalshi",
        close_time: new Date(nowMs - 91 * dayMs),
      },
      existing,
      nowMs,
    ),
    true,
  );
  assert.equal(
    shouldSkipStaleDflowNewMarketInsert(
      {
        id: "kalshi:EXISTING",
        venue: "kalshi",
        close_time: new Date(nowMs - 91 * dayMs),
      },
      existing,
      nowMs,
    ),
    false,
  );
  assert.equal(
    shouldSkipStaleDflowNewMarketInsert(
      {
        id: "kalshi:RECENT",
        venue: "kalshi",
        close_time: new Date(nowMs - 89 * dayMs),
      },
      existing,
      nowMs,
    ),
    false,
  );
  assert.equal(
    shouldSkipStaleDflowNewMarketInsert(
      {
        id: "polymarket:OLD",
        venue: "polymarket",
        close_time: new Date(nowMs - 91 * dayMs),
      },
      existing,
      nowMs,
    ),
    false,
  );
  assert.equal(
    shouldSkipStaleDflowNewMarketInsert(
      {
        id: "kalshi:EXPIRATION",
        venue: "kalshi",
        expiration_time: new Date(nowMs - 91 * dayMs),
      },
      existing,
      nowMs,
    ),
    true,
  );
});

test("maintenance no-new-market guard preserves only existing rows", () => {
  const existing = new Set(["kalshi:EXISTING"]);
  assert.equal(
    shouldBlockDflowNewMarketInsert("kalshi:NEW", existing, false),
    true,
  );
  assert.equal(
    shouldBlockDflowNewMarketInsert("kalshi:EXISTING", existing, false),
    false,
  );
  assert.equal(
    shouldBlockDflowNewMarketInsert("kalshi:NEW", existing, true),
    false,
  );
});

await asyncTest(
  "DFlow runtime mode honors env off and DB lifecycle",
  async () => {
    clearDflowRuntimeModeLastKnownGood();
    const db = {
      async query<T extends Record<string, unknown>>() {
        return {
          rows: [
            {
              id: "policy-1",
              policy_key: "venue_lifecycle",
              effective_at: new Date("2026-07-13T00:00:00.000Z"),
              payload: {
                version: 1,
                venues: {
                  polymarket: { lifecycle: "active", indexerMode: "full" },
                  limitless: { lifecycle: "active", indexerMode: "full" },
                  kalshi: { lifecycle: "exit-only", indexerMode: "off" },
                  hyperliquid: {
                    lifecycle: "unreleased",
                    indexerMode: "off",
                  },
                },
              },
              created_by: null,
              created_at: new Date("2026-07-13T00:00:00.000Z"),
            } as unknown as T,
          ],
        };
      },
    };

    const disabled = await resolveDflowRuntimeMode(db, {
      dflowEnabled: false,
    });
    assert.equal(disabled.mode, "off");
    assert.equal(disabled.source, "env_disabled");

    const resolved = await resolveDflowRuntimeMode(db, {
      dflowEnabled: true,
    });
    assert.equal(resolved.mode, "off");
    assert.equal(resolved.source, "db");
  },
);

await asyncTest("DFlow DB failure uses last-known-good", async () => {
  const failingDb = {
    async query<T extends Record<string, unknown>>(): Promise<{ rows: T[] }> {
      throw new Error("db unavailable");
    },
  };
  const resolved = await resolveDflowRuntimeMode(failingDb, {
    dflowEnabled: true,
  });
  assert.equal(resolved.mode, "off");
  assert.equal(resolved.source, "last_known_good");
});
