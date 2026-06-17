CREATE TABLE IF NOT EXISTS share_snapshots (
  id text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('portfolio_pnl', 'trade_pnl')),
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  referral_code text,
  snapshot jsonb NOT NULL,
  schema_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz
);
