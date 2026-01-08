-- Store deBridge affiliate config overrides (optional).

CREATE TABLE IF NOT EXISTS debridge_config (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  effective_at timestamptz NOT NULL,
  dln_base text,
  stats_base text,
  affiliate_fee_percent numeric,
  affiliate_fee_recipients jsonb,
  referral_code integer,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_debridge_config_effective_at
  ON debridge_config(effective_at DESC, created_at DESC);
