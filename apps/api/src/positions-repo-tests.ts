#!/usr/bin/env tsx

import assert from "node:assert/strict";
import crypto from "node:crypto";

import { pool } from "./db.js";
import {
  fetchPositionsForUserWallet,
  syncWalletPositionsFromTokenBalances,
  updatePositionMetrics,
} from "./repos/positions-repo.js";
import { reconcileExactPositionBalance } from "./services/positions-optimistic.js";

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

async function createTestUser(): Promise<string> {
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
  return userId;
}

async function cleanupPositionTest(userId: string, tokenIds: string[]) {
  await pool.query("delete from positions where user_id = $1", [userId]);
  await pool.query(
    "delete from unified_tokens where token_id = any($1::text[])",
    [tokenIds],
  );
  await pool.query("delete from users where id = $1", [userId]);
}

await test("position sync protection does not extend stale-balance grace forever", async () => {
  const walletAddress = randomEvmAddress();
  const tokenId = `limitless:${crypto.randomInt(1_000_000, 9_999_999)}`;
  const marketId = `limitless-test:${crypto.randomUUID()}`;
  const userId = await createTestUser();

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
    await cleanupPositionTest(userId, [tokenId]);
  }
});

await test("position lists sort by latest real position activity", async () => {
  const walletAddress = randomEvmAddress();
  const olderCreatedToken = `limitless:${crypto.randomInt(1_000_000, 9_999_999)}`;
  const newerCreatedToken = `limitless:${crypto.randomInt(1_000_000, 9_999_999)}`;
  const marketId = `limitless-test:${crypto.randomUUID()}`;
  const userId = await createTestUser();

  try {
    await pool.query(
      `
        insert into unified_tokens(token_id, venue, market_id, side)
        values
          ($1, 'limitless', $3, 'YES'),
          ($2, 'limitless', $3, 'NO')
      `,
      [olderCreatedToken, newerCreatedToken, marketId],
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
        values
          (
            $1,
            $2,
            'limitless',
            'own',
            $3,
            'LONG',
            1,
            0.5,
            0,
            0,
            '2026-01-02T00:00:00.000Z'::timestamptz,
            '2026-01-01T00:00:00.000Z'::timestamptz,
            now()
          ),
          (
            $1,
            $2,
            'limitless',
            'own',
            $4,
            'LONG',
            1,
            0.5,
            0,
            0,
            '2026-01-01T00:00:00.000Z'::timestamptz,
            '2026-01-03T00:00:00.000Z'::timestamptz,
            now()
          )
      `,
      [userId, walletAddress, olderCreatedToken, newerCreatedToken],
    );

    const positions = await fetchPositionsForUserWallet(pool, {
      userId,
      walletAddresses: [walletAddress],
      venue: "limitless",
      includeHidden: true,
      minSize: 0,
    });

    assert.equal(positions.length, 2);
    assert.equal(positions[0]?.tokenId, olderCreatedToken);
    assert.equal(positions[1]?.tokenId, newerCreatedToken);
  } finally {
    await cleanupPositionTest(userId, [olderCreatedToken, newerCreatedToken]);
  }
});

await test("unchanged balance sync does not bump position activity time", async () => {
  const walletAddress = randomEvmAddress();
  const tokenId = `limitless:${crypto.randomInt(1_000_000, 9_999_999)}`;
  const marketId = `limitless-test:${crypto.randomUUID()}`;
  const userId = await createTestUser();
  const oldActivityTime = "2026-01-01T00:00:00.000Z";

  try {
    await pool.query(
      `
        insert into unified_tokens(token_id, venue, market_id, side)
        values ($1, 'limitless', $2, 'YES')
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
          1.23,
          0.6,
          0,
          0,
          $4::timestamptz,
          now(),
          now()
        )
      `,
      [userId, walletAddress, tokenId, oldActivityTime],
    );

    await syncWalletPositionsFromTokenBalances(pool, {
      userId,
      walletAddress,
      venue: "limitless",
      tokenBalances: [{ tokenId, size: "1.23", averagePrice: "0.6" }],
      tokenIdLike: "limitless:%",
    });

    const row = await pool.query<{ last_updated_at: Date }>(
      `
        select last_updated_at
        from positions
        where user_id = $1 and wallet_address = $2 and token_id = $3
      `,
      [userId, walletAddress, tokenId],
    );

    assert.equal(row.rows[0]?.last_updated_at.toISOString(), oldActivityTime);
  } finally {
    await cleanupPositionTest(userId, [tokenId]);
  }
});

await test("metrics refresh does not bump position activity time", async () => {
  const walletAddress = randomEvmAddress();
  const tokenId = `limitless:${crypto.randomInt(1_000_000, 9_999_999)}`;
  const marketId = `limitless-test:${crypto.randomUUID()}`;
  const userId = await createTestUser();
  const oldActivityTime = "2026-01-01T00:00:00.000Z";

  try {
    await pool.query(
      `
        insert into unified_tokens(token_id, venue, market_id, side)
        values ($1, 'limitless', $2, 'YES')
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
          1,
          0.5,
          0,
          0,
          $4::timestamptz,
          now(),
          now()
        )
      `,
      [userId, walletAddress, tokenId, oldActivityTime],
    );

    await updatePositionMetrics(pool, {
      userId,
      walletAddress,
      venue: "limitless",
      metrics: [
        {
          tokenId,
          averagePrice: 0.55,
          realizedPnl: 1.25,
          unrealizedPnl: 2.5,
        },
      ],
    });

    const row = await pool.query<{
      average_price: string;
      realized_pnl: string;
      unrealized_pnl: string;
      last_updated_at: Date;
    }>(
      `
        select
          average_price::text,
          realized_pnl::text,
          unrealized_pnl::text,
          last_updated_at
        from positions
        where user_id = $1 and wallet_address = $2 and token_id = $3
      `,
      [userId, walletAddress, tokenId],
    );

    assert.equal(Number(row.rows[0]?.average_price), 0.55);
    assert.equal(Number(row.rows[0]?.realized_pnl), 1.25);
    assert.equal(Number(row.rows[0]?.unrealized_pnl), 2.5);
    assert.equal(row.rows[0]?.last_updated_at.toISOString(), oldActivityTime);
  } finally {
    await cleanupPositionTest(userId, [tokenId]);
  }
});

await test("flatten and reopen bump position activity time", async () => {
  const walletAddress = randomEvmAddress();
  const tokenId = `limitless:${crypto.randomInt(1_000_000, 9_999_999)}`;
  const marketId = `limitless-test:${crypto.randomUUID()}`;
  const userId = await createTestUser();
  const oldActivityTime = "2026-01-01T00:00:00.000Z";

  try {
    await pool.query(
      `
        insert into unified_tokens(token_id, venue, market_id, side)
        values ($1, 'limitless', $2, 'YES')
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
          1,
          0.5,
          0,
          0,
          $4::timestamptz,
          now(),
          now()
        )
      `,
      [userId, walletAddress, tokenId, oldActivityTime],
    );

    await syncWalletPositionsFromTokenBalances(pool, {
      userId,
      walletAddress,
      venue: "limitless",
      tokenBalances: [],
      tokenIdLike: "limitless:%",
      flattenGraceSec: 0,
    });

    const flattenedRow = await pool.query<{
      side: string;
      size: string;
      last_updated_at: Date;
    }>(
      `
        select side, size::text, last_updated_at
        from positions
        where user_id = $1 and wallet_address = $2 and token_id = $3
      `,
      [userId, walletAddress, tokenId],
    );

    assert.equal(flattenedRow.rows[0]?.side, "FLAT");
    assert.equal(Number(flattenedRow.rows[0]?.size), 0);
    assert.ok(
      (flattenedRow.rows[0]?.last_updated_at.getTime() ?? 0) >
        new Date(oldActivityTime).getTime(),
    );

    await syncWalletPositionsFromTokenBalances(pool, {
      userId,
      walletAddress,
      venue: "limitless",
      tokenBalances: [{ tokenId, size: "1.5", averagePrice: "0.4" }],
      tokenIdLike: "limitless:%",
    });

    const reopenedRow = await pool.query<{
      side: string;
      size: string;
      last_updated_at: Date;
    }>(
      `
        select side, size::text, last_updated_at
        from positions
        where user_id = $1 and wallet_address = $2 and token_id = $3
      `,
      [userId, walletAddress, tokenId],
    );

    assert.equal(reopenedRow.rows[0]?.side, "LONG");
    assert.equal(Number(reopenedRow.rows[0]?.size), 1.5);
    assert.ok(
      (reopenedRow.rows[0]?.last_updated_at.getTime() ?? 0) >=
        (flattenedRow.rows[0]?.last_updated_at.getTime() ?? 0),
    );
  } finally {
    await cleanupPositionTest(userId, [tokenId]);
  }
});

await test("exact position reconciliation corrects duplicate optimistic AMM size", async () => {
  const walletAddress = randomEvmAddress();
  const tokenId = `limitless:${crypto.randomInt(1_000_000, 9_999_999)}`;
  const marketId = `limitless-test:${crypto.randomUUID()}`;
  const userId = await createTestUser();
  const oldActivityTime = "2026-01-01T00:00:00.000Z";

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
          9.0831,
          0.22,
          0,
          0,
          $4::timestamptz,
          now(),
          now()
        )
      `,
      [userId, walletAddress, tokenId, oldActivityTime],
    );

    const result = await reconcileExactPositionBalance(pool, {
      userId,
      walletAddress,
      venue: "limitless",
      tokenId,
      size: 4.5415,
      averagePrice: 0.22,
    });

    assert.equal(result.applied, true);

    const correctedRow = await pool.query<{
      side: string;
      size: string;
      average_price: string | null;
      last_updated_at: Date;
    }>(
      `
        select side, size::text, average_price::text, last_updated_at
        from positions
        where user_id = $1 and wallet_address = $2 and token_id = $3
      `,
      [userId, walletAddress, tokenId],
    );

    assert.equal(correctedRow.rows[0]?.side, "LONG");
    assert.equal(Number(correctedRow.rows[0]?.size), 4.5415);
    assert.equal(Number(correctedRow.rows[0]?.average_price), 0.22);
    assert.ok(
      (correctedRow.rows[0]?.last_updated_at.getTime() ?? 0) >
        new Date(oldActivityTime).getTime(),
    );
  } finally {
    await cleanupPositionTest(userId, [tokenId]);
  }
});

