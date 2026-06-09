/* no-transaction */
SET lock_timeout = '5s';
SET statement_timeout = 0;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_wallet_activity_hourly_wallet_last_activity
  ON wallet_activity_hourly (wallet_id, last_occurred_at DESC)
  WHERE last_occurred_at IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_wallet_activity_hourly_wallet_last_activity_trade
  ON wallet_activity_hourly (wallet_id, last_occurred_at DESC)
  WHERE activity_type IN ('delta', 'trade')
    AND last_occurred_at IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_wallet_activity_hourly_wallet_last_activity_holder
  ON wallet_activity_hourly (wallet_id, last_occurred_at DESC)
  WHERE activity_type = 'holder'
    AND last_occurred_at IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_wallet_activity_hourly_wallet_null_last_activity
  ON wallet_activity_hourly (wallet_id)
  WHERE last_occurred_at IS NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_unified_market_tokens_market_id_yes_token
  ON unified_market_tokens (market_id, token_id)
  WHERE outcome_side = 'YES';

DROP INDEX CONCURRENTLY IF EXISTS idx_unified_market_tokens_market_id_yes;
