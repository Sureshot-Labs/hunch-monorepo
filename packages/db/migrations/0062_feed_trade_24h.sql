/* no-transaction */
SET statement_timeout = 0;

CREATE TABLE IF NOT EXISTS unified_market_trade_24h (
  market_id text PRIMARY KEY REFERENCES unified_markets(id) ON DELETE CASCADE,
  volume_24h numeric,
  vwap numeric,
  trades bigint,
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_unified_market_trade_24h_volume
  ON unified_market_trade_24h (volume_24h DESC);

CREATE OR REPLACE FUNCTION refresh_unified_market_trade_24h()
RETURNS void
LANGUAGE SQL
AS $$
  INSERT INTO unified_market_trade_24h (
    market_id,
    volume_24h,
    vwap,
    trades,
    updated_at
  )
  SELECT
    mt.market_id,
    sum(t.volume) AS volume_24h,
    CASE
      WHEN sum(t.volume) IS NULL OR sum(t.volume) = 0 THEN NULL
      ELSE sum(t.vwap * t.volume) / sum(t.volume)
    END AS vwap,
    sum(t.trades)::bigint AS trades,
    now()
  FROM unified_last_trade_1h t
  JOIN unified_market_tokens mt ON mt.token_id = t.token_id
  WHERE t.bucket >= now() - interval '24 hours'
  GROUP BY mt.market_id
  ON CONFLICT (market_id) DO UPDATE
    SET volume_24h = EXCLUDED.volume_24h,
        vwap = EXCLUDED.vwap,
        trades = EXCLUDED.trades,
        updated_at = EXCLUDED.updated_at
$$;

-- Wrapper for Timescale background job signature.
CREATE OR REPLACE FUNCTION refresh_unified_market_trade_24h_job(
  job_id int,
  config jsonb
)
RETURNS void
LANGUAGE SQL
AS $$
  SELECT refresh_unified_market_trade_24h()
$$;

SELECT refresh_unified_market_trade_24h()
WHERE EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb');

SELECT add_job('refresh_unified_market_trade_24h_job', interval '10 minutes')
WHERE EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb')
  AND NOT EXISTS (
    SELECT 1
    FROM timescaledb_information.jobs
    WHERE proc_name IN (
      'refresh_unified_market_trade_24h',
      'refresh_unified_market_trade_24h_job'
    )
  );
