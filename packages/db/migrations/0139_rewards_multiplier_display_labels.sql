ALTER TABLE rewards_multiplier_policy
  ADD COLUMN IF NOT EXISTS global_multiplier_label text;

ALTER TABLE rewards_multiplier_user_overrides
  ADD COLUMN IF NOT EXISTS label text;
