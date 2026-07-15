-- User-controlled Telegram notification delivery with a durable outbox.

CREATE TABLE IF NOT EXISTS telegram_notification_preferences (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  order_filled boolean NOT NULL DEFAULT true,
  order_issues boolean NOT NULL DEFAULT true,
  position_resolved boolean NOT NULL DEFAULT true,
  deposit_received boolean NOT NULL DEFAULT true,
  bridge_updates boolean NOT NULL DEFAULT true,
  payouts_rewards boolean NOT NULL DEFAULT true,
  position_signals boolean NOT NULL DEFAULT true,
  order_filled_enabled_at timestamptz NOT NULL DEFAULT now(),
  order_issues_enabled_at timestamptz NOT NULL DEFAULT now(),
  position_resolved_enabled_at timestamptz NOT NULL DEFAULT now(),
  deposit_received_enabled_at timestamptz NOT NULL DEFAULT now(),
  bridge_updates_enabled_at timestamptz NOT NULL DEFAULT now(),
  payouts_rewards_enabled_at timestamptz NOT NULL DEFAULT now(),
  position_signals_enabled_at timestamptz NOT NULL DEFAULT now(),
  reachable boolean NOT NULL DEFAULT true,
  blocked_at timestamptz,
  last_started_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_telegram_notification_preferences_reachable
  ON telegram_notification_preferences(user_id)
  WHERE reachable = true;

CREATE TABLE IF NOT EXISTS telegram_notification_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_key text NOT NULL,
  topic text NOT NULL CHECK (
    topic IN (
      'order_filled',
      'order_issues',
      'position_resolved',
      'deposit_received',
      'bridge_updates',
      'payouts_rewards',
      'position_signals'
    )
  ),
  notification_id uuid REFERENCES notifications(id) ON DELETE SET NULL,
  note_id uuid REFERENCES ai_notes(id) ON DELETE SET NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
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
  UNIQUE (user_id, event_key)
);

CREATE INDEX IF NOT EXISTS idx_telegram_notification_outbox_pending
  ON telegram_notification_outbox(next_attempt_at, created_at)
  WHERE status IN ('pending', 'retry', 'sending');

CREATE INDEX IF NOT EXISTS idx_telegram_notification_outbox_user_created
  ON telegram_notification_outbox(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS telegram_notification_cursors (
  consumer_key text PRIMARY KEY,
  cursor_created_at timestamptz NOT NULL,
  cursor_id uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION ensure_telegram_notification_preferences_on_link()
RETURNS trigger AS $$
BEGIN
  INSERT INTO telegram_notification_preferences (user_id)
  VALUES (NEW.user_id)
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'ensure_telegram_notification_preferences_on_link'
      AND tgrelid = 'user_telegram_accounts'::regclass
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER ensure_telegram_notification_preferences_on_link
      AFTER INSERT OR UPDATE OF user_id ON user_telegram_accounts
      FOR EACH ROW
      EXECUTE FUNCTION ensure_telegram_notification_preferences_on_link();
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_proc
    WHERE proname = 'update_updated_at_column'
  ) AND NOT EXISTS (
    SELECT 1
    FROM information_schema.triggers
    WHERE trigger_name = 'update_telegram_notification_preferences_updated_at'
  ) THEN
    CREATE TRIGGER update_telegram_notification_preferences_updated_at
      BEFORE UPDATE ON telegram_notification_preferences
      FOR EACH ROW
      EXECUTE FUNCTION update_updated_at_column();
  END IF;
END $$;
