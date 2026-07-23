create table if not exists user_asset_funding_preferences (
  user_id uuid not null references users(id) on delete cascade,
  component_id text not null,
  network_id text not null,
  asset_id text not null,
  location_id text not null,
  suggestion_preference text not null
    check (suggestion_preference in ('ask', 'suggest', 'never_suggest')),
  revision bigint not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, component_id)
);

create index if not exists idx_user_asset_funding_preferences_selector
  on user_asset_funding_preferences (
    user_id,
    network_id,
    asset_id,
    location_id
  );

