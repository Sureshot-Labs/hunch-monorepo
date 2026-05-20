import type { Pool } from "@hunch/infra";
import { createNotificationSafe } from "./notifications.js";

type ResolvedPositionRow = {
  id: string;
  token_id: string;
  wallet_address: string;
  venue: string;
  market_id: string | null;
  outcome_side: string | null;
  resolved_outcome: string | null;
};

function normalizeOutcome(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim().toUpperCase();
  return trimmed === "YES" || trimmed === "NO" ? trimmed : null;
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
    const won = resolved === side;

    const title = won ? "Position resolved (win)" : "Position resolved (loss)";
    const body = won ? "Claim available" : "Resolved with no payout";

    const result = await createNotificationSafe(pool, {
      userId: inputs.userId,
      type: "position_resolved",
      title,
      body,
      severity: won ? "success" : "warning",
      data: {
        venue: row.venue,
        marketId: row.market_id ?? null,
        tokenId: row.token_id,
        walletAddress: row.wallet_address,
        resolvedOutcome: resolved,
        outcomeSide: side,
        result: won ? "won" : "lost",
      },
      dedupeKey: `position_resolved:${row.id}`,
    });

    if (result) created += 1;
  }

  return created;
}
