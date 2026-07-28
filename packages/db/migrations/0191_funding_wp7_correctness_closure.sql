-- WP7 correctness closure:
-- - durable trade-submission attempts;
-- - receive/user lifecycle guards;
-- - persisted receive routing dispositions;
-- - canonical receive-event allocation.

create table funding_trade_attempts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  operation_id uuid not null,
  reservation_id uuid not null,
  attempt_number integer not null check (attempt_number > 0),
  venue_id text not null,
  market_id text not null references unified_markets(id) on delete restrict,
  execution_path text not null,
  idempotency_key text not null,
  canonical_fingerprint text not null,
  state text not null default 'claimed',
  broadcast_may_have_occurred boolean not null default false,
  external_reference text,
  error_code text,
  claim_token uuid not null default gen_random_uuid(),
  claim_lease_until timestamptz not null
    default (now() + interval '15 seconds'),
  consumer_kind text,
  consumer_ref text,
  claimed_at timestamptz not null default now(),
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint funding_trade_attempts_reservation_ownership_fk
    foreign key (user_id, operation_id, reservation_id)
    references balance_reservations(user_id, operation_id, id)
    on delete restrict,
  constraint funding_trade_attempts_user_id_unique
    unique (user_id, id),
  constraint funding_trade_attempts_reservation_number_unique
    unique (reservation_id, attempt_number),
  constraint funding_trade_attempts_user_idempotency_unique
    unique (user_id, idempotency_key),
  constraint funding_trade_attempts_execution_path_check
    check (
      execution_path in (
        'polymarket_clob',
        'limitless_clob',
        'limitless_amm',
        'kalshi_dflow'
      )
    ),
  constraint funding_trade_attempts_state_check
    check (
      state in (
        'claimed',
        'submission_started',
        'accepted',
        'ambiguous',
        'definitive_failure'
      )
    ),
  constraint funding_trade_attempts_fingerprint_check
    check (length(canonical_fingerprint) between 32 and 192),
  constraint funding_trade_attempts_idempotency_check
    check (length(idempotency_key) between 8 and 192),
  constraint funding_trade_attempts_external_reference_check
    check (
      external_reference is null
      or length(trim(external_reference)) between 8 and 512
    ),
  constraint funding_trade_attempts_consumer_pair_check
    check ((consumer_kind is null) = (consumer_ref is null)),
  constraint funding_trade_attempts_resolution_check
    check (
      (
        (
          (
            state = 'claimed'
            and not broadcast_may_have_occurred
          )
          or (
            state = 'submission_started'
            and broadcast_may_have_occurred
          )
        )
        and resolved_at is null
        and consumer_kind is null
      )
      or (
        state = 'accepted'
        and resolved_at is not null
        and broadcast_may_have_occurred
        and external_reference is not null
        and consumer_kind is not null
      )
      or (
        state = 'ambiguous'
        and resolved_at is not null
        and broadcast_may_have_occurred
        and consumer_kind is null
      )
      or (
        state = 'definitive_failure'
        and resolved_at is not null
        and consumer_kind is null
      )
    )
);

create unique index funding_trade_attempts_unresolved_reservation_idx
  on funding_trade_attempts (reservation_id)
  where state in ('claimed', 'submission_started', 'ambiguous');

create unique index funding_trade_attempts_external_reference_idx
  on funding_trade_attempts (venue_id, external_reference)
  where external_reference is not null;

create index funding_trade_attempts_reconcile_idx
  on funding_trade_attempts (updated_at, id)
  where state in ('submission_started', 'ambiguous');

create trigger funding_trade_attempts_touch_updated_at
before update on funding_trade_attempts
for each row execute function funding_touch_updated_at();

alter table orders
  add column funding_trade_attempt_id uuid;

alter table orders
  add constraint orders_funding_trade_attempt_ownership_fk
  foreign key (user_id, funding_trade_attempt_id)
  references funding_trade_attempts(user_id, id)
  on delete restrict;

create index orders_funding_trade_attempt_idx
  on orders (funding_trade_attempt_id)
  where funding_trade_attempt_id is not null;

alter table executions
  add column funding_trade_attempt_id uuid;

alter table executions
  add constraint executions_funding_trade_attempt_ownership_fk
  foreign key (user_id, funding_trade_attempt_id)
  references funding_trade_attempts(user_id, id)
  on delete restrict;

create index executions_funding_trade_attempt_idx
  on executions (funding_trade_attempt_id)
  where funding_trade_attempt_id is not null;

alter table funding_receive_sessions
  drop constraint if exists funding_receive_sessions_user_id_fkey;

alter table funding_receive_sessions
  add constraint funding_receive_sessions_user_id_fkey
  foreign key (user_id)
  references users(id)
  on delete restrict;

alter table funding_receive_sessions
  add constraint funding_receive_sessions_user_id_id_unique
  unique (user_id, id);

