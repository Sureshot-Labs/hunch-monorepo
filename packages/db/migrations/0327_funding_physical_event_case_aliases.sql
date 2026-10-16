-- EVM hash casing aliases must share the EXISTING physical-event gate,
-- including legacy uppercase 0X prefixes. Native signatures remain exact.
-- No historical rows, claims, anchor permissions or indexes are changed.
create or replace function funding_try_lock_physical_event(
  event_network text, event_transaction text, event_log_index text
) returns void language plpgsql strict as $$
declare
  lock_transaction text;
begin
  lock_transaction := case
    when event_network in ('evm:137','evm:8453')
      and event_transaction ~* '^0x[0-9a-f]{64}$'
    then lower(event_transaction) else event_transaction end;
  if not pg_try_advisory_xact_lock(hashtextextended(
    event_network || ':' || lock_transaction || ':' || event_log_index, 0
  )) then
    raise exception using errcode='55P03',
      message='Funding physical evidence is busy; retry the current evidence pass',
      constraint='funding_physical_event_busy';
  end if;
end;
$$;

create or replace function funding_try_lock_evm_physical_event(
  event_network text, event_transaction text, event_log_index text
) returns void language plpgsql strict as $$
begin
  if event_network not in ('evm:137','evm:8453')
    or event_transaction !~* '^0x[0-9a-f]{64}$'
    or event_log_index !~ '^(0|[1-9][0-9]*)$'
  then return; end if;
  perform funding_try_lock_physical_event(event_network,event_transaction,event_log_index);
end;
$$;
