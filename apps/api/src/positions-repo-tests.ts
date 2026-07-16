#!/usr/bin/env tsx

import assert from "node:assert/strict";
import crypto from "node:crypto";

import { pool } from "./db.js";
import {
  fetchPositionPnlSummaryForUserWallet,
  fetchPositionsForUserWallet,
  fetchPositionsForUserWalletByTokenIds,
  setPositionHidden,
  syncWalletPositionsFromTokenBalances,
  updatePositionMetrics,
} from "./repos/positions-repo.js";
import { fetchMarketsByTokenIds } from "./repos/unified-read.js";
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
    await pool.query("delete from unified_events where id = any($1::text[])", [
      marketIds.map((marketId) => `event-${marketId}`),
    ]);
  }
  await pool.query("delete from users where id = $1", [userId]);
}

function assertClose(actual: number, expected: number, epsilon = 1e-9) {
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    `expected ${actual} to be within ${epsilon} of ${expected}`,
  );
}

async function insertLimitlessToken(
  tokenId: string,
  marketId: string,
  side: "YES" | "NO" = "YES",
): Promise<void> {
  await pool.query(
    `
      insert into unified_tokens(token_id, venue, market_id, side)
      values ($1, 'limitless', $2, $3)
    `,
    [tokenId, marketId, side],
  );
}

async function insertPolymarketToken(
  tokenId: string,
  marketId: string,
  side: "YES" | "NO" = "YES",
): Promise<void> {
  await pool.query(
    `
      insert into unified_tokens(token_id, venue, market_id, side)
      values ($1, 'polymarket', $2, $3)
    `,
    [tokenId, marketId, side],
  );
}

async function insertLimitlessPosition(params: {
  userId: string;
  walletAddress: string;
  tokenId: string;
  size: number;
  averagePrice: number | null;
  realizedPnl?: number;
  unrealizedPnl?: number;
  lastUpdatedAt?: string;
}): Promise<void> {
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
        $4,
        $5,
        $6,
        $7,
        $8::timestamptz,
        now(),
        now()
      )
    `,
    [
      params.userId,
      params.walletAddress,
      params.tokenId,
      params.size,
      params.averagePrice,
      params.unrealizedPnl ?? 0,
      params.realizedPnl ?? 0,
      params.lastUpdatedAt ?? "2026-01-01T00:00:00.000Z",
    ],
  );
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

  await pool.query(
    `
      insert into unified_market_tokens(token_id, venue, market_id, outcome_side)
      values ($1, 'limitless', $2, $3)
    `,
    [params.tokenId, params.marketId, params.outcomeSide],
  );
}

async function insertResolvedPolymarketMarket(params: {
  marketId: string;
  yesTokenId: string;
  noTokenId: string;
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
        'polymarket',
        $1,
        'Resolved Polymarket test event',
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
        'polymarket',
        $1,
        $2,
        'Resolved Polymarket test market',
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
        $3,
        $4,
        $5,
        $6,
        now(),
        now()
      )
    `,
    [
      params.marketId,
      eventId,
      params.yesTokenId,
      params.noTokenId,
      `slug-${params.marketId}`,
      params.resolvedOutcome,
    ],
  );

  await pool.query(
    `
      insert into unified_tokens(token_id, venue, market_id, side)
      values
        ($1, 'polymarket', $3, 'YES'),
        ($2, 'polymarket', $3, 'NO')
    `,
    [params.yesTokenId, params.noTokenId, params.marketId],
  );

  await pool.query(
    `
      insert into unified_market_tokens(token_id, venue, market_id, outcome_side)
      values
        ($1, 'polymarket', $3, 'YES'),
        ($2, 'polymarket', $3, 'NO')
    `,
    [params.yesTokenId, params.noTokenId, params.marketId],
  );
}

async function insertKalshiMarket(params: {
  marketId: string;
  tokenId: string;
  outcomeSide: "YES" | "NO";
  resolvedOutcome?: "YES" | "NO" | null;
}): Promise<void> {
  const eventId = `event-${params.marketId}`;
  const status = params.resolvedOutcome ? "SETTLED" : "ACTIVE";
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
        'kalshi',
        $1,
        'Kalshi test event',
        $2,
        now() - interval '2 days',
        now() + interval '1 day',
        0,
        0,
        0,
        $3,
        now(),
        now()
      )
    `,
    [eventId, status, `slug-${eventId}`],
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
        'kalshi',
        $1,
        $2,
        'Kalshi test market',
        $3,
        'binary',
        now() - interval '2 days',
        now() + interval '1 day',
        now() + interval '1 day',
        0,
        0,
        null,
        0,
        0,
        0,
        0,
        '["Yes","No"]',
        case when $4 = 'YES' then $5 else $6 end,
        case when $4 = 'NO' then $5 else $6 end,
        $7,
        $8,
        now(),
        now()
      )
    `,
    [
      params.marketId,
      eventId,
      status,
      params.outcomeSide,
      params.tokenId,
      `other-${params.tokenId}`,
      `slug-${params.marketId}`,
      params.resolvedOutcome ?? null,
    ],
  );

  await pool.query(
    `
      insert into unified_tokens(token_id, venue, market_id, side)
      values ($1, 'kalshi', $2, $3)
    `,
    [params.tokenId, params.marketId, params.outcomeSide],
  );

  await pool.query(
    `
      insert into unified_market_tokens(token_id, venue, market_id, outcome_side)
      values ($1, 'kalshi', $2, $3)
    `,
    [params.tokenId, params.marketId, params.outcomeSide],
  );
}

await test("polymarket position sync canonicalizes checksum then lowercase wallet to one row", async () => {
  const checksumWallet = "0xAAbBcCdDEeFf0011223344556677889900aABbCc";
  const lowerWallet = checksumWallet.toLowerCase();
  const tokenId = `poly-token-${crypto.randomUUID()}`;
  const userId = await createTestUser();

  try {
    await insertPolymarketToken(tokenId, `poly-market-${crypto.randomUUID()}`);

    await syncWalletPositionsFromTokenBalances(pool, {
      userId,
      walletAddress: checksumWallet,
      venue: "polymarket",
      tokenBalances: [{ tokenId, size: "1" }],
    });

    await syncWalletPositionsFromTokenBalances(pool, {
      userId,
      walletAddress: lowerWallet,
      venue: "polymarket",
      tokenBalances: [{ tokenId, size: "2" }],
    });

    const { rows } = await pool.query<{
      wallet_address: string;
      size: string;
    }>(
      `
        select wallet_address, size::text
        from positions
        where user_id = $1 and token_id = $2
      `,
      [userId, tokenId],
    );

    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.wallet_address, lowerWallet);
    assert.equal(rows[0]?.size, "2");
  } finally {
    await cleanupPositionTest(userId, [tokenId]);
  }
});

