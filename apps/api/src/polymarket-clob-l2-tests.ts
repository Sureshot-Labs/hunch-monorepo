#!/usr/bin/env tsx

import assert from "node:assert/strict";
import test from "node:test";

import {
  extractSingleOrder,
  normalizeOpenOrder,
  polymarketL2Request,
  readCompletePolymarketOpenOrderPage,
} from "./services/polymarket-clob-l2.js";

const originalFetch = globalThis.fetch;
const credentials = {
  apiKey: "api-key",
  apiSecret: Buffer.from("test-secret").toString("base64"),
  apiPassphrase: "passphrase",
};

try {
  await test("sell preview distinguishes an empty complete page from incomplete or malformed locks", () => {
    const sell = {
      id: "sell",
      side: "SELL",
      asset_id: "123",
      maker_address: `0x${"a".repeat(40)}`,
      original_size: "10",
      size_matched: "1.25",
    };
    assert.deepEqual(
      readCompletePolymarketOpenOrderPage({ data: [], next_cursor: "LTE=" }),
      [],
    );
    assert.deepEqual(
      readCompletePolymarketOpenOrderPage({
        data: [sell],
        next_cursor: "LTE=",
      }),
      [sell],
    );
    assert.equal(
      readCompletePolymarketOpenOrderPage({
        data: [sell],
        next_cursor: "Mg==",
      }),
      null,
    );
    assert.equal(readCompletePolymarketOpenOrderPage({}), null);
    assert.equal(readCompletePolymarketOpenOrderPage([]), null);
    assert.equal(readCompletePolymarketOpenOrderPage({ data: [] }), null);
    for (const badSell of [
      { ...sell, type: "GCT" },
      { ...sell, size_matched: "10.000001" },
    ])
      assert.equal(
        readCompletePolymarketOpenOrderPage({
          data: [badSell],
          next_cursor: "LTE=",
        }),
        null,
      );
    assert.equal(
      readCompletePolymarketOpenOrderPage({
        data: [{ ...sell, original_size: "unknown" }],
      }),
      null,
    );
    assert.equal(
      readCompletePolymarketOpenOrderPage({
        data: [{ ...sell, maker_address: "unknown" }],
      }),
      null,
    );
  });

  await test("extractSingleOrder accepts raw order response", () => {
    const payload = {
      id: "0xabc",
      status: "matched",
      price: "0.2",
      side: "BUY",
      size_matched: "5",
    };

    assert.equal(extractSingleOrder(payload), payload);
  });

  await test("normalizeOpenOrder accepts camelCase fields", () => {
    const order = normalizeOpenOrder({
      orderId: "0xabc",
      status: "matched",
      price: "0.2",
      side: "BUY",
      sizeMatched: "5",
      associateTrades: [" trade-1 ", ""],
      assetId: "123",
      createdAt: "2026-05-28T16:00:00Z",
    });

    assert.ok(order);
    assert.equal(order.id, "0xabc");
    assert.equal(order.status, "matched");
    assert.equal(order.price, "0.2");
    assert.equal(order.side, "BUY");
    assert.equal(order.sizeMatched, "5");
    assert.deepEqual(order.associateTrades, ["trade-1"]);
    assert.equal(order.assetId, "123");
    assert.equal(order.createdAt, "2026-05-28T16:00:00Z");
  });

  await test("successful L2 requests do not block on a redundant time lookup", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (input) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ balance: "1000000" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const result = await polymarketL2Request({
      baseUrl: "https://clob.test",
      timeoutMs: 1_000,
      address: "0x0000000000000000000000000000000000000001",
      creds: credentials,
      method: "GET",
      requestPath: "/balance-allowance?asset_type=COLLATERAL",
    });

    assert.equal(result.ok, true);
    assert.deepEqual(urls, [
      "https://clob.test/balance-allowance?asset_type=COLLATERAL",
    ]);
  });

  await test("concurrent identical authenticated GETs share one upstream request", async () => {
    let fetchCalls = 0;
    let releaseFetch: ((response: Response) => void) | undefined;
    const pendingResponse = new Promise<Response>((resolve) => {
      releaseFetch = resolve;
    });
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return pendingResponse;
    }) as typeof fetch;

    const input = {
      baseUrl: "https://dedupe.test",
      timeoutMs: 1_000,
      address: "0x0000000000000000000000000000000000000001",
      creds: credentials,
      method: "GET" as const,
      requestPath: "/data/orders",
    };
    const first = polymarketL2Request(input);
    const second = polymarketL2Request(input);

    await Promise.resolve();
    assert.equal(fetchCalls, 1);
    releaseFetch?.(
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.deepEqual(firstResult, secondResult);
    assert.equal(firstResult.ok, true);
  });

  await test("a 401 retries once with authoritative remote time", async () => {
    const urls: string[] = [];
    const timestamps: string[] = [];
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith("/time")) {
        return new Response(JSON.stringify({ time: 2_000_000_000 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      const headers = new Headers(init?.headers);
      timestamps.push(headers.get("POLY_TIMESTAMP") ?? "");
      if (timestamps.length === 1) {
        return new Response(JSON.stringify({ error: "invalid timestamp" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ balance: "1000000" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const result = await polymarketL2Request({
      baseUrl: "https://clob.test",
      timeoutMs: 1_000,
      address: "0x0000000000000000000000000000000000000001",
      creds: credentials,
      method: "GET",
      requestPath: "/balance-allowance?asset_type=COLLATERAL",
    });

    assert.equal(result.ok, true);
    assert.deepEqual(urls, [
      "https://clob.test/balance-allowance?asset_type=COLLATERAL",
      "https://clob.test/time",
      "https://clob.test/balance-allowance?asset_type=COLLATERAL",
    ]);
    assert.equal(timestamps[1], "2000000000");

    const cachedResult = await polymarketL2Request({
      baseUrl: "https://clob.test",
      timeoutMs: 1_000,
      address: "0x0000000000000000000000000000000000000001",
      creds: credentials,
      method: "GET",
      requestPath: "/balance-allowance?asset_type=COLLATERAL",
    });

    assert.equal(cachedResult.ok, true);
    assert.equal(
      urls.filter((url) => url === "https://clob.test/time").length,
      1,
    );
    assert.equal(timestamps[2], "2000000000");
  });
} finally {
  globalThis.fetch = originalFetch;
}
