/* no-transaction */

-- Keep Telegram notification rollout fail-closed until the user explicitly
-- starts the bot and the runtime delivery policy is enabled.

ALTER TABLE telegram_notification_preferences
  ALTER COLUMN reachable SET DEFAULT false,
  ALTER COLUMN position_signals SET DEFAULT false;

UPDATE telegram_notification_preferences
SET reachable = false,
    updated_at = now()
WHERE last_started_at IS NULL
  AND reachable = true;

-- Portfolio signals are opt-in. This feature has not been released, so there
-- are no production user choices to preserve yet.
UPDATE telegram_notification_preferences
SET position_signals = false,
    position_signals_enabled_at = now(),
    updated_at = now()
WHERE position_signals = true;

ALTER TABLE telegram_notification_outbox
  ADD COLUMN IF NOT EXISTS event_occurred_at timestamptz;

UPDATE telegram_notification_outbox outbox
SET event_occurred_at = notification.created_at
FROM notifications notification
WHERE outbox.notification_id = notification.id
  AND outbox.event_occurred_at IS NULL;

UPDATE telegram_notification_outbox outbox
SET event_occurred_at = note.created_at
FROM ai_notes note
WHERE outbox.note_id = note.id
  AND outbox.event_occurred_at IS NULL;

UPDATE telegram_notification_outbox
SET event_occurred_at = created_at
WHERE event_occurred_at IS NULL;

ALTER TABLE telegram_notification_outbox
  ALTER COLUMN event_occurred_at SET DEFAULT now(),
  ALTER COLUMN event_occurred_at SET NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_notifications_created_cursor
  ON notifications(created_at ASC, id ASC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_telegram_notification_outbox_terminal_cleanup
  ON telegram_notification_outbox(updated_at ASC)
  WHERE status IN ('sent', 'skipped', 'dead');
