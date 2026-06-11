-- Allow Hyperliquid rows in the existing private trading tables.
-- Trading remains gated in the API by HYPERLIQUID_TRADING_ENABLED.

ALTER TABLE IF EXISTS user_venue_credentials
  DROP CONSTRAINT IF EXISTS user_venue_credentials_venue_check;
ALTER TABLE IF EXISTS user_venue_credentials
  ADD CONSTRAINT user_venue_credentials_venue_check
  CHECK (venue IN ('polymarket', 'kalshi', 'limitless', 'hyperliquid'));

ALTER TABLE IF EXISTS orders
  DROP CONSTRAINT IF EXISTS orders_venue_check;
ALTER TABLE IF EXISTS orders
  ADD CONSTRAINT orders_venue_check
  CHECK (venue IN ('polymarket', 'kalshi', 'limitless', 'hyperliquid'));

ALTER TABLE IF EXISTS orders
  DROP CONSTRAINT IF EXISTS orders_order_payload_version_check;
ALTER TABLE IF EXISTS orders
  ADD CONSTRAINT orders_order_payload_version_check
  CHECK (
    order_payload_version IS NULL OR
    order_payload_version IN (
      'polymarket_clob_v1',
      'polymarket_clob_v2',
      'hyperliquid_order_v1',
      'hyperliquid_info_v1'
    )
  );

ALTER TABLE IF EXISTS executions
  DROP CONSTRAINT IF EXISTS executions_venue_check;
ALTER TABLE IF EXISTS executions
  ADD CONSTRAINT executions_venue_check
  CHECK (venue IN ('polymarket', 'kalshi', 'limitless', 'hyperliquid'));

ALTER TABLE IF EXISTS positions
  DROP CONSTRAINT IF EXISTS positions_venue_check;
ALTER TABLE IF EXISTS positions
  ADD CONSTRAINT positions_venue_check
  CHECK (venue IN ('polymarket', 'kalshi', 'limitless', 'hyperliquid'));
