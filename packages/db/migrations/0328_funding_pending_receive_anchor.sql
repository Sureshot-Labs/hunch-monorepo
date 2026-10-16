-- Recovery metadata only. No historical transfers are credited, classified,
-- reparented or verified during deployment. Old readers remain compatible.
alter table funding_receive_canonical_events add column anchor_repair_provenance jsonb;
alter table funding_receive_refund_scans add column event_fingerprint text;

-- Legacy receipts can claim a transaction without a usable log hint. The
-- negative-ownership reader must serialize with those insertions too. Reuse
-- the try-only advisory namespace with a nonnumeric transaction sentinel,
-- BEFORE the existing per-log key. Native/malformed transaction keys keep
-- their old exact semantics. A hash collision only causes a bounded retry.
create or replace function funding_try_lock_physical_event(
  event_network text, event_transaction text, event_log_index text
) returns void language plpgsql strict as $$
declare
  lock_transaction text;
begin
  lock_transaction := event_transaction;
  if event_network in ('evm:137','evm:8453') and event_transaction ~* '^0x[0-9a-f]{64}$' then
    lock_transaction := lower(event_transaction);
    if not pg_try_advisory_xact_lock(hashtextextended(
      event_network || ':' || lock_transaction || ':evm_transaction_footprint',0
    )) then
      raise exception using errcode='55P03',
        message='Funding physical evidence is busy; retry the current evidence pass',
        constraint='funding_physical_event_busy';
    end if;
  end if;
  if not pg_try_advisory_xact_lock(hashtextextended(
    event_network || ':' || lock_transaction || ':' || event_log_index,0
  )) then
    raise exception using errcode='55P03',
      message='Funding physical evidence is busy; retry the current evidence pass',
      constraint='funding_physical_event_busy';
  end if;
end;
$$;

create or replace function funding_try_lock_evm_physical_event(
  event_network text, event_transaction text, event_log_index text
) returns void language plpgsql as $$
begin
  if event_network is null or event_network not in ('evm:137','evm:8453')
    or event_transaction is null or event_transaction !~* '^0x[0-9a-f]{64}$' then return; end if;
  perform funding_try_lock_physical_event(event_network,event_transaction,
    case when event_log_index ~ '^(0|[1-9][0-9]*)$' then event_log_index else 'evm_unknown_log' end);
end;
$$;

create or replace function funding_gate_step_receipt_claim()
returns trigger language plpgsql as $$
declare
  transfer_entry jsonb;
begin
  if tg_op='UPDATE' then
    -- A truthful retraction keeps its full footprint. Changing evidence to a
    -- different transaction/log is a NEW ownership claim even when reorged.
    if (not new.canonical or new.status='reorged') and
      (new.evidence->'transactionHash',new.evidence->'handoffEventIndex',
       new.evidence->'sourceDebitEventIndex',new.evidence->'destinationCreditTransfers',
       new.evidence->'handoffOwnedPhysicalEventV1') is not distinct from
      (old.evidence->'transactionHash',old.evidence->'handoffEventIndex',
       old.evidence->'sourceDebitEventIndex',old.evidence->'destinationCreditTransfers',
       old.evidence->'handoffOwnedPhysicalEventV1') then return new; end if;
    if (new.status,new.canonical,new.action_match,new.failure_code,new.ledger_height,new.block_hash,
        new.evidence->'transactionHash',new.evidence->'handoffEventIndex',
        new.evidence->'sourceDebitEventIndex',new.evidence->'destinationCreditTransfers',
        new.evidence->'handoffOwnedPhysicalEventV1',new.evidence->'handoffPhysicalIdentityConflict') is not distinct from
       (old.status,old.canonical,old.action_match,old.failure_code,old.ledger_height,old.block_hash,
        old.evidence->'transactionHash',old.evidence->'handoffEventIndex',
        old.evidence->'sourceDebitEventIndex',old.evidence->'destinationCreditTransfers',
        old.evidence->'handoffOwnedPhysicalEventV1',old.evidence->'handoffPhysicalIdentityConflict') then return new; end if;
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

