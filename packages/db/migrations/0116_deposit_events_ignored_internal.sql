-- Deposit webhooks can report same-user wallet movements.
-- Keep the audit row, but do not notify users as if new funds arrived.

ALTER TABLE deposit_events
  DROP CONSTRAINT IF EXISTS deposit_events_status_check;

ALTER TABLE deposit_events
  ADD CONSTRAINT deposit_events_status_check
  CHECK (status IN (
    'recorded',
    'notified',
    'ignored_bridge',
    'ignored_venue',
    'ignored_internal',
    'unresolved'
  ));
