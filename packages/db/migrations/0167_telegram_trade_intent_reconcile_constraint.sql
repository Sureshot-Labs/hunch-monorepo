ALTER TABLE IF EXISTS telegram_trade_intents
  DROP CONSTRAINT IF EXISTS telegram_trade_intents_terminal_ref_check;

ALTER TABLE IF EXISTS telegram_trade_intents
  ADD CONSTRAINT telegram_trade_intents_terminal_ref_check
  CHECK (
    status NOT IN ('submitted', 'filled')
    OR order_id IS NOT NULL
    OR execution_id IS NOT NULL
    OR venue_order_id IS NOT NULL
    OR tx_signature IS NOT NULL
    OR (
      status = 'submitted'
      AND error_code = 'reconcile_required'
      AND prepared_snapshot <> '{}'::jsonb
    )
  );
