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
    FROM snapshot_candidates
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
    LEFT JOIN LATERAL (
      SELECT s.*
      FROM unified_market_activity_snapshots_1h s
      WHERE s.market_id = cur.market_id
        AND s.bucket <= v_now - interval '24 hours'
        AND s.bucket >= v_now - interval '27 hours'
      ORDER BY s.bucket DESC
      LIMIT 1
    ) s24 ON true
    LEFT JOIN LATERAL (
      SELECT s.*
      FROM unified_market_activity_snapshots_1h s
      WHERE s.market_id = cur.market_id
        AND s.bucket <= v_now - interval '48 hours'
        AND s.bucket >= v_now - interval '51 hours'
      ORDER BY s.bucket DESC
      LIMIT 1
    ) s48 ON true
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
  )
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
  FROM metric_rows
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
       OR unified_market_activity_metrics_24h.open_interest_valid IS DISTINCT FROM EXCLUDED.open_interest_valid;

  WITH active_event_markets AS MATERIALIZED (
    SELECT
      m.id AS market_id,
      m.event_id,
      m.venue
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
  active_market_metrics AS MATERIALIZED (
    SELECT
      aem.market_id,
      aem.event_id,
      aem.venue,
      mm.volume_total_now,
      mm.volume_total_24h_ago,
      mm.volume_total_48h_ago,
      mm.volume_last_24h,
      mm.volume_prev_24h,
      mm.liquidity_now,
      mm.liquidity_24h_ago,
      mm.open_interest_now,
      mm.open_interest_24h_ago,
      COALESCE(mm.has_24h_window, false) AS has_24h_window,
      COALESCE(mm.has_48h_window, false) AS has_48h_window,
      COALESCE(mm.volume_valid, false) AS volume_valid,
      COALESCE(mm.liquidity_valid, false) AS liquidity_valid,
      COALESCE(mm.open_interest_valid, false) AS open_interest_valid,
      mm.updated_at
    FROM active_event_markets aem
    LEFT JOIN unified_market_activity_metrics_24h mm
      ON mm.market_id = aem.market_id
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
      max(updated_at) AS source_updated_at
    FROM active_market_metrics
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
  FROM event_rows
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

CREATE OR REPLACE FUNCTION refresh_unified_token_change_24h()
RETURNS void
LANGUAGE SQL
AS $$
  WITH active_tokens AS MATERIALIZED (
    SELECT DISTINCT mt.token_id
    FROM unified_market_tokens mt
    JOIN unified_markets m
      ON m.id = mt.market_id
    WHERE mt.outcome_side = 'YES'
      AND m.status = 'ACTIVE'
      AND (m.expiration_time IS NULL OR m.expiration_time > now())
      AND (m.close_time IS NULL OR m.close_time > now())
  ),
  token_rows AS MATERIALIZED (
    SELECT
      at.token_id,
      now_rows.avg_mid AS avg_mid_now,
      prev_rows.avg_mid AS avg_mid_24h,
      CASE
        WHEN now_rows.avg_mid IS NULL
          OR prev_rows.avg_mid IS NULL
          OR prev_rows.avg_mid = 0
        THEN NULL
        ELSE (now_rows.avg_mid - prev_rows.avg_mid) / prev_rows.avg_mid
      END AS change_24h,
      now_rows.bucket AS bucket_now,
      prev_rows.bucket AS bucket_24h
    FROM active_tokens at
    LEFT JOIN LATERAL (
      SELECT
        ubh.avg_mid,
        ubh.bucket
      FROM unified_book_top_1h ubh
      WHERE ubh.token_id = at.token_id
        AND ubh.bucket >= now() - interval '7 days'
      ORDER BY ubh.bucket DESC
      LIMIT 1
    ) now_rows ON true
    LEFT JOIN LATERAL (
      SELECT
        ubh.avg_mid,
        ubh.bucket
      FROM unified_book_top_1h ubh
      WHERE ubh.token_id = at.token_id
        AND ubh.bucket <= now() - interval '24 hours'
      ORDER BY ubh.bucket DESC
      LIMIT 1
    ) prev_rows ON true
  ),
  deleted AS (
    DELETE FROM unified_token_change_24h utc
    WHERE NOT EXISTS (
      SELECT 1
      FROM active_tokens at
      WHERE at.token_id = utc.token_id
    )
    RETURNING 1
  )
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
    token_id,
    avg_mid_now,
    avg_mid_24h,
    change_24h,
    bucket_now,
    bucket_24h,
    now()
  FROM token_rows
  ON CONFLICT (token_id) DO UPDATE
    SET avg_mid_now = EXCLUDED.avg_mid_now,
        avg_mid_24h = EXCLUDED.avg_mid_24h,
        change_24h = EXCLUDED.change_24h,
        bucket_now = EXCLUDED.bucket_now,
        bucket_24h = EXCLUDED.bucket_24h,
        updated_at = EXCLUDED.updated_at
    WHERE unified_token_change_24h.avg_mid_now IS DISTINCT FROM EXCLUDED.avg_mid_now
       OR unified_token_change_24h.avg_mid_24h IS DISTINCT FROM EXCLUDED.avg_mid_24h
       OR unified_token_change_24h.change_24h IS DISTINCT FROM EXCLUDED.change_24h
       OR unified_token_change_24h.bucket_now IS DISTINCT FROM EXCLUDED.bucket_now
       OR unified_token_change_24h.bucket_24h IS DISTINCT FROM EXCLUDED.bucket_24h
$$;

CREATE OR REPLACE FUNCTION refresh_unified_market_change_24h()
RETURNS void
LANGUAGE SQL
AS $$
  WITH active_markets AS MATERIALIZED (
    SELECT
      mt.market_id,
      tc.change_24h
    FROM unified_market_tokens mt
    JOIN unified_markets m
      ON m.id = mt.market_id
    LEFT JOIN unified_token_change_24h tc
      ON tc.token_id = mt.token_id
    WHERE m.status = 'ACTIVE'
      AND mt.outcome_side = 'YES'
      AND (m.expiration_time IS NULL OR m.expiration_time > now())
      AND (m.close_time IS NULL OR m.close_time > now())
  ),
  deleted AS (
    DELETE FROM unified_market_change_24h umc
    WHERE NOT EXISTS (
      SELECT 1
      FROM active_markets am
      WHERE am.market_id = umc.market_id
    )
    RETURNING 1
  )
  INSERT INTO unified_market_change_24h (
    market_id,
    change_24h,
    updated_at
  )
  SELECT
    am.market_id,
    am.change_24h,
    now()
  FROM active_markets am
  ON CONFLICT (market_id) DO UPDATE
    SET change_24h = EXCLUDED.change_24h,
        updated_at = EXCLUDED.updated_at
    WHERE unified_market_change_24h.change_24h IS DISTINCT FROM EXCLUDED.change_24h
$$;
