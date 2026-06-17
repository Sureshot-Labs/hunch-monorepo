#!/usr/bin/env tsx

import assert from "node:assert/strict";
import crypto from "node:crypto";

import { AuthService, resetAuthDbFeatureCachesForTests } from "./auth.js";
import { buildApp } from "./app.js";
import { pool } from "./db.js";

type TestContext = {
  userId: string;
  walletAddress: string;
  authHeaders: Record<string, string>;
};

type MarketFixture = {
  eventId: string;
  marketId: string;
  yesTokenId: string;
  noTokenId: string;
};

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
  return `share-routes-${crypto.randomUUID()}@example.com`;
}

function randomEvmAddress(): string {
  return `0x${crypto.randomBytes(20).toString("hex")}`;
}

function randomCode(prefix: string): string {
  return `${prefix}${crypto.randomBytes(3).toString("hex")}`.toUpperCase();
}

async function ensureShareSnapshotsTableForTests(): Promise<void> {
  await pool.query(`
    create table if not exists share_snapshots (
      id text primary key,
      kind text not null check (kind in ('portfolio_pnl', 'trade_pnl')),
      user_id uuid references users(id) on delete set null,
      referral_code text,
      snapshot jsonb not null,
      schema_version integer not null default 1,
      created_at timestamptz not null default now(),
      expires_at timestamptz
    )
  `);
}

async function createTestContext(): Promise<TestContext> {
  const walletAddress = randomEvmAddress();
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
    [userId, walletAddress],
  );

  const token = AuthService.generateToken(userId);
  const userAgent = "share-routes-tests";
  const session = await AuthService.createSession(
    userId,
    walletAddress,
    token,
    "127.0.0.1",
    userAgent,
  );

  return {
    userId,
    walletAddress,
    authHeaders: {
      authorization: `Bearer ${token}`,
      "user-agent": userAgent,
      "x-csrf-token": session.csrfToken,
    },
  };
}

async function createReferralCode(
  userId: string | null,
  code: string,
): Promise<void> {
  const policy = await pool.query<{ id: string }>(
    `
      insert into referral_code_policies (policy_type, owner_user_id)
      values ($1, $2)
      returning id
    `,
    [userId ? "user" : "campaign", userId],
  );
  await pool.query(
    `
      insert into referral_codes (code, policy_id, is_active)
      values ($1, $2, true)
    `,
    [code, policy.rows[0].id],
  );
  if (userId) {
    await pool.query("update users set referral_code = $2 where id = $1", [
      userId,
      code,
    ]);
  }
}

async function insertMarketFixture(
  prefix: string,
  venue = "limitless",
): Promise<MarketFixture> {
  const eventId = `share-event-${prefix}-${crypto.randomUUID()}`;
  const marketId = `share-market-${prefix}-${crypto.randomUUID()}`;
  const yesTokenId = `share-token-yes-${prefix}-${crypto.randomUUID()}`;
  const noTokenId = `share-token-no-${prefix}-${crypto.randomUUID()}`;

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
        image,
        created_at,
        updated_at
      )
      values (
        $1,
        $5,
        $1,
        $2,
        'ACTIVE',
        now() - interval '1 day',
        now() + interval '1 day',
        0,
        0,
        0,
        $3,
        $4,
        now(),
        now()
      )
    `,
    [
      eventId,
      `Share event ${prefix}`,
      `slug-${eventId}`,
      `https://img/${eventId}.png`,
      venue,
    ],
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
        image,
        created_at,
        updated_at
      )
      values (
        $1,
        $8,
        $1,
        $2,
        $3,
        'ACTIVE',
        'binary',
        now() - interval '1 day',
        now() + interval '1 day',
        now() + interval '1 day',
        0.54,
        0.56,
        0.55,
        0,
        0,
        0,
        0,
        '["Yes","No"]',
        $4,
        $5,
        $6,
        $7,
        now(),
        now()
      )
    `,
    [
      marketId,
      eventId,
      `Share market ${prefix}`,
      yesTokenId,
      noTokenId,
      `slug-${marketId}`,
      `https://img/${marketId}.png`,
      venue,
    ],
  );

  await pool.query(
    `
      insert into unified_tokens(token_id, venue, market_id, side)
      values
        ($1, $4, $3, 'YES'),
        ($2, $4, $3, 'NO')
    `,
    [yesTokenId, noTokenId, marketId, venue],
  );
  await pool.query(
    `
      insert into unified_market_tokens(token_id, venue, market_id, outcome_side)
      values
        ($1, $4, $3, 'YES'),
        ($2, $4, $3, 'NO')
    `,
    [yesTokenId, noTokenId, marketId, venue],
  );

  return { eventId, marketId, yesTokenId, noTokenId };
}

