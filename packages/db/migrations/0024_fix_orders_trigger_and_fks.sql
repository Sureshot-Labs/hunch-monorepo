-- Fix orders.last_update trigger and restore order_fills/order_logs foreign keys.
-- These were previously broken/removed due to a mismatch in trigger function and
-- because orders was dropped with CASCADE.

-- Ensure orders has last_update (expected by the trigger).
DO $$
BEGIN
  IF to_regclass('public.orders') IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'orders'
        AND column_name = 'last_update'
    ) THEN
      ALTER TABLE orders ADD COLUMN last_update timestamptz DEFAULT now();
    END IF;
  END IF;
END $$;

-- Correct trigger function for orders.last_update.
CREATE OR REPLACE FUNCTION update_orders_last_update_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.last_update = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Replace trigger to use the correct function (and not update_updated_at_column()).
DO $$
BEGIN
  IF to_regclass('public.orders') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS update_orders_last_update ON orders';
    EXECUTE 'CREATE TRIGGER update_orders_last_update BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION update_orders_last_update_column()';
  END IF;
END $$;

-- Restore FK: order_fills.order_id -> orders.id (dropped when orders was dropped CASCADE).
DO $$
BEGIN
  IF to_regclass('public.order_fills') IS NOT NULL
     AND to_regclass('public.orders') IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1
      FROM information_schema.table_constraints
      WHERE table_schema = 'public'
        AND table_name = 'order_fills'
        AND constraint_type = 'FOREIGN KEY'
        AND constraint_name = 'order_fills_order_id_fkey'
    ) THEN
      ALTER TABLE order_fills
        ADD CONSTRAINT order_fills_order_id_fkey
        FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE;
    END IF;
  END IF;
END $$;

-- Restore FK: order_logs.order_id -> orders.id (dropped when orders was dropped CASCADE).
DO $$
BEGIN
  IF to_regclass('public.order_logs') IS NOT NULL
     AND to_regclass('public.orders') IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1
      FROM information_schema.table_constraints
      WHERE table_schema = 'public'
        AND table_name = 'order_logs'
        AND constraint_type = 'FOREIGN KEY'
        AND constraint_name = 'order_logs_order_id_fkey'
    ) THEN
      ALTER TABLE order_logs
        ADD CONSTRAINT order_logs_order_id_fkey
        FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE;
    END IF;
  END IF;
END $$;

