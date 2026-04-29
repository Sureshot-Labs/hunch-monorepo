-- Track Polymarket CLOB payload version explicitly so legacy V1 fee collection
-- cannot be mixed with CLOB V2 pUSD collection.

DO $$
BEGIN
  IF to_regclass('public.orders') IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'orders'
        AND column_name = 'order_payload_version'
    ) THEN
      ALTER TABLE orders ADD COLUMN order_payload_version text;
    END IF;

    UPDATE orders
    SET order_payload_version = 'polymarket_clob_v1'
    WHERE venue = 'polymarket'
      AND order_payload_version IS NULL
      AND order_payload IS NOT NULL
      AND order_payload ? 'feeRateBps'
      AND order_payload ? 'nonce'
      AND order_payload ? 'taker';

    UPDATE orders
    SET order_payload_version = 'polymarket_clob_v2'
    WHERE venue = 'polymarket'
      AND order_payload_version IS NULL
      AND order_payload IS NOT NULL
      AND order_payload ? 'timestamp'
      AND order_payload ? 'metadata'
      AND order_payload ? 'builder';

    IF NOT EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conname = 'orders_order_payload_version_check'
    ) THEN
      ALTER TABLE orders
        ADD CONSTRAINT orders_order_payload_version_check
        CHECK (
          order_payload_version IS NULL OR
          order_payload_version IN ('polymarket_clob_v1', 'polymarket_clob_v2')
        );
    END IF;

    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_orders_polymarket_payload_version_fee
      ON orders(order_payload_version, fee_collector_address, fee_collected_at)
      WHERE venue = ''polymarket''';
  END IF;
END $$;