-- An exact transaction with missing/malformed physical hints is not evidence
-- of non-ownership. Valid hints for other logs in the same batch are unrelated.
create function funding_step_receipt_claims_evm_event(receipt_evidence jsonb, physical_index text)
returns boolean language plpgsql immutable parallel safe strict as $$
declare
  attribute_name text;
  index_text text;
  transfer_entry jsonb;
  known_footprint boolean := false;
begin
  foreach attribute_name in array array['handoffEventIndex','sourceDebitEventIndex'] loop
    index_text := receipt_evidence ->> attribute_name;
    if index_text is not null then
      if index_text !~ '^(0|[1-9][0-9]*)$' or index_text = physical_index then return true; end if;
      known_footprint := true;
    end if;
  end loop;
  if receipt_evidence -> 'destinationCreditTransfers' is not null
    and receipt_evidence -> 'destinationCreditTransfers' <> 'null'::jsonb then
    if jsonb_typeof(receipt_evidence -> 'destinationCreditTransfers') <> 'array' then return true; end if;
    for transfer_entry in select transfer_row from jsonb_array_elements(
      receipt_evidence -> 'destinationCreditTransfers') transfer_row loop
      index_text := transfer_entry ->> 'eventIndex';
      if index_text is null or index_text !~ '^(0|[1-9][0-9]*)$'
        or index_text = physical_index then return true; end if;
      known_footprint := true;
    end loop;
  end if;
  return not known_footprint;
end;
$$;

