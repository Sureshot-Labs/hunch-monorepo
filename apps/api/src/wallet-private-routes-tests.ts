#!/usr/bin/env tsx

import assert from "node:assert/strict";
import crypto from "node:crypto";

import { AuthService } from "./auth.js";
import { buildApp } from "./app.js";
import { pool } from "./db.js";
import {
  assertSqlParamPlaceholders,
  scoreWalletAddressResolutionCandidate,
} from "./routes/wallet-intel.js";

type TestContext = {
  userId: string;
  authHeaders: Record<string, string>;
  createdWallets: Array<{ address: string; chain: "polygon" | "solana" }>;
  createdMarketIds: string[];
  createdEventIds: string[];
  createdTokenIds: string[];
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
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  return Array.from(
    { length: 44 },
    () => alphabet[crypto.randomInt(alphabet.length)],
  ).join("");
}

function compareScore(left: number[], right: number[]): number {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

function assertAddressResolverScoring() {
  const now = new Date("2026-06-23T12:00:00.000Z");
  const emptyRecent = scoreWalletAddressResolutionCandidate({
    wallet: {
      has_venue: false,
      exposure_usd: null,
      last_activity_at: null,
      metrics_volume_30d: null,
      metrics_trades_30d: null,
      last_seen_at: now,
    },
  });
  const olderWithIntel = scoreWalletAddressResolutionCandidate({
    wallet: {
      has_venue: true,
      exposure_usd: "1000",
      last_activity_at: new Date("2026-06-22T12:00:00.000Z"),
      metrics_volume_30d: "2500",
      metrics_trades_30d: 8,
      last_seen_at: new Date("2026-06-01T12:00:00.000Z"),
    },
  });
  assert.ok(compareScore(olderWithIntel, emptyRecent) > 0);
  const followedEmpty = scoreWalletAddressResolutionCandidate({
    wallet: {
      has_venue: false,
      exposure_usd: null,
      last_activity_at: null,
      metrics_volume_30d: null,
      metrics_trades_30d: null,
      last_seen_at: now,
    },
    privateMeta: {
      followed: true,
      user_name: null,
      user_label: null,
      user_label_color: null,
    },
  });
  assert.ok(compareScore(followedEmpty, olderWithIntel) > 0);
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
    resolvedEdgeSampleCount30d?: number;
    resolvedActualWinRate30d?: number;
    resolvedExpectedWinRate30d?: number;
    resolvedWinRateEdge30d?: number;
    resolvedEdgeZScore30d?: number;
    resolvedBrierScore30d?: number;
    resolvedStakeWeightedEdge30d?: number;
    resolvedStakeUsd30d?: number;
    exposureUsd?: number;
    netImbalanceUsd?: number;
    openPositionsCount?: number;
    openMarketsCount?: number;
    avgOpenPositionSizeUsd?: number;
    avgOpenEntryPrice?: number;
    avgOpenEntryApprox?: boolean;
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
          metrics_resolved_edge_sample_count_30d,
          metrics_resolved_actual_win_rate_30d,
          metrics_resolved_expected_win_rate_30d,
          metrics_resolved_win_rate_edge_30d,
          metrics_resolved_edge_z_score_30d,
          metrics_resolved_brier_score_30d,
          metrics_resolved_stake_weighted_edge_30d,
          metrics_resolved_stake_usd_30d,
          exposure_usd,
          net_imbalance_usd,
          last_activity_at,
          updated_at
        )
        values ($1, now(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, now(), now())
        on conflict (wallet_id)
        do update set
          metrics_as_of = excluded.metrics_as_of,
          metrics_volume_30d = excluded.metrics_volume_30d,
          metrics_pnl_30d = excluded.metrics_pnl_30d,
          metrics_roi_30d = excluded.metrics_roi_30d,
          metrics_trades_30d = excluded.metrics_trades_30d,
          metrics_win_rate_30d = excluded.metrics_win_rate_30d,
          metrics_resolved_edge_sample_count_30d = excluded.metrics_resolved_edge_sample_count_30d,
          metrics_resolved_actual_win_rate_30d = excluded.metrics_resolved_actual_win_rate_30d,
          metrics_resolved_expected_win_rate_30d = excluded.metrics_resolved_expected_win_rate_30d,
          metrics_resolved_win_rate_edge_30d = excluded.metrics_resolved_win_rate_edge_30d,
          metrics_resolved_edge_z_score_30d = excluded.metrics_resolved_edge_z_score_30d,
          metrics_resolved_brier_score_30d = excluded.metrics_resolved_brier_score_30d,
          metrics_resolved_stake_weighted_edge_30d = excluded.metrics_resolved_stake_weighted_edge_30d,
          metrics_resolved_stake_usd_30d = excluded.metrics_resolved_stake_usd_30d,
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
        inputs.resolvedEdgeSampleCount30d ?? null,
        inputs.resolvedActualWinRate30d ?? null,
        inputs.resolvedExpectedWinRate30d ?? null,
        inputs.resolvedWinRateEdge30d ?? null,
        inputs.resolvedEdgeZScore30d ?? null,
        inputs.resolvedBrierScore30d ?? null,
        inputs.resolvedStakeWeightedEdge30d ?? null,
        inputs.resolvedStakeUsd30d ?? null,
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

  if (
    inputs.exposureUsd != null ||
    inputs.netImbalanceUsd != null ||
    inputs.openPositionsCount != null ||
    inputs.openMarketsCount != null ||
    inputs.avgOpenPositionSizeUsd != null ||
    inputs.avgOpenEntryPrice != null ||
    inputs.avgOpenEntryApprox != null
  ) {
    await pool.query(
      `
        insert into wallet_position_exposure (
          wallet_id,
          exposure_usd,
          hedged_notional_usd,
          net_imbalance_usd,
          hedge_ratio,
          two_sided_markets,
          open_positions_count,
          open_markets_count,
          avg_open_position_size_usd,
          avg_open_entry_price,
          avg_open_entry_approx,
          as_of
        )
        values ($1, $2, 0, $3, 0, 0, $4, $5, $6, $7, $8, now())
        on conflict (wallet_id)
        do update set
          exposure_usd = excluded.exposure_usd,
          net_imbalance_usd = excluded.net_imbalance_usd,
          open_positions_count = excluded.open_positions_count,
          open_markets_count = excluded.open_markets_count,
          avg_open_position_size_usd = excluded.avg_open_position_size_usd,
          avg_open_entry_price = excluded.avg_open_entry_price,
          avg_open_entry_approx = excluded.avg_open_entry_approx,
          as_of = excluded.as_of,
          updated_at = now()
      `,
      [
        walletId,
        inputs.exposureUsd ?? 0,
        inputs.netImbalanceUsd ?? 0,
        inputs.openPositionsCount ?? 0,
        inputs.openMarketsCount ?? 0,
        inputs.avgOpenPositionSizeUsd ?? null,
        inputs.avgOpenEntryPrice ?? null,
        inputs.avgOpenEntryApprox ?? null,
      ],
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
        image,
        icon,
        slug,
        created_at,
        updated_at
      )
      values (
        $1, 'polymarket', $2, 'Wallet routes test event', $3, 'ACTIVE',
        now() - interval '1 day', now() + interval '30 days',
        1000, 100, 500, $4, $5, $6, now(), now()
      )
    `,
    [
      eventId,
      eventId,
      inputs.category,
      `https://img.test/${eventId}.png`,
      `https://img.test/${eventId}-icon.png`,
      `${eventId}-slug`,
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
        image,
        icon,
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
        1000, 100, 500, 50, $5, $6, '["Yes","No"]', $7, '{}'::jsonb, now(), now()
      )
    `,
    [
      marketId,
      marketId,
      eventId,
      inputs.category,
      `https://img.test/${marketId}.png`,
      `https://img.test/${marketId}-icon.png`,
      `${marketId}-slug`,
    ],
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
    if (context.createdTokenIds.length) {
      await pool.query(
        "delete from unified_token_top_latest where token_id = any($1::text[])",
        [context.createdTokenIds],
      );
      await pool.query(
        "delete from unified_tokens where token_id = any($1::text[])",
        [context.createdTokenIds],
      );
    }
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
  assertAddressResolverScoring();
  await assertPrivateWalletTablesExist();
  const app = await buildApp();
  const { userId, authHeaders } = await createTestUser();
  const context: TestContext = {
    userId,
    authHeaders,
    createdWallets: [],
    createdMarketIds: [],
    createdEventIds: [],
    createdTokenIds: [],
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
      assert.equal(byAddress.get(safeAddress)?.ownerAddress, safeOwnerAddress);
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
      const edgeLeaderAddress = randomEvmAddress();
      const noisyAddress = randomEvmAddress();
      await createWhaleFixtureWallet(context, {
        address: edgeLeaderAddress,
        chain: "polygon",
        volumeUsd: 120_000,
        pnlUsd: 8_000,
        roi: 0.08,
        trades30d: 40,
        winRate30d: 0.58,
        resolvedEdgeSampleCount30d: 35,
        resolvedActualWinRate30d: 0.62,
        resolvedExpectedWinRate30d: 0.48,
        resolvedWinRateEdge30d: 0.14,
        resolvedEdgeZScore30d: 2.4,
        resolvedBrierScore30d: 0.19,
        resolvedStakeWeightedEdge30d: 0.11,
        resolvedStakeUsd30d: 15_000,
        exposureUsd: 20_000,
        netImbalanceUsd: 2_000,
      });
      await createWhaleFixtureWallet(context, {
        address: noisyAddress,
        chain: "polygon",
        volumeUsd: 130_000,
        pnlUsd: 9_000,
        roi: 0.09,
        trades30d: 50,
        winRate30d: 0.7,
        resolvedEdgeSampleCount30d: 8,
        resolvedActualWinRate30d: 0.7,
        resolvedExpectedWinRate30d: 0.66,
        resolvedWinRateEdge30d: 0.04,
        resolvedEdgeZScore30d: 0.3,
        resolvedBrierScore30d: 0.24,
        resolvedStakeWeightedEdge30d: 0.02,
        resolvedStakeUsd30d: 900,
        exposureUsd: 20_000,
        netImbalanceUsd: 2_000,
      });

      const response = await app.inject({
        method: "GET",
        url: "/wallets/whales?limit=20&offset=0&sort=edge_z_score&minResolvedEdgeSampleCount=20&minResolvedStakeUsd=10000&minResolvedEdgeZScore30d=1&maxResolvedBrierScore30d=0.2&includeAttribution=false",
      });
      assert.equal(response.statusCode, 200);
      const body = response.json() as {
        ok: boolean;
        wallets: Array<{
          address: string;
          metrics?: {
            resolvedEdgeSampleCount?: number | null;
            resolvedEdgeZScore?: number | null;
            resolvedBrierScore?: number | null;
          } | null;
        }>;
      };
      assert.equal(body.ok, true);
      const addresses = body.wallets.map((wallet) =>
        wallet.address.toLowerCase(),
      );
      assert.equal(addresses.includes(edgeLeaderAddress.toLowerCase()), true);
      assert.equal(addresses.includes(noisyAddress.toLowerCase()), false);
      const edgeLeader = body.wallets.find(
        (wallet) =>
          wallet.address.toLowerCase() === edgeLeaderAddress.toLowerCase(),
      );
      assert.equal(edgeLeader?.metrics?.resolvedEdgeSampleCount, 35);
      assert.equal(edgeLeader?.metrics?.resolvedEdgeZScore, 2.4);
      assert.equal(edgeLeader?.metrics?.resolvedBrierScore, 0.19);
    }

    {
      const rollupAddress = randomEvmAddress();
      const rollupWalletId = await createWhaleFixtureWallet(context, {
        address: rollupAddress,
        chain: "polygon",
        volumeUsd: 3_000,
        pnlUsd: 250,
        roi: 0.08,
        trades30d: 9,
        exposureUsd: 1234,
        openPositionsCount: 4,
        openMarketsCount: 3,
        avgOpenPositionSizeUsd: 308.5,
        avgOpenEntryPrice: 0.37,
        avgOpenEntryApprox: true,
      });

      const response = await app.inject({
        method: "GET",
        url: "/wallets/activity/summary?scope=whales&limit=100&offset=0&includeAttribution=false",
      });
      assert.equal(response.statusCode, 200);
      const body = response.json() as {
        ok: boolean;
        items: Array<{
          walletId: string;
          trackedExposureUsd: number | null;
          openPositionsCount: number | null;
          openMarketsCount: number | null;
          avgOpenPositionSizeUsd: number | null;
          avgOpenEntryPrice: number | null;
          avgOpenEntryApprox: boolean | null;
        }>;
      };
      assert.equal(body.ok, true);
      const summaryItem = body.items.find(
        (item) => item.walletId === rollupWalletId,
      );
      assert.ok(summaryItem);
      assert.equal(summaryItem.trackedExposureUsd, 1234);
      assert.equal(summaryItem.openPositionsCount, 4);
      assert.equal(summaryItem.openMarketsCount, 3);
      assert.equal(summaryItem.avgOpenPositionSizeUsd, 308.5);
      assert.equal(summaryItem.avgOpenEntryPrice, 0.37);
      assert.equal(summaryItem.avgOpenEntryApprox, true);

      const profileResponse = await app.inject({
        method: "GET",
        url: `/wallets/${rollupWalletId}`,
      });
      assert.equal(profileResponse.statusCode, 200);
      const profileBody = profileResponse.json() as {
        ok: boolean;
        wallet: {
          trackedExposureUsd: number | null;
          openPositionsCount: number | null;
          openMarketsCount: number | null;
          avgOpenPositionSizeUsd: number | null;
          avgOpenEntryPrice: number | null;
          avgOpenEntryApprox: boolean | null;
        };
      };
      assert.equal(profileBody.ok, true);
      assert.equal(profileBody.wallet.trackedExposureUsd, 1234);
      assert.equal(profileBody.wallet.openPositionsCount, 4);
      assert.equal(profileBody.wallet.openMarketsCount, 3);
      assert.equal(profileBody.wallet.avgOpenPositionSizeUsd, 308.5);
      assert.equal(profileBody.wallet.avgOpenEntryPrice, 0.37);
      assert.equal(profileBody.wallet.avgOpenEntryApprox, true);
    }

    {
      const suffix = crypto.randomUUID().slice(0, 8);
      const category = `summary-search-category-${suffix}`;
      const matching = await createWalletMarketFixture(context, {
        suffix: `${suffix}-summary-match`,
        category,
      });
      const unrelated = await createWalletMarketFixture(context, {
        suffix: `${suffix}-summary-other`,
        category,
      });
      const searchNeedle = `summarysearch${suffix}`;
      await pool.query(
        `
          update unified_markets
          set title = $1
          where id = $2
        `,
        [`Summary ${searchNeedle} market`, matching.marketId],
      );
      await pool.query(
        `
          update unified_events
          set title = $1
          where id = $2
        `,
        [`Summary ${searchNeedle} event`, matching.eventId],
      );
      const matchingWalletId = await createWhaleFixtureWallet(context, {
        address: randomEvmAddress(),
        chain: "polygon",
        volumeUsd: 4_000,
        pnlUsd: 100,
        roi: 0.025,
        trades30d: 11,
      });
      const otherWalletId = await createWhaleFixtureWallet(context, {
        address: randomEvmAddress(),
        chain: "polygon",
        volumeUsd: 4_100,
        pnlUsd: 110,
        roi: 0.026,
        trades30d: 12,
      });
      await pool.query(
        `
          insert into wallet_activity_hourly (
            wallet_id,
            venue,
            market_id,
            outcome_side,
            activity_type,
            hour_bucket,
            signed_delta_usd,
            abs_delta_usd,
            counts_opened,
            last_occurred_at
          )
          values
            ($1, 'polymarket', $2, 'YES', 'trade', date_trunc('hour', now()), 11, 11, 1, now()),
            ($1, 'polymarket', $3, 'NO', 'trade', date_trunc('hour', now()), 7, 7, 1, now()),
            ($4, 'polymarket', $3, 'YES', 'trade', date_trunc('hour', now()), 19, 19, 1, now())
          on conflict (wallet_id, venue, market_id, outcome_side, activity_type, hour_bucket)
          do update set
            signed_delta_usd = excluded.signed_delta_usd,
            abs_delta_usd = excluded.abs_delta_usd,
            counts_opened = excluded.counts_opened,
            last_occurred_at = excluded.last_occurred_at
        `,
        [
          matchingWalletId,
          matching.marketId,
          unrelated.marketId,
          otherWalletId,
        ],
      );

      for (const url of [
        `/wallets/activity/summary?scope=whales&q=${encodeURIComponent(searchNeedle)}&limit=100&offset=0&includeAttribution=false`,
        `/wallets/activity/summary?scope=whales&marketId=${encodeURIComponent(matching.marketId)}&limit=100&offset=0&includeAttribution=false`,
        `/wallets/activity/summary?scope=whales&eventId=${encodeURIComponent(matching.eventId)}&limit=100&offset=0&includeAttribution=false`,
      ]) {
        const response = await app.inject({ method: "GET", url });
        assert.equal(response.statusCode, 200);
        const body = response.json() as {
          ok: boolean;
          items: Array<{ walletId: string; netChangeUsd: number | null }>;
        };
        assert.equal(body.ok, true);
        assert.equal(
          body.items.some((item) => item.walletId === matchingWalletId),
          true,
        );
        assert.equal(
          body.items.some((item) => item.walletId === otherWalletId),
          false,
        );
        const item = body.items.find(
          (candidate) => candidate.walletId === matchingWalletId,
        );
        assert.equal(item?.netChangeUsd, 18);
      }
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
      const searchNeedle = `positioningsearch${suffix}`;
      await pool.query(
        `
          update unified_events
          set title = $1
          where id = $2
        `,
        [`Tracked ${searchNeedle} event`, matching.eventId],
      );
      await pool.query(
        `
          update unified_markets
          set title = $1
          where id = $2
        `,
        [`Tracked ${searchNeedle} market`, matching.marketId],
      );
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
        url: `/wallets/activity?walletId=${labeledWalletId}&marketId=${encodeURIComponent(matching.marketId)}&eventId=${encodeURIComponent(matching.eventId)}&category=${encodeURIComponent(category)}&outcomeSide=YES&action=BUY&changeAction=OPENED&minSizeUsd=100&minDeltaShares=10&marketStatus=ACTIVE&acceptingOrders=true&includePositionNow=true&limit=10&offset=0`,
      });
      assert.equal(activityResponse.statusCode, 200);
      const activityBody = activityResponse.json() as {
        ok: boolean;
        items: Array<{
          marketId: string;
          eventId: string | null;
          outcomeSide: string | null;
          changeAction: string | null;
          positionNow: {
            positionShares: number | null;
            positionSizeUsd: number | null;
          } | null;
        }>;
      };
      assert.equal(activityBody.ok, true);
      assert.equal(activityBody.items.length, 1);
      assert.equal(activityBody.items[0]?.marketId, matching.marketId);
      assert.equal(activityBody.items[0]?.eventId, matching.eventId);
      assert.equal(activityBody.items[0]?.outcomeSide, "YES");
      assert.equal(activityBody.items[0]?.changeAction, "OPENED");
      assert.equal(activityBody.items[0]?.positionNow?.positionShares, 20);
      assert.equal(activityBody.items[0]?.positionNow?.positionSizeUsd, 250);

      const searchedActivityResponse = await app.inject({
        method: "GET",
        url: `/wallets/activity?walletId=${labeledWalletId}&q=${encodeURIComponent(searchNeedle)}&limit=10&offset=0`,
      });
      assert.equal(searchedActivityResponse.statusCode, 200);
      const searchedActivityBody = searchedActivityResponse.json() as {
        ok: boolean;
        items: Array<{ marketId: string }>;
      };
      assert.equal(searchedActivityBody.ok, true);
      assert.ok(searchedActivityBody.items.length > 0);
      assert.ok(
        searchedActivityBody.items.every(
          (item) => item.marketId === matching.marketId,
        ),
      );

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
        url: `/markets/${encodeURIComponent(matching.marketId)}/wallet-activity?outcomeSide=YES&action=BUY&changeAction=OPENED&minSizeUsd=100&minDeltaShares=10&includePositionNow=true&limit=10&offset=0`,
      });
      assert.equal(marketActivityResponse.statusCode, 200);
      const marketActivityBody = marketActivityResponse.json() as {
        ok: boolean;
        marketId: string;
        items: Array<{
          marketId: string;
          positionNow: { positionShares: number | null } | null;
        }>;
      };
      assert.equal(marketActivityBody.ok, true);
      assert.equal(marketActivityBody.marketId, matching.marketId);
      assert.equal(marketActivityBody.items.length, 1);
      assert.equal(marketActivityBody.items[0]?.marketId, matching.marketId);
      assert.equal(
        marketActivityBody.items[0]?.positionNow?.positionShares,
        20,
      );

      const yesWalletId = await createWhaleFixtureWallet(context, {
        address: randomEvmAddress(),
        chain: "polygon",
        volumeUsd: 1_000,
        pnlUsd: 120,
        roi: 0.12,
        trades30d: 10,
        winRate30d: 0.7,
        resolvedEdgeSampleCount30d: 12,
        resolvedWinRateEdge30d: 0.24,
        resolvedEdgeZScore30d: 2.8,
        resolvedBrierScore30d: 0.12,
        resolvedStakeWeightedEdge30d: 0.18,
        resolvedStakeUsd30d: 24_000,
        exposureUsd: 1_000,
        inferredWins: 7,
        inferredTotal: 10,
      });
      const noWalletId = await createWhaleFixtureWallet(context, {
        address: randomEvmAddress(),
        chain: "polygon",
        volumeUsd: 1_200,
        pnlUsd: 80,
        roi: 0.08,
        trades30d: 12,
        winRate30d: 0.6,
        resolvedEdgeSampleCount30d: 3,
        resolvedWinRateEdge30d: 0.01,
        resolvedEdgeZScore30d: 0.1,
        resolvedBrierScore30d: 0.2,
        resolvedStakeWeightedEdge30d: 0.02,
        resolvedStakeUsd30d: 5_000,
        exposureUsd: 1_200,
        inferredWins: 6,
        inferredTotal: 10,
      });
      const yesTokenId = `${matching.marketId}:YES`;
      const noTokenId = `${matching.marketId}:NO`;
      context.createdTokenIds.push(yesTokenId, noTokenId);
      await pool.query(
        `
          insert into unified_tokens (token_id, venue, market_id, side)
          values
            ($1, 'polymarket', $3, 'YES'),
            ($2, 'polymarket', $3, 'NO')
        `,
        [yesTokenId, noTokenId, matching.marketId],
      );
      await pool.query(
        `
          insert into unified_token_top_latest (
            token_id,
            venue,
            ts,
            best_bid,
            best_ask,
            mid,
            spread,
            updated_at
          )
          values
            ($1, 'polymarket', $3, 0.44, 0.46, 0.45, 0.02, $3),
            ($2, 'polymarket', $3, 0.54, 0.56, 0.55, 0.02, $3)
        `,
        [yesTokenId, noTokenId, snapshotAt],
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
            ($1, 'polymarket', $3, 'YES', 10, 250, 0.45, jsonb_build_object('tokenId', $6::text), $5),
            ($2, 'polymarket', $3, 'NO', 12, 300, 0.55, jsonb_build_object('tokenId', $7::text), $5),
            ($1, 'polymarket', $4, 'YES', 8, 90, 0.4, '{}'::jsonb, $5)
        `,
        [
          yesWalletId,
          noWalletId,
          matching.marketId,
          other.marketId,
          snapshotAt,
          yesTokenId,
          noTokenId,
        ],
      );

      const marketPositioningResponse = await app.inject({
        method: "GET",
        url: `/markets/${encodeURIComponent(matching.marketId)}/wallet-positioning?minWallets=1&shape=graph&limit=5`,
      });
      assert.equal(marketPositioningResponse.statusCode, 200);
      const marketPositioningBody = marketPositioningResponse.json() as {
        ok: boolean;
        marketId: string;
        market: {
          marketId: string;
          trackedPositionUsd: number;
          walletCount: number;
          marketImage: string | null;
          marketIcon: string | null;
          eventImage: string | null;
          eventIcon: string | null;
          eventStatus: string | null;
          eventStartDate: string | null;
          eventEndDate: string | null;
          sideBreakdown: {
            YES: {
              positionUsd: number;
              walletCount: number;
              quote: { tokenId: string | null; bestBid: number | null } | null;
            };
            NO: {
              positionUsd: number;
              walletCount: number;
              quote: { tokenId: string | null; bestBid: number | null } | null;
            };
          };
          odds: {
            yes: { label: string; tokenId: string | null; bid: number | null };
            no: { label: string; tokenId: string | null; bid: number | null };
          };
          topHolders: Array<Record<string, unknown>>;
        } | null;
        graph?: {
          nodes: Array<{
            type?: string;
            image?: string | null;
            icon?: string | null;
            eventImage?: string | null;
            eventIcon?: string | null;
            odds?: Record<string, unknown>;
            walletUrl?: string;
          }>;
        };
      };
      assert.equal(marketPositioningBody.ok, true);
      assert.equal(marketPositioningBody.marketId, matching.marketId);
      assert.equal(marketPositioningBody.market?.marketId, matching.marketId);
      assert.equal(marketPositioningBody.market?.trackedPositionUsd, 550);
      assert.equal(marketPositioningBody.market?.walletCount, 2);
      assert.equal(
        marketPositioningBody.market?.sideBreakdown.YES.positionUsd,
        250,
      );
      assert.equal(
        marketPositioningBody.market?.sideBreakdown.NO.positionUsd,
        300,
      );
      assert.equal(
        marketPositioningBody.market?.sideBreakdown.YES.quote?.tokenId,
        yesTokenId,
      );
      assert.equal(
        marketPositioningBody.market?.sideBreakdown.NO.quote?.tokenId,
        noTokenId,
      );
      assert.equal(marketPositioningBody.market?.odds.yes.label, "Yes");
      assert.equal(marketPositioningBody.market?.odds.no.label, "No");
      assert.equal(marketPositioningBody.market?.odds.yes.tokenId, yesTokenId);
      assert.equal(marketPositioningBody.market?.odds.no.tokenId, noTokenId);
      assert.equal(marketPositioningBody.market?.odds.yes.bid, 0.44);
      assert.equal(marketPositioningBody.market?.odds.no.bid, 0.54);
      assert.equal(
        marketPositioningBody.market?.marketImage,
        `https://img.test/${matching.marketId}.png`,
      );
      assert.equal(
        marketPositioningBody.market?.marketIcon,
        `https://img.test/${matching.marketId}-icon.png`,
      );
      assert.equal(
        marketPositioningBody.market?.eventImage,
        `https://img.test/${matching.eventId}.png`,
      );
      assert.equal(
        marketPositioningBody.market?.eventIcon,
        `https://img.test/${matching.eventId}-icon.png`,
      );
      assert.equal(marketPositioningBody.market?.eventStatus, "ACTIVE");
      assert.ok(marketPositioningBody.market?.eventStartDate);
      assert.ok(marketPositioningBody.market?.eventEndDate);
      assert.equal(
        marketPositioningBody.market?.topHolders[0]?.["walletId"],
        noWalletId,
      );
      assert.equal("marketUrl" in (marketPositioningBody.market ?? {}), false);
      assert.equal(
        "walletUrl" in (marketPositioningBody.market?.topHolders[0] ?? {}),
        false,
      );
      assert.equal(
        marketPositioningBody.graph?.nodes.some((node) => node.type === "side"),
        true,
      );
      assert.equal(
        marketPositioningBody.graph?.nodes.some(
          (node) => node.type === "market" && node.odds != null,
        ),
        true,
      );
      assert.equal(
        marketPositioningBody.graph?.nodes.some(
          (node) =>
            node.type === "market" &&
            node.image === `https://img.test/${matching.marketId}.png` &&
            node.eventImage === `https://img.test/${matching.eventId}.png`,
        ),
        true,
      );
      assert.equal(
        marketPositioningBody.graph?.nodes.some(
          (node) => node.type === "trader" && "walletUrl" in node,
        ),
        false,
      );

      const searchedMarketPositioningResponse = await app.inject({
        method: "GET",
        url: `/wallets/positioning/markets?q=${encodeURIComponent(searchNeedle)}&minWallets=1&limit=5`,
      });
      assert.equal(searchedMarketPositioningResponse.statusCode, 200);
      const searchedMarketPositioningBody =
        searchedMarketPositioningResponse.json() as {
          ok: boolean;
          filters: { q: string | null };
          items: Array<{ marketId: string }>;
        };
      assert.equal(searchedMarketPositioningBody.ok, true);
      assert.equal(searchedMarketPositioningBody.filters.q, searchNeedle);
      assert.equal(
        searchedMarketPositioningBody.items.some(
          (item) => item.marketId === matching.marketId,
        ),
        true,
      );
      assert.equal(
        searchedMarketPositioningBody.items.some(
          (item) => item.marketId === other.marketId,
        ),
        false,
      );

      const edgeSortedHoldersResponse = await app.inject({
        method: "GET",
        url: `/markets/${encodeURIComponent(matching.marketId)}/wallet-positioning?minWallets=1&holdersLimit=2&holderSort=edge_z_score`,
      });
      assert.equal(edgeSortedHoldersResponse.statusCode, 200);
      const edgeSortedHoldersBody = edgeSortedHoldersResponse.json() as {
        ok: boolean;
        market: {
          topHolders: Array<{
            walletId: string;
            metrics: { resolvedEdgeZScore30d: number | null };
          }>;
          sideBreakdown: {
            YES: { topHolders: Array<{ walletId: string }> };
            NO: { topHolders: Array<{ walletId: string }> };
          };
        } | null;
      };
      assert.equal(edgeSortedHoldersBody.ok, true);
      assert.equal(
        edgeSortedHoldersBody.market?.topHolders[0]?.walletId,
        yesWalletId,
      );
      assert.equal(
        edgeSortedHoldersBody.market?.topHolders[0]?.metrics
          .resolvedEdgeZScore30d,
        2.8,
      );
      assert.equal(
        edgeSortedHoldersBody.market?.sideBreakdown.YES.topHolders[0]?.walletId,
        yesWalletId,
      );
      assert.equal(
        edgeSortedHoldersBody.market?.sideBreakdown.NO.topHolders[0]?.walletId,
        noWalletId,
      );

      const noEdgeCategory = `${category}-no-edge`;
      const noEdgeMarket = await createWalletMarketFixture(context, {
        suffix: `${suffix}-no-edge`,
        category: noEdgeCategory,
      });
      const smallerNoEdgeMarket = await createWalletMarketFixture(context, {
        suffix: `${suffix}-no-edge-small`,
        category: noEdgeCategory,
      });
      const largeNoEdgeWalletId = await createWhaleFixtureWallet(context, {
        address: randomEvmAddress(),
        chain: "polygon",
        volumeUsd: 2_000,
        pnlUsd: 20,
        roi: 0.01,
        trades30d: 5,
        winRate30d: 0.5,
        exposureUsd: 2_000,
      });
      const smallNoEdgeWalletId = await createWhaleFixtureWallet(context, {
        address: randomEvmAddress(),
        chain: "polygon",
        volumeUsd: 1_000,
        pnlUsd: 10,
        roi: 0.01,
        trades30d: 5,
        winRate30d: 0.5,
        exposureUsd: 1_000,
      });
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
            ($1, 'polymarket', $3, 'NO', 90, 900, 0.55, '{}'::jsonb, $5),
            ($2, 'polymarket', $3, 'YES', 10, 100, 0.45, '{}'::jsonb, $5),
            ($2, 'polymarket', $4, 'YES', 5, 50, 0.4, '{}'::jsonb, $5)
        `,
        [
          largeNoEdgeWalletId,
          smallNoEdgeWalletId,
          noEdgeMarket.marketId,
          smallerNoEdgeMarket.marketId,
          snapshotAt,
        ],
      );
      const noEdgeSortedHoldersResponse = await app.inject({
        method: "GET",
        url: `/markets/${encodeURIComponent(noEdgeMarket.marketId)}/wallet-positioning?minWallets=1&holdersLimit=2&holderSort=edge_z_score`,
      });
      assert.equal(noEdgeSortedHoldersResponse.statusCode, 200);
      const noEdgeSortedHoldersBody = noEdgeSortedHoldersResponse.json() as {
        ok: boolean;
        market: {
          topHolders: Array<{ walletId: string; positionUsd: number }>;
        } | null;
      };
      assert.equal(noEdgeSortedHoldersBody.ok, true);
      assert.equal(
        noEdgeSortedHoldersBody.market?.topHolders[0]?.walletId,
        largeNoEdgeWalletId,
      );
      assert.equal(
        noEdgeSortedHoldersBody.market?.topHolders[0]?.positionUsd,
        900,
      );
      const noEdgeMarketSortResponse = await app.inject({
        method: "GET",
        url: `/wallets/positioning/markets?category=${encodeURIComponent(noEdgeCategory)}&sort=avg_edge_z_score&minWallets=1&includeHolders=false&limit=2`,
      });
      assert.equal(noEdgeMarketSortResponse.statusCode, 200);
      const noEdgeMarketSortBody = noEdgeMarketSortResponse.json() as {
        ok: boolean;
        items: Array<{ marketId: string; trackedPositionUsd: number }>;
      };
      assert.equal(noEdgeMarketSortBody.ok, true);
      assert.equal(
        noEdgeMarketSortBody.items[0]?.marketId,
        noEdgeMarket.marketId,
      );
      assert.equal(noEdgeMarketSortBody.items[0]?.trackedPositionUsd, 1_000);

      const eventPositioningResponse = await app.inject({
        method: "GET",
        url: `/events/${encodeURIComponent(matching.eventId)}/wallet-positioning?minWallets=1&limit=5`,
      });
      assert.equal(eventPositioningResponse.statusCode, 200);
      const eventPositioningBody = eventPositioningResponse.json() as {
        ok: boolean;
        eventId: string;
        event: {
          eventId: string;
          eventStatus: string | null;
          startDate: string | null;
          endDate: string | null;
          walletCount: number;
          topMarketsPreview: Array<{
            marketId: string;
            odds: {
              yes: { tokenId: string | null };
              no: { tokenId: string | null };
            };
          }>;
        } | null;
        items: Array<{ marketId: string }>;
      };
      assert.equal(eventPositioningBody.ok, true);
      assert.equal(eventPositioningBody.eventId, matching.eventId);
      assert.equal(eventPositioningBody.event?.eventId, matching.eventId);
      assert.equal(eventPositioningBody.event?.eventStatus, "ACTIVE");
      assert.ok(eventPositioningBody.event?.startDate);
      assert.ok(eventPositioningBody.event?.endDate);
      assert.equal("eventUrl" in (eventPositioningBody.event ?? {}), false);
      assert.equal(eventPositioningBody.event?.walletCount, 2);
      assert.equal(
        eventPositioningBody.event?.topMarketsPreview[0]?.marketId,
        matching.marketId,
      );
      assert.equal(
        eventPositioningBody.event?.topMarketsPreview[0]?.odds.yes.tokenId,
        yesTokenId,
      );
      assert.equal(eventPositioningBody.items[0]?.marketId, matching.marketId);

      const searchedEventPositioningResponse = await app.inject({
        method: "GET",
        url: `/wallets/positioning/events?q=${encodeURIComponent(searchNeedle)}&minWallets=1&limit=5`,
      });
      assert.equal(searchedEventPositioningResponse.statusCode, 200);
      const searchedEventPositioningBody =
        searchedEventPositioningResponse.json() as {
          ok: boolean;
          filters: { q: string | null };
          items: Array<{ eventId: string }>;
        };
      assert.equal(searchedEventPositioningBody.ok, true);
      assert.equal(searchedEventPositioningBody.filters.q, searchNeedle);
      assert.equal(searchedEventPositioningBody.items.length, 1);
      assert.equal(
        searchedEventPositioningBody.items[0]?.eventId,
        matching.eventId,
      );

      assert.throws(
        () => assertSqlParamPlaceholders("select $1::text", ["a", "b"], "test"),
        /SQL param mismatch/,
      );

      const oneLetterEventPositioningResponse = await app.inject({
        method: "GET",
        url:
          "/wallets/positioning/events?q=u&marketStatus=ACTIVE&acceptingOrders=true" +
          "&walletActiveWithinHours=24&minWalletExposureUsd=100&minPositionUsd=100" +
          "&contestedMinMinoritySideUsd=10000&contestedMinMinoritySideShare=0.05" +
          "&contestedMinSideWallets=2&contestedMaxLargestHolderPct=0.85" +
          "&minContestedMarketCount=1&mmMode=exclude&sort=event_disagreement_score" +
          "&includeHolders=true&holdersLimit=2&holderSort=position_usd" +
          "&includePositionPnl=true&shape=both&limit=5&offset=0",
      });
      assert.equal(oneLetterEventPositioningResponse.statusCode, 200);

      const childSearchCategory = `${category}-child-search`;
      const childSearchEvent = await createWalletMarketFixture(context, {
        suffix: `${suffix}-child-search`,
        category: childSearchCategory,
      });
      const childSearchSibling = await createWalletMarketFixture(context, {
        suffix: `${suffix}-child-search-sibling`,
        category: childSearchCategory,
      });
      await pool.query(
        `
          update unified_events
          set title = $1
          where id = $2
        `,
        [
          "Republican presidential nominee test event",
          childSearchEvent.eventId,
        ],
      );
      await pool.query(
        `
          update unified_markets
          set title = case
                when id = $2 then 'Elon Musk nominee test market'
                else 'Unrelated candidate nominee test market'
              end,
              event_id = $1,
              category = $4
          where id = any($3::text[])
        `,
        [
          childSearchEvent.eventId,
          childSearchEvent.marketId,
          [childSearchEvent.marketId, childSearchSibling.marketId],
          childSearchCategory,
        ],
      );
      const childSearchWalletA = await createWhaleFixtureWallet(context, {
        address: randomEvmAddress(),
        chain: "polygon",
        volumeUsd: 1_300,
        pnlUsd: 20,
        roi: 0.01,
        trades30d: 6,
        exposureUsd: 1_300,
      });
      const childSearchWalletB = await createWhaleFixtureWallet(context, {
        address: randomEvmAddress(),
        chain: "polygon",
        volumeUsd: 1_400,
        pnlUsd: 30,
        roi: 0.02,
        trades30d: 7,
        exposureUsd: 1_400,
      });
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
            ($1, 'polymarket', $3, 'YES', 20, 200, 0.2, '{}'::jsonb, $5),
            ($2, 'polymarket', $3, 'YES', 25, 250, 0.2, '{}'::jsonb, $5),
            ($1, 'polymarket', $4, 'YES', 40, 400, 0.4, '{}'::jsonb, $5),
            ($2, 'polymarket', $4, 'NO', 45, 450, 0.6, '{}'::jsonb, $5)
        `,
        [
          childSearchWalletA,
          childSearchWalletB,
          childSearchEvent.marketId,
          childSearchSibling.marketId,
          new Date(snapshotAt.getTime() + 500),
        ],
      );
      const childSearchEventResponse = await app.inject({
        method: "GET",
        url: `/wallets/positioning/events?q=${encodeURIComponent("elon musk")}&category=${encodeURIComponent(childSearchCategory)}&minWallets=2&minContestedMarketCount=1&limit=5`,
      });
      assert.equal(childSearchEventResponse.statusCode, 200);
      const childSearchEventBody = childSearchEventResponse.json() as {
        ok: boolean;
        items: Array<{
          eventId: string;
          topMarketsPreview: Array<{ marketId: string }>;
        }>;
      };
      assert.equal(childSearchEventBody.ok, true);
      const childSearchEventItem = childSearchEventBody.items.find(
        (item) => item.eventId === childSearchEvent.eventId,
      );
      assert.ok(childSearchEventItem);
      assert.equal(
        childSearchEventItem.topMarketsPreview[0]?.marketId,
        childSearchEvent.marketId,
      );
      assert.equal(
        childSearchEventItem.topMarketsPreview.some(
          (market) => market.marketId === childSearchSibling.marketId,
        ),
        false,
      );

      const sameEventOneSided = await createWalletMarketFixture(context, {
        suffix: `${suffix}-same-event-one-sided`,
        category,
      });
      const sameEventLopsided = await createWalletMarketFixture(context, {
        suffix: `${suffix}-same-event-lopsided`,
        category,
      });
      await pool.query(
        `
          update unified_markets
          set event_id = $1, category = $2
          where id = any($3::text[])
        `,
        [
          matching.eventId,
          category,
          [sameEventOneSided.marketId, sameEventLopsided.marketId],
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
            ($1, 'polymarket', $3, 'YES', 15, 150, 0.4, '{}'::jsonb, $5),
            ($1, 'polymarket', $4, 'YES', 1000000, 1000000, 0.99, '{}'::jsonb, $5),
            ($2, 'polymarket', $4, 'NO', 5000, 5000, 0.01, '{}'::jsonb, $5)
        `,
        [
          yesWalletId,
          noWalletId,
          sameEventOneSided.marketId,
          sameEventLopsided.marketId,
          snapshotAt,
        ],
      );

      const disagreementMarketsResponse = await app.inject({
        method: "GET",
        url: `/wallets/positioning/markets?category=${encodeURIComponent(category)}&minWallets=1&sort=balanced_disagreement&limit=5`,
      });
      assert.equal(disagreementMarketsResponse.statusCode, 200);
      const disagreementMarketsBody = disagreementMarketsResponse.json() as {
        ok: boolean;
        items: Array<{
          marketId: string;
          minoritySide: string | null;
          minoritySideUsd: number;
          minoritySideShare: number | null;
          absImbalancePct: number | null;
          balancedDisagreementScore: number;
        }>;
      };
      assert.equal(disagreementMarketsBody.ok, true);
      assert.equal(
        disagreementMarketsBody.items[0]?.marketId,
        matching.marketId,
      );
      const balancedMarket = disagreementMarketsBody.items.find(
        (item) => item.marketId === matching.marketId,
      );
      const lopsidedMarket = disagreementMarketsBody.items.find(
        (item) => item.marketId === sameEventLopsided.marketId,
      );
      assert.ok(balancedMarket);
      assert.ok(lopsidedMarket);
      assert.equal(balancedMarket.minoritySide, "YES");
      assert.equal(balancedMarket.minoritySideUsd, 250);
      assert.ok((balancedMarket.minoritySideShare ?? 0) > 0.45);
      assert.ok((balancedMarket.absImbalancePct ?? 0) < 0.1);
      assert.ok(
        balancedMarket.balancedDisagreementScore >
          lopsidedMarket.balancedDisagreementScore,
      );

      const filteredDisagreementResponse = await app.inject({
        method: "GET",
        url: `/wallets/positioning/markets?category=${encodeURIComponent(category)}&minWallets=1&sort=balanced_disagreement&minMinoritySideUsd=100&minMinoritySideShare=0.05&minYesWallets=1&minNoWallets=1&limit=10`,
      });
      assert.equal(filteredDisagreementResponse.statusCode, 200);
      const filteredDisagreementBody = filteredDisagreementResponse.json() as {
        ok: boolean;
        items: Array<{ marketId: string }>;
      };
      assert.equal(filteredDisagreementBody.ok, true);
      assert.equal(
        filteredDisagreementBody.items.some(
          (item) => item.marketId === matching.marketId,
        ),
        true,
      );
      assert.equal(
        filteredDisagreementBody.items.some(
          (item) => item.marketId === sameEventLopsided.marketId,
        ),
        false,
      );

      const contestedEventDetailResponse = await app.inject({
        method: "GET",
        url: `/events/${encodeURIComponent(matching.eventId)}/wallet-positioning?minWallets=1&sort=event_disagreement_score&contestedMinMinoritySideUsd=100&contestedMinMinoritySideShare=0.05&contestedMinSideWallets=1&contestedMaxLargestHolderPct=0.9&limit=10`,
      });
      assert.equal(contestedEventDetailResponse.statusCode, 200);
      const contestedEventDetailBody = contestedEventDetailResponse.json() as {
        ok: boolean;
        event: {
          eventShape: string;
          contestedMarketCount: number;
          eventDisagreementScore: number;
          crossMarketWalletCount: number;
          topMarketMinoritySideUsd: number | null;
          topMarketMinoritySideShare: number | null;
        } | null;
        items: Array<{ marketId: string }>;
      };
      assert.equal(contestedEventDetailBody.ok, true);
      assert.equal(contestedEventDetailBody.event?.eventShape, "multi_market");
      assert.equal(contestedEventDetailBody.event?.contestedMarketCount, 1);
      assert.ok(
        (contestedEventDetailBody.event?.eventDisagreementScore ?? 0) > 0,
      );
      assert.equal(contestedEventDetailBody.event?.crossMarketWalletCount, 2);
      assert.equal(
        contestedEventDetailBody.event?.topMarketMinoritySideUsd,
        250,
      );
      assert.ok(
        (contestedEventDetailBody.event?.topMarketMinoritySideShare ?? 0) >
          0.45,
      );
      assert.equal(
        contestedEventDetailBody.items[0]?.marketId,
        matching.marketId,
      );

      const contestedEventRollupResponse = await app.inject({
        method: "GET",
        url: `/wallets/positioning/events?category=${encodeURIComponent(category)}&minWallets=1&eventShape=multi_market&minContestedMarketCount=1&minCrossMarketWallets=2&sort=event_disagreement_score&contestedMinMinoritySideUsd=100&contestedMinMinoritySideShare=0.05&contestedMinSideWallets=1&contestedMaxLargestHolderPct=0.9&limit=5`,
      });
      assert.equal(contestedEventRollupResponse.statusCode, 200);
      const contestedEventRollupBody = contestedEventRollupResponse.json() as {
        ok: boolean;
        items: Array<{
          eventId: string;
          eventShape: string;
          contestedMarketCount: number;
          crossMarketWalletCount: number;
        }>;
      };
      assert.equal(contestedEventRollupBody.ok, true);
      assert.equal(
        contestedEventRollupBody.items[0]?.eventId,
        matching.eventId,
      );
      assert.equal(
        contestedEventRollupBody.items[0]?.eventShape,
        "multi_market",
      );
      assert.equal(contestedEventRollupBody.items[0]?.contestedMarketCount, 1);
      assert.equal(
        contestedEventRollupBody.items[0]?.crossMarketWalletCount,
        2,
      );

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

      const searchedPositionResponse = await app.inject({
        method: "GET",
        url: `/wallets/positions?walletId=${labeledWalletId}&q=${encodeURIComponent(searchNeedle)}&includeSmall=true&limit=10&offset=0`,
      });
      assert.equal(searchedPositionResponse.statusCode, 200);
      const searchedPositionBody = searchedPositionResponse.json() as {
        ok: boolean;
        items: Array<{ marketId: string }>;
      };
      assert.equal(searchedPositionBody.ok, true);
      assert.equal(searchedPositionBody.items.length, 1);
      assert.equal(searchedPositionBody.items[0]?.marketId, matching.marketId);

      const searchedPositionHistoryResponse = await app.inject({
        method: "GET",
        url: `/wallets/positions/history?walletId=${labeledWalletId}&q=${encodeURIComponent(searchNeedle)}&includeSmall=true&limit=10&offset=0`,
      });
      assert.equal(searchedPositionHistoryResponse.statusCode, 200);
      assert.equal(searchedPositionHistoryResponse.json().ok, true);

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
