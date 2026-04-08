SET statement_timeout = 0;

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
  now_rows AS MATERIALIZED (
    SELECT DISTINCT ON (ubh.token_id)
      ubh.token_id,
      ubh.avg_mid,
      ubh.bucket
    FROM unified_book_top_1h ubh
    JOIN active_tokens at
      ON at.token_id = ubh.token_id
    WHERE ubh.bucket >= now() - interval '7 days'
    ORDER BY ubh.token_id, ubh.bucket DESC
  ),
  prev_rows AS MATERIALIZED (
    SELECT DISTINCT ON (ubh.token_id)
      ubh.token_id,
      ubh.avg_mid,
      ubh.bucket
    FROM unified_book_top_1h ubh
    JOIN active_tokens at
      ON at.token_id = ubh.token_id
    WHERE ubh.bucket <= now() - interval '24 hours'
    ORDER BY ubh.token_id, ubh.bucket DESC
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
    at.token_id,
    now_rows.avg_mid,
    prev_rows.avg_mid,
    CASE
      WHEN now_rows.avg_mid IS NULL
        OR prev_rows.avg_mid IS NULL
        OR prev_rows.avg_mid = 0
      THEN NULL
      ELSE (now_rows.avg_mid - prev_rows.avg_mid) / prev_rows.avg_mid
    END AS change_24h,
    now_rows.bucket,
    prev_rows.bucket,
    now()
  FROM active_tokens at
  LEFT JOIN now_rows
    ON now_rows.token_id = at.token_id
  LEFT JOIN prev_rows
    ON prev_rows.token_id = at.token_id
  ON CONFLICT (token_id) DO UPDATE
    SET avg_mid_now = EXCLUDED.avg_mid_now,
        avg_mid_24h = EXCLUDED.avg_mid_24h,
        change_24h = EXCLUDED.change_24h,
        bucket_now = EXCLUDED.bucket_now,
        bucket_24h = EXCLUDED.bucket_24h,
        updated_at = EXCLUDED.updated_at
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
$$;

SELECT refresh_unified_token_change_24h();
SELECT refresh_unified_market_change_24h();
SELECT refresh_wallet_intel_selector_snapshot();
