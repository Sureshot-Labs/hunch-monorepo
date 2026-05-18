-- Fast per-user analytics timelines for the admin panel.

create index if not exists idx_analytics_server_events_user_created_at
  on analytics_server_events(user_id, created_at desc)
  where user_id is not null;

create index if not exists idx_analytics_server_events_user_event
  on analytics_server_events(user_id, event_name, created_at desc)
  where user_id is not null;