await test("polymarket position sync canonicalizes lowercase then checksum wallet to one row", async () => {
  const checksumWallet = "0xCcDdEeFf0011223344556677889900AaBbCcDdEe";
  const lowerWallet = checksumWallet.toLowerCase();
  const tokenId = `poly-token-${crypto.randomUUID()}`;
  const userId = await createTestUser();

  try {
    await insertPolymarketToken(tokenId, `poly-market-${crypto.randomUUID()}`);

    await syncWalletPositionsFromTokenBalances(pool, {
      userId,
      walletAddress: lowerWallet,
      venue: "polymarket",
      tokenBalances: [{ tokenId, size: "3" }],
    });

    await syncWalletPositionsFromTokenBalances(pool, {
      userId,
      walletAddress: checksumWallet,
      venue: "polymarket",
      tokenBalances: [{ tokenId, size: "4" }],
    });

    const { rows } = await pool.query<{
      wallet_address: string;
      size: string;
    }>(
      `
        select wallet_address, size::text
        from positions
        where user_id = $1 and token_id = $2
      `,
      [userId, tokenId],
    );

    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.wallet_address, lowerWallet);
    assert.equal(rows[0]?.size, "4");
  } finally {
    await cleanupPositionTest(userId, [tokenId]);
  }
});

await test("polymarket position reads tolerate mixed-case duplicates before cleanup", async () => {
  const lowerWallet = randomEvmAddress();
  const checksumWallet = `0x${lowerWallet
    .slice(2)
    .split("")
    .map((char, index) =>
      /[a-f]/.test(char) && index % 2 === 0 ? char.toUpperCase() : char,
    )
    .join("")}`;
  const tokenId = `poly-token-${crypto.randomUUID()}`;
  const userId = await createTestUser();

  try {
    await insertPolymarketToken(tokenId, `poly-market-${crypto.randomUUID()}`);

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
            'polymarket',
            'own',
            $4,
            'LONG',
            1,
            0.4,
            -0.1,
            0.2,
            '2026-01-01T00:00:00.000Z'::timestamptz,
            '2026-01-01T00:00:00.000Z'::timestamptz,
            '2026-01-01T00:00:00.000Z'::timestamptz
          ),
          (
            $1,
            $3,
            'polymarket',
            'own',
            $4,
            'LONG',
            2,
            0.5,
            0.25,
            0.75,
            '2026-01-02T00:00:00.000Z'::timestamptz,
            '2026-01-02T00:00:00.000Z'::timestamptz,
            '2026-01-02T00:00:00.000Z'::timestamptz
          )
      `,
      [userId, checksumWallet, lowerWallet, tokenId],
    );

    const positions = await fetchPositionsForUserWallet(pool, {
      userId,
      walletAddresses: [checksumWallet],
      venue: "polymarket",
      includeHidden: true,
      minSize: 0,
    });
    assert.equal(positions.length, 1);
    assert.equal(positions[0]?.walletAddress, lowerWallet);
    assert.equal(positions[0]?.size, 2);

    const byToken = await fetchPositionsForUserWalletByTokenIds(pool, {
      userId,
      walletAddresses: [checksumWallet],
      tokenIds: [tokenId],
      venue: "polymarket",
      includeHidden: true,
      minSize: 0,
    });
    assert.equal(byToken.length, 1);
    assert.equal(byToken[0]?.walletAddress, lowerWallet);
    assert.equal(byToken[0]?.size, 2);

    const summary = await fetchPositionPnlSummaryForUserWallet(pool, {
      userId,
      walletAddresses: [checksumWallet],
      venue: "polymarket",
    });
    assert.equal(summary.positionsCount, 1);
    assert.equal(summary.openPositionsCount, 1);
    assertClose(summary.realizedPnlAllTime, 0.75);
    assertClose(summary.unrealizedPnlCurrent, 0.25);
  } finally {
    await cleanupPositionTest(userId, [tokenId]);
  }
});

await test("polymarket position reads sort recent order activity before sync-discovered rows", async () => {
  const walletAddress = randomEvmAddress();
  const tradedTokenId = `poly-token-${crypto.randomUUID()}`;
  const syncedTokenId = `poly-token-${crypto.randomUUID()}`;
  const userId = await createTestUser();

  try {
    await insertPolymarketToken(
      tradedTokenId,
      `poly-market-${crypto.randomUUID()}`,
    );
    await insertPolymarketToken(
      syncedTokenId,
      `poly-market-${crypto.randomUUID()}`,
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
            'polymarket',
            'own',
            $3,
            'LONG',
            1,
            0.4,
            0,
            0,
            '2026-06-20T15:40:59.000Z'::timestamptz,
            '2026-06-20T15:40:59.000Z'::timestamptz,
            '2026-06-20T15:40:59.000Z'::timestamptz
          ),
          (
            $1,
            $2,
            'polymarket',
            'own',
            $4,
            'LONG',
            2,
            0.5,
            0,
            0,
            '2026-06-20T15:41:01.000Z'::timestamptz,
            '2026-06-20T15:41:01.000Z'::timestamptz,
            '2026-06-20T15:41:01.000Z'::timestamptz
          )
      `,
      [userId, walletAddress, tradedTokenId, syncedTokenId],
    );

    await pool.query(
      `
        insert into orders (
          user_id,
          wallet_address,
          venue,
          venue_order_id,
          token_id,
          side,
          order_type,
          price,
          size,
          status,
          filled_size,
          average_fill_price,
          posted_at,
          filled_at,
          last_update
        )
        values (
          $1,
          $2,
          'polymarket',
          $3,
          $4,
          'BUY',
          'FOK',
          0.4,
          1,
          'matched',
          1,
          0.4,
          '2026-06-20T15:40:55.000Z'::timestamptz,
          '2026-06-20T15:40:55.000Z'::timestamptz,
          '2026-06-20T15:40:56.000Z'::timestamptz
        )
      `,
      [
        userId,
        walletAddress,
        `test-order-${crypto.randomUUID()}`,
        tradedTokenId,
      ],
    );

    const positions = await fetchPositionsForUserWallet(pool, {
      userId,
      walletAddresses: [walletAddress],
      venue: "polymarket",
      includeHidden: true,
      minSize: 0,
    });

    assert.equal(positions.length, 2);
    assert.equal(positions[0]?.tokenId, tradedTokenId);
    assert.equal(positions[1]?.tokenId, syncedTokenId);
  } finally {
    await pool.query("delete from orders where user_id = $1", [userId]);
    await cleanupPositionTest(userId, [tradedTokenId, syncedTokenId]);
  }
});

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

