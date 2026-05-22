-- Optional max-use caps for campaign referral-code aliases.

ALTER TABLE referral_codes
  ADD COLUMN IF NOT EXISTS max_uses integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'referral_codes_max_uses_check'
  ) THEN
    ALTER TABLE referral_codes
      ADD CONSTRAINT referral_codes_max_uses_check
      CHECK (max_uses IS NULL OR max_uses > 0);
  END IF;
END
$$;
