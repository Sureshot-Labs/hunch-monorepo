-- Rewards core tables (beta scope).

DO $$
BEGIN
  -- Add referral_code to users for sharing referral links.
  IF to_regclass('public.users') IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'users'
        AND column_name = 'referral_code'
    ) THEN
      ALTER TABLE users ADD COLUMN referral_code text;
    END IF;

    EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS idx_users_referral_code ON users(referral_code)';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS referrals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  referred_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'qualified', 'blocked')),
  qualified_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE (referred_user_id)
);

CREATE INDEX IF NOT EXISTS idx_referrals_referrer_user_id
  ON referrals(referrer_user_id);
CREATE INDEX IF NOT EXISTS idx_referrals_status
  ON referrals(status);

CREATE TABLE IF NOT EXISTS rewards_policy (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  effective_at timestamptz NOT NULL,
  tiers jsonb NOT NULL,
  referral_bonus jsonb NOT NULL,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rewards_policy_effective_at
  ON rewards_policy(effective_at DESC);

INSERT INTO rewards_policy (effective_at, tiers, referral_bonus)
SELECT
  now(),
  '[
    {"tier":0,"name":"Novice","points":0,"cashbackBps":0},
    {"tier":1,"name":"Observer","points":500,"cashbackBps":2500},
    {"tier":2,"name":"Seeker","points":5000,"cashbackBps":3000},
    {"tier":3,"name":"Analyst","points":30000,"cashbackBps":3500},
    {"tier":4,"name":"Forecaster","points":120000,"cashbackBps":4000},
    {"tier":5,"name":"Sage","points":350000,"cashbackBps":4500},
    {"tier":6,"name":"Ascendant","points":1000000,"cashbackBps":5000},
    {"tier":7,"name":"Oracle","points":2500000,"cashbackBps":5500}
  ]'::jsonb,
  '[
    {"minReferrals":3,"bonusBps":500},
    {"minReferrals":5,"bonusBps":1000},
    {"minReferrals":10,"bonusBps":1500},
    {"minReferrals":20,"bonusBps":2000},
    {"minReferrals":25,"bonusBps":2500}
  ]'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM rewards_policy);

CREATE TABLE IF NOT EXISTS volume_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  wallet_address text,
  venue text NOT NULL,
  source_type text NOT NULL CHECK (source_type IN ('order', 'execution')),
  source_id text NOT NULL,
  notional_usd numeric NOT NULL,
  created_at timestamptz DEFAULT now(),
  UNIQUE (user_id, source_type, source_id)
);

CREATE INDEX IF NOT EXISTS idx_volume_events_user_id
  ON volume_events(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_volume_events_venue
  ON volume_events(venue);

CREATE TABLE IF NOT EXISTS fee_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  wallet_address text,
  venue text NOT NULL,
  chain_id text,
  source_type text NOT NULL CHECK (source_type IN ('order', 'execution')),
  source_id text NOT NULL,
  fee_amount numeric NOT NULL,
  fee_asset text NOT NULL,
  fee_usd numeric NOT NULL,
  tx_hash text,
  collected_at timestamptz,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'collected', 'failed')),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE (user_id, source_type, source_id)
);

CREATE INDEX IF NOT EXISTS idx_fee_events_user_id
  ON fee_events(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_fee_events_status
  ON fee_events(status);
CREATE INDEX IF NOT EXISTS idx_fee_events_chain_id
  ON fee_events(chain_id);

CREATE TABLE IF NOT EXISTS reward_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  wallet_address text NOT NULL,
  chain_id text NOT NULL,
  amount_usdc numeric NOT NULL,
  tx_hash text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'submitted', 'confirmed', 'failed')),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reward_claims_user_id
  ON reward_claims(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_reward_claims_status
  ON reward_claims(status);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.triggers
    WHERE trigger_name = 'update_referrals_updated_at'
  ) THEN
    CREATE TRIGGER update_referrals_updated_at
    BEFORE UPDATE ON referrals
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.triggers
    WHERE trigger_name = 'update_fee_events_updated_at'
  ) THEN
    CREATE TRIGGER update_fee_events_updated_at
    BEFORE UPDATE ON fee_events
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.triggers
    WHERE trigger_name = 'update_reward_claims_updated_at'
  ) THEN
    CREATE TRIGGER update_reward_claims_updated_at
    BEFORE UPDATE ON reward_claims
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
  END IF;
END $$;
