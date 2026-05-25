import type { Pool } from "@hunch/infra";
import type { NotificationRow } from "../repos/notifications-repo.js";
import {
  buildNotificationPayload,
  publishNotification,
  type NotificationPayload,
} from "./notifications.js";

type ResolvedPositionRow = {
  id: string;
  token_id: string;
  wallet_address: string;
  venue: string;
  market_id: string | null;
  outcome_side: string | null;
  resolved_outcome: string | null;
};

function normalizeOutcome(value: string | null): "YES" | "NO" | null {
  if (!value) return null;
  const trimmed = value.trim().toUpperCase();
  return trimmed === "YES" || trimmed === "NO" ? trimmed : null;
}

export async function createResolvedPositionNotificationIfVisible(
  pool: Pool,
  inputs: {
    userId: string;
    position: Pick<
      ResolvedPositionRow,
      "id" | "token_id" | "wallet_address" | "venue" | "market_id"
    >;
    resolvedOutcome: "YES" | "NO";
    outcomeSide: "YES" | "NO";
  },
): Promise<NotificationPayload | null> {
  const won = inputs.resolvedOutcome === inputs.outcomeSide;
  const title = won ? "Position resolved (win)" : "Position resolved (loss)";
  const body = won ? "Claim available" : "Resolved with no payout";
  const severity = won ? "success" : "warning";
  const data = {
    venue: inputs.position.venue,
    marketId: inputs.position.market_id ?? null,
    tokenId: inputs.position.token_id,
    walletAddress: inputs.position.wallet_address,
    resolvedOutcome: inputs.resolvedOutcome,
    outcomeSide: inputs.outcomeSide,
    result: won ? "won" : "lost",
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
    await publishNotification(row.user_id, payload);
    return payload;
  } catch (error) {
    console.warn("[position-notifications] failed", String(error));
    return null;
  }
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
        m.resolved_outcome
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
        and m.resolved_outcome is not null
        and upper(m.resolved_outcome) in ('YES', 'NO')
    `,
    [inputs.userId, inputs.walletAddress, inputs.venue],
  );

  let created = 0;
  for (const row of rows) {
    const resolved = normalizeOutcome(row.resolved_outcome);
    const side = normalizeOutcome(row.outcome_side);
    if (!resolved || !side) continue;

    const result = await createResolvedPositionNotificationIfVisible(pool, {
      userId: inputs.userId,
      position: row,
      resolvedOutcome: resolved,
      outcomeSide: side,
    });

    if (result) created += 1;
  }

  return created;
}
