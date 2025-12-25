-- Add signer_address to orders for signer vs funder tracking.

DO $$
BEGIN
  IF to_regclass('public.orders') IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'orders'
        AND column_name = 'signer_address'
    ) THEN
      ALTER TABLE orders ADD COLUMN signer_address text;
    END IF;

    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_orders_signer_address ON orders(signer_address)';
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_orders_user_signer_address ON orders(user_id, signer_address)';

    UPDATE orders
    SET signer_address = wallet_address
    WHERE venue = 'polymarket'
      AND signer_address IS NULL
      AND wallet_address IS NOT NULL;

    IF to_regclass('public.user_venue_credentials') IS NOT NULL THEN
      UPDATE orders o
      SET
        wallet_address = uvc.funder_address,
        signer_address = COALESCE(o.signer_address, o.wallet_address)
      FROM user_venue_credentials uvc
      WHERE o.venue = 'polymarket'
        AND o.user_id = uvc.user_id
        AND uvc.venue = 'polymarket'
        AND uvc.is_active = true
        AND o.wallet_address = uvc.wallet_address
        AND uvc.funder_address IS NOT NULL
        AND uvc.funder_address <> ''
        AND uvc.funder_address ~ '^0x[0-9a-fA-F]{40}$';
    END IF;
  END IF;
END $$;
