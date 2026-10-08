/* no-transaction */
create index concurrently if not exists orders_verified_buy_due_idx
  on orders (verified_buy_due_at, id) where verified_buy_due_at is not null;
create index concurrently if not exists executions_verified_buy_due_idx
  on executions (verified_buy_due_at, id) where verified_buy_due_at is not null;
create index concurrently if not exists orders_social_copy_hash_idx
  on orders (user_id,lower(order_hash)) where venue='polymarket';
create index concurrently if not exists orders_social_copy_client_idx
  on orders (user_id,(coalesce(order_payload->>'clientOrderId',order_payload->'submitted'->>'clientOrderId',order_payload->'_hunchSubmitted'->>'clientOrderId')))
  where venue='limitless';
create index concurrently if not exists copy_attributions_repair_due_idx
  on copy_attributions(repair_due_at,id) where copier_user_id is not null and order_id is null and execution_id is null;
