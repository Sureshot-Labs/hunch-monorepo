-- WP6 owner-bound position actions.
--
-- Redemption is intentionally not represented as a funding operation. These
-- rows make the exact owner, canonical action digest, possible broadcast,
-- receipt, and post-submit effects durable so a restart or marker failure can
-- never cause a duplicate transaction.

create table position_action_operations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete restrict,
  market_id text references unified_markets(id) on delete restrict,
  venue_id text not null,
  action text not null,
  position_ref text not null,
  owner_binding_id text not null,
  owner_address text not null,
  execution_wallet_id text not null,
  execution_address text not null,
  execution_mode text not null,
  inspection_revision text not null,
  action_digest text not null,
  idempotency_key text not null,
  status text not null default 'prepared',
  plan_snapshot jsonb not null,
  evidence_snapshot jsonb not null,
  normalized_actions jsonb not null,
  postconditions jsonb not null,
  submission_fingerprint text,
  broadcast_may_have_occurred boolean not null default false,
  receipt_status text not null default 'unobserved',
  receipt_observed_at timestamptz,
  postcondition_status text not null default 'pending',
  last_error_code text,
  submitted_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint position_action_operations_user_id_id_unique
    unique (user_id, id),
  constraint position_action_operations_user_idempotency_unique
    unique (user_id, idempotency_key),
  constraint position_action_operations_action_digest_unique
    unique (user_id, venue_id, action, owner_binding_id, action_digest),
  constraint position_action_operations_venue_check
    check (venue_id ~ '^[a-z0-9][a-z0-9:_-]{1,159}$'),
  constraint position_action_operations_action_check
    check (action in ('sell', 'redeem')),
  constraint position_action_operations_execution_mode_check
    check (
      execution_mode in (
        'web_client',
        'privy_authorization',
        'privy_delegated',
        'venue_relayer'
      )
    ),
  constraint position_action_operations_status_check
    check (
      status in (
        'prepared',
        'awaiting_user',
        'submitting',
        'submitted',
        'reconcile_required',
        'confirmed',
        'completed',
        'failed',
        'cancelled'
      )
    ),
  constraint position_action_operations_receipt_status_check
    check (
      receipt_status in (
        'unobserved',
        'pending',
        'success',
        'reverted',
        'unknown'
      )
    ),
  constraint position_action_operations_postcondition_status_check
    check (
      postcondition_status in (
        'pending',
        'satisfied',
        'failed',
        'unavailable'
      )
    ),
  constraint position_action_operations_identity_check
    check (
      length(trim(position_ref)) > 0
      and length(trim(owner_binding_id)) between 8 and 192
      and length(trim(owner_address)) > 0
      and length(trim(execution_wallet_id)) between 8 and 192
      and length(trim(execution_address)) > 0
    ),
  constraint position_action_operations_hash_check
    check (
      length(inspection_revision) between 16 and 192
      and length(action_digest) between 32 and 192
      and length(idempotency_key) between 16 and 192
    ),
  constraint position_action_operations_json_check
    check (
      jsonb_typeof(plan_snapshot) = 'object'
      and jsonb_typeof(evidence_snapshot) = 'object'
      and jsonb_typeof(normalized_actions) = 'array'
      and jsonb_typeof(postconditions) = 'array'
    ),
  constraint position_action_operations_submission_check
    check (
      submission_fingerprint is null
      or length(trim(submission_fingerprint)) between 8 and 256
    ),
  constraint position_action_operations_receipt_time_check
    check (
      (receipt_status = 'unobserved' and receipt_observed_at is null)
      or (receipt_status <> 'unobserved' and receipt_observed_at is not null)
    ),
  constraint position_action_operations_terminal_time_check
    check (
      (status in ('completed', 'failed', 'cancelled') and completed_at is not null)
      or (status not in ('completed', 'failed', 'cancelled') and completed_at is null)
    ),
  constraint position_action_operations_broadcast_check
    check (
      status not in ('submitted', 'reconcile_required', 'confirmed', 'completed')
      or broadcast_may_have_occurred
    )
);

create index position_action_operations_user_created_idx
  on position_action_operations (user_id, created_at desc);
create index position_action_operations_reconcile_idx
  on position_action_operations (updated_at, venue_id)
  where status in ('submitting', 'submitted', 'reconcile_required', 'confirmed');
create index position_action_operations_market_idx
  on position_action_operations (market_id)
  where market_id is not null;
create unique index position_action_operations_submission_unique
  on position_action_operations (venue_id, submission_fingerprint)
  where submission_fingerprint is not null;

