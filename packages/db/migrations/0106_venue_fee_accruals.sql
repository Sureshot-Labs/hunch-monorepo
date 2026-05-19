CREATE TABLE IF NOT EXISTS venue_fee_accruals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  wallet_address text,
  signer_address text,
  venue text NOT NULL,
  fee_program text NOT NULL,
  chain_id text,
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  order_hash text NOT NULL,
  venue_order_id text,
  venue_fill_id text NOT NULL,
  venue_trade_id text,
  tx_hash text,
  log_index integer,
  token_id text,
  side text NOT NULL CHECK (side IN ('BUY', 'SELL')),
  role text NOT NULL CHECK (role IN ('maker', 'taker')),
  attribution_code text,
  fee_rate_bps integer NOT NULL CHECK (fee_rate_bps >= 0),
  notional_amount numeric NOT NULL CHECK (notional_amount >= 0),
  notional_amount_raw text NOT NULL,
  fee_amount numeric NOT NULL CHECK (fee_amount >= 0),
  fee_amount_raw text NOT NULL,
  fee_asset text NOT NULL,
  filled_at timestamptz NOT NULL,
  chain_verified_at timestamptz,
  verification_error text,
  fee_event_id uuid REFERENCES fee_events(id),
  collected_at timestamptz,
  status text NOT NULL DEFAULT 'accrued'
    CHECK (status IN ('accrued', 'verified', 'collected', 'failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue, fee_program, order_id, venue_fill_id)
);

CREATE INDEX IF NOT EXISTS idx_venue_fee_accruals_program_status_filled
  ON venue_fee_accruals(venue, fee_program, status, filled_at, created_at);

CREATE INDEX IF NOT EXISTS idx_venue_fee_accruals_tx_hash
  ON venue_fee_accruals(tx_hash)
  WHERE tx_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_venue_fee_accruals_fee_event
  ON venue_fee_accruals(fee_event_id)
  WHERE fee_event_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_venue_fee_accruals_user
  ON venue_fee_accruals(user_id, filled_at DESC);

ALTER TABLE orders
ADD COLUMN IF NOT EXISTS fee_policy_snapshot jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'update_venue_fee_accruals_updated_at'
      AND tgrelid = 'venue_fee_accruals'::regclass
  ) THEN
    CREATE TRIGGER update_venue_fee_accruals_updated_at
    BEFORE UPDATE ON venue_fee_accruals
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;
END $$;
