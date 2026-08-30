SET statement_timeout = 0;

CREATE TABLE IF NOT EXISTS unified_refresh_pipeline_state (
  pipeline_name text PRIMARY KEY,
  current_watermark timestamptz,
  baseline_watermark timestamptz,
  successful_cutoff timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE unified_refresh_pipeline_state IS
  'Transactional watermarks for bounded refresh pipelines; cache state only, never business data.';

CREATE OR REPLACE FUNCTION refresh_unified_token_change_24h_full()
RETURNS void
LANGUAGE SQL
AS $$
  WITH active_markets AS MATERIALIZED (
    SELECT market_row.id
    FROM unified_markets market_row
    WHERE market_row.status = 'ACTIVE'
      AND market_row.close_time IS NULL
      AND market_row.expiration_time IS NULL
    UNION
    SELECT market_row.id
    FROM unified_markets market_row
    WHERE market_row.status = 'ACTIVE'
      AND market_row.close_time IS NULL
      AND market_row.expiration_time > now()
    UNION
    SELECT market_row.id
    FROM unified_markets market_row
    WHERE market_row.status = 'ACTIVE'
      AND market_row.close_time > now()
      AND market_row.expiration_time IS NULL
    UNION
    SELECT market_row.id
    FROM unified_markets market_row
    WHERE market_row.status = 'ACTIVE'
      AND market_row.close_time > now()
      AND market_row.expiration_time > now()
  ),
  active_tokens AS MATERIALIZED (
    SELECT DISTINCT market_token.token_id
    FROM active_markets active_market
    JOIN unified_market_tokens market_token
      ON market_token.market_id = active_market.id
    WHERE market_token.outcome_side = 'YES'
  ),
  token_rows AS MATERIALIZED (
    SELECT
      active_token.token_id,
      latest_row.avg_mid AS avg_mid_now,
      baseline_row.avg_mid AS avg_mid_24h,
      CASE
        WHEN latest_row.avg_mid IS NULL
          OR baseline_row.avg_mid IS NULL
          OR baseline_row.avg_mid = 0
        THEN NULL
        ELSE (latest_row.avg_mid - baseline_row.avg_mid) / baseline_row.avg_mid
      END AS change_24h,
      latest_row.bucket AS bucket_now,
      baseline_row.bucket AS bucket_24h
    FROM active_tokens active_token
    LEFT JOIN LATERAL (
      SELECT hourly_top.avg_mid, hourly_top.bucket
      FROM unified_book_top_1h hourly_top
      WHERE hourly_top.token_id = active_token.token_id
        AND hourly_top.bucket >= now() - interval '7 days'
      ORDER BY hourly_top.bucket DESC
      LIMIT 1
    ) latest_row ON true
    LEFT JOIN LATERAL (
      SELECT hourly_top.avg_mid, hourly_top.bucket
      FROM unified_book_top_1h hourly_top
      WHERE hourly_top.token_id = active_token.token_id
        AND hourly_top.bucket <= now() - interval '24 hours'
      ORDER BY hourly_top.bucket DESC
      LIMIT 1
    ) baseline_row ON true
  ),
  deleted_rows AS (
    DELETE FROM unified_token_change_24h token_cache
    WHERE NOT EXISTS (
      SELECT 1
      FROM active_tokens active_token
      WHERE active_token.token_id = token_cache.token_id
    )
    RETURNING 1
  ),
  changed_token_rows AS MATERIALIZED (
    SELECT token_row.*
    FROM token_rows token_row
    LEFT JOIN unified_token_change_24h token_cache
      ON token_cache.token_id = token_row.token_id
    WHERE token_cache.token_id IS NULL
       OR token_cache.avg_mid_now IS DISTINCT FROM token_row.avg_mid_now
       OR token_cache.avg_mid_24h IS DISTINCT FROM token_row.avg_mid_24h
       OR token_cache.change_24h IS DISTINCT FROM token_row.change_24h
       OR token_cache.bucket_now IS DISTINCT FROM token_row.bucket_now
       OR token_cache.bucket_24h IS DISTINCT FROM token_row.bucket_24h
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
    changed_token.token_id,
    changed_token.avg_mid_now,
    changed_token.avg_mid_24h,
    changed_token.change_24h,
    changed_token.bucket_now,
    changed_token.bucket_24h,
    now()
  FROM changed_token_rows changed_token
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

INSERT INTO unified_refresh_pipeline_state (
  pipeline_name,
  current_watermark,
  baseline_watermark,
  updated_at
)
SELECT
  'token_change_24h',
  max(hourly_top.bucket),
  date_trunc('hour', now() - interval '24 hours'),
  now()
FROM unified_book_top_1h hourly_top
ON CONFLICT (pipeline_name) DO NOTHING;

CREATE OR REPLACE FUNCTION refresh_unified_token_change_24h()
RETURNS void
LANGUAGE plpgsql
SET jit = off
AS $$
DECLARE
  v_current_watermark timestamptz;
  v_baseline_watermark timestamptz;
  v_previous_current_watermark timestamptz;
  v_previous_baseline_watermark timestamptz;
  v_lock_acquired boolean;
BEGIN
  v_lock_acquired := pg_try_advisory_xact_lock(
    hashtext('hunch_refresh'),
    hashtext('unified_token_change_24h')
  );

  IF NOT v_lock_acquired THEN
    RETURN;
  END IF;

  SELECT max(hourly_top.bucket)
  INTO v_current_watermark
  FROM unified_book_top_1h hourly_top;

  IF v_current_watermark IS NULL THEN
    RETURN;
  END IF;

  v_baseline_watermark := date_trunc('hour', now() - interval '24 hours');

  INSERT INTO unified_refresh_pipeline_state (
    pipeline_name,
    current_watermark,
    baseline_watermark,
    updated_at
  )
  VALUES (
    'token_change_24h',
    v_current_watermark,
    v_baseline_watermark,
    now()
  )
  ON CONFLICT (pipeline_name) DO NOTHING;

  SELECT
    pipeline_state.current_watermark,
    pipeline_state.baseline_watermark
  INTO
    v_previous_current_watermark,
    v_previous_baseline_watermark
  FROM unified_refresh_pipeline_state pipeline_state
  WHERE pipeline_state.pipeline_name = 'token_change_24h'
  FOR UPDATE;

  IF v_previous_current_watermark IS NULL
    OR v_previous_baseline_watermark IS NULL
  THEN
    PERFORM refresh_unified_token_change_24h_full();

    UPDATE unified_refresh_pipeline_state pipeline_state
    SET current_watermark = v_current_watermark,
        baseline_watermark = v_baseline_watermark,
        updated_at = now()
    WHERE pipeline_state.pipeline_name = 'token_change_24h';
    RETURN;
  END IF;

  IF v_current_watermark <= v_previous_current_watermark
    AND v_baseline_watermark <= v_previous_baseline_watermark
  THEN
    RETURN;
  END IF;

  WITH current_updates AS MATERIALIZED (
    SELECT DISTINCT ON (hourly_top.token_id)
      hourly_top.token_id,
      hourly_top.avg_mid,
      hourly_top.bucket
    FROM unified_book_top_1h hourly_top
    WHERE v_current_watermark > v_previous_current_watermark
      AND hourly_top.bucket > v_previous_current_watermark
      AND hourly_top.bucket <= v_current_watermark
    ORDER BY hourly_top.token_id, hourly_top.bucket DESC
  ),
  baseline_updates AS MATERIALIZED (
    SELECT DISTINCT ON (hourly_top.token_id)
      hourly_top.token_id,
      hourly_top.avg_mid,
      hourly_top.bucket
    FROM unified_book_top_1h hourly_top
    WHERE v_baseline_watermark > v_previous_baseline_watermark
      AND hourly_top.bucket > v_previous_baseline_watermark
      AND hourly_top.bucket <= v_baseline_watermark
    ORDER BY hourly_top.token_id, hourly_top.bucket DESC
  ),
  candidate_tokens AS MATERIALIZED (
    SELECT current_update.token_id
    FROM current_updates current_update
    UNION
    SELECT baseline_update.token_id
    FROM baseline_updates baseline_update
  ),
  proposed_token_rows AS MATERIALIZED (
    SELECT
      token_cache.token_id,
      CASE
        WHEN current_update.token_id IS NOT NULL THEN current_update.avg_mid
        ELSE token_cache.avg_mid_now
      END AS avg_mid_now,
      CASE
        WHEN baseline_update.token_id IS NOT NULL THEN baseline_update.avg_mid
        ELSE token_cache.avg_mid_24h
      END AS avg_mid_24h,
      CASE
        WHEN current_update.token_id IS NOT NULL THEN current_update.bucket
        ELSE token_cache.bucket_now
      END AS bucket_now,
      CASE
        WHEN baseline_update.token_id IS NOT NULL THEN baseline_update.bucket
        ELSE token_cache.bucket_24h
      END AS bucket_24h
    FROM candidate_tokens candidate_token
    JOIN unified_token_change_24h token_cache
      ON token_cache.token_id = candidate_token.token_id
    LEFT JOIN current_updates current_update
      ON current_update.token_id = candidate_token.token_id
    LEFT JOIN baseline_updates baseline_update
      ON baseline_update.token_id = candidate_token.token_id
  ),
  calculated_token_rows AS MATERIALIZED (
    SELECT
      proposed_token.token_id,
      proposed_token.avg_mid_now,
      proposed_token.avg_mid_24h,
      CASE
        WHEN proposed_token.avg_mid_now IS NULL
          OR proposed_token.avg_mid_24h IS NULL
          OR proposed_token.avg_mid_24h = 0
        THEN NULL
        ELSE (
          proposed_token.avg_mid_now - proposed_token.avg_mid_24h
        ) / proposed_token.avg_mid_24h
      END AS change_24h,
      proposed_token.bucket_now,
      proposed_token.bucket_24h
    FROM proposed_token_rows proposed_token
  )
  UPDATE unified_token_change_24h token_cache
  SET avg_mid_now = calculated_token.avg_mid_now,
      avg_mid_24h = calculated_token.avg_mid_24h,
      change_24h = calculated_token.change_24h,
      bucket_now = calculated_token.bucket_now,
      bucket_24h = calculated_token.bucket_24h,
      updated_at = now()
  FROM calculated_token_rows calculated_token
  WHERE token_cache.token_id = calculated_token.token_id
    AND (
      token_cache.avg_mid_now IS DISTINCT FROM calculated_token.avg_mid_now
      OR token_cache.avg_mid_24h IS DISTINCT FROM calculated_token.avg_mid_24h
      OR token_cache.change_24h IS DISTINCT FROM calculated_token.change_24h
      OR token_cache.bucket_now IS DISTINCT FROM calculated_token.bucket_now
      OR token_cache.bucket_24h IS DISTINCT FROM calculated_token.bucket_24h
    );

  UPDATE unified_refresh_pipeline_state pipeline_state
  SET current_watermark = greatest(
        pipeline_state.current_watermark,
        v_current_watermark
      ),
      baseline_watermark = greatest(
        pipeline_state.baseline_watermark,
        v_baseline_watermark
      ),
      updated_at = now()
  WHERE pipeline_state.pipeline_name = 'token_change_24h';
END;
$$;

CREATE OR REPLACE FUNCTION refresh_unified_token_change_24h_job(
  job_id int,
  config jsonb
)
RETURNS void
LANGUAGE SQL
AS $$
  SELECT refresh_unified_token_change_24h()
$$;

CREATE OR REPLACE FUNCTION refresh_unified_token_change_24h_full_job(
  job_id int,
  config jsonb
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_current_watermark timestamptz;
  v_lock_acquired boolean;
BEGIN
  v_lock_acquired := pg_try_advisory_xact_lock(
    hashtext('hunch_refresh'),
    hashtext('unified_token_change_24h')
  );

  IF NOT v_lock_acquired THEN
    RETURN;
  END IF;

  PERFORM refresh_unified_token_change_24h_full();

  SELECT max(hourly_top.bucket)
  INTO v_current_watermark
  FROM unified_book_top_1h hourly_top;

  INSERT INTO unified_refresh_pipeline_state (
    pipeline_name,
    current_watermark,
    baseline_watermark,
    updated_at
  )
  VALUES (
    'token_change_24h',
    v_current_watermark,
    date_trunc('hour', now() - interval '24 hours'),
    now()
  )
  ON CONFLICT (pipeline_name) DO UPDATE
    SET current_watermark = EXCLUDED.current_watermark,
        baseline_watermark = EXCLUDED.baseline_watermark,
        updated_at = EXCLUDED.updated_at;
END;
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM timescaledb_information.jobs
        WHERE proc_name = 'refresh_unified_token_change_24h_full_job'
      ) THEN
        PERFORM add_job(
          'refresh_unified_token_change_24h_full_job',
          interval '1 hour'
        );
      END IF;
    EXCEPTION
      WHEN undefined_function OR undefined_table THEN
        NULL;
    END;
  END IF;
END;
$$;
