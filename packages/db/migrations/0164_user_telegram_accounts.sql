-- Persist Telegram Mini App identity separately from Privy and wallet identity.

CREATE TABLE IF NOT EXISTS user_telegram_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  privy_user_id text NOT NULL,
  telegram_user_id text NOT NULL,
  username text,
  first_name text,
  last_name text,
  photo_url text,
  linked_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_telegram_accounts_user_id
  ON user_telegram_accounts(user_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_telegram_accounts_telegram_user_id
  ON user_telegram_accounts(telegram_user_id);

CREATE INDEX IF NOT EXISTS idx_user_telegram_accounts_privy_user_id
  ON user_telegram_accounts(privy_user_id);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_proc
    WHERE proname = 'update_updated_at_column'
  ) AND NOT EXISTS (
    SELECT 1
    FROM information_schema.triggers
    WHERE trigger_name = 'update_user_telegram_accounts_updated_at'
  ) THEN
    CREATE TRIGGER update_user_telegram_accounts_updated_at
      BEFORE UPDATE ON user_telegram_accounts
      FOR EACH ROW
      EXECUTE FUNCTION update_updated_at_column();
  END IF;
END $$;
