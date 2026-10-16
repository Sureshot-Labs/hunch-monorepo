/* no-transaction */
-- Existing rows retain legacy replay semantics. Native fills use their exact
-- provider event identity and may share every legacy key, including timestamp.
ALTER TABLE wallet_activity_events
  ADD COLUMN IF NOT EXISTS source_event_key text;

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_wae_legacy_event
  ON wallet_activity_events(wallet_id, venue, market_id, outcome_side, activity_type, occurred_at)
  WHERE source_event_key IS NULL;

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_wae_source_event
  ON wallet_activity_events(wallet_id, venue, source, source_event_key)
  WHERE source_event_key IS NOT NULL;
