#!/usr/bin/env tsx

import assert from "node:assert/strict";

import type { DbQuery } from "./db.js";
import {
  insertNotification,
  fetchNotifications,
} from "./repos/notifications-repo.js";
import {
  buildOrderNotification,
  createNotificationSafe,
} from "./services/notifications.js";

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

  assert.equal(notification.dedupeKey, "order:polymarket:0xabc");
  assert.equal(notification.replaceExisting, true);
  assert.equal(notification.title, "Order delayed");
  assert.equal(notification.severity, "warning");
  assert.equal((notification.data as { status?: unknown }).status, "pending");
});

await test("order notification dedupe keys are venue scoped", async () => {
  const polymarketNotification = buildOrderNotification({
    userId: "user-1",
    venue: "polymarket",
    status: "delayed",
    orderId: "shared-order-id",
  });
  const limitlessNotification = buildOrderNotification({
    userId: "user-1",
    venue: "limitless",
    status: "delayed",
    orderId: "shared-order-id",
  });

  assert.equal(
    polymarketNotification.dedupeKey,
    "order:polymarket:shared-order-id",
  );
  assert.equal(
    limitlessNotification.dedupeKey,
    "order:limitless:shared-order-id",
  );
  assert.notEqual(
    polymarketNotification.dedupeKey,
    limitlessNotification.dedupeKey,
  );
});

await test("venue-scoped order notifications migrate legacy dedupe keys", async () => {
  const queries: string[] = [];
  const params: unknown[][] = [];
  const db = {
    query: async (sql: string, values?: unknown[]) => {
      queries.push(sql);
      params.push(values ?? []);
      return { rows: [] };
    },
  } as unknown as DbQuery;

  await insertNotification(db, {
    userId: "user-1",
    type: "order_filled",
    title: "Order filled",
    body: "Polymarket order",
    dedupeKey: "order:polymarket:0xabc",
    replaceExisting: true,
  });

  assert.equal(queries.length, 2);
  assert.match(queries[0] ?? "", /deleted_legacy_duplicate/);
  assert.match(queries[0] ?? "", /set dedupe_key = \$3/);
  assert.match(
    queries[0] ?? "",
    /lower\(coalesce\(data->>'venue', ''\)\) = lower\(\$4\)/,
  );
  assert.deepEqual(params[0], [
    "user-1",
    "order:0xabc",
    "order:polymarket:0xabc",
    "polymarket",
  ]);
  assert.match(
    queries[1] ?? "",
    /on conflict \(user_id, dedupe_key\) do update/i,
  );
});

await test("incomplete order filled notifications are not inserted", async () => {
  let queryCount = 0;
  const db = {
    query: async () => {
      queryCount += 1;
      return { rows: [] };
    },
  } as unknown as DbQuery;

  const result = await createNotificationSafe(db, {
    userId: "user-1",
    type: "order_filled",
    title: "Order filled",
    body: "Polymarket SELL @ null",
    severity: "success",
    data: {
      venue: "polymarket",
      side: "SELL",
      size: "0",
      price: "0.86",
      orderId: "0xabc",
    },
    dedupeKey: "order:0xabc",
    replaceExisting: true,
  });

  assert.equal(result, null);
  assert.equal(queryCount, 0);
});

await test("replaceExisting notification upserts without downgrading terminal orders", async () => {
  let capturedSql = "";
  const db = {
    query: async (sql: string) => {
      capturedSql = sql;
      return {
        rows: [
          {
            venue: "polymarket",
            venue_order_id: "0xabc",
          },
        ],
      };
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
  assert.match(capturedSql, /excluded\.type = 'order_filled'/);
  assert.doesNotMatch(
    capturedSql,
    /notifications\.type in \('order_cancelled', 'order_failed'\)[\s\S]+excluded\.type in \('order_cancelled', 'order_failed'\)/,
  );
  assert.doesNotMatch(
    capturedSql,
    /or excluded\.type in \('order_filled', 'order_cancelled', 'order_failed'\)/,
  );
});

await test("replaceExisting notification keeps order_filled as highest precedence", async () => {
  let capturedSql = "";
  const db = {
    query: async (sql: string) => {
      capturedSql = sql;
      return { rows: [] };
    },
  } as unknown as DbQuery;

  await insertNotification(db, {
    userId: "user-1",
    type: "order_failed",
    title: "Order not filled",
    body: "Polymarket order",
    dedupeKey: "order:0xabc",
    replaceExisting: true,
  });

  assert.match(capturedSql, /excluded\.type = 'order_filled'/);
  assert.doesNotMatch(
    capturedSql,
    /notifications\.type in \('order_cancelled', 'order_failed'\)[\s\S]+excluded\.type in \('order_cancelled', 'order_failed'\)/,
  );
});

await test("fetchNotifications hides stale order_created rows with terminal sibling", async () => {
  const capturedSql: string[] = [];
  const db = {
    query: async (sql: string) => {
      capturedSql.push(sql);
      if (capturedSql.length === 1) {
        return {
          rows: [
            {
              id: "notification-1",
              user_id: "user-1",
              type: "order_created",
              title: "Order delayed",
              body: "Polymarket order",
              severity: "warning",
              data: {
                venue: "polymarket",
                orderId: "0xabc",
                status: "pending",
              },
              read_at: null,
              created_at: new Date(),
              updated_at: new Date(),
            },
          ],
        };
      }
      return {
        rows: [
          {
            venue: "polymarket",
            venue_order_id: "0xabc",
          },
        ],
      };
    },
  } as unknown as DbQuery;

  const result = await fetchNotifications(db, {
    userId: "user-1",
    limit: 20,
  });

  const listSql = capturedSql[0] ?? "";
  const terminalStatusSql = capturedSql[1] ?? "";

  assert.match(listSql, /n\.type = 'order_created'/);
  assert.match(listSql, /then 'Order delayed'/);
  assert.match(listSql, /jsonb_set\(coalesce\(n\.data/);
  assert.match(
    listSql,
    /terminal\.type in \('order_filled', 'order_cancelled', 'order_failed'\)/,
  );
  assert.match(terminalStatusSql, /'unmatched'/);
  assert.equal(result.rows.length, 0);
  assert.match(listSql, /terminal\.data->>'orderId' = n\.data->>'orderId'/);
  assert.match(
    listSql,
    /n\.type = 'order_filled'[\s\S]+n\.data->>'venue'[\s\S]+like 'history:%'/,
  );
});
