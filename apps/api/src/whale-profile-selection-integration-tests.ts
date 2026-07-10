// @requires-db

import assert from "node:assert/strict";
import crypto from "node:crypto";

import type { PoolClient } from "pg";

import { pool } from "./db.js";
import { loadWhaleSelectionRows } from "./services/whale-profiles.js";

type FixtureWallet = {
  chain?: "polygon" | "solana";
  exposureUsd?: number;
  lastActivityAt?: Date;
  lastSeenAt: Date;
  metricsLastTradeAt?: Date;
  pnlUsd?: number;
  signalAbsUsd?: number;
  tradesCount?: number;
  volumeUsd?: number;
  winRate?: number;
  withSnapshot?: boolean;
};

async function insertFixtureWallet(
  client: PoolClient,
  tagId: string,
  testId: string,
  name: string,
  fixture: FixtureWallet,
): Promise<string> {
  const walletResult = await client.query<{ id: string }>(
    `
      insert into wallets (address, chain, first_seen_at, last_seen_at)
      values ($1, $2, $3, $3)
      returning id
    `,
    [
      `whale-profile-selection-${testId}-${name}`,
      fixture.chain ?? "polygon",
      fixture.lastSeenAt,
    ],
  );
  const walletId = walletResult.rows[0]?.id;
  assert.ok(walletId);

  await client.query(
    `
      insert into wallet_tag_map (wallet_id, tag_id, source)
      values ($1, $2, 'integration-test')
    `,
    [walletId, tagId],
  );

  if (fixture.withSnapshot !== false) {
    await client.query(
      `
        insert into wallet_intel_selector_snapshot (
          wallet_id,
          metrics_as_of,
          metrics_volume_30d,
          metrics_pnl_30d,
          metrics_trades_30d,
          metrics_win_rate_30d,
          metrics_last_trade_at_30d,
          exposure_usd,
          last_activity_at,
          updated_at
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $2)
      `,
      [
        walletId,
        fixture.lastSeenAt,
        fixture.volumeUsd ?? null,
        fixture.pnlUsd ?? null,
        fixture.tradesCount ?? null,
        fixture.winRate ?? null,
        fixture.metricsLastTradeAt ?? null,
        fixture.exposureUsd ?? null,
        fixture.lastActivityAt ?? null,
      ],
    );
  }

  if (fixture.signalAbsUsd != null) {
    const activityAt = fixture.lastActivityAt ?? fixture.lastSeenAt;
    await client.query(
      `
        insert into wallet_activity_hourly (
          wallet_id,
          venue,
          market_id,
          outcome_side,
          activity_type,
          hour_bucket,
          max_abs_delta_usd,
          last_occurred_at
        )
        values ($1, 'integration-test', $2, 'yes', 'trade', $3, $4, $3)
      `,
      [walletId, `market-${name}`, activityAt, fixture.signalAbsUsd],
    );
  }

  return walletId;
}

async function insertTrackerPnlHistory(
  client: PoolClient,
  walletId: string,
  startAt: Date,
  startPnl: number,
  endAt: Date,
  endPnl: number,
): Promise<void> {
  await client.query(
    `
      insert into wallet_metrics_snapshots (
        wallet_id,
        venue,
        period,
        as_of,
        pnl_usd
      )
      values
        ($1, 'aggregate', 'all', $2, $3),
        ($1, 'aggregate', 'all', $4, $5)
    `,
    [walletId, startAt, startPnl, endAt, endPnl],
  );
}

