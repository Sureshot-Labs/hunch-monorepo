-- A registration identity must never repeat after an installation is deleted.
alter table native_push_devices add column registration_id uuid not null default gen_random_uuid();

create or replace function schedule_social_trader_statistics() returns trigger language plpgsql as $$
declare owner_id uuid;
begin
  for owner_id in select distinct value from unnest(array[
    case when tg_op<>'INSERT' then old.author_id else null end,
    case when tg_op<>'DELETE' then new.author_id else null end
  ]) as owners(value) where value is not null loop
    insert into social_trader_statistics(user_id) select owner_id from users where id=owner_id and is_active and social_suspended_at is null
    on conflict(user_id) do update set
      next_refresh_at=least(social_trader_statistics.next_refresh_at,now()),
      generation=social_trader_statistics.generation+1;
  end loop;
  return null;
end $$;