create table position_action_attempts (
  id uuid primary key default gen_random_uuid(),
  action_operation_id uuid not null
    references position_action_operations(id) on delete restrict,
  attempt_number integer not null check (attempt_number > 0),
  canonical_action_fingerprint text not null,
  executor_id text not null,
  outcome text not null default 'started',
  broadcast_may_have_occurred boolean not null default false,
  submission_fingerprint text,
  receipt_evidence jsonb not null default '{}'::jsonb,
  error_code text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint position_action_attempts_operation_attempt_unique
    unique (action_operation_id, attempt_number),
  constraint position_action_attempts_fingerprint_check
    check (length(canonical_action_fingerprint) between 32 and 192),
  constraint position_action_attempts_outcome_check
    check (
      outcome in (
        'started',
        'not_broadcast',
        'submitted',
        'ambiguous',
        'confirmed',
        'reverted',
        'failed'
      )
    ),
  constraint position_action_attempts_receipt_object_check
    check (jsonb_typeof(receipt_evidence) = 'object'),
  constraint position_action_attempts_finish_check
    check (
      (outcome = 'started' and finished_at is null)
      or (outcome <> 'started' and finished_at is not null)
    ),
  constraint position_action_attempts_broadcast_check
    check (
      outcome not in ('submitted', 'ambiguous', 'confirmed')
      or broadcast_may_have_occurred
    )
);

create index position_action_attempts_operation_idx
  on position_action_attempts (action_operation_id, attempt_number desc);
create index position_action_attempts_ambiguous_idx
  on position_action_attempts (updated_at)
  where outcome = 'ambiguous' or broadcast_may_have_occurred;

create table position_action_effects (
  id uuid primary key default gen_random_uuid(),
  action_operation_id uuid not null
    references position_action_operations(id) on delete restrict,
  effect_kind text not null,
  status text not null default 'pending',
  attempt_count integer not null default 0 check (attempt_count >= 0),
  evidence jsonb not null default '{}'::jsonb,
  last_error_code text,
  next_attempt_at timestamptz not null default now(),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint position_action_effects_operation_kind_unique
    unique (action_operation_id, effect_kind),
  constraint position_action_effects_kind_check
    check (
      effect_kind in (
        'position_refresh',
        'collateral_refresh',
        'activity',
        'notification'
      )
    ),
  constraint position_action_effects_status_check
    check (status in ('pending', 'processing', 'completed', 'failed')),
  constraint position_action_effects_evidence_object_check
    check (jsonb_typeof(evidence) = 'object'),
  constraint position_action_effects_completion_check
    check (
      (status = 'completed' and completed_at is not null)
      or (status <> 'completed' and completed_at is null)
    )
);

create index position_action_effects_pending_idx
  on position_action_effects (next_attempt_at, action_operation_id)
  where status in ('pending', 'failed');

create trigger position_action_operations_touch_updated_at
before update on position_action_operations
for each row execute function funding_touch_updated_at();

create trigger position_action_attempts_touch_updated_at
before update on position_action_attempts
for each row execute function funding_touch_updated_at();

create trigger position_action_effects_touch_updated_at
before update on position_action_effects
for each row execute function funding_touch_updated_at();

create or replace function position_action_guard_operation_update()
returns trigger
language plpgsql
as $$
begin
  if (
    new.user_id,
    new.market_id,
    new.venue_id,
    new.action,
    new.position_ref,
    new.owner_binding_id,
    new.owner_address,
    new.execution_wallet_id,
    new.execution_address,
    new.execution_mode,
    new.inspection_revision,
    new.action_digest,
    new.idempotency_key,
    new.plan_snapshot,
    new.evidence_snapshot,
    new.normalized_actions,
    new.postconditions,
    new.created_at
  ) is distinct from (
    old.user_id,
    old.market_id,
    old.venue_id,
    old.action,
    old.position_ref,
    old.owner_binding_id,
    old.owner_address,
    old.execution_wallet_id,
    old.execution_address,
    old.execution_mode,
    old.inspection_revision,
    old.action_digest,
    old.idempotency_key,
    old.plan_snapshot,
    old.evidence_snapshot,
    old.normalized_actions,
    old.postconditions,
    old.created_at
  ) then
    raise exception 'position action identity and canonical plan are immutable'
      using errcode = '23514';
  end if;
  if old.status in ('completed', 'failed', 'cancelled') and (
    new.status,
    new.submission_fingerprint,
    new.broadcast_may_have_occurred,
    new.receipt_status,
    new.receipt_observed_at,
    new.postcondition_status,
    new.last_error_code,
    new.submitted_at,
    new.completed_at
  ) is distinct from (
    old.status,
    old.submission_fingerprint,
    old.broadcast_may_have_occurred,
    old.receipt_status,
    old.receipt_observed_at,
    old.postcondition_status,
    old.last_error_code,
    old.submitted_at,
    old.completed_at
  ) then
    raise exception 'terminal position action cannot be rewritten'
      using errcode = '23514';
  end if;
  if old.broadcast_may_have_occurred and not new.broadcast_may_have_occurred then
    raise exception 'position action broadcast evidence cannot regress'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger position_action_operations_guard_update
before update on position_action_operations
for each row execute function position_action_guard_operation_update();
