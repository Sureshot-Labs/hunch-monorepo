-- WP5 expiring Intent Liquidity discovery snapshots.
--
-- A projection is owned discovery state, not financial evidence. It is
-- immutable, expires quickly, and is removed with the owning account. Quotes
-- freeze the selected source and all executable facts independently.

create table funding_liquidity_projections (
  id text primary key,
  user_id uuid not null references users(id) on delete cascade,
  request_snapshot jsonb not null,
  projection_snapshot jsonb not null,
  planner_snapshot jsonb not null,
  policy_version bigint not null check (policy_version > 0),
  policy_revision text not null,
  ownership_revision text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint funding_liquidity_projections_user_id_id_unique
    unique (user_id, id),
  constraint funding_liquidity_projections_id_check
    check (
      id ~ '^projection_[0-9a-f-]{36}$'
      and length(id) between 40 and 96
    ),
  constraint funding_liquidity_projections_snapshots_check
    check (
      jsonb_typeof(request_snapshot) = 'object'
      and jsonb_typeof(projection_snapshot) = 'object'
      and jsonb_typeof(planner_snapshot) = 'object'
    ),
  constraint funding_liquidity_projections_revision_check
    check (
      length(trim(policy_revision)) between 8 and 192
      and length(trim(ownership_revision)) between 8 and 192
    ),
  constraint funding_liquidity_projections_expiry_check
    check (expires_at > created_at)
);

create index funding_liquidity_projections_user_expiry_idx
  on funding_liquidity_projections (user_id, expires_at desc);

create index funding_liquidity_projections_expiry_idx
  on funding_liquidity_projections (expires_at);

create or replace function guard_funding_liquidity_projection_immutable()
returns trigger
language plpgsql
as $$
begin
  raise exception 'funding liquidity projections are immutable';
end;
$$;

create trigger funding_liquidity_projections_immutable
before update on funding_liquidity_projections
for each row execute function guard_funding_liquidity_projection_immutable();
