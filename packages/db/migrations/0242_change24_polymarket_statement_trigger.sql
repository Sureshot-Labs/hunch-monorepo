SET statement_timeout = 0;

CREATE OR REPLACE FUNCTION enqueue_unified_change24_polymarket_markets_statement()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO unified_change24_dirty_events (event_id)
    SELECT DISTINCT linked_market.event_id
    FROM inserted_polymarket_markets source_market
    JOIN LATERAL (
      SELECT market_row.event_id
      FROM unified_markets market_row
      WHERE market_row.venue = 'polymarket'
        AND market_row.venue_market_id = source_market.id
      LIMIT 1
    ) linked_market ON true
    ON CONFLICT (event_id) DO NOTHING;
  ELSIF TG_OP = 'DELETE' THEN
    INSERT INTO unified_change24_dirty_events (event_id)
    SELECT DISTINCT linked_market.event_id
    FROM deleted_polymarket_markets source_market
    JOIN LATERAL (
      SELECT market_row.event_id
      FROM unified_markets market_row
      WHERE market_row.venue = 'polymarket'
        AND market_row.venue_market_id = source_market.id
      LIMIT 1
    ) linked_market ON true
    ON CONFLICT (event_id) DO NOTHING;
  ELSE
    INSERT INTO unified_change24_dirty_events (event_id)
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
    ) linked_market ON true
    ON CONFLICT (event_id) DO NOTHING;
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS enqueue_change24_polymarket_market_insert_delete
  ON polymarket_markets;
DROP TRIGGER IF EXISTS enqueue_unified_change24_polymarket_market_update_trigger
  ON polymarket_markets;
DROP TRIGGER IF EXISTS enqueue_change24_polymarket_market_insert_trigger
  ON polymarket_markets;
DROP TRIGGER IF EXISTS enqueue_change24_polymarket_market_delete_trigger
  ON polymarket_markets;
DROP TRIGGER IF EXISTS enqueue_change24_polymarket_market_update_trigger
  ON polymarket_markets;

CREATE TRIGGER enqueue_change24_polymarket_market_insert_trigger
AFTER INSERT ON polymarket_markets
REFERENCING NEW TABLE AS inserted_polymarket_markets
FOR EACH STATEMENT
EXECUTE FUNCTION enqueue_unified_change24_polymarket_markets_statement();

CREATE TRIGGER enqueue_change24_polymarket_market_delete_trigger
AFTER DELETE ON polymarket_markets
REFERENCING OLD TABLE AS deleted_polymarket_markets
FOR EACH STATEMENT
EXECUTE FUNCTION enqueue_unified_change24_polymarket_markets_statement();

CREATE TRIGGER enqueue_change24_polymarket_market_update_trigger
AFTER UPDATE ON polymarket_markets
REFERENCING
  OLD TABLE AS previous_polymarket_markets
  NEW TABLE AS updated_polymarket_markets
FOR EACH STATEMENT
EXECUTE FUNCTION enqueue_unified_change24_polymarket_markets_statement();

DROP FUNCTION IF EXISTS enqueue_unified_change24_polymarket_market();
