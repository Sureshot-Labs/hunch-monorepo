-- Slice D: bounded Telegram authority for routed Base USDC -> Polygon pUSD.
-- Existing closed-destination Slice C grants intentionally keep a null cap.

alter table telegram_funding_authorizations
  add column max_source_raw numeric(78, 0);

alter table telegram_funding_authorizations
  add constraint telegram_funding_authorizations_routed_cap_check check (
    security_class <> 'routed_value_movement'
    or max_source_raw > 0
  ) not valid;

-- Canonical failed EVM receipts become retry-authorizing only after the same
-- finality threshold as successful receipts. Preserve legacy/non-final failed
-- evidence while allowing those explicitly finalized failures to carry a
-- reorg-watch timestamp.
alter table funding_step_receipt_observations
  drop constraint funding_step_receipt_observations_finalized_check;

alter table funding_step_receipt_observations
  add constraint funding_step_receipt_observations_finalized_check check (
    (status = 'finalized' and finalized_at is not null)
    or (
      status = 'failed'
      and (
        (
          evidence ->> 'failureFinalized' = 'true'
          and finalized_at is not null
        )
        or (
          evidence ->> 'failureFinalized' is distinct from 'true'
          and finalized_at is null
        )
      )
    )
    or (status not in ('finalized', 'failed') and finalized_at is null)
  ) not valid;

-- A canonical failure is terminal for retry semantics, but remains mutable in
-- exactly one direction during the bounded reorg watch: failed -> reorged.
create or replace function funding_guard_step_receipt_observation_update()
returns trigger
language plpgsql
as $$
declare
  corrected_mismatch boolean;
begin
  if tg_op = 'DELETE' then
    raise exception 'funding step receipt observations cannot be deleted'
      using errcode = '23514';
  end if;
  if (
    new.operation_id,
    new.step_id,
    new.attempt_id,
    new.network_id,
    new.first_seen_at,
    new.created_at
  ) is distinct from (
    old.operation_id,
    old.step_id,
    old.attempt_id,
    old.network_id,
    old.first_seen_at,
    old.created_at
  ) then
    raise exception 'funding step receipt observation identity is immutable'
      using errcode = '23514';
  end if;
  corrected_mismatch :=
    old.status = 'mismatch'
    and new.status = 'finalized'
    and new.action_match is true
    and new.canonical
    and new.failure_code is null
    and new.finalized_at is not null
    and new.reorged_at is null;

  if new.status is distinct from old.status
    and not (
      (old.status = 'pending' and new.status in (
        'confirmed', 'finalized', 'failed', 'mismatch', 'reorged'
      ))
      or (old.status = 'confirmed' and new.status in (
        'finalized', 'failed', 'mismatch', 'reorged'
      ))
      or (old.status in ('finalized', 'failed') and new.status = 'reorged')
      or corrected_mismatch
    ) then
    raise exception 'invalid funding step receipt transition: % -> %',
      old.status,
      new.status
      using errcode = '23514';
  end if;
  if old.finalized_at is not null
    and new.status = old.status
    and new.finalized_at is distinct from old.finalized_at then
    raise exception 'funding step receipt finalization time is immutable'
      using errcode = '23514';
  end if;
  if (
    (old.status in ('mismatch', 'reorged') and not corrected_mismatch)
    or (old.status = 'failed' and new.status <> 'reorged')
  ) and (
    new.status,
    new.action_match,
    new.ledger_height,
    new.block_hash,
    new.canonical,
    new.failure_code,
    new.evidence,
    new.observed_at,
    new.finalized_at,
    new.reorged_at
  ) is distinct from (
    old.status,
    old.action_match,
    old.ledger_height,
    old.block_hash,
    old.canonical,
    old.failure_code,
    old.evidence,
    old.observed_at,
    old.finalized_at,
    old.reorged_at
  ) then
    raise exception 'terminal funding step receipt observation is immutable'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

-- A Relay refund may be re-mined with the same transaction hash and log index
-- after its original block is reorged. Preserve the former canonical location
-- in append-only metadata while permitting only that exact refund observation
-- to become canonical again. Every other observation identity/finality rule
-- remains unchanged.
create or replace function funding_guard_observation_update()
returns trigger
language plpgsql
as $$
declare
  transition_allowed boolean;
  refund_recanonicalization boolean;
