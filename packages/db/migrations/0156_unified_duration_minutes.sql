/* no-transaction */
SET lock_timeout = '5s';
SET statement_timeout = 0;

ALTER TABLE unified_events
  ADD COLUMN IF NOT EXISTS duration_minutes integer;

ALTER TABLE unified_markets
  ADD COLUMN IF NOT EXISTS duration_minutes integer;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_unified_events_active_duration_end
  ON unified_events (duration_minutes, end_date, id)
  WHERE status = 'ACTIVE' AND duration_minutes IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_unified_markets_active_duration_event
  ON unified_markets (duration_minutes, event_id, id)
  WHERE status = 'ACTIVE' AND duration_minutes IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_unified_markets_active_duration_venue_close
  ON unified_markets (duration_minutes, venue, close_time, expiration_time, id)
  WHERE status = 'ACTIVE' AND duration_minutes IS NOT NULL;
