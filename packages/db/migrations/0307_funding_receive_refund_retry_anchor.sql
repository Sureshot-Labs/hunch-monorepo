-- A receive retry must not prevent its verified refund watcher from repairing
-- the block anchor. The event remains suppressed/pending with the SAME reason.
-- No historical updates or data-dependent migration assertions.
create or replace function guard_funding_receive_canonical_event_identity()
returns trigger
language plpgsql
as $$
declare
  refund_recanonicalization boolean;
begin
  if tg_op = 'DELETE' then
    raise exception 'funding receive canonical events cannot be deleted';
  end if;

  refund_recanonicalization :=
    old.allocation_status = 'recovery_required'
    and old.allocation_error_code in (
      'internal_exact_refund_suppressed', 'exact_refund_receipt_not_final',
      'exact_refund_receipt_conflict', 'internal_event_classification_conflict'
    )
    and new.allocation_status = old.allocation_status
    and new.allocation_error_code = old.allocation_error_code
    and old.allocated_receipt_id is null and new.allocated_receipt_id is null
    and old.allocated_receive_session_id is null and new.allocated_receive_session_id is null
    and new.ledger_height is not null and new.block_hash is not null
    and exists (
      select 1 from funding_observations observation_row
      where observation_row.network_id = old.network_id
        and observation_row.tx_hash = old.tx_hash and observation_row.event_index = old.event_index
        and observation_row.kind = 'refund_credit'
        and observation_row.metadata ->> 'observerId' = 'relay_exact_refund_observation_v1'
        and observation_row.finality_status = 'reorged' and not observation_row.canonical
        and observation_row.ledger_height = old.ledger_height::text
        and observation_row.block_hash = old.block_hash
        and observation_row.asset_id = old.asset_id and observation_row.asset_decimals = old.asset_decimals
        and observation_row.to_address = old.destination_address
        and observation_row.from_address is not distinct from old.source_address
        and observation_row.raw_amount::numeric = old.raw_amount
    );

  if (
    new.network_id,
    new.asset_id,
    new.asset_decimals,
    new.destination_address,
    new.source_address,
    new.raw_amount,
    new.tx_hash,
    new.event_index,
    new.observed_at,
    new.first_observed_at
  ) is distinct from (
    old.network_id,
    old.asset_id,
    old.asset_decimals,
    old.destination_address,
    old.source_address,
    old.raw_amount,
    old.tx_hash,
    old.event_index,
    old.observed_at,
    old.first_observed_at
  ) or (not coalesce(refund_recanonicalization, false) and
    (new.ledger_height, new.block_hash) is distinct from (old.ledger_height, old.block_hash)
  ) then
    raise exception 'funding receive canonical event identity is immutable';
  end if;
  if old.allocation_status = 'allocated'
    and (
      new.allocation_status,
      new.allocated_receive_session_id,
      new.allocated_receipt_id,
      new.allocation_error_code,
      new.allocated_at
    ) is distinct from (
      old.allocation_status,
      old.allocated_receive_session_id,
      old.allocated_receipt_id,
      old.allocation_error_code,
      old.allocated_at
    ) then
    raise exception 'allocated funding receive canonical event is immutable';
  end if;
  return new;
end;
$$;
