-- Relay destination cards already own conversion progress. Privy webhooks that
-- are proven outputs of a Relay funding operation are retained for audit but
-- must not create a second generic "Deposit received" notification.

ALTER TABLE deposit_events
  DROP CONSTRAINT IF EXISTS deposit_events_status_check;

ALTER TABLE deposit_events
  ADD CONSTRAINT deposit_events_status_check
  CHECK (status IN (
    'recorded',
    'notified',
    'ignored_bridge',
    'ignored_funding',
    'ignored_venue',
    'ignored_internal',
    'unresolved'
  ));
