SET statement_timeout = 0;

INSERT INTO unified_refresh_pipeline_state (
  pipeline_name,
  successful_cutoff,
  updated_at
)
VALUES (
  'market_activity_1h',
  now() - interval '15 minutes',
  now()
)
ON CONFLICT (pipeline_name) DO NOTHING;

CREATE OR REPLACE FUNCTION refresh_unified_market_activity_snapshots_1h_incremental(
  p_changed_since interval DEFAULT interval '2 hours'
)
RETURNS void
LANGUAGE plpgsql
SET jit = off
AS $$
DECLARE
  v_now timestamptz := now();
  v_bucket timestamptz := date_trunc('hour', now());
  v_scan_until timestamptz := clock_timestamp();
  v_previous_cutoff timestamptz;
  v_scan_from timestamptz;
  v_fallback_window interval;
  v_written_rows bigint;
BEGIN
  v_fallback_window := CASE
    WHEN p_changed_since IS NULL OR p_changed_since <= interval '0 seconds'
      THEN interval '2 hours'
    ELSE p_changed_since
  END;

  INSERT INTO unified_refresh_pipeline_state (
    pipeline_name,
    successful_cutoff,
    updated_at
  )
  VALUES (
    'market_activity_1h',
    v_scan_until - v_fallback_window,
    now()
  )
  ON CONFLICT (pipeline_name) DO NOTHING;

  SELECT pipeline_state.successful_cutoff
  INTO v_previous_cutoff
  FROM unified_refresh_pipeline_state pipeline_state
  WHERE pipeline_state.pipeline_name = 'market_activity_1h'
  FOR UPDATE;

  v_scan_from := coalesce(
    v_previous_cutoff - interval '5 minutes',
    v_scan_until - v_fallback_window
  );

  IF v_scan_from > v_scan_until THEN
    v_scan_from := v_scan_until - interval '5 minutes';
  END IF;

  WITH snapshot_candidates AS MATERIALIZED (
    SELECT
      market_row.id AS market_id,
      market_row.event_id,
      market_row.venue,
      CASE
        WHEN market_row.volume_total >= 0 THEN market_row.volume_total
        ELSE NULL
      END AS volume_total,
      CASE
        WHEN market_row.liquidity >= 0 THEN market_row.liquidity
        ELSE NULL
      END AS liquidity,
      CASE
        WHEN market_row.open_interest >= 0 THEN market_row.open_interest
        ELSE NULL
      END AS open_interest,
      coalesce(market_row.updated_at, market_row.updated_at_db) AS source_updated_at
    FROM unified_markets market_row
    JOIN unified_events event_row
      ON event_row.id = market_row.event_id
    WHERE market_row.status = 'ACTIVE'
      AND event_row.status = 'ACTIVE'
      AND market_row.updated_at_db > v_scan_from
      AND market_row.updated_at_db <= v_scan_until
      AND (
        market_row.expiration_time IS NULL
        OR market_row.expiration_time > v_now
      )
      AND (
        market_row.close_time IS NULL
        OR market_row.close_time > v_now
      )
      AND (event_row.end_date IS NULL OR event_row.end_date > v_now)
      AND (
        coalesce(
          CASE
            WHEN market_row.volume_total > 0 THEN market_row.volume_total
            ELSE 0
          END,
          0
        ) > 0
        OR coalesce(
          CASE
            WHEN market_row.liquidity > 0 THEN market_row.liquidity
            ELSE 0
          END,
          0
        ) > 0
        OR coalesce(
          CASE
            WHEN market_row.open_interest > 0 THEN market_row.open_interest
            ELSE 0
          END,
          0
        ) > 0
      )
  ),
  existing_market_snapshots AS MATERIALIZED (
    SELECT
      market_snapshot.market_id,
      market_snapshot.event_id,
      market_snapshot.venue,
      market_snapshot.volume_total,
      market_snapshot.liquidity,
      market_snapshot.open_interest,
      market_snapshot.source_updated_at
    FROM snapshot_candidates candidate
    JOIN unified_market_activity_snapshots_1h market_snapshot
      ON market_snapshot.market_id = candidate.market_id
     AND market_snapshot.bucket = v_bucket
  ),
  changed_market_snapshots AS MATERIALIZED (
    SELECT candidate.*
    FROM snapshot_candidates candidate
    LEFT JOIN existing_market_snapshots existing_snapshot
      ON existing_snapshot.market_id = candidate.market_id
    WHERE existing_snapshot.market_id IS NULL
       OR existing_snapshot.event_id IS DISTINCT FROM candidate.event_id
       OR existing_snapshot.venue IS DISTINCT FROM candidate.venue
       OR existing_snapshot.volume_total IS DISTINCT FROM candidate.volume_total
       OR existing_snapshot.liquidity IS DISTINCT FROM candidate.liquidity
       OR existing_snapshot.open_interest IS DISTINCT FROM candidate.open_interest
  ),
  affected_event_keys AS MATERIALIZED (
    SELECT changed_snapshot.event_id, changed_snapshot.venue
    FROM changed_market_snapshots changed_snapshot
    WHERE changed_snapshot.event_id IS NOT NULL
      AND changed_snapshot.venue IS NOT NULL
    UNION
    SELECT existing_snapshot.event_id, existing_snapshot.venue
    FROM existing_market_snapshots existing_snapshot
    JOIN changed_market_snapshots changed_snapshot
      ON changed_snapshot.market_id = existing_snapshot.market_id
    WHERE existing_snapshot.event_id IS NOT NULL
      AND existing_snapshot.venue IS NOT NULL
  ),
  prospective_market_snapshots AS MATERIALIZED (
    SELECT
      market_snapshot.market_id,
      market_snapshot.event_id,
      market_snapshot.venue,
      market_snapshot.volume_total,
      market_snapshot.liquidity,
      market_snapshot.open_interest,
      market_snapshot.source_updated_at
    FROM unified_market_activity_snapshots_1h market_snapshot
    JOIN affected_event_keys affected_event
      ON affected_event.event_id = market_snapshot.event_id
     AND affected_event.venue = market_snapshot.venue
    WHERE market_snapshot.bucket = v_bucket
      AND NOT EXISTS (
        SELECT 1
        FROM changed_market_snapshots changed_snapshot
        WHERE changed_snapshot.market_id = market_snapshot.market_id
      )
    UNION ALL
    SELECT
      changed_snapshot.market_id,
      changed_snapshot.event_id,
      changed_snapshot.venue,
      changed_snapshot.volume_total,
      changed_snapshot.liquidity,
      changed_snapshot.open_interest,
      changed_snapshot.source_updated_at
    FROM changed_market_snapshots changed_snapshot
  ),
  aggregated_event_snapshots AS MATERIALIZED (
    SELECT
      prospective_snapshot.event_id,
      prospective_snapshot.venue,
      sum(prospective_snapshot.volume_total) AS volume_total,
      sum(prospective_snapshot.liquidity) AS liquidity,
      sum(prospective_snapshot.open_interest) AS open_interest,
      max(prospective_snapshot.source_updated_at) AS source_updated_at
    FROM prospective_market_snapshots prospective_snapshot
    GROUP BY prospective_snapshot.event_id, prospective_snapshot.venue
  ),
  changed_event_snapshots AS MATERIALIZED (
    SELECT aggregated_snapshot.*
    FROM aggregated_event_snapshots aggregated_snapshot
    LEFT JOIN unified_event_activity_snapshots_1h existing_snapshot
      ON existing_snapshot.event_id = aggregated_snapshot.event_id
     AND existing_snapshot.venue = aggregated_snapshot.venue
     AND existing_snapshot.bucket = v_bucket
    WHERE existing_snapshot.event_id IS NULL
       OR existing_snapshot.volume_total IS DISTINCT FROM aggregated_snapshot.volume_total
       OR existing_snapshot.liquidity IS DISTINCT FROM aggregated_snapshot.liquidity
       OR existing_snapshot.open_interest IS DISTINCT FROM aggregated_snapshot.open_interest
  ),
  upserted_market_snapshots AS (
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
      changed_snapshot.market_id,
      changed_snapshot.event_id,
      changed_snapshot.venue,
      v_bucket,
      changed_snapshot.volume_total,
      changed_snapshot.liquidity,
      changed_snapshot.open_interest,
      changed_snapshot.source_updated_at,
      v_now
    FROM changed_market_snapshots changed_snapshot
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
    RETURNING 1
  ),
  upserted_event_snapshots AS (
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
      changed_snapshot.event_id,
      changed_snapshot.venue,
      v_bucket,
      changed_snapshot.volume_total,
      changed_snapshot.liquidity,
      changed_snapshot.open_interest,
      changed_snapshot.source_updated_at,
      v_now,
      v_now
    FROM changed_event_snapshots changed_snapshot
    ON CONFLICT (event_id, venue, bucket) DO UPDATE
      SET volume_total = EXCLUDED.volume_total,
          liquidity = EXCLUDED.liquidity,
          open_interest = EXCLUDED.open_interest,
          source_updated_at = EXCLUDED.source_updated_at,
          updated_at = EXCLUDED.updated_at
    WHERE unified_event_activity_snapshots_1h.volume_total IS DISTINCT FROM EXCLUDED.volume_total
       OR unified_event_activity_snapshots_1h.liquidity IS DISTINCT FROM EXCLUDED.liquidity
       OR unified_event_activity_snapshots_1h.open_interest IS DISTINCT FROM EXCLUDED.open_interest
    RETURNING 1
  ),
  deleted_stale_event_snapshots AS (
    DELETE FROM unified_event_activity_snapshots_1h existing_snapshot
    USING affected_event_keys affected_event
    WHERE existing_snapshot.event_id = affected_event.event_id
      AND existing_snapshot.venue = affected_event.venue
      AND existing_snapshot.bucket = v_bucket
      AND NOT EXISTS (
        SELECT 1
        FROM aggregated_event_snapshots aggregated_snapshot
        WHERE aggregated_snapshot.event_id = affected_event.event_id
          AND aggregated_snapshot.venue = affected_event.venue
      )
    RETURNING 1
  )
  SELECT
    (SELECT count(*) FROM upserted_market_snapshots)
    + (SELECT count(*) FROM upserted_event_snapshots)
    + (SELECT count(*) FROM deleted_stale_event_snapshots)
  INTO v_written_rows;

  UPDATE unified_refresh_pipeline_state pipeline_state
  SET successful_cutoff = v_scan_until,
      updated_at = now()
  WHERE pipeline_state.pipeline_name = 'market_activity_1h';
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
  v_lock_acquired boolean;
BEGIN
  v_lock_acquired := pg_try_advisory_lock(
    hashtext('hunch_refresh'),
    hashtext('unified_market_activity_metrics_1h')
  );

  IF NOT v_lock_acquired THEN
    RETURN;
  END IF;

  BEGIN
    PERFORM refresh_unified_market_activity_snapshots_1h_incremental(
      interval '2 hours'
    );
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
