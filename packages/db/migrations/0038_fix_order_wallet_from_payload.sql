-- Ensure Polymarket orders align wallet_address with order_payload maker.

DO $$
BEGIN
  IF to_regclass('public.orders') IS NOT NULL THEN
    UPDATE orders
    SET
      wallet_address = order_payload->>'maker',
      signer_address = CASE
        WHEN signer_address IS NULL
          AND (order_payload->>'signer') ~ '^0x[0-9a-fA-F]{40}$'
        THEN order_payload->>'signer'
        ELSE signer_address
      END
    WHERE venue = 'polymarket'
      AND order_payload ? 'maker'
      AND (order_payload->>'maker') ~ '^0x[0-9a-fA-F]{40}$'
      AND (
        wallet_address IS NULL
        OR lower(wallet_address) <> lower(order_payload->>'maker')
      );
  END IF;
END $$;
