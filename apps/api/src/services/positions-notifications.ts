import type { Pool } from "@hunch/infra";

import type { NotificationRow } from "../repos/notifications-repo.js";
import {
  buildNotificationPayload,
  publishNotification,
  type NotificationPayload,
} from "./notifications.js";

export type ResolvedPositionRow = {
  id: string;
  token_id: string;
  wallet_address: string;
  venue: "kalshi" | "limitless" | "polymarket";
  market_id: string | null;
  outcome_side: string | null;
  resolved_outcome: string | null;
  resolved_outcome_pct: string | number | null;
  position_snapshot_at?: string | Date | null;
};

export type PositionResolutionFacts = {
  outcomeSide: "YES" | "NO";
  resolvedOutcome: "YES" | "NO" | null;
  resolvedOutcomePct: number | null;
  result: "lost" | "settled" | "won";
};

function normalizeOutcome(value: string | null): "YES" | "NO" | null {
  if (!value) return null;
  const trimmed = value.trim().toUpperCase();
  return trimmed === "YES" || trimmed === "NO" ? trimmed : null;
}

function normalizeResolvedOutcomePct(
  value: string | number | null,
): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 10_000) return null;
  return parsed;
}

export function buildPositionResolutionFacts(input: {
  outcomeSide: string | null;
  resolvedOutcome: string | null;
  resolvedOutcomePct: string | number | null;
}): PositionResolutionFacts | null {
  const outcomeSide = normalizeOutcome(input.outcomeSide);
  if (!outcomeSide) return null;
  const resolvedOutcome = normalizeOutcome(input.resolvedOutcome);
  if (resolvedOutcome) {
    return {
      outcomeSide,
      resolvedOutcome,
      resolvedOutcomePct: null,
      result: resolvedOutcome === outcomeSide ? "won" : "lost",
    };
  }
  const resolvedOutcomePct = normalizeResolvedOutcomePct(
    input.resolvedOutcomePct,
  );
  if (resolvedOutcomePct == null) return null;
  return {
    outcomeSide,
    resolvedOutcome: null,
    resolvedOutcomePct,
    result: "settled",
  };
}

export async function createResolvedPositionNotificationIfVisible(
  pool: Pool,
  inputs: {
    userId: string;
    position: {
      id: string;
      market_id: string | null;
      position_snapshot_at?: string | Date | null;
      token_id: string;
      venue: string;
      wallet_address: string;
    };
  } & (
    | { resolution: PositionResolutionFacts }
    | { outcomeSide: "YES" | "NO"; resolvedOutcome: "YES" | "NO" }
  ),
): Promise<NotificationPayload | null> {
  const resolution =
    "resolution" in inputs
      ? inputs.resolution
      : buildPositionResolutionFacts({
          outcomeSide: inputs.outcomeSide,
          resolvedOutcome: inputs.resolvedOutcome,
          resolvedOutcomePct: null,
        });
  if (!resolution) return null;
  const { result } = resolution;
  const title =
    result === "won"
      ? "Position resolved (win)"
      : result === "lost"
        ? "Position resolved (loss)"
        : "Position settled";
  const body =
    result === "won"
      ? "The market resolved on your side"
      : result === "lost"
        ? "The market resolved against your side"
        : "The market settled with a scalar result";
  const severity =
    result === "won" ? "success" : result === "lost" ? "warning" : "info";
  const data = {
    venue: inputs.position.venue,
    marketId: inputs.position.market_id ?? null,
    tokenId: inputs.position.token_id,
    walletAddress: inputs.position.wallet_address,
    resolvedOutcome: resolution.resolvedOutcome,
    resolvedOutcomePct: resolution.resolvedOutcomePct,
    outcomeSide: resolution.outcomeSide,
    result,
    holdingEvidence: "cached_position",
    positionSnapshotAt:
      inputs.position.position_snapshot_at instanceof Date
        ? inputs.position.position_snapshot_at.toISOString()
        : inputs.position.position_snapshot_at,
  };
  const dedupeKey = `position_resolved:${inputs.position.id}`;

  try {
    const { rows } = await pool.query<NotificationRow>(
      `
        insert into notifications (
          id,
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
        select
          gen_random_uuid(),
          $1,
          'position_resolved',
          $2,
          $3,
          $4,
          $5,
          $6,
          now(),
          now()
        where exists (
          select 1
          from positions p
          where p.id = $7
            and p.user_id = $1
            and p.position_scope = 'own'
            and p.size > 0
            and (p.is_hidden is null or p.is_hidden = false)
        )
        on conflict (user_id, dedupe_key) do nothing
        returning
          id,
          user_id,
          type,
          title,
          body,
          severity,
          data,
          read_at,
          created_at,
          updated_at
      `,
      [
        inputs.userId,
        title,
        body,
        severity,
        data,
        dedupeKey,
        inputs.position.id,
      ],
    );

    const row = rows[0];
    if (!row) return null;
    const payload = buildNotificationPayload(row);
    await publishNotification(row.user_id, payload).catch((error) => {
      console.warn(
        "[position-notifications] realtime publish failed",
        String(error),
      );
    });
    return payload;
  } catch (error) {
    console.warn("[position-notifications] failed", String(error));
    return null;
  }
}

export async function createResolvedPositionNotificationFromRow(
  pool: Pool,
  input: {
    position: ResolvedPositionRow;
    userId: string;
  },
): Promise<NotificationPayload | null> {
  const resolution = buildPositionResolutionFacts({
    outcomeSide: input.position.outcome_side,
    resolvedOutcome: input.position.resolved_outcome,
    resolvedOutcomePct: input.position.resolved_outcome_pct,
  });
  if (!resolution) return null;
  return createResolvedPositionNotificationIfVisible(pool, {
    position: input.position,
    resolution,
    userId: input.userId,
  });
}

export async function notifyResolvedPositions(
  pool: Pool,
  inputs: { userId: string; walletAddress: string; venue: string },
): Promise<number> {
  const { rows } = await pool.query<ResolvedPositionRow>(
    `
      select
        p.id,
        p.token_id,
        p.wallet_address,
        p.venue,
        ut.market_id,
        ut.side as outcome_side,
        m.resolved_outcome,
        m.resolved_outcome_pct,
        coalesce(p.last_updated_at, p.updated_at) as position_snapshot_at
      from positions p
      join unified_tokens ut
        on ut.token_id = p.token_id and ut.venue = p.venue
      join unified_markets m
        on m.id = ut.market_id and m.venue = p.venue
      where p.user_id = $1
        and lower(p.wallet_address) = lower($2)
        and p.venue = $3
        and p.position_scope = 'own'
        and p.size > 0
        and (p.is_hidden is null or p.is_hidden = false)
        and (m.resolved_outcome is not null or m.resolved_outcome_pct is not null)
    `,
    [inputs.userId, inputs.walletAddress, inputs.venue],
  );

  let created = 0;
  for (const row of rows) {
    const result = await createResolvedPositionNotificationFromRow(pool, {
      position: row,
      userId: inputs.userId,
    });
    if (result) created += 1;
  }

  return created;
}
