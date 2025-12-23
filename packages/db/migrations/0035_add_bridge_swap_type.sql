-- Add swap_type to bridge_orders for cross-chain vs same-chain tracking.

ALTER TABLE bridge_orders
  ADD COLUMN IF NOT EXISTS swap_type text NOT NULL DEFAULT 'cross_chain';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'bridge_orders_swap_type_check'
  ) THEN
    ALTER TABLE bridge_orders
      ADD CONSTRAINT bridge_orders_swap_type_check
      CHECK (swap_type IN ('cross_chain', 'same_chain'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_bridge_orders_swap_type
  ON bridge_orders(swap_type);
