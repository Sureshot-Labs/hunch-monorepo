SET statement_timeout = 0;

-- Event activity snapshots are derived from market activity snapshots. Keep
-- cleanup bounded so the hourly refresh never becomes one huge delete.
CREATE OR REPLACE FUNCTION cleanup_unified_event_activity_snapshots_1h(
  p_retention interval DEFAULT interval '8 days',
  p_limit integer DEFAULT 50000
)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_deleted integer := 0;
  v_limit integer := greatest(1, coalesce(p_limit, 50000));
  v_retention interval := coalesce(p_retention, interval '8 days');
BEGIN
  WITH doomed AS (
    SELECT ctid
    FROM unified_event_activity_snapshots_1h
    WHERE bucket < now() - v_retention
    ORDER BY bucket ASC
    LIMIT v_limit
  )
  DELETE FROM unified_event_activity_snapshots_1h s
  USING doomed d
  WHERE s.ctid = d.ctid;

  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

CREATE OR REPLACE FUNCTION refresh_unified_event_activity_snapshots_1h(
  p_window interval DEFAULT interval '8 hours'
)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM cleanup_unified_event_activity_snapshots_1h(interval '8 days', 50000);

  WITH aggregated AS (
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
       OR unified_event_activity_snapshots_1h.source_updated_at IS DISTINCT FROM EXCLUDED.source_updated_at;
END;
$$;
