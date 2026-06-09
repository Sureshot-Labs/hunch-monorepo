SET statement_timeout = 0;

CREATE TABLE IF NOT EXISTS unified_event_activity_snapshots_1h (
  event_id text NOT NULL,
  venue text NOT NULL,
  bucket timestamptz NOT NULL,
  volume_total numeric CHECK (volume_total >= 0),
  liquidity numeric CHECK (liquidity >= 0),
  open_interest numeric CHECK (open_interest >= 0),
  source_updated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, venue, bucket)
);

CREATE INDEX IF NOT EXISTS idx_unified_event_activity_snapshots_event_venue_bucket
  ON unified_event_activity_snapshots_1h (event_id, venue, bucket DESC)
  INCLUDE (volume_total, liquidity, open_interest);

CREATE INDEX IF NOT EXISTS idx_unified_event_activity_snapshots_bucket
  ON unified_event_activity_snapshots_1h (bucket DESC);

CREATE INDEX IF NOT EXISTS idx_um_activity_snapshots_event_venue_bucket_market
  ON unified_market_activity_snapshots_1h (event_id, venue, bucket DESC, market_id)
  INCLUDE (volume_total, liquidity);

CREATE OR REPLACE FUNCTION refresh_unified_event_activity_snapshots_1h(
  p_window interval DEFAULT interval '8 hours'
)
RETURNS void
LANGUAGE SQL
AS $$
  WITH deleted AS (
    DELETE FROM unified_event_activity_snapshots_1h
    WHERE bucket < now() - interval '90 days'
    RETURNING 1
  ),
  aggregated AS (
    SELECT
      s.event_id,
      s.venue,
      s.bucket,
      sum(s.volume_total) AS volume_total,
      sum(s.liquidity) AS liquidity,
      sum(s.open_interest) AS open_interest,
      max(s.source_updated_at) AS source_updated_at
    FROM unified_market_activity_snapshots_1h s
    WHERE s.bucket >= date_trunc(
        'hour',
        now() - CASE
          WHEN p_window IS NULL OR p_window <= interval '0 seconds'
            THEN interval '8 hours'
          ELSE p_window
        END
      )
      AND s.bucket <= date_trunc('hour', now())
    GROUP BY s.event_id, s.venue, s.bucket
  )
  INSERT INTO unified_event_activity_snapshots_1h (
    event_id,
    venue,
    bucket,
    volume_total,
    liquidity,
    open_interest,
    source_updated_at,
    created_at,
    updated_at
  )
  SELECT
    event_id,
    venue,
    bucket,
    volume_total,
    liquidity,
    open_interest,
    source_updated_at,
    now(),
    now()
  FROM aggregated
  ON CONFLICT (event_id, venue, bucket) DO UPDATE
    SET volume_total = EXCLUDED.volume_total,
        liquidity = EXCLUDED.liquidity,
        open_interest = EXCLUDED.open_interest,
        source_updated_at = EXCLUDED.source_updated_at,
        updated_at = EXCLUDED.updated_at
    WHERE unified_event_activity_snapshots_1h.volume_total IS DISTINCT FROM EXCLUDED.volume_total
       OR unified_event_activity_snapshots_1h.liquidity IS DISTINCT FROM EXCLUDED.liquidity
       OR unified_event_activity_snapshots_1h.open_interest IS DISTINCT FROM EXCLUDED.open_interest
       OR unified_event_activity_snapshots_1h.source_updated_at IS DISTINCT FROM EXCLUDED.source_updated_at
$$;

CREATE OR REPLACE FUNCTION refresh_unified_market_activity_metrics_1h_job(
  job_id int,
  config jsonb
)
RETURNS void
LANGUAGE SQL
AS $$
  SELECT
    refresh_unified_market_activity_metrics_1h(),
    refresh_unified_event_activity_snapshots_1h(interval '8 hours')
$$;

SELECT refresh_unified_event_activity_snapshots_1h(interval '8 days');
