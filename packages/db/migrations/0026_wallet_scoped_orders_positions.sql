-- Add wallet scoping for orders + positions.
-- This is required because auth is wallet-aware (`X-HUNCH-WALLET`) and users can link multiple wallets.

DO $$
BEGIN
  -- Orders: add wallet_address column (nullable for backwards compatibility).
  IF to_regclass('public.orders') IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'orders'
        AND column_name = 'wallet_address'
    ) THEN
      ALTER TABLE orders ADD COLUMN wallet_address text;
    END IF;

    -- Helpful indexes for wallet-scoped reads.
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_orders_wallet_address ON orders(wallet_address)';
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_orders_user_wallet_address ON orders(user_id, wallet_address)';
  END IF;

  -- Positions: add wallet_address column and update uniqueness to include it.
  IF to_regclass('public.positions') IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'positions'
        AND column_name = 'wallet_address'
    ) THEN
      ALTER TABLE positions ADD COLUMN wallet_address text;
    END IF;

    -- Drop the old user-scoped uniqueness (user_id, venue, token_id).
    IF EXISTS (
      SELECT 1
      FROM information_schema.table_constraints
      WHERE table_schema = 'public'
        AND table_name = 'positions'
        AND constraint_name = 'positions_user_id_venue_token_id_key'
    ) THEN
      ALTER TABLE positions DROP CONSTRAINT positions_user_id_venue_token_id_key;
    END IF;

    -- New wallet-scoped uniqueness.
    -- `NULLS NOT DISTINCT` preserves previous behavior for legacy rows while we backfill/update writers.
    IF NOT EXISTS (
      SELECT 1
      FROM information_schema.table_constraints
      WHERE table_schema = 'public'
        AND table_name = 'positions'
        AND constraint_name = 'positions_user_id_wallet_address_venue_token_id_key'
    ) THEN
      ALTER TABLE positions
        ADD CONSTRAINT positions_user_id_wallet_address_venue_token_id_key
        UNIQUE NULLS NOT DISTINCT (user_id, wallet_address, venue, token_id);
    END IF;
  END IF;
END $$;

