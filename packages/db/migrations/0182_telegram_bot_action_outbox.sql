CREATE TABLE IF NOT EXISTS telegram_bot_action_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action text NOT NULL CHECK (action IN ('welcome_menu')),
  telegram_account_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  telegram_user_id text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'sending', 'retry', 'sent', 'skipped', 'dead')
  ),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  telegram_message_id bigint,
  last_error text,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (telegram_account_id, action)
);

CREATE INDEX IF NOT EXISTS idx_telegram_bot_action_outbox_pending
  ON telegram_bot_action_outbox(next_attempt_at, created_at)
  WHERE status IN ('pending', 'retry', 'sending');

CREATE INDEX IF NOT EXISTS idx_telegram_bot_action_outbox_terminal
  ON telegram_bot_action_outbox(updated_at)
  WHERE status IN ('sent', 'skipped', 'dead');

CREATE OR REPLACE FUNCTION enqueue_telegram_welcome_menu_on_link()
RETURNS trigger AS $$
BEGIN
  INSERT INTO telegram_bot_action_outbox (
    action,
    telegram_account_id,
    user_id,
    telegram_user_id
  ) VALUES (
    'welcome_menu',
    NEW.id,
    NEW.user_id,
    NEW.telegram_user_id
  )
  ON CONFLICT (telegram_account_id, action) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'enqueue_telegram_welcome_menu_on_link'
      AND tgrelid = 'user_telegram_accounts'::regclass
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER enqueue_telegram_welcome_menu_on_link
      AFTER INSERT ON user_telegram_accounts
      FOR EACH ROW
      EXECUTE FUNCTION enqueue_telegram_welcome_menu_on_link();
  END IF;
END $$;
