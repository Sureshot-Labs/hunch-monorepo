/* no-transaction */
-- An admitted order remains the exact factual identity after the short-lived
-- handoff token is deleted or its owner is merged. No new financial authority.
drop index concurrently if exists telegram_native_order_lifecycle_idx;
create index concurrently telegram_native_order_lifecycle_idx
  on telegram_trade_intents(order_id)
  where venue='hyperliquid' and delivery_mode='app_handoff' and order_id is not null;
