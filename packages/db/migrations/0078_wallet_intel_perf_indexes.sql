/* no-transaction */
SET lock_timeout = '5s';
SET statement_timeout = 0;

-- Speeds up whale candidate extraction with tag-id anchored filtering.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_wallet_tag_map_tag_wallet
  ON wallet_tag_map (tag_id, wallet_id);

-- Speeds up latest positive-position lookups in whale top-markets hydration.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_wallet_position_snapshots_wallet_market_time_pos
  ON wallet_position_snapshots (wallet_id, market_id, snapshot_at DESC)
  WHERE shares > 0;

-- Helps window-first scans for trade/delta activity aggregation paths.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_wallet_activity_hourly_time_wallet_trade
  ON wallet_activity_hourly (hour_bucket DESC, wallet_id, venue, market_id, outcome_side)
  WHERE activity_type IN ('delta', 'trade');
