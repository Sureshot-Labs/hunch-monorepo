SET statement_timeout = 0;

CREATE TABLE IF NOT EXISTS wallet_intel_selector_snapshot (
  wallet_id uuid PRIMARY KEY REFERENCES wallets(id) ON DELETE CASCADE,
  metrics_as_of timestamptz,
  metrics_volume_30d numeric,
  metrics_pnl_30d numeric,
  metrics_roi_30d numeric,
  metrics_trades_30d integer,
  metrics_win_rate_30d numeric,
  metrics_avg_hold_hours_30d numeric,
  metrics_last_trade_at_30d timestamptz,
  exposure_usd numeric,
  hedged_notional_usd numeric,
  net_imbalance_usd numeric,
  hedge_ratio numeric,
  two_sided_markets integer,
  last_activity_at timestamptz,
  last_trade_activity_at timestamptz,
  last_holder_activity_at timestamptz,
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wallet_intel_selector_snapshot_last_activity
  ON wallet_intel_selector_snapshot (last_activity_at DESC);

CREATE OR REPLACE FUNCTION refresh_wallet_intel_selector_snapshot()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  WITH latest_metrics AS (
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
  activity AS (
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
  source_wallets AS (
    SELECT wallet_id FROM latest_metrics
    UNION
    SELECT wallet_id FROM activity
    UNION
    SELECT wallet_id FROM wallet_position_exposure
  )
  DELETE FROM wallet_intel_selector_snapshot snap
  WHERE NOT EXISTS (
    SELECT 1
    FROM source_wallets sw
    WHERE sw.wallet_id = snap.wallet_id
  );

  WITH latest_metrics AS (
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
  activity AS (
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
  source_wallets AS (
    SELECT wallet_id FROM latest_metrics
    UNION
    SELECT wallet_id FROM activity
    UNION
    SELECT wallet_id FROM wallet_position_exposure
  )
  INSERT INTO wallet_intel_selector_snapshot (
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
    act.last_holder_activity_at,
    now()
  FROM source_wallets sw
  LEFT JOIN latest_metrics lm ON lm.wallet_id = sw.wallet_id
  LEFT JOIN wallet_position_exposure wpe ON wpe.wallet_id = sw.wallet_id
  LEFT JOIN activity act ON act.wallet_id = sw.wallet_id
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
        updated_at = EXCLUDED.updated_at;
END;
$$;

CREATE OR REPLACE FUNCTION refresh_wallet_intel_selector_snapshot_job(
  job_id int,
  config jsonb
)
RETURNS void
LANGUAGE SQL
AS $$
  SELECT refresh_wallet_intel_selector_snapshot()
$$;

SELECT refresh_wallet_intel_selector_snapshot();

SELECT add_job('refresh_wallet_intel_selector_snapshot_job', interval '1 minute')
WHERE EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb')
  AND NOT EXISTS (
    SELECT 1
    FROM timescaledb_information.jobs
    WHERE proc_name IN (
      'refresh_wallet_intel_selector_snapshot',
      'refresh_wallet_intel_selector_snapshot_job'
    )
  );
