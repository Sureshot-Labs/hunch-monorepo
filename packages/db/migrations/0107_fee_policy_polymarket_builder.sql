ALTER TABLE fee_policy
ADD COLUMN IF NOT EXISTS polymarket_builder_code text,
ADD COLUMN IF NOT EXISTS polymarket_builder_taker_fee_bps integer,
ADD COLUMN IF NOT EXISTS polymarket_builder_maker_fee_bps integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fee_policy_polymarket_builder_taker_bps_check'
  ) THEN
    ALTER TABLE fee_policy
      ADD CONSTRAINT fee_policy_polymarket_builder_taker_bps_check
      CHECK (
        polymarket_builder_taker_fee_bps IS NULL OR
        (polymarket_builder_taker_fee_bps >= 0 AND polymarket_builder_taker_fee_bps <= 100)
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fee_policy_polymarket_builder_maker_bps_check'
  ) THEN
    ALTER TABLE fee_policy
      ADD CONSTRAINT fee_policy_polymarket_builder_maker_bps_check
      CHECK (
        polymarket_builder_maker_fee_bps IS NULL OR
        (polymarket_builder_maker_fee_bps >= 0 AND polymarket_builder_maker_fee_bps <= 50)
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fee_policy_polymarket_builder_code_check'
  ) THEN
    ALTER TABLE fee_policy
      ADD CONSTRAINT fee_policy_polymarket_builder_code_check
      CHECK (
        polymarket_builder_code IS NULL OR
        polymarket_builder_code ~ '^0x[0-9a-fA-F]{64}$'
      );
  END IF;
END $$;
