#!/usr/bin/env tsx

import assert from "node:assert/strict";

import type { DbQuery } from "./db.js";
import { insertNotification, fetchNotifications } from "./repos/notifications-repo.js";
import { buildOrderNotification } from "./services/notifications.js";

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

await test("order notifications replace by logical order id", async () => {
  const notification = buildOrderNotification({
    userId: "user-1",
    venue: "polymarket",
    status: "delayed",
    orderId: "0xabc",
  });

  assert.equal(notification.dedupeKey, "order:0xabc");
  assert.equal(notification.replaceExisting, true);
  assert.equal(notification.title, "Order delayed");
  assert.equal(notification.severity, "warning");
  assert.equal((notification.data as { status?: unknown }).status, "pending");
});

await test("replaceExisting notification upserts without downgrading terminal orders", async () => {
  let capturedSql = "";
  const db = {
    query: async (sql: string) => {
      capturedSql = sql;
      return { rows: [] };
    },
  } as unknown as DbQuery;

  await insertNotification(db, {
    userId: "user-1",
    type: "order_filled",
    title: "Order filled",
    body: "Polymarket order",
    dedupeKey: "order:0xabc",
    replaceExisting: true,
  });

  assert.match(capturedSql, /on conflict \(user_id, dedupe_key\) do update/i);
  assert.match(capturedSql, /read_at = null/i);
  assert.match(capturedSql, /jsonb_strip_nulls\(coalesce\(excluded\.data/);
  assert.match(
    capturedSql,
    /notifications\.type not in \('order_filled', 'order_cancelled', 'order_failed'\)/,
  );
});

await test("fetchNotifications hides stale order_created rows with terminal sibling", async () => {
  let capturedSql = "";
  const db = {
    query: async (sql: string) => {
      capturedSql = sql;
      return { rows: [] };
    },
  } as unknown as DbQuery;

  await fetchNotifications(db, {
    userId: "user-1",
    limit: 20,
  });

  assert.match(capturedSql, /n\.type = 'order_created'/);
  assert.match(capturedSql, /then 'Order delayed'/);
  assert.match(capturedSql, /jsonb_set\(coalesce\(n\.data/);
  assert.match(
    capturedSql,
    /terminal\.type in \('order_filled', 'order_cancelled', 'order_failed'\)/,
  );
  assert.match(
    capturedSql,
    /terminal\.data->>'orderId' = n\.data->>'orderId'/,
  );
  assert.match(
    capturedSql,
    /n\.type = 'order_filled'[\s\S]+n\.data->>'venue'[\s\S]+like 'history:%'/,
  );
});
