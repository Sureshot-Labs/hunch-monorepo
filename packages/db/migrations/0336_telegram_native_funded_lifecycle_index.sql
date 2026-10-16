/* no-transaction */
-- Immutable membership only. Expensive fact joins and watermark comparisons
-- run AFTER an indexed keyset page, with no history classification on rollout.
create index concurrently telegram_native_funded_lifecycle_page_idx
  on telegram_trade_intents(id)
  where venue='hyperliquid' and delivery_mode='app_handoff'
    and funding_operation_id is not null;
