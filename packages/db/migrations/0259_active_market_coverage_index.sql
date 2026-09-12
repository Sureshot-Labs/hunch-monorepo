-- /meta/venues counts every ACTIVE market, including unpriced rows. Cover
-- its counters without fetching large market payloads from the heap.
/* no-transaction */
SET statement_timeout = '15min';
DROP INDEX CONCURRENTLY IF EXISTS idx_unified_markets_active_coverage;
CREATE INDEX CONCURRENTLY idx_unified_markets_active_coverage
  ON unified_markets (venue)
  INCLUDE (volume_24h, volume_total, liquidity, open_interest,
    best_bid, best_ask, last_price)
  WHERE status = 'ACTIVE';
-- Exact event volume fallback sums only positive amounts. Eligibility is
-- still checked by the query. Zero-volume markets still count for scope.
DROP INDEX CONCURRENTLY IF EXISTS idx_unified_markets_event_positive_volume;
CREATE INDEX CONCURRENTLY idx_unified_markets_event_positive_volume
  ON unified_markets (event_id, expiration_time, close_time)
  INCLUDE (volume_total, venue, venue_market_id)
  WHERE status = 'ACTIVE' AND volume_total > 0
    AND (venue <> 'kalshi'
      OR lower(coalesce(metadata->>'dflowNativeAcceptingOrders', 'false')) = 'true');
RESET statement_timeout;
