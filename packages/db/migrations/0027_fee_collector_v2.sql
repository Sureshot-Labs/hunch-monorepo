-- Fee collector v2 support for orders (Polymarket).

DO $$
BEGIN
  IF to_regclass('public.orders') IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'orders'
        AND column_name = 'order_hash'
    ) THEN
      ALTER TABLE orders ADD COLUMN order_hash text;
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'orders'
        AND column_name = 'fee_bps'
    ) THEN
      ALTER TABLE orders ADD COLUMN fee_bps integer;
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'orders'
        AND column_name = 'fee_auth'
    ) THEN
      ALTER TABLE orders ADD COLUMN fee_auth jsonb;
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'orders'
        AND column_name = 'fee_auth_sig'
    ) THEN
      ALTER TABLE orders ADD COLUMN fee_auth_sig text;
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'orders'
        AND column_name = 'fee_collector_address'
    ) THEN
      ALTER TABLE orders ADD COLUMN fee_collector_address text;
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'orders'
        AND column_name = 'fee_deadline'
    ) THEN
      ALTER TABLE orders ADD COLUMN fee_deadline bigint;
    END IF;

    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_orders_order_hash ON orders(order_hash)';
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_orders_fee_auth_sig ON orders(fee_auth_sig)';
  END IF;
END $$;
