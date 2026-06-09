/* no-transaction */

-- Project-wide admin analytics cursor pagination.

create index concurrently if not exists idx_analytics_server_events_created_id_desc
  on analytics_server_events(created_at desc, id desc);

create index concurrently if not exists idx_analytics_server_events_event_created_id_desc
  on analytics_server_events(event_name, created_at desc, id desc);
