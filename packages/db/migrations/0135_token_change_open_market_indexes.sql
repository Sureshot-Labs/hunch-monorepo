/* no-transaction */
SET lock_timeout = '5min';
SET statement_timeout = 0;

DROP INDEX CONCURRENTLY IF EXISTS idx_unified_markets_active_open_null_close_exp_id;
DROP INDEX CONCURRENTLY IF EXISTS idx_unified_markets_active_open_close_exp_id;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_unified_markets_active_open_null_close_exp_id
  ON unified_markets (expiration_time, id)
  WHERE status = 'ACTIVE'
    AND close_time IS NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_unified_markets_active_open_close_exp_id
  ON unified_markets (close_time, expiration_time, id)
  WHERE status = 'ACTIVE'
    AND close_time IS NOT NULL;
