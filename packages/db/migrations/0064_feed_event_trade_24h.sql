/* no-transaction */
SET statement_timeout = 0;

CREATE TABLE IF NOT EXISTS unified_event_trade_24h (
  event_id text PRIMARY KEY REFERENCES unified_events(id) ON DELETE CASCADE,
  volume_24h numeric,
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_unified_event_trade_24h_volume
  ON unified_event_trade_24h (volume_24h DESC);

CREATE OR REPLACE FUNCTION refresh_unified_event_trade_24h()
RETURNS void
LANGUAGE SQL
AS $$
  INSERT INTO unified_event_trade_24h (
    event_id,
    volume_24h,
    updated_at
  )
  SELECT
    e.id,
    sum(mt24.volume_24h) AS volume_24h,
    now()
  FROM unified_market_trade_24h mt24
  JOIN unified_markets m ON m.id = mt24.market_id
  JOIN unified_events e ON e.id = m.event_id
  WHERE m.status = 'ACTIVE'
    AND e.status = 'ACTIVE'
    AND m.venue <> 'limitless'
    AND (m.expiration_time IS NULL OR m.expiration_time > now())
    AND (m.close_time IS NULL OR m.close_time > now())
    AND (e.end_date IS NULL OR e.end_date > now())
  GROUP BY e.id
  ON CONFLICT (event_id) DO UPDATE
    SET volume_24h = EXCLUDED.volume_24h,
        updated_at = EXCLUDED.updated_at
$$;

-- Wrapper for Timescale background job signature.
CREATE OR REPLACE FUNCTION refresh_unified_event_trade_24h_job(
  job_id int,
  config jsonb
)
RETURNS void
LANGUAGE SQL
AS $$
  SELECT refresh_unified_event_trade_24h()
$$;

SELECT refresh_unified_event_trade_24h()
WHERE EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb');

SELECT add_job('refresh_unified_event_trade_24h_job', interval '10 minutes')
WHERE EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb')
  AND NOT EXISTS (
    SELECT 1
    FROM timescaledb_information.jobs
    WHERE proc_name IN (
      'refresh_unified_event_trade_24h',
      'refresh_unified_event_trade_24h_job'
    )
  );
