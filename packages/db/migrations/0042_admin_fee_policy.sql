DO $$
BEGIN
  IF to_regclass('public.users') IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'users'
        AND column_name = 'is_admin'
    ) THEN
      ALTER TABLE users ADD COLUMN is_admin boolean DEFAULT false;
    END IF;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS fee_policy (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue text NOT NULL CHECK (venue IN ('polymarket', 'kalshi')),
  fee_bps integer NOT NULL,
  fee_scale integer,
  effective_at timestamptz NOT NULL,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fee_policy_venue_effective
  ON fee_policy(venue, effective_at DESC);
