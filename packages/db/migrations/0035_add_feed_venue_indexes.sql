-- Feed query performance: add indexes that match lower(venue) filters + status/time
CREATE INDEX IF NOT EXISTS idx_unified_events_lower_venue_status_end_date
  ON unified_events (lower(venue), status, end_date);

CREATE INDEX IF NOT EXISTS idx_unified_markets_lower_venue_status_exp_close
  ON unified_markets (lower(venue), status, expiration_time, close_time);
