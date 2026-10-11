import type { Pool } from "@hunch/infra";
import { POSITION_TOKEN_MARKET_JOIN_SQL } from "../lib/pnl-sql.js";
import {
  polymarketOrderBindingJoinSql,
  polymarketOrderMarketIdSql,
} from "../lib/polymarket-order-ledger-sql.js";

export type UserMarketInteractionRow = {
  market_id: string;
  ts: Date | string | number | null;
  weight: number;
  event_id: string;
  market_status: string | null;
  event_status: string | null;
  end_date: Date | string | number | null;
};

// Keep the existing interaction inclusion/weights. Only asset identity changes:
// a historical holding/order must not depend on the current trade projection.
export async function fetchUserMarketInteractions(
  db: Pick<Pool, "query">,
  userId: string,
) {
  const { rows } = await db.query<UserMarketInteractionRow>(
    `
    with interactions as (
      select w.market_id, w.created_at as ts, 3 as weight
      from user_watchlist w where w.user_id = $1::uuid
      union all
      select ${polymarketOrderMarketIdSql("o", "ut.market_id")}, o.posted_at, 2
      from orders o
      ${polymarketOrderBindingJoinSql("o")}
      left join unified_tokens ut on ut.token_id = o.token_id and ut.venue = o.venue
      where o.user_id = $1::uuid
      union all
      select umt.market_id, p.last_updated_at, 1
      from positions p
      ${POSITION_TOKEN_MARKET_JOIN_SQL}
      where p.user_id = $1::uuid and p.position_scope = 'own'
    )
    select i.market_id, i.ts, i.weight, m.event_id,
      m.status as market_status, e.status as event_status, e.end_date
    from interactions i
    join unified_markets m on m.id = i.market_id
    join unified_events e on e.id = m.event_id
    where i.ts is not null
  `,
    [userId],
  );
  return rows;
}
