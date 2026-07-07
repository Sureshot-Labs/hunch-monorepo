#!/usr/bin/env tsx

import assert from "node:assert/strict";

import type { Pool } from "@hunch/infra";
import {
  claimOrderPositionDeltaApplication,
  clearOrderPositionDeltaApplicationClaim,
  findLimitlessHistoryMatch,
  markOrderPositionDeltaApplied,
  storeOrder,
  updateOrderFromHistory,
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

await test("position delta application uses an atomic claim marker", async () => {
  const capturedSql: string[] = [];
  const pool = {
    query: async (sql: string) => {
      capturedSql.push(sql);
      return { rowCount: 1, rows: [{ id: "order-1" }] };
    },
  } as unknown as Pool;

  const claimed = await claimOrderPositionDeltaApplication(pool, {
    id: "order-1",
    claimId: "claim-1",
    claimedAt: new Date("2026-05-17T00:00:00.000Z"),
  });
  const cleared = await clearOrderPositionDeltaApplicationClaim(pool, {
    id: "order-1",
    claimId: "claim-1",
  });

  assert.equal(claimed, true);
  assert.equal(cleared, true);
  assert.match(capturedSql[0] ?? "", /_hunchPositionDeltaApplyClaimId/);
  assert.match(capturedSql[0] ?? "", /_hunchPositionDeltaAppliedAt/);
  assert.match(capturedSql[1] ?? "", /order_payload = order_payload/);
  assert.match(capturedSql[1] ?? "", /_hunchPositionDeltaApplyClaimId/);
  assert.doesNotMatch(capturedSql.join("\n"), /\blast_update\s*=/i);
});

await test("Limitless history matching detects nested position delta markers", async () => {
  let capturedSql = "";
  const pool = {
    query: async (sql: string) => {
      capturedSql = sql;
      return {
        rowCount: 1,
        rows: [
          {
            id: "order-1",
            venue_order_id: "venue-order-1",
            status: "filled",
            posted_at: new Date("2026-05-17T00:00:00.000Z"),
            position_delta_applied: true,
          },
        ],
      };
    },
  } as unknown as Pool;

  const match = await findLimitlessHistoryMatch(pool, {
    userId: "1844db1a-b1a0-4f93-b12c-5c5ea960687e",
    walletAddress: "0x0000000000000000000000000000000000000001",
    tokenId: "token-1",
    side: "BUY",
    orderType: "FOK",
    postedAt: new Date("2026-05-17T00:00:00.000Z"),
  });

  assert.equal(match?.positionDeltaApplied, true);
  assert.match(capturedSql, /order_payload->'submitted'/);
  assert.match(capturedSql, /order_payload->'payload'/);
  assert.match(capturedSql, /order_payload->'submitted'->'payload'/);
});

await test("updateOrderFromHistory preserves position marker when wrapping payload", async () => {
  let capturedSql = "";
  const pool = {
    query: async (sql: string) => {
      capturedSql = sql;
      return { rowCount: 1, rows: [] };
    },
  } as unknown as Pool;

  await updateOrderFromHistory(pool, {
    id: "order-1",
    status: "filled",
    price: 0.5,
    size: 10,
    filledAt: new Date("2026-05-17T00:00:00.000Z"),
    lastUpdate: new Date("2026-05-17T00:00:00.000Z"),
    orderHash: "hash",
    orderPayload: { id: "history-order-1" },
  });

  assert.match(capturedSql, /jsonb_build_object\('submitted'/);
  assert.match(capturedSql, /'_hunchPositionDeltaAppliedAt'/);
  assert.match(capturedSql, /order_payload->'submitted'->'payload'/);
});

await test("storeOrder reads nested position delta markers on existing orders", async () => {
  const client = {
    query: async (sql: string) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rows: [], rowCount: 0 };
      }
      if (/from orders/i.test(sql)) {
        return {
          rowCount: 1,
          rows: [
            {
              id: "order-1",
              wallet_address: "0x0000000000000000000000000000000000000001",
              signer_address: "0x0000000000000000000000000000000000000001",
              price: 0.5,
              size: 10,
              status: "filled",
              posted_at: new Date("2026-05-17T00:00:00.000Z"),
              order_payload: {
                submitted: {
                  _hunchPositionDeltaAppliedAt:
                    "2026-05-17T00:00:00.000Z",
                },
                history: {},
              },
              order_payload_version: null,
              fee_policy_snapshot: null,
            },
          ],
        };
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => {},
  };
  const pool = {
    connect: async () => client,
  } as unknown as Pool;

  const result = await storeOrder(pool, {
    userId: "1844db1a-b1a0-4f93-b12c-5c5ea960687e",
    walletAddress: "0x0000000000000000000000000000000000000001",
    signerAddress: "0x0000000000000000000000000000000000000001",
    venue: "limitless",
    venueOrderId: "venue-order-1",
    tokenId: "token-1",
    side: "BUY",
    orderType: "FOK",
    price: 0.5,
    size: 10,
    status: "filled",
    errorMessage: null,
    rawError: null,
  });

  assert.equal(result.kind, "exists");
  assert.equal(result.order.position_delta_applied, true);
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
