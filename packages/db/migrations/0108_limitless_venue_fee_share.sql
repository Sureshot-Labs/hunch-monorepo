ALTER TABLE fee_policy
DROP CONSTRAINT IF EXISTS fee_policy_venue_check;

ALTER TABLE fee_policy
ADD CONSTRAINT fee_policy_venue_check
CHECK (venue IN ('polymarket', 'kalshi', 'limitless'));

ALTER TABLE fee_policy
ADD COLUMN IF NOT EXISTS limitless_fee_share_bps integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fee_policy_limitless_fee_share_bps_check'
  ) THEN
    ALTER TABLE fee_policy
      ADD CONSTRAINT fee_policy_limitless_fee_share_bps_check
      CHECK (
        limitless_fee_share_bps IS NULL OR
        (limitless_fee_share_bps >= 0 AND limitless_fee_share_bps <= 10000)
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_venue_fee_accruals_chain_status_uncollected
  ON venue_fee_accruals(chain_id, status, filled_at, created_at)
  WHERE fee_event_id IS NULL
    AND status IN ('accrued', 'verified');

CREATE INDEX IF NOT EXISTS idx_orders_limitless_fee_candidates
  ON orders((coalesce(filled_at, last_update, posted_at)), id)
  WHERE venue = 'limitless'
    AND venue_order_id IS NOT NULL
    AND lower(status) IN ('filled', 'matched', 'mined', 'confirmed');

ALTER TABLE venue_fee_accruals
ADD COLUMN IF NOT EXISTS fee_basis text,
ADD COLUMN IF NOT EXISTS venue_fee_rate_bps integer,
ADD COLUMN IF NOT EXISTS venue_effective_fee_bps integer,
ADD COLUMN IF NOT EXISTS venue_fee_amount numeric,
ADD COLUMN IF NOT EXISTS venue_fee_amount_raw text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'venue_fee_accruals_fee_basis_check'
  ) THEN
    ALTER TABLE venue_fee_accruals
      ADD CONSTRAINT venue_fee_accruals_fee_basis_check
      CHECK (
        fee_basis IS NULL OR
        fee_basis IN ('notional', 'venue_fee_share')
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'venue_fee_accruals_venue_fee_rate_bps_check'
  ) THEN
    ALTER TABLE venue_fee_accruals
      ADD CONSTRAINT venue_fee_accruals_venue_fee_rate_bps_check
      CHECK (
        venue_fee_rate_bps IS NULL OR venue_fee_rate_bps >= 0
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'venue_fee_accruals_venue_effective_fee_bps_check'
  ) THEN
    ALTER TABLE venue_fee_accruals
      ADD CONSTRAINT venue_fee_accruals_venue_effective_fee_bps_check
      CHECK (
        venue_effective_fee_bps IS NULL OR venue_effective_fee_bps >= 0
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'venue_fee_accruals_venue_fee_amount_check'
  ) THEN
    ALTER TABLE venue_fee_accruals
      ADD CONSTRAINT venue_fee_accruals_venue_fee_amount_check
      CHECK (
        venue_fee_amount IS NULL OR venue_fee_amount >= 0
      );
  END IF;
END $$;