alter table funding_receive_receipts
  drop constraint if exists funding_receive_receipts_receive_session_id_fkey;

alter table funding_receive_receipts
  add constraint funding_receive_receipts_session_ownership_fk
  foreign key (user_id, receive_session_id)
  references funding_receive_sessions(user_id, id)
  on delete restrict;

alter table funding_receive_receipts
  drop constraint if exists funding_receive_receipts_user_id_fkey;

alter table funding_receive_receipts
  add constraint funding_receive_receipts_user_id_fkey
  foreign key (user_id)
  references users(id)
  on delete restrict;

alter table funding_receive_receipts
  add column routing_disposition text not null default 'pending',
  add column routing_attempt_count integer not null default 0
    check (routing_attempt_count >= 0),
  add column routing_next_attempt_at timestamptz not null default now(),
  add column routing_last_attempt_at timestamptz,
  add column routing_last_error_code text;

alter table funding_receive_receipts
  add constraint funding_receive_receipts_routing_disposition_check
  check (
    routing_disposition in (
      'pending',
      'retry_scheduled',
      'operation_created',
      'review_required',
      'recovery_required',
      'ready'
    )
  );

create index funding_receive_receipts_routing_due_idx
  on funding_receive_receipts (routing_next_attempt_at, created_at, id)
  where status in ('observed', 'routing')
    and handling = 'automatic_conversion';

-- Freeze the cursor boundary used when a receive session is opened. Mutable
-- observation_variants can then advance independently without losing the
-- information needed to allocate an event at a session boundary.
alter table funding_receive_sessions
  add column observation_start_variants jsonb;

update funding_receive_sessions
set observation_start_variants = observation_variants
where observation_start_variants is null;

alter table funding_receive_sessions
  alter column observation_start_variants set not null,
  add constraint funding_receive_sessions_start_variants_check
    check (
      jsonb_typeof(observation_start_variants) = 'array'
      and jsonb_array_length(observation_start_variants) > 0
    );

create or replace function guard_funding_receive_session_start_variants()
returns trigger
language plpgsql
as $$
begin
  if new.observation_start_variants is distinct from old.observation_start_variants then
    raise exception 'funding receive session start cursors are immutable';
  end if;
  return new;
end;
$$;

create trigger funding_receive_session_start_variants_guard
before update on funding_receive_sessions
for each row execute function guard_funding_receive_session_start_variants();

create table funding_receive_canonical_events (
  id uuid primary key default gen_random_uuid(),
  network_id text not null,
  asset_id text not null,
  asset_decimals integer not null check (asset_decimals between 0 and 36),
  destination_address text not null,
  source_address text,
  raw_amount numeric(78, 0) not null check (raw_amount > 0),
  tx_hash text not null,
  event_index text not null,
  ledger_height numeric(78, 0) not null check (ledger_height >= 0),
  block_hash text not null,
  observed_at timestamptz not null,
  allocation_status text not null default 'pending'
    check (allocation_status in ('pending', 'allocated', 'recovery_required')),
  allocated_receive_session_id uuid
    references funding_receive_sessions(id) on delete restrict,
  allocated_receipt_id uuid
    references funding_receive_receipts(id) on delete restrict,
  allocation_error_code text,
  first_observed_at timestamptz not null default now(),
  last_observed_at timestamptz not null default now(),
  allocated_at timestamptz,
  constraint funding_receive_canonical_events_identity_unique
    unique (network_id, tx_hash, event_index),
  constraint funding_receive_canonical_events_allocation_check
    check (
      (
        allocation_status = 'pending'
        and allocated_receive_session_id is null
        and allocated_receipt_id is null
        and allocation_error_code is null
        and allocated_at is null
      )
      or (
        allocation_status = 'allocated'
        and allocated_receive_session_id is not null
        and allocated_receipt_id is not null
        and allocation_error_code is null
        and allocated_at is not null
      )
      or (
        allocation_status = 'recovery_required'
        and allocated_receive_session_id is null
        and allocated_receipt_id is null
        and allocation_error_code is not null
        and allocated_at is null
      )
    )
);

create index funding_receive_canonical_events_pending_idx
  on funding_receive_canonical_events (allocation_status, first_observed_at)
  where allocation_status <> 'allocated';

create or replace function guard_funding_receive_canonical_event_identity()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'funding receive canonical events cannot be deleted';
  end if;
  if (
    new.network_id,
    new.asset_id,
    new.asset_decimals,
    new.destination_address,
    new.source_address,
    new.raw_amount,
    new.tx_hash,
    new.event_index,
    new.ledger_height,
    new.block_hash,
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
    old.ledger_height,
    old.block_hash,
    old.observed_at,
    old.first_observed_at
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

create trigger funding_receive_canonical_event_identity_guard
before update or delete on funding_receive_canonical_events
for each row execute function guard_funding_receive_canonical_event_identity();