async function insertPosition(inputs: {
  context: TestContext;
  tokenId: string;
  walletAddress?: string;
  venue?: string;
  size: number;
  averagePrice: number | null;
  realizedPnl: number;
  unrealizedPnl: number;
  side?: "LONG" | "FLAT";
}): Promise<string> {
  const inserted = await pool.query<{ id: string }>(
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
        $9,
        'own',
        $3,
        $4,
        $5,
        $6,
        $7,
        $8,
        now(),
        now(),
        now()
      )
      returning id
    `,
    [
      inputs.context.userId,
      inputs.walletAddress ?? inputs.context.walletAddress,
      inputs.tokenId,
      inputs.side ?? "LONG",
      inputs.size,
      inputs.averagePrice,
      inputs.unrealizedPnl,
      inputs.realizedPnl,
      inputs.venue ?? "limitless",
    ],
  );
  const id = inserted.rows[0]?.id;
  assert.ok(id);
  return id;
}

async function cleanup(contexts: TestContext[], fixtures: MarketFixture[]) {
  const userIds = contexts.map((context) => context.userId);
  const eventIds = fixtures.map((fixture) => fixture.eventId);
  const marketIds = fixtures.map((fixture) => fixture.marketId);
  const tokenIds = fixtures.flatMap((fixture) => [
    fixture.yesTokenId,
    fixture.noTokenId,
  ]);

  if (userIds.length) {
    await pool.query("delete from share_snapshots where user_id = any($1::uuid[])", [
      userIds,
    ]);
    await pool.query("delete from positions where user_id = any($1::uuid[])", [
      userIds,
    ]);
    await pool.query("delete from user_sessions where user_id = any($1::uuid[])", [
      userIds,
    ]);
    await pool.query(
      "delete from user_venue_credentials where user_id = any($1::uuid[])",
      [userIds],
    );
    await pool.query("delete from user_wallets where user_id = any($1::uuid[])", [
      userIds,
    ]);
    await pool.query(
      `
        with deleted_codes as (
          delete from referral_codes rc
          using referral_code_policies p
          where rc.policy_id = p.id
            and (
              p.owner_user_id = any($1::uuid[])
              or rc.code like 'SHT%'
              or rc.code like 'SHARETEST%'
            )
          returning rc.policy_id
        )
        delete from referral_code_policies p
        where p.owner_user_id = any($1::uuid[])
           or p.id in (select policy_id from deleted_codes)
      `,
      [userIds],
    );
    await pool.query("delete from users where id = any($1::uuid[])", [userIds]);
  }
  if (tokenIds.length) {
    await pool.query(
      "delete from unified_market_tokens where token_id = any($1::text[])",
      [tokenIds],
    );
    await pool.query("delete from unified_tokens where token_id = any($1::text[])", [
      tokenIds,
    ]);
  }
  if (marketIds.length) {
    await pool.query("delete from unified_markets where id = any($1::text[])", [
      marketIds,
    ]);
  }
  if (eventIds.length) {
    await pool.query("delete from unified_events where id = any($1::text[])", [
      eventIds,
    ]);
  }
}

function assertNoPrivateFields(payload: unknown, context: TestContext): void {
  const serialized = JSON.stringify(payload);
  assert.equal(serialized.includes(context.userId), false);
  assert.equal(serialized.includes(context.walletAddress), false);
  assert.equal(serialized.includes("walletAddress"), false);
  assert.equal(serialized.includes("userId"), false);
}

async function main() {
  resetAuthDbFeatureCachesForTests();
  await ensureShareSnapshotsTableForTests();
  const app = await buildApp();

  await test("portfolio share is server-computed and public-redacted", async () => {
    const context = await createTestContext();
    const fixtureA = await insertMarketFixture("portfolio-a");
    const fixtureB = await insertMarketFixture("portfolio-b");
    const referralCode = randomCode("SHT");
    try {
      await createReferralCode(context.userId, referralCode);
      const lowPnlPositionId = await insertPosition({
        context,
        tokenId: fixtureA.yesTokenId,
        size: 10,
        averagePrice: 0.5,
        realizedPnl: 0,
        unrealizedPnl: 1,
      });
      assert.ok(lowPnlPositionId);
      const topPositionId = await insertPosition({
        context,
        tokenId: fixtureB.yesTokenId,
        size: 4,
        averagePrice: 0.4,
        realizedPnl: 3,
        unrealizedPnl: -0.5,
      });

      const createResponse = await app.inject({
        method: "POST",
        url: "/shares/portfolio-pnl",
        headers: context.authHeaders,
        payload: {
          source: "portfolio",
          snapshot: { realizedPnlCents: 999999 },
        },
      });

      assert.equal(createResponse.statusCode, 200);
      const payload = createResponse.json();
      assert.match(payload.id, /^pnl_[0-9A-Za-z]{22}$/);
      assert.equal(payload.kind, "portfolio_pnl");
      assert.equal(payload.referralCode, referralCode);
      assert.equal(payload.realizedPnlCents, 300);
      assert.equal(payload.unrealizedPnlCents, 50);
      assert.equal(payload.totalPnlCents, 350);
      assert.equal(payload.topPosition.positionId, topPositionId);
      assertNoPrivateFields(payload, context);

      const publicResponse = await app.inject({
        method: "GET",
        url: `/shares/${payload.id}`,
      });
      assert.equal(publicResponse.statusCode, 200);
      assert.deepEqual(publicResponse.json(), payload);
      assertNoPrivateFields(publicResponse.json(), context);
    } finally {
      await cleanup([context], [fixtureA, fixtureB]);
    }
  });

  await test("portfolio share supports verified top-position override", async () => {
    const context = await createTestContext();
    const fixtureA = await insertMarketFixture("override-a");
    const fixtureB = await insertMarketFixture("override-b");
    const referralCode = randomCode("SHT");
    try {
      await createReferralCode(null, referralCode);
      const requestedPositionId = await insertPosition({
        context,
        tokenId: fixtureA.yesTokenId,
        size: 10,
        averagePrice: 0.5,
        realizedPnl: 0,
        unrealizedPnl: 0.1,
      });
      await insertPosition({
        context,
        tokenId: fixtureB.yesTokenId,
        size: 10,
        averagePrice: 0.5,
        realizedPnl: 10,
        unrealizedPnl: 0,
      });

      const response = await app.inject({
        method: "POST",
        url: "/shares/portfolio-pnl",
        headers: context.authHeaders,
        payload: {
          source: "portfolio",
          referralCode: referralCode.toLowerCase(),
          topPositionId: requestedPositionId,
        },
      });

      assert.equal(response.statusCode, 200);
      const payload = response.json();
      assert.equal(payload.referralCode, referralCode);
      assert.equal(payload.topPosition.positionId, requestedPositionId);
    } finally {
      await cleanup([context], [fixtureA, fixtureB]);
    }
  });

  await test("portfolio top-position override must stay inside requested venue scope", async () => {
    const context = await createTestContext();
    const scopedFixture = await insertMarketFixture("override-scope-poly", "polymarket");
    const otherVenueFixture = await insertMarketFixture(
      "override-scope-limitless",
      "limitless",
    );
    try {
      await insertPosition({
        context,
        tokenId: scopedFixture.yesTokenId,
        venue: "polymarket",
        size: 10,
        averagePrice: 0.5,
        realizedPnl: 1,
        unrealizedPnl: 1,
      });
      const otherVenuePositionId = await insertPosition({
        context,
        tokenId: otherVenueFixture.yesTokenId,
        venue: "limitless",
        size: 10,
        averagePrice: 0.5,
        realizedPnl: 10,
        unrealizedPnl: 0,
      });

      const response = await app.inject({
        method: "POST",
        url: "/shares/portfolio-pnl",
        headers: context.authHeaders,
        payload: {
          source: "portfolio",
          venue: "polymarket",
          topPositionId: otherVenuePositionId,
        },
      });

      assert.equal(response.statusCode, 404);
    } finally {
      await cleanup([context], [scopedFixture, otherVenueFixture]);
    }
  });

  await test("portfolio share uses expanded Polymarket funder wallet scope", async () => {
    const context = await createTestContext();
    const fixture = await insertMarketFixture("poly-funder-scope", "polymarket");
    const funderAddress = randomEvmAddress();
    try {
      await pool.query(
        `
          insert into user_venue_credentials (
            user_id,
            wallet_address,
            venue,
            api_key,
            api_secret,
            is_active,
            funder_address,
            funder_updated_at
          )
          values ($1, $2, 'polymarket', 'test-key', 'test-secret', true, $3, now())
        `,
        [context.userId, context.walletAddress, funderAddress],
      );
      const funderPositionId = await insertPosition({
        context,
        walletAddress: funderAddress,
        tokenId: fixture.yesTokenId,
        venue: "polymarket",
        size: 10,
        averagePrice: 0.5,
        realizedPnl: 2,
        unrealizedPnl: 3,
      });

      const autoResponse = await app.inject({
        method: "POST",
        url: "/shares/portfolio-pnl",
        headers: context.authHeaders,
        payload: {
          source: "portfolio",
          venue: "polymarket",
        },
      });

      assert.equal(autoResponse.statusCode, 200);
      const autoPayload = autoResponse.json();
      assert.equal(autoPayload.realizedPnlCents, 200);
      assert.equal(autoPayload.unrealizedPnlCents, 300);
      assert.equal(autoPayload.totalPnlCents, 500);
      assert.equal(autoPayload.topPosition.positionId, funderPositionId);
      assertNoPrivateFields(autoPayload, context);

      const explicitResponse = await app.inject({
        method: "POST",
        url: "/shares/portfolio-pnl",
        headers: context.authHeaders,
        payload: {
          source: "portfolio",
          venue: "polymarket",
          topPositionId: funderPositionId,
        },
      });

      assert.equal(explicitResponse.statusCode, 200);
      assert.equal(explicitResponse.json().topPosition.positionId, funderPositionId);
    } finally {
      await cleanup([context], [fixture]);
    }
  });

  await test("share create rejects invalid referral code", async () => {
    const context = await createTestContext();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/shares/portfolio-pnl",
        headers: context.authHeaders,
        payload: {
          source: "portfolio",
          referralCode: "!",
        },
      });
      assert.equal(response.statusCode, 400);
    } finally {
      await cleanup([context], []);
    }
  });

  await test("trade share is position-backed and rejects non-owned positions", async () => {
    const owner = await createTestContext();
    const other = await createTestContext();
    const fixture = await insertMarketFixture("trade-open");
    try {
      const ownerPositionId = await insertPosition({
        context: owner,
        tokenId: fixture.yesTokenId,
        size: 10,
        averagePrice: 0.5,
        realizedPnl: 2,
        unrealizedPnl: 1,
      });
      const otherPositionId = await insertPosition({
        context: other,
        tokenId: fixture.noTokenId,
        size: 5,
        averagePrice: 0.4,
        realizedPnl: 0,
        unrealizedPnl: 1,
      });

      const rejected = await app.inject({
        method: "POST",
        url: "/shares/trade-pnl",
        headers: owner.authHeaders,
        payload: {
          source: "position",
          positionId: otherPositionId,
        },
      });
      assert.equal(rejected.statusCode, 404);

      const accepted = await app.inject({
        method: "POST",
        url: "/shares/trade-pnl",
        headers: owner.authHeaders,
        payload: {
          source: "position",
          positionId: ownerPositionId,
        },
      });
      assert.equal(accepted.statusCode, 200);
      const payload = accepted.json();
      assert.match(payload.id, /^trade_[0-9A-Za-z]{22}$/);
      assert.equal(payload.kind, "trade_pnl");
      assert.equal(payload.source, "position");
      assert.equal(payload.positionId, ownerPositionId);
      assert.equal(payload.positionStatus, "open");
      assert.equal(payload.realizedPnlCents, 200);
      assert.equal(payload.unrealizedPnlCents, 100);
      assert.equal(payload.totalPnlCents, 300);
      assert.equal(payload.pnlPercentBasisPoints, null);
      assertNoPrivateFields(payload, owner);
    } finally {
      await cleanup([owner, other], [fixture]);
    }
  });

  await test("trade share keeps percent for unrealized-only open position", async () => {
    const context = await createTestContext();
    const fixture = await insertMarketFixture("trade-open-percent");
    try {
      const positionId = await insertPosition({
        context,
        tokenId: fixture.yesTokenId,
        size: 10,
        averagePrice: 0.5,
        realizedPnl: 0,
        unrealizedPnl: 1,
      });

      const response = await app.inject({
        method: "POST",
        url: "/shares/trade-pnl",
        headers: context.authHeaders,
        payload: {
          source: "position",
          positionId,
        },
      });
      assert.equal(response.statusCode, 200);
      const payload = response.json();
      assert.equal(payload.positionStatus, "open");
      assert.equal(payload.totalPnlCents, 100);
      assert.equal(payload.pnlPercentBasisPoints, 2000);
    } finally {
      await cleanup([context], [fixture]);
    }
  });

  await test("trade share handles closed position with null percent", async () => {
    const context = await createTestContext();
    const fixture = await insertMarketFixture("trade-closed");
    try {
      const positionId = await insertPosition({
        context,
        tokenId: fixture.yesTokenId,
        size: 0,
        averagePrice: null,
        realizedPnl: 2.5,
        unrealizedPnl: 0,
        side: "FLAT",
      });

      const response = await app.inject({
        method: "POST",
        url: "/shares/trade-pnl",
        headers: context.authHeaders,
        payload: {
          source: "position",
          positionId,
        },
      });
      assert.equal(response.statusCode, 200);
      const payload = response.json();
      assert.equal(payload.positionStatus, "closed");
      assert.equal(payload.totalPnlCents, 250);
      assert.equal(payload.pnlPercentBasisPoints, null);
      assert.equal(payload.closedAt != null, true);
    } finally {
      await cleanup([context], [fixture]);
    }
  });

  await test("unknown public share returns 404", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/shares/pnl_missing",
    });
    assert.equal(response.statusCode, 404);
  });

  await app.close();
}

await main();
