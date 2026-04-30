-- Cache baseline sample counts so wallet summary/signals do not count raw
-- wallet_activity_events rows on each request.
ALTER TABLE wallet_activity_baseline
  ADD COLUMN IF NOT EXISTS sample_count integer;
