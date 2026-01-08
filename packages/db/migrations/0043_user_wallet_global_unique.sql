-- Enforce global uniqueness for wallets (case-insensitive for EVM, case-sensitive for Solana).

DO $$
BEGIN
  IF to_regclass('public.user_wallets') IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'user_wallets'
        AND column_name = 'wallet_address_norm'
    ) THEN
      ALTER TABLE user_wallets
        ADD COLUMN wallet_address_norm text
        GENERATED ALWAYS AS (
          CASE
            WHEN wallet_type = 'solana' THEN wallet_address
            ELSE lower(wallet_address)
          END
        ) STORED;
    END IF;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_wallets_wallet_norm
  ON user_wallets(wallet_type, wallet_address_norm);
