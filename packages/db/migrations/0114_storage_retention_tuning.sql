/* no-transaction */
SET lock_timeout = '5s';
SET statement_timeout = 0;

-- Keep raw book/trade retention at 30 days, but reduce high-cardinality
-- derived history to the windows the product actually exposes.
SELECT remove_retention_policy('unified_market_activity_snapshots_1h'::regclass, if_exists => true);
SELECT add_retention_policy('unified_market_activity_snapshots_1h'::regclass, INTERVAL '8 days', if_not_exists => true);

SELECT remove_retention_policy('unified_book_top_1m'::regclass, if_exists => true);
SELECT add_retention_policy('unified_book_top_1m'::regclass, INTERVAL '60 days', if_not_exists => true);

SELECT remove_retention_policy('unified_last_trade_1m'::regclass, if_exists => true);
SELECT add_retention_policy('unified_last_trade_1m'::regclass, INTERVAL '60 days', if_not_exists => true);

-- Wallet-intel cleanup deletes by timestamp. These tiny BRIN indexes keep
-- retention deletes from degrading into broad heap scans as history grows.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_wps_snapshot_at_brin
  ON wallet_position_snapshots USING brin (snapshot_at)
  WITH (pages_per_range = 64);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_wae_occurred_at_brin
  ON wallet_activity_events USING brin (occurred_at)
  WITH (pages_per_range = 64);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_wah_hour_bucket_brin
  ON wallet_activity_hourly USING brin (hour_bucket)
  WITH (pages_per_range = 64);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_wms_as_of_brin
  ON wallet_metrics_snapshots USING brin (as_of)
  WITH (pages_per_range = 64);
