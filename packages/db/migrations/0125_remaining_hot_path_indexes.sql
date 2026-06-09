/* no-transaction */
SET lock_timeout = '5s';
SET statement_timeout = 0;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_unified_markets_limitless_active_ws_targets
  ON unified_markets (
    volume_total DESC NULLS LAST,
    liquidity DESC NULLS LAST,
    updated_at_db DESC
  )
  INCLUDE (slug, metadata)
  WHERE venue = 'limitless'
    AND status = 'ACTIVE'
    AND (
      (
        coalesce(metadata->>'tradeType', 'clob') = 'amm'
        AND nullif(metadata->>'address', '') IS NOT NULL
      )
      OR (
        coalesce(metadata->>'tradeType', 'clob') <> 'amm'
        AND slug IS NOT NULL
      )
    );

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_unified_events_active_nonblank_category_lower
  ON unified_events (lower(category))
  WHERE status = 'ACTIVE'
    AND category IS NOT NULL
    AND btrim(category) <> '';

CREATE INDEX IF NOT EXISTS idx_unified_market_activity_snapshots_bucket_event_venue_cover
  ON unified_market_activity_snapshots_1h (
    bucket DESC,
    event_id,
    venue
  )
  INCLUDE (volume_total, liquidity, open_interest, source_updated_at);