await test("unscoped position reads ignore non-portfolio venues", async () => {
  const walletAddress = randomEvmAddress();
  const supportedTokenId = `limitless:${crypto.randomInt(1_000_000, 9_999_999)}`;
  const unsupportedTokenId = `hyperliquid:${crypto.randomInt(1_000_000, 9_999_999)}`;
  const userId = await createTestUser();

  try {
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
            2,
            0.5,
            3,
            2,
            now(),
            now(),
            now()
          ),
          (
            $1,
            $2,
            'hyperliquid',
            'own',
            $4,
            'LONG',
            10,
            0.5,
            -50,
            -99,
            now(),
            now(),
            now()
          )
      `,
      [userId, walletAddress, supportedTokenId, unsupportedTokenId],
    );

    const positions = await fetchPositionsForUserWallet(pool, {
      userId,
      walletAddresses: [walletAddress],
      includeHidden: true,
      minSize: 0,
    });
    assert.equal(positions.length, 1);
    assert.equal(positions[0]?.venue, "limitless");
    assert.equal(positions[0]?.tokenId, supportedTokenId);

    const byToken = await fetchPositionsForUserWalletByTokenIds(pool, {
      userId,
      walletAddresses: [walletAddress],
      tokenIds: [supportedTokenId, unsupportedTokenId],
      includeHidden: true,
      minSize: 0,
    });
    assert.equal(byToken.length, 1);
    assert.equal(byToken[0]?.tokenId, supportedTokenId);

    const summary = await fetchPositionPnlSummaryForUserWallet(pool, {
      userId,
      walletAddresses: [walletAddress],
    });
    assert.equal(summary.positionsCount, 1);
    assert.equal(summary.openPositionsCount, 1);
    assertClose(summary.realizedPnlAllTime, 2);
    assertClose(summary.unrealizedPnlCurrent, 3);
  } finally {
    await cleanupPositionTest(userId, [supportedTokenId, unsupportedTokenId]);
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

await test("unsorted metrics update the matching token rows", async () => {
  const walletAddress = randomEvmAddress();
  const tokenA = `limitless:a-${crypto.randomUUID()}`;
  const tokenB = `limitless:b-${crypto.randomUUID()}`;
  const tokenC = `limitless:c-${crypto.randomUUID()}`;
  const userId = await createTestUser();
  const tokens = [tokenA, tokenB, tokenC];

  try {
    for (const [index, tokenId] of tokens.entries()) {
      await insertLimitlessToken(
        tokenId,
        `limitless-test:${crypto.randomUUID()}`,
      );
      await insertLimitlessPosition({
        userId,
        walletAddress,
        tokenId,
        size: index + 1,
        averagePrice: 0.5,
      });
    }

    await updatePositionMetrics(pool, {
      userId,
      walletAddress,
      venue: "limitless",
      metrics: [
        {
          tokenId: tokenC,
          averagePrice: 0.33,
          realizedPnl: 3.3,
          unrealizedPnl: 33,
        },
        {
          tokenId: tokenA,
          averagePrice: 0.11,
          realizedPnl: 1.1,
          unrealizedPnl: 11,
        },
        {
          tokenId: tokenB,
          averagePrice: 0.22,
          realizedPnl: 2.2,
          unrealizedPnl: 22,
        },
      ],
    });

    const { rows } = await pool.query<{
      token_id: string;
      average_price: string;
      realized_pnl: string;
      unrealized_pnl: string;
    }>(
      `
        select
          token_id,
          average_price::text,
          realized_pnl::text,
          unrealized_pnl::text
        from positions
        where user_id = $1 and wallet_address = $2
        order by token_id
      `,
      [userId, walletAddress],
    );

    const byToken = new Map(rows.map((row) => [row.token_id, row]));
    assert.equal(Number(byToken.get(tokenA)?.average_price), 0.11);
    assert.equal(Number(byToken.get(tokenA)?.realized_pnl), 1.1);
    assert.equal(Number(byToken.get(tokenA)?.unrealized_pnl), 11);
    assert.equal(Number(byToken.get(tokenB)?.average_price), 0.22);
    assert.equal(Number(byToken.get(tokenB)?.realized_pnl), 2.2);
    assert.equal(Number(byToken.get(tokenB)?.unrealized_pnl), 22);
    assert.equal(Number(byToken.get(tokenC)?.average_price), 0.33);
    assert.equal(Number(byToken.get(tokenC)?.realized_pnl), 3.3);
    assert.equal(Number(byToken.get(tokenC)?.unrealized_pnl), 33);
  } finally {
    await cleanupPositionTest(userId, tokens);
  }
});

await test("concurrent metrics refreshes serialize same user venue writes", async () => {
  const walletAddress = randomEvmAddress();
  const tokenA = `limitless:a-${crypto.randomUUID()}`;
  const tokenB = `limitless:b-${crypto.randomUUID()}`;
  const userId = await createTestUser();
  const tokens = [tokenA, tokenB];

  try {
    for (const tokenId of tokens) {
      await insertLimitlessToken(
        tokenId,
        `limitless-test:${crypto.randomUUID()}`,
      );
      await insertLimitlessPosition({
        userId,
        walletAddress,
        tokenId,
        size: 2,
        averagePrice: 0.5,
      });
    }

    await Promise.all([
      updatePositionMetrics(pool, {
        userId,
        walletAddress,
        venue: "limitless",
        metrics: [
          {
            tokenId: tokenA,
            averagePrice: 0.41,
            realizedPnl: 4.1,
            unrealizedPnl: 41,
          },
          {
            tokenId: tokenB,
            averagePrice: 0.52,
            realizedPnl: 5.2,
            unrealizedPnl: 52,
          },
        ],
      }),
      updatePositionMetrics(pool, {
        userId,
        walletAddress,
        venue: "limitless",
        metrics: [
          {
            tokenId: tokenB,
            averagePrice: 0.52,
            realizedPnl: 5.2,
            unrealizedPnl: 52,
          },
          {
            tokenId: tokenA,
            averagePrice: 0.41,
            realizedPnl: 4.1,
            unrealizedPnl: 41,
          },
        ],
      }),
    ]);

    const { rows } = await pool.query<{
      token_id: string;
      average_price: string;
      realized_pnl: string;
      unrealized_pnl: string;
    }>(
      `
        select
          token_id,
          average_price::text,
          realized_pnl::text,
          unrealized_pnl::text
        from positions
        where user_id = $1 and wallet_address = $2
        order by token_id
      `,
      [userId, walletAddress],
    );

    const byToken = new Map(rows.map((row) => [row.token_id, row]));
    assert.equal(Number(byToken.get(tokenA)?.average_price), 0.41);
    assert.equal(Number(byToken.get(tokenA)?.realized_pnl), 4.1);
    assert.equal(Number(byToken.get(tokenA)?.unrealized_pnl), 41);
    assert.equal(Number(byToken.get(tokenB)?.average_price), 0.52);
    assert.equal(Number(byToken.get(tokenB)?.realized_pnl), 5.2);
    assert.equal(Number(byToken.get(tokenB)?.unrealized_pnl), 52);
  } finally {
    await cleanupPositionTest(userId, tokens);
  }
});

await test("concurrent sync and metrics refresh leave coherent rows", async () => {
  const walletAddress = randomEvmAddress();
  const tokenA = `limitless:a-${crypto.randomUUID()}`;
  const tokenB = `limitless:b-${crypto.randomUUID()}`;
  const tokenC = `limitless:c-${crypto.randomUUID()}`;
  const userId = await createTestUser();
  const tokens = [tokenA, tokenB, tokenC];

  try {
    for (const tokenId of tokens) {
      await insertLimitlessToken(
        tokenId,
        `limitless-test:${crypto.randomUUID()}`,
      );
      await insertLimitlessPosition({
        userId,
        walletAddress,
        tokenId,
        size: 1,
        averagePrice: 0.5,
      });
    }

    await Promise.all([
      syncWalletPositionsFromTokenBalances(pool, {
        userId,
        walletAddress,
        venue: "limitless",
        tokenBalances: [
          { tokenId: tokenB, size: "4", averagePrice: "0.44" },
          { tokenId: tokenA, size: "3", averagePrice: "0.33" },
        ],
        tokenIdLike: "limitless:%",
        flattenGraceSec: 0,
      }),
      updatePositionMetrics(pool, {
        userId,
        walletAddress,
        venue: "limitless",
        metrics: [
          {
            tokenId: tokenB,
            averagePrice: 0.24,
            realizedPnl: 24,
            unrealizedPnl: 240,
          },
          {
            tokenId: tokenA,
            averagePrice: 0.13,
            realizedPnl: 13,
            unrealizedPnl: 130,
          },
        ],
      }),
    ]);

    const { rows } = await pool.query<{
      token_id: string;
      side: string;
      size: string;
      realized_pnl: string;
      unrealized_pnl: string;
    }>(
      `
        select
          token_id,
          side,
          size::text,
          realized_pnl::text,
          unrealized_pnl::text
        from positions
        where user_id = $1 and wallet_address = $2
        order by token_id
      `,
      [userId, walletAddress],
    );

    const byToken = new Map(rows.map((row) => [row.token_id, row]));
    assert.equal(byToken.get(tokenA)?.side, "LONG");
    assert.equal(Number(byToken.get(tokenA)?.size), 3);
    assert.equal(Number(byToken.get(tokenA)?.realized_pnl), 13);
    assert.equal(Number(byToken.get(tokenA)?.unrealized_pnl), 130);
    assert.equal(byToken.get(tokenB)?.side, "LONG");
    assert.equal(Number(byToken.get(tokenB)?.size), 4);
    assert.equal(Number(byToken.get(tokenB)?.realized_pnl), 24);
    assert.equal(Number(byToken.get(tokenB)?.unrealized_pnl), 240);
    assert.equal(byToken.get(tokenC)?.side, "FLAT");
    assert.equal(Number(byToken.get(tokenC)?.size), 0);
  } finally {
    await cleanupPositionTest(userId, tokens);
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

await test("active position reads exclude flat zero rows even with minSize zero", async () => {
  const walletAddress = randomEvmAddress();
  const flatTokenId = `limitless:${crypto.randomInt(1_000_000, 9_999_999)}`;
  const openTokenId = `limitless:${crypto.randomInt(1_000_000, 9_999_999)}`;
  const userId = await createTestUser();

  try {
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
            'FLAT',
            0,
            null,
            0,
            0,
            now(),
            now(),
            now()
          ),
          (
            $1,
            $2,
            'limitless',
            'own',
            $4,
            'LONG',
            0.0001,
            0.5,
            0,
            0,
            now(),
            now(),
            now()
          )
      `,
      [userId, walletAddress, flatTokenId, openTokenId],
    );

    const positions = await fetchPositionsForUserWallet(pool, {
      userId,
      walletAddresses: [walletAddress],
      venue: "limitless",
      includeHidden: true,
      minSize: 0,
    });
    assert.deepEqual(
      positions.map((position) => position.tokenId),
      [openTokenId],
    );

    const byToken = await fetchPositionsForUserWalletByTokenIds(pool, {
      userId,
      walletAddresses: [walletAddress],
      tokenIds: [flatTokenId, openTokenId],
      venue: "limitless",
      includeHidden: true,
      minSize: 0,
    });
    assert.deepEqual(
      byToken.map((position) => position.tokenId),
      [openTokenId],
    );
  } finally {
    await cleanupPositionTest(userId, [flatTokenId, openTokenId]);
  }
});

