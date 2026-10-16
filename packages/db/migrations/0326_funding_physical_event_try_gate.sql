-- Reuse the EXISTING handoff physical-event advisory namespace. This closes
-- the absent-E insertion race without a second ledger, waiting O -> E locks,
-- historical updates, or data-dependent deployment assertions. It grants no
-- classification, reanchor, allocation or execution authority.
-- The old explicit handoff gate also covers native keys. Keep that coverage;
-- only the table-trigger adapter below narrows itself to EVM log identities.
create function funding_try_lock_physical_event(
  event_network text, event_transaction text, event_log_index text
) returns void language plpgsql strict as $$
begin
  if not pg_try_advisory_xact_lock(hashtextextended(
    event_network || ':' || event_transaction || ':' || event_log_index, 0
  )) then
    raise exception using errcode='55P03',
      message='Funding physical evidence is busy; retry the current evidence pass',
      constraint='funding_physical_event_busy';
  end if;
end;
$$;

create function funding_try_lock_evm_physical_event(
  event_network text, event_transaction text, event_log_index text
) returns void language plpgsql strict as $$
begin
  if event_network not in ('evm:137','evm:8453')
    or event_transaction !~ '^0x[0-9a-fA-F]{64}$'
    or event_log_index !~ '^(0|[1-9][0-9]*)$'
  then return; end if;
  perform funding_try_lock_physical_event(event_network,lower(event_transaction),event_log_index);
end;
$$;

create function funding_gate_canonical_event_write()
returns trigger language plpgsql as $$
begin
  if tg_op='INSERT' or (new.ledger_height,new.block_hash) is distinct from
      (old.ledger_height,old.block_hash) then
    perform funding_try_lock_evm_physical_event(new.network_id,new.tx_hash,new.event_index);
  end if;
  return new;
end;
$$;
create trigger funding_canonical_event_physical_gate
before insert or update on funding_receive_canonical_events
for each row execute function funding_gate_canonical_event_write();

create function funding_gate_observation_claim()
returns trigger language plpgsql as $$
begin
  -- Any inserted row owns this key, including uncertain/reorged evidence. An
  -- unchanged legacy row or truthful retraction needs no new positive claim.
  if tg_op='INSERT' or (
    new.canonical and new.finality_status<>'reorged' and (
      (new.ledger_height,new.block_hash) is distinct from (old.ledger_height,old.block_hash)
      or not old.canonical or old.finality_status='reorged'
    )
  ) then
    perform funding_try_lock_evm_physical_event(new.network_id,new.tx_hash,new.event_index);
  end if;
  return new;
end;
$$;
create trigger funding_observation_physical_gate
before insert or update on funding_observations
for each row execute function funding_gate_observation_claim();

create function funding_gate_receive_receipt_claim()
returns trigger language plpgsql as $$
begin
  perform funding_try_lock_evm_physical_event(new.network_id,new.tx_hash,new.event_index);
  return new;
end;
$$;
create trigger funding_receive_receipt_physical_gate
before insert on funding_receive_receipts
for each row execute function funding_gate_receive_receipt_claim();

create function funding_gate_step_receipt_claim()
returns trigger language plpgsql as $$
declare
  transfer_entry jsonb;
begin
  if tg_op='UPDATE' then
    -- Retraction must not wait on positive classification or repair. Preserve
    -- ordinary polling/merge metadata updates on historical records too.
    if not new.canonical or new.status='reorged' then return new; end if;
    if (new.network_id,new.status,new.canonical,new.action_match,new.failure_code,new.ledger_height,new.block_hash,
        new.evidence->'transactionHash',new.evidence->'handoffEventIndex',
        new.evidence->'sourceDebitEventIndex',new.evidence->'destinationCreditTransfers',
        new.evidence->'handoffOwnedPhysicalEventV1',new.evidence->'handoffPhysicalIdentityConflict') is not distinct from
       (old.network_id,old.status,old.canonical,old.action_match,old.failure_code,old.ledger_height,old.block_hash,
        old.evidence->'transactionHash',old.evidence->'handoffEventIndex',
        old.evidence->'sourceDebitEventIndex',old.evidence->'destinationCreditTransfers',
        old.evidence->'handoffOwnedPhysicalEventV1',old.evidence->'handoffPhysicalIdentityConflict') then return new; end if;
    -- An owned marker may survive with a different/null current transaction.
    -- Both footprints use try-only acquisition, so reversal cannot wait-cycle.
    perform funding_try_lock_evm_physical_event(old.network_id,
      old.evidence->>'transactionHash',old.evidence->>'handoffEventIndex');
    perform funding_try_lock_evm_physical_event(old.network_id,
      old.evidence#>>'{handoffOwnedPhysicalEventV1,transactionHash}',
      old.evidence#>>'{handoffOwnedPhysicalEventV1,handoffEventIndex}');
  end if;
  perform funding_try_lock_evm_physical_event(new.network_id,
    new.evidence->>'transactionHash',new.evidence->>'handoffEventIndex');
  perform funding_try_lock_evm_physical_event(new.network_id,
    new.evidence->>'transactionHash',new.evidence->>'sourceDebitEventIndex');
  perform funding_try_lock_evm_physical_event(new.network_id,
    new.evidence#>>'{handoffOwnedPhysicalEventV1,transactionHash}',
    new.evidence#>>'{handoffOwnedPhysicalEventV1,handoffEventIndex}');
  for transfer_entry in select transfer_row from jsonb_array_elements(
    case when jsonb_typeof(new.evidence->'destinationCreditTransfers')='array'
      then new.evidence->'destinationCreditTransfers' else '[]'::jsonb end
  ) transfer_row loop
    perform funding_try_lock_evm_physical_event(new.network_id,
      new.evidence->>'transactionHash',transfer_entry->>'eventIndex');
  end loop;
  return new;
end;
$$;
create trigger funding_step_receipt_physical_gate
before insert or update on funding_step_receipt_observations
for each row execute function funding_gate_step_receipt_claim();
