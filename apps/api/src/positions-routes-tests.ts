#!/usr/bin/env tsx

import assert from "node:assert/strict";
import crypto from "node:crypto";

import { AuthService } from "./auth.js";
import { buildApp } from "./app.js";
import { pool } from "./db.js";
import { derivePolymarketFunderAddresses } from "./services/polymarket-funder.js";

type TestContext = {
  userId: string;
  authHeaders: Record<string, string>;
  signerWallet: string;
  funderWallet: string;
};

type CreateTestContextOptions = {
  signerWallet?: string;
  funderWallet?: string;
  persistFunderAddress?: boolean;
};

function randomEmail(): string {
  return `positions-routes-${crypto.randomUUID()}@example.com`;
}

function randomEvmAddress(): string {
  return `0x${crypto.randomBytes(20).toString("hex")}`;
}

async function createTestContext(
  options: CreateTestContextOptions = {},
): Promise<TestContext> {
  const signerWallet = options.signerWallet ?? randomEvmAddress();
  const funderWallet = options.funderWallet ?? randomEvmAddress();

  const insert = await pool.query<{ id: string }>(
    `
      insert into users (email, is_active, is_verified)
      values ($1, true, true)
      returning id
    `,
    [randomEmail()],
  );
  const userId = insert.rows[0]?.id;
  assert.ok(userId);

  await pool.query(
    `
      insert into user_wallets (
        user_id,
        wallet_address,
        wallet_type,
        is_primary,
        is_verified
      )
      values ($1, $2, 'ethereum', true, true)
    `,
    [userId, signerWallet],
  );

  await AuthService.createOrUpdateVenueCredentials(
    userId,
    signerWallet,
    "polymarket",
    `test-key-${crypto.randomUUID()}`,
    `test-secret-${crypto.randomUUID()}`,
    options.persistFunderAddress === false ? undefined : { funderAddress: funderWallet },
  );

  const token = AuthService.generateToken(userId);
  const userAgent = "positions-routes-tests";
  const session = await AuthService.createSession(
    userId,
    signerWallet,
    token,
    "127.0.0.1",
    userAgent,
  );

  return {
    userId,
    signerWallet,
    funderWallet,
    authHeaders: {
      authorization: `Bearer ${token}`,
      "user-agent": userAgent,
      "x-csrf-token": session.csrfToken,
    },
  };
}

async function cleanup(context: TestContext): Promise<void> {
  await pool.query("delete from user_sessions where user_id = $1", [context.userId]);
  await pool.query("delete from user_venue_credentials where user_id = $1", [
    context.userId,
  ]);
  await pool.query("delete from user_wallets where user_id = $1", [context.userId]);
  await pool.query("delete from users where id = $1", [context.userId]);
}

async function main() {
  const app = await buildApp();
  const persistedContext = await createTestContext();
  const derivedSignerWallet = randomEvmAddress();
  const derivedSafeWalletResult = derivePolymarketFunderAddresses({
    signer: derivedSignerWallet,
    includeMagicProxy: true,
  }).safeProxy;
  assert.ok(derivedSafeWalletResult);
  const derivedSafeWallet = derivedSafeWalletResult;
  const derivedContext = await createTestContext({
    signerWallet: derivedSignerWallet,
    funderWallet: derivedSafeWallet,
    persistFunderAddress: false,
  });

  try {
    const persistedResponse = await app.inject({
      method: "GET",
      url:
        `/positions/by-token?tokenIds=123&venue=polymarket&wallets=${encodeURIComponent(
          persistedContext.funderWallet,
        )}&minSize=0.01`,
      headers: persistedContext.authHeaders,
    });

    assert.equal(persistedResponse.statusCode, 200);
    assert.deepEqual(persistedResponse.json(), {
      positions: [],
      venue: "polymarket",
    });

    const derivedResponse = await app.inject({
      method: "GET",
      url:
        `/positions/by-token?tokenIds=123&venue=polymarket&wallets=${encodeURIComponent(
          derivedContext.funderWallet,
        )}&minSize=0.01`,
      headers: derivedContext.authHeaders,
    });

    assert.equal(derivedResponse.statusCode, 200);
    assert.deepEqual(derivedResponse.json(), {
      positions: [],
      venue: "polymarket",
    });
  } finally {
    await cleanup(persistedContext);
    await cleanup(derivedContext);
    await app.close();
  }
}

await main();
