#!/usr/bin/env tsx

import assert from "node:assert/strict";
import type { Pool } from "pg";

import {
  flushUnifiedBookTopLatestTouches,
  getUnifiedBookTopWriteStats,
  resetUnifiedBookTopWriteStateForTests,
  writeUnifiedBookTop,
} from "@hunch/db";
import { createTopTickGate } from "@hunch/infra";

async function test(
  name: string,
  run: () => void | Promise<void>,
): Promise<void> {
  try {
    await run();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

await test("unchanged one-second ticks only queue one bulk latest touch", async () => {
  const queries: string[] = [];
  const pool = {
    query: async (sql: string) => {
      queries.push(sql);
      return { rows: [] };
    },
  } as unknown as Pool;
  resetUnifiedBookTopWriteStateForTests(pool);

  const startedAt = Date.parse("2026-07-17T12:00:00.000Z");
  await writeUnifiedBookTop(
    pool,
    "limitless:1",
    0.4,
    0.5,
    new Date(startedAt),
    { touchLatestWhenUnchanged: true },
  );
  for (let second = 1; second <= 60; second += 1) {
    await writeUnifiedBookTop(
      pool,
      "limitless:1",
      0.4,
      0.5,
      new Date(startedAt + second * 1000),
      { touchLatestWhenUnchanged: true },
    );
  }

  assert.equal(
    queries.filter((sql) => sql.includes("insert into unified_book_top"))
      .length,
    1,
  );
  assert.equal(queries.length, 2);
  assert.equal(await flushUnifiedBookTopLatestTouches(pool), 1);
  assert.equal(queries.length, 3);
  assert.equal(getUnifiedBookTopWriteStats().latestOnlyTouches, 1);
  resetUnifiedBookTopWriteStateForTests(pool);
});

await test("authoritative empty top clears latest and records no history loop", async () => {
  const queries: string[] = [];
  const pool = {
    query: async (sql: string) => {
      queries.push(sql);
      return { rows: [] };
    },
  } as unknown as Pool;
  resetUnifiedBookTopWriteStateForTests(pool);
  const now = new Date("2026-07-17T12:00:00.000Z");

  await writeUnifiedBookTop(pool, "limitless:2", 0.2, 0.3, now, {
    touchLatestWhenUnchanged: true,
  });
  await writeUnifiedBookTop(
    pool,
    "limitless:2",
    null,
    null,
    new Date(now.getTime() + 1_000),
    { touchLatestWhenUnchanged: true },
  );

  assert.equal(getUnifiedBookTopWriteStats().authoritativeClears, 1);
  assert.equal(
    queries.filter((sql) => sql.includes("insert into unified_book_top"))
      .length,
    2,
  );
  resetUnifiedBookTopWriteStateForTests(pool);
});

await test("an older heartbeat flush cannot regress a newer changed top", async () => {
  const queries: string[] = [];
  let releaseHeartbeat!: () => void;
  const heartbeatBlocked = new Promise<void>((resolve) => {
    releaseHeartbeat = resolve;
  });
  const pool = {
    query: async (sql: string) => {
      queries.push(sql);
      if (sql.includes("jsonb_to_recordset")) await heartbeatBlocked;
      return { rows: [] };
    },
  } as unknown as Pool;
  resetUnifiedBookTopWriteStateForTests(pool);
  const startedAt = Date.parse("2026-07-17T12:00:00.000Z");

  await writeUnifiedBookTop(
    pool,
    "limitless:race",
    0.4,
    0.5,
    new Date(startedAt),
    { touchLatestWhenUnchanged: true },
  );
  await writeUnifiedBookTop(
    pool,
    "limitless:race",
    0.4,
    0.5,
    new Date(startedAt + 1_000),
    { touchLatestWhenUnchanged: true },
  );

  const flush = flushUnifiedBookTopLatestTouches(pool);
  await Promise.resolve();
  await writeUnifiedBookTop(
    pool,
    "limitless:race",
    0.45,
    0.55,
    new Date(startedAt + 2_000),
    { touchLatestWhenUnchanged: true },
  );
  releaseHeartbeat();
  await flush;

  const queriesBeforeRepeat = queries.length;
  await writeUnifiedBookTop(
    pool,
    "limitless:race",
    0.45,
    0.55,
    new Date(startedAt + 3_000),
    { touchLatestWhenUnchanged: true },
  );
  assert.equal(queries.length, queriesBeforeRepeat);
  resetUnifiedBookTopWriteStateForTests(pool);
});

await test("top tick gate publishes authoritative empty transitions", () => {
  const gate = createTopTickGate({
    allowEmpty: true,
    heartbeatMs: 60_000,
    minIntervalMs: 0,
  });
  assert.equal(
    gate.shouldPublish({
      tokenId: "limitless:3",
      bestBid: 0.2,
      bestAsk: 0.3,
      tsMs: 1_000,
      nowMs: 1_000,
    }),
    true,
  );
  assert.equal(
    gate.shouldPublish({
      tokenId: "limitless:3",
      bestBid: null,
      bestAsk: null,
      tsMs: 2_000,
      nowMs: 2_000,
    }),
    true,
  );
});
