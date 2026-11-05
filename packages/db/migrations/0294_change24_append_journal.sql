-- Append-only wake-ups avoid unique-key waits behind a long cache refresh.
-- Additive handoff: old queues remain readable; no market/history rows removed.
CREATE TABLE IF NOT EXISTS limitless_resolution_publications (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  market_id text NOT NULL,
  payload jsonb NOT NULL,
  enqueued_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
COMMENT ON TABLE limitless_resolution_publications IS 'Durable terminal market Redis publications. Exact IDs are acknowledged only after successful publication.';
CREATE TABLE IF NOT EXISTS unified_change24_market_journal (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  market_id text NOT NULL,
  enqueued_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS unified_change24_event_journal (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id text NOT NULL,
  enqueued_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
COMMENT ON TABLE unified_change24_market_journal IS 'Append-only change24h wake-ups, acknowledged by exact record ID after cache commit.';
COMMENT ON TABLE unified_change24_event_journal IS 'Append-only change24h event wake-ups, acknowledged by exact record ID after cache commit.';

CREATE OR REPLACE FUNCTION enqueue_unified_change24_market(
  p_market_id text
)
RETURNS void
LANGUAGE SQL
AS $$
  INSERT INTO unified_change24_market_journal (market_id)
  SELECT p_market_id
  WHERE p_market_id IS NOT NULL
$$;

CREATE OR REPLACE FUNCTION enqueue_unified_change24_event(
  p_event_id text
)
RETURNS void
LANGUAGE SQL
AS $$
  INSERT INTO unified_change24_event_journal (event_id)
  SELECT p_event_id
  WHERE p_event_id IS NOT NULL
$$;

CREATE OR REPLACE FUNCTION enqueue_unified_change24_market_tokens_statement()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO unified_change24_market_journal (market_id)
    SELECT DISTINCT inserted_token.market_id
    FROM inserted_market_tokens inserted_token;
  ELSIF TG_OP = 'DELETE' THEN
    INSERT INTO unified_change24_market_journal (market_id)
    SELECT DISTINCT deleted_token.market_id
    FROM deleted_market_tokens deleted_token;
  ELSE
    INSERT INTO unified_change24_market_journal (market_id)
    SELECT previous_token.market_id
    FROM previous_market_tokens previous_token
    UNION
    SELECT updated_token.market_id
    FROM updated_market_tokens updated_token;
  END IF;

  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION enqueue_unified_change24_token_history_statement()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO unified_change24_market_journal (market_id)
    SELECT DISTINCT market_token.market_id
    FROM inserted_token_history inserted_history
    JOIN unified_market_tokens market_token
      ON market_token.token_id = inserted_history.token_id;
  ELSIF TG_OP = 'DELETE' THEN
    INSERT INTO unified_change24_market_journal (market_id)
    SELECT DISTINCT market_token.market_id
    FROM deleted_token_history deleted_history
    JOIN unified_market_tokens market_token
      ON market_token.token_id = deleted_history.token_id;
  ELSE
    INSERT INTO unified_change24_market_journal (market_id)
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
      ON market_token.token_id = changed_token.token_id;
  END IF;

  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION enqueue_unified_change24_polymarket_markets_statement()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO unified_change24_event_journal (event_id)
    SELECT DISTINCT linked_market.event_id
    FROM inserted_polymarket_markets source_market
    JOIN LATERAL (
      SELECT market_row.event_id
      FROM unified_markets market_row
      WHERE market_row.venue = 'polymarket'
        AND market_row.venue_market_id = source_market.id
      LIMIT 1
    ) linked_market ON true;
  ELSIF TG_OP = 'DELETE' THEN
    INSERT INTO unified_change24_event_journal (event_id)
    SELECT DISTINCT linked_market.event_id
    FROM deleted_polymarket_markets source_market
    JOIN LATERAL (
      SELECT market_row.event_id
      FROM unified_markets market_row
      WHERE market_row.venue = 'polymarket'
        AND market_row.venue_market_id = source_market.id
      LIMIT 1
    ) linked_market ON true;
  ELSE
    INSERT INTO unified_change24_event_journal (event_id)
    WITH changed_source_market_ids AS MATERIALIZED (
      SELECT changed_source_market.id
      FROM (
        (
          SELECT
            previous_source_market.id,
            previous_source_market.accepting_orders,
            previous_source_market.active,
            previous_source_market.closed,
            previous_source_market.archived
          FROM previous_polymarket_markets previous_source_market
          EXCEPT
          SELECT
            updated_source_market.id,
            updated_source_market.accepting_orders,
            updated_source_market.active,
            updated_source_market.closed,
            updated_source_market.archived
          FROM updated_polymarket_markets updated_source_market
        )
        UNION
        (
          SELECT
            updated_source_market.id,
            updated_source_market.accepting_orders,
            updated_source_market.active,
            updated_source_market.closed,
            updated_source_market.archived
          FROM updated_polymarket_markets updated_source_market
          EXCEPT
          SELECT
            previous_source_market.id,
            previous_source_market.accepting_orders,
            previous_source_market.active,
            previous_source_market.closed,
            previous_source_market.archived
          FROM previous_polymarket_markets previous_source_market
        )
      ) changed_source_market
    )
    SELECT DISTINCT linked_market.event_id
    FROM changed_source_market_ids source_market
    JOIN LATERAL (
      SELECT market_row.event_id
      FROM unified_markets market_row
      WHERE market_row.venue = 'polymarket'
        AND market_row.venue_market_id = source_market.id
      LIMIT 1
    ) linked_market ON true;
  END IF;

  RETURN NULL;
END;
$$;


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

  INSERT INTO unified_change24_event_journal (event_id)
  SELECT market_row.event_id
  FROM unified_markets market_row
  WHERE market_row.id = v_market_id;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  RETURN NEW;
END;
$$;

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
  v_all_market_ids text[] := ARRAY[]::text[];
  v_market_record_ids bigint[];
  v_event_record_ids bigint[];
  v_record_page bigint[];
  v_journal_highwater bigint;
  v_after_record_id bigint;
  v_legacy_market_ids text[];
  v_legacy_event_ids text[];
  v_batch_start integer;
  v_batch_writes bigint;
  v_started_at timestamptz := clock_timestamp();
  v_stage text := 'read_market_journal';
  v_oldest_enqueued_at timestamptz;
  v_market_stage_finished_at timestamptz;
  v_event_ids text[] := ARRAY[]::text[];
  v_all_event_ids text[] := ARRAY[]::text[];
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

  -- Read identities without row locks. Producers append independent records;
  -- ack only these identities after both cache stages succeed.
  -- Fix a high-water ID, but capture/ack exact visible records. A transaction
  -- committing an earlier sequence ID later is left for the next invocation.
  SELECT coalesce(max(id),0) INTO v_journal_highwater FROM unified_change24_market_journal;
  v_after_record_id := 0;
  v_market_record_ids := ARRAY[]::bigint[];
  LOOP
    SELECT coalesce(array_agg(queue_row.id ORDER BY queue_row.id),ARRAY[]::bigint[])
    INTO v_record_page FROM (
      SELECT id FROM unified_change24_market_journal
      WHERE id > v_after_record_id AND id <= v_journal_highwater ORDER BY id LIMIT 10000
    ) queue_row;
    EXIT WHEN cardinality(v_record_page) = 0;
    v_market_record_ids := v_market_record_ids || v_record_page;
    v_after_record_id := v_record_page[cardinality(v_record_page)];
  END LOOP;
  SELECT coalesce(array_agg(market_id), ARRAY[]::text[])
  INTO v_legacy_market_ids FROM unified_change24_dirty_markets;

  WITH claimed_dirty_markets AS MATERIALIZED (
    SELECT market_id FROM unified_change24_market_journal
    WHERE id = ANY(v_market_record_ids)
    UNION SELECT unnest(v_legacy_market_ids)
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
  INTO v_all_market_ids
  FROM market_candidates market_candidate;

  v_market_candidate_count := cardinality(v_all_market_ids);
  v_stage := 'market_batches';

  FOR v_batch_start IN 1..v_market_candidate_count BY 1000 LOOP
    v_market_ids := v_all_market_ids[v_batch_start:v_batch_start + 999];
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
      JOIN LATERAL (
        SELECT source_row.* FROM unified_markets source_row
        WHERE source_row.id = candidate_market.market_id OFFSET 0
      ) market_row ON true
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
      JOIN LATERAL (
        SELECT history_row.avg_mid_24h FROM unified_token_change_24h history_row
        WHERE history_row.token_id = canonical_yes.token_id
          AND history_row.avg_mid_24h IS NOT NULL OFFSET 0
      ) history_yes ON true
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
      LEFT JOIN LATERAL (
        SELECT latest_row.best_bid, latest_row.best_ask
        FROM unified_token_top_latest latest_row
        WHERE latest_row.token_id = mapped_market.token_yes OFFSET 0
      ) current_yes ON true
      LEFT JOIN LATERAL (
        SELECT latest_row.best_bid, latest_row.best_ask
        FROM unified_token_top_latest latest_row
        WHERE latest_row.token_id = mapped_market.token_no OFFSET 0
      ) current_no ON true
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
    INTO v_batch_writes;
    v_market_written_count := v_market_written_count + v_batch_writes;
  END LOOP;

  v_market_stage_finished_at := clock_timestamp();
  v_stage := 'read_event_journal';
  -- Fix a high-water ID, but capture/ack exact visible records. A transaction
  -- committing an earlier sequence ID later is left for the next invocation.
  SELECT coalesce(max(id),0) INTO v_journal_highwater FROM unified_change24_event_journal;
  v_after_record_id := 0;
  v_event_record_ids := ARRAY[]::bigint[];
  LOOP
    SELECT coalesce(array_agg(queue_row.id ORDER BY queue_row.id),ARRAY[]::bigint[])
    INTO v_record_page FROM (
      SELECT id FROM unified_change24_event_journal
      WHERE id > v_after_record_id AND id <= v_journal_highwater ORDER BY id LIMIT 10000
    ) queue_row;
    EXIT WHEN cardinality(v_record_page) = 0;
    v_event_record_ids := v_event_record_ids || v_record_page;
    v_after_record_id := v_record_page[cardinality(v_record_page)];
  END LOOP;
  SELECT coalesce(array_agg(event_id), ARRAY[]::text[])
  INTO v_legacy_event_ids FROM unified_change24_dirty_events;

  WITH claimed_dirty_events AS MATERIALIZED (
    SELECT event_id FROM unified_change24_event_journal
    WHERE id = ANY(v_event_record_ids)
    UNION SELECT unnest(v_legacy_event_ids)
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
  INTO v_all_event_ids
  FROM event_candidates event_candidate;

  v_event_candidate_count := cardinality(v_all_event_ids);
  v_stage := 'event_batches';

  FOR v_batch_start IN 1..v_event_candidate_count BY 1000 LOOP
    v_event_ids := v_all_event_ids[v_batch_start:v_batch_start + 999];
    WITH active_event_changes AS MATERIALIZED (
      SELECT
        event_row.id AS event_id,
        avg(market_cache.change_24h) AS change_24h
      FROM unnest(v_event_ids) AS candidate_event(event_id)
      JOIN LATERAL (
        SELECT source_event.* FROM unified_events source_event
        WHERE source_event.id = candidate_event.event_id OFFSET 0
      ) event_row ON true
      JOIN LATERAL (
        SELECT source_market.* FROM unified_markets source_market
        WHERE source_market.event_id = event_row.id OFFSET 0
      ) market_row ON true
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
    INTO v_batch_writes;
    v_event_written_count := v_event_written_count + v_batch_writes;
  END LOOP;

  v_stage := 'ack';
  SELECT min(queue_row.enqueued_at) INTO v_oldest_enqueued_at FROM (
    SELECT enqueued_at FROM unified_change24_market_journal WHERE id = ANY(v_market_record_ids)
    UNION ALL
    SELECT enqueued_at FROM unified_change24_event_journal WHERE id = ANY(v_event_record_ids)
  ) queue_row;
  DELETE FROM unified_change24_market_journal WHERE id = ANY(v_market_record_ids);
  DELETE FROM unified_change24_event_journal WHERE id = ANY(v_event_record_ids);
  -- Legacy queues are retained for compatibility, but no current producer writes
  -- them after this migration. Drain only keys observed by this successful run.
  DELETE FROM unified_change24_dirty_markets WHERE market_id = ANY(v_legacy_market_ids);
  DELETE FROM unified_change24_dirty_events WHERE event_id = ANY(v_legacy_event_ids);

  UPDATE unified_refresh_pipeline_state pipeline_state
  SET successful_cutoff = v_scan_until,
      updated_at = now()
  WHERE pipeline_state.pipeline_name = 'market_event_change_24h';

  RAISE LOG
    '[change24h] incremental market_candidates=% market_writes=% event_candidates=% event_writes=% scan_from=% scan_until=% duration_ms=% journal_market_acked=% journal_event_acked=% market_stage_ms=% oldest_queue_age_ms=%',
    v_market_candidate_count,
    v_market_written_count,
    v_event_candidate_count,
    v_event_written_count,
    v_scan_from,
    v_scan_until,
    extract(epoch FROM clock_timestamp() - v_started_at) * 1000,
    cardinality(v_market_record_ids),
    cardinality(v_event_record_ids),
    extract(epoch FROM v_market_stage_finished_at - v_started_at) * 1000,
    greatest(0, extract(epoch FROM clock_timestamp() - v_oldest_enqueued_at) * 1000);
EXCEPTION WHEN OTHERS THEN
  RAISE LOG '[change24h] incremental failed stage=% sqlstate=% duration_ms=%',
    v_stage, SQLSTATE, extract(epoch FROM clock_timestamp() - v_started_at) * 1000;
  RAISE;
END;
$$;