begin
  if tg_op = 'DELETE' then
    raise exception 'funding observations cannot be deleted'
      using errcode = '23514';
  end if;

  refund_recanonicalization :=
    old.kind = 'refund_credit'
    and old.network_id = 'evm:8453'
    and lower(old.asset_id) =
          '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
    and old.metadata ->> 'observerId' =
          'relay_owned_refund_observation_v1'
    and old.finality_status = 'reorged'
    and not old.canonical
    and old.reorged_at is not null
    and new.kind = old.kind
    and new.finality_status = 'finalized'
    and new.canonical
    and new.reorged_at is null
    and new.finalized_at is not null
    and new.ledger_height is not null
    and new.block_hash is not null
    and jsonb_typeof(
          new.metadata -> 'relayRefundCanonicalityHistory'
        ) = 'array'
    and new.metadata -> 'relayRefundCanonicalityHistory' @>
          jsonb_build_array(jsonb_build_object(
            'previousBlock', old.ledger_height,
            'previousBlockHash', old.block_hash,
            'reorgedAt', old.reorged_at
          ));

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
    old.created_at
  ) or (
    not refund_recanonicalization
    and (new.ledger_height, new.block_hash) is distinct from
        (old.ledger_height, old.block_hash)
  ) then
    raise exception 'funding observation allocation and transfer identity are immutable'
      using errcode = '23514';
  end if;

  transition_allowed :=
    new.finality_status = old.finality_status
    or (old.finality_status = 'observed' and new.finality_status in ('confirmed', 'finalized', 'reorged'))
    or (old.finality_status = 'confirmed' and new.finality_status in ('finalized', 'reorged'))
    or (old.finality_status = 'finalized' and new.finality_status = 'reorged')
    or refund_recanonicalization;
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
    and new.finalized_at is distinct from old.finalized_at
    and not refund_recanonicalization then
    raise exception 'funding observation finalized_at is immutable'
      using errcode = '23514';
  end if;
  if old.reorged_at is not null
    and new.reorged_at is distinct from old.reorged_at
    and not refund_recanonicalization then
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

-- The cap is frozen authority evidence. Invalid updates are suppressed by a
-- dedicated trigger; callers already require an affected row and therefore
-- fail closed without making migration rollout depend on historical data.
create function guard_telegram_funding_authorization_cap_update()
returns trigger
language plpgsql
as $$
begin
  if new.max_source_raw is distinct from old.max_source_raw then
    return null;
  end if;
  return new;
end;
$$;

create trigger telegram_funding_authorizations_cap_guard
before update of max_source_raw on telegram_funding_authorizations
for each row execute function guard_telegram_funding_authorization_cap_update();

create table telegram_funding_authorization_reservations (
  id uuid primary key default gen_random_uuid(),
  authorization_id uuid not null
    references telegram_funding_authorizations(id) on delete restrict,
  receive_receipt_id uuid not null
    references funding_receive_receipts(id) on delete restrict,
  funding_operation_id uuid not null
    references funding_operations(id) on delete restrict,
  cleanup_operation_id uuid
    references funding_operations(id) on delete restrict,
  cleanup_allowance_revision text,
  source_raw numeric(78, 0) not null check (source_raw > 0),
  status text not null check (
    status in (
      'reserved',
      'cleanup_required',
      'settled',
      'refunded',
      'released',
      'cleaned'
    )
  ),
  reserved_at timestamptz not null,
  resolved_at timestamptz,
  refund_cursor_block numeric(78, 0) check (refund_cursor_block >= 0),
  resolution_evidence jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint telegram_funding_authorization_reservations_receipt_unique
    unique (receive_receipt_id),
  constraint telegram_funding_authorization_reservations_operation_unique
    unique (funding_operation_id),
  constraint telegram_funding_authorization_reservations_cleanup_unique
    unique (cleanup_operation_id),
  constraint telegram_funding_authorization_reservations_cleanup_shape_check
    check (
      (cleanup_operation_id is null and cleanup_allowance_revision is null)
      or (
        cleanup_operation_id is not null
        and length(cleanup_allowance_revision) between 32 and 192
      )
    ),
  constraint telegram_funding_authorization_reservations_resolution_check
    check (
      (status in ('reserved', 'cleanup_required') and resolved_at is null)
      or (
        status in ('settled', 'refunded', 'released', 'cleaned')
        and resolved_at is not null
      )
    ),
  constraint telegram_funding_authorization_reservations_evidence_check
    check (jsonb_typeof(resolution_evidence) = 'object')
);

