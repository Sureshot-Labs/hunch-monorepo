#!/usr/bin/env tsx

import assert from "node:assert/strict";
import crypto from "node:crypto";

import { AuthService } from "./auth.js";
import { buildApp } from "./app.js";
import { pool } from "./db.js";

type TestContext = {
  userId: string;
  authHeaders: Record<string, string>;
  createdWallets: Array<{ address: string; chain: "polygon" | "solana" }>;
  createdMarketIds: string[];
  createdEventIds: string[];
};

type TestWalletChain = TestContext["createdWallets"][number]["chain"];

function randomEmail(): string {
  return `wallet-private-${crypto.randomUUID()}@example.com`;
}

function randomEvmAddress(): string {
  return `0x${crypto.randomBytes(20).toString("hex")}`;
}

function withMixedEvmCase(address: string): string {
  return `0x${address.slice(2, 12).toUpperCase()}${address.slice(12)}`;
}

function randomSolanaLikeAddress(): string {
  const alphabet =
    "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  return Array.from(
    { length: 44 },
    () => alphabet[crypto.randomInt(alphabet.length)],
  ).join("");
}

async function loadWhaleTagId(): Promise<string> {
  const result = await pool.query<{ id: string }>(
    "select id from wallet_tags where slug = 'whale'",
  );
  const id = result.rows[0]?.id;
  assert.ok(id, "wallet_tags must include the whale system tag");
  return id;
}

async function createWhaleFixtureWallet(
  context: TestContext,
  inputs: {
    address: string;
    chain: TestWalletChain;
    metadata?: Record<string, unknown>;
    volumeUsd?: number;
    pnlUsd?: number;
    roi?: number;
    trades30d?: number;
    winRate30d?: number;
    exposureUsd?: number;
    netImbalanceUsd?: number;
    inferredWins?: number;
    inferredTotal?: number;
  },
): Promise<string> {
  const walletResult = await pool.query<{ id: string }>(
    `
      insert into wallets (address, chain, metadata, last_seen_at)
      values ($1, $2, $3, now())
      on conflict (address, chain)
      do update set
        metadata = excluded.metadata,
        last_seen_at = now(),
        updated_at = now()
      returning id
    `,
    [inputs.address, inputs.chain, inputs.metadata ?? null],
  );
  const walletId = walletResult.rows[0]?.id;
  assert.ok(walletId);
  context.createdWallets.push({
    address: inputs.address,
    chain: inputs.chain,
  });

  if (inputs.volumeUsd != null) {
    const whaleTagId = await loadWhaleTagId();
    await pool.query(
      `
        insert into wallet_tag_map (wallet_id, tag_id, source)
        values ($1, $2, 'test')
        on conflict (wallet_id, tag_id)
        do nothing
      `,
      [walletId, whaleTagId],
    );
    await pool.query(
      `
        insert into wallet_intel_selector_snapshot (
          wallet_id,
          metrics_as_of,
          metrics_volume_30d,
          metrics_pnl_30d,
          metrics_roi_30d,
          metrics_trades_30d,
          metrics_win_rate_30d,
          exposure_usd,
          net_imbalance_usd,
          last_activity_at,
          updated_at
        )
        values ($1, now(), $2, $3, $4, $5, $6, $7, $8, now(), now())
        on conflict (wallet_id)
        do update set
          metrics_as_of = excluded.metrics_as_of,
          metrics_volume_30d = excluded.metrics_volume_30d,
          metrics_pnl_30d = excluded.metrics_pnl_30d,
          metrics_roi_30d = excluded.metrics_roi_30d,
          metrics_trades_30d = excluded.metrics_trades_30d,
          metrics_win_rate_30d = excluded.metrics_win_rate_30d,
          exposure_usd = excluded.exposure_usd,
          net_imbalance_usd = excluded.net_imbalance_usd,
          last_activity_at = excluded.last_activity_at,
          updated_at = excluded.updated_at
      `,
      [
        walletId,
        inputs.volumeUsd,
        inputs.pnlUsd ?? 0,
        inputs.roi ?? 0,
        inputs.trades30d ?? 1,
        inputs.winRate30d ?? null,
        inputs.exposureUsd ?? 0,
        inputs.netImbalanceUsd ?? 0,
      ],
    );
    if (inputs.inferredTotal != null) {
      await pool.query(
        `
          insert into wallet_inferred_outcomes (wallet_id, wins, total, updated_at)
          values ($1, $2, $3, now())
          on conflict (wallet_id)
          do update set
            wins = excluded.wins,
            total = excluded.total,
            updated_at = excluded.updated_at
        `,
        [walletId, inputs.inferredWins ?? 0, inputs.inferredTotal],
      );
    }
    await pool.query(
      `
        insert into wallet_activity_hourly (
          wallet_id,
          venue,
          market_id,
          outcome_side,
          activity_type,
          hour_bucket,
          last_occurred_at
        )
        values ($1, 'polymarket', 'wallet-private-routes-test', 'YES', 'trade', date_trunc('hour', now()), now())
        on conflict (wallet_id, venue, market_id, outcome_side, activity_type, hour_bucket)
        do update set last_occurred_at = excluded.last_occurred_at
      `,
      [walletId],
    );
  }

  return walletId;
}

