#!/usr/bin/env tsx

import assert from "node:assert/strict";
import crypto from "node:crypto";

import { pool } from "./db.js";
import {
  fetchPositionsForUserWallet,
  setPositionHidden,
  syncWalletPositionsFromTokenBalances,
  updatePositionMetrics,
} from "./repos/positions-repo.js";
import {
  createResolvedPositionNotificationIfVisible,
  notifyResolvedPositions,
} from "./services/positions-notifications.js";
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

async function cleanupPositionTest(
  userId: string,
  tokenIds: string[],
  marketIds: string[] = [],
) {
  await pool.query("delete from notifications where user_id = $1", [userId]);
  await pool.query("delete from positions where user_id = $1", [userId]);
  await pool.query(
    "delete from unified_tokens where token_id = any($1::text[])",
    [tokenIds],
  );
  if (marketIds.length > 0) {
    await pool.query("delete from unified_markets where id = any($1::text[])", [
      marketIds,
    ]);
    await pool.query(
      "delete from unified_events where id = any($1::text[])",
      [marketIds.map((marketId) => `event-${marketId}`)],
    );
  }
  await pool.query("delete from users where id = $1", [userId]);
}

async function insertResolvedLimitlessMarket(params: {
  marketId: string;
  tokenId: string;
  outcomeSide: "YES" | "NO";
  resolvedOutcome: "YES" | "NO";
}): Promise<void> {
  const eventId = `event-${params.marketId}`;
  await pool.query(
    `
      insert into unified_events (
        id,
        venue,
        venue_event_id,
        title,
        status,
        start_date,
        end_date,
        volume_total,
        volume_24h,
        liquidity,
        slug,
        created_at,
        updated_at
      )
      values (
        $1,
        'limitless',
        $1,
        'Resolved test event',
        'SETTLED',
        now() - interval '2 days',
        now() - interval '1 day',
        0,
        0,
        0,
        $2,
        now(),
        now()
      )
    `,
    [eventId, `slug-${eventId}`],
  );

  await pool.query(
    `
      insert into unified_markets (
        id,
        venue,
        venue_market_id,
        event_id,
        title,
        status,
        market_type,
        open_time,
        close_time,
        expiration_time,
        best_bid,
        best_ask,
        last_price,
        volume_total,
        volume_24h,
        liquidity,
        open_interest,
        outcomes,
        token_yes,
        token_no,
        slug,
        resolved_outcome,
        created_at,
        updated_at
      )
      values (
        $1,
        'limitless',
        $1,
        $2,
        'Resolved test market',
        'SETTLED',
        'binary',
        now() - interval '2 days',
        now() - interval '1 day',
        now() - interval '1 day',
        0,
        0,
        null,
        0,
        0,
        0,
        0,
        '["Yes","No"]',
        case when $3 = 'YES' then $4 else $5 end,
        case when $3 = 'NO' then $4 else $5 end,
        $6,
        $7,
        now(),
        now()
      )
    `,
    [
      params.marketId,
      eventId,
      params.outcomeSide,
      params.tokenId,
      `other-${params.tokenId}`,
      `slug-${params.marketId}`,
      params.resolvedOutcome,
    ],
  );

  await pool.query(
    `
      insert into unified_tokens(token_id, venue, market_id, side)
      values ($1, 'limitless', $2, $3)
    `,
    [params.tokenId, params.marketId, params.outcomeSide],
  );
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

await test("exact position reconciliation preserves hidden resolved losses", async () => {
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
          is_hidden,
          hidden_reason,
          hidden_at,
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
          1.5,
          0.52,
          0,
          0,
          true,
          'user',
          now(),
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
      size: 1.5,
      averagePrice: 0.52,
    });

    assert.equal(result.applied, true);

    const hiddenRow = await pool.query<{
      is_hidden: boolean | null;
      hidden_reason: string | null;
      hidden_at: Date | null;
    }>(
      `
        select is_hidden, hidden_reason, hidden_at
        from positions
        where user_id = $1 and wallet_address = $2 and token_id = $3
      `,
      [userId, walletAddress, tokenId],
    );

    assert.equal(hiddenRow.rows[0]?.is_hidden, true);
    assert.equal(hiddenRow.rows[0]?.hidden_reason, "user");
    assert.ok(hiddenRow.rows[0]?.hidden_at);
  } finally {
    await cleanupPositionTest(userId, [tokenId]);
  }
});

