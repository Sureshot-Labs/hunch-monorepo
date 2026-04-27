-- Track backend-observed deposit events before notifying users.

CREATE TABLE IF NOT EXISTS deposit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL,
  source_event_type text NOT NULL,
  source_idempotency_key text NOT NULL,
  privy_wallet_id text,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  wallet_address text,
  wallet_type text,
  caip2 text,
  asset jsonb,
  amount_raw text NOT NULL,
  transaction_hash text,
  sender text,
  recipient text,
  block_number text,
  status text NOT NULL DEFAULT 'recorded'
    CHECK (status IN ('recorded', 'notified', 'ignored_bridge', 'unresolved')),
  bridge_order_id uuid REFERENCES bridge_orders(id) ON DELETE SET NULL,
  notification_id uuid REFERENCES notifications(id) ON DELETE SET NULL,
  notified_at timestamptz,
  payload jsonb NOT NULL,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE (source, source_idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_deposit_events_user_created
  ON deposit_events(user_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_deposit_events_wallet
  ON deposit_events(wallet_type, wallet_address);
CREATE INDEX IF NOT EXISTS idx_deposit_events_privy_wallet
  ON deposit_events(privy_wallet_id)
  WHERE privy_wallet_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_deposit_events_tx
  ON deposit_events(transaction_hash)
  WHERE transaction_hash IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.triggers
    WHERE trigger_name = 'update_deposit_events_updated_at'
  ) THEN
    CREATE TRIGGER update_deposit_events_updated_at
    BEFORE UPDATE ON deposit_events
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
  END IF;
END $$;
