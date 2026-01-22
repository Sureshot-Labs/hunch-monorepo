-- Wallet intelligence core tables.

CREATE TABLE IF NOT EXISTS wallets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  address text NOT NULL,
  chain text NOT NULL,
  label text,
  is_system_flagged boolean NOT NULL DEFAULT false,
  metadata jsonb,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE (address, chain)
);

CREATE INDEX IF NOT EXISTS idx_wallets_last_seen
  ON wallets(last_seen_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS wallet_venues (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id uuid NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  venue text NOT NULL,
  venue_account_id text,
  metadata jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE (wallet_id, venue),
  UNIQUE (venue, venue_account_id)
);

CREATE INDEX IF NOT EXISTS idx_wallet_venues_wallet
  ON wallet_venues(wallet_id);

CREATE TABLE IF NOT EXISTS wallet_follows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  wallet_id uuid NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  notifications_enabled boolean NOT NULL DEFAULT true,
  notes text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE (user_id, wallet_id)
);

CREATE INDEX IF NOT EXISTS idx_wallet_follows_user
  ON wallet_follows(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS wallet_tags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  label text NOT NULL,
  tag_type text NOT NULL CHECK (tag_type IN ('category', 'behavior', 'niche', 'performance', 'system')),
  is_system boolean NOT NULL DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS wallet_tag_map (
  wallet_id uuid NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  tag_id uuid NOT NULL REFERENCES wallet_tags(id) ON DELETE CASCADE,
  source text NOT NULL DEFAULT 'system',
  created_at timestamptz DEFAULT now(),
  UNIQUE (wallet_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_wallet_tag_map_tag
  ON wallet_tag_map(tag_id);

CREATE TABLE IF NOT EXISTS wallet_metrics_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id uuid NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  venue text,
  period text NOT NULL CHECK (period IN ('1d', '7d', '30d', 'all')),
  as_of timestamptz NOT NULL DEFAULT now(),
  trades_count integer,
  volume_usd numeric,
  pnl_usd numeric,
  roi numeric,
  win_rate numeric,
  avg_hold_hours numeric,
  last_trade_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE (wallet_id, venue, period, as_of)
);

CREATE INDEX IF NOT EXISTS idx_wallet_metrics_wallet_period
  ON wallet_metrics_snapshots(wallet_id, period, as_of DESC);

CREATE TABLE IF NOT EXISTS wallet_activity_cache (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id uuid NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  venue text NOT NULL,
  market_id text NOT NULL,
  side text,
  size_usd numeric,
  price numeric,
  metadata jsonb,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz DEFAULT now(),
  UNIQUE (wallet_id, venue, market_id, occurred_at)
);

CREATE INDEX IF NOT EXISTS idx_wallet_activity_wallet_time
  ON wallet_activity_cache(wallet_id, occurred_at DESC);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.triggers
    WHERE trigger_name = 'update_wallets_updated_at'
  ) THEN
    CREATE TRIGGER update_wallets_updated_at
    BEFORE UPDATE ON wallets
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.triggers
    WHERE trigger_name = 'update_wallet_venues_updated_at'
  ) THEN
    CREATE TRIGGER update_wallet_venues_updated_at
    BEFORE UPDATE ON wallet_venues
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.triggers
    WHERE trigger_name = 'update_wallet_follows_updated_at'
  ) THEN
    CREATE TRIGGER update_wallet_follows_updated_at
    BEFORE UPDATE ON wallet_follows
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.triggers
    WHERE trigger_name = 'update_wallet_tags_updated_at'
  ) THEN
    CREATE TRIGGER update_wallet_tags_updated_at
    BEFORE UPDATE ON wallet_tags
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.triggers
    WHERE trigger_name = 'update_wallet_metrics_snapshots_updated_at'
  ) THEN
    CREATE TRIGGER update_wallet_metrics_snapshots_updated_at
    BEFORE UPDATE ON wallet_metrics_snapshots
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
  END IF;
END $$;
