#!/usr/bin/env tsx

import assert from "node:assert/strict";

import type { Pool } from "@hunch/infra";
import { markOrderPositionDeltaApplied } from "./repos/orders-repo.js";

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

await test("markOrderPositionDeltaApplied does not mutate order freshness", async () => {
  let capturedSql = "";
  const pool = {
    query: async (sql: string) => {
      capturedSql = sql;
      return { rowCount: 1, rows: [] };
    },
  } as unknown as Pool;

  await markOrderPositionDeltaApplied(pool, {
    id: "order-1",
    appliedAt: new Date("2026-05-17T00:00:00.000Z"),
  });

  assert.match(capturedSql, /_hunchPositionDeltaAppliedAt/);
  assert.doesNotMatch(capturedSql, /\blast_update\s*=/i);
});
