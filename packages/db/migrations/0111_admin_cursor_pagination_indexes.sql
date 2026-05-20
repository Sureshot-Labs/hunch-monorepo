-- Admin keyset pagination support.

create index if not exists idx_users_created_at_id_desc
  on users(created_at desc, id desc);

create index if not exists idx_orders_user_activity_cursor
  on orders(user_id, (coalesce(posted_at, last_update)) desc, id desc);

create index if not exists idx_executions_user_created_id_desc
  on executions(user_id, created_at desc, id desc);

create index if not exists idx_reward_claims_user_created_id_desc
  on reward_claims(user_id, created_at desc, id desc);

create index if not exists idx_analytics_server_events_user_created_id_desc
  on analytics_server_events(user_id, created_at desc, id desc)
  where user_id is not null;

create index if not exists idx_volume_events_admin_manual_user_cursor
  on volume_events(user_id, created_at desc, id desc)
  where source_id like 'manual:%'
     or source_id like 'manual-visible:%';

create index if not exists idx_volume_events_admin_manual_wallet_cursor
  on volume_events(wallet_address, created_at desc, id desc)
  where source_id like 'manual:%'
     or source_id like 'manual-visible:%';
