-- Forward-only schema closure for funding recovery, observation identity, and
-- exact trade-consumer intent.
--
-- These columns intentionally live in a new migration. Previously applied
-- funding migrations are checksum-verified and must remain immutable.

do $$
begin
  if exists (
    select 1
    from funding_operations
    where status = 'recovery_required'
  ) then
    raise exception
      '0194 requires explicit recovery_mode classification for existing recovery_required funding operations'
      using errcode = '23514';
  end if;

  if exists (select 1 from funding_observations) then
    raise exception
      '0194 cannot infer asset_decimals for existing funding observations'
      using errcode = '23514';
  end if;

  if exists (select 1 from funding_trade_attempts) then
    raise exception
      '0194 cannot infer consumer intent for existing funding trade attempts'
      using errcode = '23514';
  end if;
end;
$$;

alter table funding_operations
  add column recovery_mode text;

alter table funding_operations
  add constraint funding_operations_recovery_mode_check
  check (
    (
      status = 'recovery_required'
      and recovery_mode in ('automatic_evidence', 'manual_review')
    )
    or (
      status <> 'recovery_required'
      and recovery_mode is null
    )
  );

alter table funding_observations
  add column asset_decimals smallint not null
    check (asset_decimals between 0 and 36);

alter table funding_observations
  drop constraint funding_observations_transfer_unique;

alter table funding_observations
  add constraint funding_observations_transfer_unique
  unique (network_id, tx_hash, event_index, asset_id, asset_decimals);

create or replace function funding_guard_observation_update()
returns trigger
language plpgsql
as $$
declare
  transition_allowed boolean;
begin
  if (
    new.operation_id,
    new.segment_id,
    new.kind,
    new.network_id,
    new.asset_id,
    new.asset_decimals,
    new.tx_hash,
    new.event_index,
    new.from_address,
    new.to_address,
    new.raw_amount,
    new.observed_at,
    new.ledger_height,
    new.block_hash,
    new.created_at
  ) is distinct from (
    old.operation_id,
    old.segment_id,
    old.kind,
    old.network_id,
    old.asset_id,
    old.asset_decimals,
    old.tx_hash,
    old.event_index,
    old.from_address,
    old.to_address,
    old.raw_amount,
    old.observed_at,
    old.ledger_height,
    old.block_hash,
    old.created_at
  ) then
    raise exception 'funding observation allocation and transfer identity are immutable'
      using errcode = '23514';
  end if;

  transition_allowed :=
    new.finality_status = old.finality_status
    or (old.finality_status = 'observed' and new.finality_status in ('confirmed', 'finalized', 'reorged'))
    or (old.finality_status = 'confirmed' and new.finality_status in ('finalized', 'reorged'))
    or (old.finality_status = 'finalized' and new.finality_status = 'reorged');
  if not transition_allowed then
    raise exception 'invalid funding observation finality transition: % -> %',
      old.finality_status,
      new.finality_status
      using errcode = '23514';
  end if;
  if new.finality_status = old.finality_status and (
    new.canonical,
    new.finalized_at,
    new.reorged_at
  ) is distinct from (
    old.canonical,
    old.finalized_at,
    old.reorged_at
  ) then
    raise exception 'funding observation finality evidence cannot change without a transition'
      using errcode = '23514';
  end if;
  if old.finalized_at is not null
    and new.finalized_at is distinct from old.finalized_at then
    raise exception 'funding observation finalized_at is immutable'
      using errcode = '23514';
  end if;
  if old.reorged_at is not null
    and new.reorged_at is distinct from old.reorged_at then
    raise exception 'funding observation reorged_at is immutable'
      using errcode = '23514';
  end if;
  if not (new.metadata @> old.metadata) then
    raise exception 'funding observation metadata is append-only'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

alter table funding_trade_attempts
  add column consumer_intent jsonb not null;

alter table funding_trade_attempts
  add column consumer_intent_fingerprint text not null;

alter table funding_trade_attempts
  drop constraint funding_trade_attempts_fingerprint_check;

alter table funding_trade_attempts
  add constraint funding_trade_attempts_fingerprint_check
  check (
    length(canonical_fingerprint) between 32 and 192
    and length(consumer_intent_fingerprint) between 32 and 192
    and jsonb_typeof(consumer_intent) = 'object'
  );
