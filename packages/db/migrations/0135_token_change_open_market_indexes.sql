/* no-transaction */
SET lock_timeout = '5s';
SET statement_timeout = 0;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_unified_markets_active_open_null_close_exp_id
  ON unified_markets (expiration_time, id)
  WHERE status = 'ACTIVE'
    AND close_time IS NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_unified_markets_active_open_close_exp_id
  ON unified_markets (close_time, expiration_time, id)
  WHERE status = 'ACTIVE'
    AND close_time IS NOT NULL;
