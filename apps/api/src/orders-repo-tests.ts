#!/usr/bin/env tsx

import assert from "node:assert/strict";

import type { Pool } from "@hunch/infra";
import {
  markOrderPositionDeltaApplied,
  storeOrder,
} from "./repos/orders-repo.js";
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

await test("fetchUnifiedOrders q filters by unified market metadata", async () => {
  const capturedSql: string[] = [];
  const capturedParams: unknown[][] = [];
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      capturedSql.push(sql);
      capturedParams.push(params ?? []);
      if (/count\(\*\)/i.test(sql)) return { rows: [{ total: "0" }] };
      return { rows: [] };
    },
  } as unknown as Pool;

  await fetchUnifiedOrders(pool, {
    userId: "1844db1a-b1a0-4f93-b12c-5c5ea960687e",
    q: "world cup",
    limit: 50,
    offset: 0,
  });

  const selectSql = capturedSql[0] ?? "";
  assert.match(selectSql, /from unified_markets search_market/);
  assert.match(selectSql, /left join unified_events search_event/);
  assert.match(selectSql, /search_market\.title/);
  assert.match(selectSql, /search_event\.title/);
  assert.equal(capturedParams[0]?.[1], "%world cup%");
});

await test("storeOrder lowercases EVM maker and signer storage without mutating raw payload", async () => {
  const payload = {
    maker: "0xAAbBcCdDEeFf0011223344556677889900aABbCc",
    signer: "0xBbCcDdEeFf0011223344556677889900AaBbCcDd",
  };
  const signerAddress = "0xCcDdEeFf0011223344556677889900AaBbCcDdEe";
  let insertParams: unknown[] | undefined;

  const client = {
    query: async (sql: string, params?: unknown[]) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rows: [], rowCount: 0 };
      }
      if (/insert into orders/i.test(sql)) {
        insertParams = params;
        return {
          rows: [
            {
              id: "order-1",
              venue_order_id: "venue-order-1",
              status: "submitted",
              posted_at: new Date("2026-06-20T00:00:00.000Z"),
            },
          ],
          rowCount: 1,
        };
      }
      if (/from orders/i.test(sql)) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => {},
  };
  const pool = {
    connect: async () => client,
  } as unknown as Pool;

  await storeOrder(pool, {
    userId: "1844db1a-b1a0-4f93-b12c-5c5ea960687e",
    walletAddress: payload.maker.toLowerCase(),
    signerAddress,
    venue: "polymarket",
    venueOrderId: "venue-order-1",
    tokenId: "token-1",
    side: "BUY",
    orderType: "GTC",
    price: 0.42,
    size: 10,
    status: "submitted",
    errorMessage: null,
    rawError: null,
    orderPayload: payload,
  });

  assert.ok(insertParams);
  assert.equal(insertParams[1], payload.maker.toLowerCase());
  assert.equal(insertParams[2], signerAddress.toLowerCase());
  assert.equal(insertParams[13], payload);
  assert.equal(payload.maker, "0xAAbBcCdDEeFf0011223344556677889900aABbCc");
  assert.equal(payload.signer, "0xBbCcDdEeFf0011223344556677889900AaBbCcDd");
});
