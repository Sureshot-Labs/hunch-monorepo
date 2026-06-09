SET statement_timeout = 0;

CREATE OR REPLACE FUNCTION refresh_unified_token_change_24h()
RETURNS void
LANGUAGE SQL
AS $$
  WITH active_markets AS MATERIALIZED (
    SELECT m.id
    FROM unified_markets m
    WHERE m.status = 'ACTIVE'
      AND m.close_time IS NULL
      AND m.expiration_time IS NULL
    UNION
    SELECT m.id
    FROM unified_markets m
    WHERE m.status = 'ACTIVE'
      AND m.close_time IS NULL
      AND m.expiration_time > now()
    UNION
    SELECT m.id
    FROM unified_markets m
    WHERE m.status = 'ACTIVE'
      AND m.close_time > now()
      AND m.expiration_time IS NULL
    UNION
    SELECT m.id
    FROM unified_markets m
    WHERE m.status = 'ACTIVE'
      AND m.close_time > now()
      AND m.expiration_time > now()
  ),
  active_tokens AS MATERIALIZED (
    SELECT DISTINCT mt.token_id
    FROM active_markets am
    JOIN unified_market_tokens mt
      ON mt.market_id = am.id
    WHERE mt.outcome_side = 'YES'
  ),
  token_rows AS MATERIALIZED (
    SELECT
      at.token_id,
      now_row.avg_mid AS avg_mid_now,
      prev_row.avg_mid AS avg_mid_24h,
      CASE
        WHEN now_row.avg_mid IS NULL
          OR prev_row.avg_mid IS NULL
          OR prev_row.avg_mid = 0
        THEN NULL
        ELSE (now_row.avg_mid - prev_row.avg_mid) / prev_row.avg_mid
      END AS change_24h,
      now_row.bucket AS bucket_now,
      prev_row.bucket AS bucket_24h
    FROM active_tokens at
    LEFT JOIN LATERAL (
      SELECT ubh.avg_mid, ubh.bucket
      FROM unified_book_top_1h ubh
      WHERE ubh.token_id = at.token_id
        AND ubh.bucket >= now() - interval '7 days'
      ORDER BY ubh.bucket DESC
      LIMIT 1
    ) now_row ON true
    LEFT JOIN LATERAL (
      SELECT ubh.avg_mid, ubh.bucket
      FROM unified_book_top_1h ubh
      WHERE ubh.token_id = at.token_id
        AND ubh.bucket <= now() - interval '24 hours'
      ORDER BY ubh.bucket DESC
      LIMIT 1
    ) prev_row ON true
  ),
  deleted AS (
    DELETE FROM unified_token_change_24h utc
    WHERE NOT EXISTS (
      SELECT 1
      FROM active_tokens at
      WHERE at.token_id = utc.token_id
    )
    RETURNING 1
  ),
  changed_token_rows AS MATERIALIZED (
    SELECT tr.*
    FROM token_rows tr
    LEFT JOIN unified_token_change_24h utc
      ON utc.token_id = tr.token_id
    WHERE utc.token_id IS NULL
       OR utc.avg_mid_now IS DISTINCT FROM tr.avg_mid_now
       OR utc.avg_mid_24h IS DISTINCT FROM tr.avg_mid_24h
       OR utc.change_24h IS DISTINCT FROM tr.change_24h
       OR utc.bucket_now IS DISTINCT FROM tr.bucket_now
       OR utc.bucket_24h IS DISTINCT FROM tr.bucket_24h
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
  FROM changed_token_rows
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