async function createWalletMarketFixture(
  context: TestContext,
  inputs: {
    suffix: string;
    category: string;
  },
): Promise<{ eventId: string; marketId: string }> {
  const eventId = `wallet-routes-event-${inputs.suffix}`;
  const marketId = `polymarket:wallet-routes-market-${inputs.suffix}`;
  await pool.query(
    `
      insert into unified_events (
        id,
        venue,
        venue_event_id,
        title,
        category,
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
        $1, 'polymarket', $2, 'Wallet routes test event', $3, 'ACTIVE',
        now() - interval '1 day', now() + interval '30 days',
        1000, 100, 500, $4, now(), now()
      )
    `,
    [eventId, eventId, inputs.category, `${eventId}-slug`],
  );
  await pool.query(
    `
      insert into unified_markets (
        id,
        venue,
        venue_market_id,
        event_id,
        title,
        category,
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
        slug,
        metadata,
        created_at,
        updated_at
      )
      values (
        $1, 'polymarket', $2, $3, 'Wallet routes test market', $4, 'ACTIVE',
        'binary', now() - interval '1 day', now() + interval '30 days',
        now() + interval '30 days', 0.42, 0.45, 0.43,
        1000, 100, 500, 50, '["Yes","No"]', $5, '{}'::jsonb, now(), now()
      )
    `,
    [marketId, marketId, eventId, inputs.category, `${marketId}-slug`],
  );
  context.createdEventIds.push(eventId);
  context.createdMarketIds.push(marketId);
  return { eventId, marketId };
}

async function createTestUser(): Promise<{
  userId: string;
  authHeaders: Record<string, string>;
}> {
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

  const token = AuthService.generateToken(userId);
  const userAgent = "wallet-private-routes-tests";
  const session = await AuthService.createSession(
    userId,
    randomEvmAddress(),
    token,
    "127.0.0.1",
    userAgent,
  );

  return {
    userId,
    authHeaders: {
      authorization: `Bearer ${token}`,
      "x-csrf-token": session.csrfToken,
      "user-agent": userAgent,
    },
  };
}

async function assertPrivateWalletTablesExist(): Promise<void> {
  const result = await pool.query<{
    wallet_user_names: string | null;
    wallet_user_labels: string | null;
    wallet_user_notes: string | null;
  }>(`
    select
      to_regclass('public.wallet_user_names')::text as wallet_user_names,
      to_regclass('public.wallet_user_labels')::text as wallet_user_labels,
      to_regclass('public.wallet_user_notes')::text as wallet_user_notes
  `);
  const row = result.rows[0];
  assert.equal(
    row?.wallet_user_names,
    "wallet_user_names",
    "wallet_user_names migration must be applied before running route tests",
  );
  assert.equal(
    row?.wallet_user_labels,
    "wallet_user_labels",
    "wallet_user_labels migration must be applied before running route tests",
  );
  assert.equal(
    row?.wallet_user_notes,
    "wallet_user_notes",
    "wallet_user_notes migration must be applied before running route tests",
  );
}

async function cleanup(context: TestContext): Promise<void> {
  await pool.query("delete from user_sessions where user_id = $1", [
    context.userId,
  ]);
  await pool.query("delete from users where id = $1", [context.userId]);
  for (const wallet of context.createdWallets) {
    await pool.query("delete from wallets where address = $1 and chain = $2", [
      wallet.address,
      wallet.chain,
    ]);
  }
  if (context.createdMarketIds.length) {
    await pool.query("delete from unified_markets where id = any($1::text[])", [
      context.createdMarketIds,
    ]);
  }
  if (context.createdEventIds.length) {
    await pool.query("delete from unified_events where id = any($1::text[])", [
      context.createdEventIds,
    ]);
  }
}

