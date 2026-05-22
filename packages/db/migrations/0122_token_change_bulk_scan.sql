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
    LEFT JOIN now_rows
      ON now_rows.token_id = at.token_id
    LEFT JOIN prev_rows
      ON prev_rows.token_id = at.token_id
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
