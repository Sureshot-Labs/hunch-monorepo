import type { DbQuery } from "../db.js";
import { POSITION_TOKEN_MARKET_JOIN_SQL } from "../lib/pnl-sql.js";
import type { ResolvedPositionRow } from "../services/positions-notifications.js";

export type PositionResolutionCandidateRow = ResolvedPositionRow & {
  user_id: string;
};

// Start with the small portfolio set, not millions of resolved markets. The
// materialization keeps cutoff/order/limit from making PostgreSQL choose the
// resolution-time index and probing every historical market's tokens first.
// Map each eligible position once, before the market join can multiply probes.
// No early LIMIT: notified/ineligible rows must not starve later candidates.
export const POSITION_RESOLUTION_CANDIDATES_SQL = `
  with eligible_positions as materialized (
    select p.id, p.user_id, p.token_id, p.wallet_address, p.venue,
      p.position_contract, coalesce(p.last_updated_at, p.updated_at) as position_snapshot_at
    from positions p
    where p.position_scope = 'own'
      and p.size > 0
      and coalesce(p.is_hidden, false) = false
      and not exists (
        select 1 from notifications notification
        where notification.user_id = p.user_id
          and notification.dedupe_key = 'position_resolved:' || p.id::text
      )
  ), mapped_positions as materialized (
    select p.*, umt.market_id, umt.outcome_side
    from eligible_positions p
    ${POSITION_TOKEN_MARKET_JOIN_SQL}
  )
  select p.id, p.user_id, p.token_id, p.wallet_address, p.venue,
    market.id as market_id, p.outcome_side,
    market.resolved_outcome, market.resolved_outcome_pct, p.position_snapshot_at
  from mapped_positions p
  join unified_markets market on market.id = p.market_id and market.venue = p.venue
  where market.resolution_observed_at >= $1::timestamptz
    and (market.resolved_outcome is not null or market.resolved_outcome_pct is not null)
  order by market.resolution_observed_at asc, p.id asc
  limit $2
`;

export async function fetchPositionResolutionCandidates(
  db: DbQuery,
  effectiveAt: string,
  limit: number,
): Promise<PositionResolutionCandidateRow[]> {
  const { rows } = await db.query<PositionResolutionCandidateRow>(
    POSITION_RESOLUTION_CANDIDATES_SQL,
    [effectiveAt, limit],
  );
  return rows;
}
