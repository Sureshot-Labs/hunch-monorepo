-- Null non-comparable Limitless AMM liquidity in unified market/event rows.
--
-- Context:
-- Limitless AMM payloads expose liquidity/liquidityFormatted, but that value is
-- not comparable to CLOB/orderbook liquidity used by other venues. Future
-- indexer writes should already suppress it; this file cleans existing unified
-- rows only.
--
-- Intentionally not touched here:
-- - limitless_events.raw / limitless_markets.raw source payloads
-- - volume_total / volume_24h
-- - open_interest
-- - activity snapshots / derived activity metrics

BEGIN;

WITH updated_markets AS (
  UPDATE unified_markets
  SET liquidity = NULL
  WHERE venue = 'limitless'
    AND COALESCE(metadata->>'tradeType', 'clob') = 'amm'
    AND liquidity IS NOT NULL
  RETURNING id
)
SELECT count(*) AS updated_limitless_amm_markets
FROM updated_markets;

WITH limitless_event_liquidity AS (
  SELECT
    e.id,
    sum(m.liquidity) AS liquidity
  FROM unified_events e
  LEFT JOIN unified_markets m
    ON m.event_id = e.id
  WHERE e.venue = 'limitless'
    AND (
      COALESCE(e.metadata->>'tradeType', 'clob') = 'amm'
      OR EXISTS (
        SELECT 1
        FROM unified_markets amm
        WHERE amm.event_id = e.id
          AND amm.venue = 'limitless'
          AND COALESCE(amm.metadata->>'tradeType', 'clob') = 'amm'
      )
    )
  GROUP BY e.id
),
updated_events AS (
  UPDATE unified_events e
  SET liquidity = lel.liquidity
  FROM limitless_event_liquidity lel
  WHERE e.id = lel.id
    AND e.liquidity IS DISTINCT FROM lel.liquidity
  RETURNING e.id
)
SELECT count(*) AS updated_limitless_events
FROM updated_events;

COMMIT;
