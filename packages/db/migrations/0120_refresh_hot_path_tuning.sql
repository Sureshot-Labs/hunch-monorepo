SET lock_timeout = '5s';
SET statement_timeout = 0;

CREATE TABLE IF NOT EXISTS unified_event_active_categories (
  category text PRIMARY KEY,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION refresh_unified_event_active_categories()
RETURNS void
LANGUAGE SQL
AS $$
  WITH normalized AS MATERIALIZED (
    SELECT DISTINCT lower(category) AS category
    FROM unified_events
    WHERE status = 'ACTIVE'
      AND category IS NOT NULL
      AND btrim(category) <> ''
  ),
  upserted AS (
    INSERT INTO unified_event_active_categories (
      category,
      updated_at
    )
    SELECT
      category,
      now()
    FROM normalized
    ON CONFLICT (category) DO UPDATE
      SET updated_at = EXCLUDED.updated_at
    RETURNING category
  )
  DELETE FROM unified_event_active_categories existing
  WHERE NOT EXISTS (
    SELECT 1
    FROM normalized n
    WHERE n.category = existing.category
  )
$$;

CREATE OR REPLACE FUNCTION refresh_unified_event_active_categories_job(
  job_id int,
  config jsonb
)
RETURNS void
LANGUAGE SQL
AS $$
  SELECT refresh_unified_event_active_categories()
$$;

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
  activity AS MATERIALIZED (
    SELECT
      wah.wallet_id,
      max(wah.last_occurred_at) AS last_activity_at,
      max(wah.last_occurred_at) FILTER (
        WHERE wah.activity_type IN ('delta', 'trade')
      ) AS last_trade_activity_at,
      max(wah.last_occurred_at) FILTER (
        WHERE wah.activity_type = 'holder'
      ) AS last_holder_activity_at
    FROM wallet_activity_hourly wah
    GROUP BY wah.wallet_id
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

SELECT refresh_unified_event_active_categories();

SELECT add_job('refresh_unified_event_active_categories_job', interval '10 minutes')
WHERE EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb')
  AND NOT EXISTS (
    SELECT 1
    FROM timescaledb_information.jobs
    WHERE proc_name = 'refresh_unified_event_active_categories_job'
  );

DO $$
DECLARE
  v_job_id integer;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
    SELECT job_id
    INTO v_job_id
    FROM timescaledb_information.jobs
    WHERE proc_name = 'refresh_wallet_intel_selector_snapshot_job'
    LIMIT 1;

    IF v_job_id IS NOT NULL THEN
      PERFORM alter_job(v_job_id, schedule_interval => interval '5 minutes');
    END IF;
  END IF;
EXCEPTION
  WHEN undefined_function OR undefined_table THEN
    NULL;
END;
$$;
