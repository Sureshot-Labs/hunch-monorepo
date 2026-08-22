ALTER TABLE unified_market_change_24h
  ADD COLUMN IF NOT EXISTS calculation_version smallint NOT NULL DEFAULT 1;

ALTER TABLE unified_event_change_24h
  ADD COLUMN IF NOT EXISTS calculation_version smallint NOT NULL DEFAULT 1;

CREATE OR REPLACE FUNCTION refresh_unified_market_change_24h()
RETURNS void
LANGUAGE SQL
AS $$
  WITH history_candidates AS MATERIALIZED (
    SELECT
      market_token.market_id,
      market_token.token_id AS token_yes,
      history.avg_mid_24h AS historical_yes
    FROM unified_token_change_24h history
    JOIN unified_market_tokens market_token
      ON market_token.token_id = history.token_id
     AND market_token.outcome_side = 'YES'
    WHERE history.avg_mid_24h IS NOT NULL
  ),
  canonical_yes_tokens AS MATERIALIZED (
    SELECT
      history_candidate.market_id,
      history_candidate.token_yes,
      history_candidate.historical_yes
    FROM history_candidates history_candidate
    JOIN LATERAL (
      SELECT market_token.token_id
      FROM unified_market_tokens market_token
      WHERE market_token.market_id = history_candidate.market_id
        AND market_token.outcome_side = 'YES'
      ORDER BY market_token.updated_at DESC NULLS LAST, market_token.token_id ASC
      LIMIT 1
    ) canonical_yes ON canonical_yes.token_id = history_candidate.token_yes
    JOIN unified_markets market
      ON market.id = history_candidate.market_id
    WHERE market.status = 'ACTIVE'
      AND (market.expiration_time IS NULL OR market.expiration_time > now())
      AND (market.close_time IS NULL OR market.close_time > now())
  ),
  mapped_markets AS MATERIALIZED (
    SELECT
      yes_token.market_id,
      yes_token.token_yes,
      no_token.token_id AS token_no,
      yes_token.historical_yes,
      history_no.avg_mid_24h AS historical_no
    FROM canonical_yes_tokens yes_token
    LEFT JOIN LATERAL (
      SELECT market_token.token_id
      FROM unified_market_tokens market_token
      WHERE market_token.market_id = yes_token.market_id
        AND market_token.outcome_side = 'NO'
      ORDER BY market_token.updated_at DESC NULLS LAST, market_token.token_id ASC
      LIMIT 1
    ) no_token ON true
    LEFT JOIN unified_token_change_24h history_no
      ON history_no.token_id = no_token.token_id
     AND history_no.avg_mid_24h IS NOT NULL
  ),
  price_inputs AS MATERIALIZED (
    SELECT
      mapped.market_id,
      current_yes_top.best_bid AS current_yes_bid,
      current_yes_top.best_ask AS current_yes_ask,
      current_no_top.best_bid AS current_no_bid,
      current_no_top.best_ask AS current_no_ask,
      mapped.historical_yes,
      mapped.historical_no
    FROM mapped_markets mapped
    LEFT JOIN unified_token_top_latest current_yes_top
      ON current_yes_top.token_id = mapped.token_yes
    LEFT JOIN unified_token_top_latest current_no_top
      ON current_no_top.token_id = mapped.token_no
  ),
  probability_mids AS MATERIALIZED (
    SELECT
      price_input.market_id,
      CASE
        WHEN price_input.current_yes_bid BETWEEN 0 AND 1
          AND price_input.current_yes_ask BETWEEN 0 AND 1
          AND price_input.current_yes_bid <= price_input.current_yes_ask
          THEN (price_input.current_yes_bid + price_input.current_yes_ask) / 2
        ELSE NULL
      END AS current_yes_mid,
      CASE
        WHEN price_input.current_no_bid BETWEEN 0 AND 1
          AND price_input.current_no_ask BETWEEN 0 AND 1
          AND price_input.current_no_bid <= price_input.current_no_ask
          THEN (price_input.current_no_bid + price_input.current_no_ask) / 2
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
  deleted AS (
    DELETE FROM unified_market_change_24h cached_change
    WHERE cached_change.calculation_version = 2
      AND NOT EXISTS (
        SELECT 1
        FROM calculated_changes calculated_change
        WHERE calculated_change.market_id = cached_change.market_id
      )
    RETURNING 1
  )
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
    WHERE unified_market_change_24h.change_24h IS DISTINCT FROM EXCLUDED.change_24h
       OR unified_market_change_24h.calculation_version IS DISTINCT FROM EXCLUDED.calculation_version
$$;

CREATE OR REPLACE FUNCTION refresh_unified_event_change_24h()
RETURNS void
LANGUAGE SQL
AS $$
  WITH active_event_changes AS MATERIALIZED (
    SELECT
      event_row.id AS event_id,
      avg(market_change.change_24h) AS change_24h
    FROM unified_events event_row
    JOIN unified_markets market
      ON market.event_id = event_row.id
    LEFT JOIN polymarket_markets polymarket_market
      ON polymarket_market.id = market.venue_market_id
     AND market.venue = 'polymarket'
    JOIN unified_market_change_24h market_change
      ON market_change.market_id = market.id
     AND market_change.calculation_version = 2
     AND market_change.change_24h IS NOT NULL
    WHERE (
        (
          market.status = 'ACTIVE'
          AND event_row.status = 'ACTIVE'
          AND (event_row.end_date IS NULL OR event_row.end_date > now())
          AND (market.expiration_time IS NULL OR market.expiration_time > now())
          AND (market.close_time IS NULL OR market.close_time > now())
          AND (
            market.venue <> 'kalshi'
            OR lower(
              coalesce(
                market.metadata->>'dflowNativeAcceptingOrders',
                'false'
              )
            ) = 'true'
          )
        )
        OR (
          market.venue = 'polymarket'
          AND market.status = 'ACTIVE'
          AND event_row.status = 'ACTIVE'
          AND polymarket_market.id IS NOT NULL
          AND polymarket_market.accepting_orders = true
          AND coalesce(polymarket_market.active, true) = true
          AND coalesce(polymarket_market.closed, false) = false
          AND coalesce(polymarket_market.archived, false) = false
          AND least(
            coalesce(market.close_time, 'infinity'::timestamptz),
            coalesce(market.expiration_time, 'infinity'::timestamptz),
            coalesce(event_row.end_date, 'infinity'::timestamptz)
          ) > (now() - interval '6 hours')
          AND NOT (
            (event_row.end_date IS NULL OR event_row.end_date > now())
            AND (market.expiration_time IS NULL OR market.expiration_time > now())
            AND (market.close_time IS NULL OR market.close_time > now())
          )
        )
      )
      AND (
        coalesce(market.volume_total, 0) > 0
        OR coalesce(market.volume_24h, 0) > 0
        OR coalesce(market.liquidity, 0) > 0
        OR coalesce(market.open_interest, 0) > 0
        OR market.best_bid IS NOT NULL
        OR market.best_ask IS NOT NULL
        OR market.last_price IS NOT NULL
      )
    GROUP BY event_row.id
  ),
  deleted AS (
    DELETE FROM unified_event_change_24h cached_change
    WHERE cached_change.calculation_version = 2
      AND NOT EXISTS (
        SELECT 1
        FROM active_event_changes active_event_change
        WHERE active_event_change.event_id = cached_change.event_id
      )
    RETURNING 1
  )
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
    WHERE unified_event_change_24h.change_24h IS DISTINCT FROM EXCLUDED.change_24h
       OR unified_event_change_24h.calculation_version IS DISTINCT FROM EXCLUDED.calculation_version
$$;
