-- Existing journal, indexes, formula and schedules only. No history deletion.
-- Regular latest-top table, not the Timescale raw hypertable. Statement
-- transition relations bind the journal to the actually accepted row versions,
-- including ON CONFLICT/equal timestamps and writers outside the indexers.
-- No per-market unique key: a consumer never blocks a producer's wake-up.
CREATE OR REPLACE FUNCTION enqueue_unified_change24_latest_tops_statement()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    INSERT INTO unified_change24_market_journal(market_id)
    SELECT DISTINCT mapped.market_id FROM inserted_quote_tops quote_row
    JOIN LATERAL (
      SELECT market_id FROM unified_market_tokens
      WHERE token_id=quote_row.token_id OFFSET 0
    ) mapped ON true;
  ELSIF TG_OP='UPDATE' THEN
    INSERT INTO unified_change24_market_journal(market_id)
    SELECT DISTINCT mapped.market_id
    FROM updated_quote_tops quote_row
    FULL JOIN previous_quote_tops previous_quote ON previous_quote.token_id=quote_row.token_id
    JOIN LATERAL (
      SELECT market_id FROM unified_market_tokens
      WHERE token_id=coalesce(quote_row.token_id,previous_quote.token_id) OFFSET 0
    ) mapped ON true
    WHERE quote_row.token_id IS NULL OR previous_quote.token_id IS NULL
      OR (quote_row.best_bid,quote_row.best_ask)
      IS DISTINCT FROM (previous_quote.best_bid,previous_quote.best_ask);
  ELSE
    INSERT INTO unified_change24_market_journal(market_id)
    SELECT DISTINCT mapped.market_id FROM deleted_quote_tops quote_row
    JOIN LATERAL (
      SELECT market_id FROM unified_market_tokens
      WHERE token_id=quote_row.token_id OFFSET 0
    ) mapped ON true;
  END IF;
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS enqueue_change24_quote_insert ON unified_token_top_latest;
CREATE TRIGGER enqueue_change24_quote_insert AFTER INSERT ON unified_token_top_latest
REFERENCING NEW TABLE AS inserted_quote_tops FOR EACH STATEMENT
EXECUTE FUNCTION enqueue_unified_change24_latest_tops_statement();
DROP TRIGGER IF EXISTS enqueue_change24_quote_update ON unified_token_top_latest;
CREATE TRIGGER enqueue_change24_quote_update AFTER UPDATE ON unified_token_top_latest
REFERENCING OLD TABLE AS previous_quote_tops NEW TABLE AS updated_quote_tops FOR EACH STATEMENT
EXECUTE FUNCTION enqueue_unified_change24_latest_tops_statement();
DROP TRIGGER IF EXISTS enqueue_change24_quote_delete ON unified_token_top_latest;
CREATE TRIGGER enqueue_change24_quote_delete AFTER DELETE ON unified_token_top_latest
REFERENCING OLD TABLE AS deleted_quote_tops FOR EACH STATEMENT
EXECUTE FUNCTION enqueue_unified_change24_latest_tops_statement();

