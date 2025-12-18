-- Encrypt-at-rest support for venue credentials + Polymarket funder discovery.
--
-- We intentionally keep the legacy plaintext columns for backwards compatibility,
-- but make them nullable so we can stop storing secrets in plaintext once the API is updated.

DO $$
BEGIN
  IF to_regclass('public.user_venue_credentials') IS NOT NULL THEN
    -- Encrypted fields (AES-GCM payload stored as text; app-managed).
    IF NOT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'user_venue_credentials'
        AND column_name = 'api_secret_enc'
    ) THEN
      ALTER TABLE user_venue_credentials ADD COLUMN api_secret_enc text;
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'user_venue_credentials'
        AND column_name = 'api_passphrase_enc'
    ) THEN
      ALTER TABLE user_venue_credentials ADD COLUMN api_passphrase_enc text;
    END IF;

    -- Non-secret: Polymarket funder/vault address (for Safe/proxy wallets).
    IF NOT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'user_venue_credentials'
        AND column_name = 'funder_address'
    ) THEN
      ALTER TABLE user_venue_credentials ADD COLUMN funder_address text;
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'user_venue_credentials'
        AND column_name = 'funder_updated_at'
    ) THEN
      ALTER TABLE user_venue_credentials ADD COLUMN funder_updated_at timestamptz;
    END IF;

    -- Allow future scrubbing of plaintext secrets once encrypted columns are in use.
    IF EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'user_venue_credentials'
        AND column_name = 'api_secret'
        AND is_nullable = 'NO'
    ) THEN
      ALTER TABLE user_venue_credentials ALTER COLUMN api_secret DROP NOT NULL;
    END IF;

    -- Useful index for funder-based lookups.
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_venue_creds_funder_address ON user_venue_credentials(funder_address) WHERE funder_address IS NOT NULL';
  END IF;
END $$;

