-- Prefer Polymarket series array metadata over seriesSlug when available
UPDATE unified_events e
SET
  series_key = coalesce(
    nullif(pe.raw->'series'->0->>'slug', ''),
    nullif(pe.raw->'series'->0->>'ticker', ''),
    nullif(pe.raw->>'seriesSlug', '')
  ),
  series_title = coalesce(
    nullif(pe.raw->'series'->0->>'title', ''),
    nullif(pe.raw->>'seriesTitle', '')
  )
FROM polymarket_events pe
WHERE e.venue = 'polymarket'
  AND e.venue_event_id = pe.id
  AND (
    pe.raw ? 'series'
    OR pe.raw ? 'seriesSlug'
    OR pe.raw ? 'seriesTitle'
  );
