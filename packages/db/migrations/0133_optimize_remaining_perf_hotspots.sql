/* no-transaction */
SET lock_timeout = '5s';
SET statement_timeout = 0;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_unified_markets_feed_event_renderable_active_open
  ON unified_markets (event_id, expiration_time, close_time)
  WHERE status = 'ACTIVE'
    AND (
      venue <> 'kalshi'
      OR lower(coalesce(metadata->>'dflowNativeAcceptingOrders', 'false')) = 'true'
    )
    AND (
      coalesce(volume_total, 0) > 0
      OR coalesce(volume_24h, 0) > 0
      OR coalesce(liquidity, 0) > 0
      OR coalesce(open_interest, 0) > 0
      OR best_bid IS NOT NULL
      OR best_ask IS NOT NULL
      OR last_price IS NOT NULL
    );

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_unified_markets_active_open_candidate
  ON unified_markets (close_time, expiration_time, id)
  WHERE status = 'ACTIVE';

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_unified_markets_activity_recent_active
  ON unified_markets (updated_at_db DESC, id)
  INCLUDE (
    event_id,
    venue,
    expiration_time,
    close_time,
    volume_total,
    liquidity,
    open_interest,
    updated_at
  )
  WHERE status = 'ACTIVE'
    AND (
      coalesce(CASE WHEN volume_total > 0 THEN volume_total ELSE 0 END, 0) > 0
      OR coalesce(CASE WHEN liquidity > 0 THEN liquidity ELSE 0 END, 0) > 0
      OR coalesce(CASE WHEN open_interest > 0 THEN open_interest ELSE 0 END, 0) > 0
    );