await test("resolved visible loss creates one notification", async () => {
  const walletAddress = randomEvmAddress();
  const tokenId = `limitless:${crypto.randomInt(1_000_000, 9_999_999)}`;
  const marketId = `limitless-test:${crypto.randomUUID()}`;
  const userId = await createTestUser();

  try {
    await insertResolvedLimitlessMarket({
      marketId,
      tokenId,
      outcomeSide: "YES",
      resolvedOutcome: "NO",
    });

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
          now(),
          now(),
          now()
        )
      `,
      [userId, walletAddress, tokenId],
    );

    const created = await notifyResolvedPositions(pool, {
      userId,
      walletAddress,
      venue: "limitless",
    });
    assert.equal(created, 1);

    const notificationRow = await pool.query<{
      title: string;
      body: string;
      read_at: Date | null;
    }>(
      `
        select title, body, read_at
        from notifications
        where user_id = $1 and type = 'position_resolved'
      `,
      [userId],
    );
    assert.equal(notificationRow.rowCount, 1);
    assert.equal(notificationRow.rows[0]?.title, "Position resolved (loss)");
    assert.equal(notificationRow.rows[0]?.body, "Resolved with no payout");
    assert.equal(notificationRow.rows[0]?.read_at, null);
  } finally {
    await cleanupPositionTest(userId, [tokenId], [marketId]);
  }
});

await test("resolved hidden loss creates no notification", async () => {
  const walletAddress = randomEvmAddress();
  const tokenId = `limitless:${crypto.randomInt(1_000_000, 9_999_999)}`;
  const marketId = `limitless-test:${crypto.randomUUID()}`;
  const userId = await createTestUser();

  try {
    await insertResolvedLimitlessMarket({
      marketId,
      tokenId,
      outcomeSide: "YES",
      resolvedOutcome: "NO",
    });

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
          is_hidden,
          hidden_reason,
          hidden_at,
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
          true,
          'user',
          now(),
          now(),
          now(),
          now()
        )
      `,
      [userId, walletAddress, tokenId],
    );

    const created = await notifyResolvedPositions(pool, {
      userId,
      walletAddress,
      venue: "limitless",
    });
    assert.equal(created, 0);

    const notificationRow = await pool.query(
      `
        select id
        from notifications
        where user_id = $1 and type = 'position_resolved'
      `,
      [userId],
    );
    assert.equal(notificationRow.rowCount, 0);
  } finally {
    await cleanupPositionTest(userId, [tokenId], [marketId]);
  }
});

await test("resolved notification insert skips position hidden after selection", async () => {
  const walletAddress = randomEvmAddress();
  const tokenId = `limitless:${crypto.randomInt(1_000_000, 9_999_999)}`;
  const marketId = `limitless-test:${crypto.randomUUID()}`;
  const userId = await createTestUser();

  try {
    await insertResolvedLimitlessMarket({
      marketId,
      tokenId,
      outcomeSide: "YES",
      resolvedOutcome: "NO",
    });

    const positionInsert = await pool.query<{
      id: string;
      token_id: string;
      wallet_address: string;
      venue: string;
      market_id: string | null;
    }>(
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
          now(),
          now(),
          now()
        )
        returning id, token_id, wallet_address, venue, $4::text as market_id
      `,
      [userId, walletAddress, tokenId, marketId],
    );
    const selectedPosition = positionInsert.rows[0];
    assert.ok(selectedPosition);

    await setPositionHidden(pool, {
      userId,
      walletAddress,
      venue: "limitless",
      tokenId,
      hidden: true,
      reason: "user",
    });

    const notification =
      await createResolvedPositionNotificationIfVisible(pool, {
        userId,
        position: selectedPosition,
        resolvedOutcome: "NO",
        outcomeSide: "YES",
      });

    assert.equal(notification, null);

    const notificationRow = await pool.query(
      `
        select id
        from notifications
        where user_id = $1 and type = 'position_resolved'
      `,
      [userId],
    );
    assert.equal(notificationRow.rowCount, 0);
  } finally {
    await cleanupPositionTest(userId, [tokenId], [marketId]);
  }
});

await test("hiding a resolved position marks its notification read", async () => {
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

    const positionInsert = await pool.query<{ id: string }>(
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
          now(),
          now(),
          now()
        )
        returning id
      `,
      [userId, walletAddress, tokenId],
    );
    const positionId = positionInsert.rows[0]?.id;
    assert.ok(positionId);

    await pool.query(
      `
        insert into notifications (
          user_id,
          type,
          title,
          body,
          severity,
          dedupe_key
        )
        values (
          $1,
          'position_resolved',
          'Position resolved (loss)',
          'Resolved with no payout',
          'warning',
          $2
        )
      `,
      [userId, `position_resolved:${positionId}`],
    );

    await setPositionHidden(pool, {
      userId,
      walletAddress,
      venue: "limitless",
      tokenId,
      hidden: true,
      reason: "user",
    });

    const notificationRow = await pool.query<{ read_at: Date | null }>(
      `
        select read_at
        from notifications
        where user_id = $1 and dedupe_key = $2
      `,
      [userId, `position_resolved:${positionId}`],
    );

    assert.ok(notificationRow.rows[0]?.read_at);
  } finally {
    await cleanupPositionTest(userId, [tokenId]);
  }
});
