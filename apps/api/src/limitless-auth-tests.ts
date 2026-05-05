#!/usr/bin/env tsx

import assert from "node:assert/strict";

import { env } from "./env.js";
import {
  loadLimitlessProfileForWallet,
  verifyLimitlessAuthContext,
  type LimitlessAuthContext,
} from "./services/limitless-auth.js";

function test(name: string, fn: () => Promise<void>) {
  tests.push({ name, fn });
}

const tests: Array<{ name: string; fn: () => Promise<void> }> = [];

function buildAuthContext(
  profile: { id?: number; account?: string; client?: string } | null,
): LimitlessAuthContext {
  return {
    creds: {
      id: "cred-1",
      userId: "user-1",
      walletAddress: "0xd829f31579e3129a551c9ab3980efa8e5e041131",
      venue: "limitless",
      apiKey: "0xD829f31579e3129a551c9AB3980eFA8E5E041131",
      apiSecret: "",
      isActive: true,
      additionalData: profile
        ? { authMode: "partner_hmac", profile }
        : { authMode: "partner_hmac" },
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    authMode: "partner_hmac",
    storedProfile: profile,
  };
}

test("verifyLimitlessAuthContext rejects when partner HMAC is not configured", async () => {
  const originalTokenId = env.limitlessHmacTokenId;
  const originalSecret = env.limitlessHmacSecret;
  env.limitlessHmacTokenId = "";
  env.limitlessHmacSecret = "";

  try {
    const result = await verifyLimitlessAuthContext({
      authContext: buildAuthContext({
        id: 460208,
        account: "0xD829f31579e3129a551c9AB3980eFA8E5E041131",
        client: "eoa",
      }),
      walletAddress: "0xd829f31579e3129a551c9ab3980efa8e5e041131",
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 503);
    assert.equal(result.message, "Limitless is temporarily unavailable.");
  } finally {
    env.limitlessHmacTokenId = originalTokenId;
    env.limitlessHmacSecret = originalSecret;
  }
});

test("verifyLimitlessAuthContext rejects stored profiles bound to another wallet", async () => {
  const originalTokenId = env.limitlessHmacTokenId;
  const originalSecret = env.limitlessHmacSecret;
  env.limitlessHmacTokenId = "token-id";
  env.limitlessHmacSecret = "c2VjcmV0";

  try {
    const result = await verifyLimitlessAuthContext({
      authContext: buildAuthContext({
        id: 123,
        account: "0x1111111111111111111111111111111111111111",
        client: "eoa",
      }),
      walletAddress: "0xd829f31579e3129a551c9ab3980efa8e5e041131",
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 400);
    assert.equal(
      result.message,
      "Stored Limitless profile belongs to a different account.",
    );
  } finally {
    env.limitlessHmacTokenId = originalTokenId;
    env.limitlessHmacSecret = originalSecret;
  }
});

test("loadLimitlessProfileForWallet merges stored and base profile fields", async () => {
  const profile = await loadLimitlessProfileForWallet({
    walletAddress: "0xd829f31579e3129a551c9ab3980efa8e5e041131",
    authContext: { authMode: "partner_hmac" },
    additionalData: {
      authMode: "partner_hmac",
      profile: {
        account: "0xd829f31579e3129a551c9ab3980efa8e5e041131",
        client: "eoa",
      },
    },
    baseProfile: {
      id: 460208,
      rank: { feeRateBps: 300 },
    },
  });

  assert.equal(profile?.id, 460208);
  assert.equal(profile?.client, "eoa");
  assert.equal(profile?.rank?.feeRateBps, 300);
});

test("resolveLimitlessAuthContext does not upgrade legacy auth rows implicitly", async () => {
  const { resolveLimitlessAuthContext } =
    await import("./services/limitless-auth.js");
  const { AuthService } = await import("./auth.js");

  const originalGetVenueCredentials = AuthService.getVenueCredentials;
  AuthService.getVenueCredentials = async () =>
    ({
      id: "cred-legacy",
      userId: "user-1",
      walletAddress: "0xd829f31579e3129a551c9ab3980efa8e5e041131",
      venue: "limitless",
      apiKey: "legacy",
      apiSecret: "",
      isActive: true,
      additionalData: {
        authMode: "session",
        profile: {
          id: 460208,
          account: "0xD829f31579e3129a551c9AB3980eFA8E5E041131",
          client: "eoa",
        },
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    }) as Awaited<ReturnType<typeof AuthService.getVenueCredentials>>;

  try {
    const result = await resolveLimitlessAuthContext(
      "user-1",
      "0xd829f31579e3129a551c9ab3980efa8e5e041131",
    );
    assert.equal(result, null);
  } finally {
    AuthService.getVenueCredentials = originalGetVenueCredentials;
  }
});

for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}
