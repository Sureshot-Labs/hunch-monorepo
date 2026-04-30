-- Deposit webhooks can also report venue-generated cash movements
-- (for example sell proceeds). Keep the event, but do not notify users.

ALTER TABLE deposit_events
  DROP CONSTRAINT IF EXISTS deposit_events_status_check;

ALTER TABLE deposit_events
  ADD CONSTRAINT deposit_events_status_check
  CHECK (status IN (
    'recorded',
    'notified',
    'ignored_bridge',
    'ignored_venue',
    'unresolved'
  ));
