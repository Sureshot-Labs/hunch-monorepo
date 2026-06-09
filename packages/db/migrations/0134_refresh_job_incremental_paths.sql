SET statement_timeout = 0;

CREATE OR REPLACE FUNCTION refresh_unified_event_active_categories()
RETURNS void
LANGUAGE SQL
AS $$
  WITH RECURSIVE normalized(category) AS (
    (
      SELECT lower(category) AS category
      FROM unified_events
      WHERE status = 'ACTIVE'
        AND category IS NOT NULL
        AND btrim(category) <> ''
      ORDER BY lower(category)
      LIMIT 1
    )
    UNION ALL
    SELECT next_category.category
    FROM normalized n
    CROSS JOIN LATERAL (
      SELECT lower(e.category) AS category
      FROM unified_events e
      WHERE e.status = 'ACTIVE'
        AND e.category IS NOT NULL
        AND btrim(e.category) <> ''
        AND lower(e.category) > n.category
      ORDER BY lower(e.category)
      LIMIT 1
    ) next_category
  ),
  inserted AS (
    INSERT INTO unified_event_active_categories (
      category,
      updated_at
    )
    SELECT
      n.category,
      now()
    FROM normalized n
    WHERE NOT EXISTS (
      SELECT 1
      FROM unified_event_active_categories existing
      WHERE existing.category = n.category
    )
    ON CONFLICT (category) DO NOTHING
    RETURNING category
  )
  DELETE FROM unified_event_active_categories existing
  WHERE NOT EXISTS (
    SELECT 1
    FROM normalized n
    WHERE n.category = existing.category
  )
$$;

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
  changed_snapshot_candidates AS MATERIALIZED (
    SELECT sc.*
    FROM snapshot_candidates sc
    LEFT JOIN unified_market_activity_snapshots_1h existing
      ON existing.market_id = sc.market_id
     AND existing.bucket = v_bucket
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

CREATE OR REPLACE FUNCTION refresh_unified_market_activity_metrics_1h_job(
  job_id int,
  config jsonb
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_locked boolean;
BEGIN
  v_locked := pg_try_advisory_lock(
    hashtext('hunch_refresh'),
    hashtext('unified_market_activity_metrics_1h')
  );

  IF NOT v_locked THEN
    RETURN;
  END IF;

  BEGIN
    PERFORM refresh_unified_market_activity_snapshots_1h_incremental(interval '2 hours');
    PERFORM refresh_unified_event_activity_snapshots_1h(interval '2 hours');
  EXCEPTION
    WHEN OTHERS THEN
      PERFORM pg_advisory_unlock(
        hashtext('hunch_refresh'),
        hashtext('unified_market_activity_metrics_1h')
      );
      RAISE;
  END;

  PERFORM pg_advisory_unlock(
    hashtext('hunch_refresh'),
    hashtext('unified_market_activity_metrics_1h')
  );
END;
$$;

CREATE OR REPLACE FUNCTION refresh_unified_market_activity_metrics_1h_full_job(
  job_id int,
  config jsonb
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_locked boolean;
BEGIN
  v_locked := pg_try_advisory_lock(
    hashtext('hunch_refresh'),
    hashtext('unified_market_activity_metrics_1h')
  );

  IF NOT v_locked THEN
    RETURN;
  END IF;

  BEGIN
    PERFORM refresh_unified_market_activity_metrics_1h();
    PERFORM refresh_unified_event_activity_snapshots_1h(interval '8 hours');
  EXCEPTION
    WHEN OTHERS THEN
      PERFORM pg_advisory_unlock(
        hashtext('hunch_refresh'),
        hashtext('unified_market_activity_metrics_1h')
      );
      RAISE;
  END;

  PERFORM pg_advisory_unlock(
    hashtext('hunch_refresh'),
    hashtext('unified_market_activity_metrics_1h')
  );
END;
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM timescaledb_information.jobs
        WHERE proc_name = 'refresh_unified_market_activity_metrics_1h_full_job'
      ) THEN
        PERFORM add_job(
          'refresh_unified_market_activity_metrics_1h_full_job',
          interval '1 hour'
        );
      END IF;
    EXCEPTION
      WHEN undefined_function OR undefined_table THEN
        NULL;
    END;
  END IF;
END;
$$;
