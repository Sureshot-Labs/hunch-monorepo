#!/usr/bin/env tsx

import assert from "node:assert/strict";

import {
  loadLimitlessProfileForWallet,
  validateLimitlessApiKeyForWallet,
  verifyLimitlessAuthContext,
  type LimitlessAuthContext,
} from "./services/limitless-auth.js";

function test(name: string, fn: () => Promise<void>) {
  tests.push({ name, fn });
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

const tests: Array<{ name: string; fn: () => Promise<void> }> = [];

test("validateLimitlessApiKeyForWallet normalizes wallet casing before lookup", async () => {
  const requests: string[] = [];
  globalThis.fetch = async (input) => {
    requests.push(String(input));
    return jsonResponse({
      id: 460208,
      account: "0xD829f31579e3129a551c9AB3980eFA8E5E041131",
      client: "eoa",
    });
  };

  const result = await validateLimitlessApiKeyForWallet({
    apiKey: "lmts_test_key",
    walletAddress: "0xd829f31579e3129a551c9ab3980efa8e5e041131",
  });

  assert.equal(result.ok, true);
  assert.equal(
    requests[0],
    "https://api.limitless.exchange/profiles/0xD829f31579e3129a551c9AB3980eFA8E5E041131",
  );
});

test("verifyLimitlessAuthContext rejects api keys bound to another wallet", async () => {
  globalThis.fetch = async () =>
    jsonResponse({
      id: 123,
      account: "0x1111111111111111111111111111111111111111",
      client: "eoa",
    });

  const authContext: LimitlessAuthContext = {
    creds: {
      id: "cred-1",
      userId: "user-1",
      walletAddress: "0xd829f31579e3129a551c9ab3980efa8e5e041131",
      venue: "limitless",
      apiKey: "0xd829f31579e3129a551c9ab3980efa8e5e041131",
      apiSecret: "lmts_test_key",
      isActive: true,
      additionalData: { authMode: "api_key" },
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    authMode: "api_key",
    apiKey: "lmts_test_key",
    storedProfile: null,
  };

  const result = await verifyLimitlessAuthContext({
    authContext,
    walletAddress: "0xd829f31579e3129a551c9ab3980efa8e5e041131",
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.status, 400);
  assert.equal(
    result.message,
    "Limitless API key belongs to a different account.",
  );
});

test("loadLimitlessProfileForWallet merges stored and live profile fields", async () => {
  globalThis.fetch = async () =>
    jsonResponse({
      id: 460208,
      account: "0xD829f31579e3129a551c9AB3980eFA8E5E041131",
      rank: { feeRateBps: 300 },
    });

  const profile = await loadLimitlessProfileForWallet({
    walletAddress: "0xd829f31579e3129a551c9ab3980efa8e5e041131",
    authContext: {
      authMode: "api_key",
      apiKey: "lmts_test_key",
    },
    additionalData: {
      authMode: "api_key",
      profile: {
        account: "0xd829f31579e3129a551c9ab3980efa8e5e041131",
        client: "eoa",
      },
    },
  });

  assert.equal(profile?.id, 460208);
  assert.equal(profile?.client, "eoa");
  assert.equal(profile?.rank?.feeRateBps, 300);
});

const originalFetch = globalThis.fetch;

try {
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`ok - ${name}`);
    } catch (error) {
      console.error(`not ok - ${name}`);
      throw error;
    }
  }
} finally {
  globalThis.fetch = originalFetch;
}