await test("includeResolved returns redemption-marked resolved flat rows", async () => {
  const walletAddress = randomEvmAddress();
  const openTokenId = `limitless:${crypto.randomInt(1_000_000, 9_999_999)}`;
  const unresolvedFlatTokenId = `limitless:${crypto.randomInt(1_000_000, 9_999_999)}`;
  const soldResolvedTokenId = `limitless:${crypto.randomInt(1_000_000, 9_999_999)}`;
  const redeemedResolvedTokenId = `limitless:${crypto.randomInt(1_000_000, 9_999_999)}`;
  const soldMarketId = `limitless-test:${crypto.randomUUID()}`;
  const redeemedMarketId = `limitless-test:${crypto.randomUUID()}`;
  const userId = await createTestUser();

  try {
    await insertResolvedLimitlessMarket({
      marketId: soldMarketId,
      tokenId: soldResolvedTokenId,
      outcomeSide: "YES",
      resolvedOutcome: "YES",
    });
    await insertResolvedLimitlessMarket({
      marketId: redeemedMarketId,
      tokenId: redeemedResolvedTokenId,
      outcomeSide: "YES",
      resolvedOutcome: "YES",
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
        values
          ($1, $2, 'limitless', 'own', $3, 'LONG', 0.5, 0.4, 0, 0, now(), now(), now()),
          ($1, $2, 'limitless', 'own', $4, 'FLAT', 0, 0.4, 0, 0.1, now(), now(), now()),
          ($1, $2, 'limitless', 'own', $5, 'FLAT', 0, 0.4, 0, 0.2, now(), now(), now()),
          ($1, $2, 'limitless', 'own', $6, 'FLAT', 0, 0.4, 0, 0.7, now(), now(), now())
      `,
      [
        userId,
        walletAddress,
        openTokenId,
        unresolvedFlatTokenId,
        soldResolvedTokenId,
        redeemedResolvedTokenId,
      ],
    );

    await pool.query(
      `
        insert into notifications (
          user_id,
          type,
          title,
          body,
          severity,
          data,
          dedupe_key
        )
        values (
          $1,
          'redemption_completed',
          'Redemption completed',
          'Limitless redemption',
          'success',
          jsonb_build_object(
            'venue', 'limitless',
            'tokenId', $2::text,
            'walletAddress', $3::text
          ),
          $4
        )
      `,
      [
        userId,
        redeemedResolvedTokenId,
        walletAddress,
        `redemption:test:${crypto.randomUUID()}`,
      ],
    );

    const defaultPositions = await fetchPositionsForUserWallet(pool, {
      userId,
      walletAddresses: [walletAddress],
      venue: "limitless",
      includeHidden: true,
      minSize: 0,
    });
    assert.deepEqual(
      defaultPositions.map((position) => position.tokenId),
      [openTokenId],
    );

    const resolvedPositions = await fetchPositionsForUserWallet(pool, {
      userId,
      walletAddresses: [walletAddress],
      venue: "limitless",
      includeHidden: true,
      includeResolved: true,
      minSize: 1,
    });
    assert.deepEqual(
      resolvedPositions.map((position) => position.tokenId),
      [redeemedResolvedTokenId],
    );
    assert.equal(resolvedPositions[0]?.side, "FLAT");
    assert.equal(resolvedPositions[0]?.size, 0);
    assertClose(resolvedPositions[0]?.realizedPnl ?? 0, 0.7);

    const byToken = await fetchPositionsForUserWalletByTokenIds(pool, {
      userId,
      walletAddresses: [walletAddress],
      tokenIds: [
        openTokenId,
        unresolvedFlatTokenId,
        soldResolvedTokenId,
        redeemedResolvedTokenId,
      ],
      venue: "limitless",
      includeHidden: true,
      includeResolved: true,
      minSize: 1,
    });
    assert.deepEqual(
      byToken.map((position) => position.tokenId),
      [redeemedResolvedTokenId],
    );
  } finally {
    await cleanupPositionTest(
      userId,
      [
        openTokenId,
        unresolvedFlatTokenId,
        soldResolvedTokenId,
        redeemedResolvedTokenId,
        `other-${soldResolvedTokenId}`,
        `other-${redeemedResolvedTokenId}`,
      ],
      [soldMarketId, redeemedMarketId],
    );
  }
});

await test("includeResolved returns same-market sibling flat rows after redemption", async () => {
  const walletAddress = randomEvmAddress();
  const userId = await createTestUser();
  const redeemedMarketId = `polymarket-test:${crypto.randomUUID()}`;
  const oldSoldMarketId = `polymarket-test:${crypto.randomUUID()}`;
  const winningTokenId = String(crypto.randomInt(1_000_000, 9_999_999));
  const losingTokenId = String(crypto.randomInt(1_000_000, 9_999_999));
  const oldSoldTokenId = String(crypto.randomInt(1_000_000, 9_999_999));
  const oldMarkerTokenId = String(crypto.randomInt(1_000_000, 9_999_999));
  const redemptionCreatedAt = "2026-06-28T19:27:49.000Z";
  const flattenedAt = "2026-06-28T19:27:51.000Z";
  const oldSoldAt = "2026-06-28T18:00:00.000Z";

  try {
    await insertResolvedPolymarketMarket({
      marketId: redeemedMarketId,
      yesTokenId: winningTokenId,
      noTokenId: losingTokenId,
      resolvedOutcome: "YES",
    });
    await insertResolvedPolymarketMarket({
      marketId: oldSoldMarketId,
      yesTokenId: oldSoldTokenId,
      noTokenId: oldMarkerTokenId,
      resolvedOutcome: "YES",
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
        values
          ($1, $2, 'polymarket', 'own', $3, 'FLAT', 0, 0.92, 0, 0.086956, $6::timestamptz, $6::timestamptz, $6::timestamptz),
          ($1, $2, 'polymarket', 'own', $4, 'FLAT', 0, 0.29, 0, -0.99999946, $6::timestamptz, $6::timestamptz, $6::timestamptz),
          ($1, $2, 'polymarket', 'own', $5, 'FLAT', 0, 0.4, 0, -0.25, $7::timestamptz, $7::timestamptz, $7::timestamptz)
      `,
      [
        userId,
        walletAddress,
        winningTokenId,
        losingTokenId,
        oldSoldTokenId,
        flattenedAt,
        oldSoldAt,
      ],
    );

    await pool.query(
      `
        insert into notifications (
          user_id,
          type,
          title,
          body,
          severity,
          data,
          dedupe_key,
          created_at,
          updated_at
        )
        values
          (
            $1,
            'redemption_completed',
            'Redemption completed',
            'Polymarket redemption',
            'success',
            jsonb_build_object(
              'venue', 'polymarket',
              'tokenId', $2::text,
              'marketId', $3::text,
              'walletAddress', $4::text
            ),
            $5,
            $7::timestamptz,
            $7::timestamptz
          ),
          (
            $1,
            'redemption_completed',
            'Redemption completed',
            'Polymarket redemption',
            'success',
            jsonb_build_object(
              'venue', 'polymarket',
              'tokenId', $6::text,
              'marketId', $8::text,
              'walletAddress', $4::text
            ),
            $9,
            $7::timestamptz,
            $7::timestamptz
          )
      `,
      [
        userId,
        winningTokenId,
        redeemedMarketId,
        walletAddress,
        `redemption:test:${crypto.randomUUID()}`,
        oldMarkerTokenId,
        redemptionCreatedAt,
        oldSoldMarketId,
        `redemption:test:${crypto.randomUUID()}`,
      ],
    );

    const defaultPositions = await fetchPositionsForUserWallet(pool, {
      userId,
      walletAddresses: [walletAddress],
      venue: "polymarket",
      includeHidden: true,
      minSize: 0,
    });
    assert.deepEqual(defaultPositions, []);

    const resolvedPositions = await fetchPositionsForUserWallet(pool, {
      userId,
      walletAddresses: [walletAddress],
      venue: "polymarket",
      includeHidden: true,
      includeResolved: true,
      minSize: 1,
    });
    assert.deepEqual(
      resolvedPositions
        .map((position) => position.tokenId)
        .sort((a, b) => a.localeCompare(b)),
      [losingTokenId, winningTokenId].sort((a, b) => a.localeCompare(b)),
    );
    const positionsByToken = new Map(
      resolvedPositions.map((position) => [position.tokenId, position]),
    );
    assertClose(
      positionsByToken.get(winningTokenId)?.realizedPnl ?? 0,
      0.086956,
    );
    assertClose(
      positionsByToken.get(losingTokenId)?.realizedPnl ?? 0,
      -0.99999946,
    );
    assert.equal(positionsByToken.has(oldSoldTokenId), false);

    const byToken = await fetchPositionsForUserWalletByTokenIds(pool, {
      userId,
      walletAddresses: [walletAddress],
      tokenIds: [winningTokenId, losingTokenId, oldSoldTokenId],
      venue: "polymarket",
      includeHidden: true,
      includeResolved: true,
      minSize: 1,
    });
    assert.deepEqual(
      byToken
        .map((position) => position.tokenId)
        .sort((a, b) => a.localeCompare(b)),
      [losingTokenId, winningTokenId].sort((a, b) => a.localeCompare(b)),
    );
  } finally {
    await cleanupPositionTest(
      userId,
      [winningTokenId, losingTokenId, oldSoldTokenId, oldMarkerTokenId],
      [redeemedMarketId, oldSoldMarketId],
    );
  }
});

await test("includeResolved maps Limitless scoped positions to raw market tokens", async () => {
  const walletAddress = randomEvmAddress();
  const rawTokenId = String(crypto.randomInt(1_000_000, 9_999_999));
  const scopedTokenId = `limitless:${rawTokenId}`;
  const marketId = `limitless-test:${crypto.randomUUID()}`;
  const userId = await createTestUser();

  try {
    await insertResolvedLimitlessMarket({
      marketId,
      tokenId: rawTokenId,
      outcomeSide: "YES",
      resolvedOutcome: "YES",
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
        values ($1, $2, 'limitless', 'own', $3, 'FLAT', 0, 0.4, 0, 0.6, now(), now(), now())
      `,
      [userId, walletAddress, scopedTokenId],
    );

    await pool.query(
      `
        insert into notifications (
          user_id,
          type,
          title,
          body,
          severity,
          data,
          dedupe_key
        )
        values (
          $1,
          'redemption_completed',
          'Redemption completed',
          'Limitless redemption',
          'success',
          jsonb_build_object(
            'venue', 'limitless',
            'tokenId', $2::text,
            'walletAddress', $3::text
          ),
          $4
        )
      `,
      [
        userId,
        scopedTokenId,
        walletAddress,
        `redemption:test:${crypto.randomUUID()}`,
      ],
    );

    const positions = await fetchPositionsForUserWallet(pool, {
      userId,
      walletAddresses: [walletAddress],
      venue: "limitless",
      includeHidden: true,
      includeResolved: true,
      minSize: 1,
    });
    assert.deepEqual(
      positions.map((position) => position.tokenId),
      [scopedTokenId],
    );

    const byToken = await fetchPositionsForUserWalletByTokenIds(pool, {
      userId,
      walletAddresses: [walletAddress],
      tokenIds: [rawTokenId],
      venue: "limitless",
      includeHidden: true,
      includeResolved: true,
      minSize: 1,
    });
    assert.deepEqual(
      byToken.map((position) => position.tokenId),
      [scopedTokenId],
    );

    const marketRows = await fetchMarketsByTokenIds(pool, {
      tokenIds: [scopedTokenId],
      venue: "limitless",
      includeTop: false,
    });
    assert.equal(marketRows.length, 1);
    assert.equal(marketRows[0]?.token_id, scopedTokenId);
    assert.equal(marketRows[0]?.market_id, marketId);
  } finally {
    await cleanupPositionTest(
      userId,
      [scopedTokenId, rawTokenId, `other-${rawTokenId}`],
      [marketId],
    );
  }
});

await test("markets by token supports Limitless variants without polymarket widening", async () => {
  const rawToScopedTokenId = String(crypto.randomInt(10_000_000, 99_999_999));
  const scopedToRawTokenId = String(crypto.randomInt(10_000_000, 99_999_999));
  const scopedMarketId = `limitless-test:${crypto.randomUUID()}`;
  const rawMarketId = `limitless-test:${crypto.randomUUID()}`;
  const userId = await createTestUser();

  try {
    await insertResolvedLimitlessMarket({
      marketId: scopedMarketId,
      tokenId: `limitless:${rawToScopedTokenId}`,
      outcomeSide: "YES",
      resolvedOutcome: "YES",
    });
    await insertResolvedLimitlessMarket({
      marketId: rawMarketId,
      tokenId: scopedToRawTokenId,
      outcomeSide: "NO",
      resolvedOutcome: "NO",
    });

    const limitlessRows = await fetchMarketsByTokenIds(pool, {
      tokenIds: [rawToScopedTokenId, `limitless:${scopedToRawTokenId}`],
      venue: "limitless",
      includeTop: false,
    });
    const marketsByToken = new Map(
      limitlessRows.map((row) => [row.token_id, row.market_id]),
    );
    assert.equal(marketsByToken.get(rawToScopedTokenId), scopedMarketId);
    assert.equal(
      marketsByToken.get(`limitless:${scopedToRawTokenId}`),
      rawMarketId,
    );

    const polymarketRows = await fetchMarketsByTokenIds(pool, {
      tokenIds: [rawToScopedTokenId],
      venue: "polymarket",
      includeTop: false,
    });
    assert.deepEqual(polymarketRows, []);
  } finally {
    await cleanupPositionTest(
      userId,
      [
        rawToScopedTokenId,
        `limitless:${rawToScopedTokenId}`,
        `other-limitless:${rawToScopedTokenId}`,
        scopedToRawTokenId,
        `limitless:${scopedToRawTokenId}`,
        `other-${scopedToRawTokenId}`,
      ],
      [scopedMarketId, rawMarketId],
    );
  }
});

await test("includeResolved returns Kalshi flat resolved rows with meaningful pnl only", async () => {
  const walletAddress = `kalshi-wallet-${crypto.randomUUID()}`;
  const resolvedWinTokenId = `sol:${crypto.randomUUID()}`;
  const resolvedZeroTokenId = `sol:${crypto.randomUUID()}`;
  const hiddenZeroTokenId = `sol:${crypto.randomUUID()}`;
  const unresolvedTokenId = `sol:${crypto.randomUUID()}`;
  const resolvedWinMarketId = `kalshi-test:${crypto.randomUUID()}`;
  const resolvedZeroMarketId = `kalshi-test:${crypto.randomUUID()}`;
  const hiddenZeroMarketId = `kalshi-test:${crypto.randomUUID()}`;
  const unresolvedMarketId = `kalshi-test:${crypto.randomUUID()}`;
  const userId = await createTestUser();

  try {
    await insertKalshiMarket({
      marketId: resolvedWinMarketId,
      tokenId: resolvedWinTokenId,
      outcomeSide: "YES",
      resolvedOutcome: "YES",
    });
    await insertKalshiMarket({
      marketId: resolvedZeroMarketId,
      tokenId: resolvedZeroTokenId,
      outcomeSide: "YES",
      resolvedOutcome: "YES",
    });
    await insertKalshiMarket({
      marketId: hiddenZeroMarketId,
      tokenId: hiddenZeroTokenId,
      outcomeSide: "NO",
      resolvedOutcome: "NO",
    });
    await insertKalshiMarket({
      marketId: unresolvedMarketId,
      tokenId: unresolvedTokenId,
      outcomeSide: "YES",
      resolvedOutcome: null,
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
        values
          ($1, $2, 'kalshi', 'own', $3, 'FLAT', 0, 0.4, 0, 0.75, false, null, null, now(), now(), now()),
          ($1, $2, 'kalshi', 'own', $4, 'FLAT', 0, 0.4, 0, 0, false, null, null, now(), now(), now()),
          ($1, $2, 'kalshi', 'own', $5, 'FLAT', 0, 0.4, 0, 0, true, 'user', now(), now(), now(), now()),
          ($1, $2, 'kalshi', 'own', $6, 'FLAT', 0, 0.4, 0, 0.5, false, null, null, now(), now(), now())
      `,
      [
        userId,
        walletAddress,
        resolvedWinTokenId,
        resolvedZeroTokenId,
        hiddenZeroTokenId,
        unresolvedTokenId,
      ],
    );

    const defaultPositions = await fetchPositionsForUserWallet(pool, {
      userId,
      walletAddresses: [walletAddress],
      venue: "kalshi",
      includeHidden: true,
      minSize: 0,
    });
    assert.deepEqual(defaultPositions, []);

    const resolvedPositions = await fetchPositionsForUserWallet(pool, {
      userId,
      walletAddresses: [walletAddress],
      venue: "kalshi",
      includeHidden: true,
      includeResolved: true,
      minSize: 1,
    });
    assert.deepEqual(
      new Set(resolvedPositions.map((position) => position.tokenId)),
      new Set([resolvedWinTokenId, hiddenZeroTokenId]),
    );
    assertClose(
      resolvedPositions.find(
        (position) => position.tokenId === resolvedWinTokenId,
      )?.realizedPnl ?? 0,
      0.75,
    );

    const visibleResolvedPositions = await fetchPositionsForUserWallet(pool, {
      userId,
      walletAddresses: [walletAddress],
      venue: "kalshi",
      includeResolved: true,
      minSize: 1,
    });
    assert.deepEqual(
      visibleResolvedPositions.map((position) => position.tokenId),
      [resolvedWinTokenId],
    );

    const byToken = await fetchPositionsForUserWalletByTokenIds(pool, {
      userId,
      walletAddresses: [walletAddress],
      tokenIds: [
        resolvedWinTokenId,
        resolvedZeroTokenId,
        hiddenZeroTokenId,
        unresolvedTokenId,
      ],
      venue: "kalshi",
      includeHidden: true,
      includeResolved: true,
      minSize: 1,
    });
    assert.deepEqual(
      new Set(byToken.map((position) => position.tokenId)),
      new Set([resolvedWinTokenId, hiddenZeroTokenId]),
    );
  } finally {
    await cleanupPositionTest(
      userId,
      [
        resolvedWinTokenId,
        `other-${resolvedWinTokenId}`,
        resolvedZeroTokenId,
        `other-${resolvedZeroTokenId}`,
        hiddenZeroTokenId,
        `other-${hiddenZeroTokenId}`,
        unresolvedTokenId,
        `other-${unresolvedTokenId}`,
      ],
      [
        resolvedWinMarketId,
        resolvedZeroMarketId,
        hiddenZeroMarketId,
        unresolvedMarketId,
      ],
    );
  }
});

await test("resolved open position list pnl matches summary effective pnl", async () => {
  const walletAddress = randomEvmAddress();
  const tokenId = `limitless:${crypto.randomInt(1_000_000, 9_999_999)}`;
  const marketId = `limitless-test:${crypto.randomUUID()}`;
  const userId = await createTestUser();

  try {
    await insertResolvedLimitlessMarket({
      marketId,
      tokenId,
      outcomeSide: "YES",
      resolvedOutcome: "YES",
    });
    await insertLimitlessPosition({
      userId,
      walletAddress,
      tokenId,
      size: 2,
      averagePrice: 0.4,
      realizedPnl: 0.25,
    });

    const summary = await fetchPositionPnlSummaryForUserWallet(pool, {
      userId,
      walletAddresses: [walletAddress],
      venue: "limitless",
    });
    assertClose(summary.realizedPnlAllTime, 1.45);
    assertClose(summary.unrealizedPnlCurrent, 0);

    const positions = await fetchPositionsForUserWallet(pool, {
      userId,
      walletAddresses: [walletAddress],
      venue: "limitless",
      includeHidden: true,
      minSize: 0,
    });
    assert.equal(positions.length, 1);
    assertClose(positions[0]?.realizedPnl ?? 0, 1.45);
    assertClose(positions[0]?.unrealizedPnl ?? 0, 0);

    const byToken = await fetchPositionsForUserWalletByTokenIds(pool, {
      userId,
      walletAddresses: [walletAddress],
      tokenIds: [tokenId],
      venue: "limitless",
      includeHidden: true,
      minSize: 0,
    });
    assert.equal(byToken.length, 1);
    assertClose(byToken[0]?.realizedPnl ?? 0, 1.45);
    assertClose(byToken[0]?.unrealizedPnl ?? 0, 0);
  } finally {
    await cleanupPositionTest(
      userId,
      [tokenId, `other-${tokenId}`],
      [marketId],
    );
  }
});

await test("resolved winning balance sync flatten materializes payout pnl", async () => {
  const walletAddress = randomEvmAddress();
  const tokenId = `limitless:${crypto.randomInt(1_000_000, 9_999_999)}`;
  const marketId = `limitless-test:${crypto.randomUUID()}`;
  const userId = await createTestUser();

  try {
    await insertResolvedLimitlessMarket({
      marketId,
      tokenId,
      outcomeSide: "YES",
      resolvedOutcome: "YES",
    });
    await insertLimitlessPosition({
      userId,
      walletAddress,
      tokenId,
      size: 2,
      averagePrice: 0.4,
      realizedPnl: 0.25,
    });

    const result = await syncWalletPositionsFromTokenBalances(pool, {
      userId,
      walletAddress,
      venue: "limitless",
      tokenBalances: [],
      tokenIdLike: "limitless:%",
    });
    assert.equal(result.flattenedPositions, 1);

    const flatRow = await pool.query<{
      side: string;
      size: string;
      realized_pnl: string | null;
      unrealized_pnl: string | null;
    }>(
      `
        select side, size::text, realized_pnl::text, unrealized_pnl::text
        from positions
        where user_id = $1 and wallet_address = $2 and token_id = $3
      `,
      [userId, walletAddress, tokenId],
    );

    assert.equal(flatRow.rows[0]?.side, "FLAT");
    assert.equal(Number(flatRow.rows[0]?.size), 0);
    assertClose(Number(flatRow.rows[0]?.realized_pnl), 1.45);
    assertClose(Number(flatRow.rows[0]?.unrealized_pnl), 0);

    const summary = await fetchPositionPnlSummaryForUserWallet(pool, {
      userId,
      walletAddresses: [walletAddress],
      venue: "limitless",
    });
    assertClose(summary.realizedPnlAllTime, 1.45);
    assertClose(summary.unrealizedPnlCurrent, 0);
  } finally {
    await cleanupPositionTest(
      userId,
      [tokenId, `other-${tokenId}`],
      [marketId],
    );
  }
});

await test("resolved losing exact balance flatten survives post-reconcile recompute", async () => {
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
    await insertLimitlessPosition({
      userId,
      walletAddress,
      tokenId,
      size: 3,
      averagePrice: 0.2,
      realizedPnl: 0,
    });

    const result = await reconcileExactPositionBalance(pool, {
      userId,
      walletAddress,
      venue: "limitless",
      tokenId,
      size: 0,
      averagePrice: 0.2,
    });
    assert.equal(result.applied, true);

    const flatRow = await pool.query<{
      side: string;
      size: string;
      average_price: string | null;
      realized_pnl: string | null;
      unrealized_pnl: string | null;
    }>(
      `
        select
          side,
          size::text,
          average_price::text,
          realized_pnl::text,
          unrealized_pnl::text
        from positions
        where user_id = $1 and wallet_address = $2 and token_id = $3
      `,
      [userId, walletAddress, tokenId],
    );

    assert.equal(flatRow.rows[0]?.side, "FLAT");
    assert.equal(Number(flatRow.rows[0]?.size), 0);
    assert.equal(flatRow.rows[0]?.average_price, null);
    assertClose(Number(flatRow.rows[0]?.realized_pnl), -0.6);
    assertClose(Number(flatRow.rows[0]?.unrealized_pnl), 0);

    await updatePositionMetrics(pool, {
      userId,
      walletAddress,
      venue: "limitless",
      metrics: [
        {
          tokenId,
          averagePrice: null,
          realizedPnl: 0,
          unrealizedPnl: 0,
        },
      ],
    });

    const recomputedFlatRow = await pool.query<{
      realized_pnl: string | null;
      unrealized_pnl: string | null;
    }>(
      `
        select realized_pnl::text, unrealized_pnl::text
        from positions
        where user_id = $1 and wallet_address = $2 and token_id = $3
      `,
      [userId, walletAddress, tokenId],
    );
    assertClose(Number(recomputedFlatRow.rows[0]?.realized_pnl), -0.6);
    assertClose(Number(recomputedFlatRow.rows[0]?.unrealized_pnl), 0);

    const summary = await fetchPositionPnlSummaryForUserWallet(pool, {
      userId,
      walletAddresses: [walletAddress],
      venue: "limitless",
    });
    assertClose(summary.realizedPnlAllTime, -0.6);
    assertClose(summary.unrealizedPnlCurrent, 0);
  } finally {
    await cleanupPositionTest(
      userId,
      [tokenId, `other-${tokenId}`],
      [marketId],
    );
  }
});

await test("unresolved balance sync flatten preserves existing raw pnl fields", async () => {
  const walletAddress = randomEvmAddress();
  const tokenId = `limitless:${crypto.randomInt(1_000_000, 9_999_999)}`;
  const marketId = `limitless-test:${crypto.randomUUID()}`;
  const userId = await createTestUser();

  try {
    await insertLimitlessToken(tokenId, marketId, "YES");
    await insertLimitlessPosition({
      userId,
      walletAddress,
      tokenId,
      size: 1.5,
      averagePrice: 0.4,
      realizedPnl: 0.2,
      unrealizedPnl: 0.7,
    });

    const result = await syncWalletPositionsFromTokenBalances(pool, {
      userId,
      walletAddress,
      venue: "limitless",
      tokenBalances: [],
      tokenIdLike: "limitless:%",
    });
    assert.equal(result.flattenedPositions, 1);

    const flatRow = await pool.query<{
      side: string;
      size: string;
      realized_pnl: string | null;
      unrealized_pnl: string | null;
    }>(
      `
        select side, size::text, realized_pnl::text, unrealized_pnl::text
        from positions
        where user_id = $1 and wallet_address = $2 and token_id = $3
      `,
      [userId, walletAddress, tokenId],
    );

    assert.equal(flatRow.rows[0]?.side, "FLAT");
    assert.equal(Number(flatRow.rows[0]?.size), 0);
    assertClose(Number(flatRow.rows[0]?.realized_pnl), 0.2);
    assertClose(Number(flatRow.rows[0]?.unrealized_pnl), 0.7);
  } finally {
    await cleanupPositionTest(userId, [tokenId]);
  }
});

await test("unresolved flat metrics refresh can replace stale realized pnl", async () => {
  const walletAddress = randomEvmAddress();
  const tokenId = `limitless:${crypto.randomInt(1_000_000, 9_999_999)}`;
  const marketId = `limitless-test:${crypto.randomUUID()}`;
  const userId = await createTestUser();

  try {
    await insertLimitlessToken(tokenId, marketId);
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
          'FLAT',
          0,
          null,
          0,
          2.5,
          now(),
          now(),
          now()
        )
      `,
      [userId, walletAddress, tokenId],
    );

    await updatePositionMetrics(pool, {
      userId,
      walletAddress,
      venue: "limitless",
      metrics: [
        {
          tokenId,
          averagePrice: null,
          realizedPnl: 0,
          unrealizedPnl: 0,
        },
      ],
    });

    const flatRow = await pool.query<{ realized_pnl: string | null }>(
      `
        select realized_pnl::text
        from positions
        where user_id = $1 and wallet_address = $2 and token_id = $3
      `,
      [userId, walletAddress, tokenId],
    );
    assertClose(Number(flatRow.rows[0]?.realized_pnl), 0);
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
    assert.equal(
      notificationRow.rows[0]?.body,
      "The market resolved against your side",
    );
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

    const notification = await createResolvedPositionNotificationIfVisible(
      pool,
      {
        userId,
        position: selectedPosition,
        resolvedOutcome: "NO",
        outcomeSide: "YES",
      },
    );

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

await Promise.race([
  pool.end(),
  new Promise<void>((resolve) => setTimeout(resolve, 1000)),
]);
process.exit(0);
