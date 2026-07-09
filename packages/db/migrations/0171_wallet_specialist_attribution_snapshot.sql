SET statement_timeout = 0;

ALTER TABLE wallet_intel_selector_snapshot
  ADD COLUMN IF NOT EXISTS attribution_specialist_labels_30d text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS attribution_venue_stats_30d jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS attribution_specialist_policy_hash text,
  ADD COLUMN IF NOT EXISTS attribution_specialist_as_of timestamptz;

CREATE INDEX IF NOT EXISTS idx_wallet_intel_selector_snapshot_specialist_labels
  ON wallet_intel_selector_snapshot
  USING gin (attribution_specialist_labels_30d);

CREATE INDEX IF NOT EXISTS idx_wallet_intel_selector_snapshot_specialist_policy
  ON wallet_intel_selector_snapshot (
    attribution_specialist_policy_hash,
    attribution_specialist_as_of DESC
  );
