/* no-transaction */
SET statement_timeout = 0;

CREATE TABLE IF NOT EXISTS unified_event_change_24h (
  event_id text PRIMARY KEY REFERENCES unified_events(id) ON DELETE CASCADE,
  change_24h numeric,
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_unified_event_change_24h_change
  ON unified_event_change_24h (change_24h DESC);

CREATE OR REPLACE FUNCTION refresh_unified_event_change_24h()
RETURNS void
LANGUAGE SQL
AS $$
  INSERT INTO unified_event_change_24h (
    event_id,
    change_24h,
    updated_at
  )
  SELECT
    e.id,
    avg(mc.change_24h) AS change_24h,
    now()
  FROM unified_events e
  JOIN unified_markets m ON m.event_id = e.id
  LEFT JOIN unified_market_change_24h mc ON mc.market_id = m.id
  WHERE e.status = 'ACTIVE'
    AND m.status = 'ACTIVE'
    AND (e.end_date IS NULL OR e.end_date > now())
    AND (m.expiration_time IS NULL OR m.expiration_time > now())
    AND (m.close_time IS NULL OR m.close_time > now())
  GROUP BY e.id
  ON CONFLICT (event_id) DO UPDATE
    SET change_24h = EXCLUDED.change_24h,
        updated_at = EXCLUDED.updated_at
$$;

CREATE OR REPLACE FUNCTION refresh_unified_event_change_24h_job(
  job_id int,
  config jsonb
)
RETURNS void
LANGUAGE SQL
AS $$
  SELECT refresh_unified_event_change_24h()
$$;

SELECT refresh_unified_event_change_24h();

SELECT add_job('refresh_unified_event_change_24h_job', interval '10 minutes')
WHERE EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb')
  AND NOT EXISTS (
    SELECT 1
    FROM timescaledb_information.jobs
    WHERE proc_name IN (
      'refresh_unified_event_change_24h',
      'refresh_unified_event_change_24h_job'
    )
  );
