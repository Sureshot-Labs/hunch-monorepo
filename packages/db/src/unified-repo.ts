import { Pool } from "pg";

// Types for unified tables
export interface UnifiedEventRow {
  id: string; // venue:venue_event_id
  venue: string;
  venue_event_id: string;
  title: string;
  description?: string;
  category?: string;
  status: 'ACTIVE' | 'CLOSED' | 'SETTLED' | 'ARCHIVED';
  start_date?: Date;
  end_date?: Date;
  volume_total?: number;
  volume_24h?: number;
  liquidity?: number;
  created_at?: Date;
  updated_at?: Date;
}

export interface UnifiedMarketRow {
  id: string; // venue:venue_market_id
  venue: string;
  venue_market_id: string;
  event_id: string; // References unified_events.id
  title: string;
  description?: string;
  category?: string;
  status: 'ACTIVE' | 'CLOSED' | 'SETTLED' | 'ARCHIVED';
  market_type: string;
  open_time?: Date;
  close_time?: Date;
  expiration_time?: Date;
  best_bid?: number;
  best_ask?: number;
  last_price?: number;
  volume_total?: number;
  volume_24h?: number;
  liquidity?: number;
  outcomes?: string; // JSON string
  created_at?: Date;
  updated_at?: Date;
}

// Repository functions for unified tables
export async function upsertUnifiedEvent(
  pool: Pool,
  eventRow: UnifiedEventRow
): Promise<string> {
  const query = `
    INSERT INTO unified_events (
      id, venue, venue_event_id, title, description, category, status,
      start_date, end_date, volume_total, volume_24h, liquidity,
      created_at, updated_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14
    )
    ON CONFLICT (venue, venue_event_id) 
    DO UPDATE SET
      title = EXCLUDED.title,
      description = EXCLUDED.description,
      category = EXCLUDED.category,
      status = EXCLUDED.status,
      start_date = EXCLUDED.start_date,
      end_date = EXCLUDED.end_date,
      volume_total = EXCLUDED.volume_total,
      volume_24h = EXCLUDED.volume_24h,
      liquidity = EXCLUDED.liquidity,
      created_at = EXCLUDED.created_at,
      updated_at = EXCLUDED.updated_at,
      updated_at_db = now()
    RETURNING id
  `;

  const values = [
    eventRow.id,
    eventRow.venue,
    eventRow.venue_event_id,
    eventRow.title,
    eventRow.description,
    eventRow.category,
    eventRow.status,
    eventRow.start_date,
    eventRow.end_date,
    eventRow.volume_total,
    eventRow.volume_24h,
    eventRow.liquidity,
    eventRow.created_at,
    eventRow.updated_at,
  ];

  const result = await pool.query(query, values);
  return result.rows[0].id;
}

export async function upsertUnifiedMarket(
  pool: Pool,
  marketRow: UnifiedMarketRow
): Promise<string> {
  const query = `
    INSERT INTO unified_markets (
      id, venue, venue_market_id, event_id, title, description, category, status,
      market_type, open_time, close_time, expiration_time, best_bid, best_ask,
      last_price, volume_total, volume_24h, liquidity, outcomes,
      created_at, updated_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21
    )
    ON CONFLICT (venue, venue_market_id) 
    DO UPDATE SET
      event_id = EXCLUDED.event_id,
      title = EXCLUDED.title,
      description = EXCLUDED.description,
      category = EXCLUDED.category,
      status = EXCLUDED.status,
      market_type = EXCLUDED.market_type,
      open_time = EXCLUDED.open_time,
      close_time = EXCLUDED.close_time,
      expiration_time = EXCLUDED.expiration_time,
      best_bid = EXCLUDED.best_bid,
      best_ask = EXCLUDED.best_ask,
      last_price = EXCLUDED.last_price,
      volume_total = EXCLUDED.volume_total,
      volume_24h = EXCLUDED.volume_24h,
      liquidity = EXCLUDED.liquidity,
      outcomes = EXCLUDED.outcomes,
      created_at = EXCLUDED.created_at,
      updated_at = EXCLUDED.updated_at,
      updated_at_db = now()
    RETURNING id
  `;

  const values = [
    marketRow.id,
    marketRow.venue,
    marketRow.venue_market_id,
    marketRow.event_id,
    marketRow.title,
    marketRow.description,
    marketRow.category,
    marketRow.status,
    marketRow.market_type,
    marketRow.open_time,
    marketRow.close_time,
    marketRow.expiration_time,
    marketRow.best_bid,
    marketRow.best_ask,
    marketRow.last_price,
    marketRow.volume_total,
    marketRow.volume_24h,
    marketRow.liquidity,
    marketRow.outcomes,
    marketRow.created_at,
    marketRow.updated_at,
  ];

  const result = await pool.query(query, values);
  return result.rows[0].id;
}
