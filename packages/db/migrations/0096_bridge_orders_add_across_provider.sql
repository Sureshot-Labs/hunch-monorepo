-- Allow Across as a persisted bridge provider.

ALTER TABLE bridge_orders
  DROP CONSTRAINT IF EXISTS bridge_orders_provider_check;

ALTER TABLE bridge_orders
  ADD CONSTRAINT bridge_orders_provider_check
  CHECK (provider IN ('debridge', 'bungee', 'across'));
