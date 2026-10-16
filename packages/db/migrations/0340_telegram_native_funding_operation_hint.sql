/* no-transaction */
-- Exact hints from the existing funding reconciliation batch, not a new job
-- queue. Bound each lookup even when legacy aliases share an operation.
create index concurrently telegram_native_funding_operation_hint_idx
  on telegram_trade_intents(funding_operation_id,id)
  where venue='hyperliquid' and delivery_mode='app_handoff'
    and funding_operation_id is not null;
