-- Add resolved outcome fields to unified markets and hide flags to positions.

ALTER TABLE unified_markets
ADD COLUMN IF NOT EXISTS resolved_outcome text,
ADD COLUMN IF NOT EXISTS resolved_outcome_pct numeric;

COMMENT ON COLUMN unified_markets.resolved_outcome IS 'Resolved outcome for binary markets (YES/NO) when available.';
COMMENT ON COLUMN unified_markets.resolved_outcome_pct IS 'Resolved YES payout percentage (0-10000 bps) for scalar outcomes.';

ALTER TABLE positions
ADD COLUMN IF NOT EXISTS is_hidden boolean NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS hidden_reason text,
ADD COLUMN IF NOT EXISTS hidden_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_positions_is_hidden ON positions(is_hidden);
