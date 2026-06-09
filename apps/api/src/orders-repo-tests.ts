#!/usr/bin/env tsx

import assert from "node:assert/strict";

import type { Pool } from "@hunch/infra";
import { markOrderPositionDeltaApplied } from "./repos/orders-repo.js";
import { fetchUnifiedOrders } from "./repos/unified-orders.js";

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

await test("fetchUnifiedOrders openOnly keeps delayed/unconfirmed FOK/FAK orders visible", async () => {
  const capturedSql: string[] = [];
  const pool = {
    query: async (sql: string) => {
      capturedSql.push(sql);
      if (/count\(\*\)/i.test(sql)) return { rows: [{ total: "0" }] };
      return { rows: [] };
    },
  } as unknown as Pool;

  await fetchUnifiedOrders(pool, {
    userId: "1844db1a-b1a0-4f93-b12c-5c5ea960687e",
    status: [
      "pending",
      "submitted",
      "live",
      "partially_filled",
      "delayed",
      "unconfirmed",
      "unmatched",
      "open",
    ],
    openOnly: true,
    type: "order",
    limit: 50,
    offset: 0,
  });

  const selectSql = capturedSql[0] ?? "";
  assert.match(
    selectSql,
    /lower\(coalesce\(o\.status, ''\)\) in \('pending', 'submitted', 'live', 'partially_filled', 'delayed', 'unconfirmed', 'open'\)/,
  );
  assert.match(
    selectSql,
    /not \(lower\(coalesce\(o\.venue, ''\)\) = 'limitless' and upper\(coalesce\(o\.order_type, ''\)\) = 'FOK'\)/,
  );
  assert.doesNotMatch(selectSql, /coalesce\(o\.order_type, ''\) not in/);
  assert.doesNotMatch(selectSql, /'unmatched'/);
  assert.doesNotMatch(selectSql, /'expired'/);
  assert.doesNotMatch(selectSql, /'rejected'/);
  assert.doesNotMatch(selectSql, /'cancelled'/);
});
