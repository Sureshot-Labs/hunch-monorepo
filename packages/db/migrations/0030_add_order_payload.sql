-- Store full order payloads for fee collection + tracking.

DO $$
BEGIN
  IF to_regclass('public.orders') IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'orders'
        AND column_name = 'order_payload'
    ) THEN
      ALTER TABLE orders ADD COLUMN order_payload jsonb;
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'orders'
        AND column_name = 'fee_collected_at'
    ) THEN
      ALTER TABLE orders ADD COLUMN fee_collected_at timestamptz;
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'orders'
        AND column_name = 'fee_collect_tx_hash'
    ) THEN
      ALTER TABLE orders ADD COLUMN fee_collect_tx_hash text;
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'orders'
        AND column_name = 'fee_collect_error'
    ) THEN
      ALTER TABLE orders ADD COLUMN fee_collect_error text;
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'orders'
        AND column_name = 'fee_collect_attempts'
    ) THEN
      ALTER TABLE orders ADD COLUMN fee_collect_attempts integer DEFAULT 0;
    END IF;
  END IF;
END $$;
