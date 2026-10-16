-- Known-wallet research enrollment only. This adds no holder enumeration,
-- ownership permission or financial capability. Existing values remain valid.
ALTER TABLE wallet_tracking_subjects
  DROP CONSTRAINT IF EXISTS wallet_tracking_subjects_venue_check,
  ADD CONSTRAINT wallet_tracking_subjects_venue_check
    CHECK (venue IN ('polymarket', 'limitless', 'kalshi', 'hyperliquid'));
