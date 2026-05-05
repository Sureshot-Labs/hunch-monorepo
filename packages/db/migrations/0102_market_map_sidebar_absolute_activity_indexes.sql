CREATE INDEX IF NOT EXISTS idx_unified_event_activity_metrics_venue_volume_abs_change
  ON unified_event_activity_metrics_24h (
    venue,
    (abs(volume_last_24h_change)) DESC,
    volume_last_24h DESC
  )
  WHERE volume_valid AND volume_last_24h_change IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_unified_event_activity_metrics_venue_liquidity_abs_change
  ON unified_event_activity_metrics_24h (
    venue,
    (abs(liquidity_change_24h)) DESC,
    liquidity_now DESC
  )
  WHERE liquidity_valid AND liquidity_change_24h IS NOT NULL;
