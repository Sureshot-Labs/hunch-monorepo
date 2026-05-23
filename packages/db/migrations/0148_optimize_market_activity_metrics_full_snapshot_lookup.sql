SET statement_timeout = 0;

CREATE OR REPLACE FUNCTION refresh_unified_market_activity_metrics_1h()
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_now timestamptz := now();
  v_bucket timestamptz := date_trunc('hour', now());
BEGIN
  PERFORM cleanup_unified_market_activity_snapshots_1h(interval '8 days', 50000);

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
  ),
  upserted_snapshot AS (
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
       OR unified_market_activity_snapshots_1h.source_updated_at IS DISTINCT FROM EXCLUDED.source_updated_at
    RETURNING 1
  ),
  deleted_current_snapshot AS (
    DELETE FROM unified_market_activity_snapshots_1h s
    WHERE s.bucket = v_bucket
      AND NOT EXISTS (
        SELECT 1
        FROM snapshot_candidates sc
        WHERE sc.market_id = s.market_id
      )
    RETURNING 1
  ),
  s24_rows AS MATERIALIZED (
    SELECT DISTINCT ON (s.market_id)
      s.market_id,
      s.volume_total,
      s.liquidity,
      s.open_interest
    FROM unified_market_activity_snapshots_1h s
    JOIN snapshot_candidates sc
      ON sc.market_id = s.market_id
    WHERE s.bucket <= v_now - interval '24 hours'
      AND s.bucket >= v_now - interval '27 hours'
    ORDER BY s.market_id, s.bucket DESC
  ),
  s48_rows AS MATERIALIZED (
    SELECT DISTINCT ON (s.market_id)
      s.market_id,
      s.volume_total
    FROM unified_market_activity_snapshots_1h s
    JOIN snapshot_candidates sc
      ON sc.market_id = s.market_id
    WHERE s.bucket <= v_now - interval '48 hours'
      AND s.bucket >= v_now - interval '51 hours'
    ORDER BY s.market_id, s.bucket DESC
  ),
  metric_base AS MATERIALIZED (
    SELECT
      cur.market_id,
      cur.event_id,
      cur.venue,
      cur.volume_total AS volume_total_now,
      s24.volume_total AS volume_total_24h_ago,
      s48.volume_total AS volume_total_48h_ago,
      cur.liquidity AS liquidity_now,
      s24.liquidity AS liquidity_24h_ago,
      cur.open_interest AS open_interest_now,
      s24.open_interest AS open_interest_24h_ago,
      (s24.market_id IS NOT NULL) AS has_24h_window,
      (s48.market_id IS NOT NULL) AS has_48h_window,
      (
        cur.volume_total IS NOT NULL
        AND s24.volume_total IS NOT NULL
        AND cur.volume_total >= s24.volume_total
      ) AS volume_current_valid,
      (
        s24.volume_total IS NOT NULL
        AND s48.volume_total IS NOT NULL
        AND s24.volume_total >= s48.volume_total
      ) AS volume_previous_valid,
      (
        cur.liquidity IS NOT NULL
        AND s24.liquidity IS NOT NULL
      ) AS liquidity_valid,
      (
        cur.open_interest IS NOT NULL
        AND s24.open_interest IS NOT NULL
      ) AS open_interest_valid
    FROM snapshot_candidates cur
    LEFT JOIN s24_rows s24
      ON s24.market_id = cur.market_id
    LEFT JOIN s48_rows s48
      ON s48.market_id = cur.market_id
  ),
  metric_rows AS MATERIALIZED (
    SELECT
      market_id,
      event_id,
      venue,
      volume_total_now,
      volume_total_24h_ago,
      volume_total_48h_ago,
      CASE
        WHEN volume_current_valid THEN volume_total_now - volume_total_24h_ago
        ELSE NULL
      END AS volume_last_24h,
      CASE
        WHEN volume_previous_valid THEN volume_total_24h_ago - volume_total_48h_ago
        ELSE NULL
      END AS volume_prev_24h,
      CASE
        WHEN volume_current_valid AND volume_previous_valid
          THEN (volume_total_now - volume_total_24h_ago)
             - (volume_total_24h_ago - volume_total_48h_ago)
        ELSE NULL
      END AS volume_last_24h_change,
      CASE
        WHEN volume_current_valid
          AND volume_previous_valid
          AND (volume_total_24h_ago - volume_total_48h_ago) <> 0
          THEN (
            (volume_total_now - volume_total_24h_ago)
            - (volume_total_24h_ago - volume_total_48h_ago)
          ) / (volume_total_24h_ago - volume_total_48h_ago)
        ELSE NULL
      END AS volume_last_24h_change_pct,
      liquidity_now,
      liquidity_24h_ago,
      CASE
        WHEN liquidity_valid THEN liquidity_now - liquidity_24h_ago
        ELSE NULL
      END AS liquidity_change_24h,
      CASE
        WHEN liquidity_valid AND liquidity_24h_ago <> 0
          THEN (liquidity_now - liquidity_24h_ago) / liquidity_24h_ago
        ELSE NULL
      END AS liquidity_change_pct_24h,
      open_interest_now,
      open_interest_24h_ago,
      CASE
        WHEN open_interest_valid THEN open_interest_now - open_interest_24h_ago
        ELSE NULL
      END AS open_interest_change_24h,
      CASE
        WHEN open_interest_valid AND open_interest_24h_ago <> 0
          THEN (open_interest_now - open_interest_24h_ago) / open_interest_24h_ago
        ELSE NULL
      END AS open_interest_change_pct_24h,
      has_24h_window,
      has_48h_window,
      volume_current_valid AS volume_valid,
      liquidity_valid,
      open_interest_valid
    FROM metric_base
  ),
  deleted_metrics AS (
    DELETE FROM unified_market_activity_metrics_24h mm
    WHERE NOT EXISTS (
      SELECT 1
      FROM metric_rows mr
      WHERE mr.market_id = mm.market_id
    )
    RETURNING 1
  ),
  changed_metric_rows AS MATERIALIZED (
    SELECT mr.*
    FROM metric_rows mr
    LEFT JOIN unified_market_activity_metrics_24h mm
      ON mm.market_id = mr.market_id
    WHERE mm.market_id IS NULL
       OR mm.event_id IS DISTINCT FROM mr.event_id
       OR mm.venue IS DISTINCT FROM mr.venue
       OR mm.volume_total_now IS DISTINCT FROM mr.volume_total_now
       OR mm.volume_total_24h_ago IS DISTINCT FROM mr.volume_total_24h_ago
       OR mm.volume_total_48h_ago IS DISTINCT FROM mr.volume_total_48h_ago
       OR mm.volume_last_24h IS DISTINCT FROM mr.volume_last_24h
       OR mm.volume_prev_24h IS DISTINCT FROM mr.volume_prev_24h
       OR mm.volume_last_24h_change IS DISTINCT FROM mr.volume_last_24h_change
       OR mm.volume_last_24h_change_pct IS DISTINCT FROM mr.volume_last_24h_change_pct
       OR mm.liquidity_now IS DISTINCT FROM mr.liquidity_now
       OR mm.liquidity_24h_ago IS DISTINCT FROM mr.liquidity_24h_ago
       OR mm.liquidity_change_24h IS DISTINCT FROM mr.liquidity_change_24h
       OR mm.liquidity_change_pct_24h IS DISTINCT FROM mr.liquidity_change_pct_24h
       OR mm.open_interest_now IS DISTINCT FROM mr.open_interest_now
       OR mm.open_interest_24h_ago IS DISTINCT FROM mr.open_interest_24h_ago
       OR mm.open_interest_change_24h IS DISTINCT FROM mr.open_interest_change_24h
       OR mm.open_interest_change_pct_24h IS DISTINCT FROM mr.open_interest_change_pct_24h
       OR mm.has_24h_window IS DISTINCT FROM mr.has_24h_window
       OR mm.has_48h_window IS DISTINCT FROM mr.has_48h_window
       OR mm.volume_valid IS DISTINCT FROM mr.volume_valid
       OR mm.liquidity_valid IS DISTINCT FROM mr.liquidity_valid
       OR mm.open_interest_valid IS DISTINCT FROM mr.open_interest_valid
  ),
  upserted_metrics AS (
    INSERT INTO unified_market_activity_metrics_24h (
      market_id,
      event_id,
      venue,
      volume_total_now,
      volume_total_24h_ago,
      volume_total_48h_ago,
      volume_last_24h,
      volume_prev_24h,
      volume_last_24h_change,
      volume_last_24h_change_pct,
      liquidity_now,
      liquidity_24h_ago,
      liquidity_change_24h,
      liquidity_change_pct_24h,
      open_interest_now,
      open_interest_24h_ago,
      open_interest_change_24h,
      open_interest_change_pct_24h,
      has_24h_window,
      has_48h_window,
      volume_valid,
      liquidity_valid,
      open_interest_valid,
      updated_at
    )
    SELECT
      market_id,
      event_id,
      venue,
      volume_total_now,
      volume_total_24h_ago,
      volume_total_48h_ago,
      volume_last_24h,
      volume_prev_24h,
      volume_last_24h_change,
      volume_last_24h_change_pct,
      liquidity_now,
      liquidity_24h_ago,
      liquidity_change_24h,
      liquidity_change_pct_24h,
      open_interest_now,
      open_interest_24h_ago,
      open_interest_change_24h,
      open_interest_change_pct_24h,
      has_24h_window,
      has_48h_window,
      volume_valid,
      liquidity_valid,
      open_interest_valid,
      v_now
    FROM changed_metric_rows
    ON CONFLICT (market_id) DO UPDATE
      SET event_id = EXCLUDED.event_id,
          venue = EXCLUDED.venue,
          volume_total_now = EXCLUDED.volume_total_now,
          volume_total_24h_ago = EXCLUDED.volume_total_24h_ago,
          volume_total_48h_ago = EXCLUDED.volume_total_48h_ago,
          volume_last_24h = EXCLUDED.volume_last_24h,
          volume_prev_24h = EXCLUDED.volume_prev_24h,
          volume_last_24h_change = EXCLUDED.volume_last_24h_change,
          volume_last_24h_change_pct = EXCLUDED.volume_last_24h_change_pct,
          liquidity_now = EXCLUDED.liquidity_now,
          liquidity_24h_ago = EXCLUDED.liquidity_24h_ago,
          liquidity_change_24h = EXCLUDED.liquidity_change_24h,
          liquidity_change_pct_24h = EXCLUDED.liquidity_change_pct_24h,
          open_interest_now = EXCLUDED.open_interest_now,
          open_interest_24h_ago = EXCLUDED.open_interest_24h_ago,
          open_interest_change_24h = EXCLUDED.open_interest_change_24h,
          open_interest_change_pct_24h = EXCLUDED.open_interest_change_pct_24h,
          has_24h_window = EXCLUDED.has_24h_window,
          has_48h_window = EXCLUDED.has_48h_window,
          volume_valid = EXCLUDED.volume_valid,
          liquidity_valid = EXCLUDED.liquidity_valid,
          open_interest_valid = EXCLUDED.open_interest_valid,
          updated_at = EXCLUDED.updated_at
      WHERE unified_market_activity_metrics_24h.event_id IS DISTINCT FROM EXCLUDED.event_id
         OR unified_market_activity_metrics_24h.venue IS DISTINCT FROM EXCLUDED.venue
         OR unified_market_activity_metrics_24h.volume_total_now IS DISTINCT FROM EXCLUDED.volume_total_now
         OR unified_market_activity_metrics_24h.volume_total_24h_ago IS DISTINCT FROM EXCLUDED.volume_total_24h_ago
         OR unified_market_activity_metrics_24h.volume_total_48h_ago IS DISTINCT FROM EXCLUDED.volume_total_48h_ago
         OR unified_market_activity_metrics_24h.volume_last_24h IS DISTINCT FROM EXCLUDED.volume_last_24h
         OR unified_market_activity_metrics_24h.volume_prev_24h IS DISTINCT FROM EXCLUDED.volume_prev_24h
         OR unified_market_activity_metrics_24h.volume_last_24h_change IS DISTINCT FROM EXCLUDED.volume_last_24h_change
         OR unified_market_activity_metrics_24h.volume_last_24h_change_pct IS DISTINCT FROM EXCLUDED.volume_last_24h_change_pct
         OR unified_market_activity_metrics_24h.liquidity_now IS DISTINCT FROM EXCLUDED.liquidity_now
         OR unified_market_activity_metrics_24h.liquidity_24h_ago IS DISTINCT FROM EXCLUDED.liquidity_24h_ago
         OR unified_market_activity_metrics_24h.liquidity_change_24h IS DISTINCT FROM EXCLUDED.liquidity_change_24h
         OR unified_market_activity_metrics_24h.liquidity_change_pct_24h IS DISTINCT FROM EXCLUDED.liquidity_change_pct_24h
         OR unified_market_activity_metrics_24h.open_interest_now IS DISTINCT FROM EXCLUDED.open_interest_now
         OR unified_market_activity_metrics_24h.open_interest_24h_ago IS DISTINCT FROM EXCLUDED.open_interest_24h_ago
         OR unified_market_activity_metrics_24h.open_interest_change_24h IS DISTINCT FROM EXCLUDED.open_interest_change_24h
         OR unified_market_activity_metrics_24h.open_interest_change_pct_24h IS DISTINCT FROM EXCLUDED.open_interest_change_pct_24h
         OR unified_market_activity_metrics_24h.has_24h_window IS DISTINCT FROM EXCLUDED.has_24h_window
         OR unified_market_activity_metrics_24h.has_48h_window IS DISTINCT FROM EXCLUDED.has_48h_window
         OR unified_market_activity_metrics_24h.volume_valid IS DISTINCT FROM EXCLUDED.volume_valid
         OR unified_market_activity_metrics_24h.liquidity_valid IS DISTINCT FROM EXCLUDED.liquidity_valid
         OR unified_market_activity_metrics_24h.open_interest_valid IS DISTINCT FROM EXCLUDED.open_interest_valid
    RETURNING 1
  ),
  event_rows_base AS MATERIALIZED (
    SELECT
      event_id,
      max(venue) AS venue,
      sum(volume_total_now) AS volume_total_now,
      sum(volume_total_24h_ago) AS volume_total_24h_ago,
      sum(volume_total_48h_ago) AS volume_total_48h_ago,
      sum(volume_last_24h) AS volume_last_24h,
      sum(volume_prev_24h) AS volume_prev_24h,
      sum(liquidity_now) AS liquidity_now,
      sum(liquidity_24h_ago) AS liquidity_24h_ago,
      sum(open_interest_now) AS open_interest_now,
      sum(open_interest_24h_ago) AS open_interest_24h_ago,
      COALESCE(bool_and(has_24h_window), false) AS has_24h_window,
      COALESCE(bool_and(has_48h_window), false) AS has_48h_window,
      COALESCE(bool_and(volume_valid), false) AS volume_valid,
      COALESCE(bool_and(liquidity_valid), false) AS liquidity_valid,
      COALESCE(bool_and(open_interest_valid), false) AS open_interest_valid,
      max(v_now) AS source_updated_at
    FROM metric_rows
    GROUP BY event_id
  ),
  event_rows AS MATERIALIZED (
    SELECT
      event_id,
      venue,
      volume_total_now,
      volume_total_24h_ago,
      volume_total_48h_ago,
      CASE WHEN volume_valid THEN volume_last_24h ELSE NULL END AS volume_last_24h,
      CASE WHEN volume_valid AND has_48h_window THEN volume_prev_24h ELSE NULL END AS volume_prev_24h,
      CASE
        WHEN volume_valid
          AND has_48h_window
          AND volume_last_24h IS NOT NULL
          AND volume_prev_24h IS NOT NULL
          THEN volume_last_24h - volume_prev_24h
        ELSE NULL
      END AS volume_last_24h_change,
      CASE
        WHEN volume_valid
          AND has_48h_window
          AND volume_last_24h IS NOT NULL
          AND volume_prev_24h IS NOT NULL
          AND volume_prev_24h <> 0
          THEN (volume_last_24h - volume_prev_24h) / volume_prev_24h
        ELSE NULL
      END AS volume_last_24h_change_pct,
      liquidity_now,
      CASE WHEN liquidity_valid THEN liquidity_24h_ago ELSE NULL END AS liquidity_24h_ago,
      CASE
        WHEN liquidity_valid
          AND liquidity_now IS NOT NULL
          AND liquidity_24h_ago IS NOT NULL
          THEN liquidity_now - liquidity_24h_ago
        ELSE NULL
      END AS liquidity_change_24h,
      CASE
        WHEN liquidity_valid
          AND liquidity_now IS NOT NULL
          AND liquidity_24h_ago IS NOT NULL
          AND liquidity_24h_ago <> 0
          THEN (liquidity_now - liquidity_24h_ago) / liquidity_24h_ago
        ELSE NULL
      END AS liquidity_change_pct_24h,
      open_interest_now,
      CASE WHEN open_interest_valid THEN open_interest_24h_ago ELSE NULL END AS open_interest_24h_ago,
      CASE
        WHEN open_interest_valid
          AND open_interest_now IS NOT NULL
          AND open_interest_24h_ago IS NOT NULL
          THEN open_interest_now - open_interest_24h_ago
        ELSE NULL
      END AS open_interest_change_24h,
      CASE
        WHEN open_interest_valid
          AND open_interest_now IS NOT NULL
          AND open_interest_24h_ago IS NOT NULL
          AND open_interest_24h_ago <> 0
          THEN (open_interest_now - open_interest_24h_ago) / open_interest_24h_ago
        ELSE NULL
      END AS open_interest_change_pct_24h,
      has_24h_window,
      has_48h_window,
      volume_valid,
      liquidity_valid,
      open_interest_valid,
      source_updated_at
    FROM event_rows_base
  ),
  deleted_events AS (
    DELETE FROM unified_event_activity_metrics_24h em
    WHERE NOT EXISTS (
      SELECT 1
      FROM event_rows er
      WHERE er.event_id = em.event_id
    )
    RETURNING 1
  ),
  changed_event_rows AS MATERIALIZED (
    SELECT er.*
    FROM event_rows er
    LEFT JOIN unified_event_activity_metrics_24h em
      ON em.event_id = er.event_id
    WHERE em.event_id IS NULL
       OR em.venue IS DISTINCT FROM er.venue
       OR em.volume_total_now IS DISTINCT FROM er.volume_total_now
       OR em.volume_total_24h_ago IS DISTINCT FROM er.volume_total_24h_ago
       OR em.volume_total_48h_ago IS DISTINCT FROM er.volume_total_48h_ago
       OR em.volume_last_24h IS DISTINCT FROM er.volume_last_24h
       OR em.volume_prev_24h IS DISTINCT FROM er.volume_prev_24h
       OR em.volume_last_24h_change IS DISTINCT FROM er.volume_last_24h_change
       OR em.volume_last_24h_change_pct IS DISTINCT FROM er.volume_last_24h_change_pct
       OR em.liquidity_now IS DISTINCT FROM er.liquidity_now
       OR em.liquidity_24h_ago IS DISTINCT FROM er.liquidity_24h_ago
       OR em.liquidity_change_24h IS DISTINCT FROM er.liquidity_change_24h
       OR em.liquidity_change_pct_24h IS DISTINCT FROM er.liquidity_change_pct_24h
       OR em.open_interest_now IS DISTINCT FROM er.open_interest_now
       OR em.open_interest_24h_ago IS DISTINCT FROM er.open_interest_24h_ago
       OR em.open_interest_change_24h IS DISTINCT FROM er.open_interest_change_24h
       OR em.open_interest_change_pct_24h IS DISTINCT FROM er.open_interest_change_pct_24h
       OR em.has_24h_window IS DISTINCT FROM er.has_24h_window
       OR em.has_48h_window IS DISTINCT FROM er.has_48h_window
       OR em.volume_valid IS DISTINCT FROM er.volume_valid
       OR em.liquidity_valid IS DISTINCT FROM er.liquidity_valid
       OR em.open_interest_valid IS DISTINCT FROM er.open_interest_valid
  )
  INSERT INTO unified_event_activity_metrics_24h (
    event_id,
    venue,
    volume_total_now,
    volume_total_24h_ago,
    volume_total_48h_ago,
    volume_last_24h,
    volume_prev_24h,
    volume_last_24h_change,
    volume_last_24h_change_pct,
    liquidity_now,
    liquidity_24h_ago,
    liquidity_change_24h,
    liquidity_change_pct_24h,
    open_interest_now,
    open_interest_24h_ago,
    open_interest_change_24h,
    open_interest_change_pct_24h,
    has_24h_window,
    has_48h_window,
    volume_valid,
    liquidity_valid,
    open_interest_valid,
    updated_at
  )
  SELECT
    event_id,
    venue,
    volume_total_now,
    volume_total_24h_ago,
    volume_total_48h_ago,
    volume_last_24h,
    volume_prev_24h,
    volume_last_24h_change,
    volume_last_24h_change_pct,
    liquidity_now,
    liquidity_24h_ago,
    liquidity_change_24h,
    liquidity_change_pct_24h,
    open_interest_now,
    open_interest_24h_ago,
    open_interest_change_24h,
    open_interest_change_pct_24h,
    has_24h_window,
    has_48h_window,
    volume_valid,
    liquidity_valid,
    open_interest_valid,
    COALESCE(source_updated_at, v_now)
  FROM changed_event_rows
  ON CONFLICT (event_id) DO UPDATE
    SET venue = EXCLUDED.venue,
        volume_total_now = EXCLUDED.volume_total_now,
        volume_total_24h_ago = EXCLUDED.volume_total_24h_ago,
        volume_total_48h_ago = EXCLUDED.volume_total_48h_ago,
        volume_last_24h = EXCLUDED.volume_last_24h,
        volume_prev_24h = EXCLUDED.volume_prev_24h,
        volume_last_24h_change = EXCLUDED.volume_last_24h_change,
        volume_last_24h_change_pct = EXCLUDED.volume_last_24h_change_pct,
        liquidity_now = EXCLUDED.liquidity_now,
        liquidity_24h_ago = EXCLUDED.liquidity_24h_ago,
        liquidity_change_24h = EXCLUDED.liquidity_change_24h,
        liquidity_change_pct_24h = EXCLUDED.liquidity_change_pct_24h,
        open_interest_now = EXCLUDED.open_interest_now,
        open_interest_24h_ago = EXCLUDED.open_interest_24h_ago,
        open_interest_change_24h = EXCLUDED.open_interest_change_24h,
        open_interest_change_pct_24h = EXCLUDED.open_interest_change_pct_24h,
        has_24h_window = EXCLUDED.has_24h_window,
        has_48h_window = EXCLUDED.has_48h_window,
        volume_valid = EXCLUDED.volume_valid,
        liquidity_valid = EXCLUDED.liquidity_valid,
        open_interest_valid = EXCLUDED.open_interest_valid,
        updated_at = EXCLUDED.updated_at
    WHERE unified_event_activity_metrics_24h.venue IS DISTINCT FROM EXCLUDED.venue
       OR unified_event_activity_metrics_24h.volume_total_now IS DISTINCT FROM EXCLUDED.volume_total_now
       OR unified_event_activity_metrics_24h.volume_total_24h_ago IS DISTINCT FROM EXCLUDED.volume_total_24h_ago
       OR unified_event_activity_metrics_24h.volume_total_48h_ago IS DISTINCT FROM EXCLUDED.volume_total_48h_ago
       OR unified_event_activity_metrics_24h.volume_last_24h IS DISTINCT FROM EXCLUDED.volume_last_24h
       OR unified_event_activity_metrics_24h.volume_prev_24h IS DISTINCT FROM EXCLUDED.volume_prev_24h
       OR unified_event_activity_metrics_24h.volume_last_24h_change IS DISTINCT FROM EXCLUDED.volume_last_24h_change
       OR unified_event_activity_metrics_24h.volume_last_24h_change_pct IS DISTINCT FROM EXCLUDED.volume_last_24h_change_pct
       OR unified_event_activity_metrics_24h.liquidity_now IS DISTINCT FROM EXCLUDED.liquidity_now
       OR unified_event_activity_metrics_24h.liquidity_24h_ago IS DISTINCT FROM EXCLUDED.liquidity_24h_ago
       OR unified_event_activity_metrics_24h.liquidity_change_24h IS DISTINCT FROM EXCLUDED.liquidity_change_24h
       OR unified_event_activity_metrics_24h.liquidity_change_pct_24h IS DISTINCT FROM EXCLUDED.liquidity_change_pct_24h
       OR unified_event_activity_metrics_24h.open_interest_now IS DISTINCT FROM EXCLUDED.open_interest_now
       OR unified_event_activity_metrics_24h.open_interest_24h_ago IS DISTINCT FROM EXCLUDED.open_interest_24h_ago
       OR unified_event_activity_metrics_24h.open_interest_change_24h IS DISTINCT FROM EXCLUDED.open_interest_change_24h
       OR unified_event_activity_metrics_24h.open_interest_change_pct_24h IS DISTINCT FROM EXCLUDED.open_interest_change_pct_24h
       OR unified_event_activity_metrics_24h.has_24h_window IS DISTINCT FROM EXCLUDED.has_24h_window
       OR unified_event_activity_metrics_24h.has_48h_window IS DISTINCT FROM EXCLUDED.has_48h_window
       OR unified_event_activity_metrics_24h.volume_valid IS DISTINCT FROM EXCLUDED.volume_valid
       OR unified_event_activity_metrics_24h.liquidity_valid IS DISTINCT FROM EXCLUDED.liquidity_valid
       OR unified_event_activity_metrics_24h.open_interest_valid IS DISTINCT FROM EXCLUDED.open_interest_valid;
END;
$$;
