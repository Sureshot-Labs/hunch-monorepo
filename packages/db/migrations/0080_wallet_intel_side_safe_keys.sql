-- Wallet intel side-safe storage and conflict keys.

UPDATE wallet_position_snapshots
SET outcome_side = ''
WHERE outcome_side IS NULL;

UPDATE wallet_activity_events
SET outcome_side = ''
WHERE outcome_side IS NULL;

ALTER TABLE wallet_position_snapshots
  ALTER COLUMN outcome_side SET DEFAULT '',
  ALTER COLUMN outcome_side SET NOT NULL;

ALTER TABLE wallet_activity_events
  ALTER COLUMN outcome_side SET DEFAULT '',
  ALTER COLUMN outcome_side SET NOT NULL;

ALTER TABLE wallet_position_snapshots
  DROP CONSTRAINT IF EXISTS wallet_position_snapshots_wallet_id_venue_market_id_snapshot_at_key;

ALTER TABLE wallet_position_snapshots
  DROP CONSTRAINT IF EXISTS uq_wps_wallet_venue_market_side_snapshot;

ALTER TABLE wallet_position_snapshots
  ADD CONSTRAINT uq_wps_wallet_venue_market_side_snapshot
  UNIQUE (wallet_id, venue, market_id, outcome_side, snapshot_at);

ALTER TABLE wallet_activity_events
  DROP CONSTRAINT IF EXISTS wallet_activity_events_wallet_id_venue_market_id_activity_type_occurred_at_key;

ALTER TABLE wallet_activity_events
  DROP CONSTRAINT IF EXISTS uq_wae_wallet_venue_market_side_type_occurred;

ALTER TABLE wallet_activity_events
  ADD CONSTRAINT uq_wae_wallet_venue_market_side_type_occurred
  UNIQUE (wallet_id, venue, market_id, outcome_side, activity_type, occurred_at);
