import type { Pool } from "@hunch/infra";

export type WatchlistRow = {
  watchlist_id: string;
  watchlist_created_at: Date;
  event_id: string;
  event_title: string | null;
  category: string | null;
  start_date: unknown;
  end_date: unknown;
  event_liquidity: unknown;
  event_volume: unknown;
  event_volume_24h: unknown;
  event_open_interest: unknown;
  event_slug: string | null;
  event_image: string | null;
  event_icon: string | null;
  market_uuid: string;
  venue: string;
  venue_market_id: string;
  market_title: string | null;
  market_slug: string | null;
  volume_24h: unknown;
  volume_total: unknown;
  open_interest: unknown;
  liquidity: unknown;
  best_bid: unknown;
  best_ask: unknown;
  token_yes: unknown;
  token_no: unknown;
  clob_token_ids: unknown;
  condition_id: unknown;
  market_category: string | null;
  market_image: string | null;
  market_icon: string | null;
  market_status: unknown;
  close_time: unknown;
  expiration_time: unknown;
  pm_accepting_orders: boolean | null;
  last_update: unknown;
};

export async function fetchWatchlistPage(
  pool: Pool,
  input: {
    userId: string;
    limit: number;
    offset: number;
    includeInactive: boolean;
  },
): Promise<{ rows: WatchlistRow[]; total: number }> {
  const statusFilter = input.includeInactive
    ? ""
    : "AND m.status = 'ACTIVE' AND (m.expiration_time IS NULL OR m.expiration_time > now()) AND (m.close_time IS NULL OR m.close_time > now())";

  const watchlistSql = `
    SELECT
      w.id as watchlist_id,
      w.created_at as watchlist_created_at,
      e.id as event_id,
      e.title as event_title,
      e.category,
      e.start_date,
      e.end_date,
      e.liquidity as event_liquidity,
      e.volume_total as event_volume,
      e.volume_24h as event_volume_24h,
      e.open_interest as event_open_interest,
      e.slug as event_slug,
      e.image as event_image,
      e.icon as event_icon,
      m.id as market_uuid,
      m.venue,
      m.venue_market_id,
      m.title as market_title,
      m.volume_24h,
      m.volume_total,
      m.open_interest,
      m.liquidity,
      m.best_bid,
      m.best_ask,
      m.last_price,
      m.token_yes,
      m.token_no,
      m.clob_token_ids,
      m.condition_id,
      m.slug as market_slug,
      m.category as market_category,
      m.image as market_image,
      m.icon as market_icon,
      m.status as market_status,
      m.close_time,
      m.expiration_time,
      pm.accepting_orders as pm_accepting_orders,
      m.updated_at as last_update
    FROM user_watchlist w
    JOIN unified_markets m ON m.id = w.market_id
    JOIN unified_events e ON e.id = m.event_id
    LEFT JOIN polymarket_markets pm
      ON pm.id = m.venue_market_id AND m.venue = 'polymarket'
    WHERE w.user_id = $1
    ${statusFilter}
    ORDER BY w.created_at DESC
    LIMIT $2 OFFSET $3
  `;

  const countSql = `
    SELECT COUNT(*) as total
    FROM user_watchlist w
    JOIN unified_markets m ON m.id = w.market_id
    WHERE w.user_id = $1
    ${statusFilter}
  `;

  const client = await pool.connect();
  try {
    const { rows } = await client.query<WatchlistRow>(watchlistSql, [
      input.userId,
      input.limit,
      input.offset,
    ]);
    const countResult = await client.query<{ total: string }>(countSql, [
      input.userId,
    ]);
    const total = parseInt(countResult.rows[0].total);
    return { rows, total };
  } finally {
    client.release();
  }
}
