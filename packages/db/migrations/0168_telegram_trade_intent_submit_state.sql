ALTER TABLE IF EXISTS telegram_trade_intents
  ADD COLUMN IF NOT EXISTS submit_started_at timestamptz;

ALTER TABLE IF EXISTS telegram_trade_intents
  DROP CONSTRAINT IF EXISTS telegram_trade_intents_terminal_ref_check;

ALTER TABLE IF EXISTS telegram_trade_intents
  DROP CONSTRAINT IF EXISTS telegram_trade_intents_status_check;

ALTER TABLE IF EXISTS telegram_trade_intents
  ADD CONSTRAINT telegram_trade_intents_status_check
  CHECK (
    status IN (
      'draft',
      'previewed',
      'confirming',
      'executing',
      'submitted',
      'filled',
      'failed',
      'expired',
      'cancelled',
      'reconcile_required'
    )
  );

UPDATE telegram_trade_intents
SET status = 'reconcile_required',
    error_code = coalesce(error_code, 'submit_state_unknown'),
    error_message = coalesce(error_message, 'Trade submit state is unknown; reconcile before retrying.'),
    submitted_at = coalesce(submitted_at, updated_at, now()),
    updated_at = now()
WHERE status = 'submitted'
  AND order_id IS NULL
  AND execution_id IS NULL
  AND venue_order_id IS NULL
  AND tx_signature IS NULL;

ALTER TABLE IF EXISTS telegram_trade_intents
  ADD CONSTRAINT telegram_trade_intents_terminal_ref_check
  CHECK (
    status NOT IN ('submitted', 'filled')
    OR order_id IS NOT NULL
    OR execution_id IS NOT NULL
    OR venue_order_id IS NOT NULL
    OR tx_signature IS NOT NULL
  );

CREATE INDEX IF NOT EXISTS idx_telegram_trade_intents_reconcile_required
  ON telegram_trade_intents(updated_at)
  WHERE status = 'reconcile_required';
