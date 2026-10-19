/* no-transaction */
create index concurrently if not exists user_follows_native_push_recipients
  on user_follows(followed_user_id,follower_user_id);
create index concurrently if not exists unified_markets_native_push_created
  on unified_markets(created_at_db,id) where status='ACTIVE';
create index concurrently if not exists positions_native_push_owned
  on positions(user_id,id) where position_scope='own' and size>0 and coalesce(is_hidden,false)=false;
