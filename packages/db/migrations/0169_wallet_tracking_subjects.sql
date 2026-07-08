-- System-managed wallet intel tracking subjects.

CREATE TABLE IF NOT EXISTS wallet_tracking_subjects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id uuid NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  venue text NOT NULL CHECK (venue IN ('polymarket', 'limitless', 'kalshi')),
  source text NOT NULL CHECK (source IN ('whale', 'recent_top_holder', 'signal_candidate')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'disabled')),
  priority integer NOT NULL DEFAULT 100,
  reason text,
  metadata jsonb,
  last_selected_at timestamptz,
  last_refresh_attempted_at timestamptz,
  last_refreshed_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE (wallet_id, venue, source)
);

CREATE INDEX IF NOT EXISTS idx_wallet_tracking_subjects_active_due
  ON wallet_tracking_subjects(status, venue, priority DESC, last_refreshed_at ASC NULLS FIRST, last_refresh_attempted_at ASC NULLS FIRST, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_wallet_tracking_subjects_wallet
  ON wallet_tracking_subjects(wallet_id, venue);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.triggers
    WHERE trigger_name = 'update_wallet_tracking_subjects_updated_at'
  ) THEN
    CREATE TRIGGER update_wallet_tracking_subjects_updated_at
    BEFORE UPDATE ON wallet_tracking_subjects
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
  END IF;
END $$;