const client = await pool.connect();
try {
  await client.query("begin");

  const testId = crypto.randomUUID();
  const now = new Date();
  const ago = (hours: number) =>
    new Date(now.getTime() - hours * 60 * 60 * 1_000);
  const tagResult = await client.query<{ id: string }>(
    `
      insert into wallet_tags (slug, label, tag_type, is_system)
      values ($1, 'Whale selection integration test', 'system', false)
      returning id
    `,
    [`whale-selection-test-${testId}`],
  );
  const tagId = tagResult.rows[0]?.id;
  assert.ok(tagId);

  const walletIds = {
    trackerRecent: await insertFixtureWallet(
      client,
      tagId,
      testId,
      "tracker-recent",
      {
        lastActivityAt: ago(1),
        lastSeenAt: ago(1),
        pnlUsd: 100,
        signalAbsUsd: 10,
        tradesCount: 10,
        volumeUsd: 1_000,
        winRate: 0.6,
      },
    ),
    trackerPnl: await insertFixtureWallet(
      client,
      tagId,
      testId,
      "tracker-pnl",
      {
        lastActivityAt: ago(2),
        lastSeenAt: ago(2),
        pnlUsd: 50,
        signalAbsUsd: 20,
        tradesCount: 20,
        volumeUsd: 500,
        winRate: 0.9,
      },
    ),
    trackerFallback: await insertFixtureWallet(
      client,
      tagId,
      testId,
      "tracker-fallback",
      {
        lastActivityAt: ago(2.5),
        lastSeenAt: ago(2.5),
        pnlUsd: 900,
        signalAbsUsd: 15,
        tradesCount: 15,
        volumeUsd: 750,
        winRate: 0.7,
      },
    ),
    recent: await insertFixtureWallet(client, tagId, testId, "recent", {
      lastActivityAt: ago(1 / 6),
      lastSeenAt: ago(1 / 6),
      pnlUsd: 10,
      tradesCount: 6,
      volumeUsd: 100,
      winRate: 0.5,
    }),
    pnl: await insertFixtureWallet(client, tagId, testId, "pnl", {
      lastActivityAt: ago(3),
      lastSeenAt: ago(3),
      pnlUsd: 1_000,
      tradesCount: 8,
      volumeUsd: 200,
      winRate: 0.4,
    }),
    signal: await insertFixtureWallet(client, tagId, testId, "signal", {
      lastActivityAt: ago(4),
      lastSeenAt: ago(4),
      pnlUsd: 5,
      signalAbsUsd: 999,
      tradesCount: 7,
      volumeUsd: 50,
      winRate: 0.3,
    }),
    solanaExposure: await insertFixtureWallet(
      client,
      tagId,
      testId,
      "solana-exposure",
      {
        chain: "solana",
        exposureUsd: 5_000,
        lastActivityAt: ago(5),
        lastSeenAt: ago(5),
        pnlUsd: 0,
        tradesCount: 5,
        volumeUsd: 0,
        winRate: 0.2,
      },
    ),
    lowerWhaleScore: await insertFixtureWallet(
      client,
      tagId,
      testId,
      "lower-whale-score",
      {
        lastActivityAt: ago(5),
        lastSeenAt: ago(5),
        pnlUsd: 0,
        tradesCount: 5,
        volumeUsd: 100,
        winRate: 0.2,
      },
    ),
    missingSnapshot: await insertFixtureWallet(
      client,
      tagId,
      testId,
      "missing-snapshot",
      {
        lastSeenAt: ago(7),
        withSnapshot: false,
      },
    ),
    oldSnapshotActivity: await insertFixtureWallet(
      client,
      tagId,
      testId,
      "old-snapshot-activity",
      {
        lastActivityAt: ago(40 * 24),
        lastSeenAt: ago(25 * 24),
        metricsLastTradeAt: ago(20 * 24),
        pnlUsd: 1,
        signalAbsUsd: 10_000,
        tradesCount: 5,
        volumeUsd: 10,
        winRate: 0.1,
      },
    ),
  };

  await insertTrackerPnlHistory(
    client,
    walletIds.trackerRecent,
    ago(31 * 24),
    100,
    ago(1 / 60),
    150,
  );
  await insertTrackerPnlHistory(
    client,
    walletIds.trackerPnl,
    ago(31 * 24),
    0,
    ago(1 / 60),
    200,
  );
  await insertTrackerPnlHistory(
    client,
    walletIds.trackerFallback,
    ago(20 * 24),
    100,
    ago(1 / 60),
    130,
  );

  const rows = await loadWhaleSelectionRows(client, {
    whaleTagId: tagId,
    windowDays: 30,
    limit: 10,
    trackerWindowHours: 24,
    signalsWindowHours: 24,
    trackerSurfaceIds: [
      walletIds.trackerRecent,
      walletIds.trackerPnl,
      walletIds.trackerFallback,
    ],
    selectTrackerRecentLimit: 1,
    selectTrackerPnlLimit: 1,
    selectTrackerWinRateLimit: 1,
    selectRecentLimit: 1,
    selectPnlLimit: 1,
    selectSignalsLimit: 1,
    trackerRecentFetchLimit: 10,
    trackerPnlFetchLimit: 10,
    trackerWinRateFetchLimit: 10,
    recentFetchLimit: 10,
    pnlFetchLimit: 10,
    signalsFetchLimit: 10,
    candidateFetchLimit: 20,
  });
  const byId = new Map(rows.map((row) => [row.id, row]));

  assert.equal(rows.length, 10);
  assert.equal(new Set(rows.map((row) => row.id)).size, rows.length);
  assert.equal(byId.get(walletIds.trackerRecent)?.rank_tracker_recent, 1);
  assert.equal(byId.get(walletIds.trackerPnl)?.rank_tracker_recent, 2);
  assert.equal(byId.get(walletIds.trackerFallback)?.rank_tracker_recent, 3);
  assert.equal(Number(byId.get(walletIds.trackerPnl)?.rank_tracker_pnl), 1);
  assert.equal(
    Number(byId.get(walletIds.trackerFallback)?.rank_tracker_pnl),
    3,
  );
  assert.equal(
    Number(byId.get(walletIds.trackerPnl)?.rank_tracker_win_rate),
    1,
  );
  assert.equal(Number(byId.get(walletIds.recent)?.rank_recent), 1);
  assert.equal(Number(byId.get(walletIds.pnl)?.rank_pnl), 1);
  assert.equal(Number(byId.get(walletIds.signal)?.rank_signal), 1);
  assert.ok(
    Number(byId.get(walletIds.solanaExposure)?.rank_recent) <
      Number(byId.get(walletIds.lowerWhaleScore)?.rank_recent),
  );
  assert.ok(byId.has(walletIds.missingSnapshot));

  const oldActivity = byId.get(walletIds.oldSnapshotActivity)?.last_activity_at;
  assert.ok(oldActivity);
  assert.ok(Math.abs(oldActivity.getTime() - ago(20 * 24).getTime()) < 1_000);
  assert.ok(Number(byId.get(walletIds.oldSnapshotActivity)?.rank_signal) > 1);

  console.log("[whale-profile-selection-integration-tests] passed 17/17");
} finally {
  await client.query("rollback");
  client.release();
}
