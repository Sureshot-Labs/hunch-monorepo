/* no-transaction */

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_unified_markets_resolution_observed
  ON unified_markets(resolution_observed_at ASC, id ASC)
  WHERE resolution_observed_at IS NOT NULL;
