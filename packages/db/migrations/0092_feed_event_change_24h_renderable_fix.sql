SET statement_timeout = 0;

CREATE OR REPLACE FUNCTION refresh_unified_event_change_24h()
RETURNS void
LANGUAGE SQL
AS $$
  INSERT INTO unified_event_change_24h (
    event_id,
    change_24h,
    updated_at
  )
  SELECT
    e.id,
    avg(mc.change_24h) AS change_24h,
    now()
  FROM unified_events e
  JOIN unified_markets m ON m.event_id = e.id
  LEFT JOIN unified_market_change_24h mc ON mc.market_id = m.id
  WHERE e.status = 'ACTIVE'
    AND m.status = 'ACTIVE'
    AND (e.end_date IS NULL OR e.end_date > now())
    AND (m.expiration_time IS NULL OR m.expiration_time > now())
    AND (m.close_time IS NULL OR m.close_time > now())
    AND (
      coalesce(m.volume_total, 0) > 0
      OR coalesce(m.volume_24h, 0) > 0
      OR coalesce(m.liquidity, 0) > 0
      OR coalesce(m.open_interest, 0) > 0
      OR m.best_bid IS NOT NULL
      OR m.best_ask IS NOT NULL
      OR m.last_price IS NOT NULL
    )
  GROUP BY e.id
  ON CONFLICT (event_id) DO UPDATE
    SET change_24h = EXCLUDED.change_24h,
        updated_at = EXCLUDED.updated_at
$$;

SELECT refresh_unified_event_change_24h();
