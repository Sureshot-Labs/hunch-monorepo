#!/usr/bin/env tsx

import assert from "node:assert/strict";

import type { Pool } from "@hunch/infra";
import { env } from "./env.js";
import { syncLimitlessHistoryForWallet } from "./services/limitless-history.js";

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

await test("syncLimitlessHistoryForWallet uses cursor pagination and delegated profile header", async () => {
  const originalFetch = globalThis.fetch;
  const originalBase = env.limitlessApiBase;
  const originalTokenId = env.limitlessHmacTokenId;
  const originalSecret = env.limitlessHmacSecret;

  let capturedUrl: string | null = null;
  let capturedOnBehalfOf: string | null = null;

  env.limitlessApiBase = "https://limitless.test";
  env.limitlessHmacTokenId = "token-id";
  env.limitlessHmacSecret = Buffer.from("secret").toString("base64");

  globalThis.fetch = (async (input, init) => {
    capturedUrl = String(input);
    const headers = new Headers(init?.headers);
    capturedOnBehalfOf = headers.get("x-on-behalf-of");
    return new Response(JSON.stringify({ data: [], nextCursor: "next-1" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const stats = await syncLimitlessHistoryForWallet({} as Pool, {
      userId: "user-1",
      walletAddress: "0x17cac6e4b08c8d95a2890a8df7cb0e7d83711387",
      authContext: {
        creds: {} as never,
        authMode: "partner_hmac",
        storedProfile: {
          id: 1297854,
          account: "0x17cac6e4b08c8d95a2890a8df7cb0e7d83711387",
        },
      },
      limit: 25,
      cursor: "abc",
    });

    assert.equal(
      capturedUrl,
      "https://limitless.test/portfolio/history?limit=25&cursor=abc",
    );
    assert.equal(capturedOnBehalfOf, "1297854");
    assert.equal(stats.fetched, 0);
    assert.equal(stats.nextCursor, "next-1");
  } finally {
    globalThis.fetch = originalFetch;
    env.limitlessApiBase = originalBase;
    env.limitlessHmacTokenId = originalTokenId;
    env.limitlessHmacSecret = originalSecret;
  }
});

await test("syncLimitlessHistoryForWallet updates canonical order instead of storing duplicate history order", async () => {
  const originalFetch = globalThis.fetch;
  const originalBase = env.limitlessApiBase;
  const originalTokenId = env.limitlessHmacTokenId;
  const originalSecret = env.limitlessHmacSecret;

  const queries: string[] = [];
  env.limitlessApiBase = "https://limitless.test";
  env.limitlessHmacTokenId = "token-id";
  env.limitlessHmacSecret = Buffer.from("secret").toString("base64");

  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        data: [
          {
            blockTimestamp: 1_799_323_200,
            clientOrderId: "hunch-client-1",
            marketId: "market-1",
            orderId: "venue-order-1",
            outcomeIndex: 0,
            strategy: "market buy",
            transactionHash:
              "0x1111111111111111111111111111111111111111111111111111111111111111",
          },
        ],
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    )) as typeof fetch;

  const pool = {
    query: async (sql: string) => {
      queries.push(sql);
      if (sql.includes("from unified_markets")) {
        return {
          rowCount: 1,
          rows: [
            {
              slug: "market-slug",
              token_no: "456",
              token_yes: "123",
              venue_market_id: "market-1",
            },
          ],
        };
      }
      if (sql.includes("from orders") && sql.includes("limit 2")) {
        return {
          rowCount: 1,
          rows: [
            {
              id: "canonical-order-1",
              position_delta_applied: true,
              posted_at: new Date("2027-01-08T00:00:00.000Z"),
              status: "filled",
              venue_order_id: "venue-order-1",
            },
          ],
        };
      }
      return { rowCount: 1, rows: [] };
    },
  } as unknown as Pool;

  try {
    const stats = await syncLimitlessHistoryForWallet(pool, {
      authContext: {
        authMode: "partner_hmac",
        creds: {} as never,
        storedProfile: null,
      },
      limit: 25,
      userId: "user-1",
      walletAddress: "0x17cac6e4b08c8d95a2890a8df7cb0e7d83711387",
    });

    assert.equal(stats.alreadyKnown, 1);
    assert.equal(stats.storedNew, 0);
    assert.ok(queries.some((sql) => /update orders/i.test(sql)));
    assert.ok(queries.some((sql) => /delete from orders/i.test(sql)));
    assert.equal(
      queries.some((sql) => /insert into orders/i.test(sql)),
      false,
    );
  } finally {
    globalThis.fetch = originalFetch;
    env.limitlessApiBase = originalBase;
    env.limitlessHmacTokenId = originalTokenId;
    env.limitlessHmacSecret = originalSecret;
  }
});
