-- AFTER-thesis triggers must never acquire a user FK lock after a thesis lock.
-- Pending items are append-only UUID invalidation signals, without a user FK.
-- Writers never contend on a shared per-author cache/marker row while holding
-- thesis rows. Separate signals also preserve writes committing after a drain.
-- The worker locks the user first, rechecks eligibility, and removes every marker
-- it visits, including markers belonging to deleted or suspended users.
create table social_trader_statistics_pending (
  id bigint generated always as identity primary key,
  user_id uuid not null
);
create index social_trader_statistics_pending_owner
  on social_trader_statistics_pending(user_id,id);

create or replace function schedule_social_trader_statistics() returns trigger language plpgsql as $$
declare owner_id uuid;
begin
  for owner_id in select distinct value from unnest(array[
    case when tg_op<>'INSERT' then old.author_id else null end,
    case when tg_op<>'DELETE' then new.author_id else null end
  ]) as owners(value) where value is not null order by value loop
    if exists(select 1 from users where id=owner_id and is_active and social_suspended_at is null) then
      insert into social_trader_statistics_pending(user_id) values(owner_id);
    end if;
  end loop;
  return null;
end $$;
