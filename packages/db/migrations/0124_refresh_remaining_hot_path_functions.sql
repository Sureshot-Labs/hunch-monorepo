SET statement_timeout = 0;

CREATE OR REPLACE FUNCTION refresh_wallet_intel_selector_snapshot()
RETURNS void
LANGUAGE SQL
AS $$
  WITH latest_metrics AS MATERIALIZED (
    SELECT DISTINCT ON (s.wallet_id)
      s.wallet_id,
      s.as_of,
      s.volume_usd,
      s.pnl_usd,
      s.roi,
      s.trades_count,
      s.win_rate,
      s.avg_hold_hours,
      s.last_trade_at
    FROM wallet_metrics_snapshots s
    WHERE s.period = '30d'
    ORDER BY s.wallet_id, s.as_of DESC
  ),
  latest_activity AS MATERIALIZED (
    SELECT DISTINCT ON (wah.wallet_id)
      wah.wallet_id,
      wah.last_occurred_at AS last_activity_at
    FROM wallet_activity_hourly wah
    WHERE wah.last_occurred_at IS NOT NULL
    ORDER BY wah.wallet_id, wah.last_occurred_at DESC
  ),
  latest_trade_activity AS MATERIALIZED (
    SELECT DISTINCT ON (wah.wallet_id)
      wah.wallet_id,
      wah.last_occurred_at AS last_trade_activity_at
    FROM wallet_activity_hourly wah
    WHERE wah.activity_type IN ('delta', 'trade')
      AND wah.last_occurred_at IS NOT NULL
    ORDER BY wah.wallet_id, wah.last_occurred_at DESC
  ),
  latest_holder_activity AS MATERIALIZED (
    SELECT DISTINCT ON (wah.wallet_id)
      wah.wallet_id,
      wah.last_occurred_at AS last_holder_activity_at
    FROM wallet_activity_hourly wah
    WHERE wah.activity_type = 'holder'
      AND wah.last_occurred_at IS NOT NULL
    ORDER BY wah.wallet_id, wah.last_occurred_at DESC
  ),
  null_activity_wallets AS MATERIALIZED (
    SELECT DISTINCT wah.wallet_id
    FROM wallet_activity_hourly wah
    WHERE wah.last_occurred_at IS NULL
  ),
  activity_wallets AS MATERIALIZED (
    SELECT wallet_id FROM latest_activity
    UNION
    SELECT wallet_id FROM latest_trade_activity
    UNION
    SELECT wallet_id FROM latest_holder_activity
    UNION
    SELECT wallet_id FROM null_activity_wallets
  ),
  activity AS MATERIALIZED (
    SELECT
      aw.wallet_id,
      la.last_activity_at,
      lta.last_trade_activity_at,
      lha.last_holder_activity_at
    FROM activity_wallets aw
    LEFT JOIN latest_activity la
      ON la.wallet_id = aw.wallet_id
    LEFT JOIN latest_trade_activity lta
      ON lta.wallet_id = aw.wallet_id
    LEFT JOIN latest_holder_activity lha
      ON lha.wallet_id = aw.wallet_id
  ),
  source_rows AS MATERIALIZED (
    SELECT
      sw.wallet_id,
      lm.as_of,
      lm.volume_usd,
      lm.pnl_usd,
      lm.roi,
      lm.trades_count,
      lm.win_rate,
      lm.avg_hold_hours,
      lm.last_trade_at,
      wpe.exposure_usd,
      wpe.hedged_notional_usd,
      wpe.net_imbalance_usd,
      wpe.hedge_ratio,
      wpe.two_sided_markets,
      act.last_activity_at,
      act.last_trade_activity_at,
      act.last_holder_activity_at
    FROM (
      SELECT wallet_id FROM latest_metrics
      UNION
      SELECT wallet_id FROM activity
      UNION
      SELECT wallet_id FROM wallet_position_exposure
    ) sw
    LEFT JOIN latest_metrics lm
      ON lm.wallet_id = sw.wallet_id
    LEFT JOIN wallet_position_exposure wpe
      ON wpe.wallet_id = sw.wallet_id
    LEFT JOIN activity act
      ON act.wallet_id = sw.wallet_id
  ),
  deleted AS (
    DELETE FROM wallet_intel_selector_snapshot snap
    WHERE NOT EXISTS (
      SELECT 1
      FROM source_rows src
      WHERE src.wallet_id = snap.wallet_id
    )
    RETURNING 1
  )
  INSERT INTO wallet_intel_selector_snapshot AS snap (
    wallet_id,
    metrics_as_of,
    metrics_volume_30d,
    metrics_pnl_30d,
    metrics_roi_30d,
    metrics_trades_30d,
    metrics_win_rate_30d,
    metrics_avg_hold_hours_30d,
    metrics_last_trade_at_30d,
    exposure_usd,
    hedged_notional_usd,
    net_imbalance_usd,
    hedge_ratio,
    two_sided_markets,
    last_activity_at,
    last_trade_activity_at,
    last_holder_activity_at,
    updated_at
  )
  SELECT
    src.wallet_id,
    src.as_of,
    src.volume_usd,
    src.pnl_usd,
    src.roi,
    src.trades_count,
    src.win_rate,
    src.avg_hold_hours,
    src.last_trade_at,
    src.exposure_usd,
    src.hedged_notional_usd,
    src.net_imbalance_usd,
    src.hedge_ratio,
    src.two_sided_markets,
    src.last_activity_at,
    src.last_trade_activity_at,
    src.last_holder_activity_at,
    now()
  FROM source_rows src
  ON CONFLICT (wallet_id) DO UPDATE
    SET metrics_as_of = EXCLUDED.metrics_as_of,
        metrics_volume_30d = EXCLUDED.metrics_volume_30d,
        metrics_pnl_30d = EXCLUDED.metrics_pnl_30d,
        metrics_roi_30d = EXCLUDED.metrics_roi_30d,
        metrics_trades_30d = EXCLUDED.metrics_trades_30d,
        metrics_win_rate_30d = EXCLUDED.metrics_win_rate_30d,
        metrics_avg_hold_hours_30d = EXCLUDED.metrics_avg_hold_hours_30d,
        metrics_last_trade_at_30d = EXCLUDED.metrics_last_trade_at_30d,
        exposure_usd = EXCLUDED.exposure_usd,
        hedged_notional_usd = EXCLUDED.hedged_notional_usd,
        net_imbalance_usd = EXCLUDED.net_imbalance_usd,
        hedge_ratio = EXCLUDED.hedge_ratio,
        two_sided_markets = EXCLUDED.two_sided_markets,
        last_activity_at = EXCLUDED.last_activity_at,
        last_trade_activity_at = EXCLUDED.last_trade_activity_at,
        last_holder_activity_at = EXCLUDED.last_holder_activity_at,
        updated_at = EXCLUDED.updated_at
    WHERE (
      snap.metrics_as_of,
      snap.metrics_volume_30d,
      snap.metrics_pnl_30d,
      snap.metrics_roi_30d,
      snap.metrics_trades_30d,
      snap.metrics_win_rate_30d,
      snap.metrics_avg_hold_hours_30d,
      snap.metrics_last_trade_at_30d,
      snap.exposure_usd,
      snap.hedged_notional_usd,
      snap.net_imbalance_usd,
      snap.hedge_ratio,
      snap.two_sided_markets,
      snap.last_activity_at,
      snap.last_trade_activity_at,
      snap.last_holder_activity_at
    ) IS DISTINCT FROM (
      EXCLUDED.metrics_as_of,
      EXCLUDED.metrics_volume_30d,
      EXCLUDED.metrics_pnl_30d,
      EXCLUDED.metrics_roi_30d,
      EXCLUDED.metrics_trades_30d,
      EXCLUDED.metrics_win_rate_30d,
      EXCLUDED.metrics_avg_hold_hours_30d,
      EXCLUDED.metrics_last_trade_at_30d,
      EXCLUDED.exposure_usd,
      EXCLUDED.hedged_notional_usd,
      EXCLUDED.net_imbalance_usd,
      EXCLUDED.hedge_ratio,
      EXCLUDED.two_sided_markets,
      EXCLUDED.last_activity_at,
      EXCLUDED.last_trade_activity_at,
      EXCLUDED.last_holder_activity_at
    )
$$;

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
