-- Drop legacy wallet-intel unique constraints that may survive under
-- Postgres-truncated auto-generated names after the side-safe key migration.

ALTER TABLE wallet_position_snapshots
  DROP CONSTRAINT IF EXISTS wallet_position_snapshots_wallet_id_venue_market_id_snapshot_at_key;

ALTER TABLE wallet_position_snapshots
  DROP CONSTRAINT IF EXISTS wallet_position_snapshots_wallet_id_venue_market_id_snapsho_key;

ALTER TABLE wallet_activity_events
  DROP CONSTRAINT IF EXISTS wallet_activity_events_wallet_id_venue_market_id_activity_type_occurred_at_key;

ALTER TABLE wallet_activity_events
  DROP CONSTRAINT IF EXISTS wallet_activity_events_wallet_id_venue_market_id_activity_t_key;
