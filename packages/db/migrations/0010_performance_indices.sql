-- Migration: Performance optimization indices
-- Adds missing composite indices for common query patterns

-- ============================================================
-- Events table indices
-- ============================================================

-- For filtering active/closed events by venue
CREATE INDEX IF NOT EXISTS idx_events_venue_active_closed 
  ON events(venue_id, active, closed) 
  WHERE active = TRUE AND closed = FALSE;

-- For filtering by category
CREATE INDEX IF NOT EXISTS idx_events_category 
  ON events(category) 
  WHERE category IS NOT NULL;

-- For sorting by start/end time
CREATE INDEX IF NOT EXISTS idx_events_start_time_desc 
  ON events(start_time DESC NULLS LAST, id);

CREATE INDEX IF NOT EXISTS idx_events_end_time_asc 
  ON events(end_time ASC NULLS LAST, id);

-- For filtering by volume
CREATE INDEX IF NOT EXISTS idx_events_volume_desc 
  ON events(volume_total DESC NULLS LAST, id);

-- Full text search on title
CREATE INDEX IF NOT EXISTS idx_events_title_search 
  ON events USING GIN (to_tsvector('english', title));

-- ============================================================
-- Markets table indices
-- ============================================================

-- For filtering accepting orders
CREATE INDEX IF NOT EXISTS idx_markets_accepting_orders 
  ON markets(venue_id, accepting_orders, enable_orderbook) 
  WHERE accepting_orders = TRUE AND enable_orderbook = TRUE;

-- For sorting by volume
CREATE INDEX IF NOT EXISTS idx_markets_volume24h_desc 
  ON markets(volume24hr DESC NULLS LAST, market_id);

-- For sorting by liquidity
CREATE INDEX IF NOT EXISTS idx_markets_liquidity_desc 
  ON markets(liquidity DESC NULLS LAST, market_id);

-- Composite index for feed queries (venue + volume filter + sort)
CREATE INDEX IF NOT EXISTS idx_markets_venue_volume_liquidity 
  ON markets(venue_id, volume24hr, liquidity) 
  WHERE volume24hr > 0 AND enable_orderbook = TRUE;

-- ============================================================
-- Book top table indices (time-series optimizations)
-- ============================================================

-- For price range queries
CREATE INDEX IF NOT EXISTS idx_book_top_token_ts_price 
  ON book_top(token_id, ts DESC, best_bid, best_ask);

-- For spread calculations
CREATE INDEX IF NOT EXISTS idx_book_top_token_spread 
  ON book_top(token_id, ts DESC, spread);

-- ============================================================
-- Last trade table indices
-- ============================================================

-- For OHLC calculations
CREATE INDEX IF NOT EXISTS idx_last_trade_token_ts_price 
  ON last_trade(token_id, ts DESC, price);

-- For volume queries
CREATE INDEX IF NOT EXISTS idx_last_trade_token_size 
  ON last_trade(token_id, ts DESC, size);

-- ============================================================
-- Orders table indices
-- ============================================================

-- For user order queries with status filter (using posted_at instead of created_at)
CREATE INDEX IF NOT EXISTS idx_orders_user_status_created 
  ON orders(user_id, status, posted_at DESC);

-- For venue order queries
CREATE INDEX IF NOT EXISTS idx_orders_venue_status 
  ON orders(venue_id, status, posted_at DESC);

-- For token order queries
CREATE INDEX IF NOT EXISTS idx_orders_token_status 
  ON orders(token_id, status, posted_at DESC);

-- For finding pending orders
CREATE INDEX IF NOT EXISTS idx_orders_pending 
  ON orders(user_id, posted_at DESC) 
  WHERE status IN ('PENDING', 'SUBMITTED', 'PARTIALLY_FILLED');

-- ============================================================
-- Trading Trades table indices
-- ============================================================

-- For user trade history (using trading_trades table)
CREATE INDEX IF NOT EXISTS idx_trades_user_executed 
  ON trading_trades(user_id, executed_at DESC);

-- For token trade history
CREATE INDEX IF NOT EXISTS idx_trades_token_executed 
  ON trading_trades(token_id, executed_at DESC);

-- For order trade lookups
CREATE INDEX IF NOT EXISTS idx_trades_order_executed 
  ON trading_trades(order_id, executed_at DESC);

-- ============================================================
-- User Positions table indices
-- ============================================================

-- For user position queries
CREATE INDEX IF NOT EXISTS idx_positions_user_token 
  ON user_positions(user_id, token_id);

-- For active positions (quantity > 0)
CREATE INDEX IF NOT EXISTS idx_positions_active 
  ON user_positions(user_id, updated_at DESC) 
  WHERE quantity > 0;

-- ============================================================
-- User exposure tracking indices
-- ============================================================

-- For daily volume queries
CREATE INDEX IF NOT EXISTS idx_user_exposure_daily_volume 
  ON user_exposure_tracking(user_id, daily_order_volume_usd DESC);

-- For finding users near limits
CREATE INDEX IF NOT EXISTS idx_user_exposure_high_usage 
  ON user_exposure_tracking(daily_order_volume_usd DESC) 
  WHERE daily_order_volume_usd > 5000;

-- ============================================================
-- Alerts table indices
-- ============================================================

-- For unacknowledged critical alerts
CREATE INDEX IF NOT EXISTS idx_alerts_unacknowledged_critical 
  ON alerts(created_at DESC) 
  WHERE acknowledged = FALSE AND severity = 'CRITICAL';

-- For alert type queries
CREATE INDEX IF NOT EXISTS idx_alerts_type_created 
  ON alerts(alert_type, created_at DESC);

-- ============================================================
-- DLQ indices (already created in migration 0009, but added here for reference)
-- ============================================================

-- These were created in 0009_dead_letter_queue.sql:
-- idx_failed_ingestion_source
-- idx_failed_ingestion_resource_type  
-- idx_failed_ingestion_status
-- idx_failed_ingestion_next_retry
-- idx_failed_ingestion_created
-- idx_failed_ingestion_error_type

-- ============================================================
-- Analyze tables to update statistics
-- ============================================================

ANALYZE events;
ANALYZE markets;
ANALYZE book_top;
ANALYZE last_trade;
ANALYZE orders;
ANALYZE trades;
ANALYZE user_positions;
ANALYZE user_exposure_tracking;
ANALYZE alerts;
ANALYZE failed_ingestion;

-- ============================================================
-- Comments for documentation
-- ============================================================

COMMENT ON INDEX idx_events_venue_active_closed IS 'Optimize queries for active markets by venue';
COMMENT ON INDEX idx_markets_accepting_orders IS 'Optimize queries for tradeable markets';
COMMENT ON INDEX idx_book_top_token_ts_price IS 'Optimize price range queries';
COMMENT ON INDEX idx_orders_user_status_created IS 'Optimize user order history queries';
COMMENT ON INDEX idx_trades_user_executed IS 'Optimize user trade history queries';
COMMENT ON INDEX idx_positions_active IS 'Optimize active position queries';
COMMENT ON INDEX idx_user_exposure_high_usage IS 'Optimize finding users approaching limits';