async function main() {
  await assertPrivateWalletTablesExist();
  const app = await buildApp();
  const { userId, authHeaders } = await createTestUser();
  const context: TestContext = {
    userId,
    authHeaders,
    createdWallets: [],
    createdMarketIds: [],
    createdEventIds: [],
  };

  try {
    const unknownAddress = randomEvmAddress();

    {
      const response = await app.inject({
        method: "GET",
        url: `/wallets/private/${unknownAddress}?chain=polygon`,
        headers: authHeaders,
      });
      assert.equal(response.statusCode, 200);
      const body = response.json();
      assert.equal(body.ok, true);
      assert.equal(body.wallet.walletId, null);
      assert.equal(body.followed, false);
      assert.equal(body.userName, null);
      assert.equal(body.userLabel, null);
      assert.equal(body.userLabelColor, null);
      assert.deepEqual(body.notes, []);
    }

    {
      const before = await pool.query<{ count: string }>(
        "select count(*)::text as count from wallets where address = $1 and chain = $2",
        [unknownAddress, "polygon"],
      );
      const response = await app.inject({
        method: "PATCH",
        url: `/wallets/private/${unknownAddress}?chain=polygon`,
        headers: {
          ...authHeaders,
          "content-type": "application/json",
        },
        payload: { label: null },
      });
      assert.equal(response.statusCode, 200);
      const body = response.json();
      assert.equal(body.wallet.walletId, null);
      assert.equal(body.userName, null);
      assert.equal(body.userLabel, null);
      assert.equal(body.userLabelColor, null);
      const after = await pool.query<{ count: string }>(
        "select count(*)::text as count from wallets where address = $1 and chain = $2",
        [unknownAddress, "polygon"],
      );
      assert.equal(after.rows[0]?.count, before.rows[0]?.count);
    }

    const labeledAddress = randomEvmAddress();
    let labeledWalletId: string;
    {
      const response = await app.inject({
        method: "PATCH",
        url: `/wallets/private/${labeledAddress}?chain=polygon`,
        headers: {
          ...authHeaders,
          "content-type": "application/json",
        },
        payload: { label: "My test whale" },
      });
      assert.equal(response.statusCode, 200);
      const body = response.json();
      assert.equal(body.ok, true);
      assert.equal(body.followed, false);
      assert.equal(body.userName, null);
      assert.equal(body.userLabel, "My test whale");
      assert.equal(body.userLabelColor, null);
      labeledWalletId = body.wallet.walletId;
      assert.ok(labeledWalletId);
      context.createdWallets.push({
        address: labeledAddress,
        chain: "polygon",
      });
    }

    {
      const response = await app.inject({
        method: "PATCH",
        url: `/wallets/private/${labeledAddress}?chain=polygon`,
        headers: {
          ...authHeaders,
          "content-type": "application/json",
        },
        payload: { labelColor: "green" },
      });
      assert.equal(response.statusCode, 200);
      const body = response.json();
      assert.equal(body.userLabel, "My test whale");
      assert.equal(body.userLabelColor, "green");
    }

    {
      const response = await app.inject({
        method: "PATCH",
        url: `/wallets/private/${randomEvmAddress()}?chain=polygon`,
        headers: {
          ...authHeaders,
          "content-type": "application/json",
        },
        payload: { labelColor: "gold" },
      });
      assert.equal(response.statusCode, 400);
      assert.match(response.body, /Label color requires an existing label/);
    }

    {
      const forcedLastSeen = new Date("2024-01-02T03:04:05.000Z");
      await pool.query("update wallets set last_seen_at = $2 where id = $1", [
        labeledWalletId,
        forcedLastSeen,
      ]);

      const response = await app.inject({
        method: "PATCH",
        url: `/wallets/private/${labeledAddress}?chain=polygon`,
        headers: {
          ...authHeaders,
          "content-type": "application/json",
        },
        payload: { name: "Custom whale", label: "Renamed whale" },
      });
      assert.equal(response.statusCode, 200);
      const body = response.json();
      assert.equal(body.userName, "Custom whale");
      assert.equal(body.userLabel, "Renamed whale");
      assert.equal(body.userLabelColor, "green");

      const wallet = await pool.query<{ last_seen_at: Date }>(
        "select last_seen_at from wallets where id = $1",
        [labeledWalletId],
      );
      assert.equal(
        wallet.rows[0]?.last_seen_at.toISOString(),
        forcedLastSeen.toISOString(),
      );
    }

    {
      const response = await app.inject({
        method: "GET",
        url: `/wallets/private/${labeledAddress}?chain=polygon`,
        headers: authHeaders,
      });
      assert.equal(response.statusCode, 200);
      const body = response.json();
      assert.equal(body.userName, "Custom whale");
      assert.equal(body.userLabel, "Renamed whale");
      assert.equal(body.userLabelColor, "green");
      assert.deepEqual(body.notes, []);
    }

    {
      const response = await app.inject({
        method: "GET",
        url: `/wallets/resolve/${labeledAddress}?chain=polygon`,
      });
      assert.equal(response.statusCode, 200);
      const body = response.json();
      assert.equal(body.ok, true);
      assert.equal(body.wallet?.walletId, labeledWalletId);
      assert.equal(body.wallet?.followed, false);
      assert.equal(body.wallet?.userName, null);
      assert.equal(body.wallet?.userLabel, null);
      assert.equal(body.wallet?.userLabelColor, null);
      assert.equal(body.matches.length, 1);
    }

    {
      const response = await app.inject({
        method: "GET",
        url: `/wallets/${labeledWalletId}`,
      });
      assert.equal(response.statusCode, 200);
      const body = response.json();
      assert.equal(body.ok, true);
      assert.equal(body.wallet.walletId, labeledWalletId);
      assert.equal(body.wallet.userName, null);
      assert.equal(body.wallet.userLabel, null);
      assert.equal(body.wallet.userLabelColor, null);
    }

    {
      const response = await app.inject({
        method: "GET",
        url: `/wallets/${labeledWalletId}/series`,
      });
      assert.equal(response.statusCode, 200);
      const body = response.json();
      assert.equal(body.ok, true);
      assert.equal(body.walletId, labeledWalletId);
    }

    {
      const response = await app.inject({
        method: "GET",
        url: "/wallets/activity/summary/stats",
      });
      assert.equal(response.statusCode, 200);
      const body = response.json();
      assert.equal(body.ok, true);
      assert.equal(body.stats.trackedWallets, null);
      assert.equal(body.stats.trackedPnl30d, null);
    }

    {
      const response = await app.inject({
        method: "GET",
        url: "/wallets/activity/summary/stats",
        headers: authHeaders,
      });
      assert.equal(response.statusCode, 200);
      const body = response.json();
      assert.equal(body.ok, true);
      assert.equal(body.stats.trackedWallets, 0);
      assert.equal(body.stats.trackedPnl30d, null);
    }

    {
      const trackedStatsAddress = randomEvmAddress();
      const trackedStatsWalletId = await createWhaleFixtureWallet(context, {
        address: trackedStatsAddress,
        chain: "polygon",
        volumeUsd: 1_000,
        pnlUsd: 12_345,
        roi: 0.12,
        trades30d: 12,
      });
      await pool.query(
        `
          insert into wallet_follows (user_id, wallet_id)
          values ($1, $2)
          on conflict (user_id, wallet_id)
          do nothing
        `,
        [userId, trackedStatsWalletId],
      );

      const response = await app.inject({
        method: "GET",
        url: "/wallets/activity/summary/stats?windowHours=2",
        headers: authHeaders,
      });
      assert.equal(response.statusCode, 200);
      const body = response.json();
      assert.equal(body.ok, true);
      assert.equal(body.stats.trackedWallets, 1);
      assert.equal(body.stats.trackedPnl30d, 12_345);
      assert.equal(typeof body.stats.totalPnl30d, "number");
    }

    {
      const response = await app.inject({
        method: "GET",
        url: "/wallets/activity/summary/stats",
        headers: {
          authorization: "Bearer invalid-token",
        },
      });
      assert.equal(response.statusCode, 200);
      const body = response.json();
      assert.equal(body.ok, true);
      assert.equal(body.stats.trackedWallets, null);
      assert.equal(body.stats.trackedPnl30d, null);
    }

    {
      const response = await app.inject({
        method: "GET",
        url: "/wallets/whales?limit=5&offset=0",
      });
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().ok, true);
    }

    {
      const response = await app.inject({
        method: "GET",
        url: "/wallets/whales?limit=5&offset=0",
        headers: {
          authorization: "Bearer invalid-token",
        },
      });
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().ok, true);
    }

    {
      const linkedOwnerAddress = randomEvmAddress();
      const linkedProxyAddress = randomEvmAddress();
      await createWhaleFixtureWallet(context, {
        address: linkedOwnerAddress,
        chain: "polygon",
      });
      await createWhaleFixtureWallet(context, {
        address: linkedProxyAddress,
        chain: "polygon",
        metadata: {
          linkedOwnerAddress: withMixedEvmCase(linkedOwnerAddress),
        },
        volumeUsd: 999_000_000_000_000,
      });

      const safeAddress = randomEvmAddress();
      const safeOwnerAddress = randomEvmAddress();
      await createWhaleFixtureWallet(context, {
        address: safeOwnerAddress,
        chain: "polygon",
        metadata: {
          kind: "safe_owner",
          derivedFrom: safeAddress,
        },
      });
      await createWhaleFixtureWallet(context, {
        address: safeAddress,
        chain: "polygon",
        metadata: { kind: "safe" },
        volumeUsd: 998_000_000_000_000,
      });

      const solanaLinkedOwnerAddress = randomSolanaLikeAddress();
      const solanaProxyAddress = randomSolanaLikeAddress();
      await createWhaleFixtureWallet(context, {
        address: solanaLinkedOwnerAddress.toLowerCase(),
        chain: "solana",
      });
      await createWhaleFixtureWallet(context, {
        address: solanaProxyAddress,
        chain: "solana",
        metadata: {
          linkedOwnerAddress: solanaLinkedOwnerAddress,
        },
        volumeUsd: 997_000_000_000_000,
      });

      const response = await app.inject({
        method: "GET",
        url: "/wallets/whales?limit=100&offset=0&sort=volume_30d&windowDays=30&includeSummary=false&includeAttribution=false",
      });
      assert.equal(response.statusCode, 200);
      const body = response.json() as {
        ok: boolean;
        wallets: Array<{ address: string; ownerAddress: string | null }>;
      };
      assert.equal(body.ok, true);
      const byAddress = new Map<string, { ownerAddress: string | null }>(
        body.wallets.map((wallet) => [wallet.address, wallet]),
      );

      assert.equal(
        byAddress.get(linkedProxyAddress)?.ownerAddress,
        linkedOwnerAddress,
      );
      assert.equal(
        byAddress.get(safeAddress)?.ownerAddress,
        safeOwnerAddress,
      );
      assert.equal(byAddress.get(solanaProxyAddress)?.ownerAddress, null);
    }

    {
      const roiLeaderAddress = randomEvmAddress();
      const lowQualityAddress = randomEvmAddress();
      await createWhaleFixtureWallet(context, {
        address: roiLeaderAddress,
        chain: "polygon",
        volumeUsd: 250_000,
        pnlUsd: 25_000,
        roi: 0.18,
        trades30d: 80,
        winRate30d: 0.7,
        exposureUsd: 10_000,
        netImbalanceUsd: 1_000,
        inferredWins: 35,
        inferredTotal: 50,
      });
      await createWhaleFixtureWallet(context, {
        address: lowQualityAddress,
        chain: "polygon",
        volumeUsd: 240_000,
        pnlUsd: 500,
        roi: 0.01,
        trades30d: 5,
        winRate30d: 0.2,
        exposureUsd: 250_000,
        netImbalanceUsd: 200_000,
        inferredWins: 1,
        inferredTotal: 5,
      });

      const response = await app.inject({
        method: "GET",
        url: "/wallets/whales?limit=20&offset=0&sort=roi_30d&minTrades30d=50&minResolvedCount=30&minPnl30d=10000&minRoi30d=0.05&minWinRate30d=0.6&maxExposureUsd=50000&maxNetImbalanceUsd=10000&includeAttribution=false",
      });
      assert.equal(response.statusCode, 200);
      const body = response.json() as {
        ok: boolean;
        wallets: Array<{ address: string; metrics?: { roi?: number | null } }>;
      };
      assert.equal(body.ok, true);
      const addresses = body.wallets.map((wallet) =>
        wallet.address.toLowerCase(),
      );
      assert.equal(addresses.includes(roiLeaderAddress.toLowerCase()), true);
      assert.equal(addresses.includes(lowQualityAddress.toLowerCase()), false);
    }

    {
      const response = await app.inject({
        method: "GET",
        url: "/wallets/activity/summary?scope=whales&limit=5&offset=0",
      });
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().ok, true);
    }

    {
      const response = await app.inject({
        method: "GET",
        url: "/wallets/activity/summary?scope=following&limit=5&offset=0",
      });
      assert.equal(response.statusCode, 401);
      assert.match(
        response.body,
        /Authentication required for following scope/,
      );
    }

    {
      const response = await app.inject({
        method: "GET",
        url: `/wallets/activity/signals?walletId=${labeledWalletId}&limit=5&offset=0`,
      });
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().ok, true);
    }

    {
      const response = await app.inject({
        method: "GET",
        url: "/wallets/activity/signals?limit=5&offset=0",
      });
      assert.equal(response.statusCode, 401);
      assert.match(
        response.body,
        /Authentication required for following scope/,
      );
    }

    {
      const response = await app.inject({
        method: "GET",
        url: `/wallets/activity?walletId=${labeledWalletId}&limit=5&offset=0`,
      });
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().ok, true);
    }

    {
      const suffix = crypto.randomUUID().slice(0, 8);
      const category = `wallet-routes-category-${suffix}`;
      const matching = await createWalletMarketFixture(context, {
        suffix: `${suffix}-match`,
        category,
      });
      const other = await createWalletMarketFixture(context, {
        suffix: `${suffix}-other`,
        category: `${category}-other`,
      });
      const snapshotAt = new Date();

      await pool.query(
        `
          insert into wallet_activity_events (
            wallet_id,
            venue,
            market_id,
            outcome_side,
            action,
            delta_shares,
            size_usd,
            price,
            activity_type,
            source,
            metadata,
            occurred_at
          )
          values
            ($1, 'polymarket', $2, 'YES', 'BUY', 20, 250, 0.42, 'delta', 'snapshot_delta', '{"prevShares":0,"currShares":20}'::jsonb, $3),
            ($1, 'polymarket', $4, 'NO', 'SELL', -5, 20, 0.2, 'delta', 'snapshot_delta', '{"prevShares":10,"currShares":5}'::jsonb, $5),
            ($1, 'polymarket', $2, 'NO', 'SELL', -12, null, 0.42, 'delta', 'snapshot_delta', '{"prevShares":20,"currShares":8}'::jsonb, $6)
        `,
        [
          labeledWalletId,
          matching.marketId,
          new Date(snapshotAt.getTime() - 1_000),
          other.marketId,
          new Date(snapshotAt.getTime() - 2_000),
          new Date(snapshotAt.getTime() - 3_000),
        ],
      );
      await pool.query(
        `
          insert into wallet_position_snapshots (
            wallet_id,
            venue,
            market_id,
            outcome_side,
            shares,
            size_usd,
            price,
            metadata,
            snapshot_at
          )
          values
            ($1, 'polymarket', $2, 'YES', 20, 250, 0.42, '{}'::jsonb, $3),
            ($1, 'polymarket', $4, 'NO', 5, 20, 0.2, '{}'::jsonb, $3)
        `,
        [labeledWalletId, matching.marketId, snapshotAt, other.marketId],
      );

      const activityResponse = await app.inject({
        method: "GET",
        url: `/wallets/activity?walletId=${labeledWalletId}&marketId=${encodeURIComponent(matching.marketId)}&eventId=${encodeURIComponent(matching.eventId)}&category=${encodeURIComponent(category)}&outcomeSide=YES&action=BUY&changeAction=OPENED&minSizeUsd=100&minDeltaShares=10&marketStatus=ACTIVE&acceptingOrders=true&limit=10&offset=0`,
      });
      assert.equal(activityResponse.statusCode, 200);
      const activityBody = activityResponse.json() as {
        ok: boolean;
        items: Array<{
          marketId: string;
          eventId: string | null;
          outcomeSide: string | null;
          changeAction: string | null;
        }>;
      };
      assert.equal(activityBody.ok, true);
      assert.equal(activityBody.items.length, 1);
      assert.equal(activityBody.items[0]?.marketId, matching.marketId);
      assert.equal(activityBody.items[0]?.eventId, matching.eventId);
      assert.equal(activityBody.items[0]?.outcomeSide, "YES");
      assert.equal(activityBody.items[0]?.changeAction, "OPENED");

      const reducedActivityResponse = await app.inject({
        method: "GET",
        url: `/wallets/activity?walletId=${labeledWalletId}&marketId=${encodeURIComponent(matching.marketId)}&outcomeSide=NO&action=SELL&changeAction=REDUCED&minDeltaShares=10&marketStatus=OPEN&limit=10&offset=0`,
      });
      assert.equal(reducedActivityResponse.statusCode, 200);
      const reducedActivityBody = reducedActivityResponse.json() as {
        ok: boolean;
        items: Array<{
          marketId: string;
          outcomeSide: string | null;
          changeAction: string | null;
          deltaShares: number | null;
        }>;
      };
      assert.equal(reducedActivityBody.ok, true);
      assert.equal(reducedActivityBody.items.length, 1);
      assert.equal(reducedActivityBody.items[0]?.marketId, matching.marketId);
      assert.equal(reducedActivityBody.items[0]?.outcomeSide, "NO");
      assert.equal(reducedActivityBody.items[0]?.changeAction, "REDUCED");
      assert.equal(reducedActivityBody.items[0]?.deltaShares, -12);

      const marketActivityResponse = await app.inject({
        method: "GET",
        url: `/markets/${encodeURIComponent(matching.marketId)}/wallet-activity?outcomeSide=YES&action=BUY&changeAction=OPENED&minSizeUsd=100&minDeltaShares=10&limit=10&offset=0`,
      });
      assert.equal(marketActivityResponse.statusCode, 200);
      const marketActivityBody = marketActivityResponse.json() as {
        ok: boolean;
        marketId: string;
        items: Array<{ marketId: string }>;
      };
      assert.equal(marketActivityBody.ok, true);
      assert.equal(marketActivityBody.marketId, matching.marketId);
      assert.equal(marketActivityBody.items.length, 1);
      assert.equal(marketActivityBody.items[0]?.marketId, matching.marketId);

      const positionResponse = await app.inject({
        method: "GET",
        url: `/wallets/positions?walletId=${labeledWalletId}&marketId=${encodeURIComponent(matching.marketId)}&eventId=${encodeURIComponent(matching.eventId)}&category=${encodeURIComponent(category)}&outcomeSide=YES&marketStatus=OPEN&acceptingOrders=true&minSizeUsd=100&limit=10&offset=0`,
      });
      assert.equal(positionResponse.statusCode, 200);
      const positionBody = positionResponse.json() as {
        ok: boolean;
        items: Array<{ marketId: string; outcomeSide: string | null }>;
      };
      assert.equal(positionBody.ok, true);
      assert.equal(positionBody.items.length, 1);
      assert.equal(positionBody.items[0]?.marketId, matching.marketId);
      assert.equal(positionBody.items[0]?.outcomeSide, "YES");

      await pool.query(
        `
          insert into wallet_follows (user_id, wallet_id)
          values ($1, $2)
          on conflict (user_id, wallet_id)
          do nothing
        `,
        [userId, labeledWalletId],
      );
      await pool.query(
        `
          insert into wallet_position_snapshots (
            wallet_id,
            venue,
            market_id,
            outcome_side,
            shares,
            size_usd,
            price,
            metadata,
            snapshot_at
          )
          values ($1, 'polymarket', $2, 'NO', 5, 20, 0.2, '{}'::jsonb, $3)
        `,
        [
          labeledWalletId,
          other.marketId,
          new Date(snapshotAt.getTime() + 1_000),
        ],
      );

      const followedCurrentPositionResponse = await app.inject({
        method: "GET",
        url: `/wallets/positions?marketId=${encodeURIComponent(matching.marketId)}&limit=10&offset=0`,
        headers: authHeaders,
      });
      assert.equal(followedCurrentPositionResponse.statusCode, 200);
      const followedCurrentPositionBody =
        followedCurrentPositionResponse.json() as {
          ok: boolean;
          items: Array<{ marketId: string }>;
        };
      assert.equal(followedCurrentPositionBody.ok, true);
      assert.equal(followedCurrentPositionBody.items.length, 0);
      await pool.query(
        "delete from wallet_follows where user_id = $1 and wallet_id = $2",
        [userId, labeledWalletId],
      );
    }

    {
      const response = await app.inject({
        method: "GET",
        url: "/wallets/activity?limit=5&offset=0",
      });
      assert.equal(response.statusCode, 401);
      assert.match(
        response.body,
        /Authentication required when walletId is omitted/,
      );
    }

    {
      const response = await app.inject({
        method: "GET",
        url: `/wallets/positions?walletId=${labeledWalletId}&limit=5&offset=0`,
      });
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().ok, true);
    }

    {
      const response = await app.inject({
        method: "GET",
        url: "/wallets/positions?limit=5&offset=0",
      });
      assert.equal(response.statusCode, 401);
      assert.match(
        response.body,
        /Authentication required when walletId is omitted/,
      );
    }

    {
      const response = await app.inject({
        method: "GET",
        url: `/wallets/positions/history?walletId=${labeledWalletId}&limit=5&offset=0`,
      });
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().ok, true);
    }

    {
      const response = await app.inject({
        method: "PATCH",
        url: `/wallets/private/${labeledAddress}?chain=polygon`,
        headers: {
          ...authHeaders,
          "content-type": "application/json",
        },
        payload: { label: null },
      });
      assert.equal(response.statusCode, 200);
      const body = response.json();
      assert.equal(body.userName, "Custom whale");
      assert.equal(body.userLabel, null);
      assert.equal(body.userLabelColor, null);
    }

    {
      const response = await app.inject({
        method: "PATCH",
        url: `/wallets/private/${labeledAddress}?chain=polygon`,
        headers: {
          ...authHeaders,
          "content-type": "application/json",
        },
        payload: { label: "Renamed whale again", labelColor: "pink" },
      });
      assert.equal(response.statusCode, 200);
      const body = response.json();
      assert.equal(body.userName, "Custom whale");
      assert.equal(body.userLabel, "Renamed whale again");
      assert.equal(body.userLabelColor, "pink");
    }

    {
      const followResponse = await app.inject({
        method: "POST",
        url: "/wallets/follow",
        headers: {
          ...authHeaders,
          "content-type": "application/json",
        },
        payload: {
          address: labeledAddress,
          chain: "polygon",
        },
      });
      assert.equal(followResponse.statusCode, 201);

      const profileResponse = await app.inject({
        method: "GET",
        url: `/wallets/${labeledWalletId}`,
        headers: authHeaders,
      });
      assert.equal(profileResponse.statusCode, 200);
      const profileBody = profileResponse.json();
      assert.equal(profileBody.wallet.userName, "Custom whale");
      assert.equal(profileBody.wallet.userLabel, "Renamed whale again");
      assert.equal(profileBody.wallet.userLabelColor, "pink");
      assert.equal(profileBody.wallet.followersCount, 1);

      const unfollowResponse = await app.inject({
        method: "DELETE",
        url: `/wallets/follow/${labeledAddress}?chain=polygon`,
        headers: authHeaders,
      });
      assert.equal(unfollowResponse.statusCode, 200);

      const response = await app.inject({
        method: "GET",
        url: `/wallets/private/${labeledAddress}?chain=polygon`,
        headers: authHeaders,
      });
      assert.equal(response.statusCode, 200);
      const body = response.json();
      assert.equal(body.followed, false);
      assert.equal(body.userName, "Custom whale");
      assert.equal(body.userLabel, "Renamed whale again");
      assert.equal(body.userLabelColor, "pink");
    }

    {
      const response = await app.inject({
        method: "PATCH",
        url: `/wallets/follow/${labeledAddress}?chain=polygon`,
        headers: {
          ...authHeaders,
          "content-type": "application/json",
        },
        payload: { label: "Follow-only label" },
      });
      assert.equal(response.statusCode, 404);
    }

    {
      const invalidSolana = "not-a-solana-address";
      const response = await app.inject({
        method: "PATCH",
        url: `/wallets/private/${invalidSolana}?chain=solana`,
        headers: {
          ...authHeaders,
          "content-type": "application/json",
        },
        payload: { label: "Nope" },
      });
      assert.equal(response.statusCode, 400);
      assert.match(response.body, /Invalid Solana wallet address/);
    }

    const notesAddress = randomEvmAddress();
    let noteId: string;
    {
      const response = await app.inject({
        method: "POST",
        url: `/wallets/private/${notesAddress}/notes?chain=polygon`,
        headers: {
          ...authHeaders,
          "content-type": "application/json",
        },
        payload: { note: "First note" },
      });
      assert.equal(response.statusCode, 201);
      const body = response.json();
      assert.equal(body.ok, true);
      noteId = body.note.id;
      assert.ok(noteId);
      context.createdWallets.push({ address: notesAddress, chain: "polygon" });
    }

    {
      const response = await app.inject({
        method: "GET",
        url: `/wallets/private/${notesAddress}?chain=polygon`,
        headers: authHeaders,
      });
      assert.equal(response.statusCode, 200);
      const body = response.json();
      assert.equal(body.notes.length, 1);
      assert.equal(body.notes[0]?.note, "First note");
    }

    {
      const followResponse = await app.inject({
        method: "POST",
        url: "/wallets/follow",
        headers: {
          ...authHeaders,
          "content-type": "application/json",
        },
        payload: {
          address: notesAddress,
          chain: "polygon",
        },
      });
      assert.equal(followResponse.statusCode, 201);

      const unfollowResponse = await app.inject({
        method: "DELETE",
        url: `/wallets/follow/${notesAddress}?chain=polygon`,
        headers: authHeaders,
      });
      assert.equal(unfollowResponse.statusCode, 200);

      const response = await app.inject({
        method: "GET",
        url: `/wallets/private/${notesAddress}?chain=polygon`,
        headers: authHeaders,
      });
      assert.equal(response.statusCode, 200);
      const body = response.json();
      assert.equal(body.followed, false);
      assert.equal(body.notes.length, 1);
      assert.equal(body.notes[0]?.note, "First note");
    }

    {
      const response = await app.inject({
        method: "PATCH",
        url: `/wallets/private/${notesAddress}/notes/${noteId}?chain=polygon`,
        headers: {
          ...authHeaders,
          "content-type": "application/json",
        },
        payload: { note: "Updated note" },
      });
      assert.equal(response.statusCode, 200);
      const body = response.json();
      assert.equal(body.note.note, "Updated note");
    }

    {
      const response = await app.inject({
        method: "DELETE",
        url: `/wallets/private/${notesAddress}/notes/${noteId}?chain=polygon`,
        headers: authHeaders,
      });
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().ok, true);
    }

    {
      const response = await app.inject({
        method: "GET",
        url: `/wallets/private/${notesAddress}?chain=polygon`,
        headers: authHeaders,
      });
      assert.equal(response.statusCode, 200);
      const body = response.json();
      assert.deepEqual(body.notes, []);
    }
  } finally {
    await cleanup(context);
    await app.close();
  }
}

await main();
