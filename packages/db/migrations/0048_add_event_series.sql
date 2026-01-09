-- Add unified event series fields for cross-venue grouping
ALTER TABLE unified_events
  ADD COLUMN IF NOT EXISTS series_key text,
  ADD COLUMN IF NOT EXISTS series_title text;

CREATE INDEX IF NOT EXISTS idx_unified_events_venue_series_key
  ON unified_events (venue, series_key)
  WHERE series_key IS NOT NULL;

-- Backfill Polymarket series metadata from raw payload
UPDATE unified_events e
SET
  series_key = NULLIF(pe.raw->>'seriesSlug', ''),
  series_title = NULLIF(pe.raw->>'seriesTitle', '')
FROM polymarket_events pe
WHERE e.venue = 'polymarket'
  AND e.venue_event_id = pe.id
  AND (e.series_key IS NULL OR e.series_title IS NULL);

-- Backfill Kalshi series ticker where available
UPDATE unified_events e
SET series_key = NULLIF(ke.series_ticker, '')
FROM kalshi_events ke
WHERE e.venue = 'kalshi'
  AND e.venue_event_id = ke.event_ticker
  AND e.series_key IS NULL;
