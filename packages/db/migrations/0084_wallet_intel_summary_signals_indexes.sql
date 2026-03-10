/* no-transaction */
SET lock_timeout = '5s';
SET statement_timeout = 0;

-- Speeds up signal-history lookups keyed by wallet + market and ordered by
-- the latest observed activity timestamp.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_wallet_activity_hourly_wallet_market_last_activity_trade
  ON wallet_activity_hourly (wallet_id, market_id, last_occurred_at DESC)
  WHERE activity_type IN ('delta', 'trade');

-- Speeds up baseline-sample counting for summary selectors and signal page-label
-- enrichment, which only care about trade/delta rows with a real size_usd.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_wallet_activity_events_wallet_time_trade_sized
  ON wallet_activity_events (wallet_id, occurred_at DESC)
  WHERE activity_type IN ('delta', 'trade')
    AND size_usd IS NOT NULL;
