-- Add executions table for venue-specific execution tracking (DFlow + Polymarket).

CREATE TABLE IF NOT EXISTS executions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  wallet_address text,
  venue text NOT NULL CHECK (venue IN ('polymarket', 'kalshi', 'limitless')),
  unified_market_id text,
  side text CHECK (side IN ('BUY', 'SELL')),
  outcome text,
  input_mint text,
  output_mint text,
  amount_in numeric,
  amount_out numeric,
  quote_id text,
  tx_signature text,
  venue_order_id text,
  status text,
  raw jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(user_id, wallet_address, venue, tx_signature)
);

CREATE INDEX IF NOT EXISTS idx_executions_user_wallet
  ON executions(user_id, wallet_address);
CREATE INDEX IF NOT EXISTS idx_executions_market
  ON executions(unified_market_id);
