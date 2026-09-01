SET statement_timeout = 0;

CREATE TABLE IF NOT EXISTS unified_change24_dirty_markets (
  market_id text PRIMARY KEY,
  enqueued_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS unified_change24_dirty_events (
  event_id text PRIMARY KEY,
  enqueued_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

COMMENT ON TABLE unified_change24_dirty_markets IS
  'Small transactional queue of markets whose structural or historical inputs require an exact change24h refresh.';

COMMENT ON TABLE unified_change24_dirty_events IS
  'Small transactional queue of events whose lifecycle or market inputs require an exact change24h refresh.';

INSERT INTO unified_refresh_pipeline_state (
  pipeline_name,
  successful_cutoff,
  updated_at
)
VALUES (
  'market_event_change_24h',
  clock_timestamp() - interval '15 minutes',
  now()
)
ON CONFLICT (pipeline_name) DO NOTHING;

CREATE OR REPLACE FUNCTION enqueue_unified_change24_market(
  p_market_id text
)
RETURNS void
LANGUAGE SQL
AS $$
  INSERT INTO unified_change24_dirty_markets (market_id)
  SELECT p_market_id
  WHERE p_market_id IS NOT NULL
  ON CONFLICT (market_id) DO NOTHING
$$;

CREATE OR REPLACE FUNCTION enqueue_unified_change24_event(
  p_event_id text
)
RETURNS void
LANGUAGE SQL
AS $$
  INSERT INTO unified_change24_dirty_events (event_id)
  SELECT p_event_id
  WHERE p_event_id IS NOT NULL
  ON CONFLICT (event_id) DO NOTHING
$$;

CREATE OR REPLACE FUNCTION enqueue_unified_change24_market_tokens_statement()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO unified_change24_dirty_markets (market_id)
    SELECT DISTINCT inserted_token.market_id
    FROM inserted_market_tokens inserted_token
    ON CONFLICT (market_id) DO NOTHING;
  ELSIF TG_OP = 'DELETE' THEN
    INSERT INTO unified_change24_dirty_markets (market_id)
    SELECT DISTINCT deleted_token.market_id
    FROM deleted_market_tokens deleted_token
    ON CONFLICT (market_id) DO NOTHING;
  ELSE
    INSERT INTO unified_change24_dirty_markets (market_id)
    SELECT previous_token.market_id
    FROM previous_market_tokens previous_token
    UNION
    SELECT updated_token.market_id
    FROM updated_market_tokens updated_token
    ON CONFLICT (market_id) DO NOTHING;
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS enqueue_unified_change24_market_token_trigger
  ON unified_market_tokens;
DROP TRIGGER IF EXISTS enqueue_unified_change24_market_token_insert_trigger
  ON unified_market_tokens;
DROP TRIGGER IF EXISTS enqueue_unified_change24_market_token_update_trigger
  ON unified_market_tokens;
DROP TRIGGER IF EXISTS enqueue_unified_change24_market_token_delete_trigger
  ON unified_market_tokens;

CREATE TRIGGER enqueue_unified_change24_market_token_insert_trigger
AFTER INSERT ON unified_market_tokens
REFERENCING NEW TABLE AS inserted_market_tokens
FOR EACH STATEMENT
EXECUTE FUNCTION enqueue_unified_change24_market_tokens_statement();

CREATE TRIGGER enqueue_unified_change24_market_token_update_trigger
AFTER UPDATE ON unified_market_tokens
REFERENCING
  OLD TABLE AS previous_market_tokens
  NEW TABLE AS updated_market_tokens
FOR EACH STATEMENT
EXECUTE FUNCTION enqueue_unified_change24_market_tokens_statement();

CREATE TRIGGER enqueue_unified_change24_market_token_delete_trigger
AFTER DELETE ON unified_market_tokens
REFERENCING OLD TABLE AS deleted_market_tokens
FOR EACH STATEMENT
EXECUTE FUNCTION enqueue_unified_change24_market_tokens_statement();

CREATE OR REPLACE FUNCTION enqueue_unified_change24_token_history_statement()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO unified_change24_dirty_markets (market_id)
    SELECT DISTINCT market_token.market_id
    FROM inserted_token_history inserted_history
    JOIN unified_market_tokens market_token
      ON market_token.token_id = inserted_history.token_id
    ON CONFLICT (market_id) DO NOTHING;
  ELSIF TG_OP = 'DELETE' THEN
    INSERT INTO unified_change24_dirty_markets (market_id)
    SELECT DISTINCT market_token.market_id
    FROM deleted_token_history deleted_history
    JOIN unified_market_tokens market_token
      ON market_token.token_id = deleted_history.token_id
    ON CONFLICT (market_id) DO NOTHING;
  ELSE
    INSERT INTO unified_change24_dirty_markets (market_id)
    WITH changed_token_ids AS MATERIALIZED (
      SELECT previous_history.token_id
      FROM previous_token_history previous_history
      UNION
      SELECT updated_history.token_id
      FROM updated_token_history updated_history
    )
    SELECT DISTINCT market_token.market_id
    FROM changed_token_ids changed_token
    JOIN unified_market_tokens market_token
      ON market_token.token_id = changed_token.token_id
    ON CONFLICT (market_id) DO NOTHING;
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS enqueue_unified_change24_token_history_trigger
  ON unified_token_change_24h;
DROP TRIGGER IF EXISTS enqueue_unified_change24_token_history_insert_trigger
  ON unified_token_change_24h;
DROP TRIGGER IF EXISTS enqueue_unified_change24_token_history_update_trigger
  ON unified_token_change_24h;
DROP TRIGGER IF EXISTS enqueue_unified_change24_token_history_delete_trigger
  ON unified_token_change_24h;

CREATE TRIGGER enqueue_unified_change24_token_history_insert_trigger
AFTER INSERT ON unified_token_change_24h
REFERENCING NEW TABLE AS inserted_token_history
FOR EACH STATEMENT
EXECUTE FUNCTION enqueue_unified_change24_token_history_statement();

CREATE TRIGGER enqueue_unified_change24_token_history_update_trigger
AFTER UPDATE ON unified_token_change_24h
REFERENCING
  OLD TABLE AS previous_token_history
  NEW TABLE AS updated_token_history
FOR EACH STATEMENT
EXECUTE FUNCTION enqueue_unified_change24_token_history_statement();

CREATE TRIGGER enqueue_unified_change24_token_history_delete_trigger
AFTER DELETE ON unified_token_change_24h
REFERENCING OLD TABLE AS deleted_token_history
FOR EACH STATEMENT
EXECUTE FUNCTION enqueue_unified_change24_token_history_statement();

CREATE OR REPLACE FUNCTION enqueue_unified_change24_unified_market()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_old_has_activity boolean;
  v_new_has_activity boolean;
  v_market_inputs_changed boolean;
  v_event_inputs_changed boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM enqueue_unified_change24_market(NEW.id);
    PERFORM enqueue_unified_change24_event(NEW.event_id);
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM enqueue_unified_change24_market(OLD.id);
    PERFORM enqueue_unified_change24_event(OLD.event_id);
    RETURN OLD;
  END IF;

  v_old_has_activity :=
    coalesce(OLD.volume_total, 0) > 0
    OR coalesce(OLD.volume_24h, 0) > 0
    OR coalesce(OLD.liquidity, 0) > 0
    OR coalesce(OLD.open_interest, 0) > 0
    OR OLD.best_bid IS NOT NULL
    OR OLD.best_ask IS NOT NULL
    OR OLD.last_price IS NOT NULL;

  v_new_has_activity :=
    coalesce(NEW.volume_total, 0) > 0
    OR coalesce(NEW.volume_24h, 0) > 0
    OR coalesce(NEW.liquidity, 0) > 0
    OR coalesce(NEW.open_interest, 0) > 0
    OR NEW.best_bid IS NOT NULL
    OR NEW.best_ask IS NOT NULL
    OR NEW.last_price IS NOT NULL;

  -- Terminal settlement and DFlow route clearing update latest tops directly,
  -- without a raw book row. Their paired market update is the wake-up signal.
  v_market_inputs_changed :=
    OLD.status IS DISTINCT FROM NEW.status
    OR OLD.close_time IS DISTINCT FROM NEW.close_time
    OR OLD.expiration_time IS DISTINCT FROM NEW.expiration_time
    OR OLD.resolved_outcome IS DISTINCT FROM NEW.resolved_outcome
    OR OLD.resolved_outcome_pct IS DISTINCT FROM NEW.resolved_outcome_pct
    OR (
      (
        NEW.resolved_outcome IS NOT NULL
        OR NEW.resolved_outcome_pct IS NOT NULL
      )
      AND OLD.last_price IS DISTINCT FROM NEW.last_price
    )
    OR lower(
      coalesce(OLD.metadata->>'dflowNativeAcceptingOrders', 'false')
    ) IS DISTINCT FROM lower(
      coalesce(NEW.metadata->>'dflowNativeAcceptingOrders', 'false')
    );

  v_event_inputs_changed :=
    OLD.event_id IS DISTINCT FROM NEW.event_id
    OR OLD.venue IS DISTINCT FROM NEW.venue
    OR OLD.venue_market_id IS DISTINCT FROM NEW.venue_market_id
    OR OLD.status IS DISTINCT FROM NEW.status
    OR OLD.close_time IS DISTINCT FROM NEW.close_time
    OR OLD.expiration_time IS DISTINCT FROM NEW.expiration_time
    OR lower(
      coalesce(OLD.metadata->>'dflowNativeAcceptingOrders', 'false')
    ) IS DISTINCT FROM lower(
      coalesce(NEW.metadata->>'dflowNativeAcceptingOrders', 'false')
    )
    OR v_old_has_activity IS DISTINCT FROM v_new_has_activity;

  IF v_market_inputs_changed THEN
    PERFORM enqueue_unified_change24_market(NEW.id);
  END IF;

  IF v_event_inputs_changed THEN
    PERFORM enqueue_unified_change24_event(OLD.event_id);
    PERFORM enqueue_unified_change24_event(NEW.event_id);
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enqueue_unified_change24_unified_market_trigger
  ON unified_markets;

CREATE TRIGGER enqueue_unified_change24_unified_market_trigger
AFTER INSERT OR DELETE OR UPDATE OF
  event_id,
  venue,
  venue_market_id,
  status,
  close_time,
  expiration_time,
  resolved_outcome,
  resolved_outcome_pct,
  metadata,
  volume_total,
  volume_24h,
  liquidity,
  open_interest,
  best_bid,
  best_ask,
  last_price
ON unified_markets
FOR EACH ROW
EXECUTE FUNCTION enqueue_unified_change24_unified_market();

CREATE OR REPLACE FUNCTION enqueue_unified_change24_unified_event()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM enqueue_unified_change24_event(OLD.id);
    RETURN OLD;
  END IF;

  PERFORM enqueue_unified_change24_event(NEW.id);

  IF TG_OP = 'UPDATE' AND OLD.id IS DISTINCT FROM NEW.id THEN
    PERFORM enqueue_unified_change24_event(OLD.id);
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enqueue_unified_change24_unified_event_insert_delete_trigger
  ON unified_events;

CREATE TRIGGER enqueue_unified_change24_unified_event_insert_delete_trigger
AFTER INSERT OR DELETE ON unified_events
FOR EACH ROW
EXECUTE FUNCTION enqueue_unified_change24_unified_event();

DROP TRIGGER IF EXISTS enqueue_unified_change24_unified_event_update_trigger
  ON unified_events;

CREATE TRIGGER enqueue_unified_change24_unified_event_update_trigger
AFTER UPDATE OF id, status, end_date ON unified_events
FOR EACH ROW
WHEN (
  OLD.id IS DISTINCT FROM NEW.id
  OR OLD.status IS DISTINCT FROM NEW.status
  OR OLD.end_date IS DISTINCT FROM NEW.end_date
)
EXECUTE FUNCTION enqueue_unified_change24_unified_event();

CREATE OR REPLACE FUNCTION enqueue_unified_change24_polymarket_market()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_source_market_ids text[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_source_market_ids := ARRAY[NEW.id];
  ELSIF TG_OP = 'DELETE' THEN
    v_source_market_ids := ARRAY[OLD.id];
  ELSE
    v_source_market_ids := ARRAY[OLD.id, NEW.id];
  END IF;

  INSERT INTO unified_change24_dirty_events (event_id)
  SELECT DISTINCT market_row.event_id
  FROM unified_markets market_row
  WHERE market_row.venue = 'polymarket'
    AND market_row.venue_market_id = ANY(v_source_market_ids)
  ON CONFLICT (event_id) DO NOTHING;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enqueue_change24_polymarket_market_insert_delete
  ON polymarket_markets;

CREATE TRIGGER enqueue_change24_polymarket_market_insert_delete
AFTER INSERT OR DELETE ON polymarket_markets
FOR EACH ROW
EXECUTE FUNCTION enqueue_unified_change24_polymarket_market();

DROP TRIGGER IF EXISTS enqueue_unified_change24_polymarket_market_update_trigger
  ON polymarket_markets;

CREATE TRIGGER enqueue_unified_change24_polymarket_market_update_trigger
AFTER UPDATE OF id, accepting_orders, active, closed, archived
ON polymarket_markets
FOR EACH ROW
WHEN (
  OLD.id IS DISTINCT FROM NEW.id
  OR OLD.accepting_orders IS DISTINCT FROM NEW.accepting_orders
  OR OLD.active IS DISTINCT FROM NEW.active
  OR OLD.closed IS DISTINCT FROM NEW.closed
  OR OLD.archived IS DISTINCT FROM NEW.archived
)
EXECUTE FUNCTION enqueue_unified_change24_polymarket_market();

CREATE OR REPLACE FUNCTION enqueue_unified_change24_market_cache_event()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_market_id text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_market_id := OLD.market_id;
  ELSE
    v_market_id := NEW.market_id;
  END IF;

  INSERT INTO unified_change24_dirty_events (event_id)
  SELECT market_row.event_id
  FROM unified_markets market_row
  WHERE market_row.id = v_market_id
  ON CONFLICT (event_id) DO NOTHING;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enqueue_change24_market_cache_event_insert_delete
  ON unified_market_change_24h;

CREATE TRIGGER enqueue_change24_market_cache_event_insert_delete
AFTER INSERT OR DELETE ON unified_market_change_24h
FOR EACH ROW
EXECUTE FUNCTION enqueue_unified_change24_market_cache_event();

DROP TRIGGER IF EXISTS enqueue_unified_change24_market_cache_event_update_trigger
  ON unified_market_change_24h;

CREATE TRIGGER enqueue_unified_change24_market_cache_event_update_trigger
AFTER UPDATE OF change_24h, calculation_version
ON unified_market_change_24h
FOR EACH ROW
WHEN (
  OLD.change_24h IS DISTINCT FROM NEW.change_24h
  OR OLD.calculation_version IS DISTINCT FROM NEW.calculation_version
)
EXECUTE FUNCTION enqueue_unified_change24_market_cache_event();

CREATE OR REPLACE FUNCTION refresh_unified_market_event_change_24h_incremental()
RETURNS void
LANGUAGE plpgsql
SET jit = off
AS $$
DECLARE
  v_scan_until timestamptz := clock_timestamp();
  v_previous_cutoff timestamptz;
  v_scan_from timestamptz;
  v_market_ids text[] := ARRAY[]::text[];
  v_event_ids text[] := ARRAY[]::text[];
  v_market_candidate_count integer := 0;
  v_event_candidate_count integer := 0;
  v_market_written_count bigint := 0;
  v_event_written_count bigint := 0;
  v_lock_acquired boolean;
BEGIN
  v_lock_acquired := pg_try_advisory_xact_lock(
    hashtext('hunch_refresh'),
    hashtext('unified_market_event_change_24h')
  );

  IF NOT v_lock_acquired THEN
    RETURN;
  END IF;

  INSERT INTO unified_refresh_pipeline_state (
    pipeline_name,
    successful_cutoff,
    updated_at
  )
  VALUES (
    'market_event_change_24h',
    v_scan_until - interval '15 minutes',
    now()
  )
  ON CONFLICT (pipeline_name) DO NOTHING;

  SELECT pipeline_state.successful_cutoff
  INTO v_previous_cutoff
  FROM unified_refresh_pipeline_state pipeline_state
  WHERE pipeline_state.pipeline_name = 'market_event_change_24h'
  FOR UPDATE;

  -- The hourly exact rebuild repairs anything older than this bounded window.
  -- Keeping the common job bounded prevents a long outage from causing a
  -- catch-up scan over the full raw retention period.
  v_scan_from := greatest(
    coalesce(
      v_previous_cutoff - interval '5 minutes',
      v_scan_until - interval '20 minutes'
    ),
    v_scan_until - interval '2 hours'
  );

  IF v_scan_from > v_scan_until THEN
    v_scan_from := v_scan_until - interval '5 minutes';
  END IF;

  WITH claimed_dirty_markets AS MATERIALIZED (
    DELETE FROM unified_change24_dirty_markets dirty_market
    RETURNING dirty_market.market_id
  ),
  recent_token_ids AS MATERIALIZED (
    SELECT DISTINCT book_top.token_id
    FROM unified_book_top book_top
    WHERE book_top.ts > v_scan_from
      AND book_top.ts <= v_scan_until
  ),
  recent_price_markets AS MATERIALIZED (
    SELECT DISTINCT market_token.market_id
    FROM recent_token_ids recent_token
    JOIN unified_market_tokens market_token
      ON market_token.token_id = recent_token.token_id
  ),
  invalid_cached_markets AS MATERIALIZED (
    SELECT market_cache.market_id
    FROM unified_market_change_24h market_cache
    LEFT JOIN unified_markets market_row
      ON market_row.id = market_cache.market_id
    WHERE market_cache.calculation_version = 2
      AND (
        market_row.id IS NULL
        OR market_row.status <> 'ACTIVE'
        OR (
          market_row.expiration_time IS NOT NULL
          AND market_row.expiration_time <= v_scan_until
        )
        OR (
          market_row.close_time IS NOT NULL
          AND market_row.close_time <= v_scan_until
        )
      )
  ),
  market_candidates AS MATERIALIZED (
    SELECT claimed_market.market_id
    FROM claimed_dirty_markets claimed_market
    UNION
    SELECT price_market.market_id
    FROM recent_price_markets price_market
    UNION
    SELECT invalid_market.market_id
    FROM invalid_cached_markets invalid_market
  )
  SELECT coalesce(
    array_agg(market_candidate.market_id),
    ARRAY[]::text[]
  )
  INTO v_market_ids
  FROM market_candidates market_candidate;

  v_market_candidate_count := cardinality(v_market_ids);

  IF v_market_candidate_count > 0 THEN
    WITH candidate_market_ids AS MATERIALIZED (
      SELECT candidate_market.market_id
      FROM unnest(v_market_ids) AS candidate_market(market_id)
    ),
    canonical_yes_tokens AS MATERIALIZED (
      SELECT
        market_row.id AS market_id,
        canonical_yes.token_id AS token_yes,
        history_yes.avg_mid_24h AS historical_yes
      FROM candidate_market_ids candidate_market
      JOIN unified_markets market_row
        ON market_row.id = candidate_market.market_id
      JOIN LATERAL (
        SELECT market_token.token_id
        FROM unified_market_tokens market_token
        WHERE market_token.market_id = market_row.id
          AND market_token.outcome_side = 'YES'
        ORDER BY
          market_token.updated_at DESC NULLS LAST,
          market_token.token_id ASC
        LIMIT 1
      ) canonical_yes ON true
      JOIN unified_token_change_24h history_yes
        ON history_yes.token_id = canonical_yes.token_id
       AND history_yes.avg_mid_24h IS NOT NULL
      WHERE market_row.status = 'ACTIVE'
        AND (
          market_row.expiration_time IS NULL
          OR market_row.expiration_time > v_scan_until
        )
        AND (
          market_row.close_time IS NULL
          OR market_row.close_time > v_scan_until
        )
    ),
    mapped_markets AS MATERIALIZED (
      SELECT
        yes_token.market_id,
        yes_token.token_yes,
        canonical_no.token_id AS token_no,
        yes_token.historical_yes,
        history_no.avg_mid_24h AS historical_no
      FROM canonical_yes_tokens yes_token
      LEFT JOIN LATERAL (
        SELECT market_token.token_id
        FROM unified_market_tokens market_token
        WHERE market_token.market_id = yes_token.market_id
          AND market_token.outcome_side = 'NO'
        ORDER BY
          market_token.updated_at DESC NULLS LAST,
          market_token.token_id ASC
        LIMIT 1
      ) canonical_no ON true
      LEFT JOIN unified_token_change_24h history_no
        ON history_no.token_id = canonical_no.token_id
       AND history_no.avg_mid_24h IS NOT NULL
    ),
    price_inputs AS MATERIALIZED (
      SELECT
        mapped_market.market_id,
        current_yes.best_bid AS current_yes_bid,
        current_yes.best_ask AS current_yes_ask,
        current_no.best_bid AS current_no_bid,
        current_no.best_ask AS current_no_ask,
        mapped_market.historical_yes,
        mapped_market.historical_no
      FROM mapped_markets mapped_market
      LEFT JOIN unified_token_top_latest current_yes
        ON current_yes.token_id = mapped_market.token_yes
      LEFT JOIN unified_token_top_latest current_no
        ON current_no.token_id = mapped_market.token_no
    ),
    probability_mids AS MATERIALIZED (
      SELECT
        price_input.market_id,
        CASE
          WHEN price_input.current_yes_bid BETWEEN 0 AND 1
            AND price_input.current_yes_ask BETWEEN 0 AND 1
            AND price_input.current_yes_bid <= price_input.current_yes_ask
            THEN (
              price_input.current_yes_bid + price_input.current_yes_ask
            ) / 2
          ELSE NULL
        END AS current_yes_mid,
        CASE
          WHEN price_input.current_no_bid BETWEEN 0 AND 1
            AND price_input.current_no_ask BETWEEN 0 AND 1
            AND price_input.current_no_bid <= price_input.current_no_ask
            THEN (
              price_input.current_no_bid + price_input.current_no_ask
            ) / 2
          ELSE NULL
        END AS current_no_mid,
        CASE
          WHEN price_input.historical_yes BETWEEN 0 AND 1
            THEN price_input.historical_yes
          ELSE NULL
        END AS historical_yes_mid,
        CASE
          WHEN price_input.historical_no BETWEEN 0 AND 1
            THEN price_input.historical_no
          ELSE NULL
        END AS historical_no_mid,
        coalesce(
          price_input.current_yes_bid BETWEEN 0 AND 1
            AND price_input.current_yes_ask BETWEEN 0 AND 1
            AND price_input.current_yes_bid > price_input.current_yes_ask,
          false
        ) AS current_yes_crossed,
        coalesce(
          price_input.current_no_bid BETWEEN 0 AND 1
            AND price_input.current_no_ask BETWEEN 0 AND 1
            AND price_input.current_no_bid > price_input.current_no_ask,
          false
        ) AS current_no_crossed
      FROM price_inputs price_input
    ),
    canonical_probabilities AS MATERIALIZED (
      SELECT
        probability_mid.market_id,
        CASE
          WHEN probability_mid.current_yes_crossed
            OR probability_mid.current_no_crossed
            THEN NULL
          WHEN probability_mid.current_yes_mid IS NOT NULL
            AND probability_mid.current_no_mid IS NOT NULL
            AND abs(
              probability_mid.current_yes_mid
              - (1 - probability_mid.current_no_mid)
            ) > 0.02
            THEN NULL
          ELSE coalesce(
            probability_mid.current_yes_mid,
            1 - probability_mid.current_no_mid
          )
        END AS current_probability,
        CASE
          WHEN probability_mid.historical_yes_mid IS NOT NULL
            AND probability_mid.historical_no_mid IS NOT NULL
            AND abs(
              probability_mid.historical_yes_mid
              - (1 - probability_mid.historical_no_mid)
            ) > 0.02
            THEN NULL
          ELSE coalesce(
            probability_mid.historical_yes_mid,
            1 - probability_mid.historical_no_mid
          )
        END AS historical_probability
      FROM probability_mids probability_mid
    ),
    calculated_changes AS MATERIALIZED (
      SELECT
        canonical_probability.market_id,
        CASE
          WHEN canonical_probability.current_probability IS NULL
            OR canonical_probability.historical_probability IS NULL
            OR canonical_probability.historical_probability = 0
            THEN NULL
          ELSE (
            canonical_probability.current_probability
            - canonical_probability.historical_probability
          ) / canonical_probability.historical_probability
        END AS change_24h
      FROM canonical_probabilities canonical_probability
    ),
    deleted_market_cache AS (
      DELETE FROM unified_market_change_24h market_cache
      WHERE market_cache.calculation_version = 2
        AND market_cache.market_id = ANY(v_market_ids)
        AND NOT EXISTS (
          SELECT 1
          FROM calculated_changes calculated_change
          WHERE calculated_change.market_id = market_cache.market_id
        )
      RETURNING market_cache.market_id
    ),
    upserted_market_cache AS (
      INSERT INTO unified_market_change_24h (
        market_id,
        change_24h,
        calculation_version,
        updated_at
      )
      SELECT
        calculated_change.market_id,
        calculated_change.change_24h,
        2,
        now()
      FROM calculated_changes calculated_change
      ON CONFLICT (market_id) DO UPDATE
        SET change_24h = EXCLUDED.change_24h,
            calculation_version = EXCLUDED.calculation_version,
            updated_at = EXCLUDED.updated_at
        WHERE unified_market_change_24h.change_24h
                IS DISTINCT FROM EXCLUDED.change_24h
           OR unified_market_change_24h.calculation_version
                IS DISTINCT FROM EXCLUDED.calculation_version
      RETURNING unified_market_change_24h.market_id
    )
    SELECT
      (SELECT count(*) FROM deleted_market_cache)
      + (SELECT count(*) FROM upserted_market_cache)
    INTO v_market_written_count;
  END IF;

  WITH claimed_dirty_events AS MATERIALIZED (
    DELETE FROM unified_change24_dirty_events dirty_event
    RETURNING dirty_event.event_id
  ),
  event_time_boundaries AS MATERIALIZED (
    SELECT event_row.id AS event_id
    FROM unified_events event_row
    WHERE event_row.end_date > v_scan_from
      AND event_row.end_date <= v_scan_until
    UNION
    SELECT event_row.id AS event_id
    FROM unified_events event_row
    WHERE event_row.end_date > v_scan_from - interval '6 hours'
      AND event_row.end_date <= v_scan_until - interval '6 hours'
  ),
  invalid_cached_events AS MATERIALIZED (
    SELECT event_cache.event_id
    FROM unified_event_change_24h event_cache
    LEFT JOIN unified_events event_row
      ON event_row.id = event_cache.event_id
    WHERE event_cache.calculation_version = 2
      AND (
        event_row.id IS NULL
        OR event_row.status <> 'ACTIVE'
      )
  ),
  event_candidates AS MATERIALIZED (
    SELECT claimed_event.event_id
    FROM claimed_dirty_events claimed_event
    UNION
    SELECT boundary_event.event_id
    FROM event_time_boundaries boundary_event
    UNION
    SELECT invalid_event.event_id
    FROM invalid_cached_events invalid_event
  )
  SELECT coalesce(
    array_agg(event_candidate.event_id),
    ARRAY[]::text[]
  )
  INTO v_event_ids
  FROM event_candidates event_candidate;

  v_event_candidate_count := cardinality(v_event_ids);

  IF v_event_candidate_count > 0 THEN
    WITH active_event_changes AS MATERIALIZED (
      SELECT
        event_row.id AS event_id,
        avg(market_cache.change_24h) AS change_24h
      FROM unified_events event_row
      JOIN unified_markets market_row
        ON market_row.event_id = event_row.id
      LEFT JOIN polymarket_markets polymarket_market
        ON polymarket_market.id = market_row.venue_market_id
       AND market_row.venue = 'polymarket'
      JOIN unified_market_change_24h market_cache
        ON market_cache.market_id = market_row.id
       AND market_cache.calculation_version = 2
       AND market_cache.change_24h IS NOT NULL
      WHERE event_row.id = ANY(v_event_ids)
        AND (
          (
            market_row.status = 'ACTIVE'
            AND event_row.status = 'ACTIVE'
            AND (
              event_row.end_date IS NULL
              OR event_row.end_date > v_scan_until
            )
            AND (
              market_row.expiration_time IS NULL
              OR market_row.expiration_time > v_scan_until
            )
            AND (
              market_row.close_time IS NULL
              OR market_row.close_time > v_scan_until
            )
            AND (
              market_row.venue <> 'kalshi'
              OR lower(
                coalesce(
                  market_row.metadata->>'dflowNativeAcceptingOrders',
                  'false'
                )
              ) = 'true'
            )
          )
          OR (
            market_row.venue = 'polymarket'
            AND market_row.status = 'ACTIVE'
            AND event_row.status = 'ACTIVE'
            AND polymarket_market.id IS NOT NULL
            AND polymarket_market.accepting_orders = true
            AND coalesce(polymarket_market.active, true) = true
            AND coalesce(polymarket_market.closed, false) = false
            AND coalesce(polymarket_market.archived, false) = false
            AND least(
              coalesce(market_row.close_time, 'infinity'::timestamptz),
              coalesce(
                market_row.expiration_time,
                'infinity'::timestamptz
              ),
              coalesce(event_row.end_date, 'infinity'::timestamptz)
            ) > (v_scan_until - interval '6 hours')
            AND NOT (
              (
                event_row.end_date IS NULL
                OR event_row.end_date > v_scan_until
              )
              AND (
                market_row.expiration_time IS NULL
                OR market_row.expiration_time > v_scan_until
              )
              AND (
                market_row.close_time IS NULL
                OR market_row.close_time > v_scan_until
              )
            )
          )
        )
        AND (
          coalesce(market_row.volume_total, 0) > 0
          OR coalesce(market_row.volume_24h, 0) > 0
          OR coalesce(market_row.liquidity, 0) > 0
          OR coalesce(market_row.open_interest, 0) > 0
          OR market_row.best_bid IS NOT NULL
          OR market_row.best_ask IS NOT NULL
          OR market_row.last_price IS NOT NULL
        )
      GROUP BY event_row.id
    ),
    deleted_event_cache AS (
      DELETE FROM unified_event_change_24h event_cache
      WHERE event_cache.calculation_version = 2
        AND event_cache.event_id = ANY(v_event_ids)
        AND NOT EXISTS (
          SELECT 1
          FROM active_event_changes active_event_change
          WHERE active_event_change.event_id = event_cache.event_id
        )
      RETURNING event_cache.event_id
    ),
    upserted_event_cache AS (
      INSERT INTO unified_event_change_24h (
        event_id,
        change_24h,
        calculation_version,
        updated_at
      )
      SELECT
        active_event_change.event_id,
        active_event_change.change_24h,
        2,
        now()
      FROM active_event_changes active_event_change
      ON CONFLICT (event_id) DO UPDATE
        SET change_24h = EXCLUDED.change_24h,
            calculation_version = EXCLUDED.calculation_version,
            updated_at = EXCLUDED.updated_at
        WHERE unified_event_change_24h.change_24h
                IS DISTINCT FROM EXCLUDED.change_24h
           OR unified_event_change_24h.calculation_version
                IS DISTINCT FROM EXCLUDED.calculation_version
      RETURNING unified_event_change_24h.event_id
    )
    SELECT
      (SELECT count(*) FROM deleted_event_cache)
      + (SELECT count(*) FROM upserted_event_cache)
    INTO v_event_written_count;
  END IF;

  UPDATE unified_refresh_pipeline_state pipeline_state
  SET successful_cutoff = v_scan_until,
      updated_at = now()
  WHERE pipeline_state.pipeline_name = 'market_event_change_24h';

  RAISE LOG
    '[change24h] incremental market_candidates=% market_writes=% event_candidates=% event_writes=% scan_from=% scan_until=%',
    v_market_candidate_count,
    v_market_written_count,
    v_event_candidate_count,
    v_event_written_count,
    v_scan_from,
    v_scan_until;
END;
$$;

CREATE OR REPLACE FUNCTION refresh_unified_market_change_24h_full()
RETURNS void
LANGUAGE SQL
AS $$
  SELECT refresh_unified_market_change_24h()
$$;

CREATE OR REPLACE FUNCTION refresh_unified_event_change_24h_full()
RETURNS void
LANGUAGE SQL
AS $$
  SELECT refresh_unified_event_change_24h()
$$;

CREATE OR REPLACE FUNCTION refresh_unified_market_change_24h_job(
  job_id int,
  config jsonb
)
RETURNS void
LANGUAGE SQL
AS $$
  SELECT refresh_unified_market_event_change_24h_incremental()
$$;

CREATE OR REPLACE FUNCTION refresh_unified_market_event_change_24h_full_job(
  job_id int,
  config jsonb
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_started_at timestamptz := clock_timestamp();
  v_transaction_started_at timestamptz := transaction_timestamp();
  v_market_row_count_before bigint;
  v_market_row_count_after bigint;
  v_market_upsert_count bigint;
  v_event_row_count_before bigint;
  v_event_row_count_after bigint;
  v_event_upsert_count bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtext('hunch_refresh'),
    hashtext('unified_market_event_change_24h')
  );

  SELECT count(*)
  INTO v_market_row_count_before
  FROM unified_market_change_24h market_cache
  WHERE market_cache.calculation_version = 2;

  PERFORM refresh_unified_market_change_24h_full();

  SELECT
    count(*),
    count(*) FILTER (
      WHERE market_cache.updated_at = v_transaction_started_at
    )
  INTO v_market_row_count_after, v_market_upsert_count
  FROM unified_market_change_24h market_cache
  WHERE market_cache.calculation_version = 2;

  SELECT count(*)
  INTO v_event_row_count_before
  FROM unified_event_change_24h event_cache
  WHERE event_cache.calculation_version = 2;

  PERFORM refresh_unified_event_change_24h_full();

  SELECT
    count(*),
    count(*) FILTER (
      WHERE event_cache.updated_at = v_transaction_started_at
    )
  INTO v_event_row_count_after, v_event_upsert_count
  FROM unified_event_change_24h event_cache
  WHERE event_cache.calculation_version = 2;

  RAISE LOG
    '[change24h] full safety rebuild market_upserts=% market_row_delta=% event_upserts=% event_row_delta=% duration_ms=%',
    v_market_upsert_count,
    v_market_row_count_after - v_market_row_count_before,
    v_event_upsert_count,
    v_event_row_count_after - v_event_row_count_before,
    extract(milliseconds FROM clock_timestamp() - v_started_at);
END;
$$;

DO $$
DECLARE
  v_event_job record;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
    BEGIN
      FOR v_event_job IN
        SELECT background_job.job_id
        FROM timescaledb_information.jobs background_job
        WHERE background_job.proc_name = 'refresh_unified_event_change_24h_job'
      LOOP
        PERFORM delete_job(v_event_job.job_id);
      END LOOP;

      IF NOT EXISTS (
        SELECT 1
        FROM timescaledb_information.jobs background_job
        WHERE background_job.proc_name = 'refresh_unified_market_change_24h_job'
      ) THEN
        PERFORM add_job(
          'refresh_unified_market_change_24h_job',
          interval '10 minutes'
        );
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM timescaledb_information.jobs background_job
        WHERE background_job.proc_name =
          'refresh_unified_market_event_change_24h_full_job'
      ) THEN
        PERFORM add_job(
          'refresh_unified_market_event_change_24h_full_job',
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