-- Global physical ownership, NOT current-user/current-asset/canonical/observer
-- membership. Fixed-width index hints tolerate oversized malformed legacy
-- strings; exact residual equality is mandatory (including a hash collision).
create function funding_receive_physical_event_is_owned(
  physical_network text, physical_transaction text, physical_index text
) returns boolean language sql stable parallel safe strict as $$
  select exists (
    select 1 from funding_observations observation_row
    where observation_row.network_id=physical_network and observation_row.tx_hash is not null
      and md5(lower(observation_row.tx_hash))=md5(lower(physical_transaction))
      and lower(observation_row.tx_hash)=lower(physical_transaction)
      and (observation_row.event_index=physical_index or observation_row.event_index is null
        or observation_row.event_index !~ '^(0|[1-9][0-9]*)$')
  ) or exists (
    select 1 from funding_receive_receipts receipt_row
    where receipt_row.network_id=physical_network and receipt_row.tx_hash is not null
      and md5(lower(receipt_row.tx_hash))=md5(lower(physical_transaction))
      and lower(receipt_row.tx_hash)=lower(physical_transaction)
      and (receipt_row.event_index=physical_index or receipt_row.event_index is null
        or receipt_row.event_index !~ '^(0|[1-9][0-9]*)$')
  ) or exists (
    select 1 from funding_step_receipt_observations step_receipt
    where step_receipt.network_id=physical_network
      and step_receipt.evidence->>'transactionHash' is not null
      and md5(lower(step_receipt.evidence->>'transactionHash'))=md5(lower(physical_transaction))
      and lower(step_receipt.evidence->>'transactionHash')=lower(physical_transaction)
      and funding_step_receipt_claims_evm_event(step_receipt.evidence,physical_index)
  ) or exists (
    select 1 from funding_step_receipt_observations retained_receipt
    where retained_receipt.network_id=physical_network
      and retained_receipt.evidence#>>'{handoffOwnedPhysicalEventV1,transactionHash}' is not null
      and md5(lower(retained_receipt.evidence#>>'{handoffOwnedPhysicalEventV1,transactionHash}'))=md5(lower(physical_transaction))
      and lower(retained_receipt.evidence#>>'{handoffOwnedPhysicalEventV1,transactionHash}')=lower(physical_transaction)
      and (retained_receipt.evidence#>>'{handoffOwnedPhysicalEventV1,handoffEventIndex}'=physical_index
        or retained_receipt.evidence#>>'{handoffOwnedPhysicalEventV1,handoffEventIndex}' is null
        or retained_receipt.evidence#>>'{handoffOwnedPhysicalEventV1,handoffEventIndex}' !~ '^(0|[1-9][0-9]*)$')
  )
$$;

-- This is an additional narrow exception, not an ignore-anchor flag. The
-- application must obtain actual replaced-block/exact-log proof outside the
-- transaction, then gate -> E -> fresh READ COMMITTED ownership read -> CAS.
create function funding_pending_receive_anchor_repair_matches(
  prior_event funding_receive_canonical_events, next_event funding_receive_canonical_events
) returns boolean language plpgsql stable as $$
declare
  prior_provenance jsonb := coalesce(prior_event.anchor_repair_provenance,'[]'::jsonb);
  next_provenance jsonb := coalesce(next_event.anchor_repair_provenance,'[]'::jsonb);
  repair_entry jsonb;
begin
  if jsonb_typeof(prior_provenance)<>'array' or jsonb_typeof(next_provenance)<>'array' then return false; end if;
  if jsonb_array_length(next_provenance)<>jsonb_array_length(prior_provenance)+1 then return false; end if;
  if next_provenance - (jsonb_array_length(next_provenance)-1) <> prior_provenance then return false; end if;
  repair_entry := next_provenance -> -1;
  return coalesce(
    prior_event.network_id in ('evm:137','evm:8453')
    and (prior_event.allocation_status='pending' or (
      prior_event.allocation_status='recovery_required' and prior_event.allocation_error_code in (
        'receive_session_allocation_unavailable','owned_route_destination_correlation_pending',
        'handoff_correlation_pending','handoff_reference_unavailable','exact_refund_correlation_pending')))
    and next_event.allocation_status=prior_event.allocation_status
    and next_event.allocation_error_code is not distinct from prior_event.allocation_error_code
    and prior_event.allocated_receipt_id is null and next_event.allocated_receipt_id is null
    and prior_event.allocated_receive_session_id is null and next_event.allocated_receive_session_id is null
    and next_event.classification_receive_session_id is not distinct from prior_event.classification_receive_session_id
    and next_event.classification_variant_id is not distinct from prior_event.classification_variant_id
    and next_event.classification_retry_at is not distinct from prior_event.classification_retry_at
    and next_event.classification_lease_token is null
    and next_event.ledger_height is not null and next_event.block_hash is not null
    and (next_event.ledger_height,next_event.block_hash) is distinct from (prior_event.ledger_height,prior_event.block_hash)
    and jsonb_typeof(repair_entry)='object' and repair_entry->>'version'='1'
    and repair_entry->>'eventFingerprint' ~ '^[0-9a-f]{64}$'
    and repair_entry->'previous'=jsonb_build_object('ledgerHeight',prior_event.ledger_height::text,'blockHash',prior_event.block_hash)
    and repair_entry->'replacement'=jsonb_build_object('ledgerHeight',next_event.ledger_height::text,'blockHash',next_event.block_hash)
    and repair_entry->>'previousCanonicalHash' ~ '^0x[0-9a-f]{64}$'
    and repair_entry->>'previousCanonicalHash'<>lower(prior_event.block_hash)
    and (next_event.ledger_height<>prior_event.ledger_height
      or repair_entry->>'previousCanonicalHash'=lower(next_event.block_hash))
    and not funding_receive_physical_event_is_owned(prior_event.network_id,prior_event.tx_hash,prior_event.event_index)
  ,false);
end;
$$;

-- Preserve BOTH existing ownership-specific exceptions from 0320 unchanged.
create or replace function guard_funding_receive_canonical_event_identity()
returns trigger language plpgsql as $$
declare
  refund_recanonicalization boolean;
  confirmed_handoff_recanonicalization boolean;
  pending_recanonicalization boolean;
begin
  if tg_op='DELETE' then raise exception 'funding receive canonical events cannot be deleted'; end if;
  refund_recanonicalization :=
    old.allocation_status='recovery_required'
    and old.allocation_error_code in ('internal_exact_refund_suppressed','exact_refund_receipt_not_final',
      'exact_refund_receipt_conflict','internal_event_classification_conflict')
    and new.allocation_status=old.allocation_status and new.allocation_error_code=old.allocation_error_code
    and old.allocated_receipt_id is null and new.allocated_receipt_id is null
    and old.allocated_receive_session_id is null and new.allocated_receive_session_id is null
    and new.ledger_height is not null and new.block_hash is not null
    and exists (
      select 1 from funding_observations observation_row
      where observation_row.network_id=old.network_id and observation_row.tx_hash=old.tx_hash
        and observation_row.event_index=old.event_index and observation_row.kind='refund_credit'
        and observation_row.metadata->>'observerId' in ('relay_exact_refund_observation_v1','relay_owned_refund_observation_v1')
        and observation_row.finality_status='reorged' and not observation_row.canonical
        and observation_row.ledger_height=old.ledger_height::text and observation_row.block_hash=old.block_hash
        and observation_row.asset_id=old.asset_id and observation_row.asset_decimals=old.asset_decimals
        and observation_row.to_address=old.destination_address
        and observation_row.from_address is not distinct from old.source_address
        and observation_row.raw_amount::numeric=old.raw_amount
    );
  confirmed_handoff_recanonicalization :=
    old.network_id='evm:137' and old.allocation_status='recovery_required'
    and old.allocation_error_code='internal_handoff_suppressed'
    and new.allocation_status=old.allocation_status and new.allocation_error_code=old.allocation_error_code
    and old.allocated_receipt_id is null and new.allocated_receipt_id is null
    and old.allocated_receive_session_id is null and new.allocated_receive_session_id is null
    and new.ledger_height is not null and new.block_hash is not null
    and exists (
      select 1 from funding_step_receipt_observations receipt_row
      join funding_operation_steps step_row on step_row.id=receipt_row.step_id and step_row.operation_id=receipt_row.operation_id
      where receipt_row.network_id=old.network_id and receipt_row.evidence->>'transactionHash' ~ '^0x[0-9a-fA-F]{64}$'
        and lower(receipt_row.evidence->>'transactionHash')=old.tx_hash
        and receipt_row.status='confirmed' and receipt_row.canonical
        and receipt_row.evidence->'handoffPhysicalIdentityConflict' is distinct from 'true'::jsonb
        and ((receipt_row.action_match and receipt_row.failure_code is null
          and receipt_row.evidence->>'handoffEventIndex'=old.event_index
          and receipt_row.ledger_height=old.ledger_height::text and receipt_row.block_hash=old.block_hash)
          or (receipt_row.evidence#>>'{handoffOwnedPhysicalEventV1,transactionHash}'=old.tx_hash
            and receipt_row.evidence#>>'{handoffOwnedPhysicalEventV1,handoffEventIndex}'=old.event_index
            and receipt_row.evidence#>>'{handoffOwnedPhysicalEventV1,ledgerHeight}'=old.ledger_height::text
            and receipt_row.evidence#>>'{handoffOwnedPhysicalEventV1,blockHash}'=old.block_hash))
        and step_row.step_kind='external_handoff' and step_row.normalized_action->>'handoffKind' in
          ('polymarket_deposit_wallet_transfer','polymarket_safe_transfer')
    );
  pending_recanonicalization := false;
  if (new.ledger_height,new.block_hash) is distinct from (old.ledger_height,old.block_hash) then
    pending_recanonicalization := funding_pending_receive_anchor_repair_matches(old,new);
  end if;
  if (new.network_id,new.asset_id,new.asset_decimals,new.destination_address,new.source_address,new.raw_amount,
      new.tx_hash,new.event_index,new.observed_at,new.first_observed_at) is distinct from
     (old.network_id,old.asset_id,old.asset_decimals,old.destination_address,old.source_address,old.raw_amount,
      old.tx_hash,old.event_index,old.observed_at,old.first_observed_at)
    or (not (coalesce(refund_recanonicalization,false) or coalesce(confirmed_handoff_recanonicalization,false)
      or pending_recanonicalization) and (new.ledger_height,new.block_hash) is distinct from (old.ledger_height,old.block_hash)) then
    raise exception 'funding receive canonical event identity is immutable';
  end if;
  if new.anchor_repair_provenance is distinct from old.anchor_repair_provenance and not pending_recanonicalization then
    raise exception 'funding receive anchor repair provenance is append-only';
  end if;
  if old.allocation_status='allocated' and
    (new.allocation_status,new.allocated_receive_session_id,new.allocated_receipt_id,new.allocation_error_code,new.allocated_at)
      is distinct from
    (old.allocation_status,old.allocated_receive_session_id,old.allocated_receipt_id,old.allocation_error_code,old.allocated_at) then
    raise exception 'allocated funding receive canonical event is immutable';
  end if;
  return new;
end;
$$;
