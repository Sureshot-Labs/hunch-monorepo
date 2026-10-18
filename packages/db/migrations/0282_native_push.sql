-- Native preferences and delivery are independent of web and Telegram settings.
create table native_notification_preferences (
  user_id uuid primary key references users(id) on delete cascade,
  revision bigint not null default 1 check (revision between 1 and 9007199254740991),
  enabled boolean not null default true,
  market_resolution boolean not null default true,
  followed_hunches boolean not null default true,
  new_markets boolean not null default true,
  big_moves boolean not null default false,
  enabled_at timestamptz not null default now(),
  market_resolution_enabled_at timestamptz not null default now(),
  followed_hunches_enabled_at timestamptz not null default now(),
  new_markets_enabled_at timestamptz not null default now(),
  big_moves_enabled_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index native_notification_subscribers on native_notification_preferences(user_id)
  where enabled;
create index native_notification_market_digest on native_notification_preferences(user_id)
  where enabled and new_markets;
create index native_notification_big_moves on native_notification_preferences(user_id)
  where enabled and big_moves;

create table native_push_devices (
  id uuid primary key,
  user_id uuid not null references users(id) on delete cascade,
  session_id uuid not null references user_sessions(id) on delete cascade,
  token text not null check (token ~ '^[0-9a-f]+$' and length(token) between 32 and 512),
  environment text not null check (environment in ('sandbox','production')),
  authorization_status text not null check (authorization_status in ('authorized','provisional','ephemeral','denied','notDetermined')),
  generation bigint not null default 1,
  active boolean not null default true,
  updated_at timestamptz not null default now(),
  unique(environment,token)
);
create index native_push_devices_owner on native_push_devices(user_id,id) where active;

create table native_push_events (
  id bigint generated always as identity primary key,
  event_key text not null unique,
  kind text not null check (kind in ('notification','followed_hunch')),
  subject_id uuid not null,
  occurred_at timestamptz not null,
  recipient_cursor uuid,
  finished boolean not null default false
);
create index native_push_events_pending on native_push_events(id) where not finished;

create table native_push_deliveries (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references native_push_devices(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  device_generation bigint not null,
  event_key text not null,
  topic text not null check (topic in ('market_resolution','followed_hunches','new_markets','big_moves')),
  occurred_at timestamptz not null,
  payload jsonb not null,
  status text not null default 'pending' check (status in ('pending','sending','sent','skipped','failed')),
  attempts integer not null default 0,
  available_at timestamptz not null default now(),
  lease_id uuid,
  lease_until timestamptz,
  error_code text,
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  unique(device_id,event_key)
);
create index native_push_delivery_pending on native_push_deliveries(available_at,id)
  where status in ('pending','sending');
create index native_push_delivery_owner on native_push_deliveries(user_id,id);
create index native_push_delivery_expiry on native_push_deliveries(occurred_at,id) where status in ('pending','sending');
create index native_push_delivery_retention on native_push_deliveries(finished_at,id) where status in ('sent','skipped','failed');
create index native_push_event_retention on native_push_events(occurred_at,id) where finished;

create table native_push_worker_cursors (
  name text primary key,
  user_id uuid,
  item_id uuid,
  cycle_started_at timestamptz not null default now(),
  available_at timestamptz not null default now()
);

create table native_push_topic_cooldowns (
  user_id uuid not null references users(id) on delete cascade,
  topic text not null,
  subject_key text not null,
  occurred_at timestamptz not null,
  primary key(user_id,topic,subject_key)
);
create index native_push_cooldown_retention on native_push_topic_cooldowns(occurred_at,user_id);

create function enqueue_native_notification() returns trigger language plpgsql as $$
begin
  if new.type = 'position_resolved' then
    insert into native_push_events(event_key,kind,subject_id,occurred_at)
      values('notification:'||new.id,'notification',new.id,new.created_at)
      on conflict(event_key) do nothing;
  end if;
  return new;
end $$;
create trigger native_notification_created after insert on notifications
  for each row execute function enqueue_native_notification();

create function enqueue_native_followed_hunch() returns trigger language plpgsql as $$
begin
  if new.author_id is not null and new.author_hidden_at is null
    and new.moderation_hidden_at is null and new.proof_invalidated_at is null then
    insert into native_push_events(event_key,kind,subject_id,occurred_at)
      values('thesis:'||new.id,'followed_hunch',new.id,new.published_at)
      on conflict(event_key) do nothing;
  end if;
  return new;
end $$;
create trigger native_followed_hunch_created after insert on user_theses
  for each row execute function enqueue_native_followed_hunch();
