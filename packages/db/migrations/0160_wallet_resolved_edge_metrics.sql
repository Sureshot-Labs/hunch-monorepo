SET statement_timeout = 0;

ALTER TABLE wallet_metrics_snapshots
  ADD COLUMN IF NOT EXISTS resolved_edge_sample_count integer,
  ADD COLUMN IF NOT EXISTS resolved_actual_win_rate numeric,
  ADD COLUMN IF NOT EXISTS resolved_expected_win_rate numeric,
  ADD COLUMN IF NOT EXISTS resolved_win_rate_edge numeric,
  ADD COLUMN IF NOT EXISTS resolved_edge_z_score numeric,
  ADD COLUMN IF NOT EXISTS resolved_brier_score numeric,
  ADD COLUMN IF NOT EXISTS resolved_stake_weighted_edge numeric,
  ADD COLUMN IF NOT EXISTS resolved_stake_usd numeric;

ALTER TABLE wallet_intel_selector_snapshot
  ADD COLUMN IF NOT EXISTS metrics_resolved_edge_sample_count_30d integer,
  ADD COLUMN IF NOT EXISTS metrics_resolved_actual_win_rate_30d numeric,
  ADD COLUMN IF NOT EXISTS metrics_resolved_expected_win_rate_30d numeric,
  ADD COLUMN IF NOT EXISTS metrics_resolved_win_rate_edge_30d numeric,
  ADD COLUMN IF NOT EXISTS metrics_resolved_edge_z_score_30d numeric,
  ADD COLUMN IF NOT EXISTS metrics_resolved_brier_score_30d numeric,
  ADD COLUMN IF NOT EXISTS metrics_resolved_stake_weighted_edge_30d numeric,
  ADD COLUMN IF NOT EXISTS metrics_resolved_stake_usd_30d numeric;

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
      s.resolved_edge_sample_count,
      s.resolved_actual_win_rate,
      s.resolved_expected_win_rate,
      s.resolved_win_rate_edge,
      s.resolved_edge_z_score,
      s.resolved_brier_score,
      s.resolved_stake_weighted_edge,
      s.resolved_stake_usd,
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
      lm.resolved_edge_sample_count,
      lm.resolved_actual_win_rate,
      lm.resolved_expected_win_rate,
      lm.resolved_win_rate_edge,
      lm.resolved_edge_z_score,
      lm.resolved_brier_score,
      lm.resolved_stake_weighted_edge,
      lm.resolved_stake_usd,
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
    metrics_resolved_edge_sample_count_30d,
    metrics_resolved_actual_win_rate_30d,
    metrics_resolved_expected_win_rate_30d,
    metrics_resolved_win_rate_edge_30d,
    metrics_resolved_edge_z_score_30d,
    metrics_resolved_brier_score_30d,
    metrics_resolved_stake_weighted_edge_30d,
    metrics_resolved_stake_usd_30d,
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
    src.resolved_edge_sample_count,
    src.resolved_actual_win_rate,
    src.resolved_expected_win_rate,
    src.resolved_win_rate_edge,
    src.resolved_edge_z_score,
    src.resolved_brier_score,
    src.resolved_stake_weighted_edge,
    src.resolved_stake_usd,
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
        metrics_resolved_edge_sample_count_30d = EXCLUDED.metrics_resolved_edge_sample_count_30d,
        metrics_resolved_actual_win_rate_30d = EXCLUDED.metrics_resolved_actual_win_rate_30d,
        metrics_resolved_expected_win_rate_30d = EXCLUDED.metrics_resolved_expected_win_rate_30d,
        metrics_resolved_win_rate_edge_30d = EXCLUDED.metrics_resolved_win_rate_edge_30d,
        metrics_resolved_edge_z_score_30d = EXCLUDED.metrics_resolved_edge_z_score_30d,
        metrics_resolved_brier_score_30d = EXCLUDED.metrics_resolved_brier_score_30d,
        metrics_resolved_stake_weighted_edge_30d = EXCLUDED.metrics_resolved_stake_weighted_edge_30d,
        metrics_resolved_stake_usd_30d = EXCLUDED.metrics_resolved_stake_usd_30d,
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
      snap.metrics_resolved_edge_sample_count_30d,
      snap.metrics_resolved_actual_win_rate_30d,
      snap.metrics_resolved_expected_win_rate_30d,
      snap.metrics_resolved_win_rate_edge_30d,
      snap.metrics_resolved_edge_z_score_30d,
      snap.metrics_resolved_brier_score_30d,
      snap.metrics_resolved_stake_weighted_edge_30d,
      snap.metrics_resolved_stake_usd_30d,
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
      EXCLUDED.metrics_resolved_edge_sample_count_30d,
      EXCLUDED.metrics_resolved_actual_win_rate_30d,
      EXCLUDED.metrics_resolved_expected_win_rate_30d,
      EXCLUDED.metrics_resolved_win_rate_edge_30d,
      EXCLUDED.metrics_resolved_edge_z_score_30d,
      EXCLUDED.metrics_resolved_brier_score_30d,
      EXCLUDED.metrics_resolved_stake_weighted_edge_30d,
      EXCLUDED.metrics_resolved_stake_usd_30d,
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
