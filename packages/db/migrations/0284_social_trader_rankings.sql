create table social_trader_statistics (
  user_id uuid primary key references users(id) on delete cascade,
  policy_revision text,
  statistics jsonb,
  wins integer not null default 0,
  losses integer not null default 0,
  win_rate numeric,
  computed_at timestamptz,
  next_refresh_at timestamptz not null default now(),
  generation bigint not null default 1,
  lease_id uuid,
  lease_until timestamptz
);
create index social_trader_statistics_due on social_trader_statistics(next_refresh_at,user_id);
create index social_trader_statistics_rank on social_trader_statistics(policy_revision,win_rate desc,((wins+losses)) desc,user_id desc)
  where win_rate is not null;

create table social_trader_ranking_snapshots (
  id uuid primary key default gen_random_uuid(),
  policy_revision text not null,
  created_at timestamptz not null default now()
);
create index social_trader_ranking_latest on social_trader_ranking_snapshots(policy_revision,created_at desc,id desc);
create index social_trader_ranking_retention on social_trader_ranking_snapshots(created_at,id);
create table social_trader_ranking_entries (
  snapshot_id uuid not null references social_trader_ranking_snapshots(id) on delete cascade,
  rank integer not null,
  user_id uuid not null references users(id) on delete cascade,
  statistics jsonb not null,
  primary key(snapshot_id,rank)
);

create function schedule_social_trader_statistics() returns trigger language plpgsql as $$
declare owner_id uuid;
begin
  for owner_id in select distinct value from unnest(array[
    case when tg_op<>'INSERT' then old.author_id else null end,
    case when tg_op<>'DELETE' then new.author_id else null end
  ]) as owners(value) where value is not null loop
    insert into social_trader_statistics(user_id) select owner_id from users where id=owner_id and is_active and social_suspended_at is null
    on conflict(user_id) do update set next_refresh_at=now(),generation=social_trader_statistics.generation+1;
  end loop;
  return null;
end $$;
create trigger social_trader_statistics_changed after insert or update or delete on user_theses
  for each row execute function schedule_social_trader_statistics();
