create table if not exists user_tutorial_dismissals (
  user_id uuid not null references users(id) on delete cascade,
  tutorial_key text not null,
  dismissed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, tutorial_key)
);

create index if not exists idx_user_tutorial_dismissals_tutorial_key
  on user_tutorial_dismissals(tutorial_key, dismissed_at desc);

do $$
begin
  if not exists (
    select 1
    from information_schema.triggers
    where trigger_name = 'update_user_tutorial_dismissals_updated_at'
  ) then
    create trigger update_user_tutorial_dismissals_updated_at
    before update on user_tutorial_dismissals
    for each row
    execute function update_updated_at_column();
  end if;
end $$;
