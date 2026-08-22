/* no-transaction */
SET statement_timeout = 0;

DROP INDEX CONCURRENTLY IF EXISTS idx_unified_market_change_24h_v2_rank;

CREATE INDEX CONCURRENTLY idx_unified_market_change_24h_v2_rank
  ON unified_market_change_24h (change_24h DESC, market_id)
  WHERE calculation_version = 2
    AND change_24h IS NOT NULL;

DROP INDEX CONCURRENTLY IF EXISTS idx_unified_event_change_24h_v2_rank;

CREATE INDEX CONCURRENTLY idx_unified_event_change_24h_v2_rank
  ON unified_event_change_24h (change_24h DESC, event_id)
  WHERE calculation_version = 2
    AND change_24h IS NOT NULL;
