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
