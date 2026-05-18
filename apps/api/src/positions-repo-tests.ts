#!/usr/bin/env tsx

import assert from "node:assert/strict";
import crypto from "node:crypto";

import { pool } from "./db.js";
import { syncWalletPositionsFromTokenBalances } from "./repos/positions-repo.js";

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

function randomEmail(): string {
  return `positions-repo-${crypto.randomUUID()}@example.com`;
}

function randomEvmAddress(): string {
  return `0x${crypto.randomBytes(20).toString("hex")}`;
}

await test("position sync protection does not extend stale-balance grace forever", async () => {
  const walletAddress = randomEvmAddress();
  const tokenId = `limitless:${crypto.randomInt(1_000_000, 9_999_999)}`;
  const marketId = `limitless-test:${crypto.randomUUID()}`;
  const userInsert = await pool.query<{ id: string }>(
    `
      insert into users (email, is_active, is_verified)
      values ($1, true, true)
      returning id
    `,
    [randomEmail()],
  );
  const userId = userInsert.rows[0]?.id;
  assert.ok(userId);

  try {
    await pool.query(
      `
        insert into unified_tokens(token_id, venue, market_id, side)
        values ($1, 'limitless', $2, 'NO')
      `,
      [tokenId, marketId],
    );

    await pool.query(
      `
        insert into positions (
          user_id,
          wallet_address,
          venue,
          position_scope,
          token_id,
          side,
          size,
          average_price,
          unrealized_pnl,
          realized_pnl,
          last_updated_at,
          created_at,
          updated_at
        )
        values (
          $1,
          $2,
          'limitless',
          'own',
          $3,
          'LONG',
          1.0526,
          0.95,
          0,
          0,
          now(),
          now(),
          '2026-01-01T00:00:00.000Z'::timestamptz
        )
      `,
      [userId, walletAddress, tokenId],
    );

    await syncWalletPositionsFromTokenBalances(pool, {
      userId,
      walletAddress,
      venue: "limitless",
      tokenBalances: [{ tokenId, size: "0.0126" }],
      tokenIdLike: "limitless:%",
      protectRecentFlatsSec: 15,
    });

    const protectedRow = await pool.query<{
      size: string;
      updated_at: Date;
    }>(
      `
        select size::text, updated_at
        from positions
        where user_id = $1 and wallet_address = $2 and token_id = $3
      `,
      [userId, walletAddress, tokenId],
    );
    assert.equal(Number(protectedRow.rows[0]?.size), 1.0526);
    assert.equal(
      protectedRow.rows[0]?.updated_at.toISOString(),
      "2026-01-01T00:00:00.000Z",
    );

    await pool.query(
      `
        update positions
        set last_updated_at = now() - interval '20 seconds'
        where user_id = $1 and wallet_address = $2 and token_id = $3
      `,
      [userId, walletAddress, tokenId],
    );

    await syncWalletPositionsFromTokenBalances(pool, {
      userId,
      walletAddress,
      venue: "limitless",
      tokenBalances: [{ tokenId, size: "0.0126" }],
      tokenIdLike: "limitless:%",
      protectRecentFlatsSec: 15,
    });

    const correctedRow = await pool.query<{ size: string }>(
      `
        select size::text
        from positions
        where user_id = $1 and wallet_address = $2 and token_id = $3
      `,
      [userId, walletAddress, tokenId],
    );
    assert.equal(Number(correctedRow.rows[0]?.size), 0.0126);
  } finally {
    await pool.query("delete from positions where user_id = $1", [userId]);
    await pool.query("delete from unified_tokens where token_id = $1", [
      tokenId,
    ]);
    await pool.query("delete from users where id = $1", [userId]);
  }
});
