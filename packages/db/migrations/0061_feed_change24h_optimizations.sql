/* no-transaction */
SET statement_timeout = 0;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_unified_market_tokens_market_id_yes
  ON unified_market_tokens (market_id)
  WHERE outcome_side = 'YES';

CREATE TABLE IF NOT EXISTS unified_token_change_24h (
  token_id text PRIMARY KEY,
  avg_mid_now numeric,
  avg_mid_24h numeric,
  change_24h numeric,
  bucket_now timestamptz,
  bucket_24h timestamptz,
  updated_at timestamptz DEFAULT now()
);

CREATE OR REPLACE FUNCTION refresh_unified_token_change_24h()
RETURNS void
LANGUAGE SQL
AS $$
  INSERT INTO unified_token_change_24h (
    token_id,
    avg_mid_now,
    avg_mid_24h,
    change_24h,
    bucket_now,
    bucket_24h,
    updated_at
  )
  SELECT
    now_rows.token_id,
    now_rows.avg_mid,
    prev_rows.avg_mid,
    CASE
      WHEN now_rows.avg_mid IS NULL
        OR prev_rows.avg_mid IS NULL
        OR prev_rows.avg_mid = 0
      THEN NULL
      ELSE (now_rows.avg_mid - prev_rows.avg_mid) / prev_rows.avg_mid
    END AS change_24h,
    now_rows.bucket,
    prev_rows.bucket,
    now()
  FROM (
    SELECT DISTINCT ON (token_id)
      token_id,
      avg_mid,
      bucket
    FROM unified_book_top_1h
    WHERE bucket >= now() - interval '7 days'
    ORDER BY token_id, bucket DESC
  ) now_rows
  LEFT JOIN (
    SELECT DISTINCT ON (token_id)
      token_id,
      avg_mid,
      bucket
    FROM unified_book_top_1h
    WHERE bucket <= now() - interval '24 hours'
    ORDER BY token_id, bucket DESC
  ) prev_rows
    ON prev_rows.token_id = now_rows.token_id
  ON CONFLICT (token_id) DO UPDATE
    SET avg_mid_now = EXCLUDED.avg_mid_now,
        avg_mid_24h = EXCLUDED.avg_mid_24h,
        change_24h = EXCLUDED.change_24h,
        bucket_now = EXCLUDED.bucket_now,
        bucket_24h = EXCLUDED.bucket_24h,
        updated_at = EXCLUDED.updated_at
$$;

-- Wrapper for Timescale background job signature.
CREATE OR REPLACE FUNCTION refresh_unified_token_change_24h_job(
  job_id int,
  config jsonb
)
RETURNS void
LANGUAGE SQL
AS $$
  SELECT refresh_unified_token_change_24h()
$$;

SELECT refresh_unified_token_change_24h()
WHERE EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb');

SELECT add_job('refresh_unified_token_change_24h_job', interval '10 minutes')
WHERE EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb')
  AND NOT EXISTS (
    SELECT 1
    FROM timescaledb_information.jobs
    WHERE proc_name IN (
      'refresh_unified_token_change_24h',
      'refresh_unified_token_change_24h_job'
    )
  );