create index telegram_funding_authorization_reservations_active_idx
  on telegram_funding_authorization_reservations (
    authorization_id,
    status,
    reserved_at
  )
  where status in ('reserved', 'cleanup_required');

create function guard_telegram_funding_authorization_reservation_update()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    if current_setting(
      'hunch.telegram_funding_retention_cleanup',
      true
    ) is distinct from 'on' then
      return null;
    end if;
    return old;
  end if;
  if (
    new.id,
    new.authorization_id,
    new.receive_receipt_id,
    new.funding_operation_id,
    new.source_raw,
    new.reserved_at,
    new.created_at
  ) is distinct from (
    old.id,
    old.authorization_id,
    old.receive_receipt_id,
    old.funding_operation_id,
    old.source_raw,
    old.reserved_at,
    old.created_at
  ) then
    return null;
  end if;
  if not new.resolution_evidence @> old.resolution_evidence then
    return null;
  end if;
  if old.refund_cursor_block is not null and (
    new.refund_cursor_block is null
    or new.refund_cursor_block < old.refund_cursor_block
  ) then
    return null;
  end if;
  if old.cleanup_operation_id is not null and (
    new.cleanup_operation_id,
    new.cleanup_allowance_revision
  ) is distinct from (
    old.cleanup_operation_id,
    old.cleanup_allowance_revision
  ) then
    return null;
  end if;
  if old.cleanup_operation_id is null
     and new.cleanup_operation_id is not null
     and not (
       old.status = 'reserved'
       and new.status = 'cleanup_required'
       and new.cleanup_allowance_revision is not null
     ) then
    return null;
  end if;
  if old.status = new.status then
    if new.resolved_at is distinct from old.resolved_at then
      return null;
    end if;
  elsif not (
    (old.status = 'reserved' and new.status in (
      'cleanup_required', 'settled', 'refunded', 'released'
    ))
    or (old.status = 'cleanup_required' and new.status = 'cleaned')
    or (old.status = 'cleaned' and new.status = 'refunded')
  ) then
    return null;
  end if;
  if old.status in ('settled', 'refunded', 'released', 'cleaned')
     and not (old.status = 'cleaned' and new.status = 'refunded')
     and (
    new.status,
    new.resolved_at
  ) is distinct from (
    old.status,
    old.resolved_at
  ) then
    return null;
  end if;
  return new;
end;
$$;

create trigger telegram_funding_authorization_reservations_guard
before update or delete on telegram_funding_authorization_reservations
for each row execute function guard_telegram_funding_authorization_reservation_update();

alter table telegram_funding_consents
  drop constraint telegram_funding_consents_automation_check;

alter table telegram_funding_consents
  add constraint telegram_funding_consents_automation_check check (
    (
      automation_enabled
      and (
        (
          max_auto_execute_source_raw is null
          and automation_policy_snapshot ->> 'version' = '2'
          and automation_policy_snapshot ->> 'kind' =
                'polymarket_usdce_full_receipt_wrap'
          and automation_policy_snapshot ->> 'fullReceipt' = 'true'
        )
        or (
          max_auto_execute_source_raw > 0
          and automation_policy_snapshot ->> 'version' in ('1', '3')
          and (
            automation_policy_snapshot ->> 'version' <> '3'
            or (
              automation_policy_snapshot ->> 'kind' =
                    'polymarket_base_usdc_relay'
              and automation_policy_snapshot ->> 'fullReceipt' = 'false'
              and automation_policy_snapshot ->> 'maxSourceRaw' =
                    max_auto_execute_source_raw::text
            )
          )
        )
      )
    )
    or (
      not automation_enabled
      and max_auto_execute_source_raw is null
    )
  ) not valid;