-- Installed after the trigger locks are acquired: every earlier writer has
-- finished, and later accepted writes carry their own transactional journal.
-- Recovery is deferred to the ordinary job, never a data-sensitive deploy scan.
INSERT INTO unified_refresh_pipeline_state(pipeline_name,successful_cutoff,updated_at)
VALUES('change24_quote_journal_handoff',clock_timestamp(),now())
ON CONFLICT(pipeline_name) DO NOTHING;

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
  v_handoff_until timestamptz;
  v_handoff_market_ids text[] := ARRAY[]::text[];
  v_candidate_started_at timestamptz;
  v_candidate_duration_ms numeric;
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

  -- One-time cutover only: recover pre-trigger raw writes in the existing
  -- bounded catch-up window. Ordinary runs never plan or scan raw books.
  SELECT successful_cutoff INTO v_handoff_until
  FROM unified_refresh_pipeline_state
  WHERE pipeline_name='change24_quote_journal_handoff';
  IF v_handoff_until IS NOT NULL THEN
    v_stage := 'quote_journal_handoff';
    WITH recent_tokens AS MATERIALIZED (
      SELECT DISTINCT token_id FROM unified_book_top
      WHERE ts > v_scan_from AND ts <= least(v_scan_until,v_handoff_until)
    )
    SELECT coalesce(array_agg(DISTINCT market_token.market_id),ARRAY[]::text[])
    INTO v_handoff_market_ids FROM recent_tokens recent_token
    JOIN unified_market_tokens market_token ON market_token.token_id=recent_token.token_id;
  END IF;
  v_candidate_started_at := clock_timestamp();
  v_stage := 'read_market_journal';
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
  market_time_boundaries AS MATERIALIZED (
    SELECT market_row.id AS market_id FROM unified_markets market_row
    WHERE market_row.status='ACTIVE'
      AND market_row.expiration_time > v_scan_from
      AND market_row.expiration_time <= v_scan_until
    UNION
    SELECT market_row.id AS market_id FROM unified_markets market_row
    WHERE market_row.status='ACTIVE'
      AND market_row.close_time > v_scan_from
      AND market_row.close_time <= v_scan_until
  ),
  market_candidates AS MATERIALIZED (
    SELECT claimed_market.market_id
    FROM claimed_dirty_markets claimed_market
    UNION
    SELECT unnest(v_handoff_market_ids)
    UNION
    SELECT boundary_market.market_id
    FROM market_time_boundaries boundary_market
  )
  SELECT coalesce(
    array_agg(market_candidate.market_id),
    ARRAY[]::text[]
  )
  INTO v_all_market_ids
  FROM market_candidates market_candidate;

  v_candidate_duration_ms := extract(epoch FROM clock_timestamp()-v_candidate_started_at)*1000;
  v_market_candidate_count := cardinality(v_all_market_ids);
  v_stage := 'market_batches';

  FOR v_batch_start IN 1..v_market_candidate_count BY 1000 LOOP
    v_market_ids := v_all_market_ids[v_batch_start:v_batch_start + 999];
    WITH candidate_market_ids AS MATERIALIZED (
      SELECT candidate_market.market_id
      FROM unnest(v_market_ids) AS candidate_market(market_id)
    ),
    mapped_markets AS MATERIALIZED (
      SELECT market_row.id AS market_id, canonical.token_yes, canonical.token_no,
        history_yes.avg_mid_24h AS historical_yes, history_no.avg_mid_24h AS historical_no
      FROM candidate_market_ids candidate_market
      JOIN LATERAL (
        SELECT source_row.* FROM unified_markets source_row
        WHERE source_row.id=candidate_market.market_id OFFSET 0
      ) market_row ON true
      JOIN LATERAL (
        SELECT max(token_id) FILTER (WHERE outcome_side='YES') AS token_yes,
               max(token_id) FILTER (WHERE outcome_side='NO') AS token_no
        FROM (
          SELECT DISTINCT ON (market_token.outcome_side)
            market_token.outcome_side, market_token.token_id
          FROM unified_market_tokens market_token
          WHERE market_token.market_id=market_row.id
            AND market_token.outcome_side IN ('YES','NO')
          ORDER BY market_token.outcome_side,
            market_token.updated_at DESC NULLS LAST,market_token.token_id ASC
        ) selected_tokens
      ) canonical ON canonical.token_yes IS NOT NULL
      JOIN LATERAL (
        SELECT history_row.avg_mid_24h FROM unified_token_change_24h history_row
        WHERE history_row.token_id=canonical.token_yes
          AND history_row.avg_mid_24h IS NOT NULL OFFSET 0
      ) history_yes ON true
      LEFT JOIN LATERAL (
        SELECT history_row.avg_mid_24h FROM unified_token_change_24h history_row
        WHERE history_row.token_id=canonical.token_no
          AND history_row.avg_mid_24h IS NOT NULL OFFSET 0
      ) history_no ON true
      WHERE market_row.status='ACTIVE'
        AND (market_row.expiration_time IS NULL OR market_row.expiration_time>v_scan_until)
        AND (market_row.close_time IS NULL OR market_row.close_time>v_scan_until)
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
  -- Same transaction as both caches and journal acknowledgments. A failed
  -- refresh retains the handoff, and a concurrent newer marker is not erased.
  DELETE FROM unified_refresh_pipeline_state
  WHERE pipeline_name='change24_quote_journal_handoff'
    AND successful_cutoff=v_handoff_until;
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
    '[change24h] incremental market_candidates=% market_writes=% event_candidates=% event_writes=% scan_from=% scan_until=% duration_ms=% journal_market_acked=% journal_event_acked=% market_stage_ms=% oldest_queue_age_ms=% candidate_ms=% handoff_markets=%',
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
    greatest(0, extract(epoch FROM clock_timestamp() - v_oldest_enqueued_at) * 1000),
    v_candidate_duration_ms, cardinality(v_handoff_market_ids);
EXCEPTION WHEN OTHERS THEN
  RAISE LOG '[change24h] incremental failed stage=% sqlstate=% duration_ms=%',
    v_stage, SQLSTATE, extract(epoch FROM clock_timestamp() - v_started_at) * 1000;
  RAISE;
END;
$$;
