SET statement_timeout = 0;

CREATE OR REPLACE FUNCTION refresh_unified_market_activity_snapshots_1h_incremental(
  p_changed_since interval DEFAULT interval '2 hours'
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_now timestamptz := now();
  v_bucket timestamptz := date_trunc('hour', now());
  v_cutoff timestamptz := now() - CASE
    WHEN p_changed_since IS NULL OR p_changed_since <= interval '0 seconds'
      THEN interval '2 hours'
    ELSE p_changed_since
  END;
BEGIN
  WITH snapshot_candidates AS MATERIALIZED (
    SELECT
      m.id AS market_id,
      m.event_id,
      m.venue,
      CASE WHEN m.volume_total >= 0 THEN m.volume_total ELSE NULL END AS volume_total,
      CASE WHEN m.liquidity >= 0 THEN m.liquidity ELSE NULL END AS liquidity,
      CASE WHEN m.open_interest >= 0 THEN m.open_interest ELSE NULL END AS open_interest,
      COALESCE(m.updated_at, m.updated_at_db) AS source_updated_at
    FROM unified_markets m
    JOIN unified_events e
      ON e.id = m.event_id
    WHERE m.status = 'ACTIVE'
      AND e.status = 'ACTIVE'
      AND m.updated_at_db >= v_cutoff
      AND (m.expiration_time IS NULL OR m.expiration_time > v_now)
      AND (m.close_time IS NULL OR m.close_time > v_now)
      AND (e.end_date IS NULL OR e.end_date > v_now)
      AND (
        COALESCE(CASE WHEN m.volume_total > 0 THEN m.volume_total ELSE 0 END, 0) > 0
        OR COALESCE(CASE WHEN m.liquidity > 0 THEN m.liquidity ELSE 0 END, 0) > 0
        OR COALESCE(CASE WHEN m.open_interest > 0 THEN m.open_interest ELSE 0 END, 0) > 0
      )
  ),
  current_snapshot AS MATERIALIZED (
    SELECT
      market_id,
      event_id,
      venue,
      volume_total,
      liquidity,
      open_interest,
      source_updated_at
    FROM unified_market_activity_snapshots_1h
    WHERE bucket = v_bucket
  ),
  changed_snapshot_candidates AS MATERIALIZED (
    SELECT sc.*
    FROM snapshot_candidates sc
    LEFT JOIN current_snapshot existing
      ON existing.market_id = sc.market_id
    WHERE existing.market_id IS NULL
       OR existing.event_id IS DISTINCT FROM sc.event_id
       OR existing.venue IS DISTINCT FROM sc.venue
       OR existing.volume_total IS DISTINCT FROM sc.volume_total
       OR existing.liquidity IS DISTINCT FROM sc.liquidity
       OR existing.open_interest IS DISTINCT FROM sc.open_interest
       OR existing.source_updated_at IS DISTINCT FROM sc.source_updated_at
  )
  INSERT INTO unified_market_activity_snapshots_1h (
    market_id,
    event_id,
    venue,
    bucket,
    volume_total,
    liquidity,
    open_interest,
    source_updated_at,
    created_at
  )
  SELECT
    market_id,
    event_id,
    venue,
    v_bucket,
    volume_total,
    liquidity,
    open_interest,
    source_updated_at,
    v_now
  FROM changed_snapshot_candidates
  ON CONFLICT (market_id, bucket) DO UPDATE
    SET event_id = EXCLUDED.event_id,
        venue = EXCLUDED.venue,
        volume_total = EXCLUDED.volume_total,
        liquidity = EXCLUDED.liquidity,
        open_interest = EXCLUDED.open_interest,
        source_updated_at = EXCLUDED.source_updated_at
  WHERE unified_market_activity_snapshots_1h.event_id IS DISTINCT FROM EXCLUDED.event_id
     OR unified_market_activity_snapshots_1h.venue IS DISTINCT FROM EXCLUDED.venue
     OR unified_market_activity_snapshots_1h.volume_total IS DISTINCT FROM EXCLUDED.volume_total
     OR unified_market_activity_snapshots_1h.liquidity IS DISTINCT FROM EXCLUDED.liquidity
     OR unified_market_activity_snapshots_1h.open_interest IS DISTINCT FROM EXCLUDED.open_interest
     OR unified_market_activity_snapshots_1h.source_updated_at IS DISTINCT FROM EXCLUDED.source_updated_at;
END;
$$;
