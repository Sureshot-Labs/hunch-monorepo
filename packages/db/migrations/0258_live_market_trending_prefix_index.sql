-- Exact live-score prefix for time-filtered market discovery. Event bonuses
-- stay in the query, which can stop only after proving no unseen score wins.
-- Keep raw numeric operands available for PostgreSQL index-only scans.
/* no-transaction */
-- Concurrent builds scan the table and wait for existing transactions.
-- The production query default (120 seconds) is not a build-time budget.
SET statement_timeout = '15min';
DROP INDEX CONCURRENTLY IF EXISTS idx_unified_markets_live_trending_prefix;
CREATE INDEX CONCURRENTLY idx_unified_markets_live_trending_prefix
  ON unified_markets (
    ((coalesce(case when volume_total is not null and volume_total > 0
      then volume_total else null end, 0) * 0.4
      + coalesce(coalesce(nullif(liquidity, 0), nullif(open_interest, 0)), 0) * 0.3)) DESC NULLS LAST,
    id
  )
  INCLUDE (venue, volume_total, liquidity, open_interest)
  WHERE status = 'ACTIVE'
    AND (venue <> 'kalshi'
      OR lower(coalesce(metadata->>'dflowNativeAcceptingOrders', 'false')) = 'true')
    AND (coalesce(volume_total, 0) > 0 OR coalesce(volume_24h, 0) > 0
      OR coalesce(liquidity, 0) > 0 OR coalesce(open_interest, 0) > 0
      OR best_bid IS NOT NULL OR best_ask IS NOT NULL OR last_price IS NOT NULL);
RESET statement_timeout;