await test("exact position reconciliation flattens empty AMM balance", async () => {
  const walletAddress = randomEvmAddress();
  const tokenId = `limitless:${crypto.randomInt(1_000_000, 9_999_999)}`;
  const marketId = `limitless-test:${crypto.randomUUID()}`;
  const userId = await createTestUser();

  try {
    await pool.query(
      `
        insert into unified_tokens(token_id, venue, market_id, side)
        values ($1, 'limitless', $2, 'YES')
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
          1.9392,
          0.52,
          0,
          0,
          now(),
          now(),
          now()
        )
      `,
      [userId, walletAddress, tokenId],
    );

    const result = await reconcileExactPositionBalance(pool, {
      userId,
      walletAddress,
      venue: "limitless",
      tokenId,
      size: 0,
      averagePrice: 0.52,
    });

    assert.equal(result.applied, true);

    const flatRow = await pool.query<{
      side: string;
      size: string;
      average_price: string | null;
    }>(
      `
        select side, size::text, average_price::text
        from positions
        where user_id = $1 and wallet_address = $2 and token_id = $3
      `,
      [userId, walletAddress, tokenId],
    );

    assert.equal(flatRow.rows[0]?.side, "FLAT");
    assert.equal(Number(flatRow.rows[0]?.size), 0);
    assert.equal(flatRow.rows[0]?.average_price, null);
  } finally {
    await cleanupPositionTest(userId, [tokenId]);
  }
});
