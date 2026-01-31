/* no-transaction */
SET statement_timeout = 0;

CREATE TABLE IF NOT EXISTS unified_market_change_24h (
  market_id text PRIMARY KEY,
  change_24h numeric,
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_unified_market_change_24h_change
  ON unified_market_change_24h (change_24h DESC);

CREATE OR REPLACE FUNCTION refresh_unified_market_change_24h()
RETURNS void
LANGUAGE SQL
AS $$
  INSERT INTO unified_market_change_24h (
    market_id,
    change_24h,
    updated_at
  )
  SELECT
    mt.market_id,
    tc.change_24h,
    now()
  FROM unified_market_tokens mt
  JOIN unified_markets m on m.id = mt.market_id
  LEFT JOIN unified_token_change_24h tc on tc.token_id = mt.token_id
  WHERE m.status = 'ACTIVE'
    AND mt.outcome_side = 'YES'
    AND (m.expiration_time IS NULL OR m.expiration_time > now())
    AND (m.close_time IS NULL OR m.close_time > now())
  ON CONFLICT (market_id) DO UPDATE
    SET change_24h = EXCLUDED.change_24h,
        updated_at = EXCLUDED.updated_at
$$;

-- Wrapper for Timescale background job signature.
CREATE OR REPLACE FUNCTION refresh_unified_market_change_24h_job(
  job_id int,
  config jsonb
)
RETURNS void
LANGUAGE SQL
AS $$
  SELECT refresh_unified_market_change_24h()
$$;

SELECT refresh_unified_market_change_24h()
WHERE EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb');

SELECT add_job('refresh_unified_market_change_24h_job', interval '10 minutes')
WHERE EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb')
  AND NOT EXISTS (
    SELECT 1
    FROM timescaledb_information.jobs
    WHERE proc_name IN (
      'refresh_unified_market_change_24h',
      'refresh_unified_market_change_24h_job'
    )
  );
