-- Feed query performance: active-venue/time composite indexes
CREATE INDEX IF NOT EXISTS idx_unified_events_active_venue_end_date
  ON unified_events (venue, end_date)
  WHERE status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS idx_unified_markets_active_venue_exp_close
  ON unified_markets (venue, expiration_time, close_time)
  WHERE status = 'ACTIVE';
