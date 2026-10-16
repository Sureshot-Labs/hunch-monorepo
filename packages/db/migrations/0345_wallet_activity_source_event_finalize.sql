-- Never remove legacy protection after an interrupted concurrent-index stage.
-- Invalid/missing indexes are an observable activity-only repair condition, not
-- a data-dependent migration exception that leaves stopped backends unavailable.
--
-- Interrupted-stage repair, only against an explicitly verified target DB:
-- 1. Inspect pg_index for to_regclass('uq_wae_legacy_event') and
--    to_regclass('uq_wae_source_event'), including indisvalid/indisready, and
--    pg_constraint for uq_wae_wallet_venue_market_side_type_occurred.
--    SELECT indexrelid::regclass, indisvalid, indisready FROM pg_index
--      WHERE indexrelid IN (to_regclass('uq_wae_legacy_event'),
--        to_regclass('uq_wae_source_event'));
--    SELECT conname FROM pg_constraint
--      WHERE conrelid = 'wallet_activity_events'::regclass
--        AND conname = 'uq_wae_wallet_venue_market_side_type_occurred';
-- 2. If the old constraint remains, native activity is disabled and its complete
--    uniqueness protection remains. Drop ONLY a confirmed invalid named index:
--      DROP INDEX CONCURRENTLY uq_wae_legacy_event
--    or DROP INDEX CONCURRENTLY uq_wae_source_event, as actually invalid.
--    If the old constraint is absent, stop for scoped integrity assessment
--    before dropping any index. Never remove the remaining unique protection.
-- 3. Rerun the exact CREATE UNIQUE INDEX CONCURRENTLY statements from 0344.
-- 4. Rerun this conditional finalizer directly, not historical migration edits.
--    HIP4_ACTIVITY_SCHEMA_READY_SQL must then return true. Current-position
--    collection remains available during this activity-only repair.
DO $wallet_activity_finalize$
BEGIN
  IF (
    SELECT count(*) = 2
    FROM pg_index activity_index
    WHERE activity_index.indexrelid IN (
      to_regclass('uq_wae_legacy_event'),
      to_regclass('uq_wae_source_event')
    )
      AND activity_index.indrelid = 'wallet_activity_events'::regclass
      AND activity_index.indisvalid
      AND activity_index.indisready
      AND activity_index.indisunique
  ) THEN
    ALTER TABLE wallet_activity_events
      DROP CONSTRAINT IF EXISTS uq_wae_wallet_venue_market_side_type_occurred;
  END IF;
END;
$wallet_activity_finalize$;
