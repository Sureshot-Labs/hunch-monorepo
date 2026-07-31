-- One physical chain event may fund at most one allocation. Asset metadata is
-- immutable evidence about that event, not part of its identity.

do $$
declare
  duplicate_count bigint;
begin
  select count(*)
  into duplicate_count
  from (
    select network_id, tx_hash, event_index
    from funding_observations
    group by network_id, tx_hash, event_index
    having count(*) > 1
  ) duplicate;

  if duplicate_count <> 0 then
    raise exception
      '0195 found % duplicate physical funding observation keys',
      duplicate_count
      using errcode = '23505';
  end if;
end;
$$;

alter table funding_observations
  drop constraint funding_observations_transfer_unique;

alter table funding_observations
  add constraint funding_observations_transfer_unique
  unique (network_id, tx_hash, event_index);
