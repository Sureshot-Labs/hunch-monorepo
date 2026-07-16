import type { Pool } from "@hunch/infra";

import { pool as defaultPool } from "../db.js";
import {
  createResolvedPositionNotificationFromRow,
  type ResolvedPositionRow,
} from "./positions-notifications.js";
import { syncPositionsForUserWallet } from "./positions-sync.js";
import { resolveTelegramNotificationsPolicy } from "./telegram-notification-policy.js";
import { venueLifecycleAllows } from "./venue-lifecycle.js";

const PRODUCER_LOCK_KEY = "position_resolution_notifications:v1";

type ResolutionCandidateRow = ResolvedPositionRow & {
  user_id: string;
};

export type PositionResolutionProducerSummary = {
  affectedWallets: number;
  candidates: number;
  notificationsCreated: number;
  skipped: boolean;
  skipReason?: string;
  syncFailed: number;
  syncSucceeded: number;
};

function emptySummary(skipReason?: string): PositionResolutionProducerSummary {
  return {
    affectedWallets: 0,
    candidates: 0,
    notificationsCreated: 0,
    skipped: Boolean(skipReason),
    ...(skipReason ? { skipReason } : {}),
    syncFailed: 0,
    syncSucceeded: 0,
  };
}

export async function runPositionResolutionNotificationProducer(
  input: {
    allowsLifecycle?: typeof venueLifecycleAllows;
    createNotification?: typeof createResolvedPositionNotificationFromRow;
    limit?: number;
    pool?: Pool;
    resolvePolicy?: typeof resolveTelegramNotificationsPolicy;
    syncPositions?: typeof syncPositionsForUserWallet;
  } = {},
): Promise<PositionResolutionProducerSummary> {
  const pool = input.pool ?? defaultPool;
  const resolvePolicy =
    input.resolvePolicy ?? resolveTelegramNotificationsPolicy;
  const createNotification =
    input.createNotification ?? createResolvedPositionNotificationFromRow;
  const allowsLifecycle = input.allowsLifecycle ?? venueLifecycleAllows;
  const syncPositions = input.syncPositions ?? syncPositionsForUserWallet;
  const resolvedPolicy = await resolvePolicy(pool);
  if (!resolvedPolicy.policy.positionResolutionProducerEnabled) {
    return emptySummary("runtime_policy_disabled");
  }
  if (!resolvedPolicy.effectiveAt) {
    return emptySummary("runtime_policy_cutoff_unavailable");
  }

  const client = await pool.connect();
  let locked = false;
  try {
    const lockResult = await client.query<{ acquired: boolean }>(
      `select pg_try_advisory_lock(hashtextextended($1, 0)) as acquired`,
      [PRODUCER_LOCK_KEY],
    );
    locked = lockResult.rows[0]?.acquired === true;
    if (!locked) return emptySummary("producer_already_running");

    const limit = Math.min(1_000, Math.max(1, input.limit ?? 250));
    const { rows } = await client.query<ResolutionCandidateRow>(
      `
        select
          p.id,
          p.user_id,
          p.token_id,
          p.wallet_address,
          p.venue,
          token.market_id,
          token.side as outcome_side,
          market.resolved_outcome,
          market.resolved_outcome_pct,
          coalesce(p.last_updated_at, p.updated_at) as position_snapshot_at
        from unified_markets market
        join unified_tokens token
          on token.market_id = market.id
         and token.venue = market.venue
        join positions p
          on p.token_id = token.token_id
         and p.venue = token.venue
        where market.resolution_observed_at >= $1::timestamptz
          and (market.resolved_outcome is not null or market.resolved_outcome_pct is not null)
          and p.position_scope = 'own'
          and p.size > 0
          and coalesce(p.is_hidden, false) = false
          and not exists (
            select 1
            from notifications notification
            where notification.user_id = p.user_id
              and notification.dedupe_key = 'position_resolved:' || p.id::text
          )
        order by market.resolution_observed_at asc, p.id asc
        limit $2
      `,
      [resolvedPolicy.effectiveAt, limit],
    );

    const affected = new Map<
      string,
      {
        userId: string;
        venue: "kalshi" | "limitless" | "polymarket";
        walletAddress: string;
      }
    >();
    let notificationsCreated = 0;
    for (const row of rows) {
      const notification = await createNotification(pool, {
        position: row,
        userId: row.user_id,
      });
      if (!notification) continue;
      notificationsCreated += 1;
      const key = `${row.user_id}:${row.venue}:${row.wallet_address.toLowerCase()}`;
      affected.set(key, {
        userId: row.user_id,
        venue: row.venue,
        walletAddress: row.wallet_address,
      });
    }

    let syncFailed = 0;
    let syncSucceeded = 0;
    for (const target of affected.values()) {
      try {
        if (!(await allowsLifecycle(pool, target.venue, "accountRead"))) {
          syncFailed += 1;
          continue;
        }
        await syncPositions(pool, target);
        syncSucceeded += 1;
      } catch (error) {
        syncFailed += 1;
        console.warn(
          "[position-resolution-producer] targeted sync failed",
          JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
            userId: target.userId,
            venue: target.venue,
            walletAddress: target.walletAddress,
          }),
        );
      }
    }

    return {
      affectedWallets: affected.size,
      candidates: rows.length,
      notificationsCreated,
      skipped: false,
      syncFailed,
      syncSucceeded,
    };
  } finally {
    if (locked) {
      await client
        .query(`select pg_advisory_unlock(hashtextextended($1, 0))`, [
          PRODUCER_LOCK_KEY,
        ])
        .catch(() => undefined);
    }
    client.release();
  }
}
